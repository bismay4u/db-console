// querylog.js
// Append-only, per-user log of everything run against a database (Query
// Runner, Explore edits, imports, restores, exports...) plus the analytics
// computed from it.
//
// Stored as JSON Lines in data/query_log.jsonl. When the file grows past
// MAX_BYTES it is rotated to query_log.1.jsonl (one previous file is kept),
// so the log never grows without bound.
//
// Safe with several PM2 cluster workers: each entry is a single append of
// one line, and rotation happens under the data-directory lock.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, FILE_MODE, ensureDir, withLock } = require('./datadir');

const LOG_FILE = path.join(DATA_DIR, 'query_log.jsonl');
const ROTATED_FILE = path.join(DATA_DIR, 'query_log.1.jsonl');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SQL_CHARS = 10000;

// Classifies a statement by its leading keyword (after comments).
function statementType(sql) {
  const stripped = String(sql || '').replace(/^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  const m = stripped.match(/^([a-z]+)/i);
  const kw = m ? m[1].toUpperCase() : '';
  if (['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(kw)) return kw;
  if (kw === 'WITH') return 'SELECT';
  if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(kw)) return 'DDL';
  if (['SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(kw)) return 'SHOW';
  return 'OTHER';
}

function logSize() {
  try {
    return fs.statSync(LOG_FILE).size;
  } catch (e) {
    return 0; // no log file yet
  }
}

function rotateIfNeeded() {
  if (logSize() <= MAX_BYTES) return;
  // Re-check under the lock: another worker may have just rotated it.
  withLock(() => {
    if (logSize() > MAX_BYTES) fs.renameSync(LOG_FILE, ROTATED_FILE);
  });
}

// entry: { username, source, connKey, connLabel, database, sql, type,
//          ok, error, durationMs, rowCount, affectedRows, statementCount }
function record(entry) {
  const sql = String(entry.sql || '');
  const line = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    username: entry.username,
    source: entry.source || 'runner',
    connKey: entry.connKey || null,
    connLabel: entry.connLabel || null,
    database: entry.database || null,
    sql: sql.length > MAX_SQL_CHARS ? sql.slice(0, MAX_SQL_CHARS) + ' …[truncated]' : sql,
    type: entry.type || statementType(sql),
    statementCount: entry.statementCount || 1,
    ok: entry.ok !== false,
    error: entry.error || null,
    durationMs: entry.durationMs ?? null,
    rowCount: entry.rowCount ?? null,
    affectedRows: entry.affectedRows ?? null
  };
  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: FILE_MODE });
  } catch (e) {
    // Logging must never break the request that triggered it.
    console.error('Failed to write query log:', e.message);
  }
  return line;
}

// All entries, oldest first.
function readAll() {
  const entries = [];
  for (const file of [ROTATED_FILE, LOG_FILE]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch (e) {
        // skip a partially written line
      }
    }
  }
  return entries;
}

function applyFilters(entries, f = {}) {
  const from = f.from ? new Date(f.from).getTime() : null;
  // A bare date for "to" means "through the end of that day".
  const to = f.to ? new Date(f.to).getTime() + (/^\d{4}-\d{2}-\d{2}$/.test(f.to) ? 86400000 : 0) : null;
  const q = f.q ? String(f.q).toLowerCase() : null;
  return entries.filter((e) => {
    if (f.username && e.username !== f.username) return false;
    if (f.connKey && e.connKey !== f.connKey) return false;
    if (f.source && e.source !== f.source) return false;
    if (f.type && e.type !== f.type) return false;
    if (f.status === 'ok' && !e.ok) return false;
    if (f.status === 'error' && e.ok) return false;
    const t = new Date(e.ts).getTime();
    if (from !== null && t < from) return false;
    if (to !== null && t >= to) return false;
    if (q && !(`${e.sql} ${e.error || ''} ${e.connLabel || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

// Every matching entry, oldest first.
function filtered(filters = {}) {
  return applyFilters(readAll(), filters);
}

// Newest first, paginated.
function query(filters = {}, { limit = 100, offset = 0 } = {}) {
  const matched = applyFilters(readAll(), filters).reverse();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  return { total: matched.length, entries: matched.slice(off, off + lim) };
}

function dayKey(iso) {
  return String(iso).slice(0, 10);
}

function analytics(filters = {}, days = 30) {
  const span = Math.min(Math.max(Number(days) || 30, 1), 365);
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (span - 1));

  const entries = applyFilters(readAll(), { ...filters, from: start.toISOString() });

  const byDayMap = new Map();
  for (let i = 0; i < span; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    byDayMap.set(dayKey(d.toISOString()), { date: dayKey(d.toISOString()), count: 0, errors: 0 });
  }

  const group = (keyFn, labelFn) => {
    const map = new Map();
    for (const e of entries) {
      const k = keyFn(e);
      if (!map.has(k)) map.set(k, { key: k, label: labelFn(e), count: 0, errors: 0, totalMs: 0, timed: 0, lastAt: null });
      const g = map.get(k);
      g.count++;
      if (!e.ok) g.errors++;
      if (typeof e.durationMs === 'number') { g.totalMs += e.durationMs; g.timed++; }
      if (!g.lastAt || e.ts > g.lastAt) g.lastAt = e.ts;
    }
    return [...map.values()]
      .map(({ totalMs, timed, ...g }) => ({ ...g, avgMs: timed ? Math.round(totalMs / timed) : null }))
      .sort((a, b) => b.count - a.count);
  };

  let errors = 0;
  let totalMs = 0;
  let timed = 0;
  for (const e of entries) {
    if (!e.ok) errors++;
    if (typeof e.durationMs === 'number') { totalMs += e.durationMs; timed++; }
    const day = byDayMap.get(dayKey(e.ts));
    if (day) {
      day.count++;
      if (!e.ok) day.errors++;
    }
  }

  const slowest = entries
    .filter((e) => typeof e.durationMs === 'number')
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10);

  return {
    days: span,
    from: start.toISOString(),
    total: entries.length,
    errors,
    errorRate: entries.length ? errors / entries.length : 0,
    avgMs: timed ? Math.round(totalMs / timed) : null,
    activeUsers: new Set(entries.map((e) => e.username)).size,
    byDay: [...byDayMap.values()],
    byUser: group((e) => e.username, (e) => e.username),
    byConnection: group((e) => e.connKey || '—', (e) => e.connLabel || e.connKey || '—'),
    byType: group((e) => e.type, (e) => e.type),
    bySource: group((e) => e.source, (e) => e.source),
    slowest
  };
}

module.exports = { record, query, filtered, analytics, statementType };
