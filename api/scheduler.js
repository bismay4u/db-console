// api/scheduler.js
// Runs the scheduled jobs (see jobs.js).
//
// Under PM2 cluster mode every worker starts a scheduler, but only one is the
// leader at a time: the leader holds data/.scheduler.lock and renews it on every tick;
// when it stops (or dies) another worker takes over after 30 seconds. A per-job lock
// file keeps a job from running twice at once, even when "Run now" is pressed on
// another worker.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { DATA_DIR, readJson, writeJson, withLock, ensureDir } = require('./datadir');
const jobs = require('./jobs');
const store = require('./store');
const db = require('./db');
const params = require('./params');
const notify = require('./notify');
const uploader = require('./uploader');
const analyzer = require('./analyzer');
const querylog = require('./querylog');
const access = require('./access');

const LEADER_FILE = path.join(DATA_DIR, '.scheduler.lock');
const LOCK_DIR = path.join(DATA_DIR, 'job-locks');
const LEADER_STALE_MS = 30000;
const MAX_CONCURRENT = 3;
const running = new Set();
let timer = null;
let leader = false;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function claimLeadership() {
  return withLock(() => {
    const cur = readJson(LEADER_FILE, {});
    const mine = cur.pid === process.pid;
    if (mine || !cur.pid || Date.now() - (cur.ts || 0) > LEADER_STALE_MS || !alive(cur.pid)) {
      writeJson(LEADER_FILE, { pid: process.pid, ts: Date.now() });
      return true;
    }
    return false;
  });
}
function releaseLeadership() {
  try { withLock(() => { if (readJson(LEADER_FILE, {}).pid === process.pid) fs.rmSync(LEADER_FILE, { force: true }); }); } catch (e) { /* ignore */ }
}

// ---------- per-job lock ----------
function acquire(id) {
  ensureDir();
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = path.join(LOCK_DIR, id + '.lock');
  return withLock(() => {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* none */ }
    if (cur && alive(cur.pid) && Date.now() - cur.ts < 6 * 3600 * 1000) return false;
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  });
}
const release = (id) => { try { fs.rmSync(path.join(LOCK_DIR, id + '.lock'), { force: true }); } catch (e) { /* ignore */ } };

// ---------- helpers ----------
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
const sizeText = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');

function pruneFiles(dir, match, keep) {
  if (!(keep > 0)) return 0;
  let names;
  try { names = fs.readdirSync(dir).filter(match).sort().reverse(); } catch (e) { return 0; }
  for (const n of names.slice(keep)) fs.rmSync(path.join(dir, n), { force: true });
  return Math.max(names.length - keep, 0);
}

function ownerOf(job) {
  const user = store.getUser(job.owner);
  if (!user || user.disabled) throw new Error(`The job's owner (${job.owner}) no longer has an active account`);
  return user;
}
function connectionFor(job, user, { manage = false } = {}) {
  const conn = store.getConnection(job.connKey);
  if (!conn) throw new Error('The connection no longer exists');
  if (!access.canUse(user, conn)) throw new Error(`${user.username} no longer has access to ${conn.label}`);
  if (manage && !access.canManage(user, conn)) throw new Error('Backups need owner or admin rights on the connection');
  return conn;
}

// ---------- runners: each returns { ok, message, summary, file?, notify: boolean, attachments? } ----------

async function runQueryJob(job) {
  const user = ownerOf(job);
  const conn = connectionFor(job, user);
  const sql = params.apply(job.sql, job.params || {});
  const allowed = access.restrictionsFor(user, conn);
  const database = job.database || conn.database;
  const started = Date.now();
  const entry = { username: user.username, source: 'schedule', connKey: conn.key, connLabel: conn.label, database, sql };
  try {
    if (db.isExportable(sql)) {
      const dir = jobs.outputDir(job.id);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${stamp()}.csv`;
      const file = path.join(dir, name);
      const out = fs.createWriteStream(file, { mode: 0o600 });
      let r;
      try {
        r = await db.exportQueryResult(conn.key, sql, { format: 'csv', bom: false, nulls: 'empty', maxRows: job.maxRows, database, allowed }, out, () => {});
      } catch (e) { out.destroy(); fs.rmSync(file, { force: true }); throw e; }
      const bytes = fs.statSync(file).size;
      pruneFiles(dir, (n) => n.endsWith('.csv'), job.keepFiles);
      querylog.record({ ...entry, type: querylog.statementType(sql), ok: true, rowCount: r.rows, durationMs: Date.now() - started });
      const head = fs.readFileSync(file, 'utf8').slice(0, 3000);
      const sample = head.split('\n').slice(0, 11).join('\n');
      const message = `${r.rows.toLocaleString()} row(s)${r.truncated ? ` (stopped at the ${job.maxRows.toLocaleString()}-row limit)` : ''}, ${sizeText(bytes)}`;
      const notifyNow = { failure: false, always: true, rows: r.rows > 0, norows: r.rows === 0 }[job.notifyWhen];
      return {
        ok: true, message, summary: { rows: r.rows, bytes, truncated: r.truncated }, file: name, notify: notifyNow,
        body: `${message}\n\nFirst lines:\n${sample}`,
        attachments: job.attach && bytes <= 10 * 1048576 ? [{ filename: name, path: file }] : undefined
      };
    }
    const result = await db.runQuery(conn.key, sql, { database, allowed });
    const failed = result.statements.find((s) => !s.ok);
    const affected = result.statements.reduce((a, s) => a + (s.affectedRows || 0), 0);
    querylog.record({ ...entry, type: 'MULTI', ok: result.ok, error: failed ? failed.error : null, affectedRows: affected, statementCount: result.statements.length, durationMs: Date.now() - started });
    if (!result.ok) throw new Error(failed ? failed.error : 'The statement failed');
    const message = `${result.statements.length} statement(s) ran, ${affected.toLocaleString()} row(s) affected`;
    return { ok: true, message, summary: { statements: result.statements.length, affected }, notify: job.notifyWhen === 'always' };
  } catch (e) {
    querylog.record({ ...entry, type: querylog.statementType(sql), ok: false, error: e.message, durationMs: Date.now() - started });
    throw e;
  }
}

async function runAnalysisJob(job, previous) {
  const user = ownerOf(job);
  connectionFor(job, user);
  const r = await analyzer.analyze(job.connKey, job.database);
  const s = r.summary;
  const prev = previous && previous.summary;
  const message = `${s.error} error(s), ${s.warning} warning(s), ${s.info} note(s) in ${r.tables} table(s)`;
  const worse = prev ? (s.error + s.warning) > (prev.error + prev.warning) : (s.error + s.warning) > 0;
  const top = r.findings.filter((f) => f.severity !== 'info').slice(0, 15).map((f) => `[${f.severity}] ${f.ruleTitle}: ${f.table ? f.table + ' — ' : ''}${f.message || f.object}`);
  return {
    ok: true, message, summary: { error: s.error, warning: s.warning, info: s.info, total: s.total, tables: r.tables, previous: prev ? { error: prev.error, warning: prev.warning } : null },
    notify: { failure: false, always: true, errors: s.error > 0, worse }[job.notifyWhen],
    body: `${message}${prev ? `\nBefore: ${prev.error} error(s), ${prev.warning} warning(s)` : ''}\n\n${top.join('\n') || 'Nothing to fix.'}`
  };
}

async function runBackupJob(job) {
  const user = ownerOf(job);
  const conn = connectionFor(job, user, { manage: true });
  const dir = jobs.backupDir(job.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${job.database}-${stamp()}${job.backup.schemaOnly ? '-schema' : ''}.sql.gz`;
  const file = path.join(dir, name);
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(file, { mode: 0o600 });
  gz.pipe(out);
  const finished = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.on('error', reject); });
  try {
    await db.streamDatabaseBackup(conn.key, job.database, gz, { data: !job.backup.schemaOnly, createDatabase: false });
    gz.end();
    await finished;
  } catch (e) { gz.destroy(); out.destroy(); fs.rmSync(file, { force: true }); throw e; }
  const bytes = fs.statSync(file).size;
  const parts = [`${name} (${sizeText(bytes)})`];
  const summary = { file: name, bytes };
  let ok = true;

  if (job.backup.restoreTest) {
    const t = await restoreTest(conn.key, job.database, file);
    summary.restoreTest = t;
    parts.push(t.ok ? `restore test passed (${t.tables} table(s)${t.driftTables ? `, ${t.driftTables} with a different row count — data changed meanwhile?` : ''})` : `RESTORE TEST FAILED: ${t.error}`);
    if (!t.ok) ok = false;
  }
  if (job.backup.upload && job.backup.upload.type) {
    try {
      const r = await uploader.upload(job.backup.upload, file, { name, prefix: `${job.database}-`, keep: job.backup.keep });
      summary.uploaded = r.target;
      parts.push(`uploaded to ${r.target}`);
    } catch (e) { parts.push(`UPLOAD FAILED: ${e.message}`); summary.uploadError = e.message; ok = false; }
  }
  const removed = pruneFiles(dir, (n) => n.startsWith(job.database + '-') && n.endsWith('.sql.gz'), job.backup.keep);
  if (removed) parts.push(`${removed} old backup(s) removed`);
  summary.removed = removed;
  return { ok, message: parts.join('; '), summary, file: name, notify: ok ? job.notifyWhen === 'always' : true, failureMessage: ok ? undefined : parts.join('; ') };
}

// Restores the dump into a throwaway database on the same server, compares tables and row counts, drops it.
async function restoreTest(key, database, file) {
  const pool = db.getPool(key);
  const scratch = 'dbc_rt_' + crypto.randomBytes(4).toString('hex');
  const q = (n) => '`' + n.replace(/`/g, '``') + '`';
  try {
    await pool.query(`CREATE DATABASE ${q(scratch)}`);
  } catch (e) { return { ok: false, error: `could not create a scratch database (${e.message})` }; }
  try {
    const r = await db.restoreDump(key, scratch, fs.createReadStream(file), 'sqlgz', null, { onError: 'continue' });
    if (r.failed) return { ok: false, error: `${r.failed} statement(s) failed to restore: ${(r.errors && r.errors[0] && r.errors[0].error) || ''}`.trim() };
    const names = async (d) => (await db.listTables(key, d)).filter((t) => t.type === 'BASE TABLE').map((t) => t.name);
    const [a, b] = await Promise.all([names(database), names(scratch)]);
    const missing = a.filter((n) => !b.includes(n));
    if (missing.length) return { ok: false, error: `tables missing after the restore: ${missing.slice(0, 5).join(', ')}` };
    let drift = 0;
    for (const n of a.slice(0, 200)) {
      const [[x]] = await pool.query(`SELECT COUNT(*) AS c FROM ${q(database)}.${q(n)}`);
      const [[y]] = await pool.query(`SELECT COUNT(*) AS c FROM ${q(scratch)}.${q(n)}`);
      if (Number(x.c) !== Number(y.c)) drift++;
    }
    return { ok: true, tables: a.length, driftTables: drift, statements: r.executed };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS ${q(scratch)}`).catch(() => {});
  }
}

async function runHealthJob(job) {
  const user = ownerOf(job);
  const all = store.listConnections().filter((c) => access.canUse(user, c));
  const targets = job.connKeys && job.connKeys.length ? all.filter((c) => job.connKeys.includes(c.key)) : all;
  if (!targets.length) throw new Error('There is no connection to check');
  const prev = (job.state && job.state.conns) || {};
  const next = {};
  const changes = [];
  const down = [];
  await Promise.all(targets.map(async (c) => {
    const t0 = Date.now();
    let err = null;
    try {
      const pool = db.getPool(c.key);
      await pool.query({ sql: 'SELECT 1', timeout: 10000 });
    } catch (e) { err = e.message; }
    const was = prev[c.key];
    next[c.key] = { up: !err, since: was && was.up === !err ? was.since : new Date().toISOString(), error: err || undefined, ms: Date.now() - t0 };
    if (err) down.push(`${c.label}: ${err}`);
    if (was && was.up !== !err) changes.push(err ? `DOWN  ${c.label}: ${err}` : `UP    ${c.label} is reachable again`);
    if (!was && err) changes.push(`DOWN  ${c.label}: ${err}`);
  }));
  const message = down.length ? `${down.length} of ${targets.length} connection(s) down` : `all ${targets.length} connection(s) reachable`;
  return {
    ok: !down.length, message, summary: { checked: targets.length, down: down.length, changes: changes.length }, state: { conns: next },
    notify: job.notifyWhen === 'always' || changes.length > 0,
    body: `${message}\n\n${changes.join('\n') || down.join('\n') || 'No change.'}`,
    failureMessage: down.join('; ') || undefined
  };
}

const RUNNERS = { query: runQueryJob, analysis: runAnalysisJob, backup: runBackupJob, health: runHealthJob };

// ---------- running a job ----------

async function runJob(job, { trigger = 'schedule', by = null } = {}) {
  if (running.size >= MAX_CONCURRENT && trigger === 'schedule') return null;
  if (!acquire(job.id)) return { skipped: true, message: 'This job is already running' };
  running.add(job.id);
  const run = { id: crypto.randomBytes(5).toString('hex'), jobId: job.id, jobName: job.name, type: job.type, trigger, by, at: new Date().toISOString() };
  const t0 = Date.now();
  let out;
  try {
    const previous = jobs.runsFor(job.id, 1).find((r) => r.ok);
    out = await RUNNERS[job.type](job, previous);
  } catch (e) {
    out = { ok: false, message: e.message, notify: true };
  }
  try {
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - t0;
    run.ok = out.ok;
    run.message = out.message;
    run.summary = out.summary;
    if (out.file) run.file = out.file;
    // Deliver the alert before the history is written, so the record says who was told.
    // Every runner decides for itself (out.notify): failures always do, except a health check
    // that is still down, which only speaks when something changed.
    if (out.notify) {
      const subject = `[DB Console] ${out.ok ? 'OK' : 'FAILED'} — ${job.name}`;
      const link = notify.link('/#/schedules');
      const text = `${job.name} (${job.type})\n${out.ok ? '' : 'Problem: '}${out.failureMessage || out.message}\n\n${out.body && out.body !== out.message ? out.body : ''}${link ? `\n${link}` : ''}`.trim();
      const d = await notify.deliver({
        subject, text, to: job.emails, webhook: job.webhook, attachments: out.attachments,
        data: { event: 'job.finished', job: { id: job.id, name: job.name, type: job.type }, ok: out.ok, message: out.message, summary: out.summary, at: run.finishedAt }
      });
      run.notified = d.sent;
      if (d.errors.length) run.notifyErrors = d.errors;
    }
    jobs.appendRun(run);
    jobs.patch(job.id, { lastRun: { at: run.at, ok: run.ok, message: run.message, durationMs: run.durationMs, runId: run.id }, ...(out.state ? { state: { ...(job.state || {}), ...out.state } } : {}) });
  } finally {
    running.delete(job.id);
    release(job.id);
  }
  return run;
}

// Starts a run now, regardless of the schedule. Resolves when it has finished.
async function runNow(id, by) {
  const job = jobs.get(id);
  if (!job) return null;
  return runJob(job, { trigger: 'manual', by });
}

async function tick() {
  try {
    leader = claimLeadership();
    if (!leader) return;
    const now = Date.now();
    for (const job of jobs.list()) {
      if (!job.enabled || !job.schedule || running.has(job.id)) continue;
      if (!job.nextRunAt) { jobs.patch(job.id, { nextRunAt: jobs.nextRunAt(job) }); continue; }
      if (Date.parse(job.nextRunAt) > now) continue;
      if (running.size >= MAX_CONCURRENT) break;
      jobs.patch(job.id, { nextRunAt: jobs.nextRunAt(job) });
      runJob(job, { trigger: 'schedule' }).catch((e) => console.error(`Scheduled job ${job.name} failed: ${e.message}`));
    }
  } catch (e) {
    console.error('Scheduler tick failed:', e.message);
  }
}

function start({ tickMs = Number(process.env.SCHEDULER_TICK_MS) || 15000 } = {}) {
  if (process.env.SCHEDULER === 'off' || timer) return;
  timer = setInterval(tick, tickMs);
  timer.unref();
  setTimeout(tick, 1000).unref();
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (leader) releaseLeadership();
}

module.exports = { start, stop, runNow, runJob, restoreTest, isLeader: () => leader, runningIds: () => [...running] };
