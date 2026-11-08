import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { createStore } from './domain.js';
import { registerApi } from './routes.js';
import { registerAuth } from './auth.js';

export async function buildApp(databasePath = process.env.DB_PATH ?? 'data/ipam.db') {
  const app = Fastify({
    bodyLimit: 1_048_576,
    logger: process.env.NODE_ENV === 'test' ? false : {
      serializers: {
        req(request) {
          return { method: request.method, url: request.url?.split('?')[0], hostname: request.hostname };
        },
      },
    },
  });
  const db = openDatabase(databasePath);
  app.addHook('onClose', async () => { db.close(); });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (request.url.startsWith('/api/') || request.url.startsWith('/auth/')) reply.header('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') reply.header('Strict-Transport-Security', 'max-age=31536000');
  });
  app.setErrorHandler((error, request, reply) => {
    const failure = error as Error & { statusCode?: number };
    if (failure.statusCode && failure.statusCode < 500) {
      return reply.code(failure.statusCode).send({ error: failure.message });
    }
    request.log.error(error, 'Request failed');
    return reply.code(500).send({ error: 'Unexpected server error' });
  });
  app.get('/health/live', async () => ({ ok: true }));
  app.get('/health/ready', async () => { db.prepare('SELECT 1').get(); return { ok: true }; });
  try {
    await registerAuth(app, db);
    registerApi(app, createStore(db));
    if (process.env.NODE_ENV === 'production' || process.env.SERVE_WEB === 'true') {
      const root = process.env.SERVE_WEB === 'true' ? resolve('dist/web') : fileURLToPath(new URL('../web/', import.meta.url));
      await app.register(fastifyStatic, { root });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/') || request.url.startsWith('/auth/') || !['GET', 'HEAD'].includes(request.method)) {
          return reply.code(404).send({ error: 'Not found' });
        }
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      });
    }
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await buildApp();
  const shutdown = async () => { await app.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
}
