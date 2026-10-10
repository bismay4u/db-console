// Approval step for dangerous statements on shared connections.
const { test } = require('node:test');
const http = require('http');
const T = require('./helpers');
const seed = require('./fixtures');
const { check, finish } = T;

test('approvals', { timeout: 60000 }, async () => {
  seed.shop();
  const hooks = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const srv = await T.startServer();
  const B = srv.B;
  try {
    const call = async (ck, method, p, body) => { const r = await fetch(B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; };
    const admin = await T.login(B);
    await call(admin, 'PUT', '/api/notify', { webhookUrl: `http://127.0.0.1:${hook.address().port}/h` });
    for (const u of ['bob', 'cy']) await call(admin, 'POST', '/api/users', { username: u, password: `${u}-pass-1234`, role: 'user' });
    await call(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['bob', 'cy'] }); // full access for both
    const bob = await T.login(B, 'bob', 'bob-pass-1234'); const cy = await T.login(B, 'cy', 'cy-pass-1234');
    const run = (ck, sql) => call(ck, 'POST', '/api/query', { dbKeys: ['shop'], sql, databases: { shop: 'shop' } });
    const people = () => T.mysql('SELECT COUNT(*) FROM people', 'shop');

    // not switched on: everything runs
    let r = await run(bob, 'UPDATE people SET name = name');
    check(r.data.results[0].ok, 'without the setting, bob\'s UPDATE just runs');

    let c = await call(admin, 'PUT', '/api/connections/shop', { requireApproval: true });
    check(c.data.requireApproval === true, 'the owner switches it on');
    r = await run(bob, 'DELETE FROM people');
    const res0 = r.data.results[0];
    check(res0.pending === true && res0.approvalId && /Needs approval/.test(res0.statements[0].error) && people() === '2', 'a shared user\'s DELETE without WHERE is held, and nothing is deleted', res0);
    await new Promise((x) => setTimeout(x, 300));
    check(hooks.length === 1 && hooks[0].event === 'approval.requested' && hooks[0].approval.requester === 'bob', 'the owner is told through the webhook', hooks);
    r = await run(bob, 'DELETE FROM people');
    check(r.data.results[0].approvalId === res0.approvalId, 'asking twice does not make two requests');
    r = await run(bob, 'DELETE FROM people WHERE id = 99; SELECT 1');
    check(r.data.results[0].ok && !r.data.results[0].pending, 'safe statements still run');
    r = await run(bob, 'SELECT 1; DROP TABLE gadgets');
    check(r.data.results[0].pending && /DROP TABLE GADGETS/.test(r.data.results[0].statements[0].error), 'a DROP is held (the whole batch)');
    r = await run(admin, 'UPDATE people SET name = name');
    check(r.data.results[0].ok, 'the owner is never held back');
    r = await call(admin, 'POST', '/api/query', { dbKeys: ['shop'], sql: 'DELETE FROM people WHERE 1=0', databases: { shop: 'shop' } });
    check(r.data.results[0].ok, 'WHERE clauses are fine');

    // who sees what
    let list = await call(admin, 'GET', '/api/approvals');
    check(list.data.pending === 2 && list.data.toApprove.every((a) => a.canDecide), 'the owner sees two requests waiting', list.data.pending);
    list = await call(bob, 'GET', '/api/approvals');
    check(list.data.pending === 0 && list.data.mine.length === 2 && list.data.mine.every((a) => !a.canDecide), 'bob sees his own, and cannot decide them');
    list = await call(cy, 'GET', '/api/approvals');
    check(list.data.mine.length === 0 && list.data.toApprove.length === 0, 'cy sees none of them');

    // deciding
    const id = res0.approvalId;
    r = await call(bob, 'POST', `/api/approvals/${id}/approve`);
    check(r.status === 403 && /own request/.test(r.data.error), 'nobody approves their own request');
    r = await call(cy, 'POST', `/api/approvals/${id}/approve`);
    check(r.status === 403, 'a user who does not own the connection cannot approve');
    r = await call(admin, 'POST', `/api/approvals/${id}/approve`);
    check(r.status === 200 && r.data.status === 'approved' && r.data.outcome.ok && people() === '0', 'the owner approves: it runs now', r.data);
    r = await call(admin, 'POST', `/api/approvals/${id}/approve`);
    check(r.status === 409, 'and only once');
    const log = (await call(admin, 'GET', '/api/logs?source=approval')).data;
    check(log.entries.length === 1 && log.entries[0].username === 'bob', 'the run is in the log under the person who asked', log.entries);

    const dropId = list.data && (await call(admin, 'GET', '/api/approvals')).data.toApprove.find((a) => a.status === 'pending').id;
    r = await call(admin, 'POST', `/api/approvals/${dropId}/reject`, { reason: 'we still need that table' });
    check(r.status === 200 && r.data.status === 'rejected' && r.data.reason === 'we still need that table' && T.mysql("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='shop' AND table_name='gadgets'") === '1', 'rejecting keeps the data and records why');
    r = await run(bob, 'TRUNCATE TABLE gadgets');
    const tid = r.data.results[0].approvalId;
    r = await call(cy, 'POST', `/api/approvals/${tid}/withdraw`);
    check(r.status === 403, 'only the requester can withdraw');
    r = await call(bob, 'POST', `/api/approvals/${tid}/withdraw`);
    check(r.status === 200 && r.data.status === 'withdrawn', 'bob withdraws his own request');

    // the requester's own permissions still apply when it finally runs
    await call(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['bob', 'cy'], permissions: { bob: ['delete'], cy: [] } });
    r = await run(bob, 'UPDATE people SET name = \'x\'');
    check(r.data.results[0].error === undefined, 'a request the person is not even allowed to make fails normally');
    r = await run(bob, 'DELETE FROM gadgets');
    const gid = r.data.results[0].approvalId;
    await call(admin, 'PUT', '/api/connections/shop/sharing', { sharedWith: ['bob', 'cy'], permissions: { bob: [], cy: [] } });
    r = await call(admin, 'POST', `/api/approvals/${gid}/approve`);
    check(r.data.outcome && r.data.outcome.ok === false && /Read-only|permission/i.test(r.data.outcome.error) && T.mysql('SELECT COUNT(*) FROM gadgets', 'shop') === '3', 'if bob lost the permission meanwhile, approving cannot make it run', r.data.outcome);
  } finally { await srv.stop(); hook.close(); }
  finish();
});
