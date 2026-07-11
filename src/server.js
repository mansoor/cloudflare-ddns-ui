import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import formbody from '@fastify/formbody';
import { registerAuth } from './auth.js';
import apiRoutes from './routes/api.js';
import { startScheduler } from './scheduler.js';
import { loadConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    },
  });

  await app.register(formbody);
  await registerAuth(app);

  // Compiled Tailwind CSS + any other build output.
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/public/',
    decorateReply: true,
  });

  // Front-end assets (js). Served without auth — they contain no secrets.
  await app.register(fastifyStatic, {
    root: WEB_DIR,
    prefix: '/static/',
    decorateReply: false,
  });

  // HTML entry points.
  app.get('/', async (req, reply) => {
    if (!req.session.get('user')) return reply.redirect('/login');
    return reply.sendFile('index.html', WEB_DIR);
  });
  app.get('/login', async (req, reply) => {
    if (req.session.get('user')) return reply.redirect('/');
    return reply.sendFile('login.html', WEB_DIR);
  });

  await app.register(apiRoutes);

  // Ensure config exists, then start the DDNS scheduler.
  await loadConfig();
  await startScheduler({ runOnStart: true });

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Cloudflare DDNS UI listening on http://localhost:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
