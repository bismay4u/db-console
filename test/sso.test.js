// OpenID Connect sign-in against a mock identity provider (discovery, authorize, token, JWKS; RS256 ID tokens).
const { test } = require('node:test');
const crypto = require('crypto');
const http = require('http');
const T = require('./helpers');
const { check, finish } = T;

function mockIdp() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const codes = new Map();
  const idp = { identity: { sub: 'u-1', email: 'ann@corp.test', email_verified: true, name: 'Ann Example' }, mode: {}, calls: [] };
  let base = '';
  const sign = (claims, key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
    const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (url.pathname === '/.well-known/openid-configuration') return json({ issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', jwks_uri: base + '/jwks' });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), client: q.get('client_id'), identity: { ...idp.identity } });
      idp.calls.push({ pkce: q.get('code_challenge_method'), scope: q.get('scope') });
      const back = new URL(q.get('redirect_uri'));
      if (idp.mode.denyAccess) { back.searchParams.set('error', 'access_denied'); back.searchParams.set('error_description', 'The user said no'); } else { back.searchParams.set('code', code); }
      back.searchParams.set('state', idp.mode.wrongState ? 'tampered' : q.get('state'));
      res.statusCode = 302; res.setHeader('Location', back.toString()); return res.end();
    }
    if (url.pathname === '/token') {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        const f = new URLSearchParams(body);
        const c = codes.get(f.get('code'));
        if (!c || f.get('client_secret') !== 'shh' || f.get('client_id') !== 'dbc-client') { res.statusCode = 400; return json({ error: 'invalid_grant' }); }
        const verifierOk = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === c.challenge;
        if (!verifierOk) { res.statusCode = 400; return json({ error: 'invalid_grant', error_description: 'PKCE failed' }); }
        codes.delete(f.get('code'));
        const claims = { iss: base, aud: idp.mode.wrongAudience ? 'someone-else' : 'dbc-client', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + (idp.mode.expired ? -3600 : 300), nonce: idp.mode.wrongNonce ? 'x' : c.nonce, ...c.identity };
        return json({ access_token: 'at', token_type: 'Bearer', id_token: sign(claims, idp.mode.forged ? otherKey : privateKey) });
      });
      return undefined;
    }
    res.statusCode = 404; return res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; idp.base = base; idp.close = () => server.close(); resolve(idp); }));
}

// Follows redirects by hand (carrying cookies) until we land back on the app.
async function signIn(B) {
  let cookie = ''; let url = B + '/auth/oidc/login'; let last;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    last = r;
    const loc = r.headers.get('location');
    if (!loc) break;
    url = new URL(loc, B).toString();
    if (url.startsWith(B + '/login') || url === B + '/') { last = { location: loc, status: r.status }; break; }
  }
  return { cookie, location: last.location || (last.headers && last.headers.get('location')), status: last.status };
}

test('OpenID Connect sign-in', { timeout: 60000 }, async () => {
  const idp = await mockIdp();
  const srv = await T.startServer({ env: { OIDC_ISSUER: idp.base, OIDC_CLIENT_ID: 'dbc-client', OIDC_CLIENT_SECRET: 'shh', OIDC_LABEL: 'Corp SSO', OIDC_ALLOWED_DOMAINS: 'corp.test', OIDC_ADMIN_EMAILS: 'boss@corp.test' } });
  const B = srv.B;
  const api = async (p, ck) => { const r = await fetch(B + p, { headers: ck ? { cookie: ck } : {} }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  try {
    check((await api('/api/auth-config')).oidc.label === 'Corp SSO', 'the login page is told about SSO');
    let r = await signIn(B);
    let sess = await api('/api/session', r.cookie);
    check(sess.authenticated && sess.username === 'ann' && sess.role === 'user', 'first sign-in creates the user and signs in', { sess, r });
    check(idp.calls[0].pkce === 'S256' && /openid/.test(idp.calls[0].scope), 'the request used PKCE and the openid scope');
    const admin = await T.login(B);
    const users = await api('/api/users', admin);
    const ann = users.find((u) => u.username === 'ann');
    check(ann && ann.sso === 'oidc' && ann.displayName === 'Ann Example', 'the user is marked as an SSO user', ann);
    check((await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ann', password: 'anything-at-all' }) })).status === 401, 'an SSO user has no password to sign in with');

    r = await signIn(B);
    sess = await api('/api/session', r.cookie);
    check(sess.authenticated && sess.username === 'ann' && (await api('/api/users', admin)).filter((u) => u.sso).length === 1, 'signing in again finds the same user');

    idp.identity = { sub: 'u-2', email: 'boss@corp.test', email_verified: true, name: 'The Boss' };
    r = await signIn(B);
    check((await api('/api/session', r.cookie)).role === 'admin', 'an e-mail on the admin list becomes an admin');

    const bad = async (label, setup, re) => {
      const saved = { identity: idp.identity, mode: idp.mode };
      setup(); const x = await signIn(B);
      const s = await api('/api/session', x.cookie);
      check(!s.authenticated && re.test(decodeURIComponent(x.location || '')), label, x.location);
      idp.identity = saved.identity; idp.mode = saved.mode;
    };
    await bad('a domain that is not allowed', () => { idp.identity = { sub: 'u-3', email: 'eve@evil.test', email_verified: true, name: 'Eve' }; }, /evil\.test may not sign in/);
    await bad('an unverified e-mail', () => { idp.identity = { sub: 'u-4', email: 'new@corp.test', email_verified: false, name: 'N' }; }, /not verified/);
    await bad('a token signed with another key', () => { idp.mode = { forged: true }; }, /signature is not valid/);
    await bad('a token for another application', () => { idp.mode = { wrongAudience: true }; }, /different application/);
    await bad('an expired token', () => { idp.mode = { expired: true }; }, /expired/);
    await bad('a replayed/foreign nonce', () => { idp.mode = { wrongNonce: true }; }, /nonce/);
    await bad('a tampered state', () => { idp.mode = { wrongState: true }; }, /state/);
    await bad('the user refusing at the provider', () => { idp.mode = { denyAccess: true }; }, /The user said no/);

    // disabled users stay out
    await fetch(B + '/api/users/ann', { method: 'PUT', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
    idp.identity = { sub: 'u-1', email: 'ann@corp.test', email_verified: true, name: 'Ann Example' };
    const d = await signIn(B);
    check(!(await api('/api/session', d.cookie)).authenticated && /disabled/.test(decodeURIComponent(d.location || '')), 'a disabled user cannot sign in with SSO');

    const log = (await api('/api/auth-log?limit=200', admin)).entries;
    check(log.some((e) => e.event === 'login_ok' && /SSO/.test(e.detail || '')) && log.some((e) => e.event === 'login_failed' && /SSO/.test(e.detail || '')), 'SSO sign-ins and refusals are in the sign-in log');
  } finally { await srv.stop(); idp.close(); }

  // not configured
  const plain = await T.startServer();
  try {
    check((await (await fetch(plain.B + '/api/auth-config')).json()).oidc === null, 'without settings there is no SSO button');
    const x = await fetch(plain.B + '/auth/oidc/login', { redirect: 'manual' });
    check(x.status === 302 && /\/login\?error=/.test(x.headers.get('location')), 'and the route says so');
  } finally { await plain.stop(); }
  finish();
});
