// api/insight.js
// Looking at data rather than structure:
//   profileColumn   – what is in a column (nulls, distinct values, range, most common values, histogram)
//   relatedRows     – the rows a row points to through foreign keys, and how many rows point at it
//   searchReplace   – find and replace text across every text column of a database, with a preview

const mysqlUtil = require('mysql2');
const { getPool, getTableColumns, assignments, encodeRows } = require('./db');
const schema = require('./schema');

const esc = (id) => mysqlUtil.escapeId(id);
const NUMERIC_RE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year)\b/i;
const DATE_RE = /^(date|datetime|timestamp|time)\b/i;
const BLOBLIKE_RE = /(blob|binary|geometry|point|polygon|linestring)/i;
const TEXT_RE = /^(char|varchar|tinytext|text|mediumtext|longtext)\b/i;
const SAMPLE_ROWS = 2000000;

const clip = (v, n = 120) => {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return `0x${v.slice(0, 16).toString('hex')}${v.length > 16 ? '…' : ''}`;
  const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// ---------- column profile ----------
async function profileColumn(key, database, table, column) {
  const { columns } = await getTableColumns(key, database, table);
  const col = columns.find((c) => c.name === column);
  if (!col) throw new Error(`Unknown column: ${column}`);
  const type = String(col.type || '');
  const pool = getPool(key);
  const c = esc(column);
  const target = `${esc(database)}.${esc(table)}`;
  const [[meta]] = await pool.query('SELECT TABLE_ROWS AS approx FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [database, table]);
  // Huge tables: profile the first couple of million rows instead of scanning everything.
  const sampled = Number(meta && meta.approx) > SAMPLE_ROWS * 1.5;
  const from = sampled ? `(SELECT ${c} FROM ${target} LIMIT ${SAMPLE_ROWS}) AS s` : target;
  const numeric = NUMERIC_RE.test(type);
  const date = DATE_RE.test(type);
  const blob = BLOBLIKE_RE.test(type);
  const text = TEXT_RE.test(type) || /^(enum|set|json)\b/i.test(type);

  const parts = ['COUNT(*) AS total', `COUNT(${c}) AS nonNull`];
  if (!blob) parts.push(`COUNT(DISTINCT ${c}) AS distinctValues`, `MIN(${c}) AS minVal`, `MAX(${c}) AS maxVal`);
  if (numeric) parts.push(`AVG(${c}) AS avgVal`);
  if (text) parts.push(`MIN(CHAR_LENGTH(${c})) AS minLen`, `MAX(CHAR_LENGTH(${c})) AS maxLen`, `AVG(CHAR_LENGTH(${c})) AS avgLen`, `SUM(${c} = '') AS emptyStrings`);
  const [[stats]] = await pool.query(`SELECT ${parts.join(', ')} FROM ${from}`);
  const total = Number(stats.total);
  const out = {
    column, type, sampled, sampleRows: sampled ? SAMPLE_ROWS : undefined,
    total, nulls: total - Number(stats.nonNull), distinct: blob ? null : Number(stats.distinctValues),
    min: blob ? null : clip(stats.minVal), max: blob ? null : clip(stats.maxVal),
    avg: numeric && stats.avgVal !== null ? Number(stats.avgVal) : undefined,
    minLength: text ? Number(stats.minLen) : undefined, maxLength: text ? Number(stats.maxLen) : undefined,
    avgLength: text && stats.avgLen !== null ? Number(stats.avgLen) : undefined, emptyStrings: text ? Number(stats.emptyStrings || 0) : undefined
  };
  if (!blob) {
    const [top] = await pool.query(`SELECT ${c} AS v, COUNT(*) AS n FROM ${from} GROUP BY ${c} ORDER BY n DESC, ${c} LIMIT 10`);
    out.top = top.map((r) => ({ value: clip(r.v), isNull: r.v === null, count: Number(r.n) }));
  }
  if (numeric && out.distinct > 1 && Number.isFinite(Number(stats.minVal)) && Number(stats.maxVal) > Number(stats.minVal)) {
    const lo = Number(stats.minVal); const hi = Number(stats.maxVal); const width = (hi - lo) / 10;
    const [rows] = await pool.query(`SELECT LEAST(FLOOR((${c} - ?) / ?), 9) AS b, COUNT(*) AS n FROM ${from} WHERE ${c} IS NOT NULL GROUP BY b ORDER BY b`, [lo, width]);
    out.histogram = Array.from({ length: 10 }, (_, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, count: Number((rows.find((r) => Number(r.b) === i) || {}).n || 0) }));
  }
  return out;
}

// ---------- related rows ----------
async function relatedRows(key, database, table, where) {
  if (!where || !Object.keys(where).length) throw new Error('Missing row identifier');
  const pool = getPool(key);
  const params = [];
  const [rows] = await pool.query(`SELECT * FROM ${esc(database)}.${esc(table)} WHERE ${assignments(where, params, ' AND ')} LIMIT 1`, params);
  if (!rows.length) throw new Error('Row not found');
  const row = rows[0];
  const all = await schema.getDatabaseForeignKeys(key, database);

  // Rows this one points to
  const parents = [];
  for (const fk of all.filter((f) => f.table === table)) {
    const values = fk.columns.map((cn) => row[cn]);
    if (values.some((v) => v === null || v === undefined)) { parents.push({ fk: fk.name, table: fk.refTable, refDb: fk.refDb, columns: fk.columns, refColumns: fk.refColumns, row: null, reason: 'null' }); continue; }
    const p = [];
    const w = fk.refColumns.map((rc, i) => { p.push(values[i]); return `${esc(rc)} = ?`; }).join(' AND ');
    const [found] = await pool.query(`SELECT * FROM ${esc(fk.refDb)}.${esc(fk.refTable)} WHERE ${w} LIMIT 1`, p);
    parents.push({ fk: fk.name, table: fk.refTable, refDb: fk.refDb, columns: fk.columns, refColumns: fk.refColumns, filter: fk.refColumns.map((rc, i) => ({ col: rc, op: '=', value: String(values[i]) })), row: found.length ? encodeRows(found)[0] : null });
  }

  // Rows that point at this one
  const children = [];
  for (const fk of all.filter((f) => f.refTable === table && (f.refDb === database || !f.refDb))) {
    const values = fk.refColumns.map((rc) => row[rc]);
    if (values.some((v) => v === null || v === undefined)) continue;
    const p = [];
    const w = fk.columns.map((cn, i) => { p.push(values[i]); return `${esc(cn)} = ?`; }).join(' AND ');
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${esc(database)}.${esc(fk.table)} WHERE ${w}`, p);
    children.push({ fk: fk.name, table: fk.table, columns: fk.columns, refColumns: fk.refColumns, count: Number(n), filter: fk.columns.map((cn, i) => ({ col: cn, op: '=', value: String(values[i]) })) });
  }
  return { parents, children };
}

// ---------- search & replace ----------
// Matching is case-sensitive and byte-exact (that is how REPLACE() works); only plain text columns are touched.
async function searchReplace(key, database, { find, replace = '', tables, preview = true } = {}) {
  find = String(find ?? '');
  replace = String(replace ?? '');
  if (!find) throw new Error('Enter the text to find');
  if (find === replace) throw new Error('The replacement is the same as the text to find');
  const pool = getPool(key);
  const [cols] = await pool.query(
    `SELECT c.TABLE_NAME AS tableName, c.COLUMN_NAME AS col, c.COLUMN_TYPE AS type, c.EXTRA AS extra, t.ENGINE AS engine
       FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE' ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`, [database]);
  const wanted = Array.isArray(tables) && tables.length ? new Set(tables) : null;
  const targets = cols.filter((c) => TEXT_RE.test(c.type) && !/\b(VIRTUAL|STORED|PERSISTENT)\b/i.test(c.extra || '') && (!wanted || wanted.has(c.tableName)));
  const hit = (c) => `LOCATE(BINARY ?, BINARY ${esc(c)}) > 0`;
  const found = [];
  const errors = [];
  let scanned = 0;
  for (const t of targets) {
    if (scanned++ >= 2000) break;
    const full = `${esc(database)}.${esc(t.tableName)}`;
    try {
      const [[r]] = await pool.query(
        `SELECT COUNT(*) AS n, SUM((CHAR_LENGTH(${esc(t.col)}) - CHAR_LENGTH(REPLACE(${esc(t.col)}, ?, ''))) / CHAR_LENGTH(?)) AS occ FROM ${full} WHERE ${hit(t.col)}`, [find, find, find]);
      if (!Number(r.n)) continue;
      const entry = { table: t.tableName, column: t.col, rows: Number(r.n), occurrences: Math.round(Number(r.occ || 0)), engine: t.engine };
      if (preview) {
        const [sample] = await pool.query(`SELECT ${esc(t.col)} AS before_, REPLACE(${esc(t.col)}, ?, ?) AS after_ FROM ${full} WHERE ${hit(t.col)} LIMIT 3`, [find, replace, find]);
        entry.sample = sample.map((s) => ({ before: excerpt(s.before_, find), after: excerpt(s.after_, replace || find) }));
      }
      found.push(entry);
    } catch (e) { errors.push({ table: t.tableName, column: t.col, error: e.message }); }
  }
  const summary = { find, replace, columns: found.length, rows: found.reduce((a, f) => a + f.rows, 0), occurrences: found.reduce((a, f) => a + f.occurrences, 0), tablesSearched: new Set(targets.map((t) => t.tableName)).size };
  if (preview) return { preview: true, ...summary, found, errors };

  // Apply: one transaction across everything, so a failure leaves the data untouched. Tables that can't
  // roll back (MyISAM…) are not touched at all.
  const safe = found.filter((f) => /^innodb$/i.test(f.engine || ''));
  const skipped = found.filter((f) => !/^innodb$/i.test(f.engine || '')).map((f) => `${f.table}.${f.column} (${f.engine})`);
  const conn = await pool.getConnection();
  const done = [];
  try {
    await conn.query('START TRANSACTION');
    for (const f of safe) {
      const full = `${esc(database)}.${esc(f.table)}`;
      let res;
      try {
        [res] = await conn.query(`UPDATE ${full} SET ${esc(f.column)} = REPLACE(${esc(f.column)}, ?, ?) WHERE ${hit(f.column)}`, [find, replace, find]);
      } catch (e) { throw new Error(`${f.table}.${f.column}: ${e.message}`); }
      done.push({ table: f.table, column: f.column, rows: res.affectedRows });
    }
    await conn.query('COMMIT');
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw new Error(`Nothing was changed. ${e.message}`);
  } finally { conn.release(); }
  return { preview: false, sql: `SEARCH & REPLACE ${JSON.stringify(find).slice(0, 60)} → ${JSON.stringify(replace).slice(0, 60)} in ${done.length} column(s) of ${database}`, ...summary, applied: done, rowsChanged: done.reduce((a, d) => a + d.rows, 0), skipped, errors };
}

// A short piece of text around the first occurrence of `needle`.
function excerpt(text, needle) {
  const s = String(text ?? '');
  const i = needle ? s.indexOf(needle) : 0;
  const start = Math.max(0, i - 40);
  const end = Math.min(s.length, i + String(needle).length + 40);
  return (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '');
}

module.exports = { profileColumn, relatedRows, searchReplace };
