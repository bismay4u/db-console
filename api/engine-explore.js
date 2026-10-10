// api/engine-explore.js
// The Explore API for PostgreSQL and SQLite connections: browsing, structure and editing rows. Everything else in
// Explore (schema editing, analysis, compare, backup, import…) is MySQL / MariaDB only for now.

const engines = require('./engines');

function handle(req, res, next, conn, { logAction, attachment, parseFilters }) {
  const engine = engines.engineOf(conn);
  const a = engines.adapterOf(engine);
  const segs = req.path.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
  const m = req.method;
  const fail = (status, err) => res.status(status).json({ error: err.message || String(err) });
  const send = (promise, status = 500) => promise.then((d) => res.json(d), (e) => fail(status, e));
  const [first, second, third, fourth] = segs;
  const unsupported = () => fail(400, engines.unsupported(engine, 'This part of Explore'));

  if (m === 'GET' && first === 'databases' && segs.length === 1) return send(a.listDatabases(conn));
  if (m === 'GET' && first === 'meta' && segs.length === 1) return send(a.serverMeta(conn));
  if (!first || first === 'databases' || first === 'meta') return unsupported();
  const database = first;

  if (segs.length === 2 && m === 'GET') {
    if (second === 'info') return send(a.databaseInfo(conn, database));
    if (second === 'objects') return send(a.listObjects(conn, database));
    if (second === 'tables') return send(a.listTables(conn, database));
    if (second === 'autocomplete') return send(a.autocomplete(conn, database));
    if (second === 'diagram') return send(a.diagram(conn, database));
    if (second === 'foreign-keys') return send(a.getDatabaseForeignKeys(conn, database));
  }
  if (segs.length === 4 && m === 'GET' && second === 'definition') return send(a.objectDefinition(conn, database, third, fourth));
  if (segs.length === 3) {
    const table = second;
    const base = `${database}.${table}`;
    if (m === 'GET' && third === 'schema') return send(a.tableSchema(conn, database, table), 400);
    if (m === 'GET' && third === 'indexes') return send(a.tableIndexes(conn, database, table));
    if (m === 'GET' && third === 'columns') return send(a.getTableColumns(conn, database, table));
    if (m === 'GET' && third === 'rows') {
      try {
        const { page, pageSize, sortCol, sortDir } = req.query;
        return send(a.browse(conn, database, table, { page, pageSize, sortCol, sortDir, sort: parseFilters(req.query.sort), filters: parseFilters(req.query.filters) }));
      } catch (e) { return fail(400, e); }
    }
    if (m === 'GET' && third === 'cell') {
      return a.cellValue(conn, database, table, JSON.parse(req.query.where || '{}'), String(req.query.col || '')).then((value) => {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value === null ? '' : String(value), 'utf8');
        res.setHeader('Content-Type', 'application/octet-stream');
        attachment(res, `${table}-${req.query.col}.bin`);
        res.end(buf);
      }, (e) => fail(400, e));
    }
    if (third === 'rows' && ['PUT', 'POST', 'DELETE'].includes(m)) {
      const { where, changes, values } = req.body || {};
      const spec = m === 'PUT'
        ? { type: 'UPDATE', sql: `UPDATE ${base} SET ${Object.keys(changes || {}).join(', ')} WHERE ${JSON.stringify(where)}`, run: () => a.updateRow(conn, database, table, where, changes) }
        : m === 'POST'
          ? { type: 'INSERT', sql: `INSERT INTO ${base} (${Object.keys(values || {}).join(', ')})`, run: () => a.insertRow(conn, database, table, values), status: 201 }
          : { type: 'DELETE', sql: `DELETE FROM ${base} WHERE ${JSON.stringify(where)}`, run: () => a.deleteRow(conn, database, table, where) };
      const start = Date.now();
      return spec.run().then((result) => {
        logAction(req, { source: 'explore', sql: spec.sql, type: spec.type, ok: true, durationMs: Date.now() - start, affectedRows: result.affectedRows });
        res.status(spec.status || 200).json(result);
      }, (err) => {
        logAction(req, { source: 'explore', sql: spec.sql, type: spec.type, ok: false, error: err.message, durationMs: Date.now() - start });
        fail(400, err);
      });
    }
    if (m === 'GET' && third === 'export.csv') {
      const { sortCol, sortDir } = req.query;
      const start = Date.now();
      let filters;
      try { filters = parseFilters(req.query.filters); } catch (e) { return fail(400, e); }
      const format = req.query.format === 'tsv' ? 'tsv' : 'csv';
      attachment(res, `${table}.${format}`);
      return a.streamTableCsv(conn, database, table, res, { sortCol, sortDir, sort: parseFilters(req.query.sort), filters, format }).then((r) => {
        logAction(req, { source: 'export', sql: `EXPORT ${base} ${format.toUpperCase()}`, type: 'SELECT', ok: true, rowCount: r.rows, durationMs: Date.now() - start });
      }, (err) => {
        logAction(req, { source: 'export', sql: `EXPORT ${base}`, type: 'SELECT', ok: false, error: err.message, durationMs: Date.now() - start });
        if (!res.headersSent) fail(400, err); else res.end();
      });
    }
  }
  return unsupported();
}

module.exports = { handle };
