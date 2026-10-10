// db.js
// Builds/caches a mysql2 pool per connection defined in store.js.
// Pools are rebuilt automatically if a connection's settings change.

const mysql = require('mysql2/promise');
const mysqlUtil = require('mysql2'); // for safe identifier escaping (escapeId)
const store = require('./store');
const tunnel = require('./tunnel');
const permissions = require('./permissions');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const { Transform, pipeline } = require('stream');

// key -> { configStr, pool }
const poolCache = new Map();

// TLS options for mysql2 from the connection's sslMode / PEM fields.
function sslConfig(conn) {
  if (!conn.sslMode) return undefined;
  const ssl = { rejectUnauthorized: conn.sslMode === 'verify' };
  if (conn.sslCa) ssl.ca = conn.sslCa;
  if (conn.sslCert) ssl.cert = conn.sslCert;
  if (conn.sslKey) ssl.key = conn.sslKey;
  return ssl;
}

function poolConfig(conn) {
  return {
    ...(sslConfig(conn) ? { ssl: sslConfig(conn) } : {}),
    // Through an SSH tunnel the stream comes from the tunnel.
    ...(conn.sshHost ? { stream: () => tunnel.createStream(conn.key, conn) } : {}),
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
  if (conn.secretError) throw new Error(conn.secretError);

  // Only settings that affect the pool count; sharing/ownership changes don't.
  const configStr = JSON.stringify([poolConfig(conn), conn.sshHost, conn.sshPort, conn.sshUser, conn.sshPassword, conn.sshPrivateKey, conn.sshPassphrase, conn.sshHostKey]);
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
  tunnel.release(key);
}

async function closeAllPools() {
  const pools = [...poolCache.values()].map((c) => c.pool);
  const keys = [...poolCache.keys()];
  poolCache.clear();
  await Promise.allSettled(pools.map((p) => p.end()));
  keys.forEach((k) => tunnel.release(k));
}

// A dedicated (non-pool) connection for streaming a large result. It gets an
// 'error' listener: without one, a connection-level error (server gone
// away, or an error after we destroyed it because the client cancelled a
// download) would be thrown as an uncaught exception and kill the process.
// Query errors still reach the query stream's own 'error' handler.
function createStreamingConnection(conn) {
  // Exports read JSON columns as the stored text (jsonStrings): parsing and
  // re-serialising them would change their formatting (MariaDB keeps JSON
  // as text, so an export → import round trip must not touch it).
  const rawConn = mysqlUtil.createConnection({ ...poolConfig(conn), jsonStrings: true });
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
    // Changed by a mysql-client style "DELIMITER ;;" line, as written by
    // mysqldump (and our own backups) around procedures, triggers and
    // events, whose bodies contain ';'.
    this.delimiter = ';';
  }

  // Feed more text; returns an array of complete statements found so far.
  feed(chunk, final = false) {
    this.buffer += chunk;
    const statements = [];
    let stmtStart = 0;
    let i = this.pos;

    while (i < this.buffer.length) {
      const ch = this.buffer[i];
      const next = this.buffer[i + 1];
      // These characters need to see the next one (--, /*, */, '', "", \x);
      // if it hasn't arrived yet, wait for the next chunk.
      if (next === undefined && !final && (ch === '-' || ch === '/' || ch === '*' || ch === '\\' || ch === "'" || ch === '"')) break;

      if (this.inLineComment) {
        if (ch === '\n') this.inLineComment = false;
        i++; continue;
      }
      if (this.inBlockComment) {
        if (ch === '*' && next === '/') { i += 2; this.inBlockComment = false; continue; }
        i++; continue;
      }
      const inQuote = this.inSingle || this.inDouble || this.inBacktick;
      // "-- " (dash dash, then whitespace) and "#" start a comment that runs to the end of the line.
      // "--" without the space is not a comment in MySQL ("SELECT 5--3" is 8).
      if (!inQuote && ch === '-' && next === '-') {
        const third = this.buffer[i + 2];
        if (third === undefined && !final) break; // wait for the character after "--"
        if (third === undefined || /\s/.test(third)) { this.inLineComment = true; i += 2; continue; }
      }
      if (!inQuote && ch === '#') {
        this.inLineComment = true; i++; continue;
      }
      if (!inQuote && ch === '/' && next === '*') {
        this.inBlockComment = true; i += 2; continue;
      }
      // DELIMITER <x> on its own line, at the start of a statement.
      if (!inQuote && (ch === 'D' || ch === 'd') && /^\s*$/.test(stripLeadingComments(this.buffer.substring(stmtStart, i)))) {
        const nl = this.buffer.indexOf('\n', i);
        if (nl === -1 && !final) break; // wait for the rest of the line
        const line = this.buffer.substring(i, nl === -1 ? this.buffer.length : nl);
        const m = /^DELIMITER\s+(\S+)\s*$/i.exec(line.trimEnd());
        if (m) {
          this.delimiter = m[1];
          i = nl === -1 ? this.buffer.length : nl + 1;
          stmtStart = i;
          continue;
        }
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
      if (!inQuote && ch === this.delimiter[0]) {
        // A multi-character delimiter may be split across chunks.
        if (!final && i + this.delimiter.length > this.buffer.length && this.delimiter.startsWith(this.buffer.substring(i))) break;
        if (this.buffer.startsWith(this.delimiter, i)) {
          const stmt = this.buffer.substring(stmtStart, i).trim();
          if (stmt) statements.push(stmt);
          i += this.delimiter.length;
          stmtStart = i;
          continue;
        }
      }
      i++;
    }

    this.pos = i;
    this.buffer = this.buffer.substring(stmtStart);
    this.pos -= stmtStart;
    return statements;
  }

  // Call once the input is exhausted; returns the remaining statements,
  // including a trailing one that wasn't terminated by a delimiter.
  flush() {
    const statements = this.feed('', true);
    const stmt = this.buffer.trim();
    this.buffer = '';
    this.pos = 0;
    if (stmt && !/^\s*$/.test(stripLeadingComments(stmt))) statements.push(stmt);
    return statements;
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
// Most rows a single statement returns to the browser; the rest are
// counted but not sent (the Query Runner shows "first N of M").
const MAX_RESULT_ROWS = 10000;
const EXPLAINABLE_RE = /^(select|with|update|delete|insert|replace|table)\b/i;

// `allowed` is the Set of permissions the user has on this connection (see
// permissions.js), or null for no restrictions. A statement that needs a
// permission they lack is refused before anything runs. Statements that only
// read run inside a READ ONLY transaction, on a connection that is thrown
// away afterwards, so a stored function that writes, or a WITH … DELETE,
// still fails for a user who may not write.
async function runQuery(key, sqlText, { database, explain = false, allowed = null, track = null } = {}) {
  let statements = splitStatements(sqlText);
  if (statements.length === 0) {
    throw new Error('No SQL statement to execute');
  }
  // EXPLAIN mode runs EXPLAIN for each statement that can be explained and
  // never executes the others (so a USE or SET in the selection is skipped).
  if (explain) {
    statements = statements.filter((st) => EXPLAINABLE_RE.test(stripLeadingComments(st))).map((st) => `EXPLAIN ${st}`);
    if (!statements.length) throw new Error('Nothing to explain — EXPLAIN works on SELECT, UPDATE, DELETE, INSERT and REPLACE');
  }

  const restricted = Boolean(allowed);
  if (restricted) {
    const refused = statements.map((st) => ({ st, error: permissions.statementDenied(st, allowed) })).find((x) => x.error);
    if (refused) return { ok: false, statements: [{ sql: refused.st, ok: false, error: refused.error, durationMs: 0 }], currentDatabase: null };
  }
  const mayCallAnything = !restricted || allowed.has('sql');

  const pool = getPool(key);
  const defaultDb = store.getConnection(key).database;
  const conn = await pool.getConnection();
  if (track) track.thread(conn.connection.threadId);
  const results = [];
  let ok = true;
  let discard = restricted || statements.some(leavesSessionState);
  let currentDatabase = null;
  let workingDb = database || defaultDb; // the database in effect for the next statement (a USE changes it)

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
      if (track) track.statement(stmt);
      // For restricted users, a statement that only reads can't write by
      // accident (a function with side effects, a writing CTE).
      const guarded = restricted && !mayCallAnything && permissions.statementNeeds(stmt) === 'read' && !/^\s*use\b/i.test(stripLeadingComments(stmt));
      try {
        if (guarded) await conn.query('START TRANSACTION READ ONLY');
        let [rows, fields] = await conn.query(stmt).finally(() => (guarded ? conn.query('COMMIT').catch(() => {}) : null));
        const durationMs = Date.now() - start;
        // CALL returns several result sets; show the first one.
        if (Array.isArray(rows) && Array.isArray(rows[0])) {
          rows = rows[0];
          fields = Array.isArray(fields) ? fields[0] : fields;
        }

        let entry;
        if (Array.isArray(rows)) {
          const total = rows.length;
          entry = {
            sql: stmt,
            ok: true,
            type: 'rows',
            columns: fields ? fields.map((f) => f.name) : [],
            rows: encodeRows(total > MAX_RESULT_ROWS ? rows.slice(0, MAX_RESULT_ROWS) : rows),
            rowCount: total,
            truncated: total > MAX_RESULT_ROWS,
            durationMs
          };
        } else {
          entry = {
            sql: stmt,
            ok: true,
            type: 'result',
            affectedRows: rows.affectedRows,
            insertId: rows.insertId,
            changedRows: rows.changedRows,
            warningStatus: rows.warningStatus,
            durationMs
          };
          if (rows.warningStatus > 0) {
            const [warnings] = await conn.query('SHOW WARNINGS LIMIT 20');
            entry.warnings = warnings.map((w) => ({ level: w.Level, code: w.Code, message: w.Message }));
          }
        }
        entry.database = workingDb; // so a download re-runs it in the same database
        results.push(entry);
        if (/^use\b/i.test(stripLeadingComments(stmt))) {
          const [[cur]] = await conn.query('SELECT DATABASE() AS db');
          workingDb = cur.db;
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
    if (track) track.done(); // before the connection can be handed to someone else
    // destroy() closes the connection, which also rolls back any
    // transaction left open; the pool opens a fresh one when needed.
    if (discard) conn.destroy();
    else conn.release();
  }

  return { ok, statements: results, currentDatabase };
}

// KILL QUERY for a thread, but only while it is still running the statement
// that starts with `sqlStart`: pooled connections are reused, and the thread
// may meanwhile belong to another user's query. Returns 1 if it was stopped.
async function killQuery(key, thread, sqlStart) {
  const n = Number(thread);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid thread id');
  const pool = getPool(key);
  const [rows] = await pool.query('SELECT INFO FROM information_schema.PROCESSLIST WHERE ID = ? AND COMMAND = ?', [n, 'Query']);
  const info = rows[0] && rows[0].INFO;
  if (!info || !sqlStart || !String(info).startsWith(String(sqlStart).slice(0, 100))) return 0;
  await pool.query(`KILL QUERY ${n}`);
  return 1;
}

// Test an arbitrary connection config (used for "Test connection" in the UI,
// both for unsaved forms and for existing saved connections).
async function testConnection(saved) {
  // A throwaway tunnel key, so testing never tears down the live tunnel of a saved connection.
  const conn = { ...saved, key: 'test:' + crypto.randomBytes(6).toString('hex') };
  let connection;
  try {
    connection = await mysql.createConnection(poolConfig(conn));
    await connection.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (connection) await connection.end().catch(() => {});
    if (conn.sshHost) tunnel.release(conn.key);
  }
}

module.exports = {
  bulkUpdate,
  getPool,
  dropPool,
  closeAllPools,
  splitStatements,
  SqlStatementStream,
  runQuery,
  killQuery,
  testConnection,
  listDatabases,
  listTables,
  listObjects,
  getTableIndexes,
  alterIndex,
  getObjectDefinition,
  getTableColumns,
  getCellValue,
  browseTable,
  updateRow,
  deleteRow,
  insertRow,
  streamTableCsv,
  insertRowsBulk,
  truncateTable,
  streamDatabaseBackup,
  streamDatabaseBackupTarGz,
  exportDatabase,
  exportQueryResult,
  stripTrailingLimit,
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
    `SELECT TABLE_NAME AS name, TABLE_ROWS AS approxRows, ENGINE AS engine, TABLE_TYPE AS type,
            DATA_LENGTH AS dataLength, INDEX_LENGTH AS indexLength, AUTO_INCREMENT AS autoIncrement,
            TABLE_COLLATION AS collation, TABLE_COMMENT AS comment, UPDATE_TIME AS updateTime
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
      kind: indexKind(idx),
      columns: parts.map((p) => (p.subPart ? `${p.column}(${p.subPart})` : p.column)),
      // For the index editor: column + optional prefix length.
      parts: parts.map((p) => ({ column: p.column, length: p.subPart ? Number(p.subPart) : null })),
      cardinality: parts.length ? parts[parts.length - 1].cardinality : null
    };
  });
}

function indexKind(idx) {
  if (idx.primary) return 'PRIMARY';
  if (idx.type === 'FULLTEXT') return 'FULLTEXT';
  if (idx.type === 'SPATIAL') return 'SPATIAL';
  return idx.unique ? 'UNIQUE' : 'INDEX';
}

const INDEX_KINDS = ['PRIMARY', 'UNIQUE', 'INDEX', 'FULLTEXT', 'SPATIAL'];

// Builds (and unless `preview`, runs) one ALTER TABLE that drops and/or adds
// an index, Adminer-style. Editing an index = drop the old one and add the
// new definition in the same statement, so it applies all-or-nothing.
//   drop: name of an existing index ('PRIMARY' for the primary key)
//   add:  { kind, name, columns: [{ column, length }] }
async function alterIndex(key, database, table, { drop, add, preview } = {}) {
  if (!drop && !add) throw new Error('Nothing to change');
  const clauses = [];

  if (drop) {
    const existing = (await getTableIndexes(key, database, table)).find((i) => i.name === drop);
    if (!existing) throw new Error(`Index not found: ${drop}`);
    clauses.push(existing.primary ? 'DROP PRIMARY KEY' : `DROP INDEX ${esc(drop)}`);
  }

  if (add) {
    const kind = String(add.kind || 'INDEX').toUpperCase();
    if (!INDEX_KINDS.includes(kind)) throw new Error(`Unsupported index type: ${add.kind}`);
    const name = String(add.name || '').trim();
    if (name.length > 64) throw new Error('Index name is longer than 64 characters');
    if (kind !== 'PRIMARY' && name.toUpperCase() === 'PRIMARY') throw new Error('PRIMARY is reserved for the primary key');

    const tableCols = new Set((await getTableColumns(key, database, table)).columns.map((c) => c.name));
    const parts = (Array.isArray(add.columns) ? add.columns : []).filter((p) => p && p.column);
    if (parts.length === 0) throw new Error('Choose at least one column');
    const seen = new Set();
    const partSql = parts.map((p) => {
      if (!tableCols.has(p.column)) throw new Error(`Unknown column: ${p.column}`);
      if (seen.has(p.column)) throw new Error(`Column used twice: ${p.column}`);
      seen.add(p.column);
      let sql = esc(p.column);
      if (p.length !== undefined && p.length !== null && p.length !== '') {
        const len = Number(p.length);
        if (!Number.isInteger(len) || len < 1 || len > 3072) throw new Error(`Invalid length for ${p.column}`);
        if (kind === 'FULLTEXT' || kind === 'SPATIAL') throw new Error(`${kind} indexes don't take a column length`);
        sql += `(${len})`;
      }
      return sql;
    }).join(', ');

    const named = name ? ` ${esc(name)}` : '';
    clauses.push({
      PRIMARY: `ADD PRIMARY KEY (${partSql})`,
      UNIQUE: `ADD UNIQUE INDEX${named} (${partSql})`,
      INDEX: `ADD INDEX${named} (${partSql})`,
      FULLTEXT: `ADD FULLTEXT INDEX${named} (${partSql})`,
      SPATIAL: `ADD SPATIAL INDEX${named} (${partSql})`
    }[kind]);
  }

  const sql = `ALTER TABLE ${esc(database)}.${esc(table)} ${clauses.join(', ')}`;
  if (preview) return { sql };
  await getPool(key).query(sql);
  return { sql, ok: true };
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

// ---- Row filters (Explore search / filter bar) ----
// filters: [{ col, op, value }], combined with AND. col '*' = any column
// (matches if any column matches). Columns are checked against the table
// and operators against this list; values are always bound as parameters.
const FILTER_OPS = {
  '=': (c) => `${c} = ?`,
  '!=': (c) => `${c} <> ?`,
  '<': (c) => `${c} < ?`,
  '<=': (c) => `${c} <= ?`,
  '>': (c) => `${c} > ?`,
  '>=': (c) => `${c} >= ?`,
  contains: (c) => `${c} LIKE ?`,
  'not contains': (c) => `${c} NOT LIKE ?`,
  starts: (c) => `${c} LIKE ?`,
  ends: (c) => `${c} LIKE ?`,
  LIKE: (c) => `${c} LIKE ?`,
  'NOT LIKE': (c) => `${c} NOT LIKE ?`,
  REGEXP: (c) => `${c} REGEXP ?`,
  IN: (c) => `${c} IN (?)`,
  'NOT IN': (c) => `${c} NOT IN (?)`,
  'IS NULL': (c) => `${c} IS NULL`,
  'IS NOT NULL': (c) => `${c} IS NOT NULL`
};
const NO_VALUE_OPS = new Set(['IS NULL', 'IS NOT NULL']);

function escapeLike(v) {
  return String(v).replace(/[\\%_]/g, (m) => '\\' + m);
}

function filterParam(op, value) {
  if (op === 'contains' || op === 'not contains') return `%${escapeLike(value)}%`;
  if (op === 'starts') return `${escapeLike(value)}%`;
  if (op === 'ends') return `%${escapeLike(value)}`;
  if (op === 'IN' || op === 'NOT IN') {
    const list = String(value).split(',').map((x) => x.trim()).filter((x) => x !== '');
    if (list.length === 0) throw new Error(`${op} needs a comma-separated list of values`);
    return list;
  }
  return value;
}

function buildWhere(filters, columnNames) {
  if (!Array.isArray(filters) || filters.length === 0) return { where: '', params: [] };
  const conds = [];
  const params = [];
  for (const f of filters) {
    if (!f || !FILTER_OPS[f.op]) throw new Error(`Unsupported filter operator: ${f && f.op}`);
    const needsValue = !NO_VALUE_OPS.has(f.op);
    if (needsValue && (f.value === undefined || f.value === null)) continue;
    const anyColumn = f.col === '*';
    const cols = anyColumn ? columnNames : [f.col];
    if (!anyColumn && !columnNames.includes(f.col)) throw new Error(`Unknown column: ${f.col}`);
    // "Any column" with a negative operator means no column matches; a NULL
    // column doesn't contain/equal the value either (in SQL it would be
    // unknown and drop the whole row).
    const negative = ['!=', 'not contains', 'NOT LIKE', 'NOT IN', 'IS NOT NULL'].includes(f.op);
    const parts = cols.map((c) => {
      if (needsValue) params.push(filterParam(f.op, f.value));
      const cond = FILTER_OPS[f.op](esc(c));
      return anyColumn && negative && needsValue ? `(${cond} OR ${esc(c)} IS NULL)` : cond;
    });
    conds.push(parts.length === 1 ? parts[0] : `(${parts.join(negative ? ' AND ' : ' OR ')})`);
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

// ORDER BY for [{ col, dir }] (or a single sortCol/sortDir); unknown columns are ignored.
function orderBy(columnNames, sort, sortCol, sortDir) {
  const list = Array.isArray(sort) && sort.length ? sort : (sortCol ? [{ col: sortCol, dir: sortDir }] : []);
  const parts = list
    .filter((s) => s && columnNames.includes(s.col))
    .map((s) => `${esc(s.col)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`);
  return parts.length ? `ORDER BY ${parts.join(', ')}` : '';
}

async function browseTable(key, database, table, { page = 1, pageSize = 50, sortCol, sortDir, sort, filters } = {}) {
  const pool = getPool(key);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safePageSize;

  const { columns } = await getTableColumns(key, database, table);
  const columnNames = columns.map((c) => c.name);

  const orderClause = orderBy(columnNames, sort, sortCol, sortDir);
  const { where, params } = buildWhere(filters, columnNames);

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ${esc(database)}.${esc(table)} ${where}`,
    params
  );
  const total = countRows[0].cnt;

  const [rows, fields] = await pool.query(
    `SELECT * FROM ${esc(database)}.${esc(table)} ${where} ${orderClause} LIMIT ? OFFSET ?`,
    [...params, safePageSize, offset]
  );

  return {
    columns: fields ? fields.map((f) => f.name) : columnNames,
    rows: encodeRows(rows),
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

// ---- Values that can't travel as plain JSON ----
// Binary values go to the browser as { __hex } when small (so e.g. a
// BINARY(16) key can be sent back in a WHERE) or { __blob, size } when
// large. From the browser, a value may be { __hex } / { __base64 } (binary)
// or { __fn, arg } (one of VALUE_FUNCTIONS, Adminer-style).
const HEX_INLINE_MAX = 64;

function encodeValue(v) {
  if (!Buffer.isBuffer(v)) return v;
  return v.length <= HEX_INLINE_MAX ? { __hex: v.toString('hex') } : { __blob: true, size: v.length };
}

function encodeRows(rows) {
  for (const r of rows) for (const k of Object.keys(r)) if (Buffer.isBuffer(r[k])) r[k] = encodeValue(r[k]);
  return rows;
}

const VALUE_FUNCTIONS = {
  NOW: 'NOW()', CURDATE: 'CURDATE()', CURTIME: 'CURTIME()', UTC_TIMESTAMP: 'UTC_TIMESTAMP()',
  UNIX_TIMESTAMP: 'UNIX_TIMESTAMP()', UUID: 'UUID()',
  MD5: 'MD5(?)', SHA1: 'SHA1(?)', SHA2: 'SHA2(?, 256)', UPPER: 'UPPER(?)', LOWER: 'LOWER(?)', TRIM: 'TRIM(?)'
};

// SQL ("?" or a function call) and parameters for one value.
function valueSql(v) {
  if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
    if (v.__hex !== undefined) return { sql: '?', params: [Buffer.from(String(v.__hex), 'hex')] };
    if (v.__base64 !== undefined) return { sql: '?', params: [Buffer.from(String(v.__base64), 'base64')] };
    if (v.__fn !== undefined) {
      const tpl = VALUE_FUNCTIONS[v.__fn];
      if (!tpl) throw new Error(`Unsupported function: ${v.__fn}`);
      return { sql: tpl, params: tpl.includes('?') ? [v.arg ?? ''] : [] };
    }
    if (v.__blob) throw new Error("A large binary value can't be sent back as-is — upload a file to replace it");
    return { sql: '?', params: [JSON.stringify(v)] }; // a JSON column value
  }
  return { sql: '?', params: [v] };
}

function assignments(obj, params, joiner) {
  return Object.entries(obj).map(([c, v]) => {
    const x = valueSql(v);
    params.push(...x.params);
    return `${esc(c)} = ${x.sql}`;
  }).join(joiner);
}

// Raw value of one cell (for downloading a binary value).
async function getCellValue(key, database, table, where, column) {
  const { columns } = await getTableColumns(key, database, table);
  if (!columns.some((c) => c.name === column)) throw new Error(`Unknown column: ${column}`);
  if (!where || !Object.keys(where).length) throw new Error('Missing row identifier');
  const params = [];
  const whereClause = assignments(where, params, ' AND ');
  const [rows] = await getPool(key).query(
    `SELECT ${esc(column)} AS v FROM ${esc(database)}.${esc(table)} WHERE ${whereClause} LIMIT 1`, params
  );
  if (!rows.length) throw new Error('Row not found');
  return rows[0].v;
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
  const params = [];
  const setClause = assignments(changes, params, ', ');
  const whereClause = assignments(where, params, ' AND ');

  const [result] = await pool.query(
    `UPDATE ${esc(database)}.${esc(table)} SET ${setClause} WHERE ${whereClause} LIMIT 1`,
    params
  );
  return { affectedRows: result.affectedRows };
}

// ---- Bulk edit ----
// changes: { column: { mode, value, fn, arg, find, replace } }, where mode is
//   value    set to value (same encodings as a row edit: __hex, __base64, JSON)
//   null     set to NULL
//   default  set to the column's DEFAULT
//   fn       one of VALUE_FUNCTIONS (fn, arg)
//   add      add a number (negative to subtract)
//   replace  replace text find → replace inside the value
//   prepend / append  add text before / after the value
// Target either the selected rows (rows: [primary-key objects], at most
// BULK_MAX_ROWS) or every row matching the filters (all: true, filters).
const BULK_MAX_ROWS = 1000;

function bulkSet(column, change, params) {
  const c = esc(column);
  const mode = change && change.mode;
  switch (mode) {
    case 'value': { const x = valueSql(change.value); params.push(...x.params); return `${c} = ${x.sql}`; }
    case 'null': return `${c} = NULL`;
    case 'default': return `${c} = DEFAULT`;
    case 'fn': { const x = valueSql({ __fn: change.fn, arg: change.arg }); params.push(...x.params); return `${c} = ${x.sql}`; }
    case 'add': {
      const n = Number(change.value);
      if (change.value === '' || change.value === null || !Number.isFinite(n)) throw new Error(`Enter a number to add to ${column}`);
      params.push(n); return `${c} = ${c} + ?`;
    }
    case 'replace':
      if (!change.find) throw new Error(`Enter the text to find in ${column}`);
      params.push(String(change.find), String(change.replace ?? '')); return `${c} = REPLACE(${c}, ?, ?)`;
    case 'prepend': params.push(String(change.value ?? '')); return `${c} = CONCAT(?, ${c})`;
    case 'append': params.push(String(change.value ?? '')); return `${c} = CONCAT(${c}, ?)`;
    default: throw new Error(`Unknown change for ${column}: ${mode}`);
  }
}

async function bulkUpdate(key, database, table, { rows, all, filters, changes, preview } = {}) {
  const { columns, primaryKey } = await getTableColumns(key, database, table);
  const names = columns.map((c) => c.name);
  const entries = Object.entries(changes || {});
  if (!entries.length) throw new Error('Choose at least one column to change');
  entries.forEach(([col]) => { if (!names.includes(col)) throw new Error(`Unknown column: ${col}`); });

  const setParams = [];
  const nullable = await blankToNullColumns(key, database, table);
  const setClause = entries.map(([col, ch]) => {
    const change = ch && ch.mode === 'value' && ch.value === '' && nullable.has(col) ? { mode: 'null' } : ch;
    return bulkSet(col, change, setParams);
  }).join(', ');

  let where; let whereParams = [];
  if (all) {
    ({ where, params: whereParams } = buildWhere(filters, names));
  } else {
    if (!Array.isArray(rows) || !rows.length) throw new Error('Select at least one row');
    if (rows.length > BULK_MAX_ROWS) throw new Error(`Select at most ${BULK_MAX_ROWS} rows, or edit all rows matching the filters`);
    if (!primaryKey.length) throw new Error('This table has no primary key, so rows cannot be picked one by one');
    const conds = rows.map((r) => {
      if (!r || primaryKey.some((k) => r[k] === undefined || r[k] === null)) throw new Error('Missing row identifier (no primary key values supplied)');
      const pk = Object.fromEntries(primaryKey.map((k) => [k, r[k]]));
      return `(${assignments(pk, whereParams, ' AND ')})`;
    });
    where = `WHERE ${conds.join(' OR ')}`;
  }

  const target = `${esc(database)}.${esc(table)}`;
  const [[{ cnt }]] = await getPool(key).query(`SELECT COUNT(*) AS cnt FROM ${target} ${where}`, whereParams);
  const sqlText = `UPDATE ${target} SET ${setClause} ${where}`.trim();
  const params = [...setParams, ...whereParams];
  const shown = mysqlUtil.format(sqlText, params);
  const sql = shown.length > 4000 ? `${shown.slice(0, 4000)} …` : shown;
  if (preview) return { sql, matched: Number(cnt) };

  const conn = await getPool(key).getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(sqlText, params);
    await conn.commit();
    return { sql, matched: Number(cnt), affectedRows: result.affectedRows, changedRows: result.changedRows };
  } catch (err) {
    await conn.rollback().catch(() => {});
    err.sql = sql;
    throw err;
  } finally {
    conn.release();
  }
}

async function deleteRow(key, database, table, where) {
  if (!where || Object.keys(where).length === 0) {
    throw new Error('Missing row identifier (no primary key values supplied)');
  }

  const pool = getPool(key);
  const params = [];
  const whereClause = assignments(where, params, ' AND ');

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
  const params = [];
  const placeholders = cols.map((c) => {
    const x = valueSql(values[c]);
    params.push(...x.params);
    return x.sql;
  }).join(', ');

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

// TSV: tab-separated, one row per line; tab/newline/backslash escaped,
// NULL as \N (the MySQL LOAD DATA convention).
function tsvField(value) {
  if (value === null || value === undefined) return '\\N';
  if (value instanceof Date) value = value.toISOString();
  else if (Buffer.isBuffer(value)) value = value.toString('base64');
  else if (isJsonValue(value)) value = JSON.stringify(value);
  return String(value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function csvField(value) {
  if (value === null || value === undefined) return CSV_NULL;
  if (value instanceof Date) value = value.toISOString();
  else if (Buffer.isBuffer(value)) value = value.toString('base64');
  else if (isJsonValue(value)) value = JSON.stringify(value);
  const str = String(value);
  // A real "\N" text value is quoted so it isn't read back as NULL.
  return /[",\n\r]/.test(str) || str === CSV_NULL ? '"' + str.replace(/"/g, '""') + '"' : str;
}

// Streams a table's full contents (no LIMIT) to `res` as CSV, one row at a
// time, so exporting a very large table doesn't buffer it all in memory.
async function streamTableCsv(key, database, table, res, { sortCol, sortDir, sort, filters, format = 'csv' } = {}) {
  const field = format === 'tsv' ? tsvField : csvField;
  const sep = format === 'tsv' ? '\t' : ',';
  const eol = format === 'tsv' ? '\n' : '\r\n';
  const conn = store.getConnection(key);
  if (!conn) throw new Error(`Unknown connection: ${key}`);

  const { columns } = await getTableColumns(key, database, table);
  const columnNames = columns.map((c) => c.name);

  const orderClause = orderBy(columnNames, sort, sortCol, sortDir);
  const { where, params } = buildWhere(filters, columnNames);
  const sql = `SELECT * FROM ${esc(database)}.${esc(table)} ${where} ${orderClause}`;

  const rawConn = createStreamingConnection(conn);

  await new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error('Download cancelled by the client'));
    res.write(columnNames.map(field).join(sep) + eol);

    const queryStream = rawConn.query(sql, params).stream({ highWaterMark: 200 });
    // If the browser cancels the download, 'drain' never comes; stop the
    // query instead of leaving the connection paused forever.
    const onClose = () => {
      if (!res.writableFinished) reject(new Error('Download cancelled by the client'));
    };
    res.on('close', onClose);
    queryStream.on('data', (row) => {
      const line = columnNames.map((c) => field(row[c])).join(sep) + eol;
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

// ---- Download the full result of a Query Runner statement ----
// The Query Runner shows at most MAX_RESULT_ROWS rows, but a download should
// contain every row. The statement is run again on its own streaming
// connection and its rows go straight into the response, one at a time, so
// a result of lakhs or millions of rows needs no memory and has no limit.

// Removes a trailing `LIMIT n`, `LIMIT n OFFSET m` or `LIMIT m, n` from a
// SELECT, so the download covers every row instead of the preview.
const TRAILING_LIMIT_RE = /\s+limit\s+(\d+\s*,\s*\d+|\d+(\s+offset\s+\d+)?)\s*$/i;
function stripTrailingLimit(sql) {
  const trimmed = String(sql).replace(/[\s;]+$/, '');
  return TRAILING_LIMIT_RE.test(trimmed) ? trimmed.replace(TRAILING_LIMIT_RE, '') : String(sql);
}

function rawQuery(rawConn, sql) {
  return new Promise((resolve, reject) => rawConn.query(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
}

const EXPORTABLE_RE = /^(select|with|table|values|show|describe|desc|explain)\b/i;

// options: { database, format: 'csv'|'tsv', gzip, bom, nulls: 'empty'|'null'|'\\N', stripLimit, maxRows (0 = all), allowed }
// Resolves with { rows, stripped, truncated }. Errors found before the first
// byte is written (not a SELECT, not allowed, a SQL error) reject before
// onStart(filename, contentType) is called, so the caller can still answer
// with a normal error.
async function exportQueryResult(key, sqlText, options, res, onStart) {
  const o = { format: 'csv', gzip: false, bom: true, nulls: 'empty', stripLimit: false, maxRows: 0, database: null, allowed: null, ...options };
  const statements = splitStatements(sqlText);
  if (statements.length !== 1) throw new Error('Choose one statement to download');
  let stmt = statements[0];
  if (permissions.statementNeeds(stmt) !== 'read' || !EXPORTABLE_RE.test(stripLeadingComments(stmt))) {
    throw new Error('Only statements that return rows (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) can be downloaded');
  }
  const denied = permissions.statementDenied(stmt, o.allowed);
  if (denied) throw new Error(denied);
  // A download is for reading rows; INTO OUTFILE would write a file on the database server instead.
  if (/\binto\s+(outfile|dumpfile)\b/i.test(stmt)) throw new Error('SELECT … INTO OUTFILE/DUMPFILE writes a file on the server and can’t be downloaded');
  let stripped = false;
  if (o.stripLimit && /^(select|with|table|values)\b/i.test(stripLeadingComments(stmt))) {
    const without = stripTrailingLimit(stmt);
    stripped = without !== stmt;
    stmt = without;
  }
  const conn = store.getConnection(key);
  if (!conn) throw new Error(`Unknown connection: ${key}`);

  const tsv = o.format === 'tsv';
  const sep = tsv ? '\t' : ',';
  const eol = tsv ? '\n' : '\r\n';
  const nullText = o.nulls === 'null' ? 'NULL' : o.nulls === '\\N' ? '\\N' : '';
  // csvField/tsvField write NULL as \N and binary as Base64; NULL is replaced by the chosen text here.
  const field = tsv ? tsvField : csvField;
  const cell = (v) => (v === null || v === undefined ? nullText : field(v));

  const maxRows = Math.max(0, Number(o.maxRows) || 0);
  const rawConn = createStreamingConnection(conn);
  let failed = true;
  let killed = false; // the connection was already destroyed (row limit reached)
  let gzip = null;
  try {
    if (o.database && o.database !== conn.database) await rawQuery(rawConn, `USE ${esc(o.database)}`);
    // Whatever the statement calls (a function with side effects), a download never writes.
    await rawQuery(rawConn, 'START TRANSACTION READ ONLY');

    const query = rawConn.query({ sql: stmt, rowsAsArray: true });
    const stream = query.stream({ highWaterMark: 200 });
    // Wait for the column list before sending anything, so a SQL error is still a normal error response.
    const fields = await new Promise((resolve, reject) => {
      const onFields = (f) => { stream.off('error', onError); stream.off('end', onEnd); if (Array.isArray(f)) resolve(f); else reject(new Error('That statement did not return a result set')); };
      const onError = (err) => { query.off('fields', onFields); stream.off('end', onEnd); reject(err); };
      const onEnd = () => { query.off('fields', onFields); stream.off('error', onError); reject(new Error('That statement did not return a result set')); };
      query.once('fields', onFields);
      stream.once('error', onError);
      stream.once('end', onEnd);
    });

    const ext = `${tsv ? 'tsv' : 'csv'}${o.gzip ? '.gz' : ''}`;
    onStart(`query-result-${fileStamp()}.${ext}`, o.gzip ? 'application/gzip' : (tsv ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8'));
    let out = res;
    if (o.gzip) { gzip = zlib.createGzip(); gzip.pipe(res); out = gzip; }

    const count = await new Promise((resolve, reject) => {
      let rows = 0;
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        res.off('close', onClose);
        if (err) reject(err); else resolve(rows);
      };
      const onClose = () => { if (!res.writableFinished) finish(new Error('Download cancelled by the client')); };
      res.on('close', onClose);
      if (res.destroyed) return finish(new Error('Download cancelled by the client'));

      out.write((o.bom && !tsv ? '\uFEFF' : '') + fields.map((f) => cell(f.name)).join(sep) + eol);
      stream.on('data', (row) => {
        if (done) return;
        rows++;
        const ok = out.write(row.map(cell).join(sep) + eol);
        if (maxRows && rows >= maxRows) {
          // Enough rows: stop the query on the server and finish the file.
          stream.pause();
          killed = true;
          closeStreamingConnection(rawConn, true);
          return finish(null);
        }
        if (!ok) {
          stream.pause();
          out.once('drain', () => stream.resume());
        }
      });
      stream.on('end', () => finish(null));
      stream.on('error', finish);
    });
    failed = false;

    // Finish the (compressed) file.
    await new Promise((resolve) => {
      if (gzip) { res.once('finish', resolve); res.once('close', resolve); gzip.end(); } else { res.end(resolve); }
    });
    return { rows: count, stripped, truncated: Boolean(maxRows && count >= maxRows) };
  } finally {
    if (gzip && failed) gzip.destroy();
    if (!killed) closeStreamingConnection(rawConn, failed);
  }
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
// Removes DEFINER=`user`@`host` so a dump can be restored by a user who
// isn't (or can't impersonate) the original definer.
function stripDefiner(sql) {
  return String(sql).replace(/\s*DEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+)@(`[^`]*`|'[^']*'|\S+)/i, '');
}

function writeWithDelimiter(dest, sql) {
  dest.write(`DELIMITER ;;\n${sql};;\nDELIMITER ;\n\n`);
}

// Promise wrapper for a query on a raw (callback) connection.
function rawQuery(rawConn, sql, params) {
  return new Promise((resolve, reject) => rawConn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

// Writes to a stream and waits for 'drain' when its buffer is full, so a
// slow download never makes the dump pile up in memory. Rejects if the
// destination is closed (a cancelled download) while waiting.
function writeAndWait(dest, text) {
  if (dest.write(text) || !dest.once) return null;
  return new Promise((resolve, reject) => {
    const onDrain = () => { dest.off('close', onClose); resolve(); };
    const onClose = () => { dest.off('drain', onDrain); reject(new Error('Download cancelled by the client')); };
    dest.once('drain', onDrain);
    dest.once('close', onClose);
  });
}

const INSERT_MODES = {
  insert: 'INSERT INTO',
  ignore: 'INSERT IGNORE INTO',
  replace: 'REPLACE INTO',
  update: 'INSERT INTO' // + ON DUPLICATE KEY UPDATE
};
// One INSERT statement is flushed at this many bytes even if rowsPerInsert
// isn't reached, so rows with large values never make a statement bigger
// than the restoring server's max_allowed_packet (4 MB by default on old
// MySQL versions, 16–64 MB on newer ones).
const DUMP_STATEMENT_MAX_BYTES = 1024 * 1024;

// Writes an SQL dump of `database` to `dest` (a writable stream).
// Options (all optional; the defaults make a full backup):
//   tables:         names to include (default: all tables and views)
//   structure:      'drop-create' | 'create' | 'create-if-not-exists' | 'none'
//   data:           include the rows (default true)
//   insertMode:     'insert' | 'ignore' | 'replace' | 'update' (ON DUPLICATE KEY UPDATE)
//   rowsPerInsert:  rows per INSERT statement (1–10000, default 500; also capped at ~1 MB)
//   truncate:       TRUNCATE each table before its rows (useful for data-only dumps)
//   createDatabase: start with CREATE DATABASE IF NOT EXISTS + USE
//   singleTransaction: read all tables in one consistent snapshot (default true)
//   views, routines, triggers, events: include those objects (default true;
//                   ignored when structure is 'none')
// Like mysqldump, the dump sets FOREIGN_KEY_CHECKS=0, UNIQUE_CHECKS=0,
// SQL_MODE=NO_AUTO_VALUE_ON_ZERO and TIME_ZONE='+00:00' (TIMESTAMP values are
// read in UTC, so they restore unchanged on a server in another time zone)
// and puts the previous values back at the end. Procedures, functions,
// triggers and events are written between DELIMITER lines.
async function streamDatabaseBackup(key, database, dest, opts = {}) {
  const conn = store.getConnection(key);
  if (!conn) throw new Error(`Unknown connection: ${key}`);
  const o = {
    structure: 'drop-create', data: true, views: true, routines: true, triggers: true, events: true,
    insertMode: 'insert', rowsPerInsert: 500, truncate: false, createDatabase: false, singleTransaction: true,
    ...opts
  };
  if (!['drop-create', 'create', 'create-if-not-exists', 'none'].includes(o.structure)) throw new Error(`Unknown structure option: ${o.structure}`);
  if (!INSERT_MODES[o.insertMode]) throw new Error(`Unknown insert mode: ${o.insertMode}`);
  const rowsPerInsert = Math.min(Math.max(Number(o.rowsPerInsert) || 500, 1), 10000);
  const withStructure = o.structure !== 'none';

  const pool = getPool(key);
  // Definitions are read with the dumped database selected: SHOW CREATE VIEW
  // otherwise names every table with its database (`src`.`t`), and the dump
  // couldn't be restored into a different database. This connection's
  // default database changes, so it's discarded at the end.
  const meta = await pool.getConnection();
  // Rows are read on one dedicated streaming connection, in a single
  // consistent snapshot (like mysqldump --single-transaction): every table is
  // dumped as it was at the same moment, without locking anything (InnoDB).
  const rawConn = o.data ? createStreamingConnection(conn) : null;
  let failed = false;
  try {
    await meta.query(`USE ${esc(database)}`);
    if (rawConn) {
      await rawQuery(rawConn, "SET SESSION time_zone = '+00:00'");
      if (o.singleTransaction) {
        await rawQuery(rawConn, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await rawQuery(rawConn, 'START TRANSACTION WITH CONSISTENT SNAPSHOT');
      }
    }
    const objects = await listTables(key, database);
    const wanted = Array.isArray(o.tables) && o.tables.length ? new Set(o.tables) : null;
    const included = objects.filter((t) => !wanted || wanted.has(t.name));
    const tables = included.filter((t) => !/VIEW/i.test(t.type || ''));
    const views = withStructure && o.views ? included.filter((t) => /VIEW/i.test(t.type || '')) : [];
    const section = (title) => writeAndWait(dest, `-- --------------------------------------------------\n-- ${title}\n-- --------------------------------------------------\n\n`);

    const what = [withStructure && 'structure', o.data && 'data'].filter(Boolean).join(' + ') || 'objects';
    await writeAndWait(dest, [
      `-- DB Console dump of \`${database}\` (${what})`,
      `-- Generated ${new Date().toISOString()}${o.data && o.singleTransaction ? ', consistent snapshot' : ''}`,
      '',
      'SET NAMES utf8mb4;',
      'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;',
      'SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;',
      "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';",
      "SET @OLD_TIME_ZONE=@@TIME_ZONE, TIME_ZONE='+00:00';",
      '', ''
    ].join('\n'));
    if (o.createDatabase) {
      const [[dbRow]] = await meta.query('SHOW CREATE DATABASE ' + esc(database));
      const create = String(dbRow['Create Database']).replace(/^CREATE DATABASE\s+(\/\*!32312 IF NOT EXISTS\*\/\s*)?/i, 'CREATE DATABASE IF NOT EXISTS ');
      await writeAndWait(dest, `${create};\nUSE ${esc(database)};\n\n`);
    }

    for (const t of tables) {
      const table = t.name;
      await section(`Table: \`${table}\``);

      if (withStructure) {
        const [createRows] = await meta.query(`SHOW CREATE TABLE ${esc(table)}`);
        let create = createRows[0]['Create Table'];
        if (o.structure === 'drop-create') await writeAndWait(dest, `DROP TABLE IF EXISTS ${esc(table)};\n`);
        if (o.structure === 'create-if-not-exists') create = create.replace(/^CREATE TABLE/i, 'CREATE TABLE IF NOT EXISTS');
        await writeAndWait(dest, `${create};\n\n`);
      }
      if (!o.data) continue;
      if (o.truncate) await writeAndWait(dest, `TRUNCATE TABLE ${esc(table)};\n`);

      // Generated (computed) columns can't be inserted into; leave them out.
      const { columns } = await getTableColumns(key, database, table);
      const columnNames = columns.filter((c) => !/\b(VIRTUAL|STORED|PERSISTENT)\b/i.test(c.extra || '')).map((c) => c.name);
      const head = `${INSERT_MODES[o.insertMode]} ${esc(table)} (${columnNames.map(esc).join(', ')}) VALUES\n`;
      const tail = o.insertMode === 'update'
        ? `\nON DUPLICATE KEY UPDATE ${columnNames.map((c) => `${esc(c)} = VALUES(${esc(c)})`).join(', ')};\n`
        : ';\n';

      await new Promise((resolve, reject) => {
        let batch = [];
        let batchBytes = 0;
        let wroteAnyRow = false;
        let settled = false;
        const done = (err) => { if (settled) return; settled = true; dest.off && dest.off('close', onClose); if (err) reject(err); else resolve(); };
        const onClose = () => done(new Error('Download cancelled by the client'));
        if (dest.once && !dest.path) dest.once('close', onClose);

        const queryStream = rawConn
          .query(`SELECT ${columnNames.map(esc).join(', ')} FROM ${esc(database)}.${esc(table)}`)
          .stream({ highWaterMark: 100 });

        // Respects backpressure: if the destination can't keep up, pause the
        // query instead of buffering the table in memory.
        const flush = () => {
          if (batch.length === 0) return;
          const ok = dest.write(head + batch.join(',\n') + tail);
          batch = []; batchBytes = 0;
          if (!ok && dest.once) {
            queryStream.pause();
            dest.once('drain', () => queryStream.resume());
          }
        };
        queryStream.on('data', (row) => {
          wroteAnyRow = true;
          const values = '(' + columnNames.map((c) => sqlLiteral(row[c])).join(',') + ')';
          if (batch.length && batchBytes + values.length > DUMP_STATEMENT_MAX_BYTES) flush();
          batch.push(values);
          batchBytes += values.length + 2;
          if (batch.length >= rowsPerInsert) flush();
        });
        queryStream.on('end', () => {
          flush();
          if (wroteAnyRow) dest.write('\n');
          done();
        });
        queryStream.on('error', done);
      });
    }

    // Views after the tables they read from.
    for (const v of views) {
      const [rows] = await meta.query(`SHOW CREATE VIEW ${esc(v.name)}`);
      await section(`View: \`${v.name}\``);
      let create = stripDefiner(rows[0]['Create View']);
      if (o.structure === 'drop-create') await writeAndWait(dest, `DROP VIEW IF EXISTS ${esc(v.name)};\n`);
      else create = create.replace(/^CREATE\s+(ALGORITHM\s*=\s*\w+\s+)?/i, (m, alg) => `CREATE OR REPLACE ${alg || ''}`);
      await writeAndWait(dest, `${create};\n\n`);
    }

    if (withStructure && o.routines) {
      for (const r of await listRoutines(key, database)) {
        const kind = r.type === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
        const [rows] = await meta.query(`SHOW CREATE ${kind} ${esc(r.name)}`);
        const create = rows[0] && rows[0][kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure'];
        if (!create) continue; // no privilege to read the body
        await section(`${kind === 'FUNCTION' ? 'Function' : 'Procedure'}: \`${r.name}\``);
        await writeAndWait(dest, `DROP ${kind} IF EXISTS ${esc(r.name)};\n`);
        writeWithDelimiter(dest, stripDefiner(create));
      }
    }

    // Triggers after the data, so restoring rows doesn't fire them.
    if (withStructure && o.triggers) {
      const tableNames = new Set(tables.map((t) => t.name));
      for (const t of await listTriggers(key, database)) {
        if (wanted && !tableNames.has(t.tableName)) continue;
        const [rows] = await meta.query(`SHOW CREATE TRIGGER ${esc(t.name)}`);
        const create = rows[0] && rows[0]['SQL Original Statement'];
        if (!create) continue;
        await section(`Trigger: \`${t.name}\``);
        await writeAndWait(dest, `DROP TRIGGER IF EXISTS ${esc(t.name)};\n`);
        writeWithDelimiter(dest, stripDefiner(create));
      }
    }

    if (withStructure && o.events) {
      for (const e of await listEvents(key, database)) {
        const [rows] = await meta.query(`SHOW CREATE EVENT ${esc(e.name)}`);
        const create = rows[0] && rows[0]['Create Event'];
        if (!create) continue;
        await section(`Event: \`${e.name}\``);
        await writeAndWait(dest, `DROP EVENT IF EXISTS ${esc(e.name)};\n`);
        writeWithDelimiter(dest, stripDefiner(create));
      }
    }

    await writeAndWait(dest, [
      'SET TIME_ZONE=@OLD_TIME_ZONE;',
      'SET SQL_MODE=@OLD_SQL_MODE;',
      'SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;',
      'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;',
      `-- Dump completed ${new Date().toISOString()}`,
      ''
    ].join('\n'));
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    meta.destroy();
    if (rawConn) closeStreamingConnection(rawConn, failed);
  }
}

// Export dialog. options: { format: 'sql' | 'sql.gz' | 'csv' | 'tsv', tables,
// structure, data, views, routines, triggers, events }. Returns the file name
// via onStart(filename, contentType) before writing.
function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function exportDatabase(key, database, res, options, onStart) {
  const format = ['sql', 'sql.gz', 'csv', 'tsv'].includes(options.format) ? options.format : 'sql';
  if (format === 'sql' || format === 'sql.gz') {
    const what = options.data === false ? '-schema' : (options.structure === 'none' ? '-data' : '');
    onStart(`${database}${what}-${fileStamp()}.${format}`, format === 'sql' ? 'application/sql; charset=utf-8' : 'application/gzip');
    if (format === 'sql') {
      await streamDatabaseBackup(key, database, res, options);
      return;
    }
    const gzip = zlib.createGzip();
    gzip.pipe(res);
    res.on('close', () => { if (!res.writableFinished) gzip.destroy(); });
    await streamDatabaseBackup(key, database, gzip, options);
    await new Promise((resolve, reject) => {
      gzip.on('error', reject);
      res.on('finish', resolve);
      gzip.end();
    });
    return;
  }

  // CSV / TSV: one file per table — a single table is sent as-is, several as .tar.gz.
  const all = await listTables(key, database);
  const wanted = Array.isArray(options.tables) && options.tables.length ? new Set(options.tables) : null;
  const tables = all.filter((t) => !wanted || wanted.has(t.name)).map((t) => t.name);
  if (!tables.length) throw new Error('Choose at least one table');
  if (tables.length === 1) {
    onStart(`${tables[0]}.${format}`, format === 'csv' ? 'text/csv; charset=utf-8' : 'text/tab-separated-values; charset=utf-8');
    await streamTableCsv(key, database, tables[0], res, { format });
    return;
  }
  // tar needs each entry's size up front, so each table is written to a temp
  // file and then appended to the archive, one table at a time: the
  // download starts at once and at most one table is on disk at any moment.
  onStart(`${database}-${format}-${fileStamp()}.tar.gz`, 'application/gzip');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbconsole-export-'));
  const gzip = zlib.createGzip();
  gzip.pipe(res);
  let cancelled = false;
  res.on('close', () => { if (!res.writableFinished) { cancelled = true; gzip.destroy(); } });
  try {
    for (const t of tables) {
      if (cancelled) throw new Error('Download cancelled by the client');
      const file = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.${format}`);
      const ws = fs.createWriteStream(file);
      try {
        await streamTableCsv(key, database, t, ws, { format });
        await new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); ws.end(); });
        const { size } = await fs.promises.stat(file);
        await writeAndWait(gzip, buildTarHeader(`${t}.${format}`, size));
        for await (const chunk of fs.createReadStream(file)) await writeAndWait(gzip, chunk);
        const pad = (512 - (size % 512)) % 512;
        if (pad) await writeAndWait(gzip, Buffer.alloc(pad));
      } finally {
        ws.destroy();
        fs.promises.rm(file, { force: true }).catch(() => {});
      }
    }
    await writeAndWait(gzip, Buffer.alloc(1024));
    await new Promise((resolve, reject) => {
      gzip.on('error', reject);
      res.on('finish', resolve);
      res.on('close', () => (res.writableFinished ? resolve() : reject(new Error('Download cancelled by the client'))));
      gzip.end();
    });
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
// never buffered whole. `format` is 'sql', 'sqlgz' (gzipped .sql) or 'targz'
// (Backup archive: gunzipped, tar container stripped).
// Options:
//   onError:  'stop' (default) — stop at the first failing statement;
//             'continue' — run the rest and report the first errors
//   foreignKeyChecks: false (default) runs with FOREIGN_KEY_CHECKS=0, so
//             tables can be loaded in any order
// Statements run with autocommit off and are committed every few hundred
// statements or seconds, which is much faster than one commit per INSERT.
// Calls onProgress({ executed, failed, bytes }) as it goes; `bytes` is how
// much of the (compressed) upload has been processed.
const RESTORE_COMMIT_EVERY = 200;
const RESTORE_COMMIT_MS = 2000;

async function restoreDump(key, database, readableStream, format, onProgress, { onError = 'stop', foreignKeyChecks = false } = {}) {
  const pool = getPool(key);
  const dbConn = await pool.getConnection();
  const splitter = new SqlStatementStream();
  const tarExtractor = format === 'targz' ? new TarExtractor() : null;
  // Decodes UTF-8 across chunk boundaries; Buffer#toString per chunk would
  // corrupt any multi-byte character split between two chunks.
  const decoder = new StringDecoder('utf8');
  let executed = 0;
  let failed = 0;
  let bytes = 0;
  let sinceCommit = 0;
  let lastCommit = Date.now();
  let stopped = null;
  const errors = [];

  const commit = async () => {
    await dbConn.query('COMMIT');
    sinceCommit = 0; lastCommit = Date.now();
  };
  const runStatement = async (stmt) => {
    if (stopped) return;
    try {
      await dbConn.query(stmt);
      executed++;
    } catch (err) {
      failed++;
      if (errors.length < 20) errors.push({ statement: stmt.slice(0, 300), error: err.message, number: executed + failed });
      if (onError !== 'continue') { stopped = errors[errors.length - 1] || { error: err.message }; return; }
    }
    if (++sinceCommit >= RESTORE_COMMIT_EVERY || Date.now() - lastCommit > RESTORE_COMMIT_MS) await commit();
  };

  // Counts the raw bytes read, before any decompression. The upload is
  // piped in by hand (not through pipeline()) so that stopping early doesn't
  // destroy the request socket before the response is sent; a cancelled
  // upload is passed on as an error instead.
  const counter = new Transform({ transform(chunk, enc, cb) { bytes += chunk.length; cb(null, chunk); } });
  const sourceStream = tarExtractor || format === 'sqlgz' ? pipeline(counter, zlib.createGunzip(), () => {}) : counter;
  const uploadEnded = () => readableStream.complete || readableStream.readableEnded;
  const onAbort = () => { if (!uploadEnded()) counter.destroy(new Error('Upload cancelled')); };
  readableStream.on('close', onAbort);
  readableStream.on('error', onAbort);
  readableStream.pipe(counter);

  let lastProgress = 0;
  const progress = (force) => {
    if (!onProgress || (!force && Date.now() - lastProgress < 300)) return;
    lastProgress = Date.now();
    onProgress({ executed, failed, bytes });
  };

  try {
    await dbConn.query(`USE ${esc(database)}`);
    await dbConn.query('SET autocommit = 0');
    if (!foreignKeyChecks) await dbConn.query('SET FOREIGN_KEY_CHECKS = 0');

    for await (const chunk of sourceStream) {
      const textChunks = tarExtractor ? tarExtractor.feed(chunk) : [chunk];
      for (const tc of textChunks) {
        const statements = splitter.feed(decoder.write(tc));
        for (const stmt of statements) await runStatement(stmt);
      }
      progress();
      if (stopped) break;
    }
    if (!stopped) {
      const rest = splitter.feed(decoder.end()).concat(splitter.flush());
      for (const stmt of rest) await runStatement(stmt);
    }
    // Keep what ran before a failing statement, so "executed" is accurate.
    await commit();
    progress(true);
  } finally {
    readableStream.off('close', onAbort);
    readableStream.off('error', onAbort);
    // The dump ran USE and SET statements (e.g. FOREIGN_KEY_CHECKS=0) on
    // this connection; never hand it back to the pool. Destroying it also
    // rolls back anything uncommitted if the upload was cancelled.
    dbConn.destroy();
  }

  // Stopped at an error: discard the rest of the upload (without running
  // it) so the response can still be delivered.
  if (stopped && !uploadEnded()) {
    readableStream.unpipe(counter);
    await new Promise((resolve) => {
      readableStream.on('end', resolve);
      readableStream.on('close', resolve);
      readableStream.resume();
    });
  }
  return { executed, failed, errors, bytes, stopped: Boolean(stopped) };
}
