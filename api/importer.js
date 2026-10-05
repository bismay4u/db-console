// api/importer.js
// Streaming CSV / TSV import into a table. The file is uploaded as the raw
// request body and parsed on the server as it arrives, so a file with
// millions of rows is never held in memory (in the browser or here):
//
//   upload → (gunzip) → UTF-8 decode → parser → multi-row INSERTs → MySQL
//
// Reading the upload waits for each INSERT, so a slow database simply slows
// the upload down (TCP backpressure) instead of buffering it.

const mysqlUtil = require('mysql2');
const zlib = require('zlib');
const { Transform, pipeline } = require('stream');
const { StringDecoder } = require('string_decoder');
const { getPool, getTableColumns } = require('./db');

const esc = (id) => mysqlUtil.escapeId(id);

// ---- Parsers ----
// Both yield rows as arrays of fields; a field is a string, or null for
// \N written unquoted (the MySQL NULL convention, also used by our export).
// Each row comes with the line number it starts on, for error messages.

// RFC 4180 CSV: fields may be "quoted", "" is an escaped quote, quoted
// fields may contain the delimiter and newlines; \r\n or \n line endings.
class CsvParser {
  constructor(delimiter = ',') {
    if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      throw new Error('The delimiter must be a single character');
    }
    this.d = delimiter;
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.quoted = false; // current field was quoted
    this.pendingQuote = false; // saw a quote inside quotes; next char decides
    this.pendingCR = false;
    this.line = 1;
    this.rowLine = 1;
    this.started = false; // anything in the current row yet
  }

  endField() {
    this.row.push(!this.quoted && this.field === '\\N' ? null : this.field);
    this.field = ''; this.quoted = false;
  }

  endRow(out) {
    this.endField();
    // A completely empty line is skipped.
    if (!(this.row.length === 1 && this.row[0] === '' )) out.push({ line: this.rowLine, fields: this.row });
    this.row = []; this.started = false;
  }

  feed(text, out = []) {
    const d = this.d;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.pendingCR) {
        this.pendingCR = false;
        if (c === '\n') continue; // \r\n already ended the row
      }
      if (!this.started) { this.started = true; this.rowLine = this.line; }
      if (this.inQuotes) {
        if (this.pendingQuote) {
          this.pendingQuote = false;
          if (c === '"') { this.field += '"'; continue; }
          this.inQuotes = false; // the quote closed the field; handle c below
        } else if (c === '"') { this.pendingQuote = true; continue; } else {
          if (c === '\n') this.line++;
          // Fast path: copy up to the next quote in one go.
          const next = text.indexOf('"', i + 1);
          const end = next === -1 ? text.length : next;
          const chunk = text.slice(i, end);
          this.field += chunk;
          for (let j = 1; j < chunk.length; j++) if (chunk.charCodeAt(j) === 10) this.line++;
          i = end - 1;
          continue;
        }
      }
      if (c === d) { this.endField(); continue; }
      if (c === '\n' || c === '\r') {
        this.line++;
        this.endRow(out);
        if (c === '\r') this.pendingCR = true;
        continue;
      }
      if (c === '"' && this.field === '' && !this.quoted) { this.inQuotes = true; this.quoted = true; continue; }
      this.field += c;
    }
    return out;
  }

  // End of input: the last row may have no trailing newline.
  flush(out = []) {
    if (this.inQuotes && !this.pendingQuote) throw new Error(`Line ${this.rowLine}: a quoted field is never closed`);
    this.inQuotes = false; this.pendingQuote = false;
    if (this.started) this.endRow(out);
    return out;
  }
}

// MySQL-style TSV (as written by SELECT … INTO OUTFILE and by our TSV
// export): tab-separated, one row per line, \t \n \r \\ \0 escaped with a
// backslash, \N = NULL. No quoting.
class TsvParser {
  constructor() { this.rest = ''; this.line = 0; }

  static unescape(f) {
    if (f === '\\N') return null;
    if (f.indexOf('\\') === -1) return f;
    return f.replace(/\\(.)/g, (m, ch) => ({ t: '\t', n: '\n', r: '\r', 0: '\0', b: '\b', Z: '\x1a' }[ch] ?? ch));
  }

  feed(text, out = []) {
    const data = this.rest + text;
    let start = 0;
    let nl;
    while ((nl = data.indexOf('\n', start)) !== -1) {
      this.pushLine(data.slice(start, nl), out);
      start = nl + 1;
    }
    this.rest = data.slice(start);
    return out;
  }

  pushLine(lineText, out) {
    this.line++;
    if (lineText.endsWith('\r')) lineText = lineText.slice(0, -1);
    if (lineText === '') return;
    out.push({ line: this.line, fields: lineText.split('\t').map(TsvParser.unescape) });
  }

  flush(out = []) {
    if (this.rest !== '') this.pushLine(this.rest, out);
    this.rest = '';
    return out;
  }
}

// ---- Import ----
const TEXTLIKE_TYPE_RE = /char|text|enum|set|binary|blob/i;
const BINARY_TYPE_RE = /binary|blob|^bit/i;
const MODES = {
  error: 'INSERT INTO',
  skip: 'INSERT IGNORE INTO',
  replace: 'REPLACE INTO',
  update: 'INSERT INTO' // + ON DUPLICATE KEY UPDATE
};
const MAX_ERRORS = 50;

class ImportError extends Error {
  constructor(message, line) { super(line ? `Line ${line}: ${message}` : message); this.line = line; }
}

// options:
//   format:     'csv' | 'tsv'
//   delimiter:  CSV delimiter (default ',')
//   gzip:       the upload is gzipped
//   columns:    one entry per file column: the table column it goes into, or
//               null to skip it. The file's first row is the header.
//   onDuplicate: 'error' | 'skip' | 'replace' | 'update'
//   onError:    'stop' (default) | 'skip' (skip rows that fail, up to the end)
//   atomic:     true (default): one transaction, nothing is kept unless the
//               whole file imports; false: committed as it goes
//   truncate:   empty the table first (atomic: DELETE inside the transaction,
//               so it's undone on failure; otherwise TRUNCATE)
//   base64Binary: binary/blob columns hold Base64, as our export writes them
//   foreignKeyChecks: false turns them off for the import
//   batchRows:  rows per INSERT (default 1000; also capped by size)
// onProgress({ rows, bytes, inserted, skipped, warnings }) is called a few
// times a second.
async function importDelimited(key, database, table, input, options, onProgress) {
  const o = {
    format: 'csv', delimiter: ',', gzip: false, onDuplicate: 'error', onError: 'stop', atomic: true,
    truncate: false, base64Binary: true, foreignKeyChecks: true, batchRows: 1000, ...options
  };
  if (!MODES[o.onDuplicate]) throw new Error(`Unknown duplicate handling: ${o.onDuplicate}`);
  if (!['stop', 'skip'].includes(o.onError)) throw new Error(`Unknown error handling: ${o.onError}`);

  const { columns: tableCols, primaryKey } = await getTableColumns(key, database, table);
  const byName = new Map(tableCols.map((c) => [c.name, c]));
  if (!Array.isArray(o.columns) || !o.columns.some(Boolean)) throw new Error('Map at least one column of the file to a table column');
  const mapping = o.columns.map((name, idx) => {
    if (!name) return null;
    const col = byName.get(name);
    if (!col) throw new Error(`Unknown column: ${name}`);
    if (/\b(VIRTUAL|STORED|PERSISTENT)\b/i.test(col.extra || '')) throw new Error(`${name} is a generated column and can't be imported into`);
    return {
      idx, name,
      blankIsNull: col.nullable && !TEXTLIKE_TYPE_RE.test(col.type),
      binary: o.base64Binary && BINARY_TYPE_RE.test(col.type)
    };
  }).filter(Boolean);
  const names = mapping.map((m) => m.name);
  if (new Set(names).size !== names.length) throw new Error('Two file columns are mapped to the same table column');

  const pool = getPool(key);
  const conn = await pool.getConnection();
  const target = `${esc(database)}.${esc(table)}`;
  const head = `${MODES[o.onDuplicate]} ${target} (${names.map(esc).join(', ')}) VALUES `;
  const updateCols = names.filter((n) => !primaryKey.includes(n));
  const tail = o.onDuplicate === 'update'
    ? ` ON DUPLICATE KEY UPDATE ${(updateCols.length ? updateCols : names).map((n) => `${esc(n)} = VALUES(${esc(n)})`).join(', ')}`
    : '';
  const [[{ packet }]] = await conn.query('SELECT @@max_allowed_packet AS packet');
  const maxBytes = Math.max(64 * 1024, Math.min(4 * 1024 * 1024, Number(packet) / 2));
  const batchRows = Math.min(Math.max(Number(o.batchRows) || 1000, 1), 10000);

  const stats = { rows: 0, bytes: 0, inserted: 0, skipped: 0, warnings: 0 };
  const errors = [];
  const warningSamples = [];
  let header = null;
  let batch = [];
  let batchBytes = 0;
  let lastProgress = 0;
  let sinceCommit = 0;
  let committed = 0; // rows already committed (non-atomic imports)

  const progress = (force) => {
    if (!onProgress || (!force && Date.now() - lastProgress < 400)) return;
    lastProgress = Date.now();
    onProgress({ ...stats });
  };

  const rowSql = ({ line, fields }) => {
    if (fields.length !== header.length) {
      throw new ImportError(`has ${fields.length} field(s), the header has ${header.length}`, line);
    }
    return '(' + mapping.map((m) => {
      let v = fields[m.idx];
      if (v === '' && m.blankIsNull) v = null;
      if (v !== null && m.binary) v = Buffer.from(v, 'base64');
      return mysqlUtil.escape(v);
    }).join(',') + ')';
  };

  const noteWarnings = async (result) => {
    if (!result.warningStatus) return;
    stats.warnings += result.warningStatus;
    if (warningSamples.length < 5) {
      const [w] = await conn.query('SHOW WARNINGS LIMIT 5');
      for (const x of w) if (warningSamples.length < 5) warningSamples.push(`${x.Level} ${x.Code}: ${x.Message}`);
    }
  };

  // Runs one batch. If it fails, rolls it back to a savepoint and retries
  // row by row to find (and report, or skip) the exact rows at fault.
  const runBatch = async () => {
    if (!batch.length) return;
    const rows = batch;
    batch = []; batchBytes = 0;
    await conn.query('SAVEPOINT import_batch');
    try {
      const [result] = await conn.query(head + rows.map((r) => r.sql).join(',') + tail);
      stats.inserted += rows.length;
      await noteWarnings(result);
    } catch (batchErr) {
      await conn.query('ROLLBACK TO SAVEPOINT import_batch');
      for (const r of rows) {
        await conn.query('SAVEPOINT import_row');
        try {
          const [result] = await conn.query(head + r.sql + tail);
          stats.inserted++;
          await noteWarnings(result);
        } catch (err) {
          await conn.query('ROLLBACK TO SAVEPOINT import_row');
          if (o.onError !== 'skip') throw new ImportError(err.message, r.line);
          stats.skipped++;
          if (errors.length < MAX_ERRORS) errors.push({ line: r.line, error: err.message });
        }
      }
    }
    if (!o.atomic && (sinceCommit += rows.length) >= 10000) { await conn.query('COMMIT'); sinceCommit = 0; committed = stats.inserted; }
  };

  const handleRows = async (rows) => {
    for (const r of rows) {
      if (!header) {
        header = r.fields.map((f) => (f === null ? '\\N' : f));
        if (o.columns.length !== header.length) {
          throw new ImportError(`The file has ${header.length} column(s) but ${o.columns.length} were mapped — was the right file and delimiter chosen?`, r.line);
        }
        continue;
      }
      stats.rows++;
      let sql;
      try {
        sql = rowSql(r);
      } catch (err) {
        if (o.onError !== 'skip') throw err;
        stats.skipped++;
        if (errors.length < MAX_ERRORS) errors.push({ line: r.line, error: err.message.replace(/^Line \d+: /, '') });
        continue;
      }
      if (batch.length && batchBytes + sql.length > maxBytes) await runBatch();
      batch.push({ line: r.line, sql });
      batchBytes += sql.length + 1;
      if (batch.length >= batchRows) await runBatch();
    }
  };

  // Count raw bytes; pipe the upload in by hand so a cancelled upload
  // becomes an error here rather than a hang.
  const counter = new Transform({ transform(chunk, enc, cb) { stats.bytes += chunk.length; cb(null, chunk); } });
  const source = o.gzip ? pipeline(counter, zlib.createGunzip(), () => {}) : counter;
  const uploadEnded = () => input.complete || input.readableEnded;
  const onAbort = () => { if (!uploadEnded()) counter.destroy(new Error('Upload cancelled')); };
  input.on('close', onAbort);
  input.on('error', onAbort);
  input.pipe(counter);

  const parser = o.format === 'tsv' ? new TsvParser() : new CsvParser(o.delimiter || ',');
  const decoder = new StringDecoder('utf8');
  let first = true;
  let failure = null;
  try {
    // A 0 in an AUTO_INCREMENT column is a real value (as in the export),
    // not "generate the next id".
    await conn.query("SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'NO_AUTO_VALUE_ON_ZERO')");
    if (!o.foreignKeyChecks) await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    if (o.truncate && !o.atomic) await conn.query(`TRUNCATE TABLE ${target}`);
    await conn.query('SET autocommit = 0');
    await conn.query('START TRANSACTION');
    if (o.truncate && o.atomic) await conn.query(`DELETE FROM ${target}`);

    for await (const chunk of source) {
      let text = decoder.write(chunk);
      if (first && text) { text = text.replace(/^﻿/, ''); first = false; } // byte-order mark
      await handleRows(parser.feed(text));
      progress();
    }
    await handleRows(parser.feed(decoder.end()));
    await handleRows(parser.flush());
    await runBatch();
    if (!header) throw new Error('The file is empty');
    await conn.query('COMMIT');
    committed = stats.inserted;
  } catch (err) {
    failure = err;
    // Atomic: nothing is kept. Otherwise keep what was committed so far
    // (batches before the failing one), and say so.
    await conn.query('ROLLBACK').catch(() => {});
  } finally {
    input.off('close', onAbort);
    input.off('error', onAbort);
    // Session settings (autocommit, FOREIGN_KEY_CHECKS) were changed.
    conn.destroy();
  }

  // Stopped early: discard the rest of the upload so the response can be sent.
  if (failure && !uploadEnded() && !input.destroyed) {
    input.unpipe(counter);
    await new Promise((resolve) => { input.on('end', resolve); input.on('close', resolve); input.resume(); });
  }

  progress(true);
  const result = { ...stats, errors, warningSamples, atomic: o.atomic };
  if (failure) {
    const err = new Error(failure.message);
    err.result = { ...result, kept: committed, line: failure.line };
    throw err;
  }
  return result;
}

module.exports = { importDelimited, CsvParser, TsvParser };
