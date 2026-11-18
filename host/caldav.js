/**
 * Minimal CalDAV client — enough to read a Lark/Feishu calendar.
 *
 * Lark does not offer a per-calendar iCal feed the way Google does. What it
 * does offer is CalDAV (client → 设置 → 日历 → CalDAV 同步, which hands you a
 * server, a username and an app password). So the job here is two requests:
 *
 *   PROPFIND  find the calendar collections under the principal
 *   REPORT    calendar-query with a time-range, which returns iCalendar text
 *
 * That text feeds the same expandFeed() the Google path uses, so occurrences,
 * RRULE, EXDATE and overrides behave identically.
 *
 * Deliberately no dependencies: node:https with Basic auth, plus regex reads of
 * the multistatus body. CalDAV servers vary in namespace prefixes, so every
 * pattern accepts an optional prefix.
 */
import http from 'node:http';
import https from 'node:https';

const UA = 'dsh-calendar/1.0 (+almanac panel)';

/** One HTTP request with an arbitrary method; never throws on HTTP status. */
export function request(url, options = {}) {
  const target = new URL(url);
  const lib = target.protocol === 'http:' ? http : https;
  const headers = Object.assign({ 'User-Agent': UA }, options.headers || {});
  if (options.auth) {
    const raw = Buffer.from(options.auth.user + ':' + options.auth.pass, 'utf8').toString('base64');
    headers.Authorization = 'Basic ' + raw;
  }
  if (options.body) headers['Content-Length'] = Buffer.byteLength(options.body);

  return new Promise((resolve) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: target.pathname + (target.search || ''),
        method: options.method || 'GET',
        headers,
        timeout: options.timeoutMs || 20000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text: data }));
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => resolve({ status: 0, headers: {}, text: '', error: String(err && err.message ? err.message : err) }));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function unescapeXml(text) {
  return String(text)
    // Feishu encodes the calendar text itself, newlines included, as numeric
    // character references (&#xD;&#xA;). Without this the whole feed is one line.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Every <…calendar-data> payload in a REPORT response, unescaped. */
export function extractCalendarData(multistatus) {
  const out = [];
  const re = /<(?:[A-Za-z0-9.-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9.-]+:)?calendar-data>/g;
  let match = re.exec(multistatus);
  while (match) {
    let body = match[1];
    const cdata = body.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    out.push(cdata ? cdata[1] : unescapeXml(body));
    match = re.exec(multistatus);
  }
  return out;
}

/** Resource hrefs listed in a REPORT/PROPFIND response. */
export function extractHrefs(multistatus) {
  const out = [];
  const re = /<(?:[A-Za-z0-9.-]+:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9.-]+:)?href>/gi;
  let match = re.exec(multistatus);
  while (match) {
    const href = unescapeXml(match[1]).trim();
    if (/\.ics($|\?)/i.test(href)) out.push(href);
    match = re.exec(multistatus);
  }
  return out;
}

/** The VEVENT blocks of any iCalendar text, wrapper removed. */
export function veventBlocks(icsText) {
  const out = [];
  const re = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g;
  let match = re.exec(String(icsText || ''));
  while (match) {
    out.push(match[0]);
    match = re.exec(String(icsText || ''));
  }
  return out;
}

const MAX_RESOURCES = 400;
const RESOURCE_BATCH = 40;

/**

 * Read a set of resources with one calendar-multiget REPORT.
 * Plain GET on a resource answers 403 on Feishu, so this is the only way in.
 */
async function multiget(collectionUrl, hrefs, auth) {
  if (!hrefs.length) return [];
  const body = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
    '  <d:prop><c:calendar-data/></d:prop>',
    ...hrefs.map((href) => '  <d:href>' + href + '</d:href>'),
    '</c:calendar-multiget>',
  ].join('\n');
  const res = await request(collectionUrl, {
    method: 'REPORT',
    auth,
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  if (res.status < 200 || res.status >= 300) return [];
  return extractCalendarData(res.text || '');
}

/** Calendar collections found in a PROPFIND response. */
export function parseCollections(multistatus, baseUrl) {
  const collections = [];
  const segments = multistatus.split(/<\/(?:[A-Za-z0-9.-]+:)?response>/i);
  for (const segment of segments) {
    const typeMatch = segment.match(/<(?:[A-Za-z0-9.-]+:)?resourcetype[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9.-]+:)?resourcetype>/i);
    if (!typeMatch) continue;
    // A collection is a calendar only if resourcetype says so. Other properties in
    // the same propstat (calendar-home-set, current-user-principal) mean nothing here.
    if (!/<(?:[A-Za-z0-9.-]+:)?calendar\s*\/?>/i.test(typeMatch[1])) continue;
    const hrefMatch = segment.match(/<(?:[A-Za-z0-9.-]+:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9.-]+:)?href>/i);
    if (!hrefMatch) continue;
    const href = unescapeXml(hrefMatch[1]).trim();
    // Only collections that actually hold events.
    const compSet = segment.match(/<(?:[A-Za-z0-9.-]+:)?supported-calendar-component-set[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9.-]+:)?supported-calendar-component-set>/i);
    const compSource = compSet ? compSet[1] : segment;
    const comps = compSource.match(/<(?:[A-Za-z0-9.-]+:)?comp[^>]*name="([A-Z]+)"/gi) || [];
    const supportsEvents = comps.length === 0 || comps.some((c) => /name="VEVENT"/i.test(c));
    if (!supportsEvents) continue;
    const nameMatch = segment.match(/<(?:[A-Za-z0-9.-]+:)?displayname[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9.-]+:)?displayname>/i);
    collections.push({
      url: new URL(href, baseUrl).toString(),
      name: nameMatch ? unescapeXml(nameMatch[1]).trim() : '',
    });
  }
  return collections;
}

/** The principal / home-set advertised by a server, if it advertises one. */
export function parseHomeSet(multistatus) {
  const m = multistatus.match(/<(?:[A-Za-z0-9.-]+:)?calendar-home-set[^>]*>[\s\S]*?<(?:[A-Za-z0-9.-]+:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9.-]+:)?href>/i);
  return m ? unescapeXml(m[1]).trim() : '';
}

const PROPFIND_BODY = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
  '  <d:prop>',
  '    <d:resourcetype/>',
  '    <d:displayname/>',
  '    <c:supported-calendar-component-set/>',
  '    <c:calendar-home-set/>',
  '    <d:current-user-principal/>',
  '  </d:prop>',
  '</d:propfind>',
].join('\n');

/**
 * Find every event-holding collection for these credentials.
 * Tries the given base, then `.well-known/caldav`, then the advertised home set.
 */
export async function discoverCollections(baseUrl, auth) {
  const tried = [];
  const bases = [];
  const trimmed = baseUrl.replace(/\/+$/, '');
  bases.push(trimmed);
  try {
    bases.push(new URL('/.well-known/caldav', trimmed).toString());
  } catch (err) {
    /* ignore a malformed base */
  }

  for (const base of bases) {
    const res = await request(base, {
      method: 'PROPFIND',
      auth,
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    tried.push({ url: base, status: res.status, error: res.error || '' });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: '用户名或密码不对（HTTP ' + res.status + '）', tried, collections: [] };
    }
    if (res.status >= 200 && res.status < 300) {
      const found = parseCollections(res.text, base);
      if (found.length) return { ok: true, error: null, tried, collections: found };
      const home = parseHomeSet(res.text);
      if (home) {
        const homeUrl = new URL(home, base).toString();
        const homeRes = await request(homeUrl, {
          method: 'PROPFIND',
          auth,
          headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
          body: PROPFIND_BODY,
        });
        tried.push({ url: homeUrl, status: homeRes.status });
        if (homeRes.status >= 200 && homeRes.status < 300) {
          const fromHome = parseCollections(homeRes.text, homeUrl);
          if (fromHome.length) return { ok: true, error: null, tried, collections: fromHome };
        }
      }
    }
  }
  return { ok: false, error: '在这个地址上找不到日历集合（可能是域名不对，或账号没开 CalDAV）', tried, collections: [] };
}

function basicStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return '' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}

/**
 * Pull the events of one collection as iCalendar text.
 * @returns {{ok: boolean, text: string, error: string|null}}
 */
export async function fetchCollection(collectionUrl, auth, from, to) {
  const body = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
    '  <d:prop><c:calendar-data/></d:prop>',
    '  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">',
    '    <c:time-range start="' + basicStamp(from) + '" end="' + basicStamp(to) + '"/>',
    '  </c:comp-filter></c:comp-filter></c:filter>',
    '</c:calendar-query>',
  ].join('\n');

  const res = await request(collectionUrl, {
    method: 'REPORT',
    auth,
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  if (res.status === 401 || res.status === 403) return { ok: false, calendars: [], error: 'HTTP ' + res.status + '（认证失败）' };
  if (res.status >= 400 || res.status === 0) return { ok: false, calendars: [], error: res.error || 'HTTP ' + res.status };

  const inline = extractCalendarData(res.text);
  if (inline.length) return { ok: true, calendars: inline, error: null };

  // Href-only server (Feishu): pull them with calendar-multiget, in batches so a
  // big calendar cannot turn one panel refresh into hundreds of round trips.
  const hrefs = extractHrefs(res.text).slice(0, MAX_RESOURCES);
  if (!hrefs.length) return { ok: true, calendars: [], error: null };

  const calendars = [];
  for (let i = 0; i < hrefs.length; i += RESOURCE_BATCH) {
    const blocks = await multiget(collectionUrl, hrefs.slice(i, i + RESOURCE_BATCH), auth);
    for (const block of blocks) calendars.push(block);
  }
  return { ok: true, calendars, error: null };
}

/** Discover once, then pull every collection into one feed text. */
export async function fetchAll(credentials, from, to) {
  const auth = { user: credentials.user, pass: credentials.pass };
  const found = await discoverCollections(credentials.url, auth);
  if (!found.ok) return { ok: false, error: found.error, text: '', collections: [] };

  const blocks = [];
  let failures = 0;
  for (const collection of found.collections) {
    const one = await fetchCollection(collection.url, auth, from, to);
    if (!one.ok) { failures += 1; continue; }
    for (const calendar of one.calendars) {
      for (const block of veventBlocks(calendar)) blocks.push(block);
    }
  }
  if (!blocks.length && failures) {
    return { ok: false, error: '所有日历都拉取失败', text: '', collections: found.collections };
  }
  return {
    ok: true,
    error: null,
    text: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + blocks.join('\r\n') + '\r\nEND:VCALENDAR',
    collections: found.collections,
    events: blocks.length,
  };
}
