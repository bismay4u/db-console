// Table notes, saved-query notes, bulk analysis fixes and the all-databases analysis.
const { test } = require('node:test');
const T = require('./helpers');
const seed = require('./fixtures');
const { check, finish } = T;

test('notes and bulk analysis', { timeout: 120000 }, async () => {
  seed.anom();
  const srv = await T.startServer();
  try {
    const admin = await T.login(srv.B);
    const api = (ck) => async (method, p, body) => {
      const r = await fetch(srv.B + p, { method, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d };
    };
    const A = api(admin);
    for (const u of ['ann', 'bob', 'cy']) await A('POST', '/api/users', { username: u, password: u + '-pass-1234', role: 'user' });
    const ann = api(await T.login(srv.B, 'ann', 'ann-pass-1234'));
    const bob = api(await T.login(srv.B, 'bob', 'bob-pass-1234'));
    const cy = api(await T.login(srv.B, 'cy', 'cy-pass-1234'));
    await A('PUT', '/api/connections/shop/sharing', { sharedWith: ['ann', 'bob'], readOnly: true });

    // ---- table notes
    const N = '/api/notes/tables/shop/anom/orders';
    let r = await ann('POST', N, { text: 'Only for me', shared: false });
    check(r.status === 201 && r.data.mine && !r.data.shared, 'a user writes a private table note (a read-only share can)', r.data);
    const priv = r.data.id;
    r = await ann('POST', N, { text: 'Billing orders, see wiki\nsecond line', shared: true });
    check(r.status === 201 && r.data.shared, 'and a shared one');
    const shared = r.data.id;
    r = await bob('GET', N);
    check(r.data.length === 1 && r.data[0].text.startsWith('Billing') && !r.data[0].mine && r.data[0].owner === 'ann', 'others see only the shared one', r.data);
    r = await ann('GET', N);
    check(r.data.length === 2, 'the author sees both');
    r = await cy('GET', N);
    check(r.status === 404, 'a user without access to the connection gets nothing', r.status);
    r = await bob('GET', '/api/notes/tables/shop/anom');
    check(r.data.orders === 1, 'table counts only include visible notes', r.data);
    r = await ann('GET', '/api/notes/tables/shop/anom');
    check(r.data.orders === 2, 'the author counts both', r.data);
    r = await bob('PUT', `/api/notes/${shared}`, { text: 'hijack' });
    check(r.status === 403, 'only the author edits a note', r.status);
    r = await bob('PUT', `/api/notes/${priv}`, { text: 'x' });
    check(r.status === 404, 'a private note of someone else does not exist for you', r.status);
    r = await bob('DELETE', `/api/notes/${shared}`);
    check(r.status === 403, 'a plain user cannot delete someone else\'s note');
    r = await ann('PUT', `/api/notes/${priv}`, { text: 'Now shared', shared: true });
    check(r.data.shared && r.data.text === 'Now shared', 'the author edits and shares a private note', r.data);
    r = await bob('GET', N);
    check(r.data.length === 2, 'which others then see');
    r = await ann('POST', N, { text: '   ' });
    check(r.status === 400, 'an empty note is refused');
    r = await ann('POST', N, { text: 'x'.repeat(4001) });
    check(r.status === 400, 'so is a very long one');
    r = await A('DELETE', `/api/notes/${shared}`);
    check(r.data.ok, 'the owner of the connection can delete a note');
    r = await ann('DELETE', `/api/notes/${priv}`);
    check(r.data.ok, 'and the author');

    // scope: a table hidden from a user has no notes for them
    await A('PUT', '/api/connections/shop/sharing', { sharedWith: ['ann', 'bob'], readOnly: true, scopes: { bob: { databases: ['anom'], hideTables: ['anom.orders'] } } });
    r = await bob('GET', N);
    check(r.status === 403, 'a hidden table has no notes for that user', r.status);

    // ---- saved query notes
    r = await ann('POST', '/api/queries', { name: 'Big orders', sql: 'SELECT 1' });
    const qid = r.data.id;
    r = await ann('POST', `/api/notes/queries/${qid}`, { text: 'Run monthly' });
    check(r.status === 201 && r.data.shared, 'the owner notes a saved query', r.data);
    r = await bob('GET', `/api/notes/queries/${qid}`);
    check(r.status === 404, 'a query nobody shared stays invisible');
    await ann('PUT', `/api/queries/${qid}/sharing`, { sharedWith: ['bob'] });
    r = await bob('GET', `/api/notes/queries/${qid}`);
    check(r.data.length === 1 && r.data[0].text === 'Run monthly', 'once shared, the notes are visible');
    r = await bob('POST', `/api/notes/queries/${qid}`, { text: 'Takes 2 minutes on prod' });
    check(r.status === 201, 'and the person it is shared with can add one');
    const bobNote = r.data.id;
    r = await cy('POST', `/api/notes/queries/${qid}`, { text: 'sneaky' });
    check(r.status === 404, 'someone it is not shared with cannot');
    r = await bob('GET', '/api/notes/queries');
    check(r.data[qid] === 2, 'note counts per query', r.data);
    r = await cy('GET', '/api/notes/queries');
    check(!(qid in r.data), 'counts only for visible queries');
    r = await ann('PUT', `/api/notes/${bobNote}`, { text: 'edited' });
    check(r.status === 403, 'the query owner cannot rewrite someone else\'s note');
    r = await ann('DELETE', `/api/notes/${bobNote}`);
    check(r.data.ok, 'but can delete it');
    r = await ann('DELETE', `/api/queries/${qid}`);
    r = await A('GET', `/api/notes/queries/${qid}`);
    check(r.status === 404, 'deleting the query is final');
    r = await bob('GET', '/api/notes/queries');
    check(!(qid in r.data), 'and removes its notes');

    // ---- bulk fixes
    await A('PUT', '/api/connections/shop/sharing', { sharedWith: ['ann', 'bob'], readOnly: true });
    const found = (await A('GET', '/api/explore/shop/anom/analyze')).data.findings;
    const fixes = found.filter((f) => f.fix && /^ALTER TABLE/i.test(f.fix) && !/DROP/i.test(f.fix)).slice(0, 3);
    check(fixes.length >= 2, 'the sample database has fixable findings', fixes.length);
    const items = fixes.map((f) => ({ rule: f.rule, object: f.object }));
    r = await A('POST', '/api/explore/shop/anom/analyze/apply-bulk', { items });
    check(r.status === 200 && r.data.items.length === items.length && r.data.items.every((i) => i.sql && i.denied === null), 'the preview lists every fix', r.data);
    check(found.filter((f) => f.fix).length > fixes.length, 'more findings than we picked');
    r = await A('POST', '/api/explore/shop/anom/analyze/apply-bulk', { items: [...items, { rule: 'no-such-rule', object: 'x' }] });
    check(r.data.items[items.length].skipped, 'an unknown finding is marked skipped', r.data.items[items.length]);
    r = await ann('POST', '/api/explore/shop/anom/analyze/apply-bulk', { items, confirm: true });
    check(r.status === 200 && r.data.applied === 0 && r.data.failed === items.length && r.data.results.every((x) => /Read-only|permission|not allowed/i.test(x.error)), 'a read-only user cannot apply them', r.data);
    r = await A('POST', '/api/explore/shop/anom/analyze/apply-bulk', { items: [...items, { rule: 'no-such-rule', object: 'x' }], confirm: true });
    check(r.data.applied === items.length && r.data.failed === 1, 'the owner applies them; the gone one fails alone', r.data);
    const after = (await A('GET', '/api/explore/shop/anom/analyze')).data.findings;
    check(items.every((i) => !after.some((f) => f.rule === i.rule && f.object === i.object)), 'the fixed findings are gone');
    r = await A('POST', '/api/explore/shop/anom/analyze/apply-bulk', { items: [] });
    check(r.status === 400, 'an empty selection is refused');
    const lg = (await A('GET', '/api/logs?source=analysis-fix')).data;
    check(lg.total >= items.length, 'each fix is in the query log', lg.total);

    // ---- all databases
    r = await A('GET', '/api/explore/shop/databases/analyze');
    const dbs = r.data.databases || [];
    check(r.status === 200 && dbs.some((d) => d.database === 'anom' && d.summary.total > 0 && d.fixable > 0) && dbs.some((d) => d.database === 'shop') && !dbs.some((d) => d.database === 'mysql'), 'every database gets a summary line (not the system ones)', dbs.map((d) => d.database));
    check(r.data.summary.total === dbs.reduce((n, d) => n + (d.summary ? d.summary.total : 0), 0), 'with a combined total');
    await A('PUT', '/api/connections/shop/sharing', { sharedWith: ['ann', 'bob'], readOnly: true, scopes: { ann: { databases: ['shop'], hideTables: [] } } });
    r = await ann('GET', '/api/explore/shop/databases/analyze');
    check(r.status === 200 && r.data.databases.length === 1 && r.data.databases[0].database === 'shop', 'a user limited to some databases only gets those', r.data.databases && r.data.databases.map((d) => d.database));
  } finally { await srv.stop(); }
  finish();
});
