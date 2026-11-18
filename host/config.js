/**
 * The calendar feed URL lives in the secrets directory, not in the plugin.
 *
 * A Google "secret address in iCal format" is a bearer credential: anyone who
 * holds it can read every event on that calendar. It is never returned to the
 * browser, never logged, and the file is written owner-only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// An env override keeps the self-check off the real secrets file.
export const SECRET_FILE = process.env.DSH_CALENDAR_ICS_FILE || path.join(os.homedir(), '.dsh', 'secrets', 'calendar-ics.env');

export function readIcsUrl() {
  try {
    const text = fs.readFileSync(SECRET_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      if (trimmed.slice(0, eq).trim() === 'CALENDAR_ICS_URL') {
        return trimmed.slice(eq + 1).trim();
      }
    }
  } catch (err) {
    /* not configured yet */
  }
  return '';
}

/** Accept the forms Google shows, and nothing that is not an http(s) feed. */
export function normalizeIcsUrl(input) {
  let url = String(input || '').trim();
  if (!url) return { ok: false, error: 'empty' };
  if (/^webcal:\/\//i.test(url)) url = url.replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\//i.test(url)) return { ok: false, error: '只接受 https 地址（Google 私密 iCal 地址以 https 开头）' };
  if (!/\.ics($|\?)/i.test(url) && url.indexOf('/ical/') < 0) return { ok: false, error: '这不像 iCal 地址（应以 .ics 结尾）' };
  return { ok: true, url };
}

export function writeIcsUrl(url) {
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  const body = [
    '# 万年历的日历订阅地址。私密 iCal 地址等同密码：拿到它就能读这个日历的全部行程。',
    '# 删除这个文件或在面板里点「断开」即可解除同步。',
    'CALENDAR_ICS_URL=' + url,
    '',
  ].join('\n');
  fs.writeFileSync(SECRET_FILE, body, { mode: 0o600 });
  return SECRET_FILE;
}

export function clearIcsUrl() {
  try {
    fs.rmSync(SECRET_FILE, { force: true });
    return true;
  } catch (err) {
    return false;
  }
}

export function isConfigured() {
  return readIcsUrl().length > 0;
}

/* ------------------------------ Lark / CalDAV ------------------------------ */

export const CALDAV_FILE = process.env.DSH_CALENDAR_CALDAV_FILE || path.join(os.homedir(), '.dsh', 'secrets', 'calendar-caldav.env');

function parseEnvFile(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
  } catch (err) {
    return {};
  }
  return out;
}

/** @returns {{url: string, user: string, pass: string}|null} */
export function readCaldav() {
  const bag = parseEnvFile(CALDAV_FILE);
  const url = bag.CALDAV_URL || '';
  const user = bag.CALDAV_USER || '';
  const pass = bag.CALDAV_PASS || '';
  if (!url || !user || !pass) return null;
  return { url, user, pass };
}

export function writeCaldav(input) {
  fs.mkdirSync(path.dirname(CALDAV_FILE), { recursive: true });
  const body = [
    '# 飞书/Lark 日历的 CalDAV 凭据。客户端 → 设置 → 日历 → CalDAV 同步 里生成。',
    '# 这个文件等同密码，不要外传；删掉它或面板里点「断开」即解除同步。',
    'CALDAV_URL=' + String(input.url || '').trim(),
    'CALDAV_USER=' + String(input.user || '').trim(),
    'CALDAV_PASS=' + String(input.pass || ''),
    '',
  ].join('\n');
  fs.writeFileSync(CALDAV_FILE, body, { mode: 0o600 });
  return CALDAV_FILE;
}

export function clearCaldav() {
  try {
    fs.rmSync(CALDAV_FILE, { force: true });
    return true;
  } catch (err) {
    return false;
  }
}

/* --------------------------------- å‘½å±€ --------------------------------- */

export const PROFILE_FILE = process.env.DSH_CALENDAR_PROFILE_FILE || path.join(os.homedir(), '.dsh', 'secrets', 'calendar-profile.json');

/** @returns {{pillars: string}|null} */
export function readProfile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    if (!parsed || typeof parsed.pillars !== 'string') return null;
    return { pillars: parsed.pillars };
  } catch (err) {
    return null;
  }
}

export function writeProfile(pillars) {
  fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
  const body = JSON.stringify({ pillars: String(pillars || '').trim(), updatedAt: new Date().toISOString() }, null, 2) + '\n';
  fs.writeFileSync(PROFILE_FILE, body, { mode: 0o600 });
  return PROFILE_FILE;
}
