// api/scope.js
// Narrowing a share to some databases and hiding some tables from the people it is shared with.
//
//   conn.shareScopes = { "<username>" | "*": { databases: ["shop", "crm"], hideTables: ["users", "shop.payments"] } }
//
// Empty / missing means no limit. This is an application-level guard: the Explore pages hide what is hidden and
// refuse what is out of scope, and every Query Runner statement is read for the databases and tables it names. It
// does not replace database grants — a determined user with SQL access can still reach things through stored
// routines, views or dynamic SQL — so give the connection's database account only the privileges it should have.

const lower = (s) => String(s).toLowerCase();

function clean(map, names) {
  const out = {};
  for (const name of names) {
    const s = map && map[name];
    if (!s || typeof s !== 'object') continue;
    const list = (v, max) => [...new Set((Array.isArray(v) ? v : String(v || '').split(','))
      .map((x) => String(x).trim().replace(/`/g, '')).filter(Boolean))].slice(0, max).map((x) => x.slice(0, 130));
    const databases = list(s.databases, 100);
    const hideTables = list(s.hideTables, 300);
    if (databases.length || hideTables.length) out[name] = { databases, hideTables };
  }
  return out;
}

// The limits that apply to `username` on `conn`, or null. (Owners and admins are handled by the caller.)
function forUser(conn, username) {
  const m = conn.shareScopes || {};
  const s = m[username] || m['*'];
  if (!s) return null;
  const databases = (s.databases || []).map(lower);
  const hide = (s.hideTables || []).map(lower);
  return databases.length || hide.length ? { databases: databases.length ? databases : null, hideTables: hide } : null;
}

const dbAllowed = (scope, db) => !scope || !scope.databases || scope.databases.includes(lower(db));
const tableHidden = (scope, db, table) => Boolean(scope) && (scope.hideTables.includes(lower(table)) || scope.hideTables.includes(`${lower(db)}.${lower(table)}`));

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

// Blank comments and the inside of string literals; backtick-quoted identifiers stay.
function blank(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--[ \t][^\n]*|#[^\n]*)/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"/g, "''");
}

// null when the SQL stays inside the scope, otherwise the message to show. `currentDb` is where the statement runs.
function checkSql(scope, sql, currentDb, knownDatabases = []) {
  const known = new Set([...SYSTEM_SCHEMAS, ...knownDatabases.map(lower)]);
  if (!scope) return null;
  const text = blank(sql);
  const ident = '(?:`((?:[^`]|``)+)`|([A-Za-z_$][\\w$]*))';
  const unq = (m, a, b) => lower((m[a] || m[b] || '').replace(/``/g, '`'));
  if (scope.databases) {
    if (currentDb && !dbAllowed(scope, currentDb)) return `You can only work in: ${scope.databases.join(', ')}`;
    if (/\bshow\s+(databases|schemas)\b/i.test(text)) return `SHOW DATABASES is not available; you can only work in: ${scope.databases.join(', ')}`;
    for (const m of text.matchAll(new RegExp(`\\buse\\s+${ident}`, 'gi'))) {
      const db = unq(m, 1, 2);
      if (!scope.databases.includes(db)) return `You may not use the database ${db}`;
    }
    for (const m of text.matchAll(new RegExp(`${ident}\\s*\\.\\s*${ident}`, 'g'))) {
      const db = unq(m, 1, 2);
      // a.b where a is a table alias looks like db.table; only names that really are databases matter
      if (known.has(db) && !scope.databases.includes(db)) return `You may not use the database ${db}`;
    }
    if (/\b(information_schema|performance_schema)\b/i.test(text) && !scope.databases.some((d) => SYSTEM_SCHEMAS.has(d))) return 'The server\'s system schemas are not available to you';
  }
  if (scope.hideTables.length) {
    const hidden = new Set(scope.hideTables.map((h) => h.split('.').pop()));
    for (const m of text.matchAll(new RegExp(ident, 'g'))) {
      const name = unq(m, 1, 2);
      if (hidden.has(name)) return `The table ${name} is not available to you`;
    }
  }
  return null;
}

module.exports = { clean, forUser, dbAllowed, tableHidden, checkSql };
