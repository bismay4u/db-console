// api/notify.js
// Where scheduled jobs send their alerts and reports: email (SMTP) and a
// webhook (Slack, Teams, Discord, or anything that accepts a JSON POST).
// The settings live in data/notify.json; the SMTP password and the webhook
// signing secret are encrypted like connection passwords.

const crypto = require('crypto');
const path = require('path');
const { DATA_DIR, readJson, writeJson, withLock } = require('./datadir');
const secrets = require('./secrets');

const FILE = path.join(DATA_DIR, 'notify.json');
const EMPTY = { smtp: { host: '', port: 587, secure: false, user: '', password: '', from: '' }, webhookUrl: '', webhookSecret: '', baseUrl: '' };

function load() {
  let raw;
  try { raw = readJson(FILE); } catch (e) { raw = null; }
  const s = { ...EMPTY, ...(raw && !Array.isArray(raw) ? raw : {}), smtp: { ...EMPTY.smtp, ...((raw && raw.smtp) || {}) } };
  for (const holder of [s.smtp, s]) {
    for (const f of ['password', 'webhookSecret']) {
      if (secrets.isEncrypted(holder[f])) { try { holder[f] = secrets.decrypt(holder[f]); } catch (e) { holder[f] = ''; } }
    }
  }
  return s;
}

// What the browser may see: never the secrets themselves.
function publicView() {
  const s = load();
  return {
    smtp: { host: s.smtp.host, port: s.smtp.port, secure: Boolean(s.smtp.secure), user: s.smtp.user, from: s.smtp.from, hasPassword: Boolean(s.smtp.password) },
    webhookUrl: s.webhookUrl, hasWebhookSecret: Boolean(s.webhookSecret), baseUrl: s.baseUrl,
    emailConfigured: Boolean(s.smtp.host && s.smtp.from), webhookConfigured: Boolean(s.webhookUrl)
  };
}

function save(body = {}) {
  return withLock(() => {
    const cur = load();
    const b = body.smtp || {};
    const next = {
      smtp: {
        host: String(b.host ?? cur.smtp.host).trim(), port: Number(b.port ?? cur.smtp.port) || 587, secure: Boolean(b.secure ?? cur.smtp.secure),
        user: String(b.user ?? cur.smtp.user).trim(), from: String(b.from ?? cur.smtp.from).trim(),
        password: b.password ? String(b.password) : cur.smtp.password
      },
      webhookUrl: String(body.webhookUrl ?? cur.webhookUrl).trim(),
      webhookSecret: body.webhookSecret ? String(body.webhookSecret) : cur.webhookSecret,
      baseUrl: String(body.baseUrl ?? cur.baseUrl).trim().replace(/\/+$/, '')
    };
    if (next.webhookUrl && !/^https?:\/\//i.test(next.webhookUrl)) throw new Error('The webhook URL must start with http:// or https://');
    if (body.clearWebhookSecret) next.webhookSecret = '';
    writeJson(FILE, {
      ...next, smtp: { ...next.smtp, password: next.smtp.password ? secrets.encrypt(next.smtp.password) : '' },
      webhookSecret: next.webhookSecret ? secrets.encrypt(next.webhookSecret) : ''
    });
    return publicView();
  });
}

let mailer = null;
function transport(s) {
  if (!s.smtp.host) throw new Error('Email is not configured: set the SMTP server first');
  if (!s.smtp.from) throw new Error('Email needs a "from" address');
  if (!mailer) mailer = require('nodemailer');
  return mailer.createTransport({
    host: s.smtp.host, port: s.smtp.port, secure: Boolean(s.smtp.secure),
    auth: s.smtp.user ? { user: s.smtp.user, pass: s.smtp.password } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000
  });
}

const addresses = (list) => String(Array.isArray(list) ? list.join(',') : (list || '')).split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));

async function sendEmail({ to, subject, text, attachments }) {
  const s = load();
  const recipients = addresses(to);
  if (!recipients.length) throw new Error('No valid email address');
  const t = transport(s);
  try {
    await t.sendMail({ from: s.smtp.from, to: recipients.join(', '), subject, text, attachments });
  } finally { t.close(); }
  return recipients;
}

async function sendWebhook(payload) {
  const s = load();
  if (!s.webhookUrl) throw new Error('No webhook URL is configured');
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'db-console' };
  if (s.webhookSecret) headers['X-DBConsole-Signature'] = 'sha256=' + crypto.createHmac('sha256', s.webhookSecret).update(body).digest('hex');
  const res = await fetch(s.webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`The webhook answered ${res.status}`);
}

// Delivers one job result. `to` = email addresses (may be empty); `webhook` = also post to the webhook.
// Returns { sent: [...], errors: [...] } and never throws: a broken alert channel must not fail the job.
async function deliver({ subject, text, data = {}, to, webhook, attachments }) {
  const out = { sent: [], errors: [] };
  const s = load();
  if (addresses(to).length) {
    try { await sendEmail({ to, subject, text, attachments }); out.sent.push('email'); } catch (e) { out.errors.push('email: ' + e.message); }
  }
  if (webhook && s.webhookUrl) {
    try { await sendWebhook({ text: `${subject}\n${text}`, subject, ...data }); out.sent.push('webhook'); } catch (e) { out.errors.push('webhook: ' + e.message); }
  }
  return out;
}

const link = (pathAndHash) => { const b = load().baseUrl; return b ? b + pathAndHash : ''; };

module.exports = { load, publicView, save, sendEmail, sendWebhook, deliver, addresses, link };
