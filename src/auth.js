import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import secureSession from '@fastify/secure-session';
import { DATA_DIR } from './config.js';

const SECRET_PATH = path.join(DATA_DIR, '.session-secret');

// The session cookie is signed with a 32-byte key. We accept SESSION_SECRET
// (any string, hashed to 32 bytes) or persist a random one to the data dir.
async function resolveSessionKey() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim()) {
    // Derive a stable 32-byte key from the provided secret.
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(fromEnv.trim()).digest();
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const hex = (await fs.readFile(SECRET_PATH, 'utf8')).trim();
    if (hex.length >= 64) return Buffer.from(hex.slice(0, 64), 'hex');
  } catch {
    /* generate below */
  }
  const key = randomBytes(32);
  await fs.writeFile(SECRET_PATH, key.toString('hex'), { mode: 0o600 });
  return key;
}

// Resolve admin credentials. Password comes from env, or is generated once and
// logged so the operator can grab it on first boot.
async function resolveAdmin(log) {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  let password = process.env.ADMIN_PASSWORD;
  if (!password || !password.trim()) {
    password = randomBytes(9).toString('base64url'); // ~12 chars
    log.warn('════════════════════════════════════════════════════════');
    log.warn(' No ADMIN_PASSWORD set. Generated a temporary password:');
    log.warn(`   username: ${username}`);
    log.warn(`   password: ${password}`);
    log.warn(' Set ADMIN_PASSWORD in your environment to make it permanent.');
    log.warn('════════════════════════════════════════════════════════');
  }
  return { username, passwordHash: bcrypt.hashSync(password, 10) };
}

export async function registerAuth(app) {
  const key = await resolveSessionKey();
  const admin = await resolveAdmin(app.log);

  await app.register(secureSession, {
    key,
    cookieName: 'ddns_session',
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    },
  });

  app.decorate('verifyCredentials', (username, password) => {
    if (username !== admin.username) return false;
    return bcrypt.compareSync(String(password || ''), admin.passwordHash);
  });

  // Re-check just the admin password (no username) — used to gate sensitive,
  // already-authenticated actions like exporting or restoring the full config.
  app.decorate('verifyPassword', (password) =>
    bcrypt.compareSync(String(password || ''), admin.passwordHash)
  );

  // preHandler guard for protected routes.
  app.decorate('requireAuth', function (req, reply, done) {
    if (req.session.get('user')) return done();
    reply.code(401).send({ error: 'unauthorized' });
  });
}
