// db.js
// Builds/caches a mysql2 pool per connection defined in store.js.
// Pools are rebuilt automatically if a connection's settings change.

const mysql = require('mysql2/promise');
const mysqlUtil = require('mysql2'); // for safe identifier escaping (escapeId)
const store = require('./store');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

// key -> { configStr, pool }
const poolCache = new Map();

function poolConfig(conn) {
  return {
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    multipleStatements: false, // enable only if you trust the SQL being run
    // Return DATE/DATETIME/TIMESTAMP exactly as stored instead of converting
    // to JS Dates (which shifts them by the server's timezone and breaks
    // editing a row and writing the value back).
    dateStrings: true,
    // BIGINTs too large for a JS number come back as strings instead of
    // silently losing precision (which could edit/delete the wrong row).
    supportBigNumbers: true
  };
}

function getPool(key) {
  const conn = store.getConnection(key);
  if (!conn) {
    throw new Error(`Unknown connection: ${key}`);
  }

  // Only settings that affect the pool count; sharing/ownership changes don't.
  const configStr = JSON.stringify(poolConfig(conn));
  const cached = poolCache.get(key);
  if (cached && cached.configStr === configStr) {
    return cached.pool;
  }

  if (cached) {
    cached.pool.end().catch(() => {});
  }

  const pool = mysql.createPool(poolConfig(conn));
  poolCache.set(key, { configStr, pool });
  return pool;
}

function dropPool(key) {
  const cached = poolCache.get(key);
  if (cached) {
    cached.pool.end().catch(() => {});
    poolCache.delete(key);
  }
}

async function closeAllPools() {
  const pools = [...poolCache.values()].map((c) => c.pool);
  poolCache.clear();
  await Promise.allSettled(pools.map((p) => p.end()));
}

// A dedicated (non-pool) connection for streaming a large result. It gets an
// 'error' listener: without one, a connection-level error (server gone
// away, or an error after we destroyed it because the client cancelled a
// download) would be thrown as an uncaught exception and kill the process.
// Query errors still reach the query stream's own 'error' handler.
function createStreamingConnection(conn) {
  const rawConn = mysqlUtil.createConnection(poolConfig(conn));
  rawConn.on('error', (err) => {
    if (err.code !== 'ERR_STREAM_WRITE_AFTER_END') console.error(`MySQL streaming connection error: ${err.message}`);
  });
  return rawConn;
}

// Closes a streaming connection. On success, a graceful end(). After a
// failure or a cancelled download, mysql2's destroy() is not enough: it
// only half-closes the socket, and while the result stream is paused the
// server keeps blocking on "Writing to net" forever. Destroying the socket
// itself makes the server abort the query.
function closeStreamingConnection(rawConn, failed) {
  if (!failed) return rawConn.end();
  rawConn.destroy();
  if (rawConn.stream) rawConn.stream.destroy();
}

// Statements that can't leave session state behind on a pooled connection.
// Anything else (USE, SET, START TRANSACTION, LOCK TABLES, CREATE TEMPORARY
// TABLE, CALL, PREPARE, user variables...) could change what the *next*
// query on that pooled connection does — possibly another user's query on
// a shared connection — so after such a run the connection is discarded
// instead of returned to the pool. USE is safe here because runQuery()
// switches the connection back to its default database afterwards.
const STATE_SAFE_RE = /^(use|select|insert|update|delete|replace|show|describe|desc|explain|with|values|table|alter|drop|truncate|rename|analyze|optimize|check|checksum|repair|grant|revoke|commit|rollback|help|do)\b/i;

function stripLeadingComments(sql) {
  return String(sql).replace(/^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '');
}

function leavesSessionState(stmt) {
  const s = stripLeadingComments(stmt);
  if (/^create\b/i.test(s)) return /^create\s+temporary\b/i.test(s);
  if (!STATE_SAFE_RE.test(s)) return true;
  return /:=|\binto\s+@/i.test(s); // assigns a user variable
}

// Stateful SQL statement splitter: can be fed text incrementally (for
// streaming a large .sql file during restore) or all at once. Splits on
// top-level ';' characters while ignoring semicolons inside string/
// identifier literals and comments. Good enough for an admin tool; not a
// full SQL parser.
class SqlStatementStream {
  constructor() {
    this.buffer = '';
    this.pos = 0;
    this.inSingle = false;
    this.inDouble = false;
    this.inBacktick = false;
    this.inLineComment = false;
    this.inBlockComment = false;
  }

  // Feed more text; returns an array of complete statements found so far.
  feed(chunk) {
    this.buffer += chunk;
    const statements = [];
    let stmtStart = 0;
    let i = this.pos;

    while (i < this.buffer.length) {
      const ch = this.buffer[i];
      const next = this.buffer[i + 1];

      if (this.inLineComment) {
        if (ch === '\n') this.inLineComment = false;
        i++; continue;
      }
      if (this.inBlockComment) {
        if (ch === '*' && next === '/') { i += 2; this.inBlockComment = false; continue; }
        i++; continue;
      }
      if (!this.inSingle && !this.inDouble && !this.inBacktick && ch === '-' && next === '-') {
        this.inLineComment = true; i += 2; continue;
      }
      if (!this.inSingle && !this.inDouble && !this.inBacktick && ch === '/' && next === '*') {
        this.inBlockComment = true; i += 2; continue;
      }
      if ((this.inSingle || this.inDouble) && ch === '\\') { i += 2; continue; }
      if (ch === "'" && !this.inDouble && !this.inBacktick) {
        if (this.inSingle && next === "'") { i += 2; continue; }
        this.inSingle = !this.inSingle; i++; continue;
      }
      if (ch === '"' && !this.inSingle && !this.inBacktick) {
        if (this.inDouble && next === '"') { i += 2; continue; }
        this.inDouble = !this.inDouble; i++; continue;
      }
      if (ch === '`' && !this.inSingle && !this.inDouble) {
        this.inBacktick = !this.inBacktick; i++; continue;
      }
      if (ch === ';' && !this.inSingle && !this.inDouble && !this.inBacktick) {
        const stmt = this.buffer.substring(stmtStart, i).trim();
        if (stmt) statements.push(stmt);
        stmtStart = i + 1;
        i++; continue;
      }
      i++;
    }

    this.pos = i;
    this.buffer = this.buffer.substring(stmtStart);
    this.pos -= stmtStart;
    return statements;
  }

  // Call once the input is exhausted; returns any trailing statement that
  // wasn't terminated by a final ';'.
  flush() {
    const stmt = this.buffer.trim();
    this.buffer = '';
    this.pos = 0;
    return stmt ? [stmt] : [];
  }
}

function splitStatements(sqlText) {
  const s = new SqlStatementStream();
  return s.feed(sqlText).concat(s.flush());
}

// Runs `sqlText` on connection `key`.
//
// `database` is the database the Query Runner is currently "in" for this
// connection (after an earlier `USE other_db`); the batch starts there.
// Returns the database the batch ended in as `currentDatabase`, so a `USE`
// carries over to the next run. The pooled connection itself is always put
// back on its configured default database, so nothing leaks to the next
// user of the pool.
async function runQuery(key, sqlText, { database } = {}) {
  const statements = splitStatements(sqlText);
  if (statements.length === 0) {
    throw new Error('No SQL statement to execute');
  }

  const pool = getPool(key);
  const defaultDb = store.getConnection(key).database;
  const conn = await pool.getConnection();
  const results = [];
  let ok = true;
  let discard = statements.some(leavesSessionState);
  let currentDatabase = null;

  try {
    if (database && database !== defaultDb) {
      try {
        await conn.query(`USE ${esc(database)}`);
      } catch (err) {
        // e.g. the database was dropped; run nowhere rather than in the
        // wrong database.
        results.push({ sql: `USE ${esc(database)}`, ok: false, error: `Could not switch to database ${database}: ${err.message}`, durationMs: 0 });
        ok = false;
      }
    }

    for (const stmt of ok ? statements : []) {
      const start = Date.now();
      try {
        const [rows, fields] = await conn.query(stmt);
        const durationMs = Date.now() - start;

        if (Array.isArray(rows)) {
          results.push({
            sql: stmt,
            ok: true,
            type: 'rows',
            columns: fields ? fields.map((f) => f.name) : [],
            rows,
            rowCount: rows.length,
            durationMs
          });
        } else {
          results.push({
            sql: stmt,
            ok: true,
            type: 'result',
            affectedRows: rows.affectedRows,
            insertId: rows.insertId,
            changedRows: rows.changedRows,
            warningStatus: rows.warningStatus,
            durationMs
          });
        }
      } catch (err) {
        results.push({ sql: stmt, ok: false, error: err.message, durationMs: Date.now() - start });
        ok = false;
        break; // stop at the first failing statement in the batch
      }
    }

    try {
      const [[row]] = await conn.query('SELECT DATABASE() AS db');
      currentDatabase = row.db;
      if (!discard && defaultDb && currentDatabase !== defaultDb) await conn.query(`USE ${esc(defaultDb)}`);
    } catch (err) {
      discard = true; // connection is broken, or can't be reset
    }
  } finally {
    // destroy() closes the connection, which also rolls back any
    // transaction left open; the pool opens a fresh one when needed.
    if (discard) conn.destroy();
    else conn.release();
  }

  return { ok, statements: results, currentDatabase };
}

// Test an arbitrary connection config (used for "Test connection" in the UI,
// both for unsaved forms and for existing saved connections).
async function testConnection(conn) {
  let connection;
  try {
    connection = await mysql.createConnection(poolConfig(conn));
    await connection.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (connection) await connection.end().catch(() => {});
  }
}

module.exports = {
  getPool,
  dropPool,
  closeAllPools,
  splitStatements,
  runQuery,
  testConnection,
  listDatabases,
  listTables,
  listObjects,
  getTableIndexes,
  getObjectDefinition,
  getTableColumns,
  browseTable,
  updateRow,
  deleteRow,
  insertRow,
  streamTableCsv,
  insertRowsBulk,
  truncateTable,
  streamDatabaseBackup,
  streamDatabaseBackupTarGz,
  restoreDump
};

// ===================== Explore (Adminer-style browsing) =====================

function esc(identifier) {
  return mysqlUtil.escapeId(identifier);
}

async function listDatabases(key) {
  const pool = getPool(key);
  const [rows] = await pool.query('SHOW DATABASES');
  // Row shape is { Database: 'name' }
  return rows.map((r) => r.Database).sort((a, b) => a.localeCompare(b));
}

// Tables AND views (type is 'BASE TABLE' or 'VIEW').
async function listTables(key, database) {
  const pool = getPool(key);
  const [rows] = await pool.query(
    `SELECT TABLE_NAME AS name, TABLE_ROWS AS approxRows, ENGINE AS engine, TABLE_TYPE AS type
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME`,
    [database]
  );
  return rows;
}

async function listRoutines(key, database) {
  const pool = getPool(key);
  const [rows] = await pool.query(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, LAST_ALTERED AS modified
     FROM information_schema.ROUTINES
     WHERE ROUTINE_SCHEMA = ?
     ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
    [database]
  );
  return rows;
}

async function listTriggers(key, database) {
  const pool = getPool(key);
  const [rows] = await pool.query(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName,
            EVENT_MANIPULATION AS event, ACTION_TIMING AS timing
     FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = ?
     ORDER BY TRIGGER_NAME`,
    [database]
  );
  return rows;
}

async function listEvents(key, database) {
  const pool = getPool(key);
  const [rows] = await pool.query(
    `SELECT EVENT_NAME AS name, STATUS AS status, EVENT_TYPE AS eventType,
            INTERVAL_VALUE AS intervalValue, INTERVAL_FIELD AS intervalField,
            EXECUTE_AT AS executeAt, LAST_EXECUTED AS lastExecuted
     FROM information_schema.EVENTS
     WHERE EVENT_SCHEMA = ?
     ORDER BY EVENT_NAME`,
    [database]
  );
  return rows;
}

// Everything the Explore left panel needs in one call. Tables/views failing
// is a real error; routines/triggers/events failing (e.g. missing privilege
// or an old server) just yields an empty list plus a note.
async function listObjects(key, database) {
  const [t, r, tr, e] = await Promise.allSettled([
    listTables(key, database),
    listRoutines(key, database),
    listTriggers(key, database),
    listEvents(key, database)
  ]);
  if (t.status === 'rejected') throw t.reason;
  const val = (x) => (x.status === 'fulfilled' ? x.value : []);
  const err = (x) => (x.status === 'rejected' ? x.reason.message : null);
  return {
    tables: t.value,
    routines: val(r),
    triggers: val(tr),
    events: val(e),
    errors: { routines: err(r), triggers: err(tr), events: err(e) }
  };
}

// Groups SHOW INDEX rows (one per indexed column) into one entry per index.
async function getTableIndexes(key, database, table) {
  const pool = getPool(key);
  const [rows] = await pool.query(`SHOW INDEX FROM ${esc(database)}.${esc(table)}`);
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.Key_name)) {
      byName.set(r.Key_name, {
        name: r.Key_name,
        primary: r.Key_name === 'PRIMARY',
        unique: Number(r.Non_unique) === 0,
        type: r.Index_type,
        comment: r.Index_comment || '',
        parts: []
      });
    }
    byName.get(r.Key_name).parts.push({
      seq: Number(r.Seq_in_index),
      // Functional indexes (MySQL 8) have no column name, only an expression
      column: r.Column_name || (r.Expression ? `(${r.Expression})` : ''),
      subPart: r.Sub_part,
      cardinality: r.Cardinality
    });
  }
  return [...byName.values()].map(({ parts, ...idx }) => {
    parts.sort((a, b) => a.seq - b.seq);
    return {
      ...idx,
      columns: parts.map((p) => (p.subPart ? `${p.column}(${p.subPart})` : p.column)),
      cardinality: parts.length ? parts[parts.length - 1].cardinality : null
    };
  });
}

const DEFINITION_KEYWORDS = {
  table: 'TABLE',
  view: 'VIEW',
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
  trigger: 'TRIGGER',
  event: 'EVENT'
};

// SHOW CREATE <kind> for any object type; the DDL column name differs per
// kind ('Create Table', 'Create View', 'SQL Original Statement', ...).
async function getObjectDefinition(key, database, kind, name) {
  const keyword = DEFINITION_KEYWORDS[kind];
  if (!keyword) throw new Error(`Unsupported object type: ${kind}`);
  const pool = getPool(key);
  const [rows] = await pool.query(`SHOW CREATE ${keyword} ${esc(database)}.${esc(name)}`);
  const row = rows[0] || {};
  const col = Object.keys(row).find((k) => /^Create /i.test(k) || k === 'SQL Original Statement');
  return { definition: col ? row[col] : null };
}

async function getTableColumns(key, database, table) {
  const pool = getPool(key);
  const [cols] = await pool.query(`SHOW FULL COLUMNS FROM ${esc(database)}.${esc(table)}`);
  const [keyRows] = await pool.query(
    `SHOW KEYS FROM ${esc(database)}.${esc(table)} WHERE Key_name = 'PRIMARY'`
  );
  const primaryKey = keyRows.map((k) => k.Column_name);

  return {
    columns: cols.map((c) => ({
      name: c.Field,
      type: c.Type,
      nullable: c.Null === 'YES',
      key: c.Key,
      default: c.Default,
      extra: c.Extra,
      comment: c.Comment
    })),
    primaryKey
  };
}

async function browseTable(key, database, table, { page = 1, pageSize = 50, sortCol, sortDir } = {}) {
  const pool = getPool(key);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safePageSize;

  const { columns } = await getTableColumns(key, database, table);
  const columnNames = columns.map((c) => c.name);

  let orderClause = '';
  if (sortCol && columnNames.includes(sortCol)) {
    orderClause = `ORDER BY ${esc(sortCol)} ${sortDir === 'desc' ? 'DESC' : 'ASC'}`;
  }

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ${esc(database)}.${esc(table)}`
  );
  const total = countRows[0].cnt;

  const [rows, fields] = await pool.query(
    `SELECT * FROM ${esc(database)}.${esc(table)} ${orderClause} LIMIT ? OFFSET ?`,
    [safePageSize, offset]
  );

  return {
    columns: fields ? fields.map((f) => f.name) : columnNames,
    rows,
    total,
    page: safePage,
    pageSize: safePageSize
  };
}

// An empty string can't be stored in a numeric/date/etc. column (strict
// mode rejects it). For such columns that allow NULL, treat '' as NULL —
// this is also how an exported CSV represents NULL, so export → import
// round-trips. Text-like columns keep '' as a real empty string.
const TEXTLIKE_TYPE_RE = /char|text|enum|set|binary|blob/i;

async function blankToNullColumns(key, database, table) {
  const { columns } = await getTableColumns(key, database, table);
  return new Set(columns.filter((c) => c.nullable && !TEXTLIKE_TYPE_RE.test(c.type)).map((c) => c.name));
}

function applyBlankToNull(values, nullable) {
  const out = {};
  for (const [k, v] of Object.entries(values)) out[k] = v === '' && nullable.has(k) ? null : v;
  return out;
}

async function updateRow(key, database, table, where, changes) {
  if (!where || Object.keys(where).length === 0) {
    throw new Error('Missing row identifier (no primary key values supplied)');
  }
  if (!changes || Object.keys(changes).length === 0) {
    throw new Error('No changes supplied');
  }

  const pool = getPool(key);
  changes = applyBlankToNull(changes, await blankToNullColumns(key, database, table));
  const setClause = Object.keys(changes).map((c) => `${esc(c)} = ?`).join(', ');
  const whereClause = Object.keys(where).map((c) => `${esc(c)} = ?`).join(' AND ');
  const params = [...Object.values(changes), ...Object.values(where)];

  const [result] = await pool.query(
    `UPDATE ${esc(database)}.${esc(table)} SET ${setClause} WHERE ${whereClause} LIMIT 1`,
    params
  );
  return { affectedRows: result.affectedRows };
}

async function deleteRow(key, database, table, where) {
  if (!where || Object.keys(where).length === 0) {
    throw new Error('Missing row identifier (no primary key values supplied)');
  }

  const pool = getPool(key);
  const whereClause = Object.keys(where).map((c) => `${esc(c)} = ?`).join(' AND ');
  const params = Object.values(where);

  const [result] = await pool.query(
    `DELETE FROM ${esc(database)}.${esc(table)} WHERE ${whereClause} LIMIT 1`,
    params
  );
  return { affectedRows: result.affectedRows };
}

async function insertRow(key, database, table, values) {
  const cols = Object.keys(values || {});
  if (cols.length === 0) {
    throw new Error('No values supplied');
  }

  const pool = getPool(key);
  values = applyBlankToNull(values, await blankToNullColumns(key, database, table));
  const colClause = cols.map(esc).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const params = cols.map((c) => values[c]);

  const [result] = await pool.query(
    `INSERT INTO ${esc(database)}.${esc(table)} (${colClause}) VALUES (${placeholders})`,
    params
  );
  return { insertId: result.insertId, affectedRows: result.affectedRows };
}

// ===================== CSV export / import =====================

// NULL is written as \N (the MySQL / LOAD DATA convention) so it stays
// distinct from an empty string and the CSV imports back exactly.
const CSV_NULL = '\\N';

// mysql2 returns JSON columns as parsed objects/arrays; turn them back into
// JSON text (String(obj) would give "[object Object]").
function isJsonValue(value) {
  return value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date);
}

// SQL literal for a value read from a row, for writing into a dump.
function sqlLiteral(value) {
  return mysqlUtil.escape(isJsonValue(value) ? JSON.stringify(value) : value);
}

function csvField(value) {
  if (value === null || value === undefined) return CSV_NULL;
  if (value instanceof Date) value = value.toISOString();
  else if (Buffer.isBuffer(value)) value = value.toString('base64');
  else if (isJsonValue(value)) value = JSON.stringify(value);
  const str = String(value);
  return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

// Streams a table's full contents (no LIMIT) to `res` as CSV, one row at a
// time, so exporting a very large table doesn't buffer it all in memory.
async function streamTableCsv(key, database, table, res, { sortCol, sortDir } = {}) {
  const conn = store.getConnection(key);
  if (!conn) throw new Error(`Unknown connection: ${key}`);

  const { columns } = await getTableColumns(key, database, table);
  const columnNames = columns.map((c) => c.name);

  let orderClause = '';
  if (sortCol && columnNames.includes(sortCol)) {
    orderClause = `ORDER BY ${esc(sortCol)} ${sortDir === 'desc' ? 'DESC' : 'ASC'}`;
  }
  const sql = `SELECT * FROM ${esc(database)}.${esc(table)} ${orderClause}`;

  const rawConn = createStreamingConnection(conn);

  await new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error('Download cancelled by the client'));
    res.write(columnNames.map(csvField).join(',') + '\r\n');

    const queryStream = rawConn.query(sql).stream({ highWaterMark: 200 });
    // If the browser cancels the download, 'drain' never comes; stop the
    // query instead of leaving the connection paused forever.
    const onClose = () => {
      if (!res.writableFinished) reject(new Error('Download cancelled by the client'));
    };
    res.on('close', onClose);
    queryStream.on('data', (row) => {
      const line = columnNames.map((c) => csvField(row[c])).join(',') + '\r\n';
      const ok = res.write(line);
      if (!ok) {
        queryStream.pause();
        res.once('drain', () => queryStream.resume());
      }
    });
    queryStream.on('end', () => { res.off('close', onClose); resolve(); });
    queryStream.on('error', reject);
  }).then(
    () => closeStreamingConnection(rawConn, false),
    (err) => { closeStreamingConnection(rawConn, true); throw err; }
  );
}

// Bulk-inserts a batch of already-parsed CSV rows (used by the CSV import
// UI, which streams+batches the file client-side so large files never hit
// the server as one giant payload).
async function insertRowsBulk(key, database, table, columns, rows) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('No columns specified');
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { affectedRows: 0 };
  }

  const pool = getPool(key);
  const nullable = await blankToNullColumns(key, database, table);
  const colClause = columns.map(esc).join(', ');
  const values = rows.map((r) => columns.map((c) => {
    const v = r[c];
    return v === undefined || v === CSV_NULL || (v === '' && nullable.has(c)) ? null : v;
  }));

  const [result] = await pool.query(
    `INSERT INTO ${esc(database)}.${esc(table)} (${colClause}) VALUES ?`,
    [values]
  );
  return { affectedRows: result.affectedRows };
}

async function truncateTable(key, database, table) {
  const pool = getPool(key);
  await pool.query(`TRUNCATE TABLE ${esc(database)}.${esc(table)}`);
  return { ok: true };
}

// ===================== tar/gzip helpers (no external dependency) =====================
// Minimal single/multi-entry USTAR tar reader/writer, built on Node's
// built-in `zlib` for gzip. Verified against the system `tar` command in
// both directions (writes it can extract, and extracting its own output).

function buildTarHeader(name, size, mtime = new Date()) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'utf8');
  buf.write('0000000\0', 108, 8, 'utf8');
  buf.write('0000000\0', 116, 8, 'utf8');
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  buf.write(Math.floor(mtime.getTime() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder while computing
  buf.write('0', 156, 1, 'utf8'); // typeflag: regular file
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += buf[i];
  buf.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

// Stateful tar reader: feed it raw (already gunzipped) bytes incrementally
// and it yields Buffer chunks of regular-file content only, in order,
// skipping headers/padding/directory entries. Handles a header split across
// feed() calls.
class TarExtractor {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.state = 'header';
    this.remainingContent = 0;
    this.remainingPadding = 0;
    this.zeroBlockCount = 0;
    this._isRegular = false;
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const output = [];
    while (true) {
      if (this.state === 'done') break;
      if (this.state === 'header') {
        if (this.buffer.length < 512) break;
        const header = this.buffer.subarray(0, 512);
        this.buffer = this.buffer.subarray(512);
        if (header.every((b) => b === 0)) {
          this.zeroBlockCount++;
          if (this.zeroBlockCount >= 2) { this.state = 'done'; break; }
          continue;
        }
        this.zeroBlockCount = 0;
        const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
        const size = sizeStr ? parseInt(sizeStr, 8) : 0;
        const typeflag = String.fromCharCode(header[156]);
        this._isRegular = (typeflag === '0' || typeflag === '\0');
        this.remainingContent = size;
        this.remainingPadding = (512 - (size % 512)) % 512;
        this.state = size > 0 ? 'content' : (this.remainingPadding > 0 ? 'padding' : 'header');
        continue;
      }
      if (this.state === 'content') {
        if (this.buffer.length === 0) break;
        const take = Math.min(this.buffer.length, this.remainingContent);
        const piece = this.buffer.subarray(0, take);
        this.buffer = this.buffer.subarray(take);
        this.remainingContent -= take;
        if (this._isRegular && take > 0) output.push(Buffer.from(piece));
        if (this.remainingContent === 0) this.state = this.remainingPadding > 0 ? 'padding' : 'header';
        else break; // need more data for this entry
        continue;
      }
      if (this.state === 'padding') {
        if (this.buffer.length < this.remainingPadding) break;
        this.buffer = this.buffer.subarray(this.remainingPadding);
        this.remainingPadding = 0;
        this.state = 'header';
        continue;
      }
    }
    return output;
  }
}

// ===================== Backup / Restore =====================

// Writes a full logical SQL dump (DROP + CREATE + batched INSERTs for every
// table) to a writable stream, table by table, row by row, so a large
// database can be dumped without holding it all in memory. `dest` just
// needs a `.write()` method — it's used for both the HTTP response and, for
// the tar.gz path below, a temp file.
async function streamDatabaseBackup(key, database, dest) {
  const conn = store.getConnection(key);
  if (!conn) throw new Error(`Unknown connection: ${key}`);

  const pool = getPool(key);
  const objects = await listTables(key, database);
  const tables = objects.filter((t) => !/VIEW/i.test(t.type || ''));
  const views = objects.filter((t) => /VIEW/i.test(t.type || ''));
  const BATCH_SIZE = 200;

  dest.write(`-- DB Console backup of \`${database}\`\n-- Generated ${new Date().toISOString()}\n\n`);
  dest.write('SET FOREIGN_KEY_CHECKS=0;\n\n');

  for (const t of tables) {
    const table = t.name;
    dest.write(`-- --------------------------------------------------\n`);
    dest.write(`-- Table: \`${table}\`\n-- --------------------------------------------------\n\n`);

    const [createRows] = await pool.query(`SHOW CREATE TABLE ${esc(database)}.${esc(table)}`);
    const createSql = createRows[0]['Create Table'];
    dest.write(`DROP TABLE IF EXISTS ${esc(table)};\n${createSql};\n\n`);

    const { columns } = await getTableColumns(key, database, table);
    const columnNames = columns.map((c) => c.name);
    const colClause = columnNames.map(esc).join(', ');

    const rawConn = createStreamingConnection(conn);
    await new Promise((resolve, reject) => {
      let batch = [];
      let wroteAnyRow = false;

      const queryStream = rawConn
        .query(`SELECT * FROM ${esc(database)}.${esc(table)}`)
        .stream({ highWaterMark: BATCH_SIZE });

      // Respects backpressure: if the destination (temp file) can't keep
      // up, pause the query instead of buffering the table in memory.
      const flush = () => {
        if (batch.length === 0) return;
        const valuesSql = batch
          .map((row) => '(' + columnNames.map((c) => sqlLiteral(row[c])).join(',') + ')')
          .join(',\n');
        const ok = dest.write(`INSERT INTO ${esc(table)} (${colClause}) VALUES\n${valuesSql};\n`);
        batch = [];
        if (!ok && dest.once) {
          queryStream.pause();
          dest.once('drain', () => queryStream.resume());
        }
      };

      queryStream.on('data', (row) => {
        wroteAnyRow = true;
        batch.push(row);
        if (batch.length >= BATCH_SIZE) {
          flush();
        }
      });
      queryStream.on('end', () => {
        flush();
        if (wroteAnyRow) dest.write('\n');
        resolve();
      });
      queryStream.on('error', reject);
    }).then(
      () => closeStreamingConnection(rawConn, false),
      (err) => { closeStreamingConnection(rawConn, true); throw err; }
    );
  }

  // Views go last since they depend on the tables above. Note: routines,
  // triggers and events are intentionally not included — their bodies
  // contain ';' and need DELIMITER handling, which the restore parser
  // doesn't do.
  for (const v of views) {
    const [rows] = await pool.query(`SHOW CREATE VIEW ${esc(database)}.${esc(v.name)}`);
    dest.write(`-- View: \`${v.name}\`\n`);
    dest.write(`DROP VIEW IF EXISTS ${esc(v.name)};\n${rows[0]['Create View']};\n\n`);
  }

  dest.write('SET FOREIGN_KEY_CHECKS=1;\n');
}

// Generates the SQL dump into a temp file first (so its exact byte size is
// known, which the tar format requires up front), then streams it out as a
// single-entry tar.gz to `res` without holding the dump in memory. The temp
// file is always cleaned up afterward.
async function streamDatabaseBackupTarGz(key, database, res) {
  const tmpFile = path.join(os.tmpdir(), `dbconsole-backup-${crypto.randomBytes(8).toString('hex')}.sql`);
  const fileStream = fs.createWriteStream(tmpFile);

  try {
    await streamDatabaseBackup(key, database, fileStream);
    await new Promise((resolve, reject) => {
      fileStream.end();
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    const { size } = await fs.promises.stat(tmpFile);
    const entryName = `${database}-backup.sql`;
    const header = buildTarHeader(entryName, size);
    const padLen = (512 - (size % 512)) % 512;

    const gzip = zlib.createGzip();
    gzip.pipe(res);

    await new Promise((resolve, reject) => {
      gzip.write(header);
      const readStream = fs.createReadStream(tmpFile);
      readStream.on('error', reject);
      readStream.pipe(gzip, { end: false });
      readStream.on('end', () => {
        if (padLen > 0) gzip.write(Buffer.alloc(padLen));
        gzip.write(Buffer.alloc(1024)); // two 512-byte zero blocks = end of archive
        gzip.end();
      });
      gzip.on('error', reject);
      res.on('finish', resolve);
      res.on('error', reject);
      // A cancelled download never emits 'finish'; settle anyway so the
      // temp file below is removed.
      res.on('close', () => {
        if (res.writableFinished) return resolve();
        readStream.destroy();
        gzip.destroy();
        reject(new Error('Download cancelled by the client'));
      });
    });
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// Executes a SQL dump against `database`, reading it incrementally from
// `readableStream` (e.g. the raw HTTP request body) so a very large file is
// never buffered whole. `format` is 'sql' or 'targz' — for 'targz' the
// stream is gunzipped and the tar container is stripped before its SQL
// content is fed to the statement splitter. Calls onProgress({executed,
// failed}) as it goes.
async function restoreDump(key, database, readableStream, format, onProgress) {
  const pool = getPool(key);
  const dbConn = await pool.getConnection();
  const splitter = new SqlStatementStream();
  const tarExtractor = format === 'targz' ? new TarExtractor() : null;
  // Decodes UTF-8 across chunk boundaries; Buffer#toString per chunk would
  // corrupt any multi-byte character split between two chunks.
  const decoder = new StringDecoder('utf8');
  let executed = 0;
  let failed = 0;
  const errors = [];

  const runStatement = async (stmt) => {
    try {
      await dbConn.query(stmt);
      executed++;
    } catch (err) {
      failed++;
      if (errors.length < 20) errors.push({ statement: stmt.slice(0, 200), error: err.message });
    }
  };

  const sourceStream = tarExtractor ? readableStream.pipe(zlib.createGunzip()) : readableStream;

  try {
    await dbConn.query(`USE ${esc(database)}`);

    for await (const chunk of sourceStream) {
      const textChunks = tarExtractor ? tarExtractor.feed(chunk) : [chunk];
      for (const tc of textChunks) {
        const statements = splitter.feed(decoder.write(tc));
        for (const stmt of statements) await runStatement(stmt);
      }
      if (onProgress) onProgress({ executed, failed });
    }
    const rest = splitter.feed(decoder.end()).concat(splitter.flush());
    for (const stmt of rest) await runStatement(stmt);
    if (onProgress) onProgress({ executed, failed });
  } finally {
    // The dump ran USE and SET statements (e.g. FOREIGN_KEY_CHECKS=0) on
    // this connection; never hand it back to the pool.
    dbConn.destroy();
  }

  return { executed, failed, errors };
}
