// App version + best-effort "update available" check against GitHub releases.
// The check is cached (6h) and degrades silently when offline; it can be turned
// off entirely with DISABLE_UPDATE_CHECK=true for fully air-gapped installs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

export const APP_VERSION = pkg.version;
export const REPO_URL = 'https://github.com/mansoor/cloudflare-ddns-ui';
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LICENSE = 'MIT';

const LATEST_API = 'https://api.github.com/repos/mansoor/cloudflare-ddns-ui/releases/latest';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DISABLED = /^(1|true|yes|on)$/i.test(String(process.env.DISABLE_UPDATE_CHECK || '').trim());

let cache = { at: 0, latest: null };

function parseVer(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

// Is `latest` a strictly newer semver than `current`?
export function isNewer(latest, current) {
  const a = parseVer(latest);
  const b = parseVer(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchLatestTag() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cloudflare-ddns-ui' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const j = await res.json();
    return String(j.tag_name || j.name || '').trim();
  } finally {
    clearTimeout(t);
  }
}

export async function getVersionInfo() {
  const info = {
    current: APP_VERSION,
    latest: null,
    updateAvailable: false,
    repoUrl: REPO_URL,
    releasesUrl: RELEASES_URL,
    license: LICENSE,
    checkEnabled: !DISABLED,
  };
  if (DISABLED) return info;

  const now = Date.now();
  if (!cache.latest || now - cache.at > TTL_MS) {
    try {
      cache = { at: now, latest: await fetchLatestTag() };
    } catch {
      // Offline / rate-limited / no releases — leave the footer without an
      // update hint rather than surfacing an error.
    }
  }
  if (cache.latest) {
    info.latest = cache.latest.replace(/^v/i, '');
    info.updateAvailable = isNewer(cache.latest, APP_VERSION);
  }
  return info;
}
