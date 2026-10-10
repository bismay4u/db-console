// test/helpers.js
// Shared by the API tests. Each test file starts its own copy of the server on
// a free port with a throwaway data directory and config, against a MySQL /
// MariaDB server given by environment variables:
//
//   TEST_DB_HOST (127.0.0.1)  TEST_DB_PORT (3306)  TEST_DB_USER (root)  TEST_DB_PASS ('')
//
// The user needs full privileges (the tests create and drop databases and
// accounts). Use a throwaway server: the tests create databases named shop,
// diag, objt, bulk, big, anom, … and refuse to run if the server holds other
// databases (set TEST_FORCE=1 to skip that check).

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const DB = {
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT || 3306),
  user: process.env.TEST_DB_USER || 'root',
  password: process.env.TEST_DB_PASS || ''
};

// The mysql command-line client, for seeding and for checking what the app did.
function mysql(sql, database, { raw = false } = {}) {
  const args = ['-h', DB.host, '-P', String(DB.port), '-u', DB.user, '--default-character-set=utf8mb4', '-N', '-B'];
  if (database) args.push(database);
  const out = execFileSync('mysql', args, { input: sql, env: { ...process.env, MYSQL_PWD: DB.password }, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  return raw ? out : out.toString().trim();
}

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const OWN_DBS = /^(shop|diag|objt|bulk|big|big_\w+|anom|sch|sch2|sch_renamed|exp_src|exp_r\d|other|archive|restored|dbc_test_\w+)$/;
function assertSafeServer() {
  if (process.env.TEST_FORCE) return;
  const foreign = mysql('SHOW DATABASES').split('\n').filter((d) => d && !SYSTEM_DBS.has(d) && !OWN_DBS.test(d));
  if (foreign.length) {
    throw new Error(`Refusing to run: this server has databases the tests don't own (${foreign.slice(0, 5).join(', ')}). The tests create and drop databases; use a throwaway server or set TEST_FORCE=1.`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Starts the app. Returns { B (base URL), dir, dataDir, pid, stop() }.
async function startServer({ config = {}, env = {} } = {}) {
  assertSafeServer();
  mysql('CREATE DATABASE IF NOT EXISTS shop CHARACTER SET utf8mb4');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-test-'));
  const dataDir = path.join(dir, 'data');
  const port = await freePort();
  const cfg = {
    appAuth: { username: 'admin', password: 'admin123!' },
    sessionSecret: 'test-secret-' + Math.random().toString(36).slice(2) + '-0123456789',
    databases: [{ key: 'shop', label: 'Shop DB', host: DB.host, port: DB.port, user: DB.user, password: DB.password, database: 'shop' }],
    ...config
  };
  const cfgFile = path.join(dir, 'config.js');
  fs.writeFileSync(cfgFile, `module.exports = ${JSON.stringify(cfg)};`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, CONFIG_PATH: cfgFile, ...env }
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + log)), 15000);
    const onData = (d) => { log += d; if (/running at/.test(log)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
  child.removeAllListeners('exit');
  return {
    B: `http://localhost:${port}`, dir, dataDir, pid: child.pid, child, log: () => log, port,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000); child.on('exit', () => { clearTimeout(t); r(); }); });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function login(B, username = 'admin', password = 'admin123!') {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const cookie = r.headers.get('set-cookie');
  if (!cookie) throw new Error(`login failed for ${username}: ${r.status}`);
  return cookie.split(';')[0];
}

// Collects failed checks so a test reports all of them, not just the first.
const failures = [];
const check = (cond, message, extra) => {
  const detail = extra === undefined ? '' : ' — ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  if (!cond) failures.push(message + detail);
  if (process.env.TEST_VERBOSE) console.log((cond ? '✓ ' : '✗ ') + message + detail);
  return Boolean(cond);
};
function finish() {
  const f = failures.splice(0);
  assert.strictEqual(f.length, 0, `${f.length} check(s) failed:\n  ✗ ${f.join('\n  ✗ ')}`);
}

module.exports = { DB, ROOT, mysql, startServer, login, check, finish, assertSafeServer, freePort };
