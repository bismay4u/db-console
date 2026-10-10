// api/uploader.js
// Sends a finished backup file somewhere else: an S3 bucket (AWS, MinIO, Backblaze, Wasabi, … any
// S3-compatible service; AWS Signature V4, no SDK) or an SFTP server.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

// ---------- S3 ----------

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const encodeKey = (key) => key.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');

// AWS Signature Version 4. `headers` must already hold host and x-amz-* headers; returns the Authorization header value.
function signV4({ method, pathname, query = '', headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', amzDate }) {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function s3Target(cfg, key) {
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) throw new Error('S3 needs a bucket, an access key id and a secret access key');
  const region = cfg.region || 'us-east-1';
  const custom = Boolean(cfg.endpoint);
  const base = new URL(custom ? cfg.endpoint : `https://s3.${region}.amazonaws.com`);
  const pathStyle = custom ? cfg.pathStyle !== false : false;
  const objectPath = '/' + encodeKey(key);
  if (pathStyle) return { base, host: base.host, pathname: (base.pathname.replace(/\/$/, '') + '/' + encodeURIComponent(cfg.bucket) + objectPath), region };
  return { base, host: `${cfg.bucket}.${base.host}`, pathname: objectPath, region };
}

// Streams `file` to the bucket with a single PUT (up to 5 GB).
function uploadS3(cfg, file, key) {
  return new Promise((resolve, reject) => {
    const t = s3Target(cfg, key);
    const { size } = fs.statSync(file);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const payloadHash = 'UNSIGNED-PAYLOAD';
    const headers = { host: t.host, 'content-length': String(size), 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, 'content-type': 'application/octet-stream' };
    const authorization = signV4({ method: 'PUT', pathname: t.pathname, headers, payloadHash, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: t.region, amzDate });
    const lib = t.base.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'PUT', hostname: t.host.split(':')[0], port: (t.host.split(':')[1] || t.base.port) || undefined, path: t.pathname,
      headers: { ...headers, authorization }, timeout: 0
    }, (res) => {
      let body = '';
      res.on('data', (d) => { if (body.length < 2000) body += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ target: `s3://${cfg.bucket}/${key}`, bytes: size });
        const msg = /<Message>([^<]*)<\/Message>/.exec(body);
        reject(new Error(`S3 answered ${res.statusCode}${msg ? ': ' + msg[1] : ''}`));
      });
    });
    req.on('error', (e) => reject(new Error('S3: ' + e.message)));
    const rs = fs.createReadStream(file);
    rs.on('error', reject);
    rs.pipe(req);
  });
}

// ---------- SFTP ----------

function sftpConnect(cfg) {
  const { Client } = require('ssh2');
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => client.sftp((err, sftp) => (err ? (client.end(), reject(new Error('SFTP: ' + err.message))) : resolve({ client, sftp }))));
    client.once('error', (e) => reject(new Error('SFTP: ' + e.message)));
    const opts = { host: cfg.host, port: Number(cfg.port) || 22, username: cfg.user, readyTimeout: 15000 };
    if (cfg.privateKey) { opts.privateKey = cfg.privateKey; if (cfg.passphrase) opts.passphrase = cfg.passphrase; }
    if (cfg.password) opts.password = cfg.password;
    client.connect(opts);
  });
}

const call = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

async function mkdirs(sftp, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = dir.startsWith('/') ? '' : '.';
  for (const p of parts) {
    cur += '/' + p;
    try { await call((cb) => sftp.stat(cur, cb)); } catch (e) { await call((cb) => sftp.mkdir(cur, cb)); }
  }
}

// Uploads, then keeps only the newest `keep` files that start with `prefix` in the remote folder.
async function uploadSftp(cfg, file, name, { keep = 0, prefix = '' } = {}) {
  if (!cfg.host || !cfg.user) throw new Error('SFTP needs a host and a user');
  const { client, sftp } = await sftpConnect(cfg);
  try {
    const dir = (cfg.path || '.').replace(/\/+$/, '') || '.';
    await mkdirs(sftp, dir);
    const remote = `${dir}/${name}`;
    await call((cb) => sftp.fastPut(file, remote, cb));
    let removed = 0;
    if (keep > 0) {
      const list = await call((cb) => sftp.readdir(dir, cb));
      const mine = list.filter((f) => f.filename.startsWith(prefix) && f.filename !== name && !f.longname.startsWith('d')).sort((a, b) => b.attrs.mtime - a.attrs.mtime || b.filename.localeCompare(a.filename));
      for (const f of mine.slice(Math.max(keep - 1, 0))) { await call((cb) => sftp.unlink(`${dir}/${f.filename}`, cb)); removed++; }
    }
    return { target: `sftp://${cfg.host}/${remote.replace(/^\.\//, '')}`, bytes: fs.statSync(file).size, removed };
  } finally { client.end(); }
}

async function upload(cfg, file, { name = path.basename(file), prefix = '', keep = 0 } = {}) {
  if (!cfg || !cfg.type) return null;
  if (cfg.type === 's3') return uploadS3(cfg, file, `${(cfg.prefix || '').replace(/^\/+|\/+$/g, '')}${cfg.prefix ? '/' : ''}${name}`);
  if (cfg.type === 'sftp') return uploadSftp(cfg, file, name, { keep, prefix });
  throw new Error(`Unknown upload type: ${cfg.type}`);
}

module.exports = { upload, uploadS3, uploadSftp, signV4, encodeKey, s3Target };
