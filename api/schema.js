// api/schema.js
// Schema editing for Explore (Adminer-style): databases, tables, columns,
// foreign keys, table maintenance and searching a whole database.
//
// Every change is built here as SQL from validated parts (identifiers are
// escaped, literals bound or escaped, keywords checked against lists) and
// can be previewed before it runs, so the UI always shows exactly what
// will be executed.

const mysqlUtil = require('mysql2');
const { getPool, getTableIndexes } = require('./db');

const esc = (identifier) => mysqlUtil.escapeId(identifier);
const lit = (value) => mysqlUtil.escape(value);

const FK_ACTIONS = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];
const TABLE_OPS = ['truncate', 'drop', 'optimize', 'analyze', 'check', 'repair', 'copy', 'move'];

// ---------- helpers ----------

const mariaCache = new Map();
async function isMariaDb(key) {
  if (!mariaCache.has(key)) {
    const [[row]] = await getPool(key).query('SELECT VERSION() AS v');
    mariaCache.set(key, /mariadb/i.test(row.v));
  }
  return mariaCache.get(key);
}

function word(value, what) {
  const s = String(value || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`Invalid ${what}: ${value}`);
  return s;
}

function name(value, what = 'name') {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${what[0].toUpperCase() + what.slice(1)} is required`);
  if (s.length > 64) throw new Error(`${what} is longer than 64 characters`);
  return s;
}

// Column types and default expressions are SQL fragments, so they are
// checked rather than escaped: no statement separators or comments
// outside quoted strings.
function stripQuoted(s) {
  return s.replace(/'([^'\\]|\\.|'')*'/g, "''");
}

function sqlFragment(value, what) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${what} is required`);
  if (s.length > 2000) throw new Error(`${what} is too long`);
  if (/;|--|\/\*|#/.test(stripQuoted(s))) throw new Error(`${what} contains characters that aren't allowed: ${s}`);
  return s;
}

function columnType(value) {
  const s = sqlFragment(value, 'Column type');
  if (!/^[a-z]/i.test(s)) throw new Error(`Invalid column type: ${s}`);
  return s;
}

async function runAll(key, statements) {
  const conn = await getPool(key).getConnection();
  const results = [];
  try {
    for (const sql of statements) {
      try {
        const [rows] = await conn.query(sql);
        results.push(Array.isArray(rows) ? rows : { affectedRows: rows.affectedRows });
      } catch (err) {
        err.sql = statements.join(';\n'); // for the query log
        throw err;
      }
    }
  } finally {
    conn.release();
  }
  return results;
}

// ---------- server metadata ----------

async function getServerMeta(key) {
  const pool = getPool(key);
  const [collations] = await pool.query(
    'SELECT COLLATION_NAME AS name, CHARACTER_SET_NAME AS charset, IS_DEFAULT AS isDefault FROM information_schema.COLLATIONS ORDER BY CHARACTER_SET_NAME, COLLATION_NAME'
  );
  const [engines] = await pool.query('SHOW ENGINES');
  const [[ver]] = await pool.query('SELECT VERSION() AS v, @@collation_server AS collation');
  return {
    version: ver.v,
    mariadb: /mariadb/i.test(ver.v),
    defaultCollation: ver.collation,
    collations: collations.map((c) => ({ name: c.name, charset: c.charset, isDefault: c.isDefault === 'Yes' })),
    engines: engines
      .filter((e) => e.Support === 'YES' || e.Support === 'DEFAULT')
      .map((e) => ({ name: e.Engine, isDefault: e.Support === 'DEFAULT' }))
  };
}

// ---------- databases ----------

async function getDatabaseInfo(key, database) {
  const [[row]] = await getPool(key).query(
    'SELECT DEFAULT_COLLATION_NAME AS collation, DEFAULT_CHARACTER_SET_NAME AS charset FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [database]
  );
  if (!row) throw new Error(`Database not found: ${database}`);
  return row;
}

async function createDatabase(key, { name: dbName, collation, preview }) {
  const n = name(dbName, 'database name');
  const sql = `CREATE DATABASE ${esc(n)}${collation ? ` COLLATE ${word(collation, 'collation')}` : ''}`;
  if (!preview) await runAll(key, [sql]);
  return { sql };
}

async function dropDatabase(key, database, { preview } = {}) {
  const sql = `DROP DATABASE ${esc(database)}`;
  if (!preview) await runAll(key, [sql]);
  return { sql };
}

// Changes the default collation and/or renames a database. MySQL has no
// RENAME DATABASE: like Adminer, a rename creates the new database, moves
// every table into it and drops the old one. Views, routines, triggers and
// events can't be moved that way, so a database with any is refused.
async function alterDatabase(key, database, { collation, rename, preview } = {}) {
  const statements = [];
  const info = await getDatabaseInfo(key, database);
  const newCollation = collation ? word(collation, 'collation') : null;
  const newName = rename && String(rename).trim() !== database ? name(rename, 'database name') : null;

  if (!newName) {
    if (!newCollation || newCollation === info.collation) throw new Error('Nothing changed');
    statements.push(`ALTER DATABASE ${esc(database)} COLLATE ${newCollation}`);
  } else {
    const pool = getPool(key);
    const [[counts]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'VIEW') AS views,
         (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?) AS routines,
         (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?) AS triggers,
         (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) AS events`,
      [database, database, database, database]
    );
    const blocking = Object.entries(counts).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${n} ${k}`);
    if (blocking.length) {
      throw new Error(`Can't rename a database that has ${blocking.join(', ')} — only tables can be moved. Export and import it instead.`);
    }
    const [tables] = await pool.query(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
      [database]
    );
    statements.push(`CREATE DATABASE ${esc(newName)} COLLATE ${newCollation || info.collation}`);
    if (tables.length) {
      statements.push('RENAME TABLE ' + tables.map((t) => `${esc(database)}.${esc(t.name)} TO ${esc(newName)}.${esc(t.name)}`).join(', '));
    }
    statements.push(`DROP DATABASE ${esc(database)}`);
  }

  if (!preview) await runAll(key, statements);
  return { sql: statements.join(';\n'), statements, database: newName || database };
}

// ---------- tables ----------

async function getTableInfo(key, database, table) {
  const [[row]] = await getPool(key).query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_COLLATION AS collation,
            TABLE_COMMENT AS comment, AUTO_INCREMENT AS autoIncrement, TABLE_ROWS AS approxRows,
            DATA_LENGTH AS dataLength, INDEX_LENGTH AS indexLength, CREATE_TIME AS createTime, UPDATE_TIME AS updateTime
     FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [database, table]
  );
  if (!row) throw new Error(`Table not found: ${table}`);
  return row;
}

// Full column details for the structure view and the table editor.
async function getColumnsDetailed(key, database, table) {
  const maria = await isMariaDb(key);
  const [rows] = await getPool(key).query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def,
            EXTRA AS extra, COLUMN_COMMENT AS comment, COLLATION_NAME AS collation, COLUMN_KEY AS colKey,
            GENERATION_EXPRESSION AS generation
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [database, table]
  );
  return rows.map((c) => {
    const nullable = c.nullable === 'YES';
    const extra = String(c.extra || '');
    return {
      name: c.name,
      type: c.type,
      nullable,
      default: parseDefault(c.def, extra, nullable, maria),
      autoIncrement: /auto_increment/i.test(extra),
      onUpdate: /on update/i.test(extra),
      comment: c.comment || '',
      collation: c.collation,
      key: c.colKey,
      generated: /GENERATED/i.test(extra) && /VIRTUAL|STORED|PERSISTENT/i.test(extra) ? { expression: c.generation, kind: /STORED|PERSISTENT/i.test(extra) ? 'STORED' : 'VIRTUAL' } : null,
      extra
    };
  });
}

// information_schema.COLUMNS.COLUMN_DEFAULT differs between servers:
//   MariaDB: 'NULL' = DEFAULT NULL, quoted = literal, unquoted = number or expression
//   MySQL:   literal unquoted; expressions flagged DEFAULT_GENERATED in EXTRA
function parseDefault(raw, extra, nullable, maria) {
  if (raw === null || raw === undefined) return nullable && !maria ? { mode: 'null' } : { mode: 'none' };
  const s = String(raw);
  if (maria) {
    if (s === 'NULL') return { mode: 'null' };
    if (s.startsWith("'")) return { mode: 'value', value: s.slice(1, -1).replace(/''/g, "'").replace(/\\(.)/g, '$1') };
    if (/^-?\d+(\.\d+)?$/.test(s)) return { mode: 'value', value: s };
    return { mode: 'expression', value: s };
  }
  if (/DEFAULT_GENERATED/i.test(extra)) return { mode: 'expression', value: s };
  return { mode: 'value', value: s };
}

// SQL for one column definition (used by CREATE TABLE and ALTER TABLE).
function columnDefSql(def) {
  const colName = name(def.name, 'column name');
  const type = columnType(def.type);
  let sql = `${esc(colName)} ${type}`;
  sql += def.nullable ? ' NULL' : ' NOT NULL';
  const d = def.default || { mode: 'none' };
  if (d.mode === 'null') {
    if (!def.nullable) throw new Error(`Column ${colName}: DEFAULT NULL needs the column to allow NULL`);
    sql += ' DEFAULT NULL';
  } else if (d.mode === 'value') {
    sql += ` DEFAULT ${lit(String(d.value ?? ''))}`;
  } else if (d.mode === 'expression') {
    sql += ` DEFAULT ${sqlFragment(d.value, `Default expression of ${colName}`)}`;
  } else if (d.mode !== 'none' && d.mode !== undefined) {
    throw new Error(`Invalid default for ${colName}`);
  }
  if (def.autoIncrement) sql += ' AUTO_INCREMENT';
  if (def.onUpdate) {
    const fsp = type.match(/^(timestamp|datetime)\s*\((\d)\)/i);
    sql += ` ON UPDATE CURRENT_TIMESTAMP${fsp ? `(${fsp[2]})` : ''}`;
  }
  if (def.comment) sql += ` COMMENT ${lit(String(def.comment))}`;
  return sql;
}

function positionSql(position) {
  if (!position) return '';
  if (position === 'FIRST') return ' FIRST';
  if (position.after) return ` AFTER ${esc(position.after)}`;
  return '';
}

function tableOptionsSql({ engine, collation, comment, autoIncrement }, forCreate) {
  const opts = [];
  if (engine) opts.push(`ENGINE=${word(engine, 'engine')}`);
  if (collation) opts.push(`${forCreate ? 'DEFAULT ' : ''}COLLATE=${word(collation, 'collation')}`);
  if (comment !== undefined && comment !== null) opts.push(`COMMENT=${lit(String(comment))}`);
  if (autoIncrement !== undefined && autoIncrement !== null && autoIncrement !== '') {
    const n = Number(autoIncrement);
    if (!Number.isInteger(n) || n < 1) throw new Error('AUTO_INCREMENT must be a positive whole number');
    opts.push(`AUTO_INCREMENT=${n}`);
  }
  return opts;
}

// spec: { name, columns: [def + { primary }], engine, collation, comment, preview }
async function createTable(key, database, spec) {
  const tableName = name(spec.name, 'table name');
  const cols = Array.isArray(spec.columns) ? spec.columns.filter((c) => c && String(c.name || '').trim()) : [];
  if (!cols.length) throw new Error('Add at least one column');
  const seen = new Set();
  const lines = cols.map((c) => {
    const lower = String(c.name).trim().toLowerCase();
    if (seen.has(lower)) throw new Error(`Duplicate column name: ${c.name}`);
    seen.add(lower);
    return columnDefSql(c);
  });
  const pk = cols.filter((c) => c.primary).map((c) => esc(String(c.name).trim()));
  if (pk.length) lines.push(`PRIMARY KEY (${pk.join(', ')})`);
  const opts = tableOptionsSql({ engine: spec.engine, collation: spec.collation, comment: spec.comment || undefined }, true);
  const sql = `CREATE TABLE ${esc(database)}.${esc(tableName)} (\n  ${lines.join(',\n  ')}\n)${opts.length ? ' ' + opts.join(' ') : ''}`;
  if (!spec.preview) await runAll(key, [sql]);
  return { sql, table: tableName };
}

// spec: {
//   rename, engine, collation, comment, autoIncrement,   // table options (omit = unchanged)
//   drop: [column names],
//   columns: [{ action: 'change', orig, def, position } | { action: 'add', def, position }]  (final order)
// }
async function alterTable(key, database, table, spec) {
  const current = await getColumnsDetailed(key, database, table);
  const currentNames = new Set(current.map((c) => c.name));
  const clauses = [];

  for (const d of spec.drop || []) {
    if (!currentNames.has(d)) throw new Error(`Unknown column: ${d}`);
    clauses.push(`DROP COLUMN ${esc(d)}`);
  }
  for (const c of spec.columns || []) {
    if (c.action === 'change') {
      if (!currentNames.has(c.orig)) throw new Error(`Unknown column: ${c.orig}`);
      if (current.find((x) => x.name === c.orig).generated) throw new Error(`Generated column ${c.orig} can't be edited here — use the Query Runner`);
      clauses.push(`CHANGE COLUMN ${esc(c.orig)} ${columnDefSql(c.def)}${positionSql(c.position)}`);
    } else if (c.action === 'add') {
      clauses.push(`ADD COLUMN ${columnDefSql(c.def)}${positionSql(c.position)}`);
    } else {
      throw new Error(`Unknown column action: ${c.action}`);
    }
  }

  const info = await getTableInfo(key, database, table);
  const opts = {};
  if (spec.engine && spec.engine !== info.engine) opts.engine = spec.engine;
  if (spec.collation && spec.collation !== info.collation) opts.collation = spec.collation;
  if (spec.comment !== undefined && spec.comment !== null && spec.comment !== (info.comment || '')) opts.comment = spec.comment;
  if (spec.autoIncrement !== undefined && spec.autoIncrement !== null && spec.autoIncrement !== '' && Number(spec.autoIncrement) !== Number(info.autoIncrement)) {
    opts.autoIncrement = spec.autoIncrement;
  }
  clauses.push(...tableOptionsSql(opts, false));

  let newName = null;
  if (spec.rename && String(spec.rename).trim() !== table) {
    newName = name(spec.rename, 'table name');
    clauses.push(`RENAME TO ${esc(database)}.${esc(newName)}`);
  }

  if (!clauses.length) throw new Error('Nothing changed');
  const sql = `ALTER TABLE ${esc(database)}.${esc(table)}\n  ${clauses.join(',\n  ')}`;
  if (!spec.preview) await runAll(key, [sql]);
  return { sql, table: newName || table };
}

// Bulk actions from the table list. Returns the statements and, for
// OPTIMIZE/ANALYZE/CHECK/REPAIR, the server's per-table messages.
async function tableAction(key, database, { action, tables, target, newName, withData = true, preview } = {}) {
  if (!TABLE_OPS.includes(action)) throw new Error(`Unknown action: ${action}`);
  if (!Array.isArray(tables) || !tables.length) throw new Error('Select at least one table');
  const pool = getPool(key);
  const [rows] = await pool.query(
    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [database]
  );
  const types = new Map(rows.map((r) => [r.name, r.type]));
  for (const t of tables) if (!types.has(t)) throw new Error(`Table not found: ${t}`);
  const base = tables.filter((t) => types.get(t) !== 'VIEW');
  const views = tables.filter((t) => types.get(t) === 'VIEW');
  const q = (t) => `${esc(database)}.${esc(t)}`;
  const statements = [];

  if (action === 'truncate') {
    if (views.length) throw new Error(`Views can't be truncated: ${views.join(', ')}`);
    base.forEach((t) => statements.push(`TRUNCATE TABLE ${q(t)}`));
  } else if (action === 'drop') {
    if (base.length) statements.push(`DROP TABLE ${base.map(q).join(', ')}`);
    if (views.length) statements.push(`DROP VIEW ${views.map(q).join(', ')}`);
  } else if (['optimize', 'analyze', 'check', 'repair'].includes(action)) {
    if (views.length && action !== 'check') throw new Error(`${action.toUpperCase()} doesn't apply to views: ${views.join(', ')}`);
    statements.push(`${action.toUpperCase()} TABLE ${tables.map(q).join(', ')}`);
  } else {
    const targetDb = name(target || database, 'target database');
    if (views.length) throw new Error(`Views can't be ${action === 'copy' ? 'copied' : 'moved'}: ${views.join(', ')}`);
    if (newName && base.length !== 1) throw new Error('A new name can only be given for a single table');
    const dest = (t) => `${esc(targetDb)}.${esc(newName ? name(newName, 'table name') : t)}`;
    if (targetDb === database && !newName) throw new Error(`Choose another database or a new name to ${action} into`);
    if (action === 'move') {
      statements.push('RENAME TABLE ' + base.map((t) => `${q(t)} TO ${dest(t)}`).join(', '));
    } else {
      for (const t of base) {
        statements.push(`CREATE TABLE ${dest(t)} LIKE ${q(t)}`);
        if (withData) statements.push(`INSERT INTO ${dest(t)} SELECT * FROM ${q(t)}`);
      }
    }
  }

  if (preview) return { sql: statements.join(';\n'), statements };
  const results = await runAll(key, statements);
  const messages = results.filter(Array.isArray).flat().map((r) => ({
    table: r.Table, op: r.Op, type: r.Msg_type, text: r.Msg_text
  }));
  return { sql: statements.join(';\n'), statements, messages };
}

// ---------- foreign keys ----------

const FK_SELECT = `SELECT k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col,
         k.REFERENCED_TABLE_SCHEMA AS refDb, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol,
         r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
  FROM information_schema.KEY_COLUMN_USAGE k
  JOIN information_schema.REFERENTIAL_CONSTRAINTS r
    ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
  WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL`;

function groupForeignKeys(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const id = `${r.tableName}\u0000${r.name}`;
    if (!byKey.has(id)) {
      byKey.set(id, { table: r.tableName, name: r.name, columns: [], refDb: r.refDb, refTable: r.refTable, refColumns: [], onUpdate: r.onUpdate, onDelete: r.onDelete });
    }
    byKey.get(id).columns.push(r.col);
    byKey.get(id).refColumns.push(r.refCol);
  }
  return [...byKey.values()];
}

async function getForeignKeys(key, database, table) {
  const [rows] = await getPool(key).query(`${FK_SELECT} AND k.TABLE_NAME = ? ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [database, table]);
  return groupForeignKeys(rows);
}

async function getDatabaseForeignKeys(key, database) {
  const [rows] = await getPool(key).query(`${FK_SELECT} ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [database]);
  return groupForeignKeys(rows);
}

// { drop: name, add: { name, columns, refDb, refTable, refColumns, onDelete, onUpdate }, preview }
async function alterForeignKey(key, database, table, { drop, add, preview } = {}) {
  if (!drop && !add) throw new Error('Nothing to change');
  const existing = await getForeignKeys(key, database, table);
  const dropped = drop ? existing.find((f) => f.name === drop) : null;
  if (drop && !dropped) throw new Error(`Foreign key not found: ${drop}`);

  let addSql = null;
  if (add) {
    const cols = (add.columns || []).filter(Boolean);
    const refCols = (add.refColumns || []).filter(Boolean);
    if (!cols.length) throw new Error('Choose at least one column');
    if (cols.length !== refCols.length) throw new Error('Choose a referenced column for every column');
    const tableCols = new Set((await getColumnsDetailed(key, database, table)).map((c) => c.name));
    cols.forEach((c) => { if (!tableCols.has(c)) throw new Error(`Unknown column: ${c}`); });
    const refDb = name(add.refDb || database, 'referenced database');
    const refTable = name(add.refTable, 'referenced table');
    const refTableCols = new Set((await getColumnsDetailed(key, refDb, refTable)).map((c) => c.name));
    if (!refTableCols.size) throw new Error(`Table not found: ${refDb}.${refTable}`);
    refCols.forEach((c) => { if (!refTableCols.has(c)) throw new Error(`Unknown column ${c} in ${refTable}`); });
    const onDelete = String(add.onDelete || 'RESTRICT').toUpperCase();
    const onUpdate = String(add.onUpdate || 'RESTRICT').toUpperCase();
    if (!FK_ACTIONS.includes(onDelete) || !FK_ACTIONS.includes(onUpdate)) throw new Error('Invalid ON DELETE / ON UPDATE action');
    const fkName = add.name ? name(add.name, 'foreign key name') : null;
    addSql = `ADD ${fkName ? `CONSTRAINT ${esc(fkName)} ` : ''}FOREIGN KEY (${cols.map(esc).join(', ')}) REFERENCES ${esc(refDb)}.${esc(refTable)} (${refCols.map(esc).join(', ')}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
  }

  const t = `${esc(database)}.${esc(table)}`;
  // Dropping and re-adding a constraint with the same name in one ALTER is
  // rejected by MySQL, so an edit that keeps the name runs as two statements.
  const statements = [];
  if (drop && add && (add.name || '') === drop) {
    // The server keeps the index it created for the old key under the same
    // name; if the columns change, the new key's index would clash with it.
    // Drop it too, but only if it covers exactly the old key's columns.
    let dropIndex = '';
    if (JSON.stringify(add.columns) !== JSON.stringify(dropped.columns)) {
      const idx = (await getTableIndexes(key, database, table)).find((i) => i.name === drop);
      if (idx && JSON.stringify(idx.parts.map((p) => p.column)) === JSON.stringify(dropped.columns)) dropIndex = `, DROP INDEX ${esc(drop)}`;
    }
    statements.push(`ALTER TABLE ${t} DROP FOREIGN KEY ${esc(drop)}${dropIndex}`, `ALTER TABLE ${t} ${addSql}`);
  } else {
    statements.push(`ALTER TABLE ${t} ${[drop ? `DROP FOREIGN KEY ${esc(drop)}` : null, addSql].filter(Boolean).join(', ')}`);
  }

  if (!preview) {
    await runAll(key, [statements[0]]);
    if (statements[1]) {
      try {
        await runAll(key, [statements[1]]);
      } catch (err) {
        // Put the original key back so a failed edit doesn't lose it.
        const orig = `ADD CONSTRAINT ${esc(dropped.name)} FOREIGN KEY (${dropped.columns.map(esc).join(', ')}) REFERENCES ${esc(dropped.refDb)}.${esc(dropped.refTable)} (${dropped.refColumns.map(esc).join(', ')}) ON DELETE ${dropped.onDelete} ON UPDATE ${dropped.onUpdate}`;
        await runAll(key, [`ALTER TABLE ${t} ${orig}`]).catch(() => {});
        throw err;
      }
    }
  }
  return { sql: statements.join(';\n'), statements };
}

// ---------- search a whole database ----------

function escapeLike(v) {
  return String(v).replace(/[\\%_]/g, (m) => '\\' + m);
}

// Counts the rows in every table where any column contains `term`.
async function searchDatabase(key, database, term, { maxTables = 500 } = {}) {
  const q = String(term || '').trim();
  if (!q) throw new Error('Enter something to search for');
  const pool = getPool(key);
  const [cols] = await pool.query(
    `SELECT c.TABLE_NAME AS tableName, c.COLUMN_NAME AS col, c.DATA_TYPE AS dataType
     FROM information_schema.COLUMNS c JOIN information_schema.TABLES t
       ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
     WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
     ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
    [database]
  );
  const byTable = new Map();
  for (const c of cols) {
    if (/blob|binary|geometry|point|polygon|linestring/i.test(c.dataType)) continue;
    if (!byTable.has(c.tableName)) byTable.set(c.tableName, []);
    byTable.get(c.tableName).push(c.col);
  }
  const pattern = `%${escapeLike(q)}%`;
  const results = [];
  let scanned = 0;
  for (const [tableName, columns] of byTable) {
    if (scanned++ >= maxTables) break;
    const where = columns.map((c) => `${esc(c)} LIKE ?`).join(' OR ');
    try {
      const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM ${esc(database)}.${esc(tableName)} WHERE ${where}`, columns.map(() => pattern));
      if (Number(row.n) > 0) results.push({ table: tableName, count: Number(row.n) });
    } catch (err) {
      results.push({ table: tableName, error: err.message });
    }
  }
  return { term: q, tablesSearched: Math.min(byTable.size, maxTables), results };
}

// ---------- views, procedures, functions, triggers, events ----------

const OBJECT_KINDS = { view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', event: 'EVENT' };
const CREATE_RE = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?(?:AGGREGATE\s+)?(VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:`[^`]+`|[\w$]+)(?:\s*\.\s*(?:`[^`]+`|[\w$]+))?)/i;

function stripComments(sql) {
  return String(sql).replace(/^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '');
}

function unquoteName(raw) {
  const last = raw.split(/\s*\.\s*/).pop();
  return last.startsWith('`') ? last.slice(1, -1).replace(/``/g, '`') : last;
}

// Runs statements on a dedicated connection with `database` selected (a
// CREATE PROCEDURE etc. without a database prefix goes there), then
// discards the connection.
async function runInDatabase(key, database, statements) {
  const conn = await getPool(key).getConnection();
  try {
    await conn.query(`USE ${esc(database)}`);
    for (const sql of statements) await conn.query(sql);
  } finally {
    conn.destroy();
  }
}

async function showCreate(key, database, kind, name) {
  const conn = await getPool(key).getConnection();
  try {
    await conn.query(`USE ${esc(database)}`);
    const [rows] = await conn.query(`SHOW CREATE ${OBJECT_KINDS[kind]} ${esc(name)}`);
    const row = rows[0] || {};
    const col = Object.keys(row).find((k) => /^Create /i.test(k) || k === 'SQL Original Statement');
    return col ? row[col] : null;
  } finally {
    conn.destroy();
  }
}

// Saves a view / procedure / function / trigger / event from its full CREATE
// statement (run as one statement — no DELIMITER needed). When `name` is
// given the existing object is replaced: it's dropped first and, if the new
// definition fails, recreated from its original definition.
async function saveObject(key, database, { kind, name, sql, preview } = {}) {
  const keyword = OBJECT_KINDS[kind];
  if (!keyword) throw new Error(`Unknown object type: ${kind}`);
  const body = String(sql || '').trim().replace(/;\s*$/, '');
  const m = CREATE_RE.exec(stripComments(body));
  if (!m) throw new Error(`The definition must be a single CREATE ${keyword} statement`);
  if (m[1].toUpperCase() !== keyword) throw new Error(`This is a CREATE ${m[1].toUpperCase()} statement, not CREATE ${keyword}`);
  if (/^\s*DELIMITER\b/im.test(body)) throw new Error('Leave out DELIMITER lines — the statement is run as a whole');
  const newName = unquoteName(m[2]);

  const statements = [];
  if (name) statements.push(`DROP ${keyword} IF EXISTS ${esc(name)}`);
  statements.push(body);
  const sqlText = statements.join(';\n');
  if (preview) return { sql: sqlText, name: newName };

  let original = null;
  if (name) original = await showCreate(key, database, kind, name);
  try {
    await runInDatabase(key, database, statements);
  } catch (err) {
    if (original) await runInDatabase(key, database, [original]).catch(() => {});
    err.sql = sqlText;
    throw err;
  }
  return { sql: sqlText, name: newName };
}

async function dropObject(key, database, { kind, name, preview } = {}) {
  const keyword = OBJECT_KINDS[kind];
  if (!keyword) throw new Error(`Unknown object type: ${kind}`);
  const sql = `DROP ${keyword} IF EXISTS ${esc(name)}`;
  if (!preview) await runInDatabase(key, database, [sql]);
  return { sql };
}

module.exports = {
  saveObject,
  dropObject,
  isMariaDb,
  getServerMeta,
  getDatabaseInfo,
  createDatabase,
  dropDatabase,
  alterDatabase,
  getTableInfo,
  getColumnsDetailed,
  createTable,
  alterTable,
  tableAction,
  getForeignKeys,
  getDatabaseForeignKeys,
  alterForeignKey,
  searchDatabase,
  FK_ACTIONS
};
