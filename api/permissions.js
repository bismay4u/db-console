// api/permissions.js
// What a user a connection is shared with may do. Reading (browse, search,
// SELECT / SHOW / EXPLAIN, export, diagram) is always allowed; everything
// that changes something needs one of these permissions. The owner and
// admins can always do everything.

const PERMISSIONS = [
  { key: 'insert', label: 'Add rows', help: 'Add rows, import CSV/TSV' },
  { key: 'update', label: 'Edit rows', help: 'Edit rows in the grid, bulk edit' },
  { key: 'delete', label: 'Delete rows', help: 'Delete rows' },
  { key: 'create', label: 'Create', help: 'Create tables, views, procedures, functions, triggers, events and databases; copy tables' },
  { key: 'alter', label: 'Change structure', help: 'Alter tables (columns, foreign keys), rename, alter databases, optimize/repair' },
  { key: 'index', label: 'Indexes', help: 'Create, change and drop indexes' },
  { key: 'drop', label: 'Drop', help: 'Drop tables, views, procedures, functions, triggers, events and databases' },
  { key: 'truncate', label: 'Truncate', help: 'Empty tables with TRUNCATE' },
  { key: 'restore', label: 'Restore', help: 'Restore a backup / run a SQL file' },
  { key: 'sql', label: 'Any SQL', help: 'Run other statements in the Query Runner (CALL, SET, transactions, …)' }
];
const ALL = PERMISSIONS.map((p) => p.key);
const LABELS = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.label]));

const PRESETS = [
  { key: 'read', label: 'Read-only', permissions: [] },
  { key: 'data', label: 'Data editor', permissions: ['insert', 'update', 'delete'] },
  { key: 'developer', label: 'Developer', permissions: ['insert', 'update', 'delete', 'create', 'alter', 'index'] },
  { key: 'full', label: 'Full access', permissions: ALL }
];

function clean(list) {
  return ALL.filter((p) => Array.isArray(list) && list.includes(p));
}

// A map { username | '*': [permissions] } with unknown names and permissions dropped.
function cleanMap(map, allowed) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [name, perms] of Object.entries(map)) {
    if (!Array.isArray(perms)) continue;
    if (allowed && !allowed.includes(name)) continue;
    out[name] = clean(perms);
  }
  return out;
}

// Permissions of `username` on a connection they are shared with (not the
// owner). Connections shared before permissions existed have none stored:
// they were full access, or read-only if shared with the old read-only switch.
function sharedPermissions(conn, username) {
  const map = conn.sharePermissions;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    if (Array.isArray(map[username])) return clean(map[username]);
    if (Array.isArray(map['*'])) return clean(map['*']);
  }
  return conn.readOnlyShare ? [] : ALL.slice();
}

// ---- Query Runner statements ----
// Which permission(s) a statement needs: 'read' for statements that only
// read, otherwise a list of permissions. Anything not recognised needs 'sql'.
function stripLeading(sql) {
  return String(sql).replace(/^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '');
}

function statementNeeds(sql) {
  const s = stripLeading(sql);
  const word = (s.match(/^[a-z]+/i) || [''])[0].toLowerCase();
  switch (word) {
    case 'select': case 'show': case 'describe': case 'desc': case 'explain': case 'use':
    case 'table': case 'values': case 'help': case 'checksum': case 'check':
      return 'read';
    case 'with': return 'read'; // runs in a READ ONLY transaction when restricted, so a writing CTE fails
    case 'insert': return /\bon\s+duplicate\s+key\s+update\b/i.test(s) ? ['insert', 'update'] : ['insert'];
    case 'replace': return ['insert', 'delete'];
    case 'update': return ['update'];
    case 'delete': return ['delete'];
    case 'truncate': return ['truncate'];
    case 'drop': return /^drop\s+(online\s+|offline\s+)?(unique\s+|fulltext\s+|spatial\s+)?index\b/i.test(s) ? ['index'] : ['drop'];
    case 'create': return /^create\s+(or\s+replace\s+)?(unique\s+|fulltext\s+|spatial\s+)?index\b/i.test(s) ? ['index']
      : (/^create\s+or\s+replace\b/i.test(s) ? ['create', 'drop'] : ['create']);
    case 'alter': return ['alter'];
    case 'rename': return ['alter'];
    case 'analyze': case 'optimize': case 'repair': return ['alter'];
    default: return ['sql'];
  }
}

// null when `allowed` (a Set; null = no restrictions) lets the statement run,
// otherwise the error to show.
function statementDenied(sql, allowed) {
  if (!allowed) return null;
  const s = stripLeading(sql);
  const word = (s.match(/^[a-z]+/i) || [''])[0].toUpperCase();
  const needs = statementNeeds(sql);
  if (needs === 'read') {
    if (/\binto\s+(outfile|dumpfile)\b/i.test(s)) return 'Not allowed: SELECT … INTO OUTFILE/DUMPFILE writes a file on the server';
    return null;
  }
  const missing = needs.filter((p) => !allowed.has(p));
  if (!missing.length) return null;
  if (!allowed.size) return `Read-only access: only SELECT, SHOW, DESCRIBE, EXPLAIN and USE are allowed (refused: ${word})`;
  return `You don't have permission to run ${word} on this connection (needs: ${missing.map((p) => LABELS[p]).join(', ')})`;
}

// Permissions an Explore request needs, from its method and path below
// /api/explore/:key. Unknown write routes need everything.
function exploreRequirement(method, segments, body = {}, query = {}) {
  const [db, second, third] = segments;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return [];
  if (db === 'databases' && segments.length === 1 && m === 'POST') return ['create'];
  if (segments.length === 1) return m === 'PUT' ? ['alter'] : m === 'DELETE' ? ['drop'] : ALL;
  if (second === 'tables' && segments.length === 2 && m === 'POST') return ['create'];
  if (second === 'table-actions') {
    switch (body.action) {
      case 'truncate': return ['truncate'];
      case 'drop': return ['drop'];
      case 'optimize': case 'analyze': case 'check': case 'repair': return ['alter'];
      case 'copy': return body.withData === false ? ['create'] : ['create', 'insert'];
      case 'move': return ['create', 'drop'];
      default: return ALL;
    }
  }
  if (second === 'objects' && third === 'save') return body.name ? ['alter'] : ['create'];
  if (second === 'objects' && third === 'drop') return ['drop'];
  if (second === 'restore') return ['restore'];
  // applying an analysis fix is checked statement by statement in the route itself
  if (second === 'analyze' && third === 'apply') return [];
  if (segments.length === 3) {
    switch (third) {
      case 'rows': return m === 'POST' ? ['insert'] : m === 'PUT' ? ['update'] : m === 'DELETE' ? ['delete'] : ALL;
      case 'bulk-update': return ['update'];
      case 'alter': case 'foreign-keys': return ['alter'];
      case 'indexes': return ['index'];
      case 'import': return body.truncate ? ['insert', 'truncate'] : ['insert'];
      case 'import-file': {
        let o = {};
        try { o = JSON.parse(query.options || '{}'); } catch (e) { /* bad options are rejected by the route */ }
        const needs = ['insert'];
        if (o.onDuplicate === 'update') needs.push('update');
        if (o.onDuplicate === 'replace') needs.push('update', 'delete');
        if (o.truncate) needs.push('truncate');
        return needs;
      }
      default: return ALL;
    }
  }
  return ALL;
}

module.exports = { PERMISSIONS, ALL, PRESETS, LABELS, clean, cleanMap, sharedPermissions, statementNeeds, statementDenied, exploreRequirement };
