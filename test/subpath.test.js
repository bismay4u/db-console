// Running in a sub-folder: redirects, the session cookie and the pages' URL shim.
const { test } = require('node:test');
const T = require('./helpers');
const { check, finish } = T;

const raw = (B, p, o = {}) => fetch(B + p, { redirect: 'manual', ...o });

test('app in a sub-folder, folder kept in the URL (BASE_PATH)', { timeout: 60000 }, async () => {
  const srv = await T.startServer({ env: { BASE_PATH: '/tools/db' } });
  const B = srv.B;
  try {
    let r = await raw(B, '/tools/db');
    check(r.status === 301 && r.headers.get('location') === '/tools/db/', 'the bare folder gets a trailing slash', r.headers.get('location'));
    r = await raw(B, '/tools/db/');
    check(r.status === 302 && r.headers.get('location') === '/tools/db/login', 'signed out: the front page goes to the folder\'s login', r.headers.get('location'));
    r = await raw(B, '/tools/db/login');
    const html = await r.text();
    check(r.status === 200 && /window\.BASE/.test(html), 'the login page is served with the URL shim');
    r = await raw(B, '/tools/db/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!' }) });
    const setCookie = r.headers.get('set-cookie') || '';
    check(r.status === 200 && /Path=\/tools\/db(;|$)/i.test(setCookie), 'the session cookie belongs to the folder', setCookie);
    const cookie = setCookie.split(';')[0];
    r = await raw(B, '/tools/db/', { headers: { cookie } });
    check(r.status === 200 && /window\.BASE/.test(await r.text()), 'signed in: the app is served under the folder');
    r = await raw(B, '/tools/db/login', { headers: { cookie } });
    check(r.status === 302 && r.headers.get('location') === '/tools/db/', 'signed in: the login page goes back to the app', r.headers.get('location'));
    r = await raw(B, '/tools/db/api/connections', { headers: { cookie } });
    check(r.status === 200 && Array.isArray(await r.json()), 'API calls work under the folder');
    r = await raw(B, '/api/connections', { headers: { cookie } });
    check(r.status === 200, 'and the plain paths keep working (a proxy that strips the folder)');
    r = await raw(B, '/auth/oidc/login', { headers: {} });
    check(r.status === 302 && r.headers.get('location') === '/tools/db/login?error=Single%20sign-on%20is%20not%20set%20up', 'login errors return to the folder\'s login page', r.headers.get('location'));
  } finally { await srv.stop(); }
  finish();
});

test('app in a sub-folder, folder stripped by the proxy (X-Forwarded-Prefix)', { timeout: 60000 }, async () => {
  const srv = await T.startServer();
  const B = srv.B;
  const h = { 'x-forwarded-prefix': '/apps/dbc/' };
  try {
    let r = await raw(B, '/', { headers: h });
    check(r.status === 302 && r.headers.get('location') === '/apps/dbc/login', 'redirects carry the prefix the proxy sent', r.headers.get('location'));
    r = await raw(B, '/', { headers: { 'x-forwarded-prefix': '//evil.example.com' } });
    check(r.status === 302 && !/^\/\//.test(r.headers.get('location')) && !/evil/.test(r.headers.get('location').replace(/^\/[^/]*/, '')) || r.headers.get('location') === '/login', 'a malformed prefix is ignored', r.headers.get('location'));
    r = await raw(B, '/api/login', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!' }) });
    check(/Path=\/apps\/dbc(;|$)/i.test(r.headers.get('set-cookie') || ''), 'the cookie path follows the prefix', r.headers.get('set-cookie'));
    r = await raw(B, '/');
    check(r.headers.get('location') === '/login', 'without a prefix nothing changes', r.headers.get('location'));
  } finally { await srv.stop(); }
  finish();
});
