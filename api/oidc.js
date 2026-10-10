// api/oidc.js
// Single sign-on with OpenID Connect (Google, Microsoft Entra ID, Okta, Auth0, Keycloak, …): the
// authorization-code flow with PKCE. The ID token's RS256 signature is checked against the provider's
// published keys, and its issuer, audience, expiry and nonce are verified.
//
// Settings (config.js `oidc: {…}` or the environment):
//   issuer         OIDC_ISSUER          https://accounts.google.com
//   clientId       OIDC_CLIENT_ID
//   clientSecret   OIDC_CLIENT_SECRET
//   label          OIDC_LABEL           shown on the button ("Google")
//   scopes         OIDC_SCOPES          default "openid email profile"
//   allowedDomains OIDC_ALLOWED_DOMAINS comma-separated e-mail domains that may sign in (empty = any the provider vouches for)
//   adminEmails    OIDC_ADMIN_EMAILS    comma-separated e-mails that become admins when first created
//   autoCreate     OIDC_AUTO_CREATE     create a user on first sign-in (default true)
//   defaultRole    OIDC_DEFAULT_ROLE    role of created users (default user)
//   redirectUri    OIDC_REDIRECT_URI    default: <this server's address>/auth/oidc/callback

const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

function load(config = {}) {
  const c = config.oidc || {};
  const env = process.env;
  const s = {
    issuer: String(env.OIDC_ISSUER || c.issuer || '').replace(/\/+$/, ''),
    clientId: env.OIDC_CLIENT_ID || c.clientId || '',
    clientSecret: env.OIDC_CLIENT_SECRET || c.clientSecret || '',
    label: env.OIDC_LABEL || c.label || 'single sign-on',
    scopes: env.OIDC_SCOPES || c.scopes || 'openid email profile',
    allowedDomains: list(env.OIDC_ALLOWED_DOMAINS ?? c.allowedDomains),
    adminEmails: list(env.OIDC_ADMIN_EMAILS ?? c.adminEmails),
    autoCreate: !/^(0|false|no)$/i.test(String(env.OIDC_AUTO_CREATE ?? c.autoCreate ?? 'true')),
    defaultRole: env.OIDC_DEFAULT_ROLE || c.defaultRole || 'user',
    redirectUri: env.OIDC_REDIRECT_URI || c.redirectUri || ''
  };
  s.enabled = Boolean(s.issuer && s.clientId);
  return s;
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}${data && (data.error_description || data.error) ? ': ' + (data.error_description || data.error) : ''}`);
  if (!data) throw new Error(`${new URL(url).host} did not answer with JSON`);
  return data;
}

function create(settings) {
  let disco = null; let discoAt = 0;
  let jwks = null; let jwksAt = 0;

  async function discovery() {
    if (disco && Date.now() - discoAt < 3600000) return disco;
    const d = await getJson(`${settings.issuer}/.well-known/openid-configuration`);
    if (String(d.issuer || '').replace(/\/+$/, '') !== settings.issuer) throw new Error('The provider reports a different issuer than the one configured');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!d[k]) throw new Error(`The provider's configuration has no ${k}`);
    disco = d; discoAt = Date.now();
    return d;
  }
  async function keys(force) {
    if (!force && jwks && Date.now() - jwksAt < 3600000) return jwks;
    jwks = (await getJson((await discovery()).jwks_uri)).keys || []; jwksAt = Date.now();
    return jwks;
  }

  async function verifyIdToken(idToken, { nonce }) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('The provider returned an invalid token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (header.alg !== 'RS256') throw new Error(`Unsupported token signature (${header.alg}); the provider must sign ID tokens with RS256`);
    let jwk = (await keys(false)).find((k) => k.kid === header.kid && (!k.use || k.use === 'sig'));
    if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid);
    if (!jwk) throw new Error('The token is signed with a key the provider does not publish');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('The token signature is not valid');
    if (String(claims.iss || '').replace(/\/+$/, '') !== settings.issuer) throw new Error('The token was issued by someone else');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(settings.clientId)) throw new Error('The token is for a different application');
    if (!claims.exp || claims.exp * 1000 < Date.now() - 60000) throw new Error('The token has expired');
    if (claims.nbf && claims.nbf * 1000 > Date.now() + 60000) throw new Error('The token is not valid yet');
    if (!nonce || claims.nonce !== nonce) throw new Error('The sign-in response does not match the request (nonce)');
    return claims;
  }

  return {
    // Where to send the browser; `redirectUri` is where the provider returns it.
    async start(redirectUri) {
      const d = await discovery();
      const state = crypto.randomBytes(16).toString('base64url');
      const nonce = crypto.randomBytes(16).toString('base64url');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const url = new URL(d.authorization_endpoint);
      for (const [k, v] of Object.entries({
        response_type: 'code', client_id: settings.clientId, redirect_uri: redirectUri, scope: settings.scopes, state, nonce,
        code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256'
      })) url.searchParams.set(k, v);
      return { url: url.toString(), saved: { state, nonce, verifier, redirectUri, at: Date.now() } };
    },
    // Trades the code for the verified identity { sub, email, name }.
    async finish(query, saved) {
      if (!saved || Date.now() - saved.at > 10 * 60 * 1000) throw new Error('The sign-in took too long — start again');
      if (query.error) throw new Error(`${query.error_description || query.error}`);
      if (!query.state || query.state !== saved.state) throw new Error('The sign-in response does not match the request (state)');
      if (!query.code) throw new Error('The provider did not return a code');
      const d = await discovery();
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: saved.redirectUri, client_id: settings.clientId, code_verifier: saved.verifier });
      if (settings.clientSecret) body.set('client_secret', settings.clientSecret);
      const tok = await getJson(d.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
      const claims = await verifyIdToken(tok.id_token, { nonce: saved.nonce });
      const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('The provider did not share an e-mail address — allow the "email" scope');
      if (claims.email_verified === false || claims.email_verified === 'false') throw new Error('The provider says your e-mail address is not verified');
      return { sub: String(claims.sub), email, name: claims.name || claims.given_name || email };
    }
  };
}

module.exports = { load, create };
