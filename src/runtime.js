// Small persisted runtime state, separate from user config. Holds the last IPs
// we saw (so IP-change notifications survive restarts and don't fire on
// first-ever detection) and the last IPs successfully sent to each Custom URL
// DDNS provider (so we can report "unchanged" and skip the needless request).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const RUNTIME_PATH = path.join(DATA_DIR, 'runtime.json');

async function readRuntime() {
  try {
    return JSON.parse(await fs.readFile(RUNTIME_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

// Read-modify-write the whole file so unrelated keys are preserved. Runs are
// serialized by the updater (never concurrent), so this is safe.
async function writeRuntime(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = RUNTIME_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  await fs.rename(tmp, RUNTIME_PATH);
}

export async function getLastIPs() {
  const d = await readRuntime();
  return { v4: d.lastIPv4 ?? null, v6: d.lastIPv6 ?? null };
}

export async function setLastIPs({ v4, v6 }) {
  const d = await readRuntime();
  d.lastIPv4 = v4 ?? null;
  d.lastIPv6 = v6 ?? null;
  await writeRuntime(d);
}

// Last IPs (and a signature of the URL list) successfully sent to a Custom URL
// provider. `null` when we've never sent to it. The signature lets an edited URL
// list re-send even if the IP hasn't changed.
export async function getDdnsSent(id) {
  const d = await readRuntime();
  const e = d.ddnsSent && d.ddnsSent[id];
  return e ? { v4: e.v4 ?? null, v6: e.v6 ?? null, sig: e.sig ?? '' } : null;
}

export async function setDdnsSent(id, { v4, v6, sig }) {
  const d = await readRuntime();
  d.ddnsSent = d.ddnsSent || {};
  d.ddnsSent[id] = { v4: v4 ?? null, v6: v6 ?? null, sig: sig ?? '' };
  await writeRuntime(d);
}
