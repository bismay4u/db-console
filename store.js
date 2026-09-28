// store.js
// Simple JSON-file-backed store for:
//   - database connections (added/edited/removed from the UI)
//   - saved SQL queries
//
// Good enough for a small internal admin tool. If you need concurrent
// multi-user editing or something heavier, swap this for a real table.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const QUERIES_FILE = path.join(DATA_DIR, 'queries.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(CONNECTIONS_FILE)) {
    // Seed from config.js on first run, if it has a "databases" array.
    let seed = [];
    try {
      const config = require('./config');
      if (Array.isArray(config.databases)) {
        seed = config.databases.map((d) => ({
          key: d.key,
          label: d.label,
          host: d.host,
          port: d.port,
          user: d.user,
          password: d.password || '',
          database: d.database
        }));
      }
    } catch (e) {
      // no config seed available, that's fine
    }
    writeJson(CONNECTIONS_FILE, seed);
  }

  if (!fs.existsSync(QUERIES_FILE)) {
    writeJson(QUERIES_FILE, []);
  }
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.trim() ? JSON.parse(raw) : [];
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '') || 'conn';
}

// ---------- Connections ----------

function listConnections() {
  return readJson(CONNECTIONS_FILE);
}

function getConnection(key) {
  return listConnections().find((c) => c.key === key) || null;
}

function createConnection(data) {
  const conns = listConnections();
  let base = slugify(data.label || 'conn');
  let key = base;
  let i = 2;
  while (conns.some((c) => c.key === key)) {
    key = `${base}-${i++}`;
  }

  const conn = {
    key,
    label: data.label,
    host: data.host,
    port: Number(data.port) || 3306,
    user: data.user,
    password: data.password || '',
    database: data.database
  };

  conns.push(conn);
  writeJson(CONNECTIONS_FILE, conns);
  return conn;
}

function updateConnection(key, data) {
  const conns = listConnections();
  const idx = conns.findIndex((c) => c.key === key);
  if (idx === -1) return null;

  const existing = conns[idx];
  const updated = {
    ...existing,
    label: data.label ?? existing.label,
    host: data.host ?? existing.host,
    port: data.port !== undefined ? Number(data.port) : existing.port,
    user: data.user ?? existing.user,
    // Keep existing password if a blank one is submitted (means "unchanged")
    password: data.password ? data.password : existing.password,
    database: data.database ?? existing.database
  };

  conns[idx] = updated;
  writeJson(CONNECTIONS_FILE, conns);
  return updated;
}

function deleteConnection(key) {
  const conns = listConnections();
  const next = conns.filter((c) => c.key !== key);
  const changed = next.length !== conns.length;
  if (changed) writeJson(CONNECTIONS_FILE, next);
  return changed;
}

// ---------- Saved queries ----------

function listQueries() {
  return readJson(QUERIES_FILE);
}

function createQuery(data) {
  const queries = listQueries();
  const query = {
    id: crypto.randomUUID(),
    name: data.name,
    sql: data.sql,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  queries.unshift(query);
  writeJson(QUERIES_FILE, queries);
  return query;
}

function updateQuery(id, data) {
  const queries = listQueries();
  const idx = queries.findIndex((q) => q.id === id);
  if (idx === -1) return null;

  queries[idx] = {
    ...queries[idx],
    name: data.name ?? queries[idx].name,
    sql: data.sql ?? queries[idx].sql,
    updatedAt: new Date().toISOString()
  };
  writeJson(QUERIES_FILE, queries);
  return queries[idx];
}

function deleteQuery(id) {
  const queries = listQueries();
  const next = queries.filter((q) => q.id !== id);
  const changed = next.length !== queries.length;
  if (changed) writeJson(QUERIES_FILE, next);
  return changed;
}

module.exports = {
  ensureStore,
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  listQueries,
  createQuery,
  updateQuery,
  deleteQuery
};
