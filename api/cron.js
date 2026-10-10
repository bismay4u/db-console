// api/cron.js
// A small cron expression parser: five fields  minute hour day-of-month month day-of-week
// Supports  *  a  a-b  a,b  */n  a-b/n  month and weekday names (JAN, MON), 7 = Sunday,
// and the shortcuts @hourly @daily @weekly @monthly @yearly.
// Times are the server's local time (set TZ to change it, e.g. in Docker).
// Like classic cron, when both day-of-month and day-of-week are restricted a day matches if either does.

const SHORTCUTS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function parseField(text, min, max, names, label) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Invalid ${label} "${part}"`);
    const num = (v) => {
      if (/^\d+$/.test(v)) return Number(v);
      const i = names ? names.indexOf(v.toUpperCase().slice(0, 3)) : -1;
      if (i === -1) throw new Error(`Invalid ${label} "${v}"`);
      return i + (label === 'month' ? 1 : 0);
    };
    let lo; let hi;
    if (m[1] === '*') { lo = min; hi = max; } else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(num); } else { lo = num(m[1]); hi = m[2] ? max : lo; }
    const step = m[2] ? Number(m[2]) : 1;
    if (!step) throw new Error(`Invalid step in ${label} "${part}"`);
    if (label === 'weekday') { if (lo === 7) lo = 0; if (hi === 7 && lo !== 0) hi = 6; if (hi === 7) hi = 0; }
    if (lo < min || hi > max || lo > hi) throw new Error(`${label} "${part}" is out of range (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function parse(expr) {
  let text = String(expr || '').trim().replace(/\s+/g, ' ');
  if (SHORTCUTS[text.toLowerCase()]) text = SHORTCUTS[text.toLowerCase()];
  const f = text.split(' ');
  if (f.length !== 5) throw new Error('A schedule needs five fields: minute hour day-of-month month day-of-week');
  const spec = {
    minute: parseField(f[0], 0, 59, null, 'minute'),
    hour: parseField(f[1], 0, 23, null, 'hour'),
    dom: parseField(f[2], 1, 31, null, 'day of month'),
    month: parseField(f[3], 1, 12, MONTHS, 'month'),
    dow: parseField(f[4], 0, 7, DAYS, 'weekday'),
    domAny: f[2].startsWith('*'), dowAny: f[4].startsWith('*')
  };
  spec.dow = new Set([...spec.dow].map((d) => d % 7));
  return spec;
}

function dayMatches(spec, d) {
  const dom = spec.dom.has(d.getDate());
  const dow = spec.dow.has(d.getDay());
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dow;
  if (spec.dowAny) return dom;
  return dom || dow;
}

// The first matching minute strictly after `from` (a Date); null if none within ~8 years.
function next(expr, from = new Date()) {
  const spec = typeof expr === 'string' ? parse(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 8 * 366 * 86400000;
  while (d.getTime() < limit) {
    if (!spec.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(spec, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!spec.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!spec.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d;
  }
  return null;
}

// Throws a readable error for a bad expression; returns the normalized text.
function validate(expr) {
  parse(expr);
  return String(expr).trim().replace(/\s+/g, ' ');
}

module.exports = { parse, next, validate };
