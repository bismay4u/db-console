// SSH tunnel: starts a throwaway sshd on a free port and routes a connection through it.
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const T = require('./helpers');
const { check, finish } = T;

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd', '/usr/local/sbin/sshd'].find((p) => fs.existsSync(p));

test('connections through an SSH tunnel', { timeout: 120000, skip: !SSHD && 'sshd not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-ssh-'));
  const sshPort = await T.freePort();
  const key = path.join(dir, 'id'); const wrong = path.join(dir, 'wrong'); const hostKey = path.join(dir, 'host');
  for (const f of [key, wrong, hostKey]) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', f]);
  fs.copyFileSync(key + '.pub', path.join(dir, 'authorized_keys'));
  fs.chmodSync(dir, 0o700);
  const me = os.userInfo().username;
  fs.writeFileSync(path.join(dir, 'sshd_config'), [
    `Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
    'PasswordAuthentication no', 'UsePAM no', 'AllowTcpForwarding yes', 'StrictModes no', `PidFile ${path.join(dir, 'pid')}`, `AllowUsers ${me}`, 'PermitRootLogin yes'
  ].join('\n'));
  try { fs.mkdirSync('/run/sshd', { recursive: true }); } catch (e) { /* not root */ }
  const sshd = spawn(SSHD, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const fp = execFileSync('ssh-keygen', ['-lf', hostKey + '.pub']).toString().split(' ')[1];
  const srv = await T.startServer();
  try {
    const cookie = await T.login(srv.B);
    const api = async (method, p, body) => {
      const r = await fetch(srv.B + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d };
    };
    const base = { label: 'Tunnelled', host: T.DB.host, port: T.DB.port, user: T.DB.user, password: T.DB.password, database: 'shop', sshHost: '127.0.0.1', sshPort: sshPort, sshUser: me };
    const privateKey = fs.readFileSync(key, 'utf8');

    let r = await api('POST', '/api/connections/test', { ...base, sshPrivateKey: fs.readFileSync(wrong, 'utf8') });
    check(r.data.ok === false && /SSH/.test(r.data.error), 'a key the server does not know is refused', r.data);
    r = await api('POST', '/api/connections/test', { ...base, sshPrivateKey: privateKey, sshHostKey: 'SHA256:notTheRealFingerprint' });
    check(r.data.ok === false, 'a wrong host-key fingerprint is refused', r.data);
    r = await api('POST', '/api/connections/test', { ...base, sshPrivateKey: privateKey, sshHostKey: fp });
    check(r.data.ok === true, 'the right key and fingerprint connect', r.data);

    r = await api('POST', '/api/connections', { ...base, sshPrivateKey: privateKey, sshHostKey: fp });
    check(r.status === 201 && r.data.sshHost === '127.0.0.1' && r.data.hasSshPrivateKey === true && !('sshPrivateKey' in r.data), 'saved; the key is not echoed back', r.data);
    const k = r.data.key;
    const stored = fs.readFileSync(path.join(srv.dataDir, 'connections.json'), 'utf8');
    check(!stored.includes('OPENSSH PRIVATE KEY') && stored.includes('enc:v1:'), 'the private key is encrypted on disk');

    r = await api('POST', '/api/query', { dbKeys: [k], sql: 'SELECT 41+1 AS answer', databases: { [k]: 'shop' } });
    check(r.data.results && r.data.results[0].ok && JSON.stringify(r.data.results[0].statements[0].rows).includes('42'), 'queries run through the tunnel', r.data);
    // concurrent use shares one SSH client
    const many = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => api('POST', '/api/query', { dbKeys: [k], sql: `SELECT ${i} AS n`, databases: { [k]: 'shop' } })));
    check(many.every((x) => x.data.results[0].ok), 'six parallel queries work');
    r = await api('GET', `/api/explore/${k}/shop/export?options=` + encodeURIComponent(JSON.stringify({ format: 'sql', tables: [] })));
    check(r.status === 200, 'streaming connections go through the tunnel too', r.status);

    // editing without re-sending the secret keeps it; clearing sshHost removes the tunnel
    r = await api('PUT', `/api/connections/${k}`, { label: 'Tunnelled 2' });
    r = await api('POST', `/api/connections/${k}/test`);
    check(r.data.ok === true, 'editing the label keeps the tunnel working', r.data);
    r = await api('PUT', `/api/connections/${k}`, { sshHost: '' });
    check(r.data.sshHost === undefined && r.data.hasSshPrivateKey === false, 'clearing the SSH host removes the tunnel settings', r.data);
    r = await api('POST', `/api/connections/${k}/test`);
    check(r.data.ok === true, 'direct connection works after clearing the tunnel', r.data);
  } finally {
    await srv.stop(); sshd.kill(); fs.rmSync(dir, { recursive: true, force: true });
  }
  finish();
});
