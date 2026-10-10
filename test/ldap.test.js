// Directory sign-in against a small in-process LDAP server (ldapjs).
const { test } = require('node:test');
const ldap = require('ldapjs');
const T = require('./helpers');
const { check, finish } = T;

const BASE = 'ou=people,dc=corp,dc=test';
const DIRECTORY = {
  'cn=svc,dc=corp,dc=test': { password: 'svcpw', attrs: {} },
  [`uid=ann,${BASE}`]: { password: 'ann-secret', attrs: { uid: 'ann', cn: 'Ann Example', mail: 'Ann@corp.test', objectClass: 'person' } },
  [`uid=bob,${BASE}`]: { password: 'bob-secret', attrs: { uid: 'bob', cn: 'Bob Boss', mail: 'bob@corp.test', objectClass: 'person' } },
  [`uid=dup1,${BASE}`]: { password: 'x', attrs: { uid: 'dup', cn: 'Dup One', objectClass: 'person' } },
  [`uid=dup2,${BASE}`]: { password: 'y', attrs: { uid: 'dup', cn: 'Dup Two', objectClass: 'person' } }
};

function startDirectory() {
  const server = ldap.createServer();
  const binds = [];
  server.bind('dc=corp,dc=test', (req, res, next) => {
    const dn = req.dn.toString().replace(/,\s+/g, ',');
    const entry = Object.entries(DIRECTORY).find(([k]) => k.toLowerCase() === dn.toLowerCase());
    binds.push({ dn, empty: req.credentials === '' });
    if (!entry || req.credentials === '' || entry[1].password !== req.credentials) return next(new ldap.InvalidCredentialsError());
    res.end(); return next();
  });
  server.search(BASE, (req, res, next) => {
    for (const [dn, e] of Object.entries(DIRECTORY)) {
      if (!dn.endsWith(BASE) || !req.filter.matches(e.attrs)) continue;
      res.send({ dn, attributes: e.attrs }, true); // true: answer with all attributes, whatever was asked
    }
    res.end(); return next();
  });
  // the admin group, found by looking for the user among its members (OpenLDAP style)
  server.search('cn=dbadmins,dc=corp,dc=test', (req, res, next) => {
    const attrs = { cn: 'dbadmins', member: [`uid=bob,${BASE}`], objectClass: 'groupOfNames' };
    if (req.filter.matches(attrs)) res.send({ dn: 'cn=dbadmins,dc=corp,dc=test', attributes: attrs }, true);
    res.end(); return next();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `ldap://127.0.0.1:${server.address().port}`, binds, close: () => server.close() })));
}

test('LDAP sign-in', { timeout: 60000 }, async () => {
  const dir = await startDirectory();
  const srv = await T.startServer({ env: { LDAP_URL: dir.url, LDAP_BASE_DN: BASE, LDAP_BIND_DN: 'cn=svc,dc=corp,dc=test', LDAP_BIND_PASSWORD: 'svcpw', LDAP_ADMIN_GROUP: 'cn=dbadmins,dc=corp,dc=test', LDAP_USER_FILTER: '(uid={username})', LDAP_LABEL: 'Corp directory' } });
  const B = srv.B;
  const post = async (p, body, ck) => { const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ck ? { cookie: ck } : {}) }, body: JSON.stringify(body) }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } const sc = r.headers.get('set-cookie'); return { status: r.status, data: d, cookie: sc ? sc.split(';')[0] : ck }; };
  const get = async (p, ck) => (await (await fetch(B + p, { headers: ck ? { cookie: ck } : {} })).json());
  try {
    check((await get('/api/auth-config')).ldap.label === 'Corp directory', 'the login page is told about the directory');
    let r = await post('/api/login', { username: 'ann', password: 'ann-secret' });
    let sess = await get('/api/session', r.cookie);
    check(r.status === 200 && sess.authenticated && sess.username === 'ann' && sess.role === 'user' && sess.displayName === 'Ann Example', 'a directory user signs in and gets an account', { r: r.data, sess });
    const admin = await T.login(B);
    let users = await get('/api/users', admin);
    check(users.find((u) => u.username === 'ann').sso === 'ldap', 'it is marked as a directory account');

    r = await post('/api/login', { username: 'ann', password: 'wrong' });
    check(r.status === 401, 'a wrong password is refused');
    r = await post('/api/login', { username: 'ann', password: '' });
    check(r.status === 401 && !dir.binds.some((b) => b.empty && /uid=ann/.test(b.dn)), 'an empty password is never even tried (it could be an anonymous bind)');
    r = await post('/api/login', { username: 'nobody', password: 'x' });
    check(r.status === 401, 'an unknown name is refused');
    r = await post('/api/login', { username: 'dup', password: 'x' });
    check(r.status === 401, 'a name that matches two entries is refused');
    r = await post('/api/login', { username: '*', password: 'ann-secret' });
    check(r.status === 401, 'filter characters are escaped (* does not match everyone)');
    r = await post('/api/login', { username: 'ann)(uid=*', password: 'ann-secret' });
    check(r.status === 401, 'and so is filter injection');

    r = await post('/api/login', { username: 'bob', password: 'bob-secret' });
    check((await get('/api/session', r.cookie)).role === 'admin', 'members of the admin group become admins');

    r = await post('/api/login', { username: 'ann', password: 'ann-secret' });
    users = await get('/api/users', admin);
    check(users.filter((u) => u.sso === 'ldap').length === 2, 'signing in again reuses the account');

    // a local account is never handed to the directory
    r = await post('/api/login', { username: 'admin', password: 'ann-secret' });
    check(r.status === 401, 'a local account name does not fall through to the directory');
    r = await post('/api/login', { username: 'admin', password: 'admin123!' });
    check(r.status === 200, 'and the local password still works');

    // a directory account has no local password
    check(!dir.binds.some((b) => /cn=svc/.test(b.dn) && b.empty), 'the service account binds with its password');
    await fetch(B + '/api/users/ann', { method: 'PUT', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
    r = await post('/api/login', { username: 'ann', password: 'ann-secret' });
    check(r.status === 401, 'a disabled directory user is refused');
  } finally { await srv.stop(); dir.close(); }

  // the directory is down
  const down = await T.startServer({ env: { LDAP_URL: 'ldap://127.0.0.1:1', LDAP_BASE_DN: BASE } });
  try {
    const r = await fetch(down.B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ann', password: 'x' }) });
    check(r.status === 503, 'an unreachable directory is reported as such', r.status);
    const local = await fetch(down.B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!' }) });
    check(local.status === 200, 'but local accounts keep working');
  } finally { await down.stop(); }
  finish();
});
