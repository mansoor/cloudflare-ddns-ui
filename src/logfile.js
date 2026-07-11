// Optional on-disk activity log. When enabled, each log entry is appended as one
// JSON line (JSONL) to a file under DATA_DIR, so the log survives restarts.
// Entries older than the retention window are pruned nightly.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

let cfg = { enabled: false, filePath: null, retentionDays: 30 };

// Serialize all file operations so an append can't interleave with a prune's
// read-filter-rewrite (which would drop the concurrent append).
let queue = Promise.resolve();
function serialize(fn) {
  const next = queue.then(fn, fn);
  // Don't let a rejection wedge the chain; each op handles its own errors.
  queue = next.catch(() => {});
  return next;
}

export function configureLogFile({ enabled, fileName, retentionDays }) {
  cfg = {
    enabled: Boolean(enabled),
    filePath: enabled ? path.join(DATA_DIR, fileName) : null,
    retentionDays: Number(retentionDays) || 30,
  };
  return cfg;
}

export function isEnabled() {
  return cfg.enabled;
}

// Append one entry (best-effort — never throws into the caller).
export function appendEntry(entry) {
  if (!cfg.enabled || !cfg.filePath) return Promise.resolve();
  const line = JSON.stringify(entry) + '\n';
  return serialize(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.appendFile(cfg.filePath, line, 'utf8');
    } catch {
      /* disk error — keep running on the in-memory log */
    }
  });
}

// Read up to `limit` most-recent entries back (newest first), for repopulating
// the in-memory log on startup.
export async function loadRecent(limit = 200) {
  if (!cfg.enabled || !cfg.filePath) return [];
  return serialize(async () => {
    let raw;
    try {
      raw = await fs.readFile(cfg.filePath, 'utf8');
    } catch {
      return []; // no file yet
    }
    const entries = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        entries.push(JSON.parse(s));
      } catch {
        /* skip a malformed/truncated line */
      }
    }
    // File is oldest-first; the in-memory log is newest-first.
    return entries.slice(-limit).reverse();
  });
}

// Drop entries whose timestamp is older than the retention window.
export async function prune() {
  if (!cfg.enabled || !cfg.filePath) return { removed: 0, kept: 0 };
  return serialize(async () => {
    let raw;
    try {
      raw = await fs.readFile(cfg.filePath, 'utf8');
    } catch {
      return { removed: 0, kept: 0 };
    }
    const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
    const kept = [];
    let removed = 0;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let entry;
      try {
        entry = JSON.parse(s);
      } catch {
        continue; // drop unparseable lines
      }
      const t = Date.parse(entry.at);
      if (Number.isFinite(t) && t < cutoff) removed += 1;
      else kept.push(s);
    }
    if (removed > 0) {
      const tmp = cfg.filePath + '.tmp';
      await fs.writeFile(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
      await fs.rename(tmp, cfg.filePath);
    }
    return { removed, kept: kept.length };
  });
}

// Run prune every night (~03:00 local) plus once shortly after boot. The timer
// is unref'd so it never keeps the process alive on its own.
let pruneTimer = null;
export function startDailyPrune() {
  if (pruneTimer) clearTimeout(pruneTimer);
  const arm = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    pruneTimer = setTimeout(async () => {
      await prune().catch(() => {});
      arm();
    }, next.getTime() - now.getTime());
    if (pruneTimer.unref) pruneTimer.unref();
  };
  arm();
}
