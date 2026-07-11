// Small persisted runtime state, separate from user config. Currently holds the
// last IPs we saw, so IP-change notifications survive restarts and don't fire on
// first-ever detection.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const RUNTIME_PATH = path.join(DATA_DIR, 'runtime.json');

export async function getLastIPs() {
  try {
    const raw = await fs.readFile(RUNTIME_PATH, 'utf8');
    const data = JSON.parse(raw);
    return { v4: data.lastIPv4 ?? null, v6: data.lastIPv6 ?? null };
  } catch {
    return { v4: null, v6: null };
  }
}

export async function setLastIPs({ v4, v6 }) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const data = { lastIPv4: v4 ?? null, lastIPv6: v6 ?? null, updatedAt: new Date().toISOString() };
  const tmp = RUNTIME_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, RUNTIME_PATH);
}
