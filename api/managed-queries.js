// api/managed-queries.js
// Managed queries: ready-made queries that come with the app (api/managed/*.js) plus the ones an administrator
// adds, offered to everybody. Nobody edits a built-in; an administrator can hide it. Users copy a managed query into
// their own saved queries when they want to change it.

const crypto = require('crypto');
const path = require('path');
const { DATA_DIR, readJson, writeJson, withLock } = require('./datadir');

const ENGINES = ['mysql', 'postgres', 'sqlite'];
const CUSTOM_FILE = path.join(DATA_DIR, 'managed-queries.json');
const HIDDEN_FILE = path.join(DATA_DIR, 'managed-hidden.json');

const BUILTIN = [
  ...require('./managed/mysql').map((q) => ({ ...q, engine: 'mysql' })),
  ...require('./managed/postgres').map((q) => ({ ...q, engine: 'postgres' })),
  ...require('./managed/sqlite').map((q) => ({ ...q, engine: 'sqlite' }))
].map((q) => ({ ...q, builtin: true, template: Boolean(q.template) }));

const hiddenIds = () => new Set(readJson(HIDDEN_FILE));
const customList = () => readJson(CUSTOM_FILE);

function view(q, hidden) {
  return {
    id: q.id, engine: q.engine, category: q.category, title: q.title, description: q.description || '', sql: q.sql,
    template: Boolean(q.template), builtin: Boolean(q.builtin), hidden: hidden.has(q.id),
    createdBy: q.createdBy || null, updatedAt: q.updatedAt || null
  };
}

// Everything the user may see: custom entries first within a category, hidden ones only when `includeHidden`.
function list({ engine, includeHidden = false } = {}) {
  const hidden = hiddenIds();
  return [...customList(), ...BUILTIN]
    .filter((q) => (includeHidden || !hidden.has(q.id)) && (!engine || q.engine === engine))
    .map((q) => view(q, hidden));
}

function clean(body) {
  const title = String(body.title || '').trim();
  const sql = String(body.sql || '').trim();
  const category = String(body.category || 'Custom').trim() || 'Custom';
  const description = String(body.description || '').trim();
  const engine = String(body.engine || 'mysql');
  if (!title) throw new Error('Give the query a title');
  if (!sql) throw new Error('Enter the SQL');
  if (!ENGINES.includes(engine)) throw new Error(`The database type must be one of ${ENGINES.join(', ')}`);
  if (title.length > 120 || category.length > 60) throw new Error('The title or category is too long');
  if (description.length > 1000) throw new Error('The description can be up to 1000 characters');
  if (sql.length > 100000) throw new Error('That SQL is too long');
  return { title, sql, category, description, engine, template: Boolean(body.template) };
}

function create(body, by) {
  const q = { id: 'custom-' + crypto.randomBytes(6).toString('hex'), ...clean(body), createdBy: by, updatedAt: new Date().toISOString() };
  withLock(() => writeJson(CUSTOM_FILE, [q, ...customList()]));
  return view(q, hiddenIds());
}

function update(id, body) {
  return withLock(() => {
    const all = customList();
    const i = all.findIndex((q) => q.id === id);
    if (i === -1) return null;
    all[i] = { ...all[i], ...clean({ ...all[i], ...body }), updatedAt: new Date().toISOString() };
    writeJson(CUSTOM_FILE, all);
    return view(all[i], hiddenIds());
  });
}

function remove(id) {
  return withLock(() => {
    const all = customList();
    const next = all.filter((q) => q.id !== id);
    if (next.length === all.length) return false;
    writeJson(CUSTOM_FILE, next);
    writeJson(HIDDEN_FILE, readJson(HIDDEN_FILE).filter((h) => h !== id));
    return true;
  });
}

// Hides (or shows again) any managed query, built-in or custom, for everybody but administrators.
function setHidden(id, hidden) {
  if (!BUILTIN.some((q) => q.id === id) && !customList().some((q) => q.id === id)) return null;
  withLock(() => {
    const set = hiddenIds();
    if (hidden) set.add(id); else set.delete(id);
    writeJson(HIDDEN_FILE, [...set]);
  });
  return { id, hidden: Boolean(hidden) };
}

module.exports = { ENGINES, BUILTIN, list, create, update, remove, setHidden };
