// Bulk actions on connections: share, unshare, inactive / active, approval, monitor, test, delete.
const { test } = require('node:test');
const T = require('./helpers');
const { check, finish } = T;

test('connections: bulk actions', { timeout: 90000 }, async () => {
  const srv = await T.startServer();
  const B = srv.B;
  try {
    const call = async (ck, method, p, body) => { const r = await fetch(B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; };
    const admin = await T.login(B);
    for (const u of ['ann', 'bob', 'cy']) await call(admin, 'POST', '/api/users', { username: u, password: u + '-pass-1234', role: 'user' });
    const ann = await T.login(B, 'ann', 'ann-pass-1234');
    const bob = await T.login(B, 'bob', 'bob-pass-1234');
    const mk = async (ck, label) => (await call(ck, 'POST', '/api/connections', { label, host: T.DB.host, port: T.DB.port, user: T.DB.user, password: T.DB.password, database: 'shop' })).data.key;
    const a1 = await mk(admin, 'A1'), a2 = await mk(admin, 'A2'), a3 = await mk(admin, 'A3');
    const n1 = await mk(ann, 'N1');
    const list = async (ck) => (await call(ck, 'GET', '/api/connections')).data;
    const get = async (ck, key) => (await list(ck)).find((c) => c.key === key);

    let r = await call(admin, 'POST', '/api/connections/bulk', { keys: [], action: 'delete' });
    check(r.status === 400, 'nothing chosen is refused');
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a1], action: 'explode' });
    check(r.status === 400, 'an unknown action is refused');

    // ---- share: add
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a1, a2, a3], action: 'share', mode: 'add', sharedWith: ['ann'], permissions: { ann: ['insert'] } });
    check(r.data.done === 3 && r.data.failed === 0, 'share three connections with a user', r.data);
    let c = await get(admin, a1);
    check(JSON.stringify(c.sharedWith) === '["ann"]' && JSON.stringify(c.sharePermissions.ann) === '["insert"]', 'with the chosen permissions', c.sharePermissions);
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a1, a2, a3], action: 'share', mode: 'add', sharedWith: ['bob'], permissions: { bob: [] }, scopes: { bob: { databases: ['shop'], hideTables: [] } } });
    c = await get(admin, a2);
    check(c.sharedWith.sort().join() === 'ann,bob' && JSON.stringify(c.sharePermissions.ann) === '["insert"]' && JSON.stringify(c.sharePermissions.bob) === '[]', 'adding keeps what the others already had', c.sharePermissions);
    check(c.shareScopes && c.shareScopes.bob && c.shareScopes.bob.databases[0] === 'shop' && !c.shareScopes.ann, 'and the limits go to the new person only', c.shareScopes);
    check((await get(bob, a1)).canWrite === false, 'the new person has exactly the chosen access');

    // ---- share: replace
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a1, a2], action: 'share', mode: 'replace', sharedWith: ['cy'], permissions: { cy: ['insert', 'update'] } });
    c = await get(admin, a1);
    check(JSON.stringify(c.sharedWith) === '["cy"]' && !c.shareScopes, 'replace swaps the whole list (and drops old limits)', c);
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a1], action: 'share', mode: 'add', sharedWith: ['*'], permissions: { '*': [] } });
    check(JSON.stringify((await get(admin, a1)).sharedWith) === '["*"]', 'adding "everyone" shares with everyone');

    // ---- unshare
    await call(admin, 'POST', '/api/connections/bulk', { keys: [a2], action: 'share', mode: 'replace', sharedWith: ['ann', 'bob', 'cy'], permissions: { ann: [], bob: [], cy: ['insert'] } });
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a2, a1], action: 'unshare', users: ['bob'] });
    c = await get(admin, a2);
    check(c.sharedWith.sort().join() === 'ann,cy' && JSON.stringify(c.sharePermissions.cy) === '["insert"]', 'stop sharing with one person, the rest stay', c.sharedWith);
    check(r.data.results.find((x) => x.key === a1).ok === false && /every user/.test(r.data.results.find((x) => x.key === a1).error), 'a connection shared with everyone says how to change that');
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a1, a2, a3], action: 'unshare', all: true });
    check(r.data.failed === 0 && (await get(admin, a1)).sharedWith.length === 0 && (await get(admin, a3)).sharedWith.length === 0, 'or with everybody');

    // ---- inactive
    await call(admin, 'POST', '/api/connections/bulk', { keys: [a3], action: 'share', mode: 'replace', sharedWith: ['ann'], permissions: { ann: [] } });
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a2, a3], action: 'deactivate' });
    check(r.data.done === 2 && (await get(admin, a2)).inactive === true, 'make connections inactive');
    r = await call(admin, 'POST', '/api/query', { dbKeys: [a2], sql: 'SELECT 1', databases: { [a2]: 'shop' } });
    check(r.status === 409 && /inactive/i.test(r.data.error), 'the Query Runner refuses an inactive connection', r.data);
    r = await call(admin, 'GET', `/api/explore/${a2}/databases`);
    check(r.status === 409, 'so does Explore', r.status);
    r = await call(ann, 'GET', `/api/explore/${a3}/databases`);
    check(r.status === 409, 'and for the people it was shared with', r.status);
    r = await call(admin, 'GET', `/api/explore/${a1}/databases`);
    check(r.status === 200, 'while the others keep working');
    check((await get(ann, a3)).inactive === true, 'the list still shows it, marked inactive');
    r = await call(admin, 'POST', `/api/connections/${a2}/test`);
    check(r.data.ok === true, 'it can still be tested');
    r = await call(admin, 'PUT', `/api/connections/${a2}/sharing`, { sharedWith: ['ann'] });
    check(r.status === 200, 'and shared or edited');
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a2, a3], action: 'activate' });
    r = await call(admin, 'GET', `/api/explore/${a2}/databases`);
    check(r.status === 200 && !(await get(admin, a2)).inactive, 'making it active again restores it');

    // ---- approval and monitoring
    await call(admin, 'POST', '/api/connections/bulk', { keys: [a1, a2], action: 'approval', on: true });
    check((await get(admin, a1)).requireApproval === true && (await get(admin, a2)).requireApproval === true, 'require approval on several');
    await call(admin, 'POST', '/api/connections/bulk', { keys: [a1, a2], action: 'approval', on: false });
    check(!(await get(admin, a1)).requireApproval, 'and off again');
    await call(admin, 'POST', '/api/connections/bulk', { keys: [a1], action: 'monitor', on: true });
    check((await get(admin, a1)).monitor === true, 'health recording on');

    // ---- test
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a1, a2, 'nope'], action: 'test' });
    check(r.data.results.filter((x) => x.ok).length === 2 && r.data.results.find((x) => x.key === 'nope').ok === false, 'test several connections at once', r.data);

    // ---- permissions
    r = await call(ann, 'POST', '/api/connections/bulk', { keys: [a1, n1], action: 'deactivate' });
    const byKey = Object.fromEntries(r.data.results.map((x) => [x.key, x]));
    check(byKey[n1].ok === true && byKey[a1].ok === false, 'a user can only change connections they own', r.data);
    r = await call(ann, 'POST', '/api/connections/bulk', { keys: [a1], action: 'delete' });
    check(r.data.results[0].ok === false && !!(await get(admin, a1)), 'nor delete someone else\'s');
    r = await call(bob, 'POST', '/api/connections/bulk', { keys: [a3], action: 'test' });
    check(r.data.results[0].ok === false, 'nor reach what is not shared with them');

    // ---- delete
    r = await call(admin, 'POST', '/api/connections/bulk', { keys: [a1, a2, a3, n1], action: 'delete' });
    check(r.data.done === 4 && !(await get(admin, a1)) && !(await get(admin, n1)), 'delete several (an admin may delete anyone\'s)', r.data);
  } finally { await srv.stop(); }
  finish();
});
