// api/params.js
// Query parameters:  SELECT * FROM orders WHERE status = {{status}} AND total > {{min=100}}
//
// A {{name}} outside quotes becomes a SQL literal: a number stays a number
// (no leading zeros), NULL stays NULL, anything else is quoted and escaped.
// Inside a quoted string  '%{{q}}%'  the value is escaped but not quoted.
// {{name=default}} supplies a default for when no value is given.
// Parameters inside comments are left alone. Values never become SQL text,
// only escaped literals, so a value can't add statements.

const mysql = require('mysql2');

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const TOKEN = new RegExp(`\\{\\{\\s*(${NAME})\\s*(?:=([^}]*))?\\}\\}`, 'y');

// Calls fn(index, length, name, defaultValue, quote) for every parameter token
// outside comments. `quote` is the quote character it sits inside, or ''.
function scan(sql, fn) {
  let i = 0;
  let quote = '';
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (quote) {
      if (c === '\\' && quote !== '`') { i += 2; continue; }
      if (c === quote) { if (n === quote) { i += 2; continue; } quote = ''; }
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '-' && n === '-' && /[\s]/.test(sql[i + 2] || ' ')) {
      const e = sql.indexOf('\n', i); i = e === -1 ? sql.length : e; continue;
    } else if (c === '#') {
      const e = sql.indexOf('\n', i); i = e === -1 ? sql.length : e; continue;
    } else if (c === '/' && n === '*') {
      const e = sql.indexOf('*/', i + 2); i = e === -1 ? sql.length : e + 2; continue;
    }
    if (c === '{' && n === '{') {
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(sql);
      if (m) { fn(i, m[0].length, m[1], m[2] === undefined ? undefined : m[2].trim(), quote); i += m[0].length; continue; }
    }
    i++;
  }
}

// [{ name, default }] in order of first appearance.
function extract(sql) {
  const seen = new Map();
  scan(String(sql), (idx, len, name, def) => {
    if (!seen.has(name)) seen.set(name, { name, default: def });
    else if (seen.get(name).default === undefined && def !== undefined) seen.get(name).default = def;
  });
  return [...seen.values()];
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function literal(value, quote) {
  const s = String(value);
  if (quote) return mysql.escape(s).slice(1, -1); // escaped, without the surrounding quotes
  if (NUMBER.test(s)) return s;
  if (/^null$/i.test(s)) return 'NULL';
  return mysql.escape(s);
}

// Returns the SQL with every parameter replaced. Throws if one has no value.
function apply(sql, values = {}) {
  sql = String(sql);
  const defaults = Object.fromEntries(extract(sql).map((p) => [p.name, p.default]));
  const missing = new Set();
  const spans = [];
  scan(sql, (idx, len, name, def, quote) => {
    let v = values[name];
    if (v === undefined || v === null || v === '') v = defaults[name];
    if (v === undefined) { missing.add(name); return; }
    spans.push([idx, len, literal(v, quote)]);
  });
  if (missing.size) throw new Error(`Missing value for parameter ${[...missing].map((m) => `{{${m}}}`).join(', ')}`);
  let out = '';
  let pos = 0;
  for (const [idx, len, text] of spans) { out += sql.slice(pos, idx) + text; pos = idx + len; }
  return out + sql.slice(pos);
}

module.exports = { extract, apply };
