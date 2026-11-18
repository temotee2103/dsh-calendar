/**
 * Loopback service that turns subscribed calendars into JSON for the panel.
 *
 * Two sources, one shape:
 *   google — the calendar's secret iCal address (a plain feed fetch)
 *   lark   — CalDAV (server + username + app password), because Lark has no
 *            per-calendar iCal URL; see host/caldav.js
 *
 * The browser cannot do either itself (no CORS on Google's feed, and CalDAV
 * needs a custom method plus Basic auth), so this runs on the Host. Read-only:
 * the only writes are the credentials, in the secrets directory.
 */
import http from 'node:http';
import { expandFeed } from './ics.js';
import { fetchAll, discoverCollections } from './caldav.js';
import {
  readIcsUrl, normalizeIcsUrl, writeIcsUrl, clearIcsUrl,
  readCaldav, writeCaldav, clearCaldav,
  readProfile, writeProfile,
} from './config.js';

const FEED_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;

/** Turn an HTTP status into the thing the user actually has to change. */
export function explainFetchFailure(status, url) {
  const isPublic = /\/public\/basic\.ics/i.test(String(url || ''));
  if (status === 404 || status === 410) {
    return isPublic
      ? '这是「公开地址」，而这份日历没有公开（Google 返回 404）。请改用「私密地址（iCal 格式）」旁眼睛图标下面那条 private-… 链接。'
      : 'Google 返回 404：链接不完整，或者这个私密地址已经被重置。';
  }
  if (status === 401 || status === 403) return '没有权限读这个日历（' + status + '）：私密地址可能已被重置。';
  return 'Google 返回 ' + status;
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 16384) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

export function startCalendarSync(options) {
  const port = options.port;
  const cache = {
    google: { text: '', at: 0, url: '', error: null, hint: '' },
    lark: { text: '', at: 0, key: '', error: null },
  };

  async function googleFeed(force) {
    const url = readIcsUrl();
    if (!url) return { ok: false, error: 'not-configured', text: '', at: 0, hint: '' };
    const fresh = !force && cache.google.url === url && cache.google.text && Date.now() - cache.google.at < FEED_TTL_MS;
    if (fresh) return { ok: true, text: cache.google.text, at: cache.google.at, error: null, hint: '' };
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'dsh-calendar/1.0 (+almanac panel)' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = new Error(explainFetchFailure(res.status, url));
        err.hint = 'http-' + res.status;
        throw err;
      }
      const text = await res.text();
      if (text.indexOf('BEGIN:VCALENDAR') < 0) throw new Error('返回内容不是 iCalendar');
      cache.google = { text, at: Date.now(), url, error: null, hint: '' };
      return { ok: true, text, at: cache.google.at, error: null, hint: '' };
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      const hint = (err && err.hint) || '';
      cache.google = Object.assign({}, cache.google, { error: message, hint });
      if (cache.google.text) {
        return { ok: true, text: cache.google.text, at: cache.google.at, stale: true, error: message, hint };
      }
      return { ok: false, error: message, text: '', at: 0, hint };
    }
  }

  async function larkFeed(force, from, to) {
    const creds = readCaldav();
    if (!creds) return { ok: false, error: 'not-configured', text: '', at: 0 };
    const key = creds.url + '|' + creds.user + '|' + Math.round(from / 3600000) + '-' + Math.round(to / 3600000);
    const fresh = !force && cache.lark.key === key && Date.now() - cache.lark.at < FEED_TTL_MS;
    if (fresh) return { ok: true, text: cache.lark.text, at: cache.lark.at, error: null };
    try {
      const result = await fetchAll(creds, from, to);
      if (!result.ok) {
        if (cache.lark.text) return { ok: true, text: cache.lark.text, at: cache.lark.at, stale: true, error: result.error };
        cache.lark = Object.assign({}, cache.lark, { error: result.error });
        return { ok: false, error: result.error, text: '', at: 0 };
      }
      cache.lark = { text: result.text, at: Date.now(), key, error: null };
      return { ok: true, text: result.text, at: cache.lark.at, error: null, collections: result.collections.length };
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      cache.lark = Object.assign({}, cache.lark, { error: message });
      return { ok: false, error: message, text: '', at: 0 };
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      });
      res.end();
      return;
    }

    if (url.pathname === '/sync' && req.method === 'GET') {
      const googleUrl = readIcsUrl();
      const larkCreds = readCaldav();
      send(res, 200, {
        ok: true,
        configured: !!googleUrl || !!larkCreds,
        sources: {
          google: { configured: !!googleUrl, lastFetchAt: cache.google.at || 0, lastError: cache.google.error },
          lark: { configured: !!larkCreds, lastFetchAt: cache.lark.at || 0, lastError: cache.lark.error },
        },
      });
      return;
    }

    if (url.pathname === '/profile' && req.method === 'GET') {
      const profile = readProfile();
      send(res, 200, { ok: true, pillars: profile ? profile.pillars : null });
      return;
    }

    if (url.pathname === '/profile' && req.method === 'POST') {
      readBody(req).then((raw) => {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch (err) { payload = {}; }
        const pillars = String(payload.pillars || '').trim().toUpperCase();
        // Four pillars, each a stem+branch: ç™¸é…‰ ç™¸äº¥ ä¸™è¾° ä¸é…‰
        if (!/^[ç”²ä¹™ä¸™ä¸æˆŠå·±åºšè¾›å£¬ç™¸][å­ä¸‘å¯…å¯è¾°å·³åˆæœªç”³é…‰æˆŒäº¥]([\s,ï¼Œ]+[ç”²ä¹™ä¸™ä¸æˆŠå·±åºšè¾›å£¬ç™¸][å­ä¸‘å¯…å¯è¾°å·³åˆæœªç”³é…‰æˆŒäº¥]){3}$/.test(pillars)) {
          send(res, 400, { ok: false, error: 'éœ€è¦å››æŸ±ï¼Œä¾‹å¦‚ï¼šç™¸é…‰ ç™¸äº¥ ä¸™è¾° ä¸é…‰' });
          return;
        }
        writeProfile(pillars.replace(/[,ï¼Œ]/g, ' ').replace(/\s+/g, ' '));
        send(res, 200, { ok: true, pillars: pillars.replace(/[,ï¼Œ]/g, ' ').replace(/\s+/g, ' ') });
      });
      return;
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      const force = url.searchParams.get('refresh') === '1';
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        send(res, 400, { ok: false, error: 'from/to 需要毫秒时间戳，且 to > from' });
        return;
      }
      Promise.all([googleFeed(force), larkFeed(force, from, to)]).then(([g, l]) => {
        const events = [];
        const failures = [];
        const collect = (result, source) => {
          if (!result.ok) {
            if (result.error !== 'not-configured') failures.push(source + ': ' + result.error);
            return;
          }
          if (!result.text) return;
          try {
            for (const event of expandFeed(result.text, from, to)) {
              events.push(Object.assign({}, event, { source }));
            }
          } catch (err) {
            failures.push(source + ': 解析失败 ' + String(err && err.message ? err.message : err));
          }
        };
        collect(g, 'google');
        collect(l, 'lark');
        events.sort((a, b) => a.start - b.start);
        send(res, 200, {
          ok: true,
          events,
          fetchedAt: Math.max(g.at || 0, l.at || 0),
          stale: !!g.stale || !!l.stale,
          sources: {
            google: { ok: g.ok, error: g.ok ? null : g.error, hint: g.hint || '', fetchedAt: g.at || 0, configured: !!readIcsUrl() },
            lark: { ok: l.ok, error: l.ok ? null : l.error, hint: '', fetchedAt: l.at || 0, collections: l.collections || 0, configured: !!readCaldav() },
          },
          warning: failures.length ? failures.join('；') : null,
        });
      });
      return;
    }

    if (url.pathname === '/config' && req.method === 'POST') {
      readBody(req).then(async (raw) => {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch (err) { payload = {}; }
        const kind = payload.kind === 'lark' ? 'lark' : 'google';

        if (kind === 'google') {
          const normalized = normalizeIcsUrl(payload.url);
          if (!normalized.ok) { send(res, 400, { ok: false, error: normalized.error }); return; }
          try {
            const probe = await fetch(normalized.url, {
              redirect: 'follow',
              headers: { 'User-Agent': 'dsh-calendar/1.0 (+almanac panel)' },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!probe.ok) {
              send(res, 400, { ok: false, error: explainFetchFailure(probe.status, normalized.url) });
              return;
            }
            const body = await probe.text();
            if (body.indexOf('BEGIN:VCALENDAR') < 0) {
              send(res, 400, { ok: false, error: '这个地址返回的不是日历数据（没有 BEGIN:VCALENDAR）' });
              return;
            }
          } catch (err) {
            send(res, 400, { ok: false, error: '连不上这个地址：' + String(err && err.message ? err.message : err) });
            return;
          }
          writeIcsUrl(normalized.url);
          cache.google = { text: '', at: 0, url: '', error: null, hint: '' };
          send(res, 200, { ok: true, configured: true, kind });
          return;
        }

        let caldavUrl = String(payload.url || '').trim();
        // The client may hand over a bare host (caldav.larksuite.com); fill the scheme.
        if (caldavUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(caldavUrl)) caldavUrl = 'https://' + caldavUrl;
        const user = String(payload.user || '').trim();
        const pass = String(payload.pass || '');
        if (!/^https:\/\//i.test(caldavUrl)) { send(res, 400, { ok: false, error: 'CalDAV 地址要以 https:// 开头' }); return; }
        if (!user || !pass) { send(res, 400, { ok: false, error: '用户名和密码都要填（密码是飞书客户端里生成的 CalDAV 密码）' }); return; }
        const probe = await discoverCollections(caldavUrl, { user, pass });
        if (!probe.ok) { send(res, 400, { ok: false, error: probe.error, tried: probe.tried }); return; }
        writeCaldav({ url: caldavUrl, user, pass });
        cache.lark = { text: '', at: 0, key: '', error: null };
        send(res, 200, { ok: true, configured: true, kind, collections: probe.collections.map((c) => c.name || c.url) });
      });
      return;
    }

    if (url.pathname === '/config' && req.method === 'DELETE') {
      const kind = url.searchParams.get('kind') === 'lark' ? 'lark' : 'google';
      if (kind === 'lark') {
        clearCaldav();
        cache.lark = { text: '', at: 0, key: '', error: null };
      } else {
        clearIcsUrl();
        cache.google = { text: '', at: 0, url: '', error: null, hint: '' };
      }
      send(res, 200, { ok: true, configured: false, kind });
      return;
    }

    send(res, 404, { error: 'not found' });
  });

  server.on('error', (err) => {
    if (options.log) options.log('[calendar-sync] listen failed: ' + err.message);
  });
  server.listen(port, '127.0.0.1');

  return { port, close() { try { server.close(); } catch (err) { /* closed */ } } };
}
