// api/engines/sqlite.js
// SQLite support (a database file on the server). Each connection runs in its own worker thread (sqlite-worker.js),
// so a long query can't freeze the server and can be stopped. "database" in the UI is the attached database, "main".

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const permissions = require('../permissions');
const S = require('./sql');

const { quote: q } = S;
const EXPLAINABLE_RE = /^(select|insert|update|delete|replace|with|values)\b/i;
const EXPORTABLE_RE = /^(select|with|values|explain|pragma)\b/i;
const TEXTLIKE_RE = /(char|clob|text|json|uuid|blob|^$)/i;

const handles = new Map(); // connection key -> { sig, worker, pending, seq, ready }

function sigOf(conn) { return JSON.stringify([conn.database, conn.sqliteCreate, conn.sqliteReadOnly]); }

function spawn(conn) {
  const entry = { sig: sigOf(conn), pending: new Map(), seq: 0 };
  entry.worker = new Worker(path.join(__dirname, 'sqlite-worker.js'), { workerData: { file: conn.database, create: Boolean(conn.sqliteCreate), readonly: Boolean(conn.sqliteReadOnly) } });
  entry.ready = new Promise((resolve, reject) => {
    entry.worker.once('error', (e) => { entry.failed = e; reject(e); });
    entry.worker.on('message', (m) => {
      if (m.ready) return resolve();
      const p = entry.pending.get(m.id);
      if (!p) return;
      entry.pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
    });
  });
  entry.ready.catch(() => {});
  entry.worker.on('exit', () => {
    for (const p of entry.pending.values()) p.reject(new Error(entry.stopped ? 'The query was stopped' : 'The SQLite worker ended unexpectedly'));
    entry.pending.clear();
    if (handles.get(conn.key) === entry) handles.delete(conn.key);
  });
  entry.worker.unref();
  return entry;
}

function handleFor(conn) {
  let h = handles.get(conn.key);
  if (h && h.sig !== sigOf(conn)) { h.worker.terminate(); handles.delete(conn.key); h = null; }
  if (!h) { h = spawn(conn); handles.set(conn.key, h); }
  return h;
}

async function call(conn, op, payload = {}) {
  const h = handleFor(conn);
  try { await h.ready; } catch (e) { handles.delete(conn.key); throw new Error(`Cannot open ${conn.database}: ${e.message}`); }
  return new Promise((resolve, reject) => {
    const id = ++h.seq;
    h.pending.set(id, { resolve, reject });
    h.worker.postMessage({ id, op, ...payload });
  });
}
const all = async (conn, sql, params) => (await call(conn, 'all', { sql, params })).rows;

function dropPool(key) { const h = handles.get(key); if (h) { h.worker.terminate(); handles.delete(key); } }
async function closeAll() { await Promise.allSettled([...handles.values()].map((h) => h.worker.terminate())); handles.clear(); }

// Ends whatever the connection is running (the worker is replaced on the next call).
async function cancel(conn) {
  const h = handles.get(conn.key);
  if (!h || !h.pending.size) return 0;
  // A statement running inside SQLite's native code cannot be interrupted from JavaScript, so the
  // worker is abandoned: callers are released at once and the next call gets a fresh worker.
  h.stopped = true;
  handles.delete(conn.key);
  for (const p of h.pending.values()) p.reject(new Error('The query was stopped'));
  h.pending.clear();
  h.worker.terminate().catch(() => {});
  return 1;
}

function checkFile(conn) {
  if (!conn.database) throw new Error('Enter the path of the SQLite file');
  if (!conn.sqliteCreate && !fs.existsSync(conn.database)) throw new Error(`The file ${conn.database} does not exist`);
}
async function ping(conn) { await all(conn, 'SELECT 1'); }
async function test(conn) {
  try {
    checkFile(conn);
    const Database = require('better-sqlite3');
    const d = new Database(conn.database, { readonly: true, fileMustExist: !conn.sqliteCreate });
    try { d.prepare('SELECT count(*) FROM sqlite_master').get(); } finally { d.close(); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- structure ----------
async function listDatabases(conn) {
  const r = await all(conn, 'PRAGMA database_list');
  return r.map((x) => x.name).filter((n) => n !== 'temp');
}
const master = (schema) => `${q(schema)}.sqlite_master`;

async function listTables(conn, schema) {
  const r = await all(conn, `SELECT name, type FROM ${master(schema)} WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`);
  return r.map((t) => ({ name: t.name, type: t.type === 'view' ? 'VIEW' : 'BASE TABLE', approxRows: null, engine: null, dataLength: 0, indexLength: 0, autoIncrement: null, collation: null, comment: '' }));
}
async function listObjects(conn, schema) {
  const tables = await listTables(conn, schema);
  const trig = await all(conn, `SELECT name, tbl_name AS "tableName", sql FROM ${master(schema)} WHERE type = 'trigger' ORDER BY name`);
  return {
    tables, routines: [], events: [], errors: {},
    triggers: trig.map((t) => ({ name: t.name, tableName: t.tableName, event: (/\b(INSERT|UPDATE|DELETE)\b/i.exec(t.sql) || [])[1] || '', timing: (/\b(BEFORE|AFTER|INSTEAD OF)\b/i.exec(t.sql) || [])[1] || '' }))
  };
}

async function getTableColumns(conn, schema, table) {
  const cols = await all(conn, `PRAGMA ${q(schema)}.table_xinfo(${q(table)})`);
  if (!cols.length) throw new Error(`Table not found: ${schema}.${table}`);
  const tableSql = ((await all(conn, `SELECT sql FROM ${master(schema)} WHERE name = ?`, [table]))[0] || {}).sql || '';
  const primaryKey = cols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
  const autoInc = /\bAUTOINCREMENT\b/i.test(tableSql);
  const rowidAlias = primaryKey.length === 1 && /^integer$/i.test(cols.find((c) => c.name === primaryKey[0]).type);
  return {
    columns: cols.map((c) => ({
      name: c.name, type: c.type || '', nullable: Number(c.notnull) === 0 && Number(c.pk) === 0, key: Number(c.pk) > 0 ? 'PRI' : '', default: c.dflt_value,
      extra: [rowidAlias && c.name === primaryKey[0] ? 'auto_increment' : '', Number(c.hidden) >= 2 ? 'STORED GENERATED' : ''].filter(Boolean).join(' '), comment: ''
    })),
    primaryKey, autoInc
  };
}

function parseDefault(def, nullable) {
  if (def === null || def === undefined) return nullable ? { mode: 'null' } : { mode: 'none' };
  const lit = /^'((?:[^']|'')*)'$/.exec(def);
  if (lit) return { mode: 'value', value: lit[1].replace(/''/g, "'") };
  if (/^-?\d+(\.\d+)?$/.test(def)) return { mode: 'value', value: def };
  return { mode: 'expression', value: def };
}

async function getForeignKeys(conn, schema, table) {
  const r = await all(conn, `PRAGMA ${q(schema)}.foreign_key_list(${q(table)})`);
  const byId = new Map();
  for (const f of r) {
    const id = Number(f.id);
    if (!byId.has(id)) byId.set(id, { name: `fk_${table}_${id}`, table, columns: [], refDb: schema, refTable: f.table, refColumns: [], onUpdate: f.on_update, onDelete: f.on_delete });
    byId.get(id).columns.push(f.from); byId.get(id).refColumns.push(f.to);
  }
  return [...byId.values()];
}
async function getDatabaseForeignKeys(conn, schema) {
  const out = [];
  for (const t of (await listTables(conn, schema)).filter((x) => x.type === 'BASE TABLE')) out.push(...await getForeignKeys(conn, schema, t.name));
  return out;
}

async function tableSchema(conn, schema, table) {
  const [info] = (await listTables(conn, schema)).filter((t) => t.name === table);
  if (!info) throw new Error(`Table not found: ${table}`);
  const { columns, primaryKey } = await getTableColumns(conn, schema, table);
  return {
    info: { ...info, createTime: null, updateTime: null },
    columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, default: parseDefault(c.default, c.nullable), autoIncrement: /auto_increment/.test(c.extra), onUpdate: false, comment: '', collation: null, key: c.key, generated: /GENERATED/.test(c.extra) ? { expression: '', kind: 'STORED' } : null, extra: c.extra })),
    foreignKeys: await getForeignKeys(conn, schema, table), primaryKey
  };
}

async function tableIndexes(conn, schema, table) {
  const { primaryKey } = await getTableColumns(conn, schema, table);
  const out = [];
  if (primaryKey.length) out.push({ name: 'PRIMARY', primary: true, unique: true, type: 'ROWID', comment: '', kind: 'PRIMARY', columns: primaryKey, parts: primaryKey.map((c) => ({ column: c, length: null })), cardinality: null });
  for (const ix of await all(conn, `PRAGMA ${q(schema)}.index_list(${q(table)})`)) {
    if (ix.origin === 'pk') continue;
    const cols = (await all(conn, `PRAGMA ${q(schema)}.index_info(${q(ix.name)})`)).sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((c) => c.name || '(expression)');
    out.push({ name: ix.name, primary: false, unique: Number(ix.unique) === 1, type: 'BTREE', comment: Number(ix.partial) ? 'partial' : '', kind: Number(ix.unique) ? 'UNIQUE' : 'INDEX', columns: cols, parts: cols.map((c) => ({ column: c, length: null })), cardinality: null });
  }
  return out;
}

async function objectDefinition(conn, schema, kind, name) {
  const r = await all(conn, `SELECT sql FROM ${master(schema)} WHERE name = ? AND type = ?`, [name, kind === 'table' ? 'table' : kind === 'view' ? 'view' : 'trigger']);
  return { definition: r[0] ? r[0].sql : null };
}
async function autocomplete(conn, schema) {
  const tables = {};
  for (const t of await listTables(conn, schema)) tables[t.name] = (await all(conn, `PRAGMA ${q(schema)}.table_info(${q(t.name)})`)).map((c) => c.name);
  return { tables };
}
async function diagram(conn, schema) {
  const tables = [];
  for (const t of await listTables(conn, schema)) {
    const cols = await all(conn, `PRAGMA ${q(schema)}.table_info(${q(t.name)})`);
    tables.push({ name: t.name, view: t.type === 'VIEW', columns: cols.map((c) => ({ name: c.name, type: c.type || '', pk: Number(c.pk) > 0 })) });
  }
  return { tables, foreignKeys: await getDatabaseForeignKeys(conn, schema) };
}
const serverMeta = async (conn) => ({ version: 'SQLite ' + (await all(conn, 'SELECT sqlite_version() AS v'))[0].v, mariadb: false, defaultCollation: '', collations: [], engines: [] });
const databaseInfo = async (conn, schema) => ({ collation: '', charset: '', schema });

// ---------- rows ----------
const qualified = (schema, table) => `${q(schema)}.${q(table)}`;
function blankToNull(values, columns) {
  const meta = new Map(columns.map((c) => [c.name, c]));
  const out = { ...values };
  for (const [k, v] of Object.entries(out)) { const c = meta.get(k); if (v === '' && c && c.nullable && !TEXTLIKE_RE.test(c.type)) out[k] = null; }
  return out;
}
async function browse(conn, schema, table, { page = 1, pageSize = 50, sortCol, sortDir, sort, filters } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const pageNo = Math.max(Number(page) || 1, 1);
  const { columns } = await getTableColumns(conn, schema, table);
  const names = columns.map((c) => c.name);
  const w = S.buildWhere(filters, names, 'sqlite');
  const total = Number((await all(conn, `SELECT COUNT(*) AS cnt FROM ${qualified(schema, table)} ${w.sql}`, w.params))[0].cnt);
  const res = await call(conn, 'all', { sql: `SELECT * FROM ${qualified(schema, table)} ${w.sql} ${S.orderBy(names, sort, sortCol, sortDir)} LIMIT ? OFFSET ?`, params: [...w.params, size, (pageNo - 1) * size] });
  return { columns: res.columns, rows: S.encodeRows(res.rows), total, page: pageNo, pageSize: size };
}
function whereFrom(where, b) {
  return Object.entries(where).map(([c, v]) => (v === null || v === undefined ? `${q(c)} IS NULL` : `${q(c)} = ${S.valueSql(v, b.bind, 'sqlite')}`)).join(' AND ');
}
async function insertRow(conn, schema, table, values) {
  const cols = Object.keys(values || {});
  if (!cols.length) throw new Error('No values supplied');
  values = blankToNull(values, (await getTableColumns(conn, schema, table)).columns);
  const b = S.binder('sqlite');
  const vals = cols.map((c) => S.valueSql(values[c], b.bind, 'sqlite')).join(', ');
  const r = await call(conn, 'run', { sql: `INSERT INTO ${qualified(schema, table)} (${cols.map(q).join(', ')}) VALUES (${vals})`, params: b.params });
  return { insertId: S.encodeCell(r.lastInsertRowid), affectedRows: Number(r.changes) };
}
async function updateRow(conn, schema, table, where, changes) {
  if (!where || !Object.keys(where).length) throw new Error('Missing row identifier (no primary key values supplied)');
  if (!changes || !Object.keys(changes).length) throw new Error('No changes supplied');
  changes = blankToNull(changes, (await getTableColumns(conn, schema, table)).columns);
  const b = S.binder('sqlite');
  const set = Object.entries(changes).map(([c, v]) => `${q(c)} = ${S.valueSql(v, b.bind, 'sqlite')}`).join(', ');
  const r = await call(conn, 'run', { sql: `UPDATE ${qualified(schema, table)} SET ${set} WHERE ${whereFrom(where, b)}`, params: b.params });
  return { affectedRows: Number(r.changes) };
}
async function deleteRow(conn, schema, table, where) {
  if (!where || !Object.keys(where).length) throw new Error('Missing row identifier (no primary key values supplied)');
  const b = S.binder('sqlite');
  const r = await call(conn, 'run', { sql: `DELETE FROM ${qualified(schema, table)} WHERE ${whereFrom(where, b)}`, params: b.params });
  return { affectedRows: Number(r.changes) };
}
async function cellValue(conn, schema, table, where, column) {
  const b = S.binder('sqlite');
  const r = await all(conn, `SELECT ${q(column)} AS v FROM ${qualified(schema, table)} WHERE ${whereFrom(where, b)} LIMIT 1`, b.params);
  if (!r.length) throw new Error('Row not found');
  return r[0].v;
}

// ---------- the Query Runner ----------
async function runQuery(conn, sqlText, { database, explain = false, allowed = null, track = null } = {}) {
  let statements = S.splitSql(sqlText, 'sqlite');
  if (!statements.length) throw new Error('No SQL statement to execute');
  if (explain) {
    statements = statements.filter((st) => EXPLAINABLE_RE.test(S.stripLeading(st))).map((st) => `EXPLAIN QUERY PLAN ${st}`);
    if (!statements.length) throw new Error('Nothing to explain — EXPLAIN works on SELECT, INSERT, UPDATE and DELETE');
  }
  const restricted = Boolean(allowed);
  if (restricted) {
    const refused = statements.map((st) => ({ st, error: permissions.statementDenied(st, allowed) })).find((x) => x.error);
    if (refused) return { ok: false, statements: [{ sql: refused.st, ok: false, error: refused.error, durationMs: 0 }], currentDatabase: null };
  }
  const mayCallAnything = !restricted || allowed.has('sql');
  const guard = statements.map((st) => restricted && !mayCallAnything && permissions.statementNeeds(st) === 'read' && !/^\s*pragma\b/i.test(S.stripLeading(st)));
  // One worker runs the whole script, so Stop ends all of it; a fixed number stands in for a thread id.
  if (track) { track.thread(1); track.statement(statements[0]); }
  let out;
  try { out = await call(conn, 'statements', { statements, guard }); } finally { if (track) track.done(); }
  for (const e of out) { if (e.ok) { if (e.rows) S.encodeRows(e.rows); e.database = database || 'main'; } }
  return { ok: out.every((e) => e.ok) && out.length === statements.length, statements: out, currentDatabase: 'main' };
}

// ---------- downloads ----------
async function openRows(conn, sql, params, fn) {
  const it = await call(conn, 'open', { sql, params });
  try { return await fn({ columns: it.columns, next: async () => { const r = await call(conn, 'next', { cur: it.cur, n: 200 }); return r.length ? r : null; } }); } finally { await call(conn, 'close', { cur: it.cur }).catch(() => {}); }
}
async function exportQuery(conn, sqlText, options, res, onStart) {
  const statements = S.splitSql(sqlText, 'sqlite');
  if (statements.length !== 1) throw new Error('Choose one statement to download');
  let stmt = statements[0];
  if (permissions.statementNeeds(stmt) !== 'read' || !EXPORTABLE_RE.test(S.stripLeading(stmt))) throw new Error('Only statements that return rows can be downloaded');
  const denied = permissions.statementDenied(stmt, options.allowed || null);
  if (denied) throw new Error(denied);
  if (options.stripLimit && /^(select|with|values)\b/i.test(S.stripLeading(stmt))) stmt = S.stripTrailingLimit(stmt);
  return openRows(conn, stmt.replace(/;+\s*$/, ''), [], ({ columns, next }) => S.writeDelimited({ columns, next, res, options, onStart, filename: `query-result-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}` }));
}
async function streamTableCsv(conn, schema, table, res, { sortCol, sortDir, sort, filters, format = 'csv' } = {}) {
  const { columns } = await getTableColumns(conn, schema, table);
  const names = columns.map((c) => c.name);
  const w = S.buildWhere(filters, names, 'sqlite');
  return openRows(conn, `SELECT * FROM ${qualified(schema, table)} ${w.sql} ${S.orderBy(names, sort, sortCol, sortDir)}`, w.params,
    ({ columns: cols, next }) => S.writeDelimited({ columns: cols, next, res, options: { format, bom: false, nulls: '\\N' }, onStart: (name, type) => res.setHeader('Content-Type', type), filename: table }));
}

module.exports = {
  dropPool, closeAll, ping, test, listDatabases, listTables, listObjects, getTableColumns, tableSchema, tableIndexes, objectDefinition, autocomplete, diagram,
  getForeignKeys, getDatabaseForeignKeys, serverMeta, databaseInfo, browse, insertRow, updateRow, deleteRow, cellValue, runQuery, cancel, exportQuery, streamTableCsv
};
