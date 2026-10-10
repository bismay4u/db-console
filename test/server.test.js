// Ported from the original ad-hoc scripts: server tools: processes, variables, accounts, grants.
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Readable } = require('stream');
const { execSync, spawn } = require('child_process');
const T = require('./helpers');
const seed = require('./fixtures');
const { check } = T;
let B, srv, S;
const mysql = (sql) => T.mysql(sql);
const login = (u = 'admin', p = 'admin123!') => T.login(B, u, p);

test('server tools: processes, variables, accounts, grants', { timeout: 300000 }, async () => {
  srv = await T.startServer(); B = srv.B; S = srv.dir;
  process.env.DATA_DIR = srv.dataDir;
  seed.shop();
  try {
  const admin = await login('admin', 'admin123!');
  const call = async (cookie, method, path, body) => { const r = await fetch(B + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const S = '/api/server/shop';
  const sleeper = spawn('mysql', ['-h', T.DB.host, '-P', String(T.DB.port), '-u', T.DB.user, '-e', 'SELECT SLEEP(60)'], { env: { ...process.env, MYSQL_PWD: T.DB.password } });
  await new Promise((r) => setTimeout(r, 800));
  let r = await call(admin, 'GET', S + '/processes');
  const sl = r.data.find((p) => /SLEEP\(60\)/.test(p.info || ''));
  check(!!sl, 'process list shows the sleeping query', sl && { id: sl.id, info: sl.info, time: sl.time });
  r = await call(admin, 'POST', S + `/processes/${sl.id}/kill`, { queryOnly: true });
  check(r.data.sql === `KILL QUERY ${sl.id}`, 'kill query', r.data.sql);
  await new Promise((res) => sleeper.on('exit', res));
  check(!(await call(admin, 'GET', S + '/processes')).data.some((p) => /SLEEP\(60\)/.test(p.info || '')), 'query is gone');
  r = await call(admin, 'GET', S + '/variables');
  check(r.data.some((v) => v.name === 'max_connections'), 'variables', r.data.length + ' variables');
  r = await call(admin, 'GET', S + '/status');
  check(r.data.some((v) => v.name === 'Uptime'), 'status', r.data.length + ' status values');
  r = await call(admin, 'POST', S + '/accounts', { user: 'appuser', host: '%', password: "s3cret'pw", preview: true });
  check(r.data.sql === "CREATE USER 'appuser'@'%' IDENTIFIED BY '********'", 'create user preview masks the password', r.data.sql);
  r = await call(admin, 'POST', S + '/accounts', { user: 'appuser', host: '%', password: "s3cret'pw" });
  check(r.status === 200 && execSync(`mysql -uappuser "-ps3cret'pw" -h127.0.0.1 -N -e "SELECT CURRENT_USER()"`).toString().trim() === 'appuser@%', 'user created and can log in');
  r = await call(admin, 'POST', S + '/grants', { action: 'grant', user: 'appuser', host: '%', privileges: ['SELECT', 'INSERT'], db: 'shop' });
  check(r.data.sql === "GRANT SELECT, INSERT ON `shop`.* TO 'appuser'@'%'", 'grant', r.data.sql);
  check(execSync(`mysql -uappuser "-ps3cret'pw" -h127.0.0.1 -N -e "SELECT COUNT(*) FROM shop.people"`).toString().trim().length > 0, 'grant is effective');
  r = await call(admin, 'GET', S + '/accounts');
  const acct = r.data.accounts.find((a) => a.user === 'appuser');
  check(acct && acct.grants.some((g) => /GRANT SELECT, INSERT ON `shop`/.test(g)), 'accounts list with grants', acct && acct.grants);
  r = await call(admin, 'POST', S + '/grants', { action: 'revoke', user: 'appuser', host: '%', privileges: ['INSERT'], db: 'shop' });
  check(r.status === 200 && !(await call(admin, 'GET', S + '/accounts')).data.accounts.find((a) => a.user === 'appuser').grants.some((g) => /INSERT/.test(g)), 'revoke', r.data.sql);
  r = await call(admin, 'POST', S + '/grants', { action: 'grant', user: 'appuser', host: '%', privileges: ['SELECT; DROP DATABASE shop'], db: 'shop' });
  check(r.status === 400, 'unknown privilege rejected', r.data.error);
  r = await call(admin, 'PUT', S + '/accounts/password', { user: 'appuser', host: '%', password: 'newpass' });
  check(r.data.sql === "ALTER USER 'appuser'@'%' IDENTIFIED BY '********'" && execSync('mysql -uappuser -pnewpass -h127.0.0.1 -N -e "SELECT 1"').toString().trim() === '1', 'change password (masked in SQL)');
  const logs = await call(admin, 'GET', '/api/logs?source=server&limit=20');
  check(logs.data.entries.length >= 4 && !logs.data.entries.some((e) => /newpass|s3cret/.test(e.sql)), 'server actions logged without passwords', logs.data.entries.map((e) => e.sql));
  r = await call(admin, 'DELETE', S + '/accounts', { user: 'appuser', host: '%' });
  check(mysql("SELECT COUNT(*) FROM mysql.user WHERE User='appuser'") === '0', 'drop user');
  // non-owner: alice exists in this data dir? create and share
  await call(admin, 'POST', '/api/users', { username: 'viewer1', password: 'viewerpass1' });
  await call(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['viewer1'] });
  const viewer = await login('viewer1', 'viewerpass1');
  r = await call(viewer, 'GET', S + '/processes');
  check(r.status === 403, 'shared (non-owner) user cannot use server tools', r.data.error);
  await call(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: [] });
  } finally {
    await srv.stop();
  }
  T.finish();
});
