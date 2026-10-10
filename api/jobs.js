// api/jobs.js
// Storage for scheduled jobs (data/jobs.json) and their run history (data/job-runs.jsonl).
// Job types:
//   query     run a SQL statement on a schedule; save the rows as CSV, email or post them
//   analysis  analyse a database and track the findings over time
//   backup    dump a database to a .sql.gz, keep the newest N, optionally upload and test-restore it
//   health    check that connections are reachable and alert when one goes down or comes back

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, readJson, writeJson, withLock, ensureDir } = require('./datadir');
const secrets = require('./secrets');
const cron = require('./cron');
const params = require('./params');
const notify = require('./notify');

const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const RUNS_FILE = path.join(DATA_DIR, 'job-runs.jsonl');
const TYPES = ['query', 'analysis', 'backup', 'health'];
const NOTIFY_WHEN = {
  query: ['failure', 'always', 'rows', 'norows'],
  analysis: ['failure', 'always', 'errors', 'worse'],
  backup: ['failure', 'always'],
  health: ['change', 'always']
};
const UPLOAD_SECRETS = ['secretAccessKey', 'password', 'privateKey', 'passphrase'];

const outputDir = (id) => path.join(DATA_DIR, 'job-output', id);
const backupDir = (id) => path.join(DATA_DIR, 'backups', id);

function list() {
  return readJson(JOBS_FILE).map((j) => {
    const out = JSON.parse(JSON.stringify(j));
    const up = out.backup && out.backup.upload;
    if (up) for (const f of UPLOAD_SECRETS) if (secrets.isEncrypted(up[f])) { try { up[f] = secrets.decrypt(up[f]); } catch (e) { up[f] = ''; } }
    return out;
  });
}
const get = (id) => list().find((j) => j.id === id) || null;

function save(jobs) {
  writeJson(JOBS_FILE, jobs.map((j) => {
    const out = JSON.parse(JSON.stringify(j));
    const up = out.backup && out.backup.upload;
    if (up) for (const f of UPLOAD_SECRETS) if (up[f]) up[f] = secrets.encrypt(up[f]);
    return out;
  }));
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// Checks and cleans what the browser sent. `existing` supplies secrets left blank.
function normalize(body = {}, existing = null) {
  const type = existing ? existing.type : body.type;
  if (!TYPES.includes(type)) throw new Error('Unknown job type');
  const job = {
    name: str(body.name ?? existing?.name, 80),
    type,
    enabled: body.enabled === undefined ? (existing ? existing.enabled : true) : Boolean(body.enabled),
    schedule: str(body.schedule ?? existing?.schedule ?? '', 100),
    connKey: str(body.connKey ?? existing?.connKey, 100),
    database: str(body.database ?? existing?.database, 128),
    notifyWhen: str(body.notifyWhen ?? existing?.notifyWhen ?? NOTIFY_WHEN[type][0], 20),
    emails: str(body.emails ?? existing?.emails ?? '', 500),
    webhook: Boolean(body.webhook ?? existing?.webhook)
  };
  if (!job.name) throw new Error('Give the job a name');
  if (job.schedule) job.schedule = cron.validate(job.schedule);
  if (!NOTIFY_WHEN[type].includes(job.notifyWhen)) throw new Error('Unknown "notify when" choice');
  const bad = job.emails ? job.emails.split(/[,;\s]+/).filter(Boolean).filter((e) => !notify.addresses(e).length) : [];
  if (bad.length) throw new Error(`Not an email address: ${bad[0]}`);

  if (type === 'health') {
    job.connKeys = Array.isArray(body.connKeys ?? existing?.connKeys) ? (body.connKeys ?? existing.connKeys).map((k) => str(k, 100)).filter(Boolean) : [];
    delete job.connKey; delete job.database;
  } else if (!job.connKey) throw new Error('Choose a connection');
  if (type !== 'health' && type !== 'query' && !job.database) throw new Error('Choose a database');

  if (type === 'query') {
    job.sql = String(body.sql ?? existing?.sql ?? '').trim();
    if (!job.sql) throw new Error('Enter the SQL to run');
    job.params = (body.params && typeof body.params === 'object') ? Object.fromEntries(Object.entries(body.params).map(([k, v]) => [str(k, 64), str(v, 1000)])) : (existing?.params || {});
    for (const p of params.extract(job.sql)) if (job.params[p.name] === undefined && p.default === undefined) throw new Error(`Give a value for the parameter {{${p.name}}} (or a default: {{${p.name}=…}})`);
    job.maxRows = Math.min(Math.max(parseInt(body.maxRows ?? existing?.maxRows ?? 100000, 10) || 100000, 1), 5000000);
    job.keepFiles = Math.min(Math.max(parseInt(body.keepFiles ?? existing?.keepFiles ?? 10, 10) || 0, 0), 500);
    job.attach = Boolean(body.attach ?? existing?.attach);
  }
  if (type === 'backup') {
    const b = body.backup || {};
    const e = (existing && existing.backup) || {};
    job.backup = {
      keep: Math.min(Math.max(parseInt(b.keep ?? e.keep ?? 7, 10) || 1, 1), 1000),
      schemaOnly: Boolean(b.schemaOnly ?? e.schemaOnly),
      restoreTest: Boolean(b.restoreTest ?? e.restoreTest)
    };
    const u = b.upload === undefined ? e.upload : b.upload;
    if (u && u.type) {
      if (!['s3', 'sftp'].includes(u.type)) throw new Error('Unknown upload type');
      const old = (e.upload && e.upload.type === u.type) ? e.upload : {};
      const up = { type: u.type };
      const fields = u.type === 's3' ? ['endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey'] : ['host', 'port', 'user', 'path', 'password', 'privateKey', 'passphrase'];
      for (const f of fields) {
        const v = u[f];
        if (UPLOAD_SECRETS.includes(f)) up[f] = v ? String(v) : (old[f] || '');
        else up[f] = v === undefined ? (old[f] ?? '') : str(v, 300);
      }
      if (u.type === 's3' && (!up.bucket || !up.accessKeyId || !up.secretAccessKey)) throw new Error('S3 needs a bucket, an access key id and a secret access key');
      if (u.type === 'sftp' && (!up.host || !up.user)) throw new Error('SFTP needs a host and a user');
      if (u.type === 'sftp' && !up.password && !up.privateKey) throw new Error('SFTP needs a password or a private key');
      job.backup.upload = up;
    }
  }
  return job;
}

const nextRunAt = (job, from = new Date()) => {
  if (!job.enabled || !job.schedule) return null;
  const d = cron.next(job.schedule, from);
  return d ? d.toISOString() : null;
};

function create(body, owner) {
  const job = normalize(body);
  return withLock(() => {
    const jobs = list();
    const full = { id: crypto.randomBytes(6).toString('hex'), ...job, owner, createdAt: new Date().toISOString(), nextRunAt: null, lastRun: null, state: {} };
    full.nextRunAt = nextRunAt(full);
    jobs.push(full);
    save(jobs);
    return full;
  });
}

function update(id, body) {
  return withLock(() => {
    const jobs = list();
    const i = jobs.findIndex((j) => j.id === id);
    if (i === -1) return null;
    const merged = { ...jobs[i], ...normalize(body, jobs[i]) };
    merged.nextRunAt = nextRunAt(merged);
    jobs[i] = merged;
    save(jobs);
    return merged;
  });
}

// Changes bookkeeping fields (nextRunAt, lastRun, state) without touching the user's settings.
function patch(id, fields) {
  return withLock(() => {
    const jobs = list();
    const i = jobs.findIndex((j) => j.id === id);
    if (i === -1) return null;
    jobs[i] = { ...jobs[i], ...fields };
    save(jobs);
    return jobs[i];
  });
}

function remove(id) {
  return withLock(() => {
    const jobs = list();
    const i = jobs.findIndex((j) => j.id === id);
    if (i === -1) return false;
    jobs.splice(i, 1);
    save(jobs);
    fs.rmSync(outputDir(id), { recursive: true, force: true }); // saved results go with the job; backups stay on disk
    return true;
  });
}

// What the browser sees: upload secrets replaced by flags.
function view(job) {
  const out = JSON.parse(JSON.stringify(job));
  const up = out.backup && out.backup.upload;
  if (up) for (const f of UPLOAD_SECRETS) { up['has' + f[0].toUpperCase() + f.slice(1)] = Boolean(up[f]); delete up[f]; }
  return out;
}

// ---------- run history ----------

function appendRun(run) {
  ensureDir();
  withLock(() => {
    fs.appendFileSync(RUNS_FILE, JSON.stringify(run) + '\n', { mode: 0o600 });
    try {
      if (fs.statSync(RUNS_FILE).size > 8 * 1024 * 1024) {
        const lines = fs.readFileSync(RUNS_FILE, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(RUNS_FILE, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', { mode: 0o600 });
      }
    } catch (e) { /* trimming is best effort */ }
  });
}

function readRuns() {
  let text;
  try { text = fs.readFileSync(RUNS_FILE, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch (e) { /* skip a torn line */ } }
  return out;
}

const runsFor = (jobId, limit = 50) => readRuns().filter((r) => r.jobId === jobId).slice(-limit).reverse();

module.exports = { TYPES, NOTIFY_WHEN, list, get, create, update, patch, remove, view, nextRunAt, appendRun, runsFor, readRuns, outputDir, backupDir, normalize };
