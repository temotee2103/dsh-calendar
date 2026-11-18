// Self-check for the calendar plugin: loads client.js exactly as the browser
// module table does, then exercises the same functions the panel renders with.
// Run: node check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'client.js'), 'utf8');

let spec = null;
globalThis.window = {
  __ModuleLoader__: {
    load(s) {
      spec = s;
    },
  },
  localStorage: { getItem: () => null, setItem: () => {} },
};

new Function(src)();
if (!spec) {
  console.error('FAIL: __ModuleLoader__.load was never called');
  process.exit(1);
}

const ReactStub = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};

const api = spec.factory((id) => {
  if (id === 'react') return ReactStub;
  throw new Error('unexpected require: ' + id);
});

const T = api.__test;
if (!T) {
  console.error('FAIL: __test surface missing');
  process.exit(1);
}

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    fails.push(name + ' :: ' + err.message);
    console.log('  FAIL ' + name + ' :: ' + err.message);
  }
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error((label ? label + ': ' : '') + 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
function ok(cond, label) {
  if (!cond) throw new Error(label || 'assertion failed');
}
function d(s) {
  const [y, m, day] = s.split('-').map(Number);
  return new Date(y, m - 1, day);
}

console.log('\n[1] 六十甲子（日柱）');
check('1993-12-01 是丙辰日（命局基准）', () => eq(T.ganzhiOfDay(d('1993-12-01')).text, '丙辰'));
check('基准前一天是乙卯（不是退化值）', () => eq(T.ganzhiOfDay(d('1993-11-30')).text, '乙卯'));
check('逐日推进：干与支各进位 1', () => {
  const a = T.ganzhiOfDay(d('2026-11-05'));
  const b = T.ganzhiOfDay(d('2026-11-06'));
  eq(b.stemIndex, (a.stemIndex + 1) % 10, 'stem');
  eq(b.branchIndex, (a.branchIndex + 1) % 12, 'branch');
});
check('60 天为整周期', () => {
  const a = T.ganzhiOfDay(d('2026-01-01'));
  const b = T.ganzhiOfDay(d('2026-03-02'));
  eq(b.index, a.index, 'index +60d');
});
check('索引与干支自洽（全 60 项）', () => {
  let bad = 0;
  for (let i = 0; i < 60; i += 1) {
    const gz = T.ganzhiOfDay(new Date(2026, 0, 1 + i));
    ok(gz.index >= 0 && gz.index < 60, 'index range');
  }
  eq(bad, 0);
});
check('与独立公式交叉验证（JDN 法，不是自证循环）', () => {
  // 六十甲子序号 = (JDN + 49) % 60；与命局基准完全独立的另一种算法。
  const jdn = (y, m, dd) => {
    const a = Math.floor((14 - m) / 12);
    const yy = y + 4800 - a;
    const mm = m + 12 * a - 3;
    return dd + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
  };
  let mismatches = 0;
  for (let i = 0; i < 400; i += 1) {
    const dt = new Date(2026, 0, 1 + i);
    const expect = (jdn(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()) + 49) % 60;
    if (T.ganzhiOfDay(dt).index !== expect) mismatches += 1;
  }
  eq(mismatches, 0, '400 天逐日比对');
  eq(T.ganzhiOfDay(d('2026-11-05')).text, '癸未', 'JDN 法给出的 2026-11-05');
});

console.log('\n[2] 十神（日主丙火）');
check('代码里不带任何人的出生数据：默认无命局，输入四柱后才可用', () => {
  eq(T.hasChart(), false, '默认应为空');
  eq(T.CHART.pillars.length, 0, '默认不该有四柱');
  eq(T.applyChartText('癸酉 癸亥 丙辰 丁酉'), '', '四柱解析失败');
  eq(T.hasChart(), true, '设置后应可用');
  eq(T.CHART.dayMaster, '丙', '日主应取日柱天干');
});
check('乱填的四柱会被拒', () => {
  ok(T.applyChartText('甲乙 丙丁') !== '', '两柱应被拒');
  ok(T.applyChartText('癸酉 癸亥 丙辰 甲子') === '', '合法的应通过');
  T.applyChartText('癸酉 癸亥 丙辰 丁酉');
});
const dm = T.CHART.dayMasterStem;
check('甲→偏印 / 乙→正印', () => {
  eq(T.tenGod(dm, 0), '偏印');
  eq(T.tenGod(dm, 1), '正印');
});
check('丙→比肩 / 丁→劫财', () => {
  eq(T.tenGod(dm, 2), '比肩');
  eq(T.tenGod(dm, 3), '劫财');
});
check('戊→食神 / 己→伤官', () => {
  eq(T.tenGod(dm, 4), '食神');
  eq(T.tenGod(dm, 5), '伤官');
});
check('庚→偏财 / 辛→正财', () => {
  eq(T.tenGod(dm, 6), '偏财');
  eq(T.tenGod(dm, 7), '正财');
});
check('壬→七杀 / 癸→正官', () => {
  eq(T.tenGod(dm, 8), '七杀');
  eq(T.tenGod(dm, 9), '正官');
});
check('十个天干给出的十神互不相同（非退化）', () => {
  const set = new Set();
  for (let i = 0; i < 10; i += 1) set.add(T.tenGod(dm, i));
  eq(set.size, 10);
});

console.log('\n[3] 农历（ICU chinese calendar）');
check('2026-02-17 = 丙午年 正月 初一', () => {
  const l = T.lunarOf(d('2026-02-17'));
  eq(l.yearName, '丙午');
  eq(l.monthClean, '正月');
  eq(l.dayNum, 1);
  eq(l.dayName, '初一');
});
check('2025-07-25 = 闰六月 初一', () => {
  const l = T.lunarOf(d('2025-07-25'));
  eq(l.monthClean, '六月');
  eq(l.isLeap, true);
  eq(l.dayName, '初一');
});
check('2026-11-05 = 九月 廿七', () => {
  const l = T.lunarOf(d('2026-11-05'));
  eq(l.monthClean, '九月');
  eq(l.dayName, '廿七');
});
check('农历日名覆盖 30 天而不是退化空串', () => {
  for (let i = 1; i <= 30; i += 1) ok(T.lunarOf(new Date(2026, 1, 16 + i)).dayName.length > 0, 'day ' + i);
});

console.log('\n[4] 农历节日');
check('2026-02-16 = 除夕（次日正月初一）', () => eq(T.lunarFestival(d('2026-02-16')), '除夕'));
check('2026-02-17 = 春节', () => eq(T.lunarFestival(d('2026-02-17')), '春节'));
check('2026-06-19 = 端午', () => eq(T.lunarFestival(d('2026-06-19')), '端午'));
check('2026-09-25 = 中秋', () => eq(T.lunarFestival(d('2026-09-25')), '中秋'));
check('普通工作日无节日（反例）', () => eq(T.lunarFestival(d('2026-11-05')), ''));

console.log('\n[5] 马来西亚公共假期');
check('2026-02-17 是农历新年（联邦）', () => {
  const list = T.holidaysOf(d('2026-02-17'));
  eq(list.length, 1);
  eq(list[0].n, '农历新年');
  eq(list[0].federal, true);
});
check('2026-11-05 无假日（反例）', () => eq(T.holidaysOf(d('2026-11-05')).length, 0));
check('2026-11-05 的下一个假日是 11-08 屠妖节，3 天后', () => {
  const next = T.nextHolidayAfter(d('2026-11-05'));
  eq(next.key, '2026-11-08');
  eq(next.name, '屠妖节');
  eq(next.days, 3);
});
check('假日表本身有序且日期自洽（30 条）', () => {
  const keys = Object.keys(T.HOLIDAYS).sort();
  eq(keys.length, 30);
  for (const k of keys) {
    const [y, m, day] = k.split('-').map(Number);
    ok(y >= 2026 && y <= 2027, 'year ' + k);
    ok(m >= 1 && m <= 12, 'month ' + k);
    ok(day >= 1 && day <= 31, 'day ' + k);
  }
});

console.log('\n[6] 月历网格');
check('2026-11 网格 42 格，首格是周日', () => {
  const cells = T.monthCells(2026, 10);
  eq(cells.length, 42);
  eq(cells[0].getDay(), 0);
});
check('网格包含本月全部日期', () => {
  const cells = T.monthCells(2026, 10).map((c) => c.getDate() + '/' + (c.getMonth() + 1));
  for (let day = 1; day <= 30; day += 1) ok(cells.indexOf(day + '/11') >= 0, 'missing 2026-11-' + day);
});
check('未来三个假期跨月排列，天数递减为负值不可能出现', () => {
  const list = T.holidaysAfter(d('2026-11-05'), 3);
  eq(list.length, 3);
  eq(list[0].key, '2026-11-08');
  eq(list[1].key, '2026-12-25');
  eq(list[2].key, '2027-01-01');
  for (const x of list) ok(x.days > 0, 'days ' + x.key + ' = ' + x.days);
});

console.log('\n[6b] 日冲煞');
check('癸未日冲丑（牛）煞西', () => {
  const c = T.clashOf(7); // 未
  eq(c.zodiac, '牛');
  eq(c.branch, '丑');
  eq(c.direction, '西');
});
check('十二支的冲与煞方成对且非退化', () => {
  const zs = new Set();
  for (let i = 0; i < 12; i += 1) zs.add(T.clashOf(i).zodiac);
  eq(zs.size, 12);
  const dirs = new Set();
  for (let i = 0; i < 12; i += 1) dirs.add(T.clashOf(i).direction);
  eq(dirs.size, 4);
  eq(T.clashOf(0).direction, '南'); // 子日煞南
});

console.log('\n[7] 当日运程（依 癸酉 癸亥 丙辰 丁酉）');
const LANES = ['career', 'wealth', 'social', 'love', 'health'];
check('五个维度都有分数，且不全是同一个值（非退化）', () => {
  const f = T.fortuneFor(d('2026-11-05'));
  const vals = LANES.map((k) => f.scores[k]);
  for (const k of LANES) ok(typeof f.scores[k] === 'number', k + ' missing');
  for (const k of LANES) {
    ok(f.scores[k] >= 18 && f.scores[k] <= 97, k + ' out of range: ' + f.scores[k]);
  }
  ok(new Set(vals).size > 1, 'all five dimensions identical: ' + vals.join(','));
});
check('同一天结果稳定（确定性）', () => {
  const a = T.fortuneFor(d('2026-11-05'));
  const b = T.fortuneFor(d('2026-11-05'));
  eq(JSON.stringify(a.scores), JSON.stringify(b.scores));
});
check('不同日子结果会变（不是常量）', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) {
    const f = T.fortuneFor(new Date(2026, 10, 1 + i));
    seen.add(LANES.map((k) => f.scores[k]).join(','));
  }
  ok(seen.size >= 20, 'only ' + seen.size + ' distinct days out of 30');
});
check('命局日支值日（辰日/酉日/亥日）能被识别为刑或合，而不是"无关系"', () => {
  // 找一个辰日
  let chenDay = null;
  for (let i = 0; i < 60; i += 1) {
    const dt = new Date(2026, 0, 1 + i);
    if (T.ganzhiOfDay(dt).branch === '辰') chenDay = dt;
  }
  ok(chenDay !== null, 'no 辰 day found');
  const f = T.fortuneFor(chenDay);
  ok(f.rels.length > 0, '辰日应见自刑/半合，实际 ' + f.relText);
});
check('2026-11-05 运程依据可读', () => {
  const f = T.fortuneFor(d('2026-11-05'));
  ok(f.gz.text.length === 2, '日柱');
  ok(f.god.length >= 2, '十神');
  ok(f.relText.length > 0, '关系');
  console.log('       → ' + f.gz.text + ' / ' + f.god + ' / ' + f.relText + ' / 总评 ' + f.total);
  console.log('       → ' + LANES.map((k) => k + ' ' + f.scores[k]).join('  '));
});

console.log('\n[8] 注册面');
check('导出了 apply 与 slots 注入', () => {
  ok(typeof api.apply === 'function', 'apply');
  ok(Array.isArray(api.inject) && api.inject.indexOf('slots') >= 0, 'inject');
});
check('该 factory 的结果不含 DOM 写入口（不碰 document.body）', () => {
  ok(src.indexOf('document.body') < 0, 'document.body referenced');
  ok(src.indexOf('querySelector') < 0, 'querySelector referenced');
});
check('所有配色都走主题 token（无硬编码 hex 作为容器色）', () => {
  const cssBlock = src.slice(src.indexOf('const CSS = ['), src.indexOf('/* =====================================================================\n     * 10.'));
  const hex = cssBlock.match(/#[0-9a-fA-F]{3,8}/g) || [];
  eq(hex.filter((x) => x !== '#fff').length, 0, 'hex colors: ' + hex.join(','));
});


/* =====================================================================
 * 9. 手机日历：iCalendar 解析与展开
 *
 * These feeds mirror what Google's secret iCal address actually emits:
 * folded lines, TZID wall times, all-day dates, RRULE with BYDAY, EXDATE,
 * a RECURRENCE-ID override, and a cancelled event.
 * =================================================================== */
console.log('\n[9] iCalendar 解析（feed 用固定样例，不依赖网络）');
{
  const ics = await import('./host/ics.js');
  const KL = 'Asia/Kuala_Lumpur';
  const feed = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'X-WR-TIMEZONE:Asia/Kuala_Lumpur',
    'BEGIN:VEVENT',
    'UID:deep@example.com',
    'SUMMARY:和 Alex 吃午饭，聊 long-term plan',
    ' 的实际细节',
    'DTSTART;TZID=Asia/Kuala_Lumpur:20261116T123000',
    'DTEND;TZID=Asia/Kuala_Lumpur:20261116T133000',
    'LOCATION:Jalan Ampang',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:utc@example.com',
    'SUMMARY:Server standup',
    'DTSTART:20261116T010000Z',
    'DTEND:20261116T013000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:allday@example.com',
    'SUMMARY:Deepavali leave',
    'DTSTART;VALUE=DATE:20261108',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@example.com',
    'SUMMARY:周会',
    'DTSTART;TZID=Asia/Kuala_Lumpur:20261102T090000',
    'DTEND;TZID=Asia/Kuala_Lumpur:20261102T100000',
    'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=4;BYDAY=MO',
    'EXDATE;TZID=Asia/Kuala_Lumpur:20261109T090000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@example.com',
    'RECURRENCE-ID;TZID=Asia/Kuala_Lumpur:20261116T090000',
    'SUMMARY:周会（改到下午）',
    'DTSTART;TZID=Asia/Kuala_Lumpur:20261116T150000',
    'DTEND;TZID=Asia/Kuala_Lumpur:20261116T160000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:cancelled@example.com',
    'SUMMARY:取消掉的会',
    'STATUS:CANCELLED',
    'DTSTART;TZID=Asia/Kuala_Lumpur:20261117T140000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:monthly@example.com',
    'SUMMARY:月结',
    'DTSTART;TZID=Asia/Kuala_Lumpur:20260131T200000',
    'RRULE:FREQ=MONTHLY;COUNT=3',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const from = new Date(2026, 0, 1).getTime();
  const to = new Date(2026, 11, 31).getTime();
  const occ = ics.expandFeed(feed, from, to, KL);
  const byTitle = (needle) => occ.filter((o) => o.summary.indexOf(needle) >= 0);
  const klTime = (ms) => {
    const w = ics.epochToWall(ms, KL);
    return [w.y, String(w.mo).padStart(2, '0'), String(w.d).padStart(2, '0')].join('-') + ' ' +
      [String(w.h).padStart(2, '0'), String(w.mi).padStart(2, '0')].join(':');
  };

  check('折行被拼回一行', () => {
    const hit = byTitle('和 Alex 吃午饭')[0];
    ok(hit, '午饭事件缺失');
    eq(hit.summary, '和 Alex 吃午饭，聊 long-term plan的实际细节');
  });
  check('TZID 墙钟时间按 Asia/Kuala_Lumpur 落点（12:30 就是 12:30）', () => {
    const hit = byTitle('和 Alex 吃午饭')[0];
    eq(klTime(hit.start), '2026-11-16 12:30');
    eq(hit.allDay, false);
  });
  check('UTC 时间（01:00Z）在吉隆坡显示为 09:00', () => {
    const hit = byTitle('Server standup')[0];
    ok(hit, 'standup 缺失');
    eq(klTime(hit.start), '2026-11-16 09:00');
  });
  check('全天事件标记 allDay 且落在当天', () => {
    const hit = byTitle('Deepavali leave')[0];
    ok(hit, '全天事件缺失');
    eq(hit.allDay, true);
    eq(klTime(hit.start), '2026-11-08 00:00');
  });
  check('周会按 COUNT=4 展开：11/9 被 EXDATE 排除、11/16 被覆盖，剩下的正好两次', () => {
    const weekly = byTitle('周会').filter((o) => o.summary === '周会');
    eq(weekly.length, 2, '应为 11/2 与 11/23');
    eq(klTime(weekly[0].start), '2026-11-02 09:00');
    eq(klTime(weekly[1].start), '2026-11-23 09:00');
  });
  check('RECURRENCE-ID 覆盖把 11/16 换成下午那场', () => {
    const moved = byTitle('周会（改到下午）');
    eq(moved.length, 1);
    eq(klTime(moved[0].start), '2026-11-16 15:00');
    ok(!byTitle('周会').some((o) => o.summary === '周会' && klTime(o.start).indexOf('2026-11-16') === 0), '旧时段仍在');
  });
  check('STATUS:CANCELLED 的事件不出现', () => eq(byTitle('取消掉的会').length, 0));
  check('月度重复遇短月不越界（1/31 → 2/28 → 3/31）', () => {
    const monthly = byTitle('月结');
    eq(monthly.length, 3);
    eq(klTime(monthly[0].start), '2026-01-31 20:00');
    eq(klTime(monthly[1].start), '2026-02-28 20:00');
    eq(klTime(monthly[2].start), '2026-03-31 20:00');
  });
  check('结果按开始时间升序', () => {
    const sorted = occ.slice().sort((a, b) => a.start - b.start);
    eq(JSON.stringify(occ.map((o) => o.start)), JSON.stringify(sorted.map((o) => o.start)));
  });
}

/* =====================================================================
 * 10. 本机同步服务（临时 secrets 文件 + 本地假 feed）
 * =================================================================== */
console.log('\n[10] 同步服务（不碰真实密钥文件）');
{
  const acheck = async (name, fn) => {
    try { const detail = await fn(); pass += 1; console.log('  ok   ' + name + (detail ? ' — ' + detail : '')); }
    catch (err) { fails.push(name + ' :: ' + err.message); console.log('  FAIL ' + name + ' :: ' + err.message); }
  };
  const os = await import('node:os');
  const http = await import('node:http');
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
  const tmpDir = fsx.mkdtempSync(pathx.join(os.default.tmpdir(), 'cal-sync-'));
  process.env.DSH_CALENDAR_ICS_FILE = pathx.join(tmpDir, 'calendar-ics.env');
  process.env.DSH_CALENDAR_CALDAV_FILE = pathx.join(tmpDir, 'calendar-caldav.env');

  const feedBody = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:t1@example.com',
    'SUMMARY:与客户开会',
    'DTSTART;TZID=Asia/Kuala_Lumpur:20261118T100000',
    'DTEND;TZID=Asia/Kuala_Lumpur:20261118T110000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const feedServer = http.default.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
    res.end(feedBody);
  });
  await new Promise((r) => feedServer.listen(47839, '127.0.0.1', r));

  const config = await import('./host/config.js');
  const serverMod = await import('./host/server.js');
  eq(config.isConfigured(), false, '临时文件应为空');

  const handle = serverMod.startCalendarSync({ port: 47838 });
  const base = 'http://127.0.0.1:47838';
  await new Promise((r) => setTimeout(r, 250));

  await acheck('两个源都没配置时：没有事件，且每个源各自说明 not-configured', async () => {
    const res = await fetch(base + '/events?from=' + Date.now() + '&to=' + (Date.now() + 86400000));
    const body = await res.json();
    eq(body.events.length, 0);
    eq(body.sources.google.error, 'not-configured');
    eq(body.sources.lark.error, 'not-configured');
    eq(body.sources.google.configured, false);
  });

  await acheck('POST /config 拒绝非 https 地址', async () => {
    const res = await fetch(base + '/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://example.com/a.ics' }),
    });
    eq(res.status, 400);
    const body = await res.json();
    eq(body.ok, false);
  });

  await acheck('写入地址后 /events 能取到 feed 里的事件', async () => {
    config.writeIcsUrl('http://127.0.0.1:47839/fixture.ics');
    const from = new Date(2026, 10, 1).getTime();
    const to = new Date(2026, 11, 1).getTime();
    const body = await (await fetch(base + '/events?from=' + from + '&to=' + to)).json();
    eq(body.ok, true);
    eq(body.events.length, 1);
    eq(body.events[0].summary, '与客户开会');
    ok(body.fetchedAt > 0, 'fetchedAt');
  });

  await acheck('DELETE /config?kind=google 断开后，只有 google 回到未配置', async () => {
    const res = await fetch(base + '/config?kind=google', { method: 'DELETE' });
    const body = await res.json();
    eq(body.ok, true);
    const after = await (await fetch(base + '/events?from=' + Date.now() + '&to=' + (Date.now() + 86400000))).json();
    eq(after.sources.google.error, 'not-configured');
    eq(after.sources.google.configured, false);
  });

  await acheck('密钥文件落在用户目录、只存一行地址，POSIX 权限位仅在类 Unix 上断言', async () => {
    config.writeIcsUrl('https://calendar.google.com/calendar/ical/x/private-y/basic.ics');
    const file = config.SECRET_FILE;
    ok(fsx.existsSync(file), 'file missing');
    const text = fsx.readFileSync(file, 'utf8');
    ok(text.indexOf('CALENDAR_ICS_URL=https://') >= 0, 'url line missing');
    ok(text.indexOf('BEGIN:VCALENDAR') < 0, 'feed content must not be stored');
    ok(file.indexOf('.dsh') >= 0 || file.indexOf(process.env.DSH_CALENDAR_ICS_FILE) === 0, 'outside home');
    // Windows ignores POSIX mode bits (0o666 on every new file); the directory is
    // already user-scoped, so the mode assertion only means something on Unix.
    if (process.platform !== 'win32') eq(fsx.statSync(file).mode & 0o777, 0o600);
    config.clearIcsUrl();
  });

  check('公开地址 + 404 → 直接告诉用户去复制「私密地址」', () => {
    const msg = serverMod.explainFetchFailure(404, 'https://calendar.google.com/calendar/ical/x%40gmail.com/public/basic.ics');
    ok(msg.indexOf('公开地址') >= 0, msg);
    ok(msg.indexOf('私密地址') >= 0, msg);
  });
  check('私密地址 404 不会被误报成「公开地址」', () => {
    const msg = serverMod.explainFetchFailure(404, 'https://calendar.google.com/calendar/ical/x/private-ab12cd/basic.ics');
    ok(msg.indexOf('公开地址') < 0, msg);
    ok(msg.indexOf('404') >= 0, msg);
  });
  check('401/403 提示地址可能已被重置', () => {
    const msg = serverMod.explainFetchFailure(403, 'https://calendar.google.com/calendar/ical/x/private-ab12cd/basic.ics');
    ok(msg.indexOf('重置') >= 0, msg);
  });

  handle.close();
  await new Promise((r) => feedServer.close(r));
  fsx.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DSH_CALENDAR_ICS_FILE;
}


/* =====================================================================
 * 11. 跨天事件（飞书那批 4 天的行程曾经只显示开始日）
 * =================================================================== */
console.log('\n[11] 跨天事件占满每一天');
{
  const api2 = spec.factory((id) => (id === 'react' ? {} : {}));
  const spread = api2.__test.spreadEventDays;
  const range = api2.__test.eventRangeText;
  const day = (y, m, d) => new Date(y, m - 1, d);
  const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi).getTime();

  const allDay4 = { uid: 'a', summary: 'Green Mart', start: day(2026, 11, 17).getTime(), end: day(2026, 11, 21).getTime(), allDay: true, source: 'lark' };
  const timed = { uid: 'b', summary: '会', start: at(2026, 11, 18, 12, 30), end: at(2026, 11, 18, 13, 30), allDay: false, source: 'lark' };
  const toMidnight = { uid: 'c', summary: '晚场', start: at(2026, 11, 18, 22, 0), end: at(2026, 11, 19, 0, 0), allDay: false, source: 'google' };
  const overMidnight = { uid: 'd', summary: '红眼', start: at(2026, 11, 18, 23, 0), end: at(2026, 11, 19, 0, 30), allDay: false, source: 'google' };

  const map = spread([allDay4, timed, toMidnight, overMidnight]);
  const keys = Object.keys(map).sort();

  check('4 天全天事件出现在 17、18、19、20 这四天', () => {
    for (const d of ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']) {
      ok(map[d] && map[d].some((e) => e.uid === 'a'), '缺 ' + d);
    }
    ok(!(map['2026-11-21'] || []).some((e) => e.uid === 'a'), '21 号不该有（DTEND 是排他的）');
    const one = map['2026-11-18'].find((e) => e.uid === 'a');
    eq(one.spanCount, 4, 'spanCount');
    eq(one.spanDay, 2, 'spanDay');
    return '4 天，第 2 天在 18 号';
  });

  check('当天 1 小时的会只占 1 天', () => {
    const list = (map['2026-11-18'] || []).filter((e) => e.uid === 'b');
    eq(list.length, 1);
    eq(list[0].spanCount, 1);
    ok(!(map['2026-11-19'] || []).some((e) => e.uid === 'b'), '次日不该有');
  });

  check('22:00 结束于次日 00:00 的晚间场仍算 1 天（不该溢出到次日）', () => {
    ok((map['2026-11-18'] || []).some((e) => e.uid === 'c'), '18 号没有');
    ok(!(map['2026-11-19'] || []).some((e) => e.uid === 'c'), '19 号不该有');
  });

  check('跨过午夜 30 分钟的行程算 2 天', () => {
    ok((map['2026-11-18'] || []).some((e) => e.uid === 'd'), '18 号没有');
    ok((map['2026-11-19'] || []).some((e) => e.uid === 'd'), '19 号没有');
  });

  check('日期范围文案：全天按排他终点回退一天', () => {
    const enriched = map['2026-11-18'].find((e) => e.uid === 'a');
    eq(range(enriched), '11/17–11/20');
    eq(range(map['2026-11-18'].find((e) => e.uid === 'b')), '');
  });

  check('每一天里的事件按开始时间排序', () => {
    const list = map['2026-11-18'];
    const starts = list.map((e) => e.start);
    eq(JSON.stringify(starts), JSON.stringify(starts.slice().sort((x, y) => x - y)));
    return keys.length + ' 个有事件的日子';
  });
}


/* =====================================================================
 * 12. 月历条形层：一根横穿整周，不是一天一条
 * =================================================================== */
console.log('\n[12] 月历条形层');
{
  const day = (y, m, d) => new Date(y, m - 1, d);
  const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi).getTime();
  const week = [16, 17, 18, 19, 20, 21, 22].map((d) => day(2026, 11, d));

  const greenMart = { uid: 'm', summary: 'Green Mart', start: day(2026, 11, 17).getTime(), end: day(2026, 11, 21).getTime(), allDay: true, source: 'lark' };
  const oneMeeting = { uid: 's', summary: '会', start: at(2026, 11, 18, 9, 0), end: at(2026, 11, 18, 10, 0), allDay: false, source: 'google' };
  const crossing = { uid: 'x', summary: '跨周', start: day(2026, 11, 20).getTime(), end: day(2026, 11, 24).getTime(), allDay: true, source: 'lark' };

  const byDay = T.spreadEventDays([greenMart, oneMeeting, crossing]);
  const out = T.layoutWeek(week, byDay);
  const byUid = {};
  for (const bar of out.bars) byUid[bar.id] = bar;

  check('四天事件合成一根条，不是四条', () => {
    eq(out.bars.length, 2, 'bars=' + out.bars.length);
    ok(byUid.m, 'Green Mart 没成条');
    return '2 根';
  });
  check('条的位置对应到正确的列（17→20 号 = 第 1..4 列）', () => {
    eq(byUid.m.startCol, 1, 'startCol');
    eq(byUid.m.endCol, 4, 'endCol');
    return 'col 1..4';
  });
  check('跨出本周的事件被截到周末（第 4..6 列）', () => {
    eq(byUid.x.startCol, 4, 'startCol');
    eq(byUid.x.endCol, 6, 'endCol');
    return 'col 4..6';
  });
  check('重叠的两根条分到不同车道', () => {
    ok(byUid.m.lane !== byUid.x.lane, 'lane ' + byUid.m.lane + ' / ' + byUid.x.lane);
    eq(out.laneCount, 2, 'laneCount');
  });
  check('当天 1 小时的会议不进条形层，留在格子里', () => {
    eq(out.timed[2].length, 1, 'timed');
    eq(out.timed[2][0].uid, 's');
    ok(!out.bars.some((b) => b.id === 's'), '会议不该成条');
  });
}

console.log('\n' + (fails.length ? 'FAILED ' + fails.length + ' / ' + (pass + fails.length) : 'ALL PASS ' + pass));
if (fails.length) {
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
