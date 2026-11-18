window.__ModuleLoader__.load({
  id: '@local/dsh-calendar',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useCallback = React.useCallback;

    /* =====================================================================
     * 1. 干支 / 十神 / 命局
     * =================================================================== */

    const STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
    const BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
    const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
    const STEM_EL = ['木', '木', '火', '火', '土', '土', '金', '金', '水', '水'];
    const BRANCH_EL = ['水', '土', '木', '木', '土', '火', '火', '土', '金', '金', '土', '水'];
    const EL_ORDER = { 木: 0, 火: 1, 土: 2, 金: 3, 水: 4 };
    const WEEKDAY_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const HEAD_ZH = ['日', '一', '二', '三', '四', '五', '六'];
    const HEAD_EN = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    const LUNAR_DAYS = [
      '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
      '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
      '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
    ];

    // The chart is per-user data, loaded from ~/.dsh/secrets/calendar-profile.json
    // by the Host half. Shipping a hardcoded chart would publish one person's birth
    // data to everyone who installs the plugin, so CHART starts empty.
    const CHART = {
      pillars: [],
      labels: ['年柱', '月柱', '日柱', '时柱'],
      dayMasterStem: -1,
      dayMaster: '',
      dayMasterElement: '',
      strength: '',
      useful: '',
      favorable: '',
      adverse: [],
      branchRoles: [],
    };

    /** True once a chart has been loaded (or entered in the panel). */
    function hasChart() {
      return CHART.dayMasterStem >= 0 && CHART.pillars.length === 4;
    }

    /** "癸酉 癸亥 丙辰 丁酉" -> CHART. Returns an error string, or ''. */
    function applyChartText(text) {
      const pairs = String(text || '').trim().split(/[\s,，]+/).filter(Boolean);
      if (pairs.length !== 4) return '需要四个柱，例如：癸酉 癸亥 丙辰 丁酉';
      const pillars = [];
      for (const pair of pairs) {
        const stem = STEMS.indexOf(pair.charAt(0));
        const branch = BRANCHES.indexOf(pair.charAt(1));
        if (pair.length < 2 || stem < 0 || branch < 0) return '看不懂这一柱：' + pair;
        pillars.push([STEMS[stem], BRANCHES[branch]]);
      }
      CHART.pillars = pillars;
      CHART.dayMasterStem = STEMS.indexOf(pillars[2][0]);
      CHART.dayMaster = pillars[2][0];
      CHART.dayMasterElement = STEM_EL[CHART.dayMasterStem];
      CHART.branchRoles = pillars.map(function (pair, i) {
        return { i: BRANCHES.indexOf(pair[1]), role: ['年支', '月支', '日支', '时支'][i], rel: pair[1] };
      });
      return '';
    }

    /** 相对日主的十神；dayMaster / other 都是天干下标。 */
    function tenGod(dayMaster, other) {
      const a = EL_ORDER[STEM_EL[dayMaster]];
      const b = EL_ORDER[STEM_EL[other]];
      const same = dayMaster % 2 === other % 2;
      if (a === b) return same ? '比肩' : '劫财';
      if ((a + 1) % 5 === b) return same ? '食神' : '伤官'; // 我生
      if ((a + 2) % 5 === b) return same ? '偏财' : '正财'; // 我克
      if ((b + 2) % 5 === a) return same ? '七杀' : '正官'; // 克我
      return same ? '偏印' : '正印'; // 生我
    }

    // 日柱基准：1993-12-01 为丙辰日（六十甲子序号 52），此盘来自引擎实测。
    const DAY_BASE_UTC = Date.UTC(1993, 11, 1);
    const DAY_BASE_INDEX = 52;

    function ganzhiOfDay(date) {
      const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
      const delta = Math.round((utc - DAY_BASE_UTC) / 86400000);
      const index = ((DAY_BASE_INDEX + delta) % 60 + 60) % 60;
      const stemIndex = index % 10;
      const branchIndex = index % 12;
      return {
        index: index,
        stem: STEMS[stemIndex],
        branch: BRANCHES[branchIndex],
        stemIndex: stemIndex,
        branchIndex: branchIndex,
        text: STEMS[stemIndex] + BRANCHES[branchIndex],
      };
    }

    /* =====================================================================
     * 2. 农历（ICU 中国历法）
     * =================================================================== */

    let LUNAR_FMT = null;
    try {
      LUNAR_FMT = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch (err) {
      LUNAR_FMT = null;
    }

    const lunarCache = new Map();

    function lunarOf(date) {
      const key = dateKey(date);
      const cached = lunarCache.get(key);
      if (cached) return cached;

      let month = '';
      let day = '';
      let yearName = '';
      if (LUNAR_FMT) {
        try {
          const parts = LUNAR_FMT.formatToParts(date);
          for (let i = 0; i < parts.length; i += 1) {
            const p = parts[i];
            if (p.type === 'month') month = p.value;
            else if (p.type === 'day') day = p.value;
            else if (p.type === 'yearName') yearName = p.value;
          }
        } catch (err) {
          month = '';
          day = '';
          yearName = '';
        }
      }

      const num = parseInt(day, 10);
      const dayNum = Number.isFinite(num) ? num : 0;
      const result = {
        month: month || '',
        monthClean: month.replace('闰', ''),
        isLeap: month.indexOf('闰') === 0,
        dayNum: dayNum,
        dayName: dayNum >= 1 && dayNum <= 30 ? LUNAR_DAYS[dayNum - 1] : day || '',
        yearName: yearName || '',
      };
      lunarCache.set(key, result);
      return result;
    }

    function zodiacOfYear(yearName) {
      if (!yearName || yearName.length < 2) return '';
      const idx = BRANCHES.indexOf(yearName.charAt(1));
      return idx >= 0 ? ZODIAC[idx] : '';
    }

    const LUNAR_FESTIVALS = {
      '正月-1': '春节',
      '正月-15': '元宵',
      '二月-2': '龙抬头',
      '五月-5': '端午',
      '七月-7': '七夕',
      '七月-15': '中元',
      '八月-15': '中秋',
      '九月-9': '重阳',
      '腊月-8': '腊八',
      '腊月-23': '小年',
    };

    function lunarFestival(date) {
      const lunar = lunarOf(date);
      if (!lunar.monthClean || !lunar.dayNum) return '';
      // 除夕：次日为正月初一
      const tomorrow = addDays(date, 1);
      const t = lunarOf(tomorrow);
      if (t.monthClean === '正月' && t.dayNum === 1) return '除夕';
      return LUNAR_FESTIVALS[lunar.monthClean + '-' + lunar.dayNum] || '';
    }

    /* =====================================================================
     * 3. 马来西亚公共假期（联邦级，2026–2027）
     * =================================================================== */

    const HOLIDAYS = {
      '2026-01-01': [{ n: '元旦', scope: '多数州属', federal: false }],
      '2026-02-17': [{ n: '农历新年', scope: '全国', federal: true }],
      '2026-02-18': [{ n: '农历新年初二', scope: '除吉兰丹、登嘉楼', federal: true }],
      '2026-03-20': [{ n: '开斋节次日假期', scope: '全国', federal: true }],
      '2026-03-21': [{ n: '开斋节', scope: '全国', federal: true }],
      '2026-05-01': [{ n: '劳动节', scope: '全国', federal: true }],
      '2026-05-27': [{ n: '哈芝节', scope: '全国', federal: true }],
      '2026-05-31': [{ n: '卫塞节', scope: '全国', federal: true }],
      '2026-06-01': [{ n: '国家元首诞辰', scope: '全国', federal: true }],
      '2026-06-17': [{ n: '回历新年', scope: '全国', federal: true }],
      '2026-08-25': [{ n: '先知诞辰', scope: '全国', federal: true }],
      '2026-08-31': [{ n: '国庆日', scope: '全国', federal: true }],
      '2026-09-16': [{ n: '马来西亚日', scope: '全国', federal: true }],
      '2026-11-08': [{ n: '屠妖节', scope: '除砂拉越', federal: true }],
      '2026-12-25': [{ n: '圣诞节', scope: '全国', federal: true }],
      '2027-01-01': [{ n: '元旦', scope: '多数州属', federal: false }],
      '2027-02-06': [{ n: '农历新年', scope: '全国', federal: true }],
      '2027-02-07': [{ n: '农历新年初二', scope: '除吉兰丹、登嘉楼', federal: true }],
      '2027-03-10': [{ n: '开斋节', scope: '全国（暂定）', federal: true }],
      '2027-03-11': [{ n: '开斋节次日', scope: '全国（暂定）', federal: true }],
      '2027-05-01': [{ n: '劳动节', scope: '全国', federal: true }],
      '2027-05-17': [{ n: '哈芝节', scope: '全国（暂定）', federal: true }],
      '2027-05-20': [{ n: '卫塞节', scope: '全国', federal: true }],
      '2027-06-06': [{ n: '回历新年', scope: '全国（暂定）', federal: true }],
      '2027-06-07': [{ n: '国家元首诞辰', scope: '全国', federal: true }],
      '2027-08-15': [{ n: '先知诞辰', scope: '全国（暂定）', federal: true }],
      '2027-08-31': [{ n: '国庆日', scope: '全国', federal: true }],
      '2027-09-16': [{ n: '马来西亚日', scope: '全国', federal: true }],
      '2027-10-28': [{ n: '屠妖节', scope: '除砂拉越', federal: true }],
      '2027-12-25': [{ n: '圣诞节', scope: '全国', federal: true }],
    };

    const HOLIDAY_KEYS = Object.keys(HOLIDAYS).sort();

    function holidaysOf(date) {
      return HOLIDAYS[dateKey(date)] || [];
    }

    function nextHolidayAfter(date) {
      const list = holidaysAfter(date, 1);
      return list.length ? list[0] : null;
    }

    function holidaysAfter(date, count) {
      const key = dateKey(date);
      const base = startOfDay(date).getTime();
      const out = [];
      for (let i = 0; i < HOLIDAY_KEYS.length && out.length < count; i += 1) {
        const k = HOLIDAY_KEYS[i];
        if (k <= key) continue;
        const parts = k.split('-').map(Number);
        const target = new Date(parts[0], parts[1] - 1, parts[2]);
        out.push({
          key: k,
          date: target,
          name: HOLIDAYS[k][0].n,
          scope: HOLIDAYS[k][0].scope,
          days: Math.round((target.getTime() - base) / 86400000),
        });
      }
      return out;
    }

    // 万年历的日冲煞：当日地支冲其对宫生肖；煞方按支序每四位循环南东西北。
    function clashOf(branchIndex) {
      const clashBranch = (branchIndex + 6) % 12;
      const directions = ['南', '东', '北', '西'];
      return {
        zodiac: ZODIAC[clashBranch],
        branch: BRANCHES[clashBranch],
        direction: directions[branchIndex % 4],
      };
    }

    /* =====================================================================
     * 4. 日期工具
     * =================================================================== */

    function startOfDay(d) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function addDays(d, n) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    }

    function dateKey(d) {
      const m = d.getMonth() + 1;
      const day = d.getDate();
      return d.getFullYear() + '-' + (m < 10 ? '0' + m : String(m)) + '-' + (day < 10 ? '0' + day : String(day));
    }

    function sameDay(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }

    function monthCells(year, month) {
      const first = new Date(year, month, 1);
      const start = new Date(year, month, 1 - first.getDay());
      const cells = [];
      for (let i = 0; i < 42; i += 1) {
        cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
      }
      return cells;
    }

    /* =====================================================================
     * 5. 地支关系与当日运程
     * =================================================================== */

    const PAIRS_CHONG = [[0, 6], [1, 7], [2, 8], [3, 9], [4, 10], [5, 11]];
    const PAIRS_HE = [[0, 1], [2, 11], [3, 10], [4, 9], [5, 8], [6, 7]];
    const PAIRS_HAI = [[0, 7], [1, 6], [2, 5], [3, 4], [8, 11], [9, 10]];
    const XING_SETS = [[2, 5, 8], [1, 10, 7]];
    const ZI_XING = [4, 6, 9, 11];
    const SANHE_SETS = [[8, 0, 4], [11, 3, 7], [2, 6, 10], [5, 9, 1]];

    const REL_LABEL = { chong: '冲', he: '合', hai: '害', xing: '刑', banhe: '半合' };

    function isPair(list, a, b) {
      for (let i = 0; i < list.length; i += 1) {
        const p = list[i];
        if ((p[0] === a && p[1] === b) || (p[0] === b && p[1] === a)) return true;
      }
      return false;
    }

    function relationsToChart(branchIndex) {
      const out = [];
      for (let i = 0; i < CHART.branchRoles.length; i += 1) {
        const role = CHART.branchRoles[i];
        const weight = role.role === '日支' ? 1 : 0.55;
        if (isPair(PAIRS_CHONG, branchIndex, role.i)) out.push({ type: 'chong', text: '冲' + role.role, weight: weight });
        if (isPair(PAIRS_HE, branchIndex, role.i)) out.push({ type: 'he', text: '合' + role.role, weight: weight });
        if (isPair(PAIRS_HAI, branchIndex, role.i)) out.push({ type: 'hai', text: '害' + role.role, weight: weight });
        let xing = false;
        for (let j = 0; j < XING_SETS.length; j += 1) {
          const set = XING_SETS[j];
          if (set.indexOf(branchIndex) >= 0 && set.indexOf(role.i) >= 0 && branchIndex !== role.i) xing = true;
        }
        if (branchIndex === role.i && ZI_XING.indexOf(branchIndex) >= 0) xing = true;
        if (xing) out.push({ type: 'xing', text: '刑' + role.role, weight: weight });
      }
      for (let i = 0; i < SANHE_SETS.length; i += 1) {
        const group = SANHE_SETS[i];
        if (group.indexOf(branchIndex) < 0) continue;
        let mate = -1;
        for (let j = 0; j < group.length; j += 1) {
          const x = group[j];
          if (x === branchIndex) continue;
          for (let k = 0; k < CHART.branchRoles.length; k += 1) {
            if (CHART.branchRoles[k].i === x) mate = x;
          }
        }
        if (mate >= 0) out.push({ type: 'banhe', text: '半合' + BRANCHES[mate], weight: 0.7 });
      }
      return out;
    }

    const FAV_OF = { 木: 1, 火: 1, 土: 0, 金: -1, 水: -1 };

    const GOD_EFFECT = {
      比肩: { career: 3, wealth: -5, social: 7, love: -5, health: 2 },
      劫财: { career: 2, wealth: -7, social: 6, love: -7, health: 1 },
      食神: { career: 5, wealth: 7, social: 6, love: 4, health: 4 },
      伤官: { career: 6, wealth: 6, social: 3, love: 2, health: 2 },
      偏财: { career: 4, wealth: 6, social: 3, love: 5, health: -2 },
      正财: { career: 5, wealth: 5, social: 2, love: 8, health: -2 },
      七杀: { career: 4, wealth: -2, social: -5, love: -3, health: -6 },
      正官: { career: 6, wealth: 2, social: -3, love: -2, health: -4 },
      偏印: { career: 6, wealth: -2, social: 3, love: 2, health: 4 },
      正印: { career: 7, wealth: -3, social: 5, love: 3, health: 5 },
    };

    const REL_EFFECT = {
      chong: { career: -3, wealth: -2, social: -3, love: -3, health: -7 },
      he: { career: 2, wealth: 2, social: 5, love: 5, health: 2 },
      hai: { career: -1, wealth: -1, social: -2, love: -2, health: -1 },
      xing: { career: -2, wealth: -2, social: -2, love: -2, health: -5 },
      banhe: { career: 1, wealth: 2, social: 3, love: 3, health: 1 },
    };

    const LANES = [
      { key: 'career', zh: '事业' },
      { key: 'wealth', zh: '财运' },
      { key: 'social', zh: '人缘' },
      { key: 'love', zh: '感情' },
      { key: 'health', zh: '健康' },
    ];

    function clamp(n, lo, hi) {
      return Math.max(lo, Math.min(hi, n));
    }

    function bandOf(score) {
      if (score >= 75) return 'hi';
      if (score >= 58) return 'mid';
      return 'lo';
    }

    function fortuneFor(date) {
      if (!hasChart()) return null;
      const gz = ganzhiOfDay(date);
      const god = tenGod(CHART.dayMasterStem, gz.stemIndex);
      const stemEl = STEM_EL[gz.stemIndex];
      const branchEl = BRANCH_EL[gz.branchIndex];
      const rels = relationsToChart(gz.branchIndex);
      const favStem = FAV_OF[stemEl] || 0;
      const favBranch = FAV_OF[branchEl] || 0;

      const scores = {};
      const basis = {};
      for (let i = 0; i < LANES.length; i += 1) {
        const lane = LANES[i];
        let score = 60;
        const ge = GOD_EFFECT[god] || {};
        score += ge[lane.key] || 0;
        score += favStem * (lane.key === 'health' ? 6 : 4);
        score += favBranch * (lane.key === 'health' ? 5 : 3);
        let decay = 1;
        const reasons = [];
        for (let j = 0; j < rels.length; j += 1) {
          const rel = rels[j];
          const table = REL_EFFECT[rel.type] || {};
          score += (table[lane.key] || 0) * rel.weight * decay;
          decay *= 0.7;
          if (reasons.indexOf(rel.text) < 0) reasons.push(rel.text);
        }
        scores[lane.key] = clamp(Math.round(score), 18, 97);
        basis[lane.key] = reasons;
      }

      const total = Math.round(LANES.reduce(function (sum, lane) { return sum + scores[lane.key]; }, 0) / LANES.length);
      return {
        gz: gz,
        god: god,
        stemEl: stemEl,
        branchEl: branchEl,
        rels: rels,
        relText: rels.length ? rels.map(function (r) { return r.text; }).join('、') : '无刑冲合害',
        scores: scores,
        basis: basis,
        total: total,
        band: bandOf(total),
      };
    }

    /* =====================================================================
     * 6. 文案
     * =================================================================== */

    const STR = {
      zh: {
        panel: '万年历',
        today: '今天',
        todayAlmanac: '今日万年历',
        pickedAlmanac: '当日万年历',
        prevMonth: '上个月',
        nextMonth: '下个月',
        backToday: '回到今天',
        lunar: '农历',
        zodiacYear: '岁次',
        dayPillar: '日柱',
        dayGod: '值日十神',
        dayEl: '今日五行',
        withChart: '与命局',
        nextHoliday: '距',
        nextHolidayTail: '还有',
        days: '天',
        monthHolidays: '本月假期',
        noMonthHoliday: '本月没有联邦公共假期',
        itinerary: '每日行程',
        emptyPlan: '这天还没有安排。',
        addHint: '时间 / 内容，回车添加',
        add: '添加',
        remove: '删除',
        done: '完成',
        reading: '今日运程',
        pickedReading: '当日运程',
        chartLine: '命局',
        total: '总评',
        basisLabel: '依据',
        footer: '农历由中国历法（ICU chinese calendar）换算 · 公共假期为马来西亚联邦级假期，仅覆盖 2026–2027，州假与临时调整以官方公告为准 · 运程依命局 癸酉 癸亥 丙辰 丁酉（日主丙火）推算，作为自我观察的参考视角，不是决定。',
        noLunar: '当前运行环境无法换算农历',
        clash: '冲煞',
        upcoming: '接下来',
        scopeFederal: '联邦',
        scopeState: '州属',
        phoneCal: '手机日历',
        phoneCalHint: '把 Google 日历里的「私密 iCal 地址」粘在这里：手机上同步到 Google 的行程就会出现。手机本地/设备日历的行程不会上传，必须存在 Google 账户下。',
        phoneCalSave: '连接',
        phoneCalDisconnect: '断开',
        phoneCalOff: '未连接手机日历',
        phoneCalError: '同步失败',
        phoneCalDown: '同步服务未启动：重启一次 DSH 后生效',
        phoneCalStale: '离线缓存',
        larkCal: '飞书日历',
        larkUser: '用户名',
        larkPass: '密码',
        larkSave: '连接飞书',
        larkOff: '未连接飞书日历',
        larkHint: '飞书客户端 → 设置 → 日历 → CalDAV 同步：那里会给服务器地址、用户名和密码',
        phoneCalPublic: '这是「公开地址」：日历没公开时读不到。请点开「私密地址」旁的眼睛图标再复制。',
        updated: '更新于',
        phoneCalRefresh: '刷新',
        phoneCalEvents: '条行程',
        allDay: '全天',
        chartUnset: '还没设置命局',
        chartHint: '四柱，例如 癸酉 癸亥 丙辰 丁酉',
        chartExample: '只存本机（~/.dsh/secrets/calendar-profile.json），不会上传',
        chartSave: '保存命局',
      },
      en: {
        panel: 'Almanac',
        today: 'Today',
        todayAlmanac: "Today's Almanac",
        pickedAlmanac: 'Almanac',
        prevMonth: 'Previous month',
        nextMonth: 'Next month',
        backToday: 'Back to today',
        lunar: 'Lunar',
        zodiacYear: 'Year',
        dayPillar: 'Day pillar',
        dayGod: 'Day officer',
        dayEl: 'Day element',
        withChart: 'Vs chart',
        nextHoliday: '',
        nextHolidayTail: 'until',
        days: 'days',
        monthHolidays: 'Holidays this month',
        noMonthHoliday: 'No federal holiday this month',
        itinerary: 'Day plan',
        emptyPlan: 'Nothing planned for this day yet.',
        addHint: 'Time / what to do, press Enter',
        add: 'Add',
        remove: 'Remove',
        done: 'Done',
        reading: 'Daily reading',
        pickedReading: 'Reading',
        chartLine: 'Chart',
        total: 'Overall',
        basisLabel: 'Basis',
        footer: 'Lunar dates come from the ICU Chinese calendar. Malaysian federal public holidays only for 2026–2027; state holidays and provisional dates follow the official gazette. The reading is derived from the chart 癸酉 癸亥 丙辰 丁酉 (day master 丙 fire) as a lens for self-observation, not a verdict.',
        noLunar: 'This runtime cannot convert the Chinese calendar',
        clash: 'Clash',
        upcoming: 'Upcoming',
        scopeFederal: 'Federal',
        scopeState: 'State',
        phoneCal: 'Phone calendar',
        phoneCalHint: 'Paste the calendar\'s secret iCal address from Google Calendar. Events the phone syncs into that Google account show up here. Device-local events never leave the phone.',
        phoneCalSave: 'Connect',
        phoneCalDisconnect: 'Disconnect',
        phoneCalOff: 'Phone calendar not connected',
        phoneCalError: 'Sync failed',
        phoneCalDown: 'Sync service is not running yet — restart DSH once',
        phoneCalStale: 'cached',
        larkCal: 'Lark',
        larkUser: 'Username',
        larkPass: 'Password',
        larkSave: 'Connect Lark',
        larkOff: 'Lark calendar not connected',
        larkHint: 'Lark client → Settings → Calendar → CalDAV sync: it gives you a server, a username and a password',
        phoneCalPublic: 'That is the public address — it only works on a public calendar. Use the Secret address (click the eye icon) instead.',
        updated: 'Updated',
        phoneCalRefresh: 'Refresh',
        phoneCalEvents: 'events',
        allDay: 'All day',
        chartUnset: 'No chart yet',
        chartHint: 'Four pillars, e.g. 癸酉 癸亥 丙辰 丁酉',
        chartExample: 'Stored locally at ~/.dsh/secrets/calendar-profile.json',
        chartSave: 'Save chart',
      },
    };

    const COPY = {
      zh: {
        career: {
          hi: '印比得力，主动提方案、汇报进度容易被点头；适合把需要别人拍板的事推上去。',
          mid: '按既定节奏推进即可，不必抢跑；把手上未收尾的收干净更值钱。',
          lo: '官杀当令而身弱，今天容易被推着走；把承诺压到最小，先守住已有的。',
        },
        wealth: {
          hi: '食伤生财，进项看得到出口；可以谈价、收账，但要当场落纸面。',
          mid: '财路平稳，宜守成；日常支出照常，避免临时起意的大笔。',
          lo: '比劫夺财，钱容易从朋友、同事、应酬里漏出去；今天不做担保、不借出。',
        },
        social: {
          hi: '比劫食伤通气，人缘活络；约人、问人、求人都比平时顺。',
          mid: '人际平顺但无助力，礼貌即可，不必深谈。',
          lo: '官杀混进人缘，说话容易被当成承诺；今天少表态、多记录。',
        },
        love: {
          hi: '财星到位（男命以财为妻星），适合把话说开，安排一次正经的相处。',
          mid: '感情平淡可控，维持日常关心就够。',
          lo: '比劫争合，容易因第三方或旧事起波澜；今天不翻旧账。',
        },
        health: {
          hi: '木火相生，气色与精神都在线；适合运动，别用熬夜把劲头花掉。',
          mid: '平稳；注意补水与久坐，晚间早半小时收工。',
          lo: '金水偏旺克丙火，容易乏力、头眼不适；今晚早睡、少冰饮，留意睡眠与心血管。',
        },
      },
      en: {
        career: {
          hi: 'Resource and peers support you — propose, report, ask for a decision; it lands today.',
          mid: 'Keep the agreed pace. Closing what is already open is worth more than starting something.',
          lo: 'Officer stars press a weak day master: others set the tempo. Promise less, protect what you hold.',
        },
        wealth: {
          hi: 'Output feeds wealth — negotiate and collect, but put the number in writing on the spot.',
          mid: 'Steady. Keep spending ordinary; skip the large impulse purchase.',
          lo: 'Peers cut into wealth — money leaks through friends, colleagues and social spend. No guarantees today.',
        },
        social: {
          hi: 'Easy line to people. Ask, invite, reach out; it goes better than usual.',
          mid: 'Polite and flat. No deep conversations needed.',
          lo: 'Officer stars in the social lane make a remark sound like a promise. Say less, log more.',
        },
        love: {
          hi: 'Wealth star (spouse star for a male chart) is in place — say the thing, plan real time together.',
          mid: 'Calm and manageable. Ordinary care is enough.',
          lo: 'Competing peers stir old ground. Do not reopen a settled argument today.',
        },
        health: {
          hi: 'Wood feeds fire — energy is there. Train, and do not spend it on a late night.',
          mid: 'Stable. Water, breaks from sitting, and stop half an hour earlier.',
          lo: 'Metal and water press on 丙 fire: fatigue, head and eyes. Sleep early, skip iced drinks.',
        },
      },
    };

    /* =====================================================================
     * 7. 行程存储
     * =================================================================== */

    const STORE_KEY = 'dsh-calendar.itinerary.v1';

    function loadStore() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (err) {
        return {};
      }
    }

    function saveStore(store) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
      } catch (err) {
        /* storage may be unavailable; the panel still works for this session */
      }
    }

    let seq = 0;
    function nextId() {
      seq += 1;
      return 'i' + Date.now().toString(36) + seq.toString(36);
    }

    /* =====================================================================
     * 7b. 手机日历（Google iCal 订阅）
     *
     * The browser cannot fetch the feed (no CORS headers on Google's side), so
     * the Host half proxies it on loopback and this module only reads JSON.
     * A multi-day event is listed on its start day; that is deliberate — the
     * month grid stays one line per day.
     * =================================================================== */

    const SYNC_ENDPOINT = 'http://127.0.0.1:47831';

    /**
     * File every event under each calendar day it covers, not just its start day.
     *
     * iCalendar makes DTEND exclusive for all-day events, so a 17th→21st event
     * occupies the 17th, 18th, 19th and 20th. A timed event that ends exactly at
     * midnight therefore still belongs to one day; one that ends at 00:30 does not.
     */
    function spreadEventDays(events) {
      const map = {};
      const dayStart = function (ms) {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
      };
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i];
        const first = dayStart(ev.start);
        const endMs = Math.max(ev.end || ev.start, ev.start);
        const days = [];
        let cursor = first;
        let guard = 0;
        while (cursor.getTime() < endMs && guard < 400) {
          days.push(cursor);
          cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
          guard += 1;
        }
        if (!days.length) days.push(first);
        for (let d = 0; d < days.length; d += 1) {
          const key = dateKey(days[d]);
          if (!map[key]) map[key] = [];
          map[key].push(Object.assign({}, ev, { spanDay: d + 1, spanCount: days.length }));
        }
      }
      const keys = Object.keys(map);
      for (let i = 0; i < keys.length; i += 1) {
        map[keys[i]].sort(function (a, b) { return a.start - b.start; });
      }
      return map;
    }

    /** "11/17–11/20" for a multi-day event, empty for a single-day one. */
    function eventRangeText(ev) {
      if (!ev || !ev.spanCount || ev.spanCount <= 1) return '';
      const start = new Date(ev.start);
      const rawEnd = new Date(ev.end || ev.start);
      // All-day DTEND is exclusive: a span ending at 21st 00:00 finishes on the 20th.
      const last = ev.allDay ? new Date(rawEnd.getTime() - 1) : rawEnd;
      return (start.getMonth() + 1) + '/' + start.getDate() + '–' + (last.getMonth() + 1) + '/' + last.getDate();
    }


    function useCalendarSync(fromMs, toMs) {
      const [events, setEvents] = useState([]);
      const [meta, setMeta] = useState({
        sources: { google: { configured: null }, lark: { configured: null } },
        fetchedAt: 0, error: null, stale: false, loading: false, warning: null,
      });

      const load = useCallback(function (force) {
        setMeta(function (prev) { return Object.assign({}, prev, { loading: true }); });
        const query = '/events?from=' + fromMs + '&to=' + toMs + (force ? '&refresh=1' : '');
        return fetch(SYNC_ENDPOINT + query, { cache: 'no-store' })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (!data.ok) {
              setEvents([]);
              setMeta(function (prev) { return Object.assign({}, prev, { fetchedAt: 0, error: data.error, stale: false, loading: false }); });
              return;
            }
            setEvents(data.events || []);
            setMeta({
              sources: data.sources || {},
              fetchedAt: data.fetchedAt || 0,
              error: null,
              warning: data.warning || null,
              stale: !!data.stale,
              loading: false,
            });
          })
          .catch(function (err) {
            setMeta(function (prev) {
              return Object.assign({}, prev, { fetchedAt: 0, error: 'service-down', stale: false, loading: false });
            });
          });
      }, [fromMs, toMs]);

      useEffect(function () { load(false); }, [load]);

      const byDay = useMemo(function () {
        return spreadEventDays(events);
      }, [events]);

      const saveUrl = useCallback(function (kind, payload) {
        const body = kind === 'lark'
          ? { kind: 'lark', url: payload.url, user: payload.user, pass: payload.pass }
          : { kind: 'google', url: payload.url };
        return fetch(SYNC_ENDPOINT + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (!data.ok) throw new Error(data.error || 'save failed');
            return load(true);
          });
      }, [load]);

      const disconnect = useCallback(function (kind) {
        return fetch(SYNC_ENDPOINT + '/config?kind=' + (kind === 'lark' ? 'lark' : 'google'), { method: 'DELETE' })
          .then(function () { return load(true); });
      }, [load]);

      return { events: events, byDay: byDay, meta: meta, reload: load, saveUrl: saveUrl, disconnect: disconnect };
    }

    function clockOf(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const pad = function (n) { return n < 10 ? '0' + n : String(n); };
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function eventTimeText(ev, lang) {
      if (ev.allDay) return lang === 'zh' ? '全天' : 'All day';
      const start = clockOf(ev.start);
      const end = ev.end && ev.end > ev.start ? clockOf(ev.end) : '';
      return end ? start + '–' + end : start;
    }

    /* =====================================================================
     * 8. 语言
     * =================================================================== */

    let localeFace = null;

    function useLang() {
      const [snapshot, setSnapshot] = useState(function () {
        if (!localeFace) return null;
        try {
          return localeFace.getSnapshot();
        } catch (err) {
          return null;
        }
      });

      useEffect(function () {
        if (!localeFace) return undefined;
        let off = null;
        try {
          off = localeFace.subscribe(function () {
            try {
              setSnapshot(localeFace.getSnapshot());
            } catch (err) {
              /* keep the current language */
            }
          });
        } catch (err) {
          off = null;
        }
        return function () {
          if (off) off();
        };
      }, []);

      const active = snapshot && snapshot.active ? String(snapshot.active).toLowerCase() : 'zh';
      return active.indexOf('zh') === 0 ? 'zh' : 'en';
    }

    /* =====================================================================
     * 9. 样式
     * =================================================================== */

    const CSS = [
      '.dshcal-page{display:flex;flex-direction:column;gap:16px;height:100%;min-height:0;overflow:auto;padding:20px 24px 28px;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.dshcal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.dshcal-title{font-size:15px;font-weight:600;letter-spacing:.01em}',
      '.dshcal-nav{display:flex;align-items:center;gap:6px}',
      '.dshcal-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit;transition:background .12s ease,border-color .12s ease}',
      '.dshcal-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
      '.dshcal-btn:active{transform:translateY(.5px)}',
      '.dshcal-btn[disabled]{opacity:.45;cursor:default}',
      '.dshcal-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.45fr);gap:16px;align-items:stretch}',
      '@media (max-width:940px){.dshcal-grid{grid-template-columns:minmax(0,1fr)}}',
      '.dshcal-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px 18px;box-sizing:border-box;min-width:0;display:flex;flex-direction:column}',
      '.dshcal-cardhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}',
      '.dshcal-cardtitle{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-cardsub{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-hero{display:flex;align-items:flex-end;gap:14px;margin-bottom:14px}',
      '.dshcal-bigday{font-size:44px;line-height:1;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
      '.dshcal-herometa{padding-bottom:4px}',
      '.dshcal-weekday{font-size:13px;font-weight:600}',
      '.dshcal-ymd{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-lunarline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:12px}',
      '.dshcal-lunarbig{font-size:15px;font-weight:600}',
      '.dshcal-lunarsub{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-rows{display:flex;flex-direction:column;gap:0}',
      '.dshcal-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}',
      '.dshcal-row:last-child{border-bottom:0}',
      '.dshcal-rowkey{font-size:11px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.dshcal-rowval{font-size:12px;font-weight:500;text-align:right;word-break:break-word}',
      '.dshcal-tagrow{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}',
      '.dshcal-tag{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1)}',
      '.dshcal-tag.is-holiday{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.dshcal-tag.is-festival{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-brand-primary)}',
      '.dshcal-countdown{font-size:11px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;margin-top:auto}',
      '.dshcal-countdown b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dshcal-monthhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}',
      '.dshcal-monthname{font-size:14px;font-weight:600}',
      '.dshcal-weekrow{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:0}',
      '.dshcal-weeks{display:flex;flex-direction:column}',
      '.dshcal-week{position:relative;--dshcal-bar-top:38px}',
      '.dshcal-week+.dshcal-week{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dshcal-weekcells{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:0}',
      '.dshcal-barlayer{position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none}',
      '.dshcal-bar{position:absolute;height:13px;line-height:13px;pointer-events:none;margin:0 2px;border-radius:4px}',
      '.dshcal-weekcell{text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 0 4px}',
      '.dshcal-cell{appearance:none;font-family:inherit;text-align:left;border:1px solid transparent;background:transparent;border-radius:9px;padding:0 5px 6px;min-height:78px;cursor:pointer;display:flex;flex-direction:column;gap:0;color:var(--dsw-alias-label-primary);transition:background .12s ease,border-color .12s ease}',
      '.dshcal-cell:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshcal-cell.is-out{opacity:.38}',
      '.dshcal-cell.is-today{border-color:var(--dsw-alias-brand-primary)}',
      '.dshcal-cell.is-selected{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);border-color:var(--dsw-alias-brand-primary)}',
      '.dshcal-cellhead{height:38px;padding-top:6px;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.dshcal-cellspacer{display:block}',
      '.dshcal-cellnum{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:4px}',
      '.dshcal-celllunar{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshcal-celllunar.is-festival{color:var(--dsw-alias-brand-primary)}',
      '.dshcal-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:0 0 auto}',
      '.dshcal-cell.is-holiday .dshcal-cellnum{color:var(--dsw-alias-brand-primary)}',
      '.dshcal-holist{display:flex;flex-direction:column;gap:5px;margin-top:12px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}',
      '.dshcal-holist.is-upcoming{margin-top:auto}',
      '.dshcal-holisthead{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-bottom:1px}',
      '.dshcal-holine{display:flex;gap:8px;font-size:11px;align-items:baseline}',
      '.dshcal-hodate{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:0 0 auto;min-width:44px}',
      '.dshcal-honame{font-weight:500}',
      '.dshcal-hoscope{color:var(--dsw-alias-label-secondary);font-size:10px}',
      '.dshcal-addrow{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}',
      '.dshcal-input{appearance:none;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;box-sizing:border-box;min-width:0}',
      '.dshcal-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dshcal-input.is-time{width:96px;flex:0 0 auto}',
      '.dshcal-input.is-text{flex:1 1 120px}',
      '.dshcal-items{display:flex;flex-direction:column;gap:2px}',
      '.dshcal-item{display:flex;align-items:center;gap:9px;padding:7px 4px;border-bottom:1px dashed var(--dsw-alias-border-l1)}',
      '.dshcal-item:last-child{border-bottom:0}',
      '.dshcal-check{appearance:none;width:15px;height:15px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);cursor:pointer;flex:0 0 auto;position:relative;margin:0}',
      '.dshcal-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dshcal-check:checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 1.6px 1.6px 0;transform:rotate(42deg)}',
      '.dshcal-itemtime{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:0 0 auto;min-width:40px}',
      '.dshcal-itemtext{font-size:12px;flex:1 1 auto;word-break:break-word}',
      '.dshcal-item.is-done .dshcal-itemtext{text-decoration:line-through;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-del{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:6px;font-family:inherit}',
      '.dshcal-del:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dshcal-empty{font-size:11px;color:var(--dsw-alias-label-secondary);padding:14px 2px;text-align:center;flex:1 1 auto;display:flex;align-items:center;justify-content:center;min-height:60px}',
      '.dshcal-bars{display:flex;flex-direction:column;gap:9px}',
      '.dshcal-bar{display:grid;grid-template-columns:34px minmax(0,1fr) 34px;align-items:center;gap:9px}',
      '.dshcal-barname{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-bartrack{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dshcal-barfill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}',
      '.dshcal-barfill.is-lo{background:var(--dsw-alias-state-warn-primary)}',
      '.dshcal-barval{font-size:11px;font-variant-numeric:tabular-nums;text-align:right;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-reads{display:flex;flex-direction:column;gap:10px;margin-top:12px}',
      '.dshcal-read{display:flex;gap:9px;font-size:11.5px;line-height:1.55}',
      '.dshcal-readkey{flex:0 0 34px;font-weight:600;font-size:11px;color:var(--dsw-alias-label-primary)}',
      '.dshcal-readtext{color:var(--dsw-alias-label-secondary);flex:1 1 auto}',
      '.dshcal-chartline{display:flex;gap:6px;flex-wrap:wrap;align-items:baseline;font-size:11px;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);margin-bottom:12px}',
      '.dshcal-pillars{display:flex;gap:8px;font-weight:600;color:var(--dsw-alias-label-primary);font-size:12px}',
      '.dshcal-basis{font-size:10.5px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);margin-top:12px;padding-top:9px;line-height:1.6}',
      '.dshcal-total{display:flex;align-items:baseline;gap:8px;margin-bottom:12px}',
      '.dshcal-totalnum{font-size:26px;font-weight:650;line-height:1;font-variant-numeric:tabular-nums}',
      '.dshcal-totalcap{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-syncbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-syncbar.is-off{border-style:dashed}',
      '.dshcal-syncinput{flex:1 1 300px;min-width:180px}',
      '.dshcal-syncinput-sm{flex:0 0 auto;width:118px}',
      '.dshcal-syncstate{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:11px}',
      '.dshcal-syncstate b{font-weight:600}',
      '.dshcal-chips{display:flex;flex-direction:column;gap:2px;margin-top:2px;min-width:0;overflow:hidden}',
      '.dshcal-chip{font-size:9.5px;line-height:1.4;padding:1px 4px;border-radius:3px;border-left:2.5px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;color:var(--dsw-alias-label-primary)}',
      '.dshcal-chip.is-google{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent);border-left-color:var(--dsw-alias-state-success-primary)}',
      '.dshcal-chip.is-lark{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);border-left-color:var(--dsw-alias-brand-primary)}',
      '.dshcal-chip.is-span-start{border-radius:3px 0 0 3px}',
      '.dshcal-chip.is-span-mid{border-radius:0;border-left-width:0;padding-left:6px}',
      '.dshcal-chip.is-span-end{border-radius:0 3px 3px 0}',
      '.dshcal-chipmore{font-size:9px;color:var(--dsw-alias-label-secondary)}',
      '.dshcal-extlist{display:flex;flex-direction:column;gap:3px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px dashed var(--dsw-alias-border-l1)}',
      '.dshcal-ext{display:flex;align-items:baseline;gap:8px;font-size:12px}',
      '.dshcal-exttime{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:0 0 auto;min-width:72px}',
      '.dshcal-extname{flex:1 1 auto;word-break:break-word}',
      '.dshcal-extloc{font-size:10px;color:var(--dsw-alias-label-secondary);flex:0 1 auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshcal-extbadge{font-size:9px;padding:1px 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.dshcal-extrange{font-size:10px;color:var(--dsw-alias-label-secondary);flex:0 0 auto;font-variant-numeric:tabular-nums}',
      '.dshcal-page{overflow-x:hidden}',
      '.dshcal-page,.dshcal-grid,.dshcal-card,.dshcal-card>*{min-width:0}',
      '.dshcal-ext,.dshcal-extname,.dshcal-syncbar>*{min-width:0}',
      '@media (max-width:560px){',
      '  .dshcal-page>*{min-width:0}',
      '  .dshcal-card{overflow:hidden}',
      /* mobile shrink */
      '  .dshcal-page{padding:12px 10px 18px;gap:10px}',
      '  .dshcal-grid{gap:10px}',
      '  .dshcal-card{padding:12px}',
      '  .dshcal-bigday{font-size:34px}',
      '  .dshcal-lunarbig{font-size:14px}',
      '  .dshcal-cardtitle{font-size:11px}',
      '  .dshcal-cell{min-height:66px;padding:0 2px 5px}',
      '  .dshcal-cellhead{height:34px;padding-top:4px}',
      '  .dshcal-week{--dshcal-bar-top:34px}',
      '  .dshcal-bar{font-size:9px;height:12px;line-height:12px;margin:0 1px}',
      '  .dshcal-chip{font-size:9px;padding:1px 3px}',
      '  .dshcal-cellnum{font-size:12px;gap:2px}',
      '  .dshcal-celllunar{font-size:9px}',
      '  .dshcal-weekcell{font-size:10px}',
      '  .dshcal-ext{flex-wrap:wrap;gap:3px 6px}',
      '  .dshcal-extloc{max-width:100%}',
      '  .dshcal-syncinput-sm{width:96px}',
      '  .dshcal-rowval{max-width:60%}',
      '  .dshcal-table{font-size:11px}',
      '  .dshcal-addrow .dshcal-input.is-time{width:84px}',
      '}',
      '.dshcal-footer{font-size:10.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}',
    ].join('\n');

    /* =====================================================================
     * 10. 组件
     * =================================================================== */

    function CalendarIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      const stroke = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', {
          x: 3.2, y: 5, width: 17.6, height: 16, rx: 3.4,
          stroke: stroke, strokeWidth: 1.6,
        }),
        h('path', { d: 'M3.2 9.6h17.6', stroke: stroke, strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { d: 'M8 3.2v3.4M16 3.2v3.4', stroke: stroke, strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', {
          d: 'M15.4 12.4a3.1 3.1 0 1 0 0 6.2 3.9 3.9 0 0 1 0-6.2z',
          fill: stroke,
        }),
        h('circle', { cx: 8.2, cy: 13.4, r: 1.05, fill: stroke }),
        h('circle', { cx: 8.2, cy: 17.2, r: 1.05, fill: stroke, opacity: 0.6 })
      );
    }

    function KeyRow(props) {
      return h(
        'div',
        { className: 'dshcal-row' },
        h('span', { className: 'dshcal-rowkey' }, props.k),
        h('span', { className: 'dshcal-rowval' }, props.v)
      );
    }

    function AlmanacCard(props) {
      const lang = useLang();
      const t = STR[lang];
      const date = props.date;
      const lunar = lunarOf(date);
      const gz = ganzhiOfDay(date);
      const god = hasChart() ? tenGod(CHART.dayMasterStem, gz.stemIndex) : '';
      const rels = hasChart() ? relationsToChart(gz.branchIndex) : [];
      const holidays = holidaysOf(date);
      const festival = lunarFestival(date);
      const upcoming = holidaysAfter(date, 3);
      const clash = clashOf(gz.branchIndex);
      const zodiac = zodiacOfYear(lunar.yearName);

      const isToday = sameDay(date, props.today);
      const title = isToday ? t.todayAlmanac : t.pickedAlmanac;

      const tags = [];
      for (let i = 0; i < holidays.length; i += 1) {
        tags.push(h('span', { key: 'h' + i, className: 'dshcal-tag is-holiday' }, holidays[i].n));
      }
      if (festival) tags.push(h('span', { key: 'f', className: 'dshcal-tag is-festival' }, festival));

      return h(
        'section',
        { className: 'dshcal-card' },
        h(
          'div',
          { className: 'dshcal-cardhead' },
          h('div', { className: 'dshcal-cardtitle' }, title),
          h('div', { className: 'dshcal-cardsub' }, t.lunar)
        ),
        h(
          'div',
          { className: 'dshcal-hero' },
          h('div', { className: 'dshcal-bigday' }, String(date.getDate())),
          h(
            'div',
            { className: 'dshcal-herometa' },
            h('div', { className: 'dshcal-weekday' }, (lang === 'zh' ? WEEKDAY_ZH : WEEKDAY_EN)[date.getDay()]),
            h(
              'div',
              { className: 'dshcal-ymd' },
              date.getFullYear() + (lang === 'zh' ? '年' : '-') + (date.getMonth() + 1) + (lang === 'zh' ? '月' : '-') + date.getDate() + (lang === 'zh' ? '日' : '')
            )
          )
        ),
        h(
          'div',
          { className: 'dshcal-lunarline' },
          h(
            'span',
            { className: 'dshcal-lunarbig' },
            lunar.month ? (lunar.yearName ? lunar.yearName + '年 ' : '') + lunar.month + lunar.dayName : t.noLunar
          ),
          lunar.dayName
            ? h('span', { className: 'dshcal-lunarsub' }, zodiac ? zodiac + (lang === 'zh' ? '年' : ' year') : '')
            : null
        ),
        tags.length ? h('div', { className: 'dshcal-tagrow' }, tags) : null,
        h(
          'div',
          { className: 'dshcal-rows' },
          h(KeyRow, { key: 'gz', k: t.dayPillar, v: gz.text }),
          h(KeyRow, { key: 'god', k: t.dayGod, v: hasChart() ? god : '—' }),
          h(KeyRow, { key: 'el', k: t.dayEl, v: STEM_EL[gz.stemIndex] + ' / ' + BRANCH_EL[gz.branchIndex] }),
          h(KeyRow, {
            key: 'rel',
            k: t.withChart,
            v: !hasChart() ? '—' : (rels.length ? rels.map(function (r) { return r.text; }).join('、') : (lang === 'zh' ? '无刑冲合害' : 'no clash or combo')),
          }),
          h(KeyRow, {
            key: 'clash',
            k: t.clash,
            v: lang === 'zh'
              ? '冲' + clash.zodiac + '（' + clash.branch + '）· 煞' + clash.direction
              : 'clash ' + clash.branch + ' · sha ' + clash.direction,
          })
        ),
        upcoming.length
          ? h(
              'div',
              { className: 'dshcal-holist is-upcoming' },
              h('div', { className: 'dshcal-holisthead' }, t.upcoming),
              upcoming.map(function (x) {
                return h(
                  'div',
                  { key: x.key, className: 'dshcal-holine' },
                  h('span', { className: 'dshcal-hodate' }, (x.date.getMonth() + 1) + '/' + x.date.getDate()),
                  h('span', { className: 'dshcal-honame' }, x.name),
                  h('span', { className: 'dshcal-hoscope' }, x.days + ' ' + t.days)
                );
              })
            )
          : null
      );
    }

    /* ---- month grid: one bar per event per week, laid out in lanes ---- */
    const BAR_LANE = 15;

    /**
     * Lay out one week row.
     * All-day and multi-day events become bars (deduped by uid, so the 4 daily
     * copies of one event collapse into a single span); timed single-day events
     * stay inside their cell. Bars are packed into lanes so overlapping spans do
     * not collide.
     * @returns {{bars: Array, timed: Array<Array>, laneCount: number}}
     */
    function layoutWeek(weekCells, byDay) {
      const bars = [];
      const byId = {};
      const timed = [];
      for (let col = 0; col < weekCells.length; col += 1) {
        timed.push([]);
        const list = (byDay && byDay[dateKey(weekCells[col])]) || [];
        for (let i = 0; i < list.length; i += 1) {
          const ev = list[i];
          if (!ev.allDay && !(ev.spanCount > 1)) { timed[col].push(ev); continue; }
          const id = ev.uid || (ev.summary + '@' + ev.start);
          if (byId[id]) { byId[id].endCol = col; continue; }
          const record = { id: id, ev: ev, startCol: col, endCol: col, lane: 0 };
          byId[id] = record;
          bars.push(record);
        }
      }
      bars.sort(function (a, b) {
        return a.startCol - b.startCol || (b.endCol - b.endCol) - (a.endCol - a.startCol);
      });
      const lanes = [];
      for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i];
        for (let lane = 0; lane < 12; lane += 1) {
          if (!lanes[lane]) lanes[lane] = [];
          const clash = lanes[lane].some(function (other) {
            return !(bar.endCol < other.startCol || bar.startCol > other.endCol);
          });
          if (!clash) { lanes[lane].push(bar); bar.lane = lane; break; }
        }
      }
      return { bars: bars, timed: timed, laneCount: Math.min(lanes.length, 4) };
    }

    function MonthCard(props) {
      const lang = useLang();
      const t = STR[lang];
      const year = props.cursor.y;
      const month = props.cursor.m;
      const cells = useMemo(function () { return monthCells(year, month); }, [year, month]);

      const monthHolidays = useMemo(function () {
        const prefix = year + '-' + (month + 1 < 10 ? '0' + (month + 1) : String(month + 1));
        return HOLIDAY_KEYS.filter(function (k) { return k.indexOf(prefix) === 0; }).map(function (k) {
          const parts = k.split('-').map(Number);
          return { key: k, day: parts[2], name: HOLIDAYS[k][0].n, scope: HOLIDAYS[k][0].scope, federal: HOLIDAYS[k][0].federal };
        });
      }, [year, month]);

      const head = lang === 'zh' ? HEAD_ZH : HEAD_EN;

      const weeks = useMemo(function () {
        const out = [];
        for (let w = 0; w < 6; w += 1) {
          const slice = cells.slice(w * 7, w * 7 + 7);
          out.push({ cells: slice, layout: layoutWeek(slice, props.byDay) });
        }
        return out;
      }, [cells, props.byDay]);

      const renderCell = function (cell, col, lanes) {
        const lunar = lunarOf(cell);
        const festival = lunarFestival(cell);
        const holidays = holidaysOf(cell);
        const isToday = sameDay(cell, props.today);
        const isSelected = sameDay(cell, props.selected);
        const isOut = cell.getMonth() !== month;
        const dayEvents = (props.byDay && props.byDay[dateKey(cell)]) || [];
        const timed = dayEvents.filter(function (ev) { return !ev.allDay && !(ev.spanCount > 1); });

        const cls = ['dshcal-cell'];
        if (isOut) cls.push('is-out');
        if (isToday) cls.push('is-today');
        if (isSelected) cls.push('is-selected');
        if (holidays.length) cls.push('is-holiday');

        const tip = [];
        if (holidays.length) tip.push(holidays.map(function (x) { return x.n; }).join(' / '));
        if (festival) tip.push(festival);
        if (lunar.month) tip.push((lunar.isLeap ? '闰' : '') + lunar.monthClean + lunar.dayName);
        tip.push(ganzhiOfDay(cell).text);
        if (dayEvents.length) {
          tip.push(dayEvents.slice(0, 4).map(function (ev) {
            return eventTimeText(ev, lang) + ' ' + ev.summary;
          }).join(' / '));
        }

        return h(
          'button',
          {
            key: dateKey(cell) + '-' + col,
            type: 'button',
            className: cls.join(' '),
            title: tip.join(' · '),
            onClick: function () { props.onPick(cell); },
          },
          h('span', { className: 'dshcal-cellhead' },
            h('span', { className: 'dshcal-cellnum' },
              String(cell.getDate()),
              holidays.length ? h('span', { className: 'dshcal-dot' }) : null),
            h('span', { className: 'dshcal-celllunar' + (festival ? ' is-festival' : '') },
              festival || (lunar.dayNum === 1 ? lunar.monthClean : lunar.dayName))
          ),
          lanes ? h('span', { className: 'dshcal-cellspacer', style: { height: (lanes * BAR_LANE) + 'px' } }) : null,
          timed.length
            ? h('span', { className: 'dshcal-chips' },
                timed.slice(0, 2).map(function (ev, i) {
                  const label = clockOf(ev.start) + ' ' + ev.summary;
                  return h('span', {
                    key: 'e' + i,
                    className: 'dshcal-chip ' + (ev.source === 'lark' ? 'is-lark' : 'is-google'),
                    title: label,
                  }, label);
                }),
                timed.length > 2 ? h('span', { className: 'dshcal-chipmore' }, '+' + (timed.length - 2)) : null)
            : null
        );
      };

      return h(
        'section',
        { className: 'dshcal-card' },
        h(
          'div',
          { className: 'dshcal-monthhead' },
          h('div', { className: 'dshcal-monthname' }, year + (lang === 'zh' ? '年' : '-') + (month + 1) + (lang === 'zh' ? '月' : '')),
          h(
            'div',
            { className: 'dshcal-nav' },
            h('button', { type: 'button', className: 'dshcal-btn', title: t.prevMonth, onClick: props.onPrev }, '‹'),
            h('button', { type: 'button', className: 'dshcal-btn', onClick: props.onToday }, t.today),
            h('button', { type: 'button', className: 'dshcal-btn', title: t.nextMonth, onClick: props.onNext }, '›')
          )
        ),
        h('div', { className: 'dshcal-weekrow' },
          head.map(function (name, i) { return h('div', { key: 'w' + i, className: 'dshcal-weekcell' }, name); })
        ),
        h('div', { className: 'dshcal-weeks' },
          weeks.map(function (week, wi) {
            return h('div', { key: 'wk' + wi, className: 'dshcal-week' },
              h('div', { className: 'dshcal-weekcells' },
                week.cells.map(function (cell, ci) { return renderCell(cell, ci, week.layout.laneCount); })
              ),
              week.layout.bars.length
                ? h('div', { className: 'dshcal-barlayer' },
                    week.layout.bars.map(function (bar) {
                      const ev = bar.ev;
                      const label = (ev.allDay ? '' : clockOf(ev.start) + ' ') + ev.summary;
                      return h('span', {
                        key: bar.id,
                        className: 'dshcal-chip dshcal-bar ' + (ev.source === 'lark' ? 'is-lark' : 'is-google'),
                        title: label,
                        style: {
                          left: (bar.startCol * 100 / 7) + '%',
                          right: ((6 - bar.endCol) * 100 / 7) + '%',
                          top: 'calc(var(--dshcal-bar-top) + ' + (bar.lane * BAR_LANE) + 'px)',
                        },
                      }, label);
                    })
                  )
                : null
            );
          })
        ),
        h(
          'div',
          { className: 'dshcal-holist' },
          monthHolidays.length
            ? monthHolidays.map(function (x) {
                return h(
                  'div',
                  { key: x.key, className: 'dshcal-holine' },
                  h('span', { className: 'dshcal-hodate' }, String(x.day)),
                  h('span', { className: 'dshcal-honame' }, x.name),
                  h('span', { className: 'dshcal-hoscope' }, x.federal ? t.scopeFederal : t.scopeState + ' · ' + x.scope)
                );
              })
            : h('div', { className: 'dshcal-holine' }, h('span', { className: 'dshcal-hoscope' }, t.noMonthHoliday))
        )
      );
    }

    function ItineraryCard(props) {
      const lang = useLang();
      const t = STR[lang];
      const date = props.date;
      const key = dateKey(date);
      const items = props.items || [];
      const [time, setTime] = useState('');
      const [text, setText] = useState('');

      const submit = function () {
        const value = text.trim();
        if (!value) return;
        props.onAdd(key, time.trim(), value);
        setTime('');
        setText('');
      };

      const sorted = items.slice().sort(function (a, b) {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return (a.time || '99:99').localeCompare(b.time || '99:99');
      });

      return h(
        'section',
        { className: 'dshcal-card' },
        h(
          'div',
          { className: 'dshcal-cardhead' },
          h('div', { className: 'dshcal-cardtitle' }, t.itinerary),
          h(
            'div',
            { className: 'dshcal-cardsub' },
            (date.getMonth() + 1) + (lang === 'zh' ? '月' : '-') + date.getDate() + (lang === 'zh' ? '日 ' : ' ') + (lang === 'zh' ? WEEKDAY_ZH : WEEKDAY_EN)[date.getDay()]
          )
        ),
        props.external && props.external.length
          ? h(
              'div',
              { className: 'dshcal-extlist' },
              props.external.map(function (ev, i) {
                return h(
                  'div',
                  { key: 'x' + i, className: 'dshcal-ext', title: ev.location || ev.summary },
                  h('span', { className: 'dshcal-exttime' }, eventTimeText(ev, lang)),
                  h('span', { className: 'dshcal-extname' }, ev.summary),
                  eventRangeText(ev)
                    ? h('span', { className: 'dshcal-extrange' }, eventRangeText(ev))
                    : null,
                  ev.location ? h('span', { className: 'dshcal-extloc' }, ev.location) : null,
                  h('span', { className: 'dshcal-extbadge' }, ev.source === 'lark' ? t.larkCal : t.phoneCal)
                );
              })
            )
          : null,
        h(
          'div',
          { className: 'dshcal-addrow' },
          h('input', {
            type: 'time',
            className: 'dshcal-input is-time',
            value: time,
            'aria-label': t.addHint,
            onChange: function (e) { setTime(e.target.value); },
          }),
          h('input', {
            type: 'text',
            className: 'dshcal-input is-text',
            value: text,
            placeholder: t.addHint,
            'aria-label': t.addHint,
            onChange: function (e) { setText(e.target.value); },
            onKeyDown: function (e) {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            },
          }),
          h('button', { type: 'button', className: 'dshcal-btn', onClick: submit }, t.add)
        ),
        sorted.length
          ? h(
              'div',
              { className: 'dshcal-items' },
              sorted.map(function (item) {
                return h(
                  'div',
                  { key: item.id, className: 'dshcal-item' + (item.done ? ' is-done' : '') },
                  h('input', {
                    type: 'checkbox',
                    className: 'dshcal-check',
                    checked: !!item.done,
                    'aria-label': t.done,
                    onChange: function () { props.onToggle(key, item.id); },
                  }),
                  h('span', { className: 'dshcal-itemtime' }, item.time || '--:--'),
                  h('span', { className: 'dshcal-itemtext' }, item.text),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshcal-del',
                      title: t.remove,
                      'aria-label': t.remove,
                      onClick: function () { props.onRemove(key, item.id); },
                    },
                    '×'
                  )
                );
              })
            )
          : (props.external && props.external.length)
            ? null
            : h('div', { className: 'dshcal-empty' }, t.emptyPlan)
      );
    }

    function ChartSetup(props) {
      const t = props.t;
      const [text, setText] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      const save = function () {
        const err = applyChartText(text);
        if (err) { setError(err); return; }
        setBusy(true);
        setError(null);
        fetch(SYNC_ENDPOINT + '/profile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pillars: CHART.pillars.map(function (pair) { return pair[0] + pair[1]; }).join(' ') }),
        })
          .then(function () { setBusy(false); if (props.onSaved) props.onSaved(); })
          .catch(function (err2) { setBusy(false); setError(String(err2 && err2.message ? err2.message : err2)); });
      };

      return h(
        'section',
        { className: 'dshcal-card' },
        h('div', { className: 'dshcal-cardhead' },
          h('div', { className: 'dshcal-cardtitle' }, props.title),
          h('div', { className: 'dshcal-cardsub' }, t.chartUnset)
        ),
        h('div', { className: 'dshcal-addrow' },
          h('input', {
            type: 'text',
            className: 'dshcal-input is-text',
            value: text,
            placeholder: t.chartHint,
            'aria-label': t.chartHint,
            onChange: function (e) { setText(e.target.value); },
            onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } },
          }),
          h('button', { type: 'button', className: 'dshcal-btn', disabled: busy, onClick: save }, busy ? '…' : t.chartSave)
        ),
        h('div', { className: 'dshcal-cardsub' }, error || t.chartExample)
      );
    }

    function FortuneCard(props) {
      const lang = useLang();
      const t = STR[lang];
      const copy = COPY[lang];
      const date = props.date;
      const reading = useMemo(function () { return fortuneFor(date); }, [dateKey(date), props.chartRev]);
      const isToday = sameDay(date, props.today);

      if (!reading) {
        return h(ChartSetup, {
          t: t,
          title: isToday ? t.reading : t.pickedReading,
          onSaved: props.onChartSaved,
        });
      }

      const pillars = CHART.pillars.map(function (pair) { return pair[0] + pair[1]; }).join(' ');

      const bars = LANES.map(function (lane) {
        const score = reading.scores[lane.key];
        const band = bandOf(score);
        return h(
          'div',
          { key: lane.key, className: 'dshcal-bar' },
          h('span', { className: 'dshcal-barname' }, lane.zh),
          h(
            'span',
            { className: 'dshcal-bartrack' },
            h('span', {
              className: 'dshcal-barfill' + (score < 50 ? ' is-lo' : ''),
              style: { width: score + '%', display: 'block' },
            })
          ),
          h('span', { className: 'dshcal-barval' }, String(score))
        );
      });

      const reads = LANES.map(function (lane) {
        const score = reading.scores[lane.key];
        const band = bandOf(score);
        return h(
          'div',
          { key: lane.key, className: 'dshcal-read' },
          h('span', { className: 'dshcal-readkey' }, lane.zh),
          h('span', { className: 'dshcal-readtext' }, copy[lane.key][band])
        );
      });

      return h(
        'section',
        { className: 'dshcal-card' },
        h(
          'div',
          { className: 'dshcal-cardhead' },
          h('div', { className: 'dshcal-cardtitle' }, isToday ? t.reading : t.pickedReading),
          h('div', { className: 'dshcal-cardsub' }, (lang === 'zh' ? '日主 ' : 'day master ') + CHART.dayMaster + CHART.dayMasterElement)
        ),
        h(
          'div',
          { className: 'dshcal-chartline' },
          h('span', { className: 'dshcal-pillars' }, pillars),
          h('span', null, (lang === 'zh' ? '日主' : 'day master') + ' ' + CHART.dayMaster + CHART.dayMasterElement + ' · ' + CHART.strength + ' · ' + (lang === 'zh' ? '用神 ' + CHART.useful + ' · 喜 ' + CHART.favorable : 'useful ' + CHART.useful + ' · favor ' + CHART.favorable))
        ),
        h(
          'div',
          { className: 'dshcal-total' },
          h('span', { className: 'dshcal-totalnum' }, String(reading.total)),
          h('span', { className: 'dshcal-totalcap' }, t.total + ' · ' + reading.gz.text + ' · ' + reading.god)
        ),
        h('div', { className: 'dshcal-bars' }, bars),
        h('div', { className: 'dshcal-reads' }, reads),
        h(
          'div',
          { className: 'dshcal-basis' },
          t.basisLabel + '：' + (lang === 'zh'
            ? '日柱 ' + reading.gz.text + '（' + reading.god + '）· 天干' + reading.stemEl + ' · 地支' + reading.branchEl + ' · 与命局 ' + reading.relText
            : reading.gz.text + ' (' + reading.god + ') · stem ' + reading.stemEl + ' · branch ' + reading.branchEl + ' · chart ' + reading.relText)
        )
      );
    }

    function SyncNotice(props) {
      return h(
        'div',
        { className: 'dshcal-syncbar' },
        h('span', { className: 'dshcal-syncstate' },
          h('b', null, props.title),
          h('span', { className: 'dshcal-cardsub' }, props.text)
        )
      );
    }

    /** One source's paste/status row. Google: a URL. Lark: URL + user + pass. */
    function SourceBar(props) {
      const t = props.t;
      const src = props.src || {};
      const [draft, setDraft] = useState({ url: '', user: '', pass: '' });
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      if (src.configured === null || src.configured === undefined) return null;

      const failed = src.configured && !src.ok && src.error;
      const needsInput = src.configured === false || !!failed;

      const submit = function () {
        if (busy) return;
        const url = draft.url.trim();
        if (!url) return;
        if (props.kind === 'google' && /\/public\/basic\.ics/i.test(url)) {
          setError(t.phoneCalPublic);
          return;
        }
        if (props.kind === 'lark' && (!draft.user.trim() || !draft.pass)) {
          setError(t.larkHint);
          return;
        }
        setBusy(true);
        setError(null);
        props.onSave(props.kind, { url: url, user: draft.user.trim(), pass: draft.pass })
          .then(function () { setDraft({ url: '', user: '', pass: '' }); setBusy(false); })
          .catch(function (err) { setBusy(false); setError(String(err && err.message ? err.message : err)); });
      };

      const set = function (field) {
        return function (e) {
          const value = e.target.value;
          setDraft(function (prev) { const next = Object.assign({}, prev); next[field] = value; return next; });
        };
      };

      if (needsInput) {
        return h(
          'div',
          { className: 'dshcal-syncbar is-off' },
          h('span', { className: 'dshcal-syncstate' },
            h('b', null, props.title),
            h('span', { className: 'dshcal-cardsub' }, failed ? t.phoneCalError + '：' + src.error : props.offText)
          ),
          h('input', {
            type: 'text',
            className: 'dshcal-input dshcal-syncinput',
            value: draft.url,
            placeholder: props.placeholder,
            'aria-label': props.hint,
            onChange: set('url'),
            onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
          }),
          props.kind === 'lark'
            ? h('input', {
                type: 'text',
                className: 'dshcal-input dshcal-syncinput-sm',
                value: draft.user,
                placeholder: t.larkUser,
                'aria-label': t.larkUser,
                onChange: set('user'),
              })
            : null,
          props.kind === 'lark'
            ? h('input', {
                type: 'password',
                className: 'dshcal-input dshcal-syncinput-sm',
                value: draft.pass,
                placeholder: t.larkPass,
                'aria-label': t.larkPass,
                onChange: set('pass'),
                onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
              })
            : null,
          h('button', { type: 'button', className: 'dshcal-btn', disabled: busy, onClick: submit }, busy ? '…' : props.saveText),
          src.configured
            ? h('button', {
                type: 'button',
                className: 'dshcal-btn',
                onClick: function () { props.onDisconnect(props.kind).then(function () { setError(null); }); },
              }, t.phoneCalDisconnect)
            : null,
          h('span', { className: 'dshcal-cardsub', style: { flexBasis: '100%' } }, error || props.hint)
        );
      }

      const status = src.fetchedAt
        ? t.updated + ' ' + clockOf(src.fetchedAt) + ' · ' + (props.count || 0) + ' ' + t.phoneCalEvents
        : t.phoneCalOff;

      return h(
        'div',
        { className: 'dshcal-syncbar' },
        h('span', { className: 'dshcal-syncstate' },
          h('b', null, props.title),
          h('span', { className: 'dshcal-cardsub' }, status)
        ),
        h('button', { type: 'button', className: 'dshcal-btn', disabled: !!props.meta.loading, onClick: props.onRefresh },
          props.meta.loading ? '…' : t.phoneCalRefresh),
        h('button', {
          type: 'button',
          className: 'dshcal-btn',
          onClick: function () { props.onDisconnect(props.kind); },
        }, t.phoneCalDisconnect)
      );
    }

    function SyncBars(props) {
      const t = props.t;
      const meta = props.meta || {};
      if (meta.error === 'service-down') {
        return h(SyncNotice, { title: t.phoneCal, text: t.phoneCalDown });
      }
      const countOf = function (source) {
        let n = 0;
        for (let i = 0; i < props.events.length; i += 1) if (props.events[i].source === source) n += 1;
        return n;
      };
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(SourceBar, {
          key: 'google',
          kind: 'google',
          t: t,
          meta: meta,
          src: meta.sources && meta.sources.google,
          count: countOf('google'),
          title: t.phoneCal,
          offText: t.phoneCalOff,
          hint: t.phoneCalHint,
          saveText: t.phoneCalSave,
          placeholder: 'https://calendar.google.com/calendar/ical/…/private-…/basic.ics',
          onSave: props.onSave,
          onDisconnect: props.onDisconnect,
          onRefresh: props.onRefresh,
        }),
        h(SourceBar, {
          key: 'lark',
          kind: 'lark',
          t: t,
          meta: meta,
          src: meta.sources && meta.sources.lark,
          count: countOf('lark'),
          title: t.larkCal,
          offText: t.larkOff,
          hint: t.larkHint,
          saveText: t.larkSave,
          placeholder: 'https://caldav.larksuite.com',
          onSave: props.onSave,
          onDisconnect: props.onDisconnect,
          onRefresh: props.onRefresh,
        })
      );
    }

    function CalendarPage() {
      const lang = useLang();
      const t = STR[lang];
      const today = useMemo(function () { return startOfDay(new Date()); }, []);
      const [selected, setSelected] = useState(today);
      const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });
      const [store, setStore] = useState(loadStore);
      const [chartRev, setChartRev] = useState(0);

      useEffect(function () {
        fetch(SYNC_ENDPOINT + '/profile', { cache: 'no-store' })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data && data.ok && data.pillars) {
              applyChartText(data.pillars);
              setChartRev(function (n) { return n + 1; });
            }
          })
          .catch(function () { /* 面板照常工作，只是运程卡要求先设置命局 */ });
      }, []);

      useEffect(function () {
        saveStore(store);
      }, [store]);

      const pick = useCallback(function (date) {
        setSelected(date);
        setCursor({ y: date.getFullYear(), m: date.getMonth() });
      }, []);

      const goPrev = useCallback(function () {
        setCursor(function (c) {
          return c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 };
        });
      }, []);

      const goNext = useCallback(function () {
        setCursor(function (c) {
          return c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 };
        });
      }, []);

      const goToday = useCallback(function () {
        const now = startOfDay(new Date());
        setSelected(now);
        setCursor({ y: now.getFullYear(), m: now.getMonth() });
      }, []);

      const onAdd = useCallback(function (key, time, text) {
        setStore(function (prev) {
          const next = Object.assign({}, prev);
          const list = (next[key] || []).slice();
          list.push({ id: nextId(), time: time, text: text, done: false });
          next[key] = list;
          return next;
        });
      }, []);

      const onToggle = useCallback(function (key, id) {
        setStore(function (prev) {
          const next = Object.assign({}, prev);
          const list = (next[key] || []).map(function (item) {
            return item.id === id ? Object.assign({}, item, { done: !item.done }) : item;
          });
          next[key] = list;
          return next;
        });
      }, []);

      const onRemove = useCallback(function (key, id) {
        setStore(function (prev) {
          const next = Object.assign({}, prev);
          const list = (next[key] || []).filter(function (item) { return item.id !== id; });
          if (list.length) next[key] = list;
          else delete next[key];
          return next;
        });
      }, []);

      const items = store[dateKey(selected)] || [];

      const windowFrom = useMemo(function () { return new Date(cursor.y, cursor.m, 1 - 7).getTime(); }, [cursor]);
      const windowTo = useMemo(function () { return new Date(cursor.y, cursor.m + 1, 8).getTime(); }, [cursor]);
      const sync = useCalendarSync(windowFrom, windowTo);
      const external = sync.byDay[dateKey(selected)] || [];

      return h(
        'div',
        { className: 'dshcal-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dshcal-head' },
          h('div', { className: 'dshcal-title' }, t.panel),
          h(
            'div',
            { className: 'dshcal-nav' },
            h('button', { type: 'button', className: 'dshcal-btn', onClick: goToday }, t.backToday)
          )
        ),
        h(SyncBars, {
          key: 'sync',
          meta: sync.meta,
          events: sync.events,
          onSave: sync.saveUrl,
          onDisconnect: sync.disconnect,
          onRefresh: function () { sync.reload(true); },
          t: t,
          lang: lang,
        }),
        h(
          'div',
          { className: 'dshcal-grid' },
          h(AlmanacCard, { date: selected, today: today, key: 'almanac', chartRev: chartRev }),
          h(MonthCard, {
            key: 'month',
            cursor: cursor,
            today: today,
            selected: selected,
            byDay: sync.byDay,
            onPick: pick,
            onPrev: goPrev,
            onNext: goNext,
            onToday: goToday,
          })
        ),
        h(
          'div',
          { className: 'dshcal-grid' },
          h(ItineraryCard, {
            key: 'plan',
            date: selected,
            items: items,
            external: external,
            onAdd: onAdd,
            onToggle: onToggle,
            onRemove: onRemove,
          }),
          h(FortuneCard, {
            key: 'fortune',
            date: selected,
            today: today,
            chartRev: chartRev,
            onChartSaved: function () { setChartRev(function (n) { return n + 1; }); },
          })
        ),
        h('div', { className: 'dshcal-footer' }, t.footer)
      );
    }

    /* =====================================================================
     * 11. 注册
     * =================================================================== */

    return {
      inject: ['slots', 'layout', 'locale'],
      // Exposed for the workspace self-check only: it lets the probe exercise the
      // exact functions the panel renders with instead of a drifted copy.
      __test: {
        lunarOf: lunarOf,
        lunarFestival: lunarFestival,
        ganzhiOfDay: ganzhiOfDay,
        tenGod: tenGod,
        fortuneFor: fortuneFor,
        holidaysOf: holidaysOf,
        nextHolidayAfter: nextHolidayAfter,
        holidaysAfter: holidaysAfter,
        clashOf: clashOf,
        monthCells: monthCells,
        dateKey: dateKey,
        spreadEventDays: spreadEventDays,
        layoutWeek: layoutWeek,
        applyChartText: applyChartText,
        hasChart: hasChart,
        eventRangeText: eventRangeText,
        CHART: CHART,
        HOLIDAYS: HOLIDAYS,
        components: {
          CalendarPage: CalendarPage,
          CalendarIcon: CalendarIcon,
          AlmanacCard: AlmanacCard,
          MonthCard: MonthCard,
          ItineraryCard: ItineraryCard,
          FortuneCard: FortuneCard,
        },
      },
      apply(ctx) {
        ctx.effect(function () {
          try {
            localeFace = ctx.locale;
          } catch (err) {
            localeFace = null;
          }
          return function () {
            localeFace = null;
          };
        });

        const panelLabel = function () {
          let active = 'zh';
          try {
            const snapshot = ctx.locale.getLocale();
            active = snapshot && snapshot.active ? String(snapshot.active).toLowerCase() : 'zh';
          } catch (err) {
            active = 'zh';
          }
          return active.indexOf('zh') === 0 ? '万年历' : 'Almanac';
        };

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'calendar',
              order: 60,
              label: panelLabel,
            },
            CalendarIcon
          );
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'calendar' }, CalendarPage);
        });
      },
    };
  },
});
