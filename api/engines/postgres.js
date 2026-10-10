// api/engines/postgres.js
// PostgreSQL support. In DB Console terms a PostgreSQL "database" (the thing you pick next to the connection) is a
// schema of the connection's database; "public" comes first.

const pg = require('pg');
const Cursor = require('pg-cursor');
const permissions = require('../permissions');
const tunnel = require('../tunnel');
const S = require('./sql');

const { quote: q } = S;
const MAX_RESULT_ROWS = 10000;
const EXPLAINABLE_RE = /^(select|insert|update|delete|values|with|merge)\b/i;
const EXPORTABLE_RE = /^(select|with|table|values|show|explain)\b/i;
const TEXTLIKE_RE = /^(character|char|bpchar|varchar|text|citext|name|uuid|json|jsonb|xml|bytea)/i;

// Dates and times stay exactly as the server writes them (no time-zone shifting by the driver).
for (const oid of [1082, 1083, 1114, 1184, 1266, 1186]) pg.types.setTypeParser(oid, (v) => v);

const pools = new Map(); // connection key -> { sig, pool }

function poolConfig(conn) {
  const cfg = {
    host: conn.host, port: Number(conn.port) || 5432, user: conn.user, password: conn.password, database: conn.database,
    max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, application_name: 'DB Console'
  };
  if (conn.sslMode) cfg.ssl = { rejectUnauthorized: conn.sslMode === 'verify', ...(conn.sslCa ? { ca: conn.sslCa } : {}), ...(conn.sslCert ? { cert: conn.sslCert } : {}), ...(conn.sslKey ? { key: conn.sslKey } : {}) };
  if (conn.sshHost) cfg.stream = () => tunnel.createStream(conn.key, conn);
  return cfg;
}

function getPool(conn) {
  const sig = JSON.stringify([conn.host, conn.port, conn.user, conn.password, conn.database, conn.sslMode, conn.sslCa, conn.sslCert, conn.sslKey, conn.sshHost, conn.sshPort, conn.sshUser, conn.sshPassword, conn.sshPrivateKey, conn.sshPassphrase, conn.sshHostKey]);
  const cached = pools.get(conn.key);
  if (cached && cached.sig === sig) return cached.pool;
  if (cached) cached.pool.end().catch(() => {});
  const pool = new pg.Pool(poolConfig(conn));
  pool.on('error', () => { /* an idle client lost its connection; the pool replaces it */ });
  pools.set(conn.key, { sig, pool });
  return pool;
}
function dropPool(key) {
  const c = pools.get(key);
  if (c) { c.pool.end().catch(() => {}); pools.delete(key); }
}
async function closeAll() {
  const all = [...pools.values()];
  pools.clear();
  await Promise.allSettled(all.map((c) => c.pool.end()));
}

const query = async (conn, text, params) => (await getPool(conn).query(text, params));
const rows = async (conn, text, params) => (await query(conn, text, params)).rows;

async function ping(conn) { await query(conn, 'SELECT 1'); }

async function test(conn) {
  const tkey = 'test:' + Math.random().toString(36).slice(2);
  const client = new pg.Client({ ...poolConfig({ ...conn, key: tkey }), connectionTimeoutMillis: 10000 });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; } finally {
    await client.end().catch(() => {});
    if (conn.sshHost) tunnel.release(tkey);
  }
}

// ---------- structure ----------
async function listDatabases(conn) {
  const r = await rows(conn, `SELECT schema_name AS name FROM information_schema.schemata
    WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' ORDER BY (schema_name = 'public') DESC, schema_name`);
  return r.map((x) => x.name);
}

async function listTables(conn, schema) {
  const r = await rows(conn, `SELECT c.relname AS name, CASE WHEN c.relkind IN ('v','m') THEN 'VIEW' ELSE 'BASE TABLE' END AS type,
      GREATEST(c.reltuples, 0)::bigint AS "approxRows", pg_table_size(c.oid) AS "dataLength", pg_indexes_size(c.oid) AS "indexLength",
      obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`, [schema]);
  return r.map((t) => ({ ...t, approxRows: Number(t.approxRows), dataLength: Number(t.dataLength), indexLength: Number(t.indexLength), engine: null, autoIncrement: null, collation: null }));
}

async function listObjects(conn, schema) {
  const [tables, routines, triggers] = await Promise.allSettled([
    listTables(conn, schema),
    rows(conn, `SELECT p.proname AS name, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS type FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f','p') ORDER BY p.proname`, [schema]),
    rows(conn, `SELECT t.tgname AS name, c.relname AS "tableName", CASE WHEN t.tgtype & 4 > 0 THEN 'INSERT' WHEN t.tgtype & 8 > 0 THEN 'DELETE' WHEN t.tgtype & 16 > 0 THEN 'UPDATE' ELSE '' END AS event,
        CASE WHEN t.tgtype & 2 > 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname`, [schema])
  ]);
  if (tables.status === 'rejected') throw tables.reason;
  const val = (x) => (x.status === 'fulfilled' ? x.value : []);
  return { tables: tables.value, routines: val(routines), triggers: val(triggers), events: [], errors: {} };
}

const qualified = (schema, table) => `${q(schema)}.${q(table)}`;

async function getTableColumns(conn, schema, table) {
  const cols = await rows(conn, `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
      pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity AS identity, a.attgenerated AS generated, col_description(a.attrelid, a.attnum) AS comment
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, table]);
  if (!cols.length) throw new Error(`Table not found: ${schema}.${table}`);
  const pk = await rows(conn, `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`, [qualified(schema, table)]);
  const primaryKey = pk.map((x) => x.name);
  return {
    columns: cols.map((c) => ({
      name: c.name, type: c.type, nullable: c.nullable, key: primaryKey.includes(c.name) ? 'PRI' : '', default: c.default,
      extra: [(c.identity || /^nextval\(/i.test(c.default || '')) ? 'auto_increment' : '', c.generated ? 'STORED GENERATED' : ''].filter(Boolean).join(' '), comment: c.comment || ''
    })),
    primaryKey
  };
}

function parseDefault(def, nullable) {
  if (def === null || def === undefined) return nullable ? { mode: 'null' } : { mode: 'none' };
  const lit = /^'((?:[^']|'')*)'(?:::[\w\s."\[\]()]+)?$/.exec(def);
  if (lit) return { mode: 'value', value: lit[1].replace(/''/g, "'") };
  if (/^-?\d+(\.\d+)?$/.test(def)) return { mode: 'value', value: def };
  return { mode: 'expression', value: def };
}

const FK_ACTIONS = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const FK_SQL = `SELECT con.conname AS name, c.relname AS "table", n.nspname AS schema, rn.nspname AS "refDb", rc.relname AS "refTable",
    ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
    ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS "refColumns",
    con.confupdtype AS upd, con.confdeltype AS del
  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace WHERE con.contype = 'f' AND n.nspname = $1`;
const fkRow = (r) => ({ name: r.name, table: r.table, columns: r.columns, refDb: r.refDb, refTable: r.refTable, refColumns: r.refColumns, onUpdate: FK_ACTIONS[r.upd], onDelete: FK_ACTIONS[r.del] });
const getForeignKeys = async (conn, schema, table) => (await rows(conn, `${FK_SQL} AND c.relname = $2 ORDER BY con.conname`, [schema, table])).map(fkRow);
const getDatabaseForeignKeys = async (conn, schema) => (await rows(conn, `${FK_SQL} ORDER BY c.relname, con.conname`, [schema])).map(fkRow);

async function tableSchema(conn, schema, table) {
  const [info] = (await listTables(conn, schema)).filter((t) => t.name === table);
  if (!info) throw new Error(`Table not found: ${table}`);
  const { columns, primaryKey } = await getTableColumns(conn, schema, table);
  return {
    info: { ...info, createTime: null, updateTime: null },
    columns: columns.map((c) => ({
      name: c.name, type: c.type, nullable: c.nullable, default: parseDefault(c.default, c.nullable), autoIncrement: /auto_increment/.test(c.extra), onUpdate: false,
      comment: c.comment, collation: null, key: c.key, generated: /GENERATED/.test(c.extra) ? { expression: c.default, kind: 'STORED' } : null, extra: c.extra
    })),
    foreignKeys: await getForeignKeys(conn, schema, table), primaryKey
  };
}

async function tableIndexes(conn, schema, table) {
  const r = await rows(conn, `SELECT i.relname AS name, ix.indisprimary AS "primary", ix.indisunique AS "unique", am.amname AS type, pg_get_indexdef(ix.indexrelid) AS def,
      ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true) FROM generate_series(0, ix.indnkeyatts - 1) k) AS cols
    FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam WHERE n.nspname = $1 AND t.relname = $2 ORDER BY ix.indisprimary DESC, i.relname`, [schema, table]);
  return r.map((x) => ({
    name: x.name, primary: x.primary, unique: x.unique, type: x.type.toUpperCase(), comment: '', kind: x.primary ? 'PRIMARY' : x.unique ? 'UNIQUE' : 'INDEX',
    columns: x.cols, parts: x.cols.map((c) => ({ column: c, length: null })), cardinality: null, definition: x.def
  }));
}

async function objectDefinition(conn, schema, kind, name) {
  if (kind === 'view') {
    const [v] = await rows(conn, `SELECT pg_get_viewdef(c.oid, true) AS def, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, name]);
    return { definition: v ? `CREATE ${v.relkind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${qualified(schema, name)} AS\n${v.def}` : null };
  }
  if (kind === 'procedure' || kind === 'function') {
    const [f] = await rows(conn, `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1`, [schema, name]);
    return { definition: f ? f.def : null };
  }
  if (kind === 'trigger') {
    const [t] = await rows(conn, `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND t.tgname = $2 LIMIT 1`, [schema, name]);
    return { definition: t ? t.def : null };
  }
  if (kind === 'table') {
    const { columns, primaryKey } = await getTableColumns(conn, schema, name);
    const lines = columns.map((c) => `  ${q(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default && !/GENERATED/.test(c.extra) ? ` DEFAULT ${c.default}` : ''}`);
    if (primaryKey.length) lines.push(`  PRIMARY KEY (${primaryKey.map(q).join(', ')})`);
    for (const fk of await getForeignKeys(conn, schema, name)) lines.push(`  CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${qualified(fk.refDb, fk.refTable)} (${fk.refColumns.map(q).join(', ')}) ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`);
    const idx = (await tableIndexes(conn, schema, name)).filter((i) => !i.primary).map((i) => `${i.definition};`);
    return { definition: `CREATE TABLE ${qualified(schema, name)} (\n${lines.join(',\n')}\n);${idx.length ? '\n\n' + idx.join('\n') : ''}` };
  }
  throw new Error(`Unsupported object type: ${kind}`);
}

async function autocomplete(conn, schema) {
  const r = await rows(conn, `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position LIMIT 20000`, [schema]);
  const tables = {};
  for (const x of r) (tables[x.t] = tables[x.t] || []).push(x.c);
  return { tables };
}

async function diagram(conn, schema) {
  const cols = await rows(conn, `SELECT c.relname AS t, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk, c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m') ORDER BY c.relname, a.attnum`, [schema]);
  const tables = new Map();
  for (const c of cols) {
    if (!tables.has(c.t)) tables.set(c.t, { name: c.t, view: c.kind === 'v' || c.kind === 'm', columns: [] });
    tables.get(c.t).columns.push({ name: c.name, type: c.type, pk: c.pk });
  }
  return { tables: [...tables.values()], foreignKeys: await getDatabaseForeignKeys(conn, schema) };
}

const serverMeta = async (conn) => ({ version: (await rows(conn, 'SHOW server_version'))[0].server_version, mariadb: false, defaultCollation: '', collations: [], engines: [] });
const databaseInfo = async (conn, schema) => ({ collation: '', charset: '', schema });

// ---------- rows ----------
const COUNTS = new WeakMap();
function blankToNull(values, columns) {
  const meta = new Map(columns.map((c) => [c.name, c]));
  const out = { ...values };
  for (const [k, v] of Object.entries(out)) {
    const c = meta.get(k);
    if (v === '' && c && c.nullable && !TEXTLIKE_RE.test(c.type)) out[k] = null;
  }
  return out;
}

async function browse(conn, schema, table, { page = 1, pageSize = 50, sortCol, sortDir, sort, filters } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const pageNo = Math.max(Number(page) || 1, 1);
  const { columns } = await getTableColumns(conn, schema, table);
  const names = columns.map((c) => c.name);
  const w = S.buildWhere(filters, names, 'postgres');
  const order = S.orderBy(names, sort, sortCol, sortDir);
  const total = Number((await rows(conn, `SELECT COUNT(*) AS cnt FROM ${qualified(schema, table)} ${w.sql}`, w.params))[0].cnt);
  const b = w.b;
  const lim = b.bind(size); const off = b.bind((pageNo - 1) * size);
  const res = await query(conn, `SELECT * FROM ${qualified(schema, table)} ${w.sql} ${order} LIMIT ${lim} OFFSET ${off}`, b.params);
  return { columns: res.fields.map((f) => f.name), rows: S.encodeRows(res.rows), total, page: pageNo, pageSize: size };
}

function whereFrom(where, b) {
  return Object.entries(where).map(([c, v]) => (v === null || v === undefined ? `${q(c)} IS NULL` : `${q(c)} = ${S.valueSql(v, b.bind, 'postgres')}`)).join(' AND ');
}

async function insertRow(conn, schema, table, values) {
  const cols = Object.keys(values || {});
  if (!cols.length) throw new Error('No values supplied');
  const meta = await getTableColumns(conn, schema, table);
  values = blankToNull(values, meta.columns);
  const b = S.binder('postgres');
  const vals = cols.map((c) => S.valueSql(values[c], b.bind, 'postgres')).join(', ');
  const ret = meta.primaryKey.length === 1 ? ` RETURNING ${q(meta.primaryKey[0])} AS "insertId"` : '';
  const r = await query(conn, `INSERT INTO ${qualified(schema, table)} (${cols.map(q).join(', ')}) VALUES (${vals})${ret}`, b.params);
  return { insertId: r.rows[0] ? r.rows[0].insertId : null, affectedRows: r.rowCount };
}
async function updateRow(conn, schema, table, where, changes) {
  if (!where || !Object.keys(where).length) throw new Error('Missing row identifier (no primary key values supplied)');
  if (!changes || !Object.keys(changes).length) throw new Error('No changes supplied');
  const meta = await getTableColumns(conn, schema, table);
  changes = blankToNull(changes, meta.columns);
  const b = S.binder('postgres');
  const set = Object.entries(changes).map(([c, v]) => `${q(c)} = ${S.valueSql(v, b.bind, 'postgres')}`).join(', ');
  const r = await query(conn, `UPDATE ${qualified(schema, table)} SET ${set} WHERE ${whereFrom(where, b)}`, b.params);
  return { affectedRows: r.rowCount };
}
async function deleteRow(conn, schema, table, where) {
  if (!where || !Object.keys(where).length) throw new Error('Missing row identifier (no primary key values supplied)');
  const b = S.binder('postgres');
  const r = await query(conn, `DELETE FROM ${qualified(schema, table)} WHERE ${whereFrom(where, b)}`, b.params);
  return { affectedRows: r.rowCount };
}
async function cellValue(conn, schema, table, where, column) {
  const b = S.binder('postgres');
  const r = await rows(conn, `SELECT ${q(column)} AS v FROM ${qualified(schema, table)} WHERE ${whereFrom(where, b)} LIMIT 1`, b.params);
  if (!r.length) throw new Error('Row not found');
  return r[0].v;
}

// ---------- the Query Runner ----------
async function runQuery(conn, sqlText, { database, explain = false, allowed = null, track = null } = {}) {
  let statements = S.splitSql(sqlText, 'postgres');
  if (!statements.length) throw new Error('No SQL statement to execute');
  if (explain) {
    statements = statements.filter((st) => EXPLAINABLE_RE.test(S.stripLeading(st))).map((st) => `EXPLAIN ${st}`);
    if (!statements.length) throw new Error('Nothing to explain — EXPLAIN works on SELECT, INSERT, UPDATE, DELETE and WITH');
  }
  const restricted = Boolean(allowed);
  if (restricted) {
    const refused = statements.map((st) => ({ st, error: permissions.statementDenied(st, allowed) })).find((x) => x.error);
    if (refused) return { ok: false, statements: [{ sql: refused.st, ok: false, error: refused.error, durationMs: 0 }], currentDatabase: null };
  }
  const mayCallAnything = !restricted || allowed.has('sql');
  const client = await getPool(conn).connect();
  if (track) track.thread(client.processID);
  const results = [];
  let ok = true; let discard = false; let currentDatabase = null;
  try {
    if (database && database !== 'public') await client.query(`SET search_path TO ${q(database)}, public`);
    for (const stmt of statements) {
      const start = Date.now();
      if (track) track.statement(stmt);
      const guarded = restricted && !mayCallAnything && permissions.statementNeeds(stmt) === 'read';
      try {
        if (guarded) await client.query('BEGIN READ ONLY');
        let r;
        try { r = await client.query(stmt); } finally { if (guarded) await client.query('COMMIT').catch(() => {}); }
        const durationMs = Date.now() - start;
        if (/^\s*(set|reset)\s+(session\s+|local\s+)?search_path\b/i.test(S.stripLeading(stmt))) discard = true;
        if (r.fields && r.fields.length) {
          const total = r.rows.length;
          results.push({ sql: stmt, ok: true, type: 'rows', columns: r.fields.map((f) => f.name), rows: S.encodeRows(total > MAX_RESULT_ROWS ? r.rows.slice(0, MAX_RESULT_ROWS) : r.rows), rowCount: total, truncated: total > MAX_RESULT_ROWS, durationMs, database: database || 'public' });
        } else {
          results.push({ sql: stmt, ok: true, type: 'result', affectedRows: r.rowCount || 0, durationMs, database: database || 'public' });
        }
      } catch (err) {
        if (guarded) await client.query('ROLLBACK').catch(() => {});
        results.push({ sql: stmt, ok: false, error: err.message, durationMs: Date.now() - start });
        ok = false; discard = discard || /current transaction is aborted/i.test(err.message);
        break;
      }
    }
    try { currentDatabase = (await client.query('SELECT current_schema() AS s')).rows[0].s; if (database && database !== 'public') await client.query('RESET search_path'); } catch (e) { discard = true; }
  } finally {
    if (track) track.done();
    client.release(discard);
  }
  return { ok, statements: results, currentDatabase };
}

// Stops the statement a run started (cancel by backend pid), only if it is still the one running.
async function cancel(conn, pid, sqlStart) {
  const r = await rows(conn, `SELECT pg_cancel_backend(pid) AS ok FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query LIKE $2`, [Number(pid), `${S.escapeLike(String(sqlStart).slice(0, 100))}%`]);
  return r.length && r[0].ok ? 1 : 0;
}

// ---------- downloads ----------
async function cursorRows(conn, sql, params, fn, schema) {
  const client = await getPool(conn).connect();
  let failed = false;
  try {
    await client.query('BEGIN READ ONLY');
    if (schema && schema !== 'public') await client.query(`SET LOCAL search_path TO ${q(schema)}, public`);
    const cursor = client.query(new Cursor(sql, params));
    const read = (n) => new Promise((resolve, reject) => cursor.read(n, (err, r) => (err ? reject(err) : resolve(r))));
    const first = await read(200);
    const fields = cursor._result && cursor._result.fields ? cursor._result.fields.map((f) => f.name) : [];
    let pending = first;
    const result = await fn({ columns: fields, next: async () => { if (pending) { const p = pending; pending = null; return p.length ? p : null; } const more = await read(200); return more.length ? more : null; } });
    await new Promise((resolve) => cursor.close(() => resolve()));
    await client.query('COMMIT').catch(() => {});
    return result;
  } catch (e) { failed = true; throw e; } finally { client.release(failed); }
}

async function exportQuery(conn, sqlText, options, res, onStart) {
  const statements = S.splitSql(sqlText, 'postgres');
  if (statements.length !== 1) throw new Error('Choose one statement to download');
  let stmt = statements[0];
  if (permissions.statementNeeds(stmt) !== 'read' || !EXPORTABLE_RE.test(S.stripLeading(stmt))) throw new Error('Only statements that return rows (SELECT, WITH, SHOW, EXPLAIN) can be downloaded');
  const denied = permissions.statementDenied(stmt, options.allowed || null);
  if (denied) throw new Error(denied);
  if (options.stripLimit && /^(select|with|table|values)\b/i.test(S.stripLeading(stmt))) stmt = S.stripTrailingLimit(stmt);
  return cursorRows(conn, stmt.replace(/;+\s*$/, ''), [], ({ columns, next }) => S.writeDelimited({ columns, next, res, options, onStart, filename: `query-result-${stamp()}` }), options.database);
}

async function streamTableCsv(conn, schema, table, res, { sortCol, sortDir, sort, filters, format = 'csv' } = {}) {
  const { columns } = await getTableColumns(conn, schema, table);
  const names = columns.map((c) => c.name);
  const w = S.buildWhere(filters, names, 'postgres');
  return cursorRows(conn, `SELECT * FROM ${qualified(schema, table)} ${w.sql} ${S.orderBy(names, sort, sortCol, sortDir)}`, w.params,
    ({ columns: cols, next }) => S.writeDelimited({ columns: cols.length ? cols : names, next, res, options: { format, bom: false, nulls: '\\N' }, onStart: (name, type) => res.setHeader('Content-Type', type), filename: table }), schema);
}
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

module.exports = {
  dropPool, closeAll, getPool, ping, test, listDatabases, listTables, listObjects, getTableColumns, tableSchema, tableIndexes, objectDefinition,
  autocomplete, diagram, getForeignKeys, getDatabaseForeignKeys, serverMeta, databaseInfo,
  browse, insertRow, updateRow, deleteRow, cellValue, runQuery, cancel, exportQuery, streamTableCsv
};
