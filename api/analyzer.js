// api/analyzer.js
// Database health check for Explore → "Analyze": looks at a database's
// structure and statistics and reports anomalies (tables without a primary
// key, missing / duplicate / redundant indexes, foreign keys that can't use
// an index, auto-increment columns about to overflow, …).
//
// Everything a rule needs is read once from information_schema into a
// "model"; built-in rules are functions over that model. Admins can switch
// built-in rules off, change their severity and thresholds, exclude tables,
// and add their own rules:
//   - sql:     a single read-only SELECT; every row it returns is a finding
//   - pattern: naming rules on tables, columns and indexes
// Rule settings live in <data dir>/analyzer_rules.json.

const path = require('path');
const crypto = require('crypto');
const mysqlUtil = require('mysql2');
const { DATA_DIR, readJson, writeJson, withLock } = require('./datadir');
const { getPool, splitStatements } = require('./db');
const permissions = require('./permissions');
const schema = require('./schema');

const RULES_FILE = path.join(DATA_DIR, 'analyzer_rules.json');
const DISMISSED_FILE = path.join(DATA_DIR, 'analyzer_dismissed.json');
const SEVERITIES = ['error', 'warning', 'info'];
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const MAX_FINDINGS_PER_RULE = 500;
const CUSTOM_SQL_ROWS = 200;

const esc = (id) => mysqlUtil.escapeId(id);
const num = (x) => Number(x || 0).toLocaleString('en-US');
function bytes(n) {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---------- The model ----------
async function collect(key, database) {
  const pool = getPool(key);
  const q = async (sql, params) => (await pool.query(sql, params))[0];
  const [tables, columns, stats, fks, schemata, events] = await Promise.all([
    q(`SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS tableRows, DATA_LENGTH AS dataLength,
              INDEX_LENGTH AS indexLength, DATA_FREE AS dataFree, AUTO_INCREMENT AS autoIncrement, TABLE_COLLATION AS collation,
              UPDATE_TIME AS updateTime
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [database]),
    q(`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, ORDINAL_POSITION AS position, DATA_TYPE AS dataType, COLUMN_TYPE AS type,
              IS_NULLABLE = 'YES' AS nullable, COLUMN_KEY AS columnKey, EXTRA AS extra, CHARACTER_SET_NAME AS charset,
              COLLATION_NAME AS collation, CHARACTER_MAXIMUM_LENGTH AS length
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [database]),
    q(`SELECT TABLE_NAME AS tableName, INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS columnName,
              SUB_PART AS subPart, INDEX_TYPE AS indexType, CARDINALITY AS cardinality
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [database]),
    schema.getDatabaseForeignKeys(key, database),
    q('SELECT DEFAULT_COLLATION_NAME AS collation, DEFAULT_CHARACTER_SET_NAME AS charset FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]),
    q('SELECT EVENT_NAME AS name, STATUS AS status FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?', [database]).catch(() => [])
  ]);

  const byName = new Map();
  for (const t of tables) {
    byName.set(t.name, {
      ...t,
      isView: /VIEW/i.test(t.type || ''),
      rows: Number(t.tableRows || 0),
      dataLength: Number(t.dataLength || 0), indexLength: Number(t.indexLength || 0), dataFree: Number(t.dataFree || 0),
      columns: [], indexes: [], fks: []
    });
  }
  for (const c of columns) {
    const t = byName.get(c.tableName);
    if (!t) continue;
    t.columns.push({
      ...c,
      nullable: Boolean(Number(c.nullable)),
      unsigned: /\bunsigned\b/i.test(c.type || ''),
      dataType: String(c.dataType || '').toLowerCase()
    });
  }
  const ixMap = new Map();
  for (const s of stats) {
    const id = `${s.tableName}\u0000${s.name}`;
    if (!ixMap.has(id)) {
      const t = byName.get(s.tableName);
      if (!t) continue;
      const ix = {
        name: s.name, table: s.tableName, primary: s.name === 'PRIMARY', unique: Number(s.nonUnique) === 0,
        type: String(s.indexType || 'BTREE').toUpperCase(), cardinality: s.cardinality === null ? null : Number(s.cardinality), cols: []
      };
      ix.special = ix.type === 'FULLTEXT' || ix.type === 'SPATIAL';
      ixMap.set(id, ix);
      t.indexes.push(ix);
    }
    ixMap.get(id).cols.push({ name: s.columnName, sub: s.subPart === null ? null : Number(s.subPart) });
  }
  for (const ix of ixMap.values()) ix.sig = ix.cols.map((c) => (c.sub ? `${c.name}(${c.sub})` : c.name));
  for (const fk of fks) {
    const t = byName.get(fk.table);
    if (t) t.fks.push(fk);
  }
  const list = [...byName.values()];
  return {
    database,
    dbCollation: schemata[0] ? schemata[0].collation : null,
    dbCharset: schemata[0] ? schemata[0].charset : null,
    tables: list.filter((t) => !t.isView),
    views: list.filter((t) => t.isView),
    byName,
    events
  };
}

// ---------- Helpers shared by rules ----------
const isPrefix = (a, b) => a.length <= b.length && a.every((x, i) => x === b[i]);
const btree = (t) => t.indexes.filter((ix) => !ix.special);
const csv = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const alter = (table, sql) => `ALTER TABLE ${esc(table)} ${sql}`;
const colList = (names) => names.map(esc).join(', ');

// first column of every index (PRIMARY included): a column that leads one can be searched by an index
const leadingColumns = (t) => new Set(t.indexes.map((ix) => ix.cols[0] && ix.cols[0].name));

const INT_MAX = { tinyint: [127n, 255n], smallint: [32767n, 65535n], mediumint: [8388607n, 16777215n], int: [2147483647n, 4294967295n], integer: [2147483647n, 4294967295n], bigint: [9223372036854775807n, 18446744073709551615n] };

const SENSITIVE_RE = /(^|_)(password|passwd|pwd|secret|token|api_?key|apikey|ssn|social_security|card_?number|credit_?card|cvv|iban)(_|$)/i;
const MONEY_RE = /(price|amount|cost|total|balance|salary|fee|tax|payment|revenue|rate|discount|charge)/i;

// ---------- Built-in rules ----------
// run(model, params, ctx) → [{ table, object, objectType, message, detail?, fix?, severity? }]
const BUILTIN = [
  {
    id: 'no-primary-key', category: 'Indexes', severity: 'error', title: 'Table without a primary key',
    description: 'Without a primary key rows can’t be addressed individually: editing and deleting rows in the grid is read-only, replication and many tools struggle, and InnoDB creates a hidden key.',
    run(m) {
      const out = [];
      for (const t of m.tables) {
        if (t.indexes.some((ix) => ix.primary)) continue;
        const notNull = (name) => (t.columns.find((c) => c.name === name) || {}).nullable === false;
        const candidate = t.indexes.find((ix) => ix.unique && !ix.special && ix.cols.every((c) => notNull(c.name) && !c.sub));
        out.push(candidate ? {
          table: t.name, object: t.name, objectType: 'table',
          message: `No primary key; unique index ${candidate.name} on (${candidate.cols.map((c) => c.name).join(', ')}) could be it`,
          fix: alter(t.name, `DROP INDEX ${esc(candidate.name)}, ADD PRIMARY KEY (${colList(candidate.cols.map((c) => c.name))})`)
        } : {
          table: t.name, object: t.name, objectType: 'table',
          message: 'No primary key and no unique NOT NULL index to use as one',
          fix: alter(t.name, 'ADD COLUMN `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST'),
          detail: 'Adding an id column rewrites the table. Pick the columns that really identify a row if there are any.'
        });
      }
      return out;
    }
  },
  {
    id: 'no-secondary-index', category: 'Indexes', severity: 'warning', title: 'Table with rows but no index besides the primary key',
    description: 'Any query that filters or joins on another column has to read the whole table.',
    params: [{ key: 'minRows', label: 'Minimum rows', type: 'number', default: 1000 }],
    run(m, p) {
      const out = [];
      for (const t of m.tables) {
        if (t.rows < p.minRows || btree(t).some((ix) => !ix.primary)) continue;
        const cands = t.columns.filter((c) => /(^|_)id$/i.test(c.name) && !t.indexes.some((ix) => ix.primary && ix.cols[0].name === c.name)).slice(0, 3);
        out.push({
          table: t.name, object: t.name, objectType: 'table',
          message: `~${num(t.rows)} rows and no index besides the primary key`,
          detail: cands.length ? `Likely lookup columns: ${cands.map((c) => c.name).join(', ')}` : undefined,
          fix: cands.length ? cands.map((c) => alter(t.name, `ADD INDEX ${esc('idx_' + c.name)} (${esc(c.name)})`)).join(';\n') : undefined
        });
      }
      return out;
    }
  },
  {
    id: 'unindexed-id-column', category: 'Indexes', severity: 'warning', title: 'Column that looks like a key, with no index',
    description: 'Columns named like “customer_id” are almost always used to look rows up or join tables. Without an index those queries scan the table.',
    params: [{ key: 'minRows', label: 'Minimum rows', type: 'number', default: 100 }],
    run(m, p) {
      const out = [];
      for (const t of m.tables) {
        if (t.rows < p.minRows) continue;
        const leading = leadingColumns(t);
        const fkCols = new Set(t.fks.flatMap((f) => f.columns));
        for (const c of t.columns) {
          if (!/(^|_)id$/i.test(c.name) || leading.has(c.name) || fkCols.has(c.name) || /text|blob|json/i.test(c.dataType)) continue;
          out.push({
            table: t.name, object: `${t.name}.${c.name}`, objectType: 'column',
            message: `${c.name} is not the first column of any index (~${num(t.rows)} rows)`,
            fix: alter(t.name, `ADD INDEX ${esc('idx_' + c.name)} (${esc(c.name)})`)
          });
        }
      }
      return out;
    }
  },
  {
    id: 'fk-without-index', category: 'Indexes', severity: 'warning', title: 'Foreign key without a usable index',
    description: 'Deleting or updating a parent row has to scan the child table when its foreign key columns are not the start of an index.',
    run(m) {
      const out = [];
      for (const t of m.tables) {
        for (const fk of t.fks) {
          if (btree(t).some((ix) => isPrefix(fk.columns, ix.cols.map((c) => c.name)))) continue;
          out.push({
            table: t.name, object: `${t.name}.${fk.name}`, objectType: 'foreign key',
            message: `Foreign key ${fk.name} (${fk.columns.join(', ')}) → ${fk.refTable} has no index starting with those columns`,
            fix: alter(t.name, `ADD INDEX ${esc('idx_' + fk.columns.join('_'))} (${colList(fk.columns)})`)
          });
        }
      }
      return out;
    }
  },
  {
    id: 'duplicate-index', category: 'Indexes', severity: 'warning', title: 'Duplicate index',
    description: 'Two indexes on exactly the same columns: every write maintains both and one of them is never needed.',
    run(m) {
      const out = [];
      for (const t of m.tables) {
        const rank = (ix) => (ix.primary ? 0 : ix.unique ? 1 : 2);
        const ixs = btree(t).slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
        const seen = new Map();
        for (const ix of ixs) {
          const k = ix.sig.join('\u0000');
          if (!seen.has(k)) { seen.set(k, ix); continue; }
          const keep = seen.get(k);
          out.push({
            table: t.name, object: `${t.name}.${ix.name}`, objectType: 'index',
            message: `Index ${ix.name} (${ix.sig.join(', ')}) duplicates ${keep.name}`,
            fix: alter(t.name, `DROP INDEX ${esc(ix.name)}`)
          });
        }
      }
      return out;
    }
  },
  {
    id: 'redundant-index', category: 'Indexes', severity: 'info', title: 'Redundant index (covered by a longer index)',
    description: 'An index on (a) is not needed when another index starts with (a, …): queries on (a) can use the longer one.',
    run(m) {
      const out = [];
      for (const t of m.tables) {
        const ixs = btree(t);
        for (const ix of ixs) {
          if (ix.primary || ix.unique) continue;
          const cover = ixs.find((o) => o !== ix && o.sig.length > ix.sig.length && isPrefix(ix.sig, o.sig));
          if (!cover) continue;
          out.push({
            table: t.name, object: `${t.name}.${ix.name}`, objectType: 'index',
            message: `Index ${ix.name} (${ix.sig.join(', ')}) is covered by ${cover.name} (${cover.sig.join(', ')})`,
            fix: alter(t.name, `DROP INDEX ${esc(ix.name)}`)
          });
        }
      }
      return out;
    }
  },
  {
    id: 'too-many-indexes', category: 'Indexes', severity: 'info', title: 'Table with many indexes',
    description: 'Every index slows inserts and updates and takes space.',
    params: [{ key: 'max', label: 'More than', type: 'number', default: 8 }],
    run(m, p) {
      return m.tables.filter((t) => t.indexes.filter((ix) => !ix.primary).length > p.max).map((t) => ({
        table: t.name, object: t.name, objectType: 'table',
        message: `${t.indexes.filter((ix) => !ix.primary).length} indexes besides the primary key`,
        detail: [...new Set(t.indexes.filter((ix) => !ix.primary).map((ix) => ix.name))].join(', ')
      }));
    }
  },
  {
    id: 'low-cardinality-index', category: 'Indexes', severity: 'info', title: 'Index with very few distinct values',
    description: 'An index on a column with a handful of distinct values (a status flag) is rarely chosen by the optimizer. Check that it is really used.',
    defaultEnabled: false,
    params: [{ key: 'minRows', label: 'Minimum rows', type: 'number', default: 10000 }, { key: 'maxRatioPct', label: 'Distinct values below (% of rows)', type: 'number', default: 1 }],
    run(m, p) {
      const out = [];
      for (const t of m.tables) {
        if (t.rows < p.minRows) continue;
        for (const ix of btree(t)) {
          if (ix.primary || ix.unique || ix.cols.length !== 1 || ix.cardinality === null) continue;
          if (ix.cardinality / t.rows * 100 < p.maxRatioPct) {
            out.push({ table: t.name, object: `${t.name}.${ix.name}`, objectType: 'index', message: `Index ${ix.name} has ~${num(ix.cardinality)} distinct values in ~${num(t.rows)} rows` });
          }
        }
      }
      return out;
    }
  },
  {
    id: 'autoinc-overflow', category: 'Design', severity: 'warning', title: 'Auto-increment column close to its maximum',
    description: 'When an AUTO_INCREMENT column reaches the largest value of its type, inserts start to fail.',
    params: [{ key: 'warnPct', label: 'Warn above (% used)', type: 'number', default: 70 }, { key: 'errorPct', label: 'Error above (% used)', type: 'number', default: 90 }],
    run(m, p) {
      const out = [];
      for (const t of m.tables) {
        if (t.autoIncrement === null || t.autoIncrement === undefined) continue;
        const col = t.columns.find((c) => /auto_increment/i.test(c.extra || ''));
        const limits = col && INT_MAX[col.dataType];
        if (!limits) continue;
        let used;
        try { used = BigInt(String(t.autoIncrement)); } catch (e) { continue; }
        const max = limits[col.unsigned ? 1 : 0];
        const pct = Number((used * 10000n) / max) / 100;
        if (pct < p.warnPct) continue;
        out.push({
          table: t.name, object: `${t.name}.${col.name}`, objectType: 'column', severity: pct >= p.errorPct ? 'error' : 'warning',
          message: `${col.name} (${col.type}) has used ${pct.toFixed(1)}% of its range (next value ${num(String(t.autoIncrement))})`,
          fix: col.dataType === 'bigint' ? undefined : alter(t.name, `MODIFY ${esc(col.name)} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`)
        });
      }
      return out;
    }
  },
  {
    id: 'fk-type-mismatch', category: 'Design', severity: 'error', title: 'Foreign key columns of different types',
    description: 'A foreign key between columns of different type, signedness, character set or collation can’t use its index for joins, and is slow or fails.',
    run(m) {
      const out = [];
      for (const t of m.tables) {
        for (const fk of t.fks) {
          if (fk.refDb !== m.database) continue;
          const ref = m.byName.get(fk.refTable);
          if (!ref) continue;
          fk.columns.forEach((cn, i) => {
            const a = t.columns.find((c) => c.name === cn);
            const b = ref.columns.find((c) => c.name === fk.refColumns[i]);
            if (!a || !b) return;
            const diffs = [];
            if (a.dataType !== b.dataType) diffs.push(`${a.type} vs ${b.type}`);
            else if (a.unsigned !== b.unsigned) diffs.push(`${a.type} vs ${b.type} (signedness)`);
            if (a.charset && b.charset && a.charset !== b.charset) diffs.push(`character set ${a.charset} vs ${b.charset}`);
            else if (a.collation && b.collation && a.collation !== b.collation) diffs.push(`collation ${a.collation} vs ${b.collation}`);
            if (diffs.length) out.push({ table: t.name, object: `${t.name}.${cn}`, objectType: 'column', message: `${t.name}.${cn} → ${ref.name}.${b.name}: ${diffs.join('; ')}` });
          });
        }
      }
      return out;
    }
  },
  {
    id: 'non-innodb', category: 'Design', severity: 'warning', title: 'Table not using an allowed storage engine',
    description: 'MyISAM and similar engines have no transactions or foreign keys and can lose data in a crash.',
    params: [{ key: 'allowed', label: 'Allowed engines (comma separated)', type: 'text', default: 'InnoDB' }],
    run(m, p) {
      const allowed = csv(p.allowed);
      return m.tables.filter((t) => t.engine && !allowed.includes(String(t.engine).toLowerCase())).map((t) => ({
        table: t.name, object: t.name, objectType: 'table', message: `Uses the ${t.engine} engine`,
        fix: alter(t.name, 'ENGINE=InnoDB')
      }));
    }
  },
  {
    id: 'float-money', category: 'Design', severity: 'warning', title: 'Money stored in a floating-point column',
    description: 'FLOAT and DOUBLE can’t store decimal fractions exactly, so sums and comparisons of prices drift. Use DECIMAL.',
    run(m) {
      const out = [];
      for (const t of m.tables) {
        for (const c of t.columns) {
          if (!['float', 'double', 'real'].includes(c.dataType) || !MONEY_RE.test(c.name)) continue;
          out.push({
            table: t.name, object: `${t.name}.${c.name}`, objectType: 'column', message: `${c.name} is ${c.type}`,
            fix: alter(t.name, `MODIFY ${esc(c.name)} DECIMAL(14,2)${c.nullable ? ' NULL' : ' NOT NULL'}`),
            detail: 'Choose the precision and scale your data needs before running this.'
          });
        }
      }
      return out;
    }
  },
  {
    id: 'legacy-charset', category: 'Design', severity: 'warning', title: 'Legacy character set',
    description: 'latin1 and 3-byte utf8 can’t store every character (emoji, many symbols). utf8mb4 is the standard.',
    params: [{ key: 'charsets', label: 'Flag these character sets', type: 'text', default: 'latin1,utf8,utf8mb3,ascii' }],
    run(m, p) {
      const bad = csv(p.charsets);
      const out = [];
      for (const t of m.tables) {
        const cols = t.columns.filter((c) => c.charset && bad.includes(String(c.charset).toLowerCase()));
        if (!cols.length) continue;
        out.push({
          table: t.name, object: t.name, objectType: 'table',
          message: `${cols.length} column(s) use ${[...new Set(cols.map((c) => c.charset))].join('/')}: ${cols.slice(0, 5).map((c) => c.name).join(', ')}${cols.length > 5 ? '…' : ''}`,
          fix: alter(t.name, 'CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'),
          detail: 'Back up first. Long indexed VARCHAR columns may need a shorter length (utf8mb4 uses up to 4 bytes per character).'
        });
      }
      return out;
    }
  },
  {
    id: 'collation-mismatch', category: 'Design', severity: 'info', title: 'Collation differs from the database default',
    description: 'Comparing or joining columns with different collations is an error or prevents index use, and mixed collations are usually accidental.',
    run(m) {
      const out = [];
      for (const t of m.tables) {
        const mismatched = t.columns.filter((c) => c.collation && t.collation && c.collation !== t.collation);
        if (t.collation && m.dbCollation && t.collation !== m.dbCollation) {
          out.push({ table: t.name, object: t.name, objectType: 'table', message: `Table collation ${t.collation} differs from the database default ${m.dbCollation}` });
        } else if (mismatched.length) {
          out.push({ table: t.name, object: t.name, objectType: 'table', message: `${mismatched.length} column(s) with a collation other than the table's ${t.collation}: ${mismatched.slice(0, 4).map((c) => `${c.name} (${c.collation})`).join(', ')}` });
        }
      }
      return out;
    }
  },
  {
    id: 'possible-missing-fk', category: 'Design', severity: 'info', title: 'Column that looks like a foreign key but isn’t one',
    description: 'A column like “customer_id” next to a “customers” table usually should be a foreign key, so the database rejects orphaned values.',
    run(m) {
      const out = [];
      const lower = new Map(m.tables.map((t) => [t.name.toLowerCase(), t]));
      for (const t of m.tables) {
        const fkCols = new Set(t.fks.flatMap((f) => f.columns));
        for (const c of t.columns) {
          const mm = /^(.+)_id$/i.exec(c.name);
          if (!mm || fkCols.has(c.name) || c.columnKey === 'PRI') continue;
          const base = mm[1].toLowerCase();
          const names = [base, base + 's', base + 'es', base.replace(/y$/, 'ies')];
          const ref = names.map((n) => lower.get(n)).find((r) => r && r !== t);
          if (!ref) continue;
          const pk = ref.indexes.find((ix) => ix.primary);
          if (!pk || pk.cols.length !== 1) continue;
          const pkCol = ref.columns.find((x) => x.name === pk.cols[0].name);
          if (!pkCol || pkCol.dataType !== c.dataType || pkCol.unsigned !== c.unsigned) continue;
          out.push({
            table: t.name, object: `${t.name}.${c.name}`, objectType: 'column',
            message: `${c.name} looks like a reference to ${ref.name}.${pkCol.name}, but has no foreign key`,
            fix: alter(t.name, `ADD CONSTRAINT ${esc(`fk_${t.name}_${c.name}`)} FOREIGN KEY (${esc(c.name)}) REFERENCES ${esc(ref.name)} (${esc(pkCol.name)})`),
            detail: 'Adding the constraint fails if some rows already hold values that don’t exist in the parent table.'
          });
        }
      }
      return out;
    }
  },
  {
    id: 'wide-table', category: 'Design', severity: 'info', title: 'Table with very many columns',
    description: 'Hundreds of columns are a sign the table mixes several things, and make every row read expensive.',
    params: [{ key: 'max', label: 'More than (columns)', type: 'number', default: 50 }],
    run(m, p) {
      return m.tables.filter((t) => t.columns.length > p.max).map((t) => ({ table: t.name, object: t.name, objectType: 'table', message: `${t.columns.length} columns` }));
    }
  },
  {
    id: 'sensitive-columns', category: 'Security', severity: 'info', title: 'Possibly sensitive columns',
    description: 'Lists columns whose names suggest passwords, tokens or card data, so you can check how they are stored.',
    defaultEnabled: false,
    run(m) {
      const out = [];
      for (const t of m.tables) {
        for (const c of t.columns) {
          if (!SENSITIVE_RE.test(c.name)) continue;
          const short = /password|passwd|pwd/i.test(c.name) && c.length && c.length < 60;
          out.push({
            table: t.name, object: `${t.name}.${c.name}`, objectType: 'column', severity: short ? 'warning' : undefined,
            message: short ? `${c.name} is ${c.type}: too short for a password hash (bcrypt needs 60 characters)` : `${c.name} (${c.type}) may hold sensitive data`
          });
        }
      }
      return out;
    }
  },
  {
    id: 'large-table', category: 'Storage', severity: 'info', title: 'Very large table',
    description: 'Tables this large benefit from archiving old rows, partitioning, and a careful look at their indexes.',
    params: [{ key: 'rows', label: 'At least (rows)', type: 'number', default: 10000000 }],
    run(m, p) {
      return m.tables.filter((t) => t.rows >= p.rows).map((t) => ({ table: t.name, object: t.name, objectType: 'table', message: `~${num(t.rows)} rows, ${bytes(t.dataLength + t.indexLength)}` }));
    }
  },
  {
    id: 'index-heavy', category: 'Storage', severity: 'info', title: 'Indexes much larger than the data',
    description: 'When indexes take far more space than the rows they point to, some of them are probably unnecessary.',
    params: [{ key: 'ratio', label: 'Index size ÷ data size above', type: 'number', default: 2 }, { key: 'minMb', label: 'Index size at least (MB)', type: 'number', default: 50 }],
    run(m, p) {
      return m.tables.filter((t) => t.indexLength >= p.minMb * 1048576 && t.indexLength > t.dataLength * p.ratio).map((t) => ({
        table: t.name, object: t.name, objectType: 'table', message: `Indexes take ${bytes(t.indexLength)}, the data ${bytes(t.dataLength)}`
      }));
    }
  },
  {
    id: 'fragmented', category: 'Storage', severity: 'info', title: 'Table with a lot of free space inside',
    description: 'After many deletes or updates a table file keeps empty space that OPTIMIZE TABLE gives back.',
    params: [{ key: 'minMb', label: 'Free space at least (MB)', type: 'number', default: 100 }, { key: 'pct', label: 'And at least (% of table)', type: 'number', default: 30 }],
    run(m, p) {
      return m.tables.filter((t) => {
        const total = t.dataLength + t.indexLength;
        return t.dataFree >= p.minMb * 1048576 && total > 0 && t.dataFree / (total + t.dataFree) * 100 >= p.pct;
      }).map((t) => ({
        table: t.name, object: t.name, objectType: 'table', message: `${bytes(t.dataFree)} of free space in a ${bytes(t.dataLength + t.indexLength)} table`,
        fix: `OPTIMIZE TABLE ${esc(t.name)}`
      }));
    }
  },
  {
    id: 'empty-table', category: 'Storage', severity: 'info', title: 'Empty table',
    description: 'Tables with no rows may be leftovers from old features or failed migrations.',
    defaultEnabled: false,
    async run(m, p, ctx) {
      const out = [];
      for (const t of m.tables.filter((x) => x.rows === 0).slice(0, 200)) {
        const [rows] = await ctx.pool.query(`SELECT 1 FROM ${esc(m.database)}.${esc(t.name)} LIMIT 1`);
        if (!rows.length) out.push({ table: t.name, object: t.name, objectType: 'table', message: 'No rows' });
      }
      return out;
    }
  },
  {
    id: 'stale-table', category: 'Storage', severity: 'info', title: 'Table not modified for a long time',
    description: 'Tables nobody writes to may be unused. (The server forgets modification times when it restarts, so only tables with a known time are listed.)',
    defaultEnabled: false,
    params: [{ key: 'days', label: 'Not modified for (days)', type: 'number', default: 365 }],
    run(m, p) {
      const cutoff = Date.now() - p.days * 86400000;
      return m.tables.filter((t) => t.updateTime && t.rows > 0 && new Date(t.updateTime).getTime() < cutoff).map((t) => ({
        table: t.name, object: t.name, objectType: 'table', message: `Last modified ${String(t.updateTime).slice(0, 10)} (~${num(t.rows)} rows)`
      }));
    }
  },
  {
    id: 'invalid-view', category: 'Objects', severity: 'error', title: 'View that no longer works',
    description: 'A view referring to a table or column that was dropped or renamed fails whenever it is used.',
    params: [{ key: 'max', label: 'Check at most (views)', type: 'number', default: 200 }],
    async run(m, p, ctx) {
      const out = [];
      for (const v of m.views.slice(0, p.max)) {
        try {
          const [rows] = await ctx.pool.query(`CHECK TABLE ${esc(m.database)}.${esc(v.name)}`);
          const bad = rows.find((r) => /^error$/i.test(r.Msg_type));
          if (bad) out.push({ table: v.name, object: v.name, objectType: 'view', message: bad.Msg_text });
        } catch (e) {
          out.push({ table: v.name, object: v.name, objectType: 'view', message: e.message });
        }
      }
      return out;
    }
  },
  {
    id: 'disabled-event', category: 'Objects', severity: 'info', title: 'Disabled event',
    description: 'Scheduled events that are switched off usually mean a job silently stopped running.',
    run(m) {
      return m.events.filter((e) => /disabled/i.test(e.status || '')).map((e) => ({ table: null, object: e.name, objectType: 'event', message: `Event ${e.name} is ${e.status}` }));
    }
  },

  // ---- Runtime rules: what the server is doing right now (need PROCESS for other users' sessions) ----
  {
    id: 'table-size-limit', category: 'Storage', severity: 'warning', title: 'Table over the size limit',
    description: 'A hard ceiling on table size (data + indexes) that you want to be warned about before disks or backups suffer.',
    params: [{ key: 'maxMb', label: 'Larger than (MB)', type: 'number', default: 10240 }],
    run(m, p) {
      return m.tables.filter((t) => (t.dataLength + t.indexLength) / 1048576 >= p.maxMb)
        .map((t) => ({ table: t.name, object: t.name, objectType: 'table', message: `${bytes(t.dataLength + t.indexLength)} (limit ${num(p.maxMb)} MB)` }));
    }
  },
  {
    id: 'long-transaction', category: 'Runtime', severity: 'warning', title: 'Transaction open for a long time',
    description: 'Long transactions hold locks, stop InnoDB from purging old row versions and make the history list grow.',
    params: [{ key: 'seconds', label: 'Open for more than (seconds)', type: 'number', default: 60 }],
    async run(m, p, ctx) {
      const [rows] = await ctx.pool.query(
        `SELECT trx_mysql_thread_id AS id, trx_started AS started, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age, trx_rows_modified AS modified, trx_query AS query
           FROM information_schema.INNODB_TRX WHERE TIMESTAMPDIFF(SECOND, trx_started, NOW()) > ? ORDER BY trx_started`, [p.seconds]);
      return rows.map((r) => ({
        table: null, object: `thread ${r.id}`, objectType: 'transaction',
        message: `Connection ${r.id} has had a transaction open for ${r.age}s (${num(r.modified)} row(s) modified)`,
        detail: r.query ? `Current statement: ${String(r.query).slice(0, 300)}` : 'It is idle — probably a client that forgot to COMMIT.',
        fix: `KILL ${Number(r.id)}`
      }));
    }
  },
  {
    id: 'lock-waits', category: 'Runtime', severity: 'warning', title: 'Statements waiting for a lock',
    description: 'A statement is blocked by another transaction right now. Short waits are normal; waits that last point to a long transaction or a missing index.',
    params: [{ key: 'seconds', label: 'Waiting more than (seconds)', type: 'number', default: 5 }],
    async run(m, p, ctx) {
      let rows;
      try {
        [rows] = await ctx.pool.query(
          `SELECT w.trx_mysql_thread_id AS waiting, TIMESTAMPDIFF(SECOND, w.trx_wait_started, NOW()) AS secs, w.trx_query AS waitingQuery,
                  b.trx_mysql_thread_id AS blocking, b.trx_query AS blockingQuery
             FROM information_schema.INNODB_LOCK_WAITS lw
             JOIN information_schema.INNODB_TRX w ON w.trx_id = lw.requesting_trx_id
             JOIN information_schema.INNODB_TRX b ON b.trx_id = lw.blocking_trx_id
            WHERE TIMESTAMPDIFF(SECOND, w.trx_wait_started, NOW()) >= ?`, [p.seconds]);
      } catch (e) {
        // MySQL 8 moved these tables to performance_schema
        [rows] = await ctx.pool.query(
          `SELECT r.trx_mysql_thread_id AS waiting, TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS secs, r.trx_query AS waitingQuery,
                  b.trx_mysql_thread_id AS blocking, b.trx_query AS blockingQuery
             FROM performance_schema.data_lock_waits w
             JOIN information_schema.INNODB_TRX r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
             JOIN information_schema.INNODB_TRX b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
            WHERE TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) >= ?`, [p.seconds]);
      }
      return rows.map((r) => ({
        table: null, object: `thread ${r.waiting}`, objectType: 'transaction',
        message: `Connection ${r.waiting} has waited ${r.secs}s for a lock held by connection ${r.blocking}`,
        detail: `Waiting: ${String(r.waitingQuery || '(none)').slice(0, 200)}\nBlocking transaction's current statement: ${String(r.blockingQuery || '(idle — it has not committed)').slice(0, 200)}`,
        fix: `KILL ${Number(r.blocking)}`
      }));
    }
  },
  {
    id: 'recent-deadlock', category: 'Runtime', severity: 'warning', title: 'Deadlock detected recently',
    description: 'InnoDB rolled back a transaction to break a deadlock. Occasional ones are normal; repeated ones need the code to take locks in the same order.',
    params: [{ key: 'hours', label: 'Within the last (hours)', type: 'number', default: 24 }],
    async run(m, p, ctx) {
      const [rows] = await ctx.pool.query('SHOW ENGINE INNODB STATUS');
      const text = String((rows[0] && (rows[0].Status || rows[0].status)) || '');
      const found = /LATEST DETECTED DEADLOCK\s*-+\s*(\d{4}-\d\d-\d\d\s+\d{1,2}:\d\d:\d\d)/.exec(text);
      if (!found) return [];
      const when = new Date(found[1].replace(' ', 'T').replace(/T(\d):/, 'T0$1:'));
      if (Number.isNaN(when.getTime()) || Date.now() - when.getTime() > p.hours * 3600000) return [];
      const section = text.slice(text.indexOf('LATEST DETECTED DEADLOCK'));
      const queries = [...section.matchAll(/^(?:update|insert|delete|select|replace)[^\n]*$/gim)].slice(0, 2).map((x) => x[0].slice(0, 200));
      return [{ table: null, object: `deadlock ${found[1]}`, objectType: 'transaction', message: `A deadlock was detected at ${found[1]}`, detail: queries.length ? `Statements involved:\n${queries.join('\n')}` : undefined }];
    }
  },
  {
    id: 'replication-lag', category: 'Runtime', severity: 'error', title: 'Replication lagging or stopped',
    description: 'On a replica: reads see old data when it falls behind, and a stopped thread means it is no longer following the primary.',
    params: [{ key: 'seconds', label: 'Behind by more than (seconds)', type: 'number', default: 60 }],
    async run(m, p, ctx) {
      let rows;
      try { [rows] = await ctx.pool.query('SHOW REPLICA STATUS'); } catch (e) { [rows] = await ctx.pool.query('SHOW SLAVE STATUS'); }
      const out = [];
      for (const r of rows) {
        const io = r.Replica_IO_Running || r.Slave_IO_Running; const sql = r.Replica_SQL_Running || r.Slave_SQL_Running;
        const lag = r.Seconds_Behind_Source ?? r.Seconds_Behind_Master;
        const err = r.Last_SQL_Error || r.Last_IO_Error;
        if (io !== 'Yes' || sql !== 'Yes') out.push({ table: null, object: 'replication', objectType: 'replication', severity: 'error', message: `Replication is not running (IO: ${io}, SQL: ${sql})`, detail: err || undefined });
        else if (lag !== null && lag !== undefined && Number(lag) > p.seconds) out.push({ table: null, object: 'replication', objectType: 'replication', severity: 'warning', message: `The replica is ${num(lag)} seconds behind` });
      }
      return out;
    }
  },
  {
    id: 'unused-index', category: 'Indexes', severity: 'info', title: 'Index that has never been used',
    description: 'Every index slows down writes and takes space. These have had no reads since the server started (needs performance_schema; only trustworthy after a long uptime).',
    params: [{ key: 'minUptimeDays', label: 'Only when the server has been up at least (days)', type: 'number', default: 7 }],
    async run(m, p, ctx) {
      const [[v]] = await ctx.pool.query("SELECT @@performance_schema AS ps");
      if (!Number(v.ps)) throw new Error('performance_schema is switched off on this server, so index usage is not recorded');
      const [[up]] = await ctx.pool.query("SHOW GLOBAL STATUS LIKE 'Uptime'");
      const days = Number(up.Value) / 86400;
      if (days < p.minUptimeDays) throw new Error(`the server has only been up ${days.toFixed(1)} days; index usage statistics need at least ${p.minUptimeDays}`);
      const [rows] = await ctx.pool.query(
        `SELECT OBJECT_NAME AS tableName, INDEX_NAME AS indexName FROM performance_schema.table_io_waits_summary_by_index_usage
          WHERE OBJECT_SCHEMA = ? AND INDEX_NAME IS NOT NULL AND INDEX_NAME <> 'PRIMARY' AND COUNT_STAR = 0`, [m.database]);
      const out = [];
      for (const r of rows) {
        const t = m.byName.get(r.tableName);
        const ix = t && t.indexes.find((i) => i.name === r.indexName);
        if (!ix || ix.unique) continue; // a unique index also enforces a rule
        out.push({ table: t.name, object: `${t.name}.${ix.name}`, objectType: 'index', message: `${ix.name} (${ix.sig.join(', ')}) has not been used since the server started ${days.toFixed(0)} days ago`, fix: alter(t.name, `DROP INDEX ${esc(ix.name)}`) });
      }
      return out;
    }
  },
];
const BUILTIN_BY_ID = new Map(BUILTIN.map((r) => [r.id, r]));

// ---------- Settings ----------
function loadConfig() {
  const cfg = readJson(RULES_FILE, {});
  return { builtin: cfg.builtin && typeof cfg.builtin === 'object' ? cfg.builtin : {}, custom: Array.isArray(cfg.custom) ? cfg.custom : [] };
}

function paramValues(rule, override = {}) {
  const out = {};
  for (const p of rule.params || []) {
    const v = override[p.key];
    out[p.key] = p.type === 'number' ? (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : p.default) : (typeof v === 'string' ? v : p.default);
  }
  return out;
}

function ruleView(rule, cfg, includeSql) {
  const o = cfg.builtin[rule.id] || {};
  return {
    id: rule.id, builtin: true, title: rule.title, description: rule.description, category: rule.category,
    severity: SEVERITIES.includes(o.severity) ? o.severity : rule.severity,
    defaultSeverity: rule.severity,
    enabled: o.enabled === undefined ? rule.defaultEnabled !== false : Boolean(o.enabled),
    defaultEnabled: rule.defaultEnabled !== false,
    params: (rule.params || []).map((p) => ({ ...p, value: paramValues(rule, o.params)[p.key] })),
    exclude: o.exclude || ''
  };
}

function listRules({ includeSql = false } = {}) {
  const cfg = loadConfig();
  return {
    builtin: BUILTIN.map((r) => ruleView(r, cfg, includeSql)),
    custom: cfg.custom.map((r) => (includeSql ? r : { ...r, sql: undefined }))
  };
}

function checkRegex(text, what) {
  const s = String(text || '');
  if (s.length > 200) throw new Error(`${what} is too long`);
  try { return new RegExp(s, 'i'); } catch (e) { throw new Error(`${what} is not a valid regular expression: ${e.message}`); }
}

function checkSql(sql) {
  const statements = splitStatements(String(sql || ''));
  if (statements.length !== 1) throw new Error('A rule runs exactly one SELECT statement');
  const s = statements[0];
  if (!/^\s*(\(\s*)*(select|with)\b/i.test(s.replace(/^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, ''))) throw new Error('The rule must be a SELECT statement');
  const denied = permissions.statementDenied(s, new Set());
  if (denied) throw new Error(denied.replace(/^Read-only access: /, ''));
  return s;
}

const clean = (s, max) => String(s ?? '').trim().slice(0, max);

function updateBuiltin(id, body = {}) {
  const rule = BUILTIN_BY_ID.get(id);
  if (!rule) return null;
  return withLock(() => {
    const cfg = readJson(RULES_FILE, {});
    cfg.builtin = cfg.builtin || {};
    const o = { ...(cfg.builtin[id] || {}) };
    if (body.enabled !== undefined) o.enabled = Boolean(body.enabled);
    if (body.severity !== undefined) {
      if (!SEVERITIES.includes(body.severity)) throw new Error('Severity must be error, warning or info');
      o.severity = body.severity;
    }
    if (body.exclude !== undefined) { if (body.exclude) checkRegex(body.exclude, 'The exclude pattern'); o.exclude = clean(body.exclude, 200); }
    if (body.params && typeof body.params === 'object') {
      o.params = { ...(o.params || {}) };
      for (const p of rule.params || []) {
        if (body.params[p.key] === undefined) continue;
        if (p.type === 'number') {
          const n = Number(body.params[p.key]);
          if (!Number.isFinite(n) || n < 0) throw new Error(`${p.label} must be a number`);
          o.params[p.key] = n;
        } else o.params[p.key] = clean(body.params[p.key], 200);
      }
    }
    cfg.builtin[id] = o;
    writeJson(RULES_FILE, cfg);
    return ruleView(rule, { builtin: cfg.builtin }, false);
  });
}

function normalizeCustom(body, existing) {
  const rule = {
    id: existing ? existing.id : `custom-${crypto.randomBytes(4).toString('hex')}`,
    builtin: false,
    title: clean(body.title, 120),
    description: clean(body.description, 500),
    category: clean(body.category, 40) || 'Custom',
    severity: SEVERITIES.includes(body.severity) ? body.severity : 'warning',
    enabled: body.enabled === undefined ? (existing ? existing.enabled !== false : true) : Boolean(body.enabled),
    kind: body.kind === 'pattern' ? 'pattern' : 'sql',
    exclude: clean(body.exclude, 200)
  };
  if (!rule.title) throw new Error('Give the rule a title');
  if (rule.exclude) checkRegex(rule.exclude, 'The exclude pattern');
  if (rule.kind === 'sql') {
    rule.sql = checkSql(body.sql);
  } else {
    rule.target = ['table', 'column', 'index', 'table-needs-column'].includes(body.target) ? body.target : 'table';
    rule.pattern = clean(body.pattern, 200);
    if (!rule.pattern) throw new Error('Enter a pattern');
    checkRegex(rule.pattern, 'The pattern');
    rule.mode = body.mode === 'must-not-match' ? 'must-not-match' : 'must-match';
    rule.typePattern = clean(body.typePattern, 200);
    if (rule.typePattern) checkRegex(rule.typePattern, 'The data type pattern');
  }
  return rule;
}

function saveCustom(body, id) {
  return withLock(() => {
    const cfg = readJson(RULES_FILE, {});
    cfg.custom = Array.isArray(cfg.custom) ? cfg.custom : [];
    const idx = id ? cfg.custom.findIndex((r) => r.id === id) : -1;
    if (id && idx === -1) return null;
    if (cfg.custom.length >= 100 && idx === -1) throw new Error('Too many custom rules');
    const rule = normalizeCustom(body, idx === -1 ? null : cfg.custom[idx]);
    if (idx === -1) cfg.custom.push(rule); else cfg.custom[idx] = rule;
    writeJson(RULES_FILE, cfg);
    return rule;
  });
}

function deleteCustom(id) {
  return withLock(() => {
    const cfg = readJson(RULES_FILE, {});
    const next = (cfg.custom || []).filter((r) => r.id !== id);
    if (next.length === (cfg.custom || []).length) return false;
    cfg.custom = next;
    writeJson(RULES_FILE, cfg);
    return true;
  });
}

// ---------- Custom rules ----------
async function runCustomSql(rule, ctx) {
  const conn = await ctx.pool.getConnection();
  try {
    await conn.query(`USE ${esc(ctx.database)}`);
    await conn.query('SET @db = ?', [ctx.database]);
    await conn.query('SET SESSION max_statement_time = 10').catch(() => {}); // MariaDB (seconds)
    await conn.query('SET SESSION max_execution_time = 10000').catch(() => {}); // MySQL (milliseconds)
    await conn.query('START TRANSACTION READ ONLY');
    const [rows] = await conn.query(checkSql(rule.sql));
    if (!Array.isArray(rows)) throw new Error('The rule did not return rows');
    return rows.slice(0, CUSTOM_SQL_ROWS).map((r) => {
      const keys = Object.keys(r);
      const pick = (n) => (r[n] !== undefined && r[n] !== null ? String(r[n]) : undefined);
      const object = pick('object') || pick('table') || pick('table_name') || (keys.length ? String(r[keys[0]]) : rule.title);
      const sev = pick('severity');
      return {
        table: pick('table') || pick('table_name') || (ctx.model.byName.has(object.split('.')[0]) ? object.split('.')[0] : null),
        object, objectType: pick('type') || 'object',
        message: pick('message') || rule.title, detail: pick('detail'), fix: pick('fix'),
        severity: SEVERITIES.includes(sev) ? sev : undefined
      };
    });
  } finally {
    conn.destroy(); // session variables and the READ ONLY transaction were set on it
  }
}

function runPattern(rule, m) {
  const re = new RegExp(rule.pattern, 'i');
  const typeRe = rule.typePattern ? new RegExp(rule.typePattern, 'i') : null;
  const flag = (matches) => (rule.mode === 'must-not-match' ? matches : !matches);
  const out = [];
  const say = (what) => (rule.mode === 'must-not-match' ? `${what} matches /${rule.pattern}/` : `${what} doesn’t match /${rule.pattern}/`);
  for (const t of m.tables) {
    if (rule.target === 'table') {
      if (flag(re.test(t.name))) out.push({ table: t.name, object: t.name, objectType: 'table', message: say(`Table ${t.name}`) });
    } else if (rule.target === 'column') {
      for (const c of t.columns) {
        if (typeRe && !typeRe.test(c.type)) continue;
        if (flag(re.test(c.name))) out.push({ table: t.name, object: `${t.name}.${c.name}`, objectType: 'column', message: say(`Column ${c.name}`) });
      }
    } else if (rule.target === 'index') {
      for (const ix of t.indexes.filter((x) => !x.primary)) {
        if (flag(re.test(ix.name))) out.push({ table: t.name, object: `${t.name}.${ix.name}`, objectType: 'index', message: say(`Index ${ix.name}`) });
      }
    } else if (rule.target === 'table-needs-column') {
      const has = t.columns.some((c) => re.test(c.name) && (!typeRe || typeRe.test(c.type)));
      if (!has) out.push({ table: t.name, object: t.name, objectType: 'table', message: `No column matching /${rule.pattern}/` });
    }
  }
  return out;
}

// ---------- Running ----------
function toFindings(rule, items, view) {
  let skip = null;
  if (view.exclude) skip = checkRegex(view.exclude, 'exclude');
  return items
    .filter((it) => !(skip && it.table && skip.test(it.table)))
    .slice(0, MAX_FINDINGS_PER_RULE)
    .map((it) => ({
      rule: rule.id, ruleTitle: rule.title, category: rule.category,
      severity: SEVERITIES.includes(it.severity) ? it.severity : view.severity,
      table: it.table || null, object: it.object, objectType: it.objectType || 'object',
      message: it.message, detail: it.detail, fix: it.fix
    }));
}

// ---------- Dismissed findings ----------
// "We know, it's fine": hidden from the results (and from the counts, and from scheduled analyses)
// until someone restores it. Per connection + database + rule + object.
const dismissedFor = (key, database) => readJson(DISMISSED_FILE).filter((d) => d.conn === key && d.database === database);

function dismiss(key, database, { rule, object, reason }, by) {
  if (!rule || !object) throw new Error('rule and object are required');
  return withLock(() => {
    const all = readJson(DISMISSED_FILE).filter((d) => !(d.conn === key && d.database === database && d.rule === rule && d.object === object));
    const entry = { conn: key, database, rule: String(rule), object: String(object), reason: String(reason || '').trim().slice(0, 500), by, at: new Date().toISOString() };
    all.push(entry);
    writeJson(DISMISSED_FILE, all);
    return entry;
  });
}

function restore(key, database, rule, object) {
  return withLock(() => {
    const all = readJson(DISMISSED_FILE);
    const rest = all.filter((d) => !(d.conn === key && d.database === database && d.rule === rule && d.object === object));
    writeJson(DISMISSED_FILE, rest);
    return rest.length !== all.length;
  });
}

async function analyze(key, database, { only } = {}) {
  const started = Date.now();
  const cfg = loadConfig();
  const model = await collect(key, database);
  const ctx = { key, database, pool: getPool(key), model };
  const findings = [];
  const skipped = [];
  let rulesRun = 0;

  for (const rule of BUILTIN) {
    const view = ruleView(rule, cfg, false);
    if (!view.enabled || (only && !only.includes(rule.id))) continue;
    const params = Object.fromEntries(view.params.map((p) => [p.key, p.value]));
    try {
      findings.push(...toFindings(rule, (await rule.run(model, params, ctx)) || [], view));
      rulesRun++;
    } catch (e) {
      skipped.push({ id: rule.id, rule: rule.title, reason: e.message });
    }
  }
  for (const rule of cfg.custom) {
    if (rule.enabled === false || (only && !only.includes(rule.id))) continue;
    try {
      const items = rule.kind === 'pattern' ? runPattern(rule, model) : await runCustomSql(rule, ctx);
      findings.push(...toFindings(rule, items, rule));
      rulesRun++;
    } catch (e) {
      skipped.push({ id: rule.id, rule: rule.title, reason: e.message });
    }
  }

  const hidden = dismissedFor(key, database);
  const dismissed = [];
  if (hidden.length) {
    for (let i = findings.length - 1; i >= 0; i--) {
      const d = hidden.find((x) => x.rule === findings[i].rule && x.object === findings[i].object);
      if (d) dismissed.push({ ...findings.splice(i, 1)[0], reason: d.reason, dismissedBy: d.by, dismissedAt: d.at });
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || String(a.table).localeCompare(String(b.table)) || a.ruleTitle.localeCompare(b.ruleTitle) || String(a.object).localeCompare(String(b.object)));
  const summary = { error: 0, warning: 0, info: 0, total: findings.length };
  for (const f of findings) summary[f.severity]++;
  return {
    database, ranAt: new Date().toISOString(), durationMs: Date.now() - started,
    tables: model.tables.length, views: model.views.length, rulesRun, summary, findings, dismissed, skipped
  };
}

// Tries a rule that hasn't been saved yet (admin editor), on one database.
async function testRule(key, database, body) {
  const rule = normalizeCustom({ ...body, enabled: true }, null);
  const model = await collect(key, database);
  const ctx = { key, database, pool: getPool(key), model };
  const items = rule.kind === 'pattern' ? runPattern(rule, model) : await runCustomSql(rule, ctx);
  return { findings: toFindings(rule, items, rule), tables: model.tables.length };
}

module.exports = { dismiss, restore, analyze, listRules, updateBuiltin, saveCustom, deleteCustom, testRule, BUILTIN };
