// Scheduled jobs: query / analysis / backup / health, alerts by email and webhook, uploads, permissions.
const { test } = require('node:test');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const T = require('./helpers');
const seed = require('./fixtures');
const { check, finish } = T;

function smtpSink() {
  const mails = [];
  const server = net.createServer((sock) => {
    let buf = ''; let data = false; let cur = { to: [], raw: '' };
    sock.write('220 sink ESMTP\r\n');
    const pump = () => {
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          cur.raw = buf.slice(0, end); buf = buf.slice(end + 5); mails.push(cur); cur = { to: [], raw: '' }; data = false; sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i === -1) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^(EHLO|HELO)/i.test(line)) sock.write('250-sink\r\n250 8BITMIME\r\n');
        else if (/^RCPT TO:/i.test(line)) { cur.to.push(/<([^>]*)>/.exec(line)[1]); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); return; }
        else sock.write('250 ok\r\n');
      }
    };
    sock.on('data', (c) => { buf += c.toString(); pump(); });
    sock.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ mails, port: server.address().port, close: () => server.close() })));
}
function webhookSink() {
  const hooks = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hooks.push({ body: JSON.parse(b), sig: req.headers['x-dbconsole-signature'] }); res.end('ok'); });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ hooks, port: server.address().port, close: () => server.close() })));
}
function s3Sink() {
  const puts = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { puts.push({ url: req.url, bytes: Buffer.concat(chunks).length, auth: req.headers.authorization }); res.end(); });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ puts, port: server.address().port, close: () => server.close() })));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150); } return null; };

test('scheduled jobs', { timeout: 240000 }, async (t) => {
  seed.diag();
  const smtp = await smtpSink(); const hook = await webhookSink(); const s3 = await s3Sink();
  const ssh = await T.startSshd();
  const srv = await T.startServer({ env: { SCHEDULER_TICK_MS: '300' } });
  try {
    const cookie = await T.login(srv.B);
    const api = (ck = cookie) => async (method, p, body) => {
      const r = await fetch(srv.B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let d; try { d = JSON.parse(text); } catch { d = text; } return { status: r.status, data: d, headers: r.headers };
    };
    const A = api();
    const runJob = async (id) => (await A('POST', `/api/jobs/${id}/run?wait=1`)).data;
    const mine = () => smtp.mails.length;

    // ---- alert channels
    let r = await A('PUT', '/api/notify', { smtp: { host: '127.0.0.1', port: smtp.port, from: 'dbc@example.test' }, webhookUrl: `http://127.0.0.1:${hook.port}/h`, webhookSecret: 'shh', baseUrl: 'http://dbc.test' });
    check(r.status === 200 && r.data.emailConfigured && r.data.webhookConfigured && !JSON.stringify(r.data).includes('shh'), 'notification settings saved, secrets not echoed', r.data);
    r = await A('POST', '/api/notify/test', { email: 'ops@example.test', webhook: true });
    check(r.data.sent.includes('email') && r.data.sent.includes('webhook') && !r.data.errors.length, 'test message goes out by email and webhook', r.data);
    check(smtp.mails.length === 1 && /Subject: \[DB Console\] Test message/.test(smtp.mails[0].raw) && smtp.mails[0].to[0] === 'ops@example.test', 'the email arrived');
    check(hook.hooks.length === 1 && /^sha256=[0-9a-f]{64}$/.test(hook.hooks[0].sig || ''), 'the webhook is signed');

    // ---- validation
    r = await A('POST', '/api/jobs', { type: 'query', name: 'x', connKey: 'shop', database: 'diag', sql: 'SELECT {{p}}', schedule: '*/5 * * * *' });
    check(r.status === 400 && /parameter/.test(r.data.error), 'a parameter without a value is refused', r.data);
    r = await A('POST', '/api/jobs', { type: 'query', name: 'x', connKey: 'shop', sql: 'SELECT 1', schedule: 'nonsense' });
    check(r.status === 400, 'a bad schedule is refused', r.data);
    r = await A('POST', '/api/schedule/preview', { schedule: '0 3 * * *' });
    check(r.status === 200 && r.data.next.length === 5, 'schedule preview lists the next runs');

    // ---- query job: CSV + email on rows
    r = await A('POST', '/api/jobs', { type: 'query', name: 'Customers', connKey: 'shop', database: 'diag', sql: 'SELECT id, name FROM customers WHERE name <> {{skip=zzz}} ORDER BY id', schedule: '0 3 * * *', notifyWhen: 'rows', emails: 'a@example.test, b@example.test', webhook: true, attach: true });
    check(r.status === 201 && r.data.nextRunAt, 'query job created with a next run', r.data);
    const q = r.data.id;
    const before = mine();
    let run = await runJob(q);
    check(run.ok && run.summary.rows === 2 && run.file && /2 row/.test(run.message), 'runs and records the rows', run);
    check(mine() === before + 1 && /filename=/.test(smtp.mails[smtp.mails.length - 1].raw) && smtp.mails[smtp.mails.length - 1].to.length === 2, 'rows > 0 sends one email with the CSV attached');
    check(hook.hooks.length === 2 && hook.hooks[1].body.job.name === 'Customers' && hook.hooks[1].body.ok === true, 'and posts the webhook');
    const dl = await fetch(`${srv.B}/api/jobs/${q}/runs/${run.id}/file`, { headers: { cookie } });
    const csv = await dl.text();
    check(dl.status === 200 && /^id,name/.test(csv) && /ann/.test(csv), 'the CSV can be downloaded', csv.slice(0, 40));
    r = await A('PUT', `/api/jobs/${q}`, { notifyWhen: 'norows' });
    const b2 = mine();
    run = await runJob(q);
    check(run.ok && mine() === b2, '"alert when no rows" stays quiet when there are rows');
    r = await A('PUT', `/api/jobs/${q}`, { notifyWhen: 'failure', sql: 'SELECT nope FROM customers' });
    run = await runJob(q);
    check(!run.ok && /nope/i.test(run.message) && mine() === b2 + 1 && /Subject:.*FAILED/.test(smtp.mails[smtp.mails.length - 1].raw), 'a failing query alerts', run.message);
    const log = (await A('GET', '/api/logs?source=schedule')).data;
    check(log.entries && log.entries.length >= 2, 'scheduled runs are in the query log', log.total);

    // ---- the schedule fires by itself
    r = await A('PUT', `/api/jobs/${q}`, { sql: 'SELECT 1 AS n', schedule: '* * * * *', notifyWhen: 'failure' });
    const jf = path.join(srv.dataDir, 'jobs.json');
    const all = JSON.parse(fs.readFileSync(jf, 'utf8'));
    all.find((j) => j.id === q).nextRunAt = new Date(Date.now() - 5000).toISOString();
    fs.writeFileSync(jf, JSON.stringify(all));
    const fired = await waitFor(async () => (await A('GET', `/api/jobs/${q}/runs`)).data.find((x) => x.trigger === 'schedule'));
    check(fired && fired.ok, 'a job that is due runs on its own', fired);
    const after = (await A('GET', '/api/jobs')).data.find((j) => j.id === q);
    check(Date.parse(after.nextRunAt) > Date.now(), 'and is rescheduled', after.nextRunAt);

    // ---- permissions
    await A('POST', '/api/users', { username: 'reader', password: 'reader-pass-1', role: 'user', displayName: 'R' });
    await A('POST', '/api/users', { username: 'other', password: 'other-pass-12', role: 'user', displayName: 'O' });
    await A('PUT', '/api/connections/shop/sharing', { sharedWith: ['reader'], readOnly: true });
    const R = api(await T.login(srv.B, 'reader', 'reader-pass-1'));
    const O = api(await T.login(srv.B, 'other', 'other-pass-12'));
    r = await O('POST', '/api/jobs', { type: 'query', name: 'sneak', connKey: 'shop', database: 'diag', sql: 'SELECT 1', schedule: '' });
    check(r.status === 400 && /access/i.test(r.data.error), 'no job on a connection you cannot use', r.data);
    check((await O('GET', '/api/jobs')).data.length === 0 && (await O('POST', `/api/jobs/${q}/run`)).status === 404 && (await O('DELETE', `/api/jobs/${q}`)).status === 404, 'other people\'s jobs are invisible');
    r = await R('POST', '/api/jobs', { type: 'query', name: 'writer', connKey: 'shop', database: 'diag', sql: "UPDATE customers SET name = 'hacked'", schedule: '', notifyWhen: 'failure' });
    run = (await R('POST', `/api/jobs/${r.data.id}/run?wait=1`)).data;
    check(!run.ok && /read-only|permission|not allowed/i.test(run.message) && T.mysql("SELECT COUNT(*) FROM customers WHERE name='hacked'", 'diag') === '0', 'a job runs with its owner\'s permissions (read-only user cannot write)', run.message);
    r = await R('POST', '/api/jobs', { type: 'backup', name: 'b', connKey: 'shop', database: 'diag', schedule: '' });
    check(r.status === 400 && /owner or admin/.test(r.data.error), 'backups need owner/admin rights', r.data);
    check((await A('GET', '/api/jobs')).data.length >= 2, 'admins see everyone\'s jobs');

    // ---- analysis job, twice
    r = await A('POST', '/api/jobs', { type: 'analysis', name: 'Nightly analysis', connKey: 'shop', database: 'diag', schedule: '', notifyWhen: 'worse', emails: 'a@example.test' });
    const an = r.data.id;
    const m0 = mine();
    run = await runJob(an);
    check(run.ok && run.summary && typeof run.summary.error === 'number' && run.summary.tables > 3, 'analysis summarises the findings', run.summary);
    check(mine() === m0 + 1, 'the first run reports (there is something to fix)');
    run = await runJob(an);
    check(run.ok && run.summary.previous && mine() === m0 + 1, 'a second identical run is not "worse", so it stays quiet', run.summary);

    // ---- backup: keep 2, restore test, S3 and SFTP uploads
    r = await A('POST', '/api/jobs', { type: 'backup', name: 'Backup diag', connKey: 'shop', database: 'diag', schedule: '', notifyWhen: 'failure', backup: { keep: 2, restoreTest: true } });
    const bk = r.data.id;
    for (let i = 0; i < 3; i++) { run = await runJob(bk); await wait(1100); }
    check(run.ok && /restore test passed/.test(run.message) && run.summary.restoreTest.tables >= 5, 'backup + restore test pass', run.message);
    const files = fs.readdirSync(path.join(srv.dataDir, 'backups', bk));
    check(files.length === 2, 'only the newest 2 backups are kept', files);
    check(!T.mysql('SHOW DATABASES').split('\n').some((d) => d.startsWith('dbc_rt_')), 'the scratch database is dropped');
    const bdl = await fetch(`${srv.B}/api/jobs/${bk}/runs/${run.id}/file`, { headers: { cookie } });
    check(bdl.status === 200 && (await bdl.arrayBuffer()).byteLength > 100, 'a backup can be downloaded by its owner');

    r = await A('POST', '/api/jobs', { type: 'backup', name: 'Backup to S3', connKey: 'shop', database: 'diag', schedule: '', backup: { keep: 3, upload: { type: 's3', endpoint: `http://127.0.0.1:${s3.port}`, bucket: 'bk', region: 'us-east-1', accessKeyId: 'AKIATEST', secretAccessKey: 'sekrit', prefix: 'dbc' } } });
    check(r.status === 201 && !JSON.stringify(r.data).includes('sekrit') && r.data.backup.upload.hasSecretAccessKey, 'S3 secret is not echoed back', r.data.backup);
    check(!fs.readFileSync(path.join(srv.dataDir, 'jobs.json'), 'utf8').includes('sekrit'), 'and is encrypted on disk');
    run = await runJob(r.data.id);
    check(run.ok && s3.puts.length === 1 && /^\/bk\/dbc\/diag-.*\.sql\.gz$/.test(s3.puts[0].url) && s3.puts[0].bytes > 100 && /AWS4-HMAC-SHA256/.test(s3.puts[0].auth), 'the backup is uploaded to S3 with a signed request', { run: run.message, puts: s3.puts });

    if (ssh) {
      r = await A('POST', '/api/jobs', { type: 'backup', name: 'Backup to SFTP', connKey: 'shop', database: 'diag', schedule: '', backup: { keep: 2, upload: { type: 'sftp', host: '127.0.0.1', port: ssh.port, user: ssh.user, privateKey: ssh.privateKey, path: path.join(ssh.dir, 'remote', 'dbc') } } });
      for (let i = 0; i < 3; i++) { run = await runJob(r.data.id); await wait(1100); }
      const remote = fs.readdirSync(path.join(ssh.dir, 'remote', 'dbc'));
      check(run.ok && /uploaded to sftp:/.test(run.message) && remote.length === 2, 'SFTP upload keeps the newest 2 remotely', { msg: run.message, remote });
    }

    // ---- health: down, still down (quiet), recovered
    const bad = (await A('POST', '/api/connections', { label: 'Flaky', host: '127.0.0.1', port: 1, user: 'x', password: 'x', database: 'x' })).data.key;
    r = await A('POST', '/api/jobs', { type: 'health', name: 'Are we up', connKeys: [bad], schedule: '', notifyWhen: 'change', emails: 'ops@example.test' });
    const hj = r.data.id;
    const h0 = mine();
    run = await runJob(hj);
    check(!run.ok && /1 of 1 connection\(s\) down/.test(run.message) && mine() === h0 + 1 && /FAILED/.test(smtp.mails[smtp.mails.length - 1].raw), 'a connection that is down alerts', run.message);
    run = await runJob(hj);
    check(!run.ok && mine() === h0 + 1, 'still down: no repeated alert');
    await A('PUT', `/api/connections/${bad}`, { host: T.DB.host, port: T.DB.port, user: T.DB.user, password: T.DB.password, database: 'shop' });
    run = await runJob(hj);
    check(run.ok && mine() === h0 + 2 && /reachable again|UP/.test(smtp.mails[smtp.mails.length - 1].raw + ''), 'recovery alerts once', run.message);

    // ---- housekeeping
    r = await A('DELETE', `/api/jobs/${q}`);
    check(r.status === 200 && !fs.existsSync(path.join(srv.dataDir, 'job-output', q)), 'deleting a job removes its saved results');
    check(fs.existsSync(path.join(srv.dataDir, 'backups', bk)), 'but never its backups');
  } finally {
    await srv.stop(); smtp.close(); hook.close(); s3.close(); if (ssh) ssh.stop();
  }
  finish();
});
