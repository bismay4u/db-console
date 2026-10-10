// api/diff.js
// Compare two databases (or two tables) and produce the script that makes the target match the source.
//
// Schema: every table's SHOW CREATE TABLE is split into its elements (columns, keys, foreign keys,
// checks, table options) and compared element by element as text, so anything MySQL/MariaDB can
// express is compared faithfully without us modelling it. Views, procedures, functions, triggers and
// events are compared by definition.
//
// Data: rows are matched by key; a hash of each row's shared columns says which ones differ.

const crypto = require('crypto');
const mysqlUtil = require('mysql2');
const { getPool } = require('./db');
const permissions = require('./permissions');

const esc = (id) => mysqlUtil.escapeId(id);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const unq = (s) => s.replace(/``/g, '`');

// ---------- reading a database ----------

function parseCreateTable(text) {
  const lines = String(text).split('\n');
  let close = lines.length - 1;
  while (close > 0 && !/^\)/.test(lines[close])) close--;
  const t = { columns: [], keys: new Map(), fks: new Map(), checks: new Map(), other: new Map(), options: {}, partition: '' };
  for (const raw of lines.slice(1, close)) {
    const line = raw.trim().replace(/,$/, '');
    let m;
    if ((m = /^`((?:[^`]|``)+)`\s/.exec(line))) t.columns.push({ name: unq(m[1]), def: line });
    else if (/^PRIMARY KEY/i.test(line)) t.keys.set('PRIMARY', line);
    else if ((m = /^(?:UNIQUE |FULLTEXT |SPATIAL )?KEY `((?:[^`]|``)+)`/i.exec(line))) t.keys.set(unq(m[1]), line);
    else if ((m = /^CONSTRAINT `((?:[^`]|``)+)` FOREIGN KEY/i.exec(line))) t.fks.set(unq(m[1]), line);
    else if ((m = /^CONSTRAINT `((?:[^`]|``)+)` CHECK/i.exec(line))) t.checks.set(unq(m[1]), line);
    else t.other.set(line, line);
  }
  const tail = lines.slice(close).join('\n');
  const first = lines[close] || '';
  t.options = {
    engine: (/ENGINE=(\w+)/i.exec(first) || [])[1] || '',
    charset: (/DEFAULT CHARSET=(\w+)/i.exec(first) || [])[1] || '',
    collate: (/COLLATE=(\w+)/i.exec(first) || [])[1] || '',
    comment: (/COMMENT='((?:[^']|'')*)'/i.exec(first) || [])[1]
  };
  t.partition = /\n\s*(\/\*!\d+\s*)?PARTITION BY/i.test(tail) ? tail.slice(tail.search(/PARTITION BY/i)) : '';
  return t;
}

const stripDefiner = (sql) => sql.replace(/\bDEFINER\s*=\s*(`[^`]*`|[^\s@]+)@(`[^`]*`|[^\s]+)\s*/i, '').replace(/\/\*!\d+\s*DEFINER=[^*]*\*\/\s*/i, '');

async function loadSchema(key, database) {
  const pool = getPool(key);
  const conn = await pool.getConnection();
  try {
    await conn.query(`USE ${esc(database)}`);
    const [tbl] = await conn.query('SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [database]);
    const show = async (what, name) => { const [r] = await conn.query(`SHOW CREATE ${what} ${esc(name)}`); const row = r[0] || {}; const k = Object.keys(row).find((c) => /^Create /i.test(c) || c === 'SQL Original Statement'); return k ? String(row[k]) : ''; };
    const out = { tables: new Map(), views: new Map(), routines: new Map(), triggers: new Map(), events: new Map() };
    const qual = new RegExp('`' + database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/`/g, '``') + '`\\.', 'g');
    for (const t of tbl) {
      if (/VIEW/i.test(t.type)) {
        const def = stripDefiner(await show('VIEW', t.name)).replace(/\bALGORITHM\s*=\s*\w+\s*/i, '').replace(/\bSQL SECURITY\s+\w+\s*/i, '').replace(qual, '');
        out.views.set(t.name, def);
      } else {
        const text = await show('TABLE', t.name);
        out.tables.set(t.name, { ...parseCreateTable(text), create: text });
      }
    }
    const [routines] = await conn.query('SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [database]);
    for (const r of routines) out.routines.set(`${r.type}:${r.name}`, { type: r.type, name: r.name, def: stripDefiner(await show(r.type, r.name)).replace(qual, '') });
    const [triggers] = await conn.query('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', [database]);
    for (const r of triggers) out.triggers.set(r.name, stripDefiner(await show('TRIGGER', r.name)).replace(qual, ''));
    const [events] = await conn.query('SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?', [database]);
    for (const r of events) out.events.set(r.name, stripDefiner(await show('EVENT', r.name)).replace(qual, ''));
    return out;
  } finally { conn.destroy(); }
}

// ---------- comparing ----------
// phases: 1 drop foreign keys · 2 drop programmable objects/views · 3 drop tables · 4 create tables
//         5 alter tables · 6 add foreign keys · 7 create views, routines, triggers, events

function item(o) {
  const body = o.clause || (o.statements || []).join(';');
  return { destructive: false, ...o, id: sha(`${o.kind}|${o.action}|${o.table || ''}|${o.name}|${body}`) };
}

const noAutoInc = (create) => create.replace(/ AUTO_INCREMENT=\d+/i, '');

async function diffSchema(source, target, { drops = true } = {}) {
  const [a, b] = await Promise.all([loadSchema(source.key, source.database), loadSchema(target.key, target.database)]);
  const items = [];
  const q = esc;

  for (const [name, st] of a.tables) {
    const tt = b.tables.get(name);
    if (!tt) {
      items.push(item({ kind: 'table', action: 'create', table: name, name, phase: 4, description: `Create table ${name}`, statements: [noAutoInc(st.create)] }));
      continue;
    }
    // columns
    const tcols = new Map(tt.columns.map((c) => [c.name, c]));
    const scols = new Map(st.columns.map((c) => [c.name, c]));
    st.columns.forEach((c, i) => {
      const old = tcols.get(c.name);
      if (!old) {
        const pos = i === 0 ? ' FIRST' : ` AFTER ${q(st.columns[i - 1].name)}`;
        items.push(item({ kind: 'column', action: 'create', table: name, name: c.name, phase: 5, order: 20, description: `Add column ${name}.${c.name}`, clause: `ADD COLUMN ${c.def}${pos}` }));
      } else if (old.def !== c.def) {
        items.push(item({ kind: 'column', action: 'alter', table: name, name: c.name, phase: 5, order: 30, description: `Change column ${name}.${c.name}`, detail: `${old.def}\n→ ${c.def}`, clause: `MODIFY COLUMN ${c.def}` }));
      }
    });
    for (const c of tt.columns) if (!scols.has(c.name)) items.push(item({ kind: 'column', action: 'drop', table: name, name: c.name, phase: 5, order: 10, destructive: true, description: `Drop column ${name}.${c.name}`, clause: `DROP COLUMN ${q(c.name)}` }));
    // keys
    for (const [k, def] of st.keys) {
      const old = tt.keys.get(k);
      if (old === undefined) items.push(item({ kind: 'index', action: 'create', table: name, name: k, phase: 5, order: 40, description: `Add ${k === 'PRIMARY' ? 'primary key' : 'index ' + k} on ${name}`, clause: `ADD ${def}` }));
      else if (old !== def) {
        items.push(item({ kind: 'index', action: 'drop', table: name, name: k, phase: 5, order: 5, description: `Rebuild ${k === 'PRIMARY' ? 'primary key' : 'index ' + k} on ${name} (drop)`, detail: `${old}\n→ ${def}`, clause: k === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${q(k)}` }));
        items.push(item({ kind: 'index', action: 'create', table: name, name: k, phase: 5, order: 40, description: `Rebuild ${k === 'PRIMARY' ? 'primary key' : 'index ' + k} on ${name} (add)`, clause: `ADD ${def}` }));
      }
    }
    for (const [k] of tt.keys) if (!st.keys.has(k)) items.push(item({ kind: 'index', action: 'drop', table: name, name: k, phase: 5, order: 5, destructive: k === 'PRIMARY', description: `Drop ${k === 'PRIMARY' ? 'primary key' : 'index ' + k} on ${name}`, clause: k === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${q(k)}` }));
    // foreign keys
    for (const [k, def] of st.fks) {
      const old = tt.fks.get(k);
      if (old === undefined) items.push(item({ kind: 'foreign-key', action: 'create', table: name, name: k, phase: 6, description: `Add foreign key ${k} on ${name}`, clause: `ADD ${def}` }));
      else if (old !== def) {
        items.push(item({ kind: 'foreign-key', action: 'drop', table: name, name: k, phase: 1, description: `Rebuild foreign key ${k} on ${name} (drop)`, detail: `${old}\n→ ${def}`, clause: `DROP FOREIGN KEY ${q(k)}` }));
        items.push(item({ kind: 'foreign-key', action: 'create', table: name, name: k, phase: 6, description: `Rebuild foreign key ${k} on ${name} (add)`, clause: `ADD ${def}` }));
      }
    }
    for (const [k] of tt.fks) if (!st.fks.has(k)) items.push(item({ kind: 'foreign-key', action: 'drop', table: name, name: k, phase: 1, description: `Drop foreign key ${k} on ${name}`, clause: `DROP FOREIGN KEY ${q(k)}` }));
    // checks
    for (const [k, def] of st.checks) {
      const old = tt.checks.get(k);
      if (old === undefined) items.push(item({ kind: 'check', action: 'create', table: name, name: k, phase: 5, order: 50, description: `Add check ${k} on ${name}`, clause: `ADD ${def}` }));
      else if (old !== def) {
        items.push(item({ kind: 'check', action: 'drop', table: name, name: k, phase: 5, order: 6, description: `Rebuild check ${k} on ${name} (drop)`, clause: `DROP CONSTRAINT ${q(k)}` }));
        items.push(item({ kind: 'check', action: 'create', table: name, name: k, phase: 5, order: 50, description: `Rebuild check ${k} on ${name} (add)`, clause: `ADD ${def}` }));
      }
    }
    for (const [k] of tt.checks) if (!st.checks.has(k)) items.push(item({ kind: 'check', action: 'drop', table: name, name: k, phase: 5, order: 6, description: `Drop check ${k} on ${name}`, clause: `DROP CONSTRAINT ${q(k)}` }));
    // options
    const opt = [];
    if (st.options.engine && st.options.engine !== tt.options.engine) opt.push(`ENGINE=${st.options.engine}`);
    if (st.options.charset && st.options.charset !== tt.options.charset) opt.push(`DEFAULT CHARSET=${st.options.charset}`);
    if (st.options.collate && st.options.collate !== tt.options.collate) opt.push(`COLLATE=${st.options.collate}`);
    if ((st.options.comment || '') !== (tt.options.comment || '')) opt.push(`COMMENT='${st.options.comment || ''}'`);
    if (opt.length) items.push(item({ kind: 'option', action: 'alter', table: name, name: 'options', phase: 5, order: 60, description: `Change table options of ${name}`, detail: opt.join(', '), clause: opt.join(', ') }));
    if (st.partition !== tt.partition) items.push(item({ kind: 'option', action: 'alter', table: name, name: 'partitioning', phase: 8, description: `Partitioning of ${name} differs — not scripted`, detail: 'Change partitioning by hand.', clause: null, manual: true }));
  }
  if (drops) for (const [name] of b.tables) if (!a.tables.has(name)) items.push(item({ kind: 'table', action: 'drop', table: name, name, phase: 3, destructive: true, description: `Drop table ${name}`, statements: [`DROP TABLE ${q(name)}`] }));

  // views
  for (const [name, def] of a.views) {
    const old = b.views.get(name);
    if (old === undefined) items.push(item({ kind: 'view', action: 'create', name, phase: 7, description: `Create view ${name}`, statements: [def] }));
    else if (old !== def) items.push(item({ kind: 'view', action: 'alter', name, phase: 7, description: `Change view ${name}`, detail: `${old}\n→ ${def}`, statements: [def.replace(/^CREATE\s+(OR REPLACE\s+)?/i, 'CREATE OR REPLACE ')] }));
  }
  if (drops) for (const [name] of b.views) if (!a.views.has(name)) items.push(item({ kind: 'view', action: 'drop', name, phase: 2, destructive: true, description: `Drop view ${name}`, statements: [`DROP VIEW ${q(name)}`] }));
  // routines, triggers, events
  const progs = [['routines', null], ['triggers', 'TRIGGER'], ['events', 'EVENT']];
  for (const [bucket, fixed] of progs) {
    for (const [k, v] of a[bucket]) {
      const def = typeof v === 'string' ? v : v.def;
      const kind = fixed ? fixed.toLowerCase() : v.type.toLowerCase();
      const name = typeof v === 'string' ? k : v.name;
      const kw = fixed || v.type;
      const old = b[bucket].get(k);
      const oldDef = old === undefined ? undefined : (typeof old === 'string' ? old : old.def);
      if (oldDef === undefined) items.push(item({ kind, action: 'create', name, phase: 7, compound: true, description: `Create ${kind} ${name}`, statements: [def] }));
      else if (oldDef !== def) items.push(item({ kind, action: 'alter', name, phase: 7, compound: true, description: `Change ${kind} ${name}`, detail: 'The definition differs.', statements: [`DROP ${kw} ${q(name)}`, def] }));
    }
    if (drops) for (const [k, v] of b[bucket]) {
      if (a[bucket].has(k)) continue;
      const kind = fixed ? fixed.toLowerCase() : v.type.toLowerCase();
      const name = typeof v === 'string' ? k : v.name;
      items.push(item({ kind, action: 'drop', name, phase: 2, destructive: true, description: `Drop ${kind} ${name}`, statements: [`DROP ${fixed || v.type} ${q(name)}`] }));
    }
  }
  items.sort((x, y) => x.phase - y.phase || (x.table || x.name).localeCompare(y.table || y.name) || (x.order || 0) - (y.order || 0));
  return items;
}

// The statements for the chosen items, in a safe order: [{ sql, compound, kind }]
function compose(items) {
  const out = [];
  const groups = new Map();
  for (const it of items) {
    if (it.manual) continue;
    if (it.clause) {
      const k = `${it.phase}|${it.table}`;
      if (!groups.has(k)) { groups.set(k, { phase: it.phase, table: it.table, clauses: [], at: out.length }); out.push(groups.get(k)); }
      groups.get(k).clauses.push(it.clause);
    } else for (const s of it.statements) out.push({ phase: it.phase, sql: s, compound: Boolean(it.compound) });
  }
  return out.map((g) => (g.clauses ? { sql: `ALTER TABLE ${esc(g.table)} ${g.clauses.join(',\n  ')}`, compound: false } : g));
}

// Script text. Compound statements (BEGIN … END) get a DELIMITER so it can be pasted into a client.
function script(items) {
  const parts = compose(items);
  if (!parts.length) return '';
  const lines = ['SET FOREIGN_KEY_CHECKS=0;', ''];
  for (const p of parts) lines.push(p.compound ? `DELIMITER ;;\n${p.sql};;\nDELIMITER ;` : `${p.sql};`, '');
  lines.push('SET FOREIGN_KEY_CHECKS=1;');
  return lines.join('\n');
}

// Runs the chosen items on the target. Each statement is checked against `allowed`; stops at the first error.
async function applySchema(target, items, { allowed = null } = {}) {
  const parts = compose(items);
  for (const p of parts) { const denied = permissions.statementDenied(p.sql, allowed); if (denied) throw new Error(denied); }
  const conn = await getPool(target.key).getConnection();
  const done = [];
  try {
    await conn.query(`USE ${esc(target.database)}`);
    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    for (const p of parts) {
      try { await conn.query(p.sql); done.push(p.sql); } catch (e) {
        const err = new Error(`${e.message}\nStopped at: ${p.sql.slice(0, 200)}${done.length ? `\n${done.length} earlier statement(s) were already applied.` : ''}`);
        err.executed = done.length; throw err;
      }
    }
    return { executed: done.length };
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS=1').catch(() => {});
    conn.destroy();
  }
}

// ---------- data ----------

const HASHABLE_BLOB = /(blob|binary)/i;
const rowHashExpr = (cols) => `MD5(CONCAT_WS(CHAR(31), ${cols.map((c) => (HASHABLE_BLOB.test(c.type) ? `IFNULL(HEX(${esc(c.name)}), CHAR(0))` : `IFNULL(CAST(${esc(c.name)} AS CHAR), CHAR(0))`)).join(', ')}))`;

async function tableColumns(key, database, table) {
  const [rows] = await getPool(key).query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS colKey, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [database, table]);
  if (!rows.length) throw new Error(`Table not found: ${database}.${table}`);
  return rows;
}

const MAX_COMPARE_ROWS = 500000;
const MAX_SCRIPT_ROWS = 5000;

async function readHashes(key, database, table, keyCols, cols, where) {
  const pool = getPool(key);
  const keySql = keyCols.map((k) => `CAST(${esc(k)} AS CHAR)`).join(', ');
  const sql = `SELECT CONCAT_WS(CHAR(31), ${keySql}) AS k, ${rowHashExpr(cols)} AS h FROM ${esc(database)}.${esc(table)} ${where ? 'WHERE ' + where : ''}`;
  const conn = await pool.getConnection();
  const map = new Map();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const stream = conn.connection.query(sql).stream({ highWaterMark: 1000 });
    for await (const r of stream) {
      if (map.size >= MAX_COMPARE_ROWS) { stream.destroy(); throw new Error(`${database}.${table} has more than ${MAX_COMPARE_ROWS.toLocaleString()} rows to compare; narrow it with a WHERE condition`); }
      map.set(r.k, r.h);
    }
    await conn.query('COMMIT');
  } finally { conn.destroy(); }
  return map;
}

const fetchRows = async (key, database, table, keyCols, keys, cols) => {
  if (!keys.length) return [];
  const pool = getPool(key);
  const rows = [];
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    const where = slice.map(() => `(${keyCols.map((k) => `CAST(${esc(k)} AS CHAR) = ?`).join(' AND ')})`).join(' OR ');
    const params = slice.flatMap((k) => k.split('\x1f'));
    const [r] = await pool.query(`SELECT ${cols.map((c) => esc(c.name)).join(', ')} FROM ${esc(database)}.${esc(table)} WHERE ${where}`, params);
    rows.push(...r);
  }
  return rows;
};

const keyOf = (row, keyCols) => keyCols.map((k) => (row[k] === null ? '' : Buffer.isBuffer(row[k]) ? row[k].toString('hex') : String(row[k]))).join('\x1f');

async function diffData(source, target, { keyColumns, where, columns: wanted } = {}) {
  const [sc, tc] = await Promise.all([tableColumns(source.key, source.database, source.table), tableColumns(target.key, target.database, target.table)]);
  const tnames = new Set(tc.map((c) => c.name));
  const shared = sc.filter((c) => tnames.has(c.name) && !/\b(VIRTUAL|STORED|PERSISTENT|GENERATED)\b/i.test(c.extra || ''));
  const pk = Array.isArray(keyColumns) && keyColumns.length ? keyColumns : sc.filter((c) => c.colKey === 'PRI').map((c) => c.name);
  if (!pk.length) throw new Error('This table has no primary key — choose the column(s) that identify a row');
  for (const k of pk) if (!shared.some((c) => c.name === k)) throw new Error(`Key column ${k} must exist in both tables`);
  const cols = Array.isArray(wanted) && wanted.length ? shared.filter((c) => wanted.includes(c.name) || pk.includes(c.name)) : shared;
  const [ha, hb] = await Promise.all([readHashes(source.key, source.database, source.table, pk, cols, where), readHashes(target.key, target.database, target.table, pk, cols, where)]);

  const onlySource = []; const onlyTarget = []; const changed = [];
  for (const [k, h] of ha) { const o = hb.get(k); if (o === undefined) onlySource.push(k); else if (o !== h) changed.push(k); }
  for (const k of hb.keys()) if (!ha.has(k)) onlyTarget.push(k);
  const counts = { source: ha.size, target: hb.size, same: ha.size - onlySource.length - changed.length, onlySource: onlySource.length, onlyTarget: onlyTarget.length, changed: changed.length };

  // The rows themselves, for the first few of each kind and for the script.
  const SAMPLE = 100;
  const need = (arr) => arr.slice(0, MAX_SCRIPT_ROWS);
  const [srcRows, tgtOnly, srcChanged, tgtChanged] = await Promise.all([
    fetchRows(source.key, source.database, source.table, pk, need(onlySource), cols),
    fetchRows(target.key, target.database, target.table, pk, need(onlyTarget), cols),
    fetchRows(source.key, source.database, source.table, pk, need(changed), cols),
    fetchRows(target.key, target.database, target.table, pk, need(changed), cols)
  ]);
  const byKey = (rows) => new Map(rows.map((r) => [keyOf(r, pk), r]));
  const tChanged = byKey(tgtChanged);
  const changedRows = srcChanged.map((s) => {
    const t = tChanged.get(keyOf(s, pk)) || {};
    const diffCols = cols.filter((c) => !pk.includes(c.name) && String(Buffer.isBuffer(s[c.name]) ? s[c.name].toString('hex') : s[c.name]) !== String(Buffer.isBuffer(t[c.name]) ? t[c.name].toString('hex') : t[c.name]) || (s[c.name] === null) !== (t[c.name] === null)).map((c) => c.name);
    return { key: Object.fromEntries(pk.map((k) => [k, s[k]])), source: s, target: t, columns: diffCols };
  });

  const lit = (v) => (v === null || v === undefined ? 'NULL' : Buffer.isBuffer(v) ? `X'${v.toString('hex')}'` : mysqlUtil.escape(v));
  const tt = `${esc(target.database)}.${esc(target.table)}`;
  const stmts = { insert: [], update: [], delete: [] };
  for (const r of srcRows) stmts.insert.push(`INSERT INTO ${tt} (${cols.map((c) => esc(c.name)).join(', ')}) VALUES (${cols.map((c) => lit(r[c.name])).join(', ')})`);
  for (const r of changedRows) {
    if (!r.columns.length) continue;
    stmts.update.push(`UPDATE ${tt} SET ${r.columns.map((c) => `${esc(c)} = ${lit(r.source[c])}`).join(', ')} WHERE ${pk.map((k) => `${esc(k)} = ${lit(r.source[k])}`).join(' AND ')}`);
  }
  for (const r of tgtOnly) stmts.delete.push(`DELETE FROM ${tt} WHERE ${pk.map((k) => `${esc(k)} = ${lit(r[k])}`).join(' AND ')}`);
  const scriptTruncated = onlySource.length > MAX_SCRIPT_ROWS || changed.length > MAX_SCRIPT_ROWS || onlyTarget.length > MAX_SCRIPT_ROWS;
  const strip = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? `0x${v.slice(0, 16).toString('hex')}` : v]));
  return {
    keyColumns: pk, columns: cols.map((c) => c.name), notCompared: sc.filter((c) => !cols.some((x) => x.name === c.name)).map((c) => c.name),
    counts, scriptTruncated,
    onlySource: srcRows.slice(0, SAMPLE).map(strip), onlyTarget: tgtOnly.slice(0, SAMPLE).map(strip),
    changed: changedRows.slice(0, SAMPLE).map((r) => ({ key: r.key, columns: r.columns, source: strip(r.source), target: strip(r.target) })),
    statements: stmts
  };
}

// Applies the chosen kinds of change to the target in one transaction. `actions` = { insert, update, delete }.
async function applyData(target, diff, actions, { allowed = null } = {}) {
  const list = [];
  for (const k of ['insert', 'update', 'delete']) if (actions && actions[k]) list.push(...diff.statements[k].map((sql) => ({ sql, k })));
  if (!list.length) throw new Error('Nothing selected to apply');
  for (const p of list) { const denied = permissions.statementDenied(p.sql, allowed); if (denied) throw new Error(denied); }
  const conn = await getPool(target.key).getConnection();
  try {
    await conn.query('START TRANSACTION');
    for (const p of list) await conn.query(p.sql);
    await conn.query('COMMIT');
    return { executed: list.length };
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw new Error(`Nothing was changed. ${e.message}`);
  } finally { conn.release(); }
}

module.exports = { diffSchema, compose, script, applySchema, diffData, applyData };
