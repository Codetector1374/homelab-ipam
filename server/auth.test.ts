import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import Database from 'better-sqlite3';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { registerAuth } from './auth.js';

const PUBLIC_URL = 'http://ipam.test';
const CLIENT_ID = 'ipam';
const CLIENT_SECRET = 'test-client-secret-not-for-deployment';
const envKeys = ['NODE_ENV', 'AUTH_MODE', 'PUBLIC_URL', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;

async function withEnvironment(values: Record<string, string | undefined>, action: () => Promise<void>) {
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    await action();
  } finally {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function cookieFrom(response: LightMyRequestResponse, name: string): string {
  const found = response.cookies.find((entry) => entry.name === name);
  assert.ok(found, `Expected ${name} cookie`);
  return `${name}=${found.value}`;
}

async function registerProtectedRoutes(app: FastifyInstance, db: Database.Database) {
  await registerAuth(app, db);
  app.get('/api/private', async () => ({ private: true }));
  app.post('/api/private', async () => ({ changed: true }));
  app.get('/health/live', async () => ({ ok: true }));
  await app.ready();
}

test('production authentication fails closed without configuration or with insecure URLs', async () => {
  for (const values of [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'production', AUTH_MODE: 'development' },
    { NODE_ENV: 'production', AUTH_MODE: 'oidc', PUBLIC_URL, OIDC_ISSUER: 'http://issuer.test', OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET },
  ]) {
    await withEnvironment(values, async () => {
      const app = Fastify();
      const db = new Database(':memory:');
      try {
        await assert.rejects(registerAuth(app, db), /OIDC requires|forbidden in production|requires HTTPS/);
      } finally {
        await app.close();
        db.close();
      }
    });
  }
});

test('development bypass still requires a browser-safe mutation origin', async () => {
  await withEnvironment({ NODE_ENV: 'test', AUTH_MODE: 'development' }, async () => {
    const app = Fastify();
    const db = new Database(':memory:');
    try {
      await registerProtectedRoutes(app, db);
      assert.equal((await app.inject('/api/private')).statusCode, 200);
      assert.equal((await app.inject('/api/session')).json().authenticated, true);
      for (const origin of [undefined, 'https://attacker.test', 'null']) {
        assert.equal((await app.inject({ method: 'POST', url: '/api/private', headers: origin ? { origin } : {} })).statusCode, 403);
      }
      for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000']) {
        assert.equal((await app.inject({ method: 'POST', url: '/api/private', headers: { host: 'localhost:3000', origin } })).statusCode, 200);
      }
    } finally {
      await app.close();
      db.close();
    }
  });
});

test('OIDC discovery, Basic authentication, signed ID tokens, PKCE, state, sessions and logout', async (t) => {
  const provider = Fastify();
  const key = await generateKeyPair('ES256');
  const wrongKey = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(key.publicKey), kid: 'test-signing-key', alg: 'ES256', use: 'sig' };
  let issuer = '';
  let tokenRequests = 0;
  let issuedTokens = 0;
  let fault: 'none' | 'nonce' | 'issuer' | 'audience' | 'signature' | 'expired' = 'none';
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  provider.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, new URLSearchParams(String(body)));
  });
  provider.get('/oauth2/openid/ipam/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
  }));
  provider.get('/oauth2/openid/ipam/jwks', async () => ({ keys: [jwk] }));
  provider.get('/oauth2/openid/ipam/authorize', async (request, reply) => {
    const query = new URLSearchParams(request.url.split('?')[1]);
    assert.equal(query.get('client_id'), CLIENT_ID);
    assert.equal(query.get('redirect_uri'), `${PUBLIC_URL}/auth/callback`);
    assert.equal(query.get('response_type'), 'code');
    assert.equal(query.get('code_challenge_method'), 'S256');
    assert.ok(query.get('scope')?.split(' ').includes('openid'));
    assert.ok(query.get('nonce'));
    assert.ok(query.get('state'));
    const code = randomBytes(24).toString('base64url');
    codes.set(code, { nonce: query.get('nonce')!, challenge: query.get('code_challenge')!, redirect: query.get('redirect_uri')! });
    const redirect = new URL(query.get('redirect_uri')!);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', query.get('state')!);
    return reply.redirect(redirect.href);
  });
  provider.post('/oauth2/openid/ipam/token', async (request, reply) => {
    tokenRequests++;
    assert.ok(request.headers.authorization?.startsWith('Basic '));
    const credentials = Buffer.from(request.headers.authorization.slice(6), 'base64').toString('utf8').split(':');
    assert.equal(credentials.length, 2);
    // OAuth Basic credentials are form-encoded before base64, including punctuation.
    assert.equal(decodeURIComponent(credentials[0]!.replace(/\+/g, ' ')), CLIENT_ID);
    assert.equal(decodeURIComponent(credentials[1]!.replace(/\+/g, ' ')), CLIENT_SECRET);
    const body = request.body as URLSearchParams;
    assert.equal(body.get('grant_type'), 'authorization_code');
    const code = body.get('code')!;
    const authorization = codes.get(code);
    codes.delete(code);
    if (!authorization) return reply.code(400).send({ error: 'invalid_grant' });
    assert.equal(body.get('redirect_uri'), authorization.redirect);
    const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
    if (challenge !== authorization.challenge) return reply.code(400).send({ error: 'invalid_grant' });
    const idToken = await new SignJWT({
      nonce: fault === 'nonce' ? 'wrong-nonce' : authorization.nonce,
      name: 'Test Operator', email: 'operator@example.test',
    }).setProtectedHeader({ alg: 'ES256', kid: 'test-signing-key' })
      .setIssuer(fault === 'issuer' ? 'https://different-issuer.test' : issuer)
      .setAudience(fault === 'audience' ? 'another-client' : CLIENT_ID)
      .setSubject('operator-id').setIssuedAt().setExpirationTime(fault === 'expired' ? Math.floor(Date.now() / 1000) - 3600 : '5 minutes')
      .sign(fault === 'signature' ? wrongKey.privateKey : key.privateKey);
    issuedTokens++;
    return { access_token: 'test-access-token', token_type: 'Bearer', expires_in: 300, id_token: idToken };
  });
  await provider.listen({ host: '127.0.0.1', port: 0 });
  const address = provider.server.address();
  assert.ok(address && typeof address !== 'string');
  issuer = `http://127.0.0.1:${address.port}/oauth2/openid/ipam`;

  try {
    await withEnvironment({ NODE_ENV: 'test', AUTH_MODE: 'oidc', PUBLIC_URL, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET }, async () => {
      const app = Fastify();
      const db = new Database(':memory:');
      try {
        await registerProtectedRoutes(app, db);
        const startLogin = async (cookie?: string) => {
          // A forged request host must never affect redirect_uri.
          const login = await app.inject({ url: '/auth/login', headers: { host: 'attacker.test', ...(cookie ? { cookie } : {}) } });
          assert.equal(login.statusCode, 302);
          const transactionCookie = cookieFrom(login, 'ipam_login');
          const authorize = await fetch(login.headers.location!, { redirect: 'manual' });
          assert.equal(authorize.status, 302);
          const callback = new URL(authorize.headers.get('location')!);
          return { transactionCookie, callback: `${callback.pathname}${callback.search}`, login };
        };
        await t.test('public session and health, guarded reads and mutations', async () => {
          assert.deepEqual((await app.inject('/api/session')).json(), { authenticated: false, mode: 'oidc', user: null });
          assert.equal((await app.inject('/health/live')).statusCode, 200);
          assert.equal((await app.inject('/api/private')).statusCode, 401);
          assert.equal((await app.inject({ method: 'POST', url: '/api/private', headers: { origin: PUBLIC_URL } })).statusCode, 401);
          assert.equal((await app.inject({ method: 'POST', url: '/api/private' })).statusCode, 403);
        });
        await t.test('state mismatch and missing browser binding are rejected before code exchange', async () => {
          const login = await startLogin();
          const before = tokenRequests;
          assert.equal((await app.inject(login.callback)).statusCode, 400);
          const changed = new URL(login.callback, PUBLIC_URL);
          changed.searchParams.set('state', 'attacker-state');
          assert.equal((await app.inject({ url: changed.pathname + changed.search, headers: { cookie: login.transactionCookie } })).statusCode, 400);
          assert.equal((await app.inject({ url: login.callback, headers: { cookie: login.transactionCookie } })).statusCode, 400);
          assert.equal(tokenRequests, before);
        });
        await t.test('expired and rotated transactions cannot authenticate', async () => {
          const first = await startLogin();
          const second = await startLogin(first.transactionCookie);
          assert.equal((await app.inject({ url: first.callback, headers: { cookie: first.transactionCookie } })).statusCode, 400);
          db.prepare('UPDATE auth_transactions SET expires_at = 0').run();
          assert.equal((await app.inject({ url: second.callback, headers: { cookie: second.transactionCookie } })).statusCode, 400);
        });
        await t.test('PKCE verifier is required by the real token endpoint', async () => {
          const login = await startLogin();
          db.prepare('UPDATE auth_transactions SET verifier = ?').run('tampered-verifier');
          const response = await app.inject({ url: login.callback, headers: { cookie: login.transactionCookie } });
          assert.equal(response.statusCode, 400);
          assert.deepEqual(response.json(), { error: 'Login failed; please start again' });
        });
        await t.test('login creates hashed persistent sessions, rejects replay and supports same-origin logout', async () => {
          const login = await startLogin();
          assert.ok(login.login.headers['set-cookie']?.toString().includes('HttpOnly'));
          assert.ok(login.login.headers['set-cookie']?.toString().includes('SameSite=Lax'));
          const response = await app.inject({ url: login.callback, headers: { cookie: login.transactionCookie } });
          assert.equal(response.statusCode, 302);
          assert.equal(response.headers.location, '/');
          const sessionCookie = cookieFrom(response, 'ipam_session');
          const token = sessionCookie.split('=')[1]!;
          const row = db.prepare('SELECT token_hash FROM auth_sessions').get() as { token_hash: string };
          assert.notEqual(row.token_hash, token);
          assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
          assert.equal((await app.inject({ url: login.callback, headers: { cookie: login.transactionCookie } })).statusCode, 400);
          assert.deepEqual((await app.inject({ url: '/api/session', headers: { cookie: sessionCookie } })).json(), {
            authenticated: true, mode: 'oidc', user: { name: 'Test Operator', email: 'operator@example.test' },
          });
          assert.equal((await app.inject({ url: '/api/private', headers: { cookie: sessionCookie } })).statusCode, 200);
          for (const origin of [undefined, 'http://attacker.test', `${PUBLIC_URL}/`, 'null']) {
            assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: sessionCookie, ...(origin ? { origin } : {}) } })).statusCode, 403);
          }
          assert.equal((await app.inject({ method: 'POST', url: '/api/private', headers: { cookie: sessionCookie, origin: PUBLIC_URL } })).statusCode, 200);
          const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: sessionCookie, origin: PUBLIC_URL } });
          assert.equal(logout.statusCode, 200);
          assert.ok(logout.cookies.find((entry) => entry.name === 'ipam_session' && entry.value === ''));
          assert.equal((await app.inject({ url: '/api/private', headers: { cookie: sessionCookie } })).statusCode, 401);
        });
        for (const value of ['nonce', 'issuer', 'audience', 'signature', 'expired'] as const) {
          await t.test(`rejects invalid ID token ${value}`, async () => {
            fault = value;
            try {
              const login = await startLogin();
              const issuedBefore = issuedTokens;
              const response = await app.inject({ url: login.callback, headers: { cookie: login.transactionCookie } });
              assert.equal(issuedTokens, issuedBefore + 1, 'Mock provider must issue the intended invalid token');
              assert.equal(response.statusCode, 400);
              assert.deepEqual(db.prepare('SELECT count(*) AS count FROM auth_sessions').get(), { count: 0 });
              assert.deepEqual(response.json(), { error: 'Login failed; please start again' });
            } finally {
              fault = 'none';
            }
          });
        }
        await t.test('expired server-side sessions are rejected even with a browser cookie', async () => {
          const login = await startLogin();
          const response = await app.inject({ url: login.callback, headers: { cookie: login.transactionCookie } });
          assert.equal(response.statusCode, 302);
          const sessionCookie = cookieFrom(response, 'ipam_session');
          db.prepare('UPDATE auth_sessions SET expires_at = 0').run();
          assert.equal((await app.inject({ url: '/api/private', headers: { cookie: sessionCookie } })).statusCode, 401);
        });
      } finally {
        await app.close();
        db.close();
      }
    });
  } finally {
    await provider.close();
  }
});
