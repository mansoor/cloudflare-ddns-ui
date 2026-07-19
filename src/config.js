import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DDNS_TYPES } from './ddns.js';
import { HEARTBEAT_TYPES } from './heartbeat.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Placeholder the API returns instead of a real token. When the client sends
// this value back on save, we keep the token already stored on disk.
export const REDACTED_TOKEN = '__stored__';

export const IP_PROVIDERS_V4 = ['cloudflare.trace', 'cloudflare.doh', 'ipify', 'local', 'literal', 'custom', 'none'];
export const IP_PROVIDERS_V6 = ['cloudflare.trace', 'cloudflare.doh', 'ipify', 'local', 'literal', 'custom', 'none'];

export function defaultConfig() {
  return {
    cloudflare: [],
    a: true,
    aaaa: false,
    ttl: 300,
    ip4_provider: 'cloudflare.trace',
    ip4_custom_url: '',
    ip4_iface: '', // interface name when ip4_provider === 'local' (blank = default route)
    ip4_literal: '', // fixed IP when ip4_provider === 'literal'
    ip6_provider: 'none',
    ip6_custom_url: '',
    ip6_iface: '',
    ip6_literal: '',
    purge_unknown_records: false,
    reject_cloudflare_ips: true, // refuse to write a Cloudflare-owned IP into a record
    record_comment: 'cf-ddns-plus', // stamped on managed records; also gates safe purge
    update_interval_minutes: 5,
    scheduler_paused: false,
    waf_lists: [],
    notifications: {
      // Event preferences live per-channel now (each channel picks failure /
      // ip_change / success). No global events block.
      channels: [],
    },
    heartbeats: [], // uptime monitors pinged after each full run
    ddns_providers: [],
    // Master default for the DDNS force-update interval. Providers left on
    // "Default" follow these; others carry their own force_every/force_unit.
    ddns_force_every: 30,
    ddns_force_unit: 'days',
    log: {
      persistent: false, // default: in-memory only
      memory_rows: 200, // rows kept in memory (in-memory mode)
      file_name: 'activity.log', // file under DATA_DIR (persistent mode)
      retention_days: 30, // prune entries older than this nightly (persistent mode)
    },
  };
}

export const DDNS_FORCE_UNITS = ['minutes', 'hours', 'days'];
export const CHANNEL_TYPES = ['discord', 'slack', 'webhook'];
export const WEBHOOK_FORMATS = ['json', 'text'];
// Only the default for NEW lists — existing lists keep whatever comment is
// already stored (changing theirs would orphan the items they've already tagged).
const DEFAULT_ITEM_COMMENT = 'cf-ddns-plus';

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadConfig() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      const cfg = defaultConfig();
      await saveConfig(cfg);
      return cfg;
    }
    throw err;
  }
}

export async function saveConfig(cfg) {
  await ensureDataDir();
  const tmp = CONFIG_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  await fs.rename(tmp, CONFIG_PATH);
  return cfg;
}

// Fill in defaults / coerce types so older or partial files don't crash us.
export function normalizeConfig(input) {
  const def = defaultConfig();
  const cfg = { ...def, ...(input || {}) };

  cfg.a = Boolean(cfg.a);
  cfg.aaaa = Boolean(cfg.aaaa);
  cfg.purge_unknown_records = Boolean(cfg.purge_unknown_records);
  cfg.reject_cloudflare_ips = cfg.reject_cloudflare_ips !== false; // default on
  cfg.record_comment =
    typeof cfg.record_comment === 'string' ? cfg.record_comment.trim().slice(0, 100) : 'cf-ddns-plus';
  cfg.scheduler_paused = Boolean(cfg.scheduler_paused);
  cfg.ttl = clampInt(cfg.ttl, 1, 86400, 300);
  cfg.update_interval_minutes = clampInt(cfg.update_interval_minutes, 1, 1440, 5);

  if (!IP_PROVIDERS_V4.includes(cfg.ip4_provider)) cfg.ip4_provider = 'cloudflare.trace';
  if (!IP_PROVIDERS_V6.includes(cfg.ip6_provider)) cfg.ip6_provider = 'none';
  cfg.ip4_custom_url = String(cfg.ip4_custom_url || '');
  cfg.ip6_custom_url = String(cfg.ip6_custom_url || '');
  cfg.ip4_iface = String(cfg.ip4_iface || '').trim();
  cfg.ip6_iface = String(cfg.ip6_iface || '').trim();
  cfg.ip4_literal = String(cfg.ip4_literal || '').trim();
  cfg.ip6_literal = String(cfg.ip6_literal || '').trim();

  cfg.cloudflare = Array.isArray(cfg.cloudflare) ? cfg.cloudflare.map(normalizeAccount) : [];
  cfg.waf_lists = Array.isArray(cfg.waf_lists) ? cfg.waf_lists.map(normalizeWaf) : [];
  cfg.notifications = normalizeNotifications(cfg.notifications);
  cfg.heartbeats = Array.isArray(cfg.heartbeats) ? cfg.heartbeats.map(normalizeHeartbeat) : [];
  cfg.ddns_force_every = clampInt(cfg.ddns_force_every, 1, 100000, 30);
  cfg.ddns_force_unit = DDNS_FORCE_UNITS.includes(cfg.ddns_force_unit) ? cfg.ddns_force_unit : 'days';
  const forceMaster = { every: cfg.ddns_force_every, unit: cfg.ddns_force_unit };
  cfg.ddns_providers = Array.isArray(cfg.ddns_providers)
    ? cfg.ddns_providers.map((p) => normalizeDdnsProvider(p, forceMaster))
    : [];
  cfg.log = normalizeLog(cfg.log);
  return cfg;
}

function normalizeLog(l) {
  return {
    persistent: Boolean(l?.persistent),
    memory_rows: clampInt(l?.memory_rows, 10, 5000, 200),
    file_name: sanitizeLogFileName(l?.file_name),
    retention_days: clampInt(l?.retention_days, 1, 3650, 30),
  };
}

// Keep the log file inside DATA_DIR: strip path separators, allow only a safe
// charset, and drop leading dots so it can never become '.', '..', or escape.
export function sanitizeLogFileName(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[/\\]+/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^\.+/, '');
  return cleaned || 'activity.log';
}

function normalizeDdnsProvider(p, forceMaster = { every: 30, unit: 'days' }) {
  // Force-update interval: providers on "Default" follow the master setting.
  // For configs written before the master existed, infer force_default — a
  // provider that carried its own interval differing from the master keeps it.
  const forceEvery = clampInt(p?.force_every, 1, 100000, forceMaster.every);
  const forceUnit = DDNS_FORCE_UNITS.includes(p?.force_unit) ? p.force_unit : forceMaster.unit;
  const forceDefault =
    p?.force_default != null
      ? p.force_default !== false
      : forceEvery === forceMaster.every && forceUnit === forceMaster.unit;
  // FreeDNS token/URL list — migrate an older single `token` into the list.
  const rawUrls = Array.isArray(p?.urls)
    ? p.urls
    : p?.type === 'freedns' && p?.token
    ? [p.token]
    : [];
  return {
    id: p?.id || randomUUID(),
    type: DDNS_TYPES.includes(p?.type) ? p.type : 'duckdns',
    enabled: p?.enabled !== false, // default on
    label: String(p?.label || ''),
    // DuckDNS
    domains: String(p?.domains || '').trim(),
    token: String(p?.token || ''),
    // FreeDNS token/URL method — each entry pairs an optional label (the
    // domain/host it's for, so a long list stays identifiable) with the token/URL.
    method: p?.method === 'userpass' ? 'userpass' : 'token',
    urls: rawUrls.map(normalizeUrlEntry).filter((e) => e.url),
    // DynDNS2 (+ FreeDNS username/password method)
    server: String(p?.server || '').trim(),
    hostname: String(p?.hostname || '').trim(),
    username: String(p?.username || ''),
    password: String(p?.password || ''),
    https: p?.https !== false, // default true
    // Re-send on a schedule even when nothing changed — keeps free hosts from
    // expiring and re-asserts the record if it was changed at the provider.
    // On by default so skipping unchanged updates never silently lets a host lapse.
    // A provider joins scheduled runs only once a Test has succeeded, so a
    // half-configured one can't hammer a real endpoint. Providers that predate
    // this flag already have an id, so they stay eligible on upgrade; a brand
    // new one (no id yet) starts untested.
    tested: p?.tested != null ? Boolean(p.tested) : Boolean(p?.id),
    force_update: p?.force_update !== false,
    force_default: forceDefault, // follow the master interval
    force_every: forceEvery, // used only when force_default is false
    force_unit: forceUnit,
  };
}

// A FreeDNS token/URL entry is `{ label, url }`. Older configs stored a bare
// string per entry — accept those and migrate to the labelled shape.
function normalizeUrlEntry(u) {
  if (typeof u === 'string') return { label: '', url: u.trim() };
  return { label: String(u?.label || '').trim(), url: String(u?.url || '').trim() };
}

function normalizeWaf(w) {
  return {
    id: w?.id || randomUUID(),
    label: String(w?.label || ''),
    account_id: String(w?.account_id || ''),
    list_name: String(w?.list_name || ''),
    list_id: String(w?.list_id || ''),
    api_token: String(w?.api_token || ''),
    item_comment: String(w?.item_comment || '').trim() || DEFAULT_ITEM_COMMENT,
  };
}

function normalizeNotifications(n) {
  // Event prefs used to be a single global block; they're per-channel now.
  // Migrate an old global `events` object onto any channel that predates the
  // per-channel prefs so existing setups keep behaving the same.
  const g = n?.events || {};
  const legacy = {
    failure: g.failure !== false, // old default on
    ip_change: g.ip_change !== false, // old default on
    success: Boolean(g.success), // old default off
  };
  return {
    channels: Array.isArray(n?.channels) ? n.channels.map((c) => normalizeChannel(c, legacy)) : [],
  };
}

const DEFAULT_CHANNEL_EVENTS = { failure: true, ip_change: true, success: false };

function normalizeChannel(c, eventsFallback = DEFAULT_CHANNEL_EVENTS) {
  const e = c?.events;
  const events =
    e && typeof e === 'object'
      ? { failure: e.failure !== false, ip_change: e.ip_change !== false, success: Boolean(e.success) }
      : { ...eventsFallback }; // legacy channel with no prefs → inherit old global
  return {
    id: c?.id || randomUUID(),
    type: CHANNEL_TYPES.includes(c?.type) ? c.type : 'webhook',
    enabled: c?.enabled !== false, // default on
    label: String(c?.label || ''),
    webhook_url: String(c?.webhook_url || ''),
    url: String(c?.url || ''),
    format: WEBHOOK_FORMATS.includes(c?.format) ? c.format : 'json',
    auth_header: String(c?.auth_header || ''),
    events,
  };
}

function normalizeHeartbeat(h) {
  return {
    id: h?.id || randomUUID(),
    type: HEARTBEAT_TYPES.includes(h?.type) ? h.type : 'healthchecks',
    enabled: h?.enabled !== false, // default on
    label: String(h?.label || ''),
    url: String(h?.url || ''),
  };
}

function normalizeAccount(acc) {
  const subdomains = Array.isArray(acc?.subdomains) ? acc.subdomains : [];
  return {
    id: acc?.id || randomUUID(),
    enabled: acc?.enabled !== false, // default on (back-compat for older configs)
    label: String(acc?.label || ''),
    api_token: String(acc?.api_token || ''),
    zone_id: String(acc?.zone_id || ''),
    zone_name: String(acc?.zone_name || ''),
    subdomains: subdomains.map((s) => {
      const o = typeof s === 'string' ? { name: s } : s || {};
      return {
        name: normalizeSubName(o.name),
        proxied: Boolean(o.proxied),
        // Which record types to manage for this host (narrowed by the global
        // a/aaaa switches at run time). Default on for back-compat.
        a: o.a !== false,
        aaaa: o.aaaa !== false,
      };
    }),
  };
}

function normalizeSubName(name) {
  const n = String(name ?? '').trim();
  return n === '@' ? '' : n;
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const hint = (v) => (v ? String(v).slice(-4) : '');

// Return a copy safe to send to the browser: real secrets replaced with a
// redacted placeholder plus a last-4 hint for display. The generic webhook
// `url` is left visible (it's an endpoint, e.g. an ntfy topic); the real
// secrets (Discord/Slack webhook URLs, auth headers, tokens) are redacted.
export function redactConfig(cfg) {
  return {
    ...cfg,
    cloudflare: cfg.cloudflare.map((acc) => ({
      ...acc,
      api_token: acc.api_token ? REDACTED_TOKEN : '',
      api_token_hint: hint(acc.api_token),
    })),
    waf_lists: cfg.waf_lists.map((w) => ({
      ...w,
      api_token: w.api_token ? REDACTED_TOKEN : '',
      api_token_hint: hint(w.api_token),
    })),
    notifications: {
      ...cfg.notifications,
      channels: cfg.notifications.channels.map((c) => ({
        ...c,
        webhook_url: c.webhook_url ? REDACTED_TOKEN : '',
        webhook_url_hint: hint(c.webhook_url),
        auth_header: c.auth_header ? REDACTED_TOKEN : '',
        auth_header_set: Boolean(c.auth_header),
      })),
    },
    // Heartbeat URLs are sent as-is (masked in the UI with a reveal toggle,
    // like the FreeDNS update URLs) so a saved monitor can be revealed + tested.
    ddns_providers: cfg.ddns_providers.map((p) => ({
      ...p,
      token: p.token ? REDACTED_TOKEN : '',
      token_hint: hint(p.token),
      password: p.password ? REDACTED_TOKEN : '',
      password_set: Boolean(p.password),
    })),
  };
}

// Restore a secret the client left as the redacted placeholder.
const restore = (incoming, prev) =>
  incoming && incoming !== REDACTED_TOKEN ? incoming : prev || '';

// Merge an incoming (redacted) config from the client with what's on disk,
// restoring any secrets the client left as the redacted placeholder.
export function mergeIncomingConfig(existing, incoming) {
  const merged = normalizeConfig(incoming);
  // Pause is toggled only via the scheduler endpoint, never through a settings
  // save — keep whatever is already on disk.
  merged.scheduler_paused = existing.scheduler_paused;

  const cfById = new Map(existing.cloudflare.map((a) => [a.id, a]));
  const cfByZone = new Map(existing.cloudflare.map((a) => [a.zone_id, a]));
  merged.cloudflare = merged.cloudflare.map((acc) => {
    const prev = cfById.get(acc.id) || cfByZone.get(acc.zone_id);
    return { ...acc, api_token: restore(acc.api_token, prev?.api_token) };
  });

  const wafById = new Map(existing.waf_lists.map((w) => [w.id, w]));
  merged.waf_lists = merged.waf_lists.map((w) => ({
    ...w,
    api_token: restore(w.api_token, wafById.get(w.id)?.api_token),
  }));

  const chById = new Map(existing.notifications.channels.map((c) => [c.id, c]));
  merged.notifications.channels = merged.notifications.channels.map((c) => {
    const prev = chById.get(c.id);
    return {
      ...c,
      webhook_url: restore(c.webhook_url, prev?.webhook_url),
      auth_header: restore(c.auth_header, prev?.auth_header),
    };
  });

  const ddnsById = new Map(existing.ddns_providers.map((p) => [p.id, p]));
  merged.ddns_providers = merged.ddns_providers.map((p) => {
    const prev = ddnsById.get(p.id);
    return {
      ...p,
      token: restore(p.token, prev?.token),
      password: restore(p.password, prev?.password),
      // `tested` is set by a successful Test, never by a settings save.
      tested: prev ? prev.tested : p.tested,
    };
  });
  return merged;
}
