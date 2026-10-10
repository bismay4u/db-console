// api/engines/index.js
// Which database engine a connection uses, and its adapter. MySQL / MariaDB is the original, full-featured engine
// (api/db.js and friends); PostgreSQL and SQLite are adapters with the core features: Query Runner, data browsing and
// editing, structure, CSV downloads, schedules for queries and connection checks.

const store = require('../store');

const ENGINES = {
  mysql: { label: 'MySQL / MariaDB', defaultPort: 3306 },
  postgres: { label: 'PostgreSQL', defaultPort: 5432 },
  sqlite: { label: 'SQLite', defaultPort: null }
};

const engineOf = (conn) => (conn && ENGINES[conn.engine] ? conn.engine : 'mysql');
const adapterOf = (engine) => (engine === 'postgres' ? require('./postgres') : engine === 'sqlite' ? require('./sqlite') : null);

// { conn, a: adapter, engine } for a connection that is not MySQL; null for MySQL (the caller's normal path).
function forKey(key) {
  const conn = store.getConnection(key);
  const engine = engineOf(conn);
  if (!conn || engine === 'mysql') return null;
  if (conn.secretError) throw new Error(conn.secretError);
  return { conn, a: adapterOf(engine), engine };
}
function forConn(conn) {
  const engine = engineOf(conn);
  return engine === 'mysql' ? null : { conn, a: adapterOf(engine), engine };
}

const unsupported = (engine, what = 'This') => new Error(`${what} is not available for ${ENGINES[engine].label} connections yet`);

function dropPool(key) { for (const e of ['postgres', 'sqlite']) { try { adapterOf(e).dropPool(key); } catch (err) { /* driver not loaded */ } } }
async function closeAll() { await Promise.allSettled(['postgres', 'sqlite'].map((e) => { try { return adapterOf(e).closeAll(); } catch (err) { return null; } })); }

module.exports = { ENGINES, engineOf, adapterOf, forKey, forConn, unsupported, dropPool, closeAll };
