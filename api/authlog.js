// api/authlog.js
// Sign-in activity: who signed in or failed to, from where. JSON Lines in
// data/auth_log.jsonl (rotated at 5 MB, one previous file kept). Admins read it
// under Users → Sign-in activity; it feeds the failed-login report.

const fs = require('fs');
const path = require('path');
const { DATA_DIR, FILE_MODE, ensureDir, withLock } = require('./datadir');

const LOG_FILE = path.join(DATA_DIR, 'auth_log.jsonl');
const ROTATED_FILE = path.join(DATA_DIR, 'auth_log.1.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;

// event: login_ok | login_failed | login_locked | logout | password_changed | ip_blocked
function record(entry) {
  const line = {
    ts: new Date().toISOString(),
    event: entry.event,
    username: entry.username ? String(entry.username).slice(0, 64) : null,
    ip: entry.ip || null,
    detail: entry.detail ? String(entry.detail).slice(0, 200) : null,
    agent: entry.agent ? String(entry.agent).slice(0, 120) : null
  };
  try {
    ensureDir();
    try {
      if (fs.statSync(LOG_FILE).size > MAX_BYTES) withLock(() => { if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, ROTATED_FILE); });
    } catch (e) { /* no file yet */ }
    fs.appendFileSync(LOG_FILE, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: FILE_MODE });
  } catch (e) {
    console.error('Failed to write sign-in log:', e.message);
  }
}

function readAll() {
  const out = [];
  for (const f of [ROTATED_FILE, LOG_FILE]) {
    if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch (e) { /* partial line */ }
    }
  }
  return out;
}

function filter(entries, f = {}) {
  const from = f.from ? new Date(f.from).getTime() : null;
  const to = f.to ? new Date(f.to).getTime() + (/^\d{4}-\d{2}-\d{2}$/.test(f.to) ? 86400000 : 0) : null;
  const q = f.q ? String(f.q).toLowerCase() : null;
  return entries.filter((e) => {
    if (f.event && e.event !== f.event) return false;
    if (f.username && e.username !== f.username) return false;
    if (f.ip && e.ip !== f.ip) return false;
    const t = new Date(e.ts).getTime();
    if (from !== null && t < from) return false;
    if (to !== null && t >= to) return false;
    if (q && !`${e.username || ''} ${e.ip || ''} ${e.detail || ''} ${e.agent || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function query(filters = {}, { limit = 100, offset = 0 } = {}) {
  const matched = filter(readAll(), filters).reverse();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  return { total: matched.length, entries: matched.slice(off, off + lim) };
}

// The failed-login report: counts over the last `hours`, and the busiest sources.
function summary(hours = 24) {
  const since = Date.now() - Math.max(1, Number(hours) || 24) * 3600 * 1000;
  const recent = readAll().filter((e) => new Date(e.ts).getTime() >= since);
  const count = (ev) => recent.filter((e) => e.event === ev).length;
  const top = (ev, key) => {
    const m = new Map();
    for (const e of recent) if (e.event === ev && e[key]) m.set(e[key], (m.get(e[key]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, count: n }));
  };
  return {
    hours: Number(hours) || 24,
    successful: count('login_ok'), failed: count('login_failed'), locked: count('login_locked'), blocked: count('ip_blocked'),
    topFailedIps: top('login_failed', 'ip'), topFailedUsers: top('login_failed', 'username'), topBlockedIps: top('ip_blocked', 'ip')
  };
}

module.exports = { record, query, summary, readAll, filter };
