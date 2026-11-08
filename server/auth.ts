import { createHash, randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import * as oidc from 'openid-client';
import type { Session } from '../shared/types.js';

const SESSION_TTL = 12 * 60 * 60;
const TRANSACTION_TTL = 10 * 60;
const randomToken = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

interface LoginTransaction { state: string; nonce: string; verifier: string; expires_at: number }
interface StoredSession { name: string; email: string | null }

/** Register directly on the root Fastify instance so the hook also protects later API routes. */
export async function registerAuth(app: FastifyInstance, db: Database.Database): Promise<void> {
  const production = process.env.NODE_ENV === 'production';
  const mode = process.env.AUTH_MODE ?? (production ? 'oidc' : 'development');
  if (mode !== 'development' && mode !== 'oidc') throw new Error('AUTH_MODE must be development or oidc');
  if (production && mode === 'development') throw new Error('Development authentication is forbidden in production');

  let publicUrl: URL | undefined;
  let config: oidc.Configuration | undefined;
  let redirectUri: string | undefined;
  if (mode === 'oidc') {
    const { PUBLIC_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = process.env;
    if (!PUBLIC_URL || !OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET) {
      throw new Error('OIDC requires PUBLIC_URL, OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET');
    }
    let issuer: URL;
    try {
      publicUrl = new URL(PUBLIC_URL);
      issuer = new URL(OIDC_ISSUER);
    } catch {
      throw new Error('PUBLIC_URL and OIDC_ISSUER must be valid URLs');
    }
    if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/' ||
        issuer.username || issuer.password || issuer.search || issuer.hash ||
        !['https:', 'http:'].includes(publicUrl.protocol) || !['https:', 'http:'].includes(issuer.protocol)) {
      throw new Error('PUBLIC_URL must be an origin and OIDC_ISSUER must be an issuer URL without credentials, query or fragment');
    }
    if (production && (publicUrl.protocol !== 'https:' || issuer.protocol !== 'https:')) {
      throw new Error('Production OIDC requires HTTPS PUBLIC_URL and OIDC_ISSUER');
    }
    redirectUri = new URL('/auth/callback', publicUrl).href;
    try {
      config = await oidc.discovery(issuer, OIDC_CLIENT_ID, {
        client_secret: OIDC_CLIENT_SECRET,
        id_token_signed_response_alg: 'ES256',
      }, oidc.ClientSecretBasic(OIDC_CLIENT_SECRET), {
        execute: production
          ? [oidc.enableNonRepudiationChecks]
          : [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks],
        timeout: 10,
      });
      if (production) {
        const metadata = config.serverMetadata();
        for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
          if (!endpoint || new URL(endpoint).protocol !== 'https:') throw new Error('Insecure OIDC endpoint');
        }
      }
    } catch {
      throw new Error('Unable to initialize OIDC provider');
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS auth_transactions (
      token_hash TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      nonce TEXT NOT NULL,
      verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_transactions_expiry ON auth_transactions(expires_at);
  `);
  const findSession = db.prepare('SELECT name, email FROM auth_sessions WHERE token_hash = ? AND expires_at > ?');
  const deleteSession = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?');
  const findTransaction = db.prepare('SELECT state, nonce, verifier, expires_at FROM auth_transactions WHERE token_hash = ?');
  const deleteTransaction = db.prepare('DELETE FROM auth_transactions WHERE token_hash = ?');
  const prune = () => {
    db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now());
    db.prepare('DELETE FROM auth_transactions WHERE expires_at <= ?').run(now());
  };
  prune();

  await app.register(cookie);
  const sessionCookie = production ? '__Host-ipam_session' : 'ipam_session';
  const loginCookie = production ? '__Host-ipam_login' : 'ipam_login';
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
  const session = (request: FastifyRequest): Session => {
    if (mode === 'development') return { authenticated: true, mode, user: { name: 'Local development' } };
    const token = request.cookies[sessionCookie];
    const stored = token ? findSession.get(hash(token), now()) as StoredSession | undefined : undefined;
    return {
      authenticated: !!stored,
      mode,
      user: stored ? { name: stored.name, ...(stored.email ? { email: stored.email } : {}) } : null,
    };
  };
  const sameOrigin = (request: FastifyRequest): boolean => {
    const origin = request.headers.origin;
    if (!origin) return false;
    if (mode === 'oidc') return origin === publicUrl!.origin;
    try {
      const parsed = new URL(origin);
      if (parsed.origin !== origin) return false;
      return origin === `${request.protocol}://${request.headers.host}` ||
        origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173';
    } catch {
      return false;
    }
  };

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    const route = request.routeOptions.url ?? path;
    if (path.startsWith('/auth/') || route === '/api/session') reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) {
      return reply.code(403).send({ error: 'A matching Origin header is required' });
    }
    if ((route.startsWith('/api/') || path.startsWith('/api/')) && route !== '/api/session' && !session(request).authenticated) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
  });

  app.get('/api/session', async (request) => session(request));
  app.get('/auth/login', async (request, reply) => {
    if (mode === 'development') return reply.redirect('/');
    prune();
    const previous = request.cookies[loginCookie];
    if (previous) deleteTransaction.run(hash(previous));
    const token = randomToken();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    db.prepare('INSERT INTO auth_transactions (token_hash, state, nonce, verifier, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash(token), state, nonce, verifier, now() + TRANSACTION_TTL);
    const url = oidc.buildAuthorizationUrl(config!, {
      redirect_uri: redirectUri!, scope: 'openid profile email', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', state, nonce,
    });
    return reply.setCookie(loginCookie, token, { ...cookieOptions, maxAge: TRANSACTION_TTL }).redirect(url.href);
  });

  app.get('/auth/callback', async (request, reply) => {
    if (mode === 'development') return reply.redirect('/');
    const token = request.cookies[loginCookie];
    reply.clearCookie(loginCookie, cookieOptions);
    if (!token) return reply.code(400).send({ error: 'Login failed; please start again' });
    // Consume synchronously before any network I/O: concurrent callbacks cannot replay it.
    const transaction = db.transaction(() => {
      const found = findTransaction.get(hash(token)) as LoginTransaction | undefined;
      deleteTransaction.run(hash(token));
      return found;
    })();
    if (!transaction || transaction.expires_at <= now()) {
      return reply.code(400).send({ error: 'Login failed; please start again' });
    }
    try {
      const callback = new URL(redirectUri!);
      callback.search = new URL(request.url, publicUrl!).search;
      const tokens = await oidc.authorizationCodeGrant(config!, callback, {
        pkceCodeVerifier: transaction.verifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Missing subject');
      const name = typeof claims.name === 'string' ? claims.name :
        typeof claims.preferred_username === 'string' ? claims.preferred_username : claims.sub;
      const email = typeof claims.email === 'string' ? claims.email : null;
      const previous = request.cookies[sessionCookie];
      if (previous) deleteSession.run(hash(previous));
      const sessionToken = randomToken();
      db.prepare('INSERT INTO auth_sessions (token_hash, subject, name, email, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(hash(sessionToken), claims.sub, name, email, now() + SESSION_TTL);
      return reply.setCookie(sessionCookie, sessionToken, { ...cookieOptions, maxAge: SESSION_TTL }).redirect('/');
    } catch {
      return reply.code(400).send({ error: 'Login failed; please start again' });
    }
  });

  // Local logout only. The identity provider's own SSO session is not ended.
  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[sessionCookie];
    const transaction = request.cookies[loginCookie];
    if (token) deleteSession.run(hash(token));
    if (transaction) deleteTransaction.run(hash(transaction));
    return reply.clearCookie(sessionCookie, cookieOptions).clearCookie(loginCookie, cookieOptions).send({ ok: true });
  });
}
