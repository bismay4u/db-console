// api/tunnel.js
// SSH tunnels for database connections that sit behind a bastion host.
//
// mysql2 accepts a `stream` factory that must return a stream synchronously,
// while ssh2 opens a forwarded channel asynchronously. TunnelStream bridges
// the two: it is usable immediately, buffers writes until the channel is open
// and then pipes both ways. One SSH client per connection is shared by all
// of its pooled database connections and re-created if it drops.

const crypto = require('crypto');
const { Duplex } = require('stream');

let Client = null;
function sshClientClass() {
  if (!Client) {
    try { ({ Client } = require('ssh2')); } catch (e) { throw new Error('SSH tunnels need the "ssh2" package: run npm install'); }
  }
  return Client;
}

// key -> { sig, ready: Promise<Client> }
const clients = new Map();

const fingerprint = (hostKey) => 'SHA256:' + crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');

function signature(conn) {
  return JSON.stringify([conn.sshHost, conn.sshPort, conn.sshUser, conn.sshPassword, conn.sshPrivateKey, conn.sshPassphrase, conn.sshHostKey]);
}

function connect(conn) {
  return new Promise((resolve, reject) => {
    const client = new (sshClientClass())();
    const expected = (conn.sshHostKey || '').trim();
    const opts = {
      host: conn.sshHost,
      port: Number(conn.sshPort) || 22,
      username: conn.sshUser,
      readyTimeout: 15000,
      keepaliveInterval: 15000
    };
    if (conn.sshPrivateKey) { opts.privateKey = conn.sshPrivateKey; if (conn.sshPassphrase) opts.passphrase = conn.sshPassphrase; }
    if (conn.sshPassword) opts.password = conn.sshPassword;
    if (expected) {
      // Compare with the fingerprint the admin entered (SHA256:… as `ssh-keygen -lf` prints it).
      opts.hostVerifier = (key) => fingerprint(key) === expected || key.toString('hex') === expected;
    }
    client.once('ready', () => resolve(client));
    client.once('error', (err) => reject(new Error('SSH: ' + (expected && /host key|verif/i.test(err.message) ? 'host key does not match the saved fingerprint' : err.message))));
    client.connect(opts);
  });
}

function getClient(key, conn) {
  const sig = signature(conn);
  const cached = clients.get(key);
  if (cached && cached.sig === sig) return cached.ready;
  if (cached) release(key);
  const entry = { sig, ready: null };
  entry.ready = connect(conn).then((client) => {
    const drop = () => { if (clients.get(key) === entry) clients.delete(key); };
    client.on('close', drop); client.on('end', drop); client.on('error', drop);
    return client;
  }, (err) => { if (clients.get(key) === entry) clients.delete(key); throw err; });
  entry.ready.catch(() => {});
  clients.set(key, entry);
  return entry.ready;
}

function release(key) {
  const cached = clients.get(key);
  if (!cached) return;
  clients.delete(key);
  cached.ready.then((c) => c.end(), () => {});
}

class TunnelStream extends Duplex {
  constructor(key, conn) {
    super();
    this.channel = null;
    this.pending = null; // a write waiting for the channel
    this.wantRead = false;
    this.remoteAddress = conn.host;
    getClient(key, conn).then((client) => {
      if (this.destroyed) return;
      client.forwardOut('127.0.0.1', 0, conn.host, Number(conn.port) || 3306, (err, channel) => {
        if (err) return this.destroy(new Error('SSH tunnel: ' + err.message));
        if (this.destroyed) return channel.destroy();
        this.channel = channel;
        channel.on('data', (d) => { if (!this.push(d)) channel.pause(); });
        channel.on('end', () => this.push(null));
        channel.on('close', () => this.destroy());
        channel.on('error', (e) => this.destroy(e));
        if (this.pending) { const { chunk, cb } = this.pending; this.pending = null; channel.write(chunk, cb); }
        this.emit('connect');
      });
    }, (err) => this.destroy(err));
  }
  _read() { if (this.channel) this.channel.resume(); }
  _write(chunk, enc, cb) {
    if (this.channel) return this.channel.write(chunk, cb);
    this.pending = { chunk, cb };
  }
  _final(cb) { if (this.channel) this.channel.end(); cb(); }
  _destroy(err, cb) { if (this.channel) this.channel.destroy(); cb(err); }
  // net.Socket methods mysql2 may call
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout() { return this; }
  ref() { return this; }
  unref() { return this; }
}

const createStream = (key, conn) => new TunnelStream(key, conn);

module.exports = { createStream, release, fingerprint };
