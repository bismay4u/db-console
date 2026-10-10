// api/approvals.js
// A second pair of eyes for dangerous statements. On a connection with "require approval" switched on, a user who
// is not its owner (or an admin) cannot run DROP, TRUNCATE, or an UPDATE / DELETE without a WHERE from the Query
// Runner directly: the statement becomes a request that the owner or an admin approves (it then runs with the
// requester's own permissions) or rejects. Nobody approves their own request.

const crypto = require('crypto');
const path = require('path');
const { DATA_DIR, readJson, writeJson, withLock } = require('./datadir');

const FILE = path.join(DATA_DIR, 'approvals.json');
const EXPIRES_MS = 7 * 24 * 3600 * 1000;
const KEEP_DONE = 500;

// Statement text with comments cut out and the insides of strings blanked, so a keyword inside a string doesn't count.
function statements(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--[ \t][^\n]*|#[^\n]*)/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[0])
    .split(';').map((t) => t.trim()).filter(Boolean);
}

// Why this SQL needs approval (empty = it doesn't).
function classify(sql) {
  const reasons = [];
  for (const t of statements(sql)) {
    const head = t.replace(/^\(+/, '');
    if (/^drop\b/i.test(head)) reasons.push(`${head.split(/\s+/).slice(0, 3).join(' ').toUpperCase()}`);
    else if (/^truncate\b/i.test(head)) reasons.push(`TRUNCATE ${(head.split(/\s+/)[2] || head.split(/\s+/)[1] || '').replace(/`/g, '')}`.trim());
    else if (/^(update|delete)\b/i.test(head) && !/\bwhere\b/i.test(head)) reasons.push(`${head.split(/\s+/)[0].toUpperCase()} without WHERE`);
  }
  return [...new Set(reasons)];
}

function load() {
  const all = readJson(FILE);
  const now = Date.now();
  return all.map((a) => (a.status === 'pending' && now - Date.parse(a.createdAt) > EXPIRES_MS ? { ...a, status: 'expired' } : a));
}
const get = (id) => load().find((a) => a.id === id) || null;

function create({ requester, connKey, connLabel, database, sql, reasons }) {
  return withLock(() => {
    const all = readJson(FILE);
    const dup = all.find((a) => a.status === 'pending' && a.requester === requester && a.connKey === connKey && a.database === database && a.sql === sql);
    if (dup) return dup; // pressing Run twice doesn't ask twice
    const a = { id: crypto.randomBytes(6).toString('hex'), requester, connKey, connLabel, database, sql, reasons, status: 'pending', createdAt: new Date().toISOString() };
    all.push(a);
    const done = all.filter((x) => x.status !== 'pending');
    writeJson(FILE, done.length > KEEP_DONE ? all.filter((x) => x.status === 'pending' || done.slice(-KEEP_DONE).includes(x)) : all);
    return a;
  });
}

function update(id, fields) {
  return withLock(() => {
    const all = readJson(FILE);
    const i = all.findIndex((a) => a.id === id);
    if (i === -1) return null;
    all[i] = { ...all[i], ...fields };
    writeJson(FILE, all);
    return all[i];
  });
}

module.exports = { classify, load, get, create, update, statements };
