// Two-factor sign-in: enrol, sign in with the code, recovery codes, replay, admin reset, enforcement.
const { test } = require('node:test');
const T = require('./helpers');
const totp = require('../api/totp');
const { check, finish } = T;

const raw = async (B, method, p, body, cookie) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: d, cookie: sc ? sc.split(';')[0] : cookie };
};
// The server remembers the last time step used (a code works once). One test run sits in one 30-second step,
// so tests that need another fresh code rewind that memory in users.json — what waiting 30 s would do.
const fs = require('fs'); const path = require('path');
const rewind = (dataDir, username) => { const f = path.join(dataDir, 'users.json'); const u = JSON.parse(fs.readFileSync(f, 'utf8')); const x = u.find((v) => v.username === username); if (x && x.totp) x.totp.lastStep = 0; fs.writeFileSync(f, JSON.stringify(u)); };
const nextCode = (secret) => { const step = Math.floor(Date.now() / 30000); return { code: totp.codeAt(secret, step), step }; };

test('two-factor authentication', { timeout: 90000 }, async () => {
  const srv = await T.startServer();
  const B = srv.B;
  try {
    const admin = await T.login(B);
    await raw(B, 'POST', '/api/users', { username: 'ann', password: 'ann-pass-1234', role: 'user' }, admin);

    // ---- enrol
    let ann = (await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' })).cookie;
    let r = await raw(B, 'POST', '/api/2fa/setup', {}, ann);
    check(r.status === 200 && /^[A-Z2-7]{32}$/.test(r.data.secret) && r.data.uri.startsWith('otpauth://totp/DB%20Console:ann'), 'setup returns a secret and an otpauth link', r.data);
    const secret = r.data.secret;
    r = await raw(B, 'POST', '/api/2fa/enable', { code: '000000' }, ann);
    check(r.status === 400, 'a wrong code does not turn it on');
    let c = nextCode(secret);
    r = await raw(B, 'POST', '/api/2fa/enable', { code: c.code }, ann);
    const recovery = r.data.recoveryCodes;
    check(r.status === 200 && recovery.length === 10, 'the right code turns it on and shows 10 recovery codes', r.data);
    const stored = require('fs').readFileSync(require('path').join(srv.dataDir, 'users.json'), 'utf8');
    check(!stored.includes(secret) && stored.includes('enc:v1:') && !recovery.some((x) => stored.includes(x)), 'the secret is encrypted and recovery codes are stored hashed');

    // ---- sign in with it
    let s1 = await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' });
    check(s1.data.need2fa === true && (await raw(B, 'GET', '/api/session', null, s1.cookie)).data.authenticated === false, 'the password alone does not sign in', s1.data);
    r = await raw(B, 'POST', '/api/connections', { label: 'x' }, s1.cookie);
    check(r.status === 401, 'and opens nothing');
    r = await raw(B, 'POST', '/api/login/2fa', { code: '123456' }, s1.cookie);
    check(r.status === 401, 'a wrong code is refused');
    rewind(srv.dataDir, 'ann'); c = nextCode(secret);
    r = await raw(B, 'POST', '/api/login/2fa', { code: c.code }, s1.cookie);
    check(r.status === 200 && (await raw(B, 'GET', '/api/session', null, r.cookie)).data.authenticated === true, 'the right code signs in', r.data);
    // the same code cannot be used again (replay)
    s1 = await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' });
    r = await raw(B, 'POST', '/api/login/2fa', { code: c.code }, s1.cookie);
    check(r.status === 401, 'a code is good only once');
    // recovery code
    r = await raw(B, 'POST', '/api/login/2fa', { code: recovery[0].toUpperCase() }, s1.cookie);
    check(r.status === 200, 'a recovery code signs in');
    s1 = await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' });
    r = await raw(B, 'POST', '/api/login/2fa', { code: recovery[0] }, s1.cookie);
    check(r.status === 401, 'and works once');
    r = await raw(B, 'POST', '/api/login/2fa', { code: '123456' }, undefined);
    check(r.status === 401 && r.data.expired, '/login/2fa without a password step is refused');

    // ---- lockout covers the second step
    for (let i = 0; i < 12; i++) { const s = await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' }); if (s.status === 429) { r = s; break; } r = await raw(B, 'POST', '/api/login/2fa', { code: '111111' }, s.cookie); if (r.status === 429) break; }
    check(r.status === 429, 'too many wrong codes lock the account for a while', r.status);
    // clear the lockout (a restart-free way: the attempts file)
    require('fs').rmSync(require('path').join(srv.dataDir, 'login_attempts.json'), { force: true });

    // ---- the audit log
    const log = (await raw(B, 'GET', '/api/auth-log?limit=200', null, admin)).data.entries.map((e) => e.event);
    check(['2fa_enabled', 'login_2fa_required', 'recovery_code_used'].every((e) => log.includes(e)), '2FA events are in the sign-in log', [...new Set(log)]);

    // ---- recovery codes / disable
    const a2 = await (async () => { rewind(srv.dataDir, 'ann'); const s = await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' }); c = nextCode(secret); const z = await raw(B, 'POST', '/api/login/2fa', { code: c.code }, s.cookie);  return z.cookie; })();
    r = await raw(B, 'GET', '/api/2fa', null, a2);
    check(r.data.enabled && r.data.recoveryLeft === 9, 'status shows the recovery codes left', r.data);
    r = await raw(B, 'POST', '/api/2fa/disable', { password: 'wrong', code: totp.codeAt(secret, Math.floor(Date.now() / 30000) + 1) }, a2);
    check(r.status === 400, 'turning it off needs the password');
    rewind(srv.dataDir, 'ann');
    r = await raw(B, 'POST', '/api/2fa/disable', { password: 'ann-pass-1234', code: nextCode(secret).code }, a2);
    check(r.status === 200 && (await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' })).data.ok === true, 'with both, it turns off and the password signs in again');

    // ---- admin reset
    await raw(B, 'POST', '/api/2fa/setup', {}, (await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' })).cookie);
    const ann3 = (await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' })).cookie;
    const sec2 = (await raw(B, 'POST', '/api/2fa/setup', {}, ann3)).data.secret;
    await raw(B, 'POST', '/api/2fa/enable', { code: nextCode(sec2).code }, ann3);
    check((await raw(B, 'GET', '/api/users', null, admin)).data.find((u) => u.username === 'ann').totpEnabled === true, 'the user list shows who has 2FA');
    r = await raw(B, 'DELETE', '/api/users/ann/2fa', null, ann3);
    check(r.status === 403, 'only an admin can reset');
    r = await raw(B, 'DELETE', '/api/users/ann/2fa', null, admin);
    check(r.status === 200 && (await raw(B, 'POST', '/api/login', { username: 'ann', password: 'ann-pass-1234' })).data.ok === true, 'an admin reset puts the user back to password-only');
  } finally { await srv.stop(); }

  // ---- enforcement
  const srv2 = await T.startServer({ env: { REQUIRE_2FA: '1' } });
  try {
    const ck = (await raw(srv2.B, 'POST', '/api/login', { username: 'admin', password: 'admin123!' })).cookie;
    let r = await raw(srv2.B, 'GET', '/api/connections', null, ck);
    check(r.status === 403 && r.data.needs2faSetup === true, 'with REQUIRE_2FA, nothing works before enrolment', r);
    check((await raw(srv2.B, 'GET', '/api/session', null, ck)).data.needs2faSetup === true, 'the session says setup is needed');
    const secret = (await raw(srv2.B, 'POST', '/api/2fa/setup', {}, ck)).data.secret;
    await raw(srv2.B, 'POST', '/api/2fa/enable', { code: nextCode(secret).code }, ck);
    r = await raw(srv2.B, 'GET', '/api/connections', null, ck);
    check(r.status === 200, 'and everything after');
    r = await raw(srv2.B, 'POST', '/api/2fa/disable', { password: 'admin123!', code: nextCode(secret).code }, ck);
    check(r.status === 400 && /required/.test(r.data.error), 'it cannot be turned off while required');
  } finally { await srv2.stop(); }
  finish();
});
