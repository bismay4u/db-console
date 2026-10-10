// api/notes.js
// Short text notes. Two kinds:
//   table — about one table (or view) of a connection. Written for yourself (private) or shared with everyone who can
//           open that connection.
//   query — about a saved query. Visible to everyone who can see the query, and anyone who can see it may add one.
// The store only holds and filters notes; who may see what is decided by the callers (server.js).

const crypto = require('crypto');
const path = require('path');
const { DATA_DIR, readJson, writeJson, withLock } = require('./datadir');

const FILE = path.join(DATA_DIR, 'notes.json');
const MAX_TEXT = 4000;

const all = () => readJson(FILE);

function cleanText(text) {
  const t = String(text === undefined || text === null ? '' : text).replace(/\r\n/g, '\n').trim();
  if (!t) throw new Error('Write something first');
  if (t.length > MAX_TEXT) throw new Error(`A note can be up to ${MAX_TEXT} characters`);
  return t;
}

function get(id) { return all().find((n) => n.id === id) || null; }

function create(note) {
  const n = {
    id: crypto.randomBytes(8).toString('hex'),
    kind: note.kind,
    connKey: note.connKey || null, database: note.database || null, table: note.table || null,
    queryId: note.queryId || null,
    text: cleanText(note.text),
    shared: note.kind === 'table' ? Boolean(note.shared) : true,
    owner: note.owner,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  withLock(() => { const list = all(); list.push(n); writeJson(FILE, list); });
  return n;
}

function update(id, { text, shared }) {
  return withLock(() => {
    const list = all();
    const i = list.findIndex((n) => n.id === id);
    if (i === -1) return null;
    const next = { ...list[i] };
    if (text !== undefined) next.text = cleanText(text);
    if (shared !== undefined && next.kind === 'table') next.shared = Boolean(shared);
    next.updatedAt = new Date().toISOString();
    list[i] = next;
    writeJson(FILE, list);
    return next;
  });
}

function remove(id) {
  return withLock(() => {
    const list = all();
    const next = list.filter((n) => n.id !== id);
    if (next.length === list.length) return false;
    writeJson(FILE, next);
    return true;
  });
}

// Notes that go with something that was deleted.
function removeFor({ connKey, queryId }) {
  withLock(() => {
    const list = all();
    const next = list.filter((n) => !((connKey && n.connKey === connKey) || (queryId && n.queryId === queryId)));
    if (next.length !== list.length) writeJson(FILE, next);
  });
}

// Table notes on one table that `username` may read: their own plus the shared ones.
function forTable(connKey, database, table, username) {
  return all().filter((n) => n.kind === 'table' && n.connKey === connKey && n.database === database && n.table === table && (n.owner === username || n.shared))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

// How many notes each table of a database has, for the table list.
function tableCounts(connKey, database, username) {
  const counts = {};
  for (const n of all()) if (n.kind === 'table' && n.connKey === connKey && n.database === database && (n.owner === username || n.shared)) counts[n.table] = (counts[n.table] || 0) + 1;
  return counts;
}

function forQuery(queryId) {
  return all().filter((n) => n.kind === 'query' && n.queryId === queryId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function queryCounts() {
  const counts = {};
  for (const n of all()) if (n.kind === 'query') counts[n.queryId] = (counts[n.queryId] || 0) + 1;
  return counts;
}

module.exports = { MAX_TEXT, get, create, update, remove, removeFor, forTable, tableCounts, forQuery, queryCounts };
