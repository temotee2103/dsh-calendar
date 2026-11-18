// Self-check for the Lark/CalDAV source.
//
// The fake server reproduces what caldav-jp.larksuite.com actually does, which
// is not what RFC examples suggest:
//   1. PROPFIND repeats <calendar-home-set> inside every propstat, so "is this a
//      calendar" must be decided by resourcetype alone.
//   2. calendar-query answers with hrefs and an EMPTY <calendar-data/> whose
//      propstat is 404 — the data must be pulled separately.
//   3. GET on a resource is 403; only calendar-multiget returns data.
//   4. That data encodes the iCalendar text, newlines included, as numeric
//      character references (&#xD;&#xA;).
// A collection answering inline (the common case elsewhere) is covered as well.
//
// Run: node check-lark.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-'));
process.env.DSH_CALENDAR_ICS_FILE = path.join(dir, 'calendar-ics.env');
process.env.DSH_CALENDAR_CALDAV_FILE = path.join(dir, 'calendar-caldav.env');

const caldav = await import('./host/caldav.js');
const ics = await import('./host/ics.js');
const config = await import('./host/config.js');
const serverMod = await import('./host/server.js');

const AUTH = 'Basic ' + Buffer.from('temo:secret').toString('base64');

let pass = 0;
const fails = [];
function record(name, detail, err) {
  if (err) {
    fails.push(name + ' :: ' + err.message);
    console.log('  FAIL ' + name + ' :: ' + err.message);
  } else {
    pass += 1;
    console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
  }
}
function check(name, fn) { try { record(name, fn()); } catch (err) { record(name, null, err); } }
async function acheck(name, fn) { try { record(name, await fn()); } catch (err) { record(name, null, err); } }
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

/* ------------------------------- fixtures ------------------------------- */

const WORK_EVENTS = [
  ['UID:lark-1@feishu', 'SUMMARY:飞书周会',
    'DTSTART;TZID=Asia/Kuala_Lumpur:20261119T100000', 'DTEND;TZID=Asia/Kuala_Lumpur:20261119T110000'],
  ['UID:lark-2@feishu', 'SUMMARY:和财务对账',
    'DTSTART;TZID=Asia/Kuala_Lumpur:20261120T150000', 'DTEND;TZID=Asia/Kuala_Lumpur:20261120T160000'],
].map((lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));

const INLINE_EVENTS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
  'UID:inline-1@feishu', 'SUMMARY:内联日历的会',
  'DTSTART;TZID=Asia/Kuala_Lumpur:20261121T090000', 'DTEND;TZID=Asia/Kuala_Lumpur:20261121T093000',
  'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/u_temo/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/></D:resourcetype><D:displayname>temo</D:displayname>
    <C:calendar-home-set><D:href>/u_temo/</D:href></C:calendar-home-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/u_temo/work/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>work</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    <C:calendar-home-set><D:href>/u_temo/</D:href></C:calendar-home-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/u_temo/inline/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>inline</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    <C:calendar-home-set><D:href>/u_temo/</D:href></C:calendar-home-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/u_temo/todo/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>todo</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    <C:calendar-home-set><D:href>/u_temo/</D:href></C:calendar-home-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;

const WORK_HREFS = ['/u_temo/work/a.ics', '/u_temo/work/b.ics'];

// Feishu escapes the calendar text itself: CRLF becomes &#xD;&#xA;.
const numericEscape = (text) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\r/g, '&#xD;')
  .replace(/\n/g, '&#xA;')
  .replace(/'/g, '&#39;');

const caldavServer = http.createServer((req, res) => {
  if (req.headers.authorization !== AUTH) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="caldav"' });
    res.end('auth required');
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = req.url || '';

    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(MULTISTATUS);
      return;
    }
    if (req.method === 'GET') { res.writeHead(403); res.end(); return; }

    if (req.method === 'REPORT') {
      if (url.includes('/work/') && body.includes('calendar-multiget')) {
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
${WORK_EVENTS.map((data, i) => `  <D:response><D:href>${WORK_HREFS[i]}</D:href><D:propstat><D:prop><C:calendar-data>${numericEscape(data)}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('\n')}
</D:multistatus>`);
        return;
      }
      if (url.includes('/work/')) {
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
${WORK_HREFS.map((h) => `  <D:response><D:href>${h}</D:href><D:propstat><D:prop><C:calendar-data/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>`).join('\n')}
</D:multistatus>`);
        return;
      }
      if (url.includes('/inline/')) {
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/u_temo/inline/a.ics</D:href><D:propstat><D:prop>
    <C:calendar-data>${numericEscape(INLINE_EVENTS)}</C:calendar-data>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`);
        return;
      }
    }
    res.writeHead(405);
    res.end('method not allowed');
  });
});

await new Promise((r) => caldavServer.listen(47860, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:47860';

console.log('\n[1] Feishu-style CalDAV');
await acheck('discovery: home-set noise does not hide the two VEVENT calendars, VTODO one skipped', async () => {
  const found = await caldav.discoverCollections(BASE, { user: 'temo', pass: 'secret' });
  ok(found.ok, found.error || 'not ok');
  const urls = found.collections.map((c) => c.url).sort().join(' ');
  ok(found.collections.length === 2, 'found ' + found.collections.length + ': ' + urls);
  ok(urls.includes('/u_temo/work/') && urls.includes('/u_temo/inline/'), urls);
  ok(!urls.includes('/u_temo/todo/'), 'VTODO collection slipped in');
  return urls;
});

await acheck('wrong password is named as a credential problem', async () => {
  const found = await caldav.discoverCollections(BASE, { user: 'temo', pass: 'wrong' });
  ok(!found.ok, 'should fail');
  ok(/401/.test(found.error), found.error);
  return found.error;
});

await acheck('href-only REPORT + 403 GET: multiget reads the data, numeric refs decode to real newlines', async () => {
  const found = await caldav.discoverCollections(BASE, { user: 'temo', pass: 'secret' });
  const work = found.collections.find((c) => c.url.includes('/work/'));
  const one = await caldav.fetchCollection(work.url, { user: 'temo', pass: 'secret' }, new Date(2026, 10, 1).getTime(), new Date(2026, 11, 1).getTime());
  ok(one.ok, one.error || 'not ok');
  ok(one.calendars.length === 2, 'calendars=' + one.calendars.length);
  const blocks = caldav.veventBlocks(one.calendars[0]);
  ok(blocks.length === 1, 'blocks=' + blocks.length);
  ok(blocks[0].includes('\r\n'), 'newlines were not decoded');
  const summary = (blocks[0].split(/\r?\n/).find((l) => l.startsWith('SUMMARY:')) || '').slice(8);
  ok(summary.length > 0, 'no SUMMARY line');
  return summary;
});

await acheck('inline calendar-data still works (not only the Feishu shape)', async () => {
  const found = await caldav.discoverCollections(BASE, { user: 'temo', pass: 'secret' });
  const inline = found.collections.find((c) => c.url.includes('/inline/'));
  const one = await caldav.fetchCollection(inline.url, { user: 'temo', pass: 'secret' }, new Date(2026, 10, 1).getTime(), new Date(2026, 11, 1).getTime());
  ok(one.ok, one.error || 'not ok');
  ok(one.calendars.length === 1, 'calendars=' + one.calendars.length);
  return 'inline ok';
});

await acheck('fetchAll merges both collections into one feed the parser accepts', async () => {
  const from = new Date(2026, 10, 1).getTime();
  const to = new Date(2026, 11, 1).getTime();
  const all = await caldav.fetchAll({ url: BASE, user: 'temo', pass: 'secret' }, from, to);
  ok(all.ok, all.error || 'not ok');
  const events = ics.expandFeed(all.text, from, to);
  ok(events.length === 3, 'events=' + events.length);
  return events.length + ' events';
});

console.log('\n[2] Two sources in the service');
const googleFeed = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:g1', 'SUMMARY:Google meeting',
  'DTSTART;TZID=Asia/Kuala_Lumpur:20261119T090000', 'DTEND;TZID=Asia/Kuala_Lumpur:20261119T093000',
  'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const gServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
  res.end(googleFeed);
});
await new Promise((r) => gServer.listen(47861, '127.0.0.1', r));

config.writeIcsUrl('http://127.0.0.1:47861/fixture.ics');
config.writeCaldav({ url: BASE, user: 'temo', pass: 'secret' });
const handle = serverMod.startCalendarSync({ port: 47862 });
await new Promise((r) => setTimeout(r, 250));
const SVC = 'http://127.0.0.1:47862';

await acheck('/sync reports both sources', async () => {
  const body = await (await fetch(SVC + '/sync')).json();
  ok(body.sources.google.configured, 'google');
  ok(body.sources.lark.configured, 'lark');
  return 'ok';
});

await acheck('/events merges and tags by source', async () => {
  const from = new Date(2026, 10, 1).getTime();
  const to = new Date(2026, 11, 1).getTime();
  const body = await (await fetch(SVC + '/events?from=' + from + '&to=' + to)).json();
  const counts = {};
  for (const e of body.events) counts[e.source] = (counts[e.source] || 0) + 1;
  ok(body.events.length === 4, 'events=' + body.events.length);
  ok(counts.google === 1 && counts.lark === 3, JSON.stringify(counts));
  return JSON.stringify(counts);
});

await acheck('disconnecting Lark leaves Google alone', async () => {
  await fetch(SVC + '/config?kind=lark', { method: 'DELETE' });
  const sync = await (await fetch(SVC + '/sync')).json();
  ok(sync.sources.lark.configured === false, 'lark still configured');
  ok(sync.sources.google.configured === true, 'google lost');
});

await acheck('Lark rejects an http address and an empty password', async () => {
  const bad1 = await fetch(SVC + '/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'lark', url: 'http://127.0.0.1:47860', user: 'temo', pass: 'secret' }),
  });
  ok(bad1.status === 400, 'http accepted');
  const bad2 = await fetch(SVC + '/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'lark', url: 'https://caldav.example.com', user: 'temo', pass: '' }),
  });
  ok(bad2.status === 400, 'empty pass accepted');
});

handle.close();
config.clearIcsUrl();
config.clearCaldav();
await new Promise((r) => caldavServer.close(r));
await new Promise((r) => gServer.close(r));

console.log('\n' + (fails.length ? 'FAILED ' + fails.length + ' / ' + (pass + fails.length) : 'ALL PASS ' + pass));
if (fails.length) {
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
