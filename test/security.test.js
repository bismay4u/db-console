// Security basics: encrypted secrets, IP allow-list, idle timeout, sign-in log, CSV exports.
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('./helpers');
const { check, finish } = T;

const jsonReq = (B, cookie) => async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d, headers: r.headers };
};

test('secrets are encrypted at rest and migrated from plain text', { timeout: 60000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-sec-'));
  const env = { ...process.env, DATA_DIR: dir, DBC_ENCRYPTION_KEY: 'a-long-test-passphrase' };
  try {
    fs.writeFileSync(path.join(dir, 'connections.json'), JSON.stringify([{ key: 'c1', label: 'C1', host: 'h', port: 3306, user: 'u', password: 'plain-pw-123', database: 'd', owner: 'admin', sharedWith: [] }]));
    const run = (code) => execFileSync(process.execPath, ['-e', code], { cwd: T.ROOT, env }).toString().trim();
    run("require('./api/store').ensureStore()");
    const raw = fs.readFileSync(path.join(dir, 'connections.json'), 'utf8');
    check(!raw.includes('plain-pw-123') && raw.includes('enc:v1:'), 'plain-text password is encrypted on start', raw.slice(0, 200));
    check(run("console.log(require('./api/store').getConnection('c1').password)") === 'plain-pw-123', 'decrypts transparently');
    // wrong key: the connection is flagged, not crashed
    const out = execFileSync(process.execPath, ['-e', "const c=require('./api/store').getConnection('c1');console.log(JSON.stringify({p:c.password,e:!!c.secretError}))"], { cwd: T.ROOT, env: { ...env, DBC_ENCRYPTION_KEY: 'a-different-passphrase' } }).toString().trim();
    check(out === '{"p":"","e":true}', 'wrong key flags secretError and leaves the password empty', out);
    const again = fs.readFileSync(path.join(dir, 'connections.json'), 'utf8');
    check(again === raw, 'wrong key does not rewrite the file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  finish();
});

test('IP allow-list, /health exemption, sign-in log, CSV, idle timeout', { timeout: 120000 }, async () => {
  const srv = await T.startServer({ config: { allowedIps: ['10.9.9.0/24'], idleMinutes: 0.02 } });
  try {
    let r = await fetch(srv.B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check(r.status === 403, 'address outside the list is refused', r.status);
    r = await fetch(srv.B + '/health');
    check(r.status !== 403, '/health is exempt from the allow-list', r.status);
  } finally { await srv.stop(); }

  const s2 = await T.startServer({ config: { idleMinutes: 0.02 } });
  try {
    const bad = await fetch(s2.B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'nope' }) });
    check(bad.status === 401, 'bad password is 401', bad.status);
    const cookie = await T.login(s2.B);
    const api = jsonReq(s2.B, cookie);
    let q = await api('POST', '/api/query', { dbKeys: ['shop'], sql: 'SELECT 1', databases: { shop: 'shop' } });
    check(q.status === 200, 'query works while active', q.status);
    const log = await api('GET', '/api/auth-log');
    const events = log.data.entries.map((e) => e.event);
    check(events.includes('login_failed') && events.includes('login_ok'), 'sign-in events recorded', events);
    check(log.data.summary.failed >= 1 && log.data.summary.successful >= 1, 'summary counts', log.data.summary);
    const csv = await api('GET', '/api/auth-log.csv');
    check(csv.status === 200 && /login_failed/.test(csv.data) && /^time,event,user/.test(csv.data), 'auth log CSV');
    const lcsv = await api('GET', '/api/logs/export.csv');
    check(lcsv.status === 200 && /^time,user,source/.test(lcsv.data) && /SELECT 1/.test(lcsv.data), 'query log CSV', String(lcsv.data).slice(0, 120));
    const conns = await api('GET', '/api/connections');
    check(!JSON.stringify(conns.data).includes('"password"') || conns.data.every((c) => !c.password), 'connection list hides passwords');
    await new Promise((res) => setTimeout(res, 2500));
    q = await api('GET', '/api/connections');
    check(q.status === 401, 'idle session is signed out', q.status);
    const cookie2 = await T.login(s2.B);
    const nonAdmin = await jsonReq(s2.B, cookie2)('POST', '/api/users', { username: 'plain', password: 'plain-pass-123', role: 'user' });
    const pc = await T.login(s2.B, 'plain', 'plain-pass-123');
    const denied = await jsonReq(s2.B, pc)('GET', '/api/auth-log');
    check(nonAdmin.status < 300 && denied.status === 403, 'auth log is admin-only', denied.status);
  } finally { await s2.stop(); }
  finish();
});
