// Config backup / restore helpers.
//
// A backup is the whole config object with REAL secrets (unlike the redacted
// shape the UI normally sees), wrapped in a small envelope so we can recognise
// our own exports and refuse to feed them to the upstream cloudflare-ddns
// importer. It's a convenience feature: copying the on-disk config.json is still
// the most secure way to move an instance. The export is password-gated and the
// restore additionally needs a typed confirmation because it overwrites
// everything.

import { APP_VERSION } from './version.js';

export const BACKUP_TYPE = 'cloudflare-ddns-plus-backup';

// Top-level keys that only ever exist in OUR config, never in an upstream
// timothymiller/cloudflare-ddns config.json. Presence of any of these means the
// blob is a Cloudflare DDNS+ config/backup, not something the wizard importer
// should touch.
const PLUS_MARKER_KEYS = [
  'ip4_provider',
  'update_interval_minutes',
  'record_comment',
  'waf_lists',
  'heartbeats',
  'ddns_providers',
  'scheduler_paused',
];

// Wrap a full (real-secret) config in the export envelope.
export function buildBackup(cfg, now = new Date()) {
  return {
    _type: BACKUP_TYPE,
    _version: APP_VERSION,
    _exported_at: now.toISOString(),
    config: cfg,
  };
}

// True if `obj` is one of our backups/configs (envelope or bare) rather than an
// upstream cloudflare-ddns config. Used to steer the first-run wizard.
export function looksLikePlusConfig(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj._type === BACKUP_TYPE) return true;
  return PLUS_MARKER_KEYS.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

// Pull the config out of a restore payload: accept our envelope, a bare config
// object, or a JSON string of either. Throws with a friendly message on junk.
export function parseRestore(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) throw new Error('the backup is empty');
    obj = JSON.parse(raw);
  }
  if (!obj || typeof obj !== 'object') throw new Error('expected a JSON object');
  const cfg = obj._type === BACKUP_TYPE ? obj.config : obj;
  if (!cfg || typeof cfg !== 'object') throw new Error('no config found in the backup');
  return cfg;
}
