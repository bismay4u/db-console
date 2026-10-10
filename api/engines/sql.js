// api/engines/sql.js
// What the PostgreSQL and SQLite engines share: splitting a script into statements, quoting, building WHERE / ORDER BY
// from the grid's filters, and turning values into something the browser (JSON) and the drivers can handle.

const HEX_INLINE_MAX = 4096; // binary values up to this size are shown as hex in the grid; larger ones as a size

const quote = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// ---------- splitting ----------
// dialect: 'postgres' (dollar quoting, E'' strings, nested block comments) or 'sqlite' (CREATE TRIGGER … BEGIN … END).
function splitSql(text, dialect) {
  const s = String(text);
  const out = [];
  let start = 0; let i = 0;
  let triggerBody = false; // inside BEGIN … END of a CREATE TRIGGER (SQLite)
  const head = () => s.slice(start, i).replace(/^(\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/g, '');
  while (i < s.length) {
    const c = s[i]; const n = s[i + 1];
    if (c === '-' && n === '-') { const e = s.indexOf('\n', i); i = e === -1 ? s.length : e + 1; continue; }
    if (c === '/' && n === '*') {
      let depth = 1; i += 2;
      while (i < s.length && depth) {
        if (s[i] === '/' && s[i + 1] === '*' && dialect === 'postgres') { depth++; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || (c === '`' && dialect === 'sqlite') || (c === '[' && dialect === 'sqlite')) {
      const close = c === '[' ? ']' : c;
      const escapes = dialect === 'postgres' && c === "'" && /[eE]$/.test(s.slice(Math.max(0, i - 1), i)) && !/[\w$]$/.test(s.slice(Math.max(0, i - 2), i - 1));
      i++;
      while (i < s.length) {
        if (escapes && s[i] === '\\') { i += 2; continue; }
        if (s[i] === close) { if (s[i + 1] === close && close !== ']') { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (dialect === 'postgres' && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      if (m && !/[\w$]/.test(s[i - 1] || ' ')) { const e = s.indexOf(m[0], i + m[0].length); i = e === -1 ? s.length : e + m[0].length; continue; }
    }
    if (dialect === 'sqlite' && /[A-Za-z]/.test(c) && !/[\w$]/.test(s[i - 1] || ' ')) {
      const w = /^[A-Za-z_]+/.exec(s.slice(i, i + 12))[0].toUpperCase();
      if (w === 'BEGIN' && /^create\s+(temp(orary)?\s+)?trigger\b/i.test(head())) triggerBody = true;
      if (w === 'END' && triggerBody && /^\s*;/.test(s.slice(i + 3))) triggerBody = false;
      i += w.length; continue;
    }
    if (c === ';' && !triggerBody) {
      const stmt = s.slice(start, i).trim();
      if (stmt && !/^(\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*$/.test(stmt)) out.push(stmt);
      start = i + 1;
    }
    i++;
  }
  const tail = s.slice(start).trim();
  if (tail && !/^(\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*$/.test(tail)) out.push(tail);
  return out;
}

const stripLeading = (sql) => String(sql).replace(/^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '');

// ---------- values ----------
function encodeCell(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) { if (!Buffer.isBuffer(v)) v = Buffer.from(v.buffer, v.byteOffset, v.byteLength); return v.length <= HEX_INLINE_MAX ? { __hex: v.toString('hex') } : { __blob: true, size: v.length }; }
  if (v instanceof Date) return v.toISOString();
  return v;
}
function encodeRows(rows) {
  for (const r of rows) for (const k of Object.keys(r)) { const v = r[k]; if (typeof v === 'bigint' || v instanceof Uint8Array || v instanceof Date) r[k] = encodeCell(v); }
  return rows;
}

// A value from the browser as a driver parameter. Functions the row editor offers map to portable SQL.
const FUNCTIONS = {
  postgres: { NOW: 'NOW()', CURDATE: 'CURRENT_DATE', CURTIME: 'CURRENT_TIME', UTC_TIMESTAMP: "(NOW() AT TIME ZONE 'UTC')", UUID: 'gen_random_uuid()', UNIX_TIMESTAMP: 'EXTRACT(EPOCH FROM NOW())::bigint' },
  sqlite: { NOW: 'CURRENT_TIMESTAMP', CURDATE: 'CURRENT_DATE', CURTIME: 'CURRENT_TIME', UTC_TIMESTAMP: 'CURRENT_TIMESTAMP', UNIX_TIMESTAMP: "CAST(strftime('%s','now') AS INTEGER)" }
};
// → { sql, params } for one value, using `bind(v)` to add a parameter and get its placeholder.
function valueSql(v, bind, dialect) {
  if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
    if (v.__hex !== undefined) return bind(Buffer.from(String(v.__hex), 'hex'));
    if (v.__base64 !== undefined) return bind(Buffer.from(String(v.__base64), 'base64'));
    if (v.__fn !== undefined) {
      const f = FUNCTIONS[dialect][v.__fn];
      if (!f) throw new Error(`The function ${v.__fn} is not available for this kind of database — type the value instead`);
      return f;
    }
    if (v.__blob) throw new Error("A large binary value can't be sent back as-is — upload a file to replace it");
    return bind(JSON.stringify(v));
  }
  return bind(v);
}

// Placeholder numbering: $1, $2… for PostgreSQL, ? for SQLite.
function binder(dialect) {
  const params = [];
  return { params, bind(v) { params.push(v); return dialect === 'postgres' ? `$${params.length}` : '?'; } };
}

// ---------- filters ----------
const escapeLike = (v) => String(v).replace(/[\\%_]/g, (m) => '\\' + m);
const NO_VALUE = new Set(['IS NULL', 'IS NOT NULL']);
const SIMPLE = { '=': '=', '!=': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };

function buildWhere(filters, columnNames, dialect, b = binder(dialect)) {
  if (!Array.isArray(filters) || !filters.length) return { sql: '', params: b.params, b };
  const conds = [];
  const text = (c) => (dialect === 'postgres' ? `${quote(c)}::text` : quote(c));
  const like = (c, pat, neg) => (dialect === 'postgres' ? `${text(c)} ${neg ? 'NOT ILIKE' : 'ILIKE'} ${pat}` : `${quote(c)} ${neg ? 'NOT LIKE' : 'LIKE'} ${pat} ESCAPE '\\'`);
  for (const f of filters) {
    if (!f || !(f.op in SIMPLE || NO_VALUE.has(f.op) || ['contains', 'not contains', 'starts', 'ends', 'LIKE', 'NOT LIKE', 'REGEXP', 'IN', 'NOT IN'].includes(f.op))) throw new Error(`Unsupported filter operator: ${f && f.op}`);
    const needsValue = !NO_VALUE.has(f.op);
    if (needsValue && (f.value === undefined || f.value === null)) continue;
    const any = f.col === '*';
    const cols = any ? columnNames : [f.col];
    if (!any && !columnNames.includes(f.col)) throw new Error(`Unknown column: ${f.col}`);
    const negative = ['!=', 'not contains', 'NOT LIKE', 'NOT IN', 'IS NOT NULL'].includes(f.op);
    const parts = cols.map((c) => {
      let cond;
      if (f.op in SIMPLE) cond = `${quote(c)} ${SIMPLE[f.op]} ${b.bind(f.value)}`;
      else if (f.op === 'IS NULL') cond = `${quote(c)} IS NULL`;
      else if (f.op === 'IS NOT NULL') cond = `${quote(c)} IS NOT NULL`;
      else if (f.op === 'contains' || f.op === 'not contains') cond = like(c, b.bind(`%${escapeLike(f.value)}%`), f.op === 'not contains');
      else if (f.op === 'starts') cond = like(c, b.bind(`${escapeLike(f.value)}%`), false);
      else if (f.op === 'ends') cond = like(c, b.bind(`%${escapeLike(f.value)}`), false);
      else if (f.op === 'LIKE' || f.op === 'NOT LIKE') cond = like(c, b.bind(f.value), f.op === 'NOT LIKE');
      else if (f.op === 'REGEXP') cond = dialect === 'postgres' ? `${text(c)} ~* ${b.bind(f.value)}` : `${quote(c)} REGEXP ${b.bind(f.value)}`;
      else {
        const list = String(f.value).split(',').map((x) => x.trim()).filter((x) => x !== '');
        if (!list.length) throw new Error(`${f.op} needs a comma-separated list of values`);
        cond = `${quote(c)}${dialect === 'postgres' ? '::text' : ''} ${f.op} (${list.map((x) => b.bind(x)).join(', ')})`;
      }
      return any && negative && needsValue ? `(${cond} OR ${quote(c)} IS NULL)` : cond;
    });
    conds.push(parts.length === 1 ? parts[0] : `(${parts.join(negative ? ' AND ' : ' OR ')})`);
  }
  return { sql: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params: b.params, b };
}

function orderBy(columnNames, sort, sortCol, sortDir) {
  const list = Array.isArray(sort) && sort.length ? sort : (sortCol ? [{ col: sortCol, dir: sortDir }] : []);
  const parts = list.filter((x) => x && columnNames.includes(x.col)).map((x) => `${quote(x.col)} ${x.dir === 'desc' ? 'DESC' : 'ASC'}`);
  return parts.length ? `ORDER BY ${parts.join(', ')}` : '';
}

// ---------- CSV ----------
function csvField(v) {
  if (v === null || v === undefined) return '\\N';
  const t = Buffer.isBuffer(v) ? v.toString('base64') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(t) || t === '\\N' ? `"${t.replace(/"/g, '""')}"` : t;
}
function tsvField(v) {
  if (v === null || v === undefined) return '\\N';
  const t = Buffer.isBuffer(v) ? v.toString('base64') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.replace(/[\\\t\n\r\0]/g, (m) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r', '\0': '\\0' }[m]));
}

module.exports = { HEX_INLINE_MAX, quote, splitSql, stripLeading, encodeCell, encodeRows, valueSql, binder, buildWhere, orderBy, escapeLike, csvField, tsvField };

// ---------- streaming a result into a CSV / TSV download ----------
// next() resolves to an array of row objects (or null when there are no more); `columns` are the column names.
const zlib = require('zlib');
async function writeDelimited({ columns, next, res, options = {}, onStart, filename }) {
  const o = { format: 'csv', gzip: false, bom: true, nulls: 'empty', maxRows: 0, ...options };
  const tsv = o.format === 'tsv';
  const sep = tsv ? '\t' : ','; const eol = tsv ? '\n' : '\r\n';
  const nullText = o.nulls === 'null' ? 'NULL' : o.nulls === '\\N' ? '\\N' : '';
  const field = tsv ? tsvField : csvField;
  const cell = (v) => (v === null || v === undefined ? nullText : field(v));
  const ext = `${tsv ? 'tsv' : 'csv'}${o.gzip ? '.gz' : ''}`;
  onStart(`${filename}.${ext}`, o.gzip ? 'application/gzip' : (tsv ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8'));
  let out = res; let gz = null;
  if (o.gzip) { gz = zlib.createGzip(); gz.pipe(res); out = gz; }
  let cancelled = false;
  const onClose = () => { if (!res.writableFinished) cancelled = true; };
  res.on('close', onClose);
  const write = (text) => new Promise((resolve, reject) => { if (cancelled) return reject(new Error('Download cancelled by the client')); if (out.write(text)) resolve(); else out.once('drain', resolve); });
  let count = 0; let truncated = false;
  try {
    await write((o.bom && !tsv ? '﻿' : '') + columns.map((c) => cell(c)).join(sep) + eol);
    for (;;) {
      const batch = await next();
      if (!batch || !batch.length) break;
      let chunk = '';
      for (const row of batch) {
        if (o.maxRows && count >= o.maxRows) { truncated = true; break; }
        chunk += columns.map((c) => cell(row[c])).join(sep) + eol;
        count++;
      }
      await write(chunk);
      if (truncated) break;
    }
    await new Promise((resolve) => { if (gz) { res.once('finish', resolve); res.once('close', resolve); gz.end(); } else res.end(resolve); });
  } finally { res.off('close', onClose); }
  return { rows: count, truncated };
}

// A trailing LIMIT n [OFFSET m] / LIMIT m, n on a SELECT, removed (so a preview query downloads every row).
function stripTrailingLimit(sql) {
  return String(sql).trim().replace(/;+\s*$/, '').replace(/\s+limit\s+(\d+\s*,\s*\d+|\d+(\s+offset\s+\d+)?)\s*$/i, '');
}

module.exports.writeDelimited = writeDelimited;
module.exports.stripTrailingLimit = stripTrailingLimit;
