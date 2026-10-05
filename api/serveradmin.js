// api/serveradmin.js
// Server-level tools for a connection (Adminer's "Process list",
// "Variables", "Status" and "Privileges"). Account names and passwords are
// always bound as parameters; privileges and scopes are checked against
// lists, so nothing from the request is pasted into SQL as-is.

const mysqlUtil = require('mysql2');
const { getPool } = require('./db');

const esc = (identifier) => mysqlUtil.escapeId(identifier);

const PRIVILEGES = [
  'ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES',
  'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'TRIGGER', 'EVENT',
  'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'GRANT OPTION',
  // server-wide only
  'PROCESS', 'RELOAD', 'SHUTDOWN', 'FILE', 'SUPER', 'SHOW DATABASES', 'CREATE USER', 'REPLICATION CLIENT', 'REPLICATION SLAVE'
];

async function processList(key) {
  const [rows] = await getPool(key).query('SHOW FULL PROCESSLIST');
  const [[me]] = await getPool(key).query('SELECT CONNECTION_ID() AS id');
  return rows.map((r) => ({
    id: r.Id, user: r.User, host: r.Host, db: r.db, command: r.Command,
    time: r.Time, state: r.State, info: r.Info, progress: r.Progress
  })).filter((r) => r.id !== me.id);
}

async function killProcess(key, id, { queryOnly = false, preview } = {}) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid process id');
  const sql = `KILL ${queryOnly ? 'QUERY ' : ''}${n}`;
  if (!preview) await getPool(key).query(sql);
  return { sql };
}

async function variables(key, kind = 'variables') {
  const sql = kind === 'status' ? 'SHOW GLOBAL STATUS' : 'SHOW GLOBAL VARIABLES';
  const [rows] = await getPool(key).query(sql);
  return rows.map((r) => ({ name: r.Variable_name, value: r.Value }));
}

function account(user, host) {
  const u = String(user ?? '');
  const h = String(host ?? '%') || '%';
  if (u.length > 128 || h.length > 255) throw new Error('User or host is too long');
  return { u, h };
}

// Accounts with their grants. Needs SELECT on mysql.user.
async function listAccounts(key) {
  const pool = getPool(key);
  const [rows] = await pool.query('SELECT User AS user, Host AS host FROM mysql.user ORDER BY User, Host');
  const accounts = [];
  for (const r of rows) {
    let grants = [];
    try {
      const [g] = await pool.query('SHOW GRANTS FOR ?@?', [r.user, r.host]);
      grants = g.map((x) => Object.values(x)[0]);
    } catch (e) {
      grants = [`(could not read grants: ${e.message})`];
    }
    accounts.push({ user: r.user, host: r.host, grants });
  }
  return accounts;
}

const mask = (sql, password) => (password ? sql.replace(mysqlUtil.escape(password), "'********'") : sql);

async function run(key, sql, params, preview, password) {
  const formatted = mysqlUtil.format(sql, params);
  if (!preview) {
    try {
      await getPool(key).query(formatted);
    } catch (err) {
      err.sql = mask(formatted, password); // for the query log
      throw err;
    }
  }
  return { sql: mask(formatted, password) };
}

async function createUser(key, { user, host, password, preview } = {}) {
  const { u, h } = account(user, host);
  if (!u) throw new Error('User name is required');
  return password
    ? run(key, 'CREATE USER ?@? IDENTIFIED BY ?', [u, h, String(password)], preview, String(password))
    : run(key, 'CREATE USER ?@?', [u, h], preview);
}

async function dropUser(key, { user, host, preview } = {}) {
  const { u, h } = account(user, host);
  return run(key, 'DROP USER ?@?', [u, h], preview);
}

async function setPassword(key, { user, host, password, preview } = {}) {
  const { u, h } = account(user, host);
  if (!password) throw new Error('Enter a new password');
  return run(key, 'ALTER USER ?@? IDENTIFIED BY ?', [u, h, String(password)], preview, String(password));
}

// action 'grant' | 'revoke'; scope: { db: '*' | name, table: '*' | name }
async function changeGrants(key, { action, user, host, privileges, db = '*', table = '*', preview } = {}) {
  if (!['grant', 'revoke'].includes(action)) throw new Error('Unknown action');
  const { u, h } = account(user, host);
  const privs = (privileges || []).map((p) => String(p).toUpperCase());
  if (!privs.length) throw new Error('Choose at least one privilege');
  privs.forEach((p) => { if (!PRIVILEGES.includes(p)) throw new Error(`Unknown privilege: ${p}`); });
  const onDb = db === '*' || !db ? '*' : esc(db);
  const onTable = table === '*' || !table ? '*' : esc(table);
  if (onDb === '*' && onTable !== '*') throw new Error('Choose a database for a table-level privilege');
  const scope = `${onDb}.${onTable}`;
  const grantOption = privs.includes('GRANT OPTION');
  const list = privs.filter((p) => p !== 'GRANT OPTION');
  let sql;
  if (action === 'grant') {
    if (!list.length) throw new Error('GRANT OPTION needs at least one other privilege');
    sql = `GRANT ${list.join(', ')} ON ${scope} TO ?@?${grantOption ? ' WITH GRANT OPTION' : ''}`;
  } else {
    sql = `REVOKE ${[...list, ...(grantOption ? ['GRANT OPTION'] : [])].join(', ')} ON ${scope} FROM ?@?`;
  }
  return run(key, sql, [u, h], preview);
}

module.exports = { PRIVILEGES, processList, killProcess, variables, listAccounts, createUser, dropUser, setPassword, changeGrants };
