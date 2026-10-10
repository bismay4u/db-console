// Stopping a running Query Runner statement (KILL QUERY).
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./helpers');
const { check } = T;

const SLOW = 'SELECT COUNT(*) AS n FROM seq_1_to_40000 a, seq_1_to_40000 b WHERE (a.seq * b.seq) % 7 = 3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('stop button: KILL QUERY on a running statement', { timeout: 120000 }, async () => {
  const srv = await T.startServer();
  const B = srv.B;
  try {
    const admin = await T.login(B);
    const post = (cookie, p, body) => fetch(B + p, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post(admin, '/api/users', { username: 'other', password: 'other-pass-123', role: 'user', displayName: 'Other' });
    await post(admin, '/api/connections/shop/sharing', { sharedWith: ['other'], permissions: { other: [] } });
    const other = await T.login(B, 'other', 'other-pass-123');

    // start a long statement with a run id; it must not be answered yet
    const runId = 'run' + Date.now().toString(36) + 'abcd';
    const started = Date.now();
    const running = post(admin, '/api/query', { dbKeys: ['shop'], sql: SLOW, runId }).then((r) => r.json());
    let file = path.join(srv.dataDir, 'runs', runId + '.json');
    for (let i = 0; i < 50 && !(fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).conns.shop?.sql); i++) await sleep(100);
    check(fs.existsSync(file), 'the run is registered while it executes');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(reg.username === 'admin' && Number.isInteger(reg.conns.shop.thread) && reg.conns.shop.sql.startsWith('SELECT COUNT(*)'), 'registry holds the thread and the statement', reg);
    await sleep(500);

    // someone else cannot stop it; an unknown run id is a 404
    let r = await post(other, '/api/query/cancel', { runId });
    check(r.status === 403, 'another user cannot stop it', r.status);
    r = await post(admin, '/api/query/cancel', { runId: 'doesnotexist123' });
    check(r.status === 404, 'unknown run → 404');
    r = await post(admin, '/api/query/cancel', { runId: '../../etc/passwd' });
    check(r.status === 404, 'a malformed run id is refused');

    r = await post(admin, '/api/query/cancel', { runId });
    const stop = await r.json();
    check(r.status === 200 && stop.stopped === 1, 'stop reports one stopped statement', stop);
    const result = await running;
    const st = result.results[0].statements[0];
    check(!st.ok && /interrupted|killed/i.test(st.error) && Date.now() - started < 30000, 'the statement ends with an "interrupted" error, quickly', { error: st.error, ms: Date.now() - started });
    check(!fs.existsSync(file), 'the registry entry is removed when the run ends');
    r = await post(admin, '/api/query/cancel', { runId });
    check(r.status === 404, 'stopping a finished run → 404');

    // the connection still works afterwards
    r = await post(admin, '/api/query', { dbKeys: ['shop'], sql: 'SELECT 1 AS ok' });
    check((await r.json()).results[0].ok, 'the connection works again afterwards');

    // a thread id that now belongs to a different statement is never killed
    const sleeper = spawn('mysql', ['-h', T.DB.host, '-P', String(T.DB.port), '-u', T.DB.user, '-e', 'SELECT SLEEP(20)'], { env: { ...process.env, MYSQL_PWD: T.DB.password } });
    await sleep(1500);
    const tid = T.mysql("SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP(20)%' LIMIT 1");
    check(/^\d+$/.test(tid), 'found an unrelated running query', tid);
    const fake = 'fakerun12345678';
    fs.mkdirSync(path.join(srv.dataDir, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(srv.dataDir, 'runs', fake + '.json'), JSON.stringify({ username: 'admin', started: Date.now(), conns: { shop: { thread: Number(tid), sql: 'SELECT COUNT(*) AS n FROM something_else' } } }));
    r = await post(admin, '/api/query/cancel', { runId: fake });
    check((await r.json()).stopped === 0, 'a reused thread running a different statement is not killed');
    check(T.mysql(`SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID = ${tid}`) === '1', 'the other query is still running');
    sleeper.kill();
  } finally {
    await srv.stop();
  }
  T.finish();
});
