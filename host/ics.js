/**
 * iCalendar reader for the almanac's phone-calendar sync.
 *
 * Deliberately dependency-free: it reads what Google's "secret address in iCal
 * format" emits, which is a plain VCALENDAR feed. Everything here is a pure
 * function so check.mjs can feed it fixed feeds and assert the expansion.
 *
 * Scope, stated plainly:
 *   - one-off events, all-day events, UTC and TZID wall times
 *   - RRULE DAILY / WEEKLY (with BYDAY) / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL
 *   - EXDATE exclusions and RECURRENCE-ID overrides (the override wins on its day)
 *   - STATUS:CANCELLED events are dropped
 *   - not read: RDATE, BYSETPOS, BYMONTHDAY beyond the base day, VALARM
 * Monthly and yearly occurrences are added in wall-clock space, so a zone with
 * DST keeps the wall clock and may shift the UTC instant by an hour. Malaysia
 * has no DST, so this never shows up here.
 */

const MAX_OCCURRENCES = 600;

/** Unfold RFC 5545 line continuations (CRLF + a single space or tab). */
export function unfold(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const raw = normalized.split('\n');
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function splitProperty(line) {
  const at = line.indexOf(':');
  if (at < 0) return null;
  const head = line.slice(0, at);
  const value = line.slice(at + 1);
  const segments = head.split(';');
  const name = segments[0].toUpperCase();
  const params = {};
  for (let i = 1; i < segments.length; i += 1) {
    const eq = segments[i].indexOf('=');
    if (eq < 0) continue;
    const key = segments[i].slice(0, eq).toUpperCase();
    let val = segments[i].slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value };
}

function unescapeText(value) {
  return String(value)
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function tzOffsetMs(zone, epoch) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const bag = {};
  for (const part of dtf.formatToParts(new Date(epoch))) bag[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(bag.year), Number(bag.month) - 1, Number(bag.day),
    Number(bag.hour) % 24, Number(bag.minute), Number(bag.second)
  );
  return asUtc - epoch;
}

/** A wall-clock time in `zone` → epoch ms (two passes settle DST boundaries). */
export function wallToEpoch(y, mo, d, h, mi, s, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = tzOffsetMs(zone, guess);
  let ts = guess - offset;
  offset = tzOffsetMs(zone, ts);
  ts = guess - offset;
  return ts;
}

/** The wall-clock parts of an epoch in `zone`. */
export function epochToWall(epoch, zone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const bag = {};
  for (const part of dtf.formatToParts(new Date(epoch))) bag[part.type] = part.value;
  return {
    y: Number(bag.year), mo: Number(bag.month), d: Number(bag.day),
    h: Number(bag.hour) % 24, mi: Number(bag.minute), s: Number(bag.second),
  };
}

function parseDateValue(value, params, feedZone) {
  const v = String(value).trim();
  const dateOnly = params.VALUE === 'DATE' || /^\d{8}$/.test(v);
  if (dateOnly) {
    const y = Number(v.slice(0, 4));
    const mo = Number(v.slice(4, 6));
    const d = Number(v.slice(6, 8));
    return { ms: wallToEpoch(y, mo, d, 0, 0, 0, feedZone), allDay: true };
  }
  const utc = /Z$/.test(v);
  const body = utc ? v.slice(0, -1) : v;
  const y = Number(body.slice(0, 4));
  const mo = Number(body.slice(4, 6));
  const d = Number(body.slice(6, 8));
  const h = Number(body.slice(9, 11) || 0);
  const mi = Number(body.slice(11, 13) || 0);
  const s = Number(body.slice(13, 15) || 0);
  if (utc) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  const zone = params.TZID || feedZone;
  return { ms: wallToEpoch(y, mo, d, h, mi, s, zone), allDay: false, zone };
}

function parseRrule(value) {
  const out = {};
  for (const chunk of String(value).split(';')) {
    const eq = chunk.indexOf('=');
    if (eq < 0) continue;
    out[chunk.slice(0, eq).toUpperCase()] = chunk.slice(eq + 1);
  }
  const rule = { freq: (out.FREQ || '').toUpperCase() };
  if (out.INTERVAL) rule.interval = Math.max(1, Number(out.INTERVAL) || 1);
  if (out.COUNT) rule.count = Number(out.COUNT) || 0;
  if (out.UNTIL) {
    const parsed = parseDateValue(out.UNTIL, {}, 'UTC');
    rule.until = parsed.ms;
  }
  if (out.BYDAY) {
    rule.byDay = out.BYDAY.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  }
  return rule;
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Parse a feed into raw event records (no expansion). */
export function parseIcs(text, feedZone = 'Asia/Kuala_Lumpur') {
  const lines = unfold(text);
  const events = [];
  let current = null;
  let depth = 0;

  for (const line of lines) {
    const prop = splitProperty(line);
    if (!prop) continue;

    if (prop.name === 'BEGIN' && prop.value.toUpperCase() === 'VEVENT') {
      current = { exdates: [], cancelled: false };
      depth += 1;
      continue;
    }
    if (prop.name === 'END' && prop.value.toUpperCase() === 'VEVENT') {
      if (current && current.dtstart) events.push(current);
      current = null;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (!current) continue;

    switch (prop.name) {
      case 'UID': current.uid = prop.value.trim(); break;
      case 'SUMMARY': current.summary = unescapeText(prop.value); break;
      case 'LOCATION': current.location = unescapeText(prop.value); break;
      case 'STATUS': current.cancelled = prop.value.toUpperCase() === 'CANCELLED'; break;
      case 'DTSTART': {
        const parsed = parseDateValue(prop.value, prop.params, feedZone);
        current.dtstart = parsed.ms;
        current.allDay = parsed.allDay;
        current.zone = parsed.zone || feedZone;
        break;
      }
      case 'DTEND': {
        const parsed = parseDateValue(prop.value, prop.params, feedZone);
        current.dtend = parsed.ms;
        break;
      }
      case 'RRULE': current.rrule = parseRrule(prop.value); break;
      case 'EXDATE': {
        for (const piece of String(prop.value).split(',')) {
          if (!piece.trim()) continue;
          current.exdates.push(parseDateValue(piece.trim(), prop.params, feedZone).ms);
        }
        break;
      }
      case 'RECURRENCE-ID': {
        current.recurrenceId = parseDateValue(prop.value, prop.params, feedZone).ms;
        break;
      }
      default: break;
    }
  }

  return events.filter((e) => !e.cancelled);
}

/** The month step taken from a FIXED base wall day: 1/31 -> 2/28 -> 3/31, not 3/28. */
function monthStep(baseWall, months, zone) {
  const total = (baseWall.y * 12 + (baseWall.mo - 1)) + months;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const d = Math.min(baseWall.d, lastDay);
  return wallToEpoch(y, mo, d, baseWall.h, baseWall.mi, baseWall.s, zone);
}

function addDaysWall(ms, days, zone) {
  const wall = epochToWall(ms, zone);
  const shifted = Date.UTC(wall.y, wall.mo - 1, wall.d + days);
  const dt = new Date(shifted);
  return wallToEpoch(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), wall.h, wall.mi, wall.s, zone);
}

/** Every start instant this event produces inside [from, to]. */
export function occurrencesOf(event, from, to) {
  const starts = [];
  const zone = event.zone || 'Asia/Kuala_Lumpur';
  const duration = event.dtend != null && event.dtend > event.dtstart ? event.dtend - event.dtstart : (event.allDay ? 86400000 : 0);

  const push = (start) => {
    if (start == null) return;
    if (start > to) return;
    if (event.exdates.indexOf(start) >= 0) return;
    if (start < from - duration) return;
    starts.push(start);
  };

  const rule = event.rrule;
  if (!rule || !rule.freq) {
    push(event.dtstart);
  } else {
    const interval = rule.interval || 1;
    const baseWall = epochToWall(event.dtstart, zone);
    let step = 0;
    const limit = rule.count || MAX_OCCURRENCES;
    let produced = 0;
    let cursor = event.dtstart;
    let guard = 0;

    while (cursor != null && guard < MAX_OCCURRENCES) {
      guard += 1;
      if (rule.until != null && cursor > rule.until) break;
      if (cursor > to) break;

      if (rule.freq === 'WEEKLY' && rule.byDay && rule.byDay.length) {
        // Expand the week this cursor sits in, then jump a whole interval.
        const wall = epochToWall(cursor, zone);
        const weekStart = addDaysWall(cursor, -((new Date(Date.UTC(wall.y, wall.mo - 1, wall.d)).getUTCDay())), zone);
        for (const code of rule.byDay) {
          const idx = DAY_CODES.indexOf(code.replace(/^[+-]?\d+/, ''));
          if (idx < 0) continue;
          const candidate = addDaysWall(weekStart, idx, zone);
          if (candidate < event.dtstart) continue;
          if (rule.until != null && candidate > rule.until) continue;
          if (produced >= limit) break;
          push(candidate);
          produced += 1;
        }
        cursor = addDaysWall(cursor, 7 * interval, zone);
      } else {
        if (produced >= limit) break;
        push(cursor);
        produced += 1;
        step += 1;
        if (rule.freq === 'DAILY') cursor = addDaysWall(cursor, interval, zone);
        else if (rule.freq === 'WEEKLY') cursor = addDaysWall(cursor, 7 * interval, zone);
        else if (rule.freq === 'MONTHLY') cursor = monthStep(baseWall, step * interval, zone);
        else if (rule.freq === 'YEARLY') cursor = monthStep(baseWall, step * 12 * interval, zone);
        else break;
      }
    }
  }

  return starts.map((start) => ({
    uid: event.uid || '',
    summary: event.summary || '(无标题)',
    location: event.location || '',
    start,
    end: start + duration,
    allDay: !!event.allDay,
    zone,
    recurring: !!rule,
  }));
}

/**
 * Expand a whole feed into occurrences inside [from, to), sorted by start.
 * An override (RECURRENCE-ID) replaces the occurrence it names.
 */
export function expandFeed(text, from, to, feedZone = 'Asia/Kuala_Lumpur') {
  const events = parseIcs(text, feedZone);
  const overrides = new Map();
  const masters = [];

  for (const event of events) {
    if (event.recurrenceId != null) {
      overrides.set(String(event.uid || '') + '|' + event.recurrenceId, event);
    } else {
      masters.push(event);
    }
  }

  const out = [];
  for (const event of masters) {
    for (const occurrence of occurrencesOf(event, from, to)) {
      // A RECURRENCE-ID override replaces its slot; that slot is normally also an
      // EXDATE, so the override is added by the second pass below, not here.
      if (!overrides.has(String(event.uid || '') + '|' + occurrence.start)) out.push(occurrence);
    }
  }

  // Overrides whose master sits outside the window still deserve to show.
  for (const [start, override] of overrides) {
    if (start < from || start > to) continue;
    if (out.some((o) => o.start === start)) continue;
    out.push({
      uid: override.uid || '',
      summary: override.summary || '(无标题)',
      location: override.location || '',
      start: override.dtstart,
      end: override.dtend != null ? override.dtend : override.dtstart,
      allDay: !!override.allDay,
      zone: override.zone || feedZone,
      recurring: true,
    });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}
