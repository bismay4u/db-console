// system.js
// Admin-only "Update & Restart": pulls the latest code with git, installs
// dependencies when package.json / package-lock.json changed, and restarts
// the app through PM2.
//
// Works in PM2 fork and cluster mode. In cluster mode every worker serves
// admin requests, so "an update is running" is a lock file shared by all
// workers, and restarts target the PM2 app by name (all instances), not
// just the worker that received the request.
//
// Only fixed commands run here; nothing from the request is ever passed to
// a shell.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { DATA_DIR, ensureDir, FILE_MODE } = require('./datadir');

// git, npm and pm2 run in the app root (this file lives in api/).
const APP_DIR = path.join(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const UPDATE_LOCK = path.join(DATA_DIR, '.update.lock');
const UPDATE_LOCK_STALE_MS = 1000 * 60 * 15;
const STARTED_AT = Date.now();

// Environment for every child process (git, npm, pm2):
// - In PM2 cluster mode this process is a Node cluster worker. npm and pm2
//   are Node programs too; inheriting NODE_UNIQUE_ID / NODE_CHANNEL_FD makes
//   them start as cluster workers and crash before doing anything.
// - GIT_TERMINAL_PROMPT=0 makes git fail instead of waiting forever if the
//   remote asks for credentials.
function childEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of ['NODE_UNIQUE_ID', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'pm2_env']) delete env[k];
  return env;
}

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: APP_DIR, env: childEnv(), timeout, shell: IS_WIN, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // trimEnd only: leading spaces are significant in `git status --porcelain`.
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout).trimEnd(), stderr: String(stderr).trim() });
    });
  });
}

// Like run(), but streams each output line to onLine as it arrives.
function runStreaming(cmd, args, onLine, { timeout = 600000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: APP_DIR, env: childEnv(), shell: IS_WIN });
    } catch (err) {
      onLine(err.message);
      return resolve({ ok: false, code: 1 });
    }
    const timer = setTimeout(() => {
      onLine(`Timed out after ${Math.round(timeout / 1000)}s`);
      child.kill();
    }, timeout);
    const pipe = (stream) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach((l) => l.trim() && onLine(l));
      });
      stream.on('end', () => buf.trim() && onLine(buf));
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', (err) => onLine(err.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code });
    });
  });
}

function pm2Info() {
  const managed = process.env.pm_id !== undefined;
  return {
    managed,
    id: managed ? process.env.pm_id : null,
    name: process.env.name || null,
    execMode: process.env.exec_mode || null,
    instance: process.env.NODE_APP_INSTANCE ?? null
  };
}

// Every instance of this PM2 app (one per cluster worker), from `pm2 jlist`.
// Returns null if pm2 can't be queried.
async function pm2Instances() {
  const info = pm2Info();
  if (!info.managed) return null;
  const res = await run(IS_WIN ? 'pm2.cmd' : 'pm2', ['jlist'], { timeout: 15000 });
  if (!res.ok) return null;
  try {
    // pm2 may print warnings before the JSON array.
    const list = JSON.parse(res.stdout.slice(res.stdout.indexOf('[')));
    return list
      .filter((p) => p.name === info.name)
      .map((p) => ({
        id: p.pm_id,
        pid: p.pid,
        status: p.pm2_env && p.pm2_env.status,
        startedAt: p.pm2_env && p.pm2_env.pm_uptime,
        restarts: p.pm2_env && p.pm2_env.restart_time,
        memory: p.monit && p.monit.memory,
        cpu: p.monit && p.monit.cpu,
        current: String(p.pm_id) === String(info.id)
      }))
      .sort((a, b) => a.id - b.id);
  } catch (e) {
    return null;
  }
}

async function gitInfo() {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) return { available: false, error: inside.stderr || 'Not a git repository' };

  const [branch, commit, last, upstream, status] = await Promise.all([
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    run('git', ['rev-parse', '--short', 'HEAD']),
    run('git', ['log', '-1', '--format=%s%n%cI%n%an']),
    run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    run('git', ['status', '--porcelain'])
  ]);
  const [subject, date, author] = last.stdout.split('\n');
  return {
    available: true,
    branch: branch.stdout,
    commit: commit.stdout,
    subject,
    date,
    author,
    upstream: upstream.ok ? upstream.stdout : null,
    changedFiles: status.stdout ? status.stdout.split('\n') : []
  };
}

// ---- Update lock (shared by all workers) ----

function lockHolder() {
  try {
    const holder = JSON.parse(fs.readFileSync(UPDATE_LOCK, 'utf8'));
    if (Date.now() - holder.at < UPDATE_LOCK_STALE_MS) return holder;
  } catch (e) {
    // no lock
  }
  return null;
}

function acquireUpdateLock(username) {
  ensureDir();
  if (lockHolder() === null) {
    try { fs.unlinkSync(UPDATE_LOCK); } catch (e) { /* none, or stale one removed */ }
  }
  try {
    const fd = fs.openSync(UPDATE_LOCK, 'wx', FILE_MODE);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, username, at: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

function releaseUpdateLock() {
  try { fs.unlinkSync(UPDATE_LOCK); } catch (e) { /* already gone */ }
}

async function getStatus() {
  const holder = lockHolder();
  return {
    git: await gitInfo(),
    pm2: { ...pm2Info(), instances: await pm2Instances() },
    node: process.version,
    platform: process.platform,
    appDir: APP_DIR,
    dataDir: DATA_DIR,
    pid: process.pid,
    startedAt: STARTED_AT,
    now: Date.now(),
    busy: Boolean(holder),
    busyBy: holder ? holder.username : null
  };
}

// Fetches from the remote and lists the commits an update would bring in.
async function checkForUpdates() {
  const fetch = await run('git', ['fetch', '--prune'], { timeout: 60000 });
  if (!fetch.ok) return { ok: false, error: fetch.stderr || 'git fetch failed' };

  const counts = await run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (!counts.ok) return { ok: false, error: counts.stderr || 'This branch has no upstream to update from' };
  const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);

  const log = await run('git', ['log', '--format=%h%x09%s%x09%an%x09%cI', 'HEAD..@{u}', '-n', '50']);
  const incoming = log.stdout
    ? log.stdout.split('\n').map((l) => {
      const [hash, subject, author, date] = l.split('\t');
      return { hash, subject, author, date };
    })
    : [];
  return { ok: true, ahead, behind, incoming };
}

// Asks PM2 to reload (cluster mode: one worker at a time, no downtime) or
// restart (fork mode) every instance of this app.
//
// The pm2 command must outlive this process: PM2 kills a worker's whole
// process tree when it reloads that worker, and the pm2 CLI reloads the
// instances one by one, so if it were our child it would be killed part
// way through. On POSIX it is started via `sh -c '… &'`, which returns at
// once and leaves pm2 orphaned (re-parented to init), outside our tree.
//
// If pm2 can't be found, exiting lets PM2's autorestart bring this worker
// back on the new code.
function scheduleRestart(delayMs = 1000) {
  const info = pm2Info();
  if (!info.managed) return false;
  const action = info.execMode === 'cluster_mode' ? 'reload' : 'restart';
  const target = info.name || String(info.id);
  setTimeout(() => {
    try {
      const child = IS_WIN
        ? spawn('pm2.cmd', [action, target], { cwd: APP_DIR, env: childEnv(), detached: true, stdio: 'ignore', shell: true })
        : spawn('/bin/sh', ['-c', `command -v pm2 >/dev/null || exit 127; pm2 ${action} "$0" >/dev/null 2>&1 &`, target], {
          cwd: APP_DIR, env: childEnv(), detached: true, stdio: 'ignore'
        });
      child.on('error', () => process.exit(0));
      child.on('exit', (code) => { if (code !== 0) process.exit(0); });
      child.unref();
    } catch (e) {
      process.exit(0);
    }
  }, delayMs);
  return action;
}

// emit(event) receives { type: 'step' | 'log' | 'done' | 'error', ... }.
async function update({ restart = true, username } = {}, emit) {
  if (!acquireUpdateLock(username)) {
    const holder = lockHolder();
    throw new Error(`An update is already running${holder && holder.username ? ` (started by ${holder.username})` : ''}`);
  }
  try {
    const log = (text) => emit({ type: 'log', text });
    const step = (name) => emit({ type: 'step', name });

    const before = (await run('git', ['rev-parse', 'HEAD'])).stdout;
    if (!before) throw new Error('Not a git repository, or git is not installed');

    step('git pull --ff-only');
    const pull = await runStreaming('git', ['pull', '--ff-only'], log);
    if (!pull.ok) throw new Error('git pull failed — resolve the problem on the server, then try again');

    const after = (await run('git', ['rev-parse', 'HEAD'])).stdout;
    if (after === before) {
      emit({ type: 'done', ok: true, updated: false, restarting: false, from: before, to: after });
      return { updated: false, from: before, to: after };
    }

    const diff = await run('git', ['diff', '--name-only', before, after]);
    const changed = diff.stdout.split('\n');
    if (changed.includes('package.json') || changed.includes('package-lock.json')) {
      step('npm install --omit=dev');
      const npm = await runStreaming(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], log);
      if (!npm.ok) throw new Error('npm install failed — the new code is pulled but the app was not restarted');
    } else {
      log('Dependencies unchanged, skipping npm install');
    }

    let restarting = false;
    const requestedAt = Date.now();
    if (restart) {
      const action = scheduleRestart();
      restarting = Boolean(action);
      step(restarting ? `pm2 ${action} ${pm2Info().name}` : 'restart');
      if (!restarting) log('Not running under PM2 — restart the app manually to load the new code');
    }
    emit({ type: 'done', ok: true, updated: true, restarting, requestedAt, from: before, to: after });
    return { updated: true, from: before, to: after, restarting };
  } finally {
    releaseUpdateLock();
  }
}

module.exports = { getStatus, checkForUpdates, update, scheduleRestart, pm2Info, appDir: path.resolve(APP_DIR) };
