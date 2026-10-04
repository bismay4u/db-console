// system.js
// Admin-only "Update & Restart": pulls the latest code with git, installs
// dependencies when package.json / package-lock.json changed, and restarts
// the app through PM2.
//
// Only fixed commands run here; nothing from the request is ever passed to
// a shell.

const path = require('path');
const { execFile, spawn } = require('child_process');

const APP_DIR = __dirname;
const IS_WIN = process.platform === 'win32';
// Fail instead of waiting forever if the remote asks for credentials.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

let busy = false;

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: APP_DIR, env: GIT_ENV, timeout, shell: IS_WIN, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
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
      child = spawn(cmd, args, { cwd: APP_DIR, env: GIT_ENV, shell: IS_WIN });
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
    execMode: process.env.exec_mode || null
  };
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

async function getStatus() {
  return {
    git: await gitInfo(),
    pm2: pm2Info(),
    node: process.version,
    platform: process.platform,
    appDir: APP_DIR,
    uptimeSec: Math.round(process.uptime()),
    busy
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

// Environment for the pm2 CLI. In PM2 cluster mode this process is a Node
// cluster worker; a child inheriting NODE_UNIQUE_ID / NODE_CHANNEL_FD would
// also start as a cluster worker and crash before doing anything.
function pm2CliEnv() {
  const env = { ...process.env };
  for (const k of ['NODE_UNIQUE_ID', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'pm2_env']) delete env[k];
  return env;
}

// Restarts through PM2 in a detached child, so the PM2 command survives the
// current process being stopped. Falls back to exiting and letting PM2's
// autorestart bring the app back if the pm2 command can't be run or fails.
function scheduleRestart(delayMs = 1000) {
  const info = pm2Info();
  if (!info.managed) return false;
  const action = info.execMode === 'cluster_mode' ? 'reload' : 'restart';
  setTimeout(() => {
    try {
      const child = spawn('pm2', [action, String(info.id)], {
        cwd: APP_DIR, env: pm2CliEnv(), detached: true, stdio: 'ignore', shell: IS_WIN
      });
      child.on('error', () => process.exit(0));
      child.on('exit', (code) => { if (code !== 0) process.exit(0); });
      child.unref();
    } catch (e) {
      process.exit(0);
    }
  }, delayMs);
  return true;
}

// emit(event) receives { type: 'step' | 'log' | 'done' | 'error', ... }.
async function update({ restart = true } = {}, emit) {
  if (busy) throw new Error('An update is already running');
  busy = true;
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
    if (restart) {
      restarting = scheduleRestart();
      step(restarting ? `pm2 ${pm2Info().execMode === 'cluster_mode' ? 'reload' : 'restart'}` : 'restart');
      if (!restarting) log('Not running under PM2 — restart the app manually to load the new code');
    }
    emit({ type: 'done', ok: true, updated: true, restarting, from: before, to: after });
    return { updated: true, from: before, to: after, restarting };
  } finally {
    busy = false;
  }
}

module.exports = { getStatus, checkForUpdates, update, scheduleRestart, pm2Info, appDir: path.resolve(APP_DIR) };
