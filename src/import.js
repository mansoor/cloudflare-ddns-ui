// Import a config from the upstream `timothymiller/cloudflare-ddns` tool and map
// its Cloudflare zones into our schema. Their per-zone shape differs from ours
// (auth is nested; there's no zone_name), so we translate and resolve the zone
// name from Cloudflare using each entry's token.

import { listZones, listRecords } from './cloudflare.js';

// Map one upstream `cloudflare[]` entry to our account shape (without an id).
// Returns { account } or { skip: <reason> }. Tolerates our own flat shape too.
function mapEntry(entry) {
  const token = String(entry?.authentication?.api_token || entry?.api_token || '').trim();
  if (!token) {
    const usesApiKey = Boolean(entry?.authentication?.api_key);
    return {
      skip: usesApiKey
        ? 'uses a global API key (unsupported) — create a scoped API token and add it manually'
        : 'no API token found',
    };
  }
  const zone_id = String(entry?.zone_id || '').trim();
  if (!zone_id) return { skip: 'missing zone_id' };

  const subs = Array.isArray(entry?.subdomains) ? entry.subdomains : [];
  const subdomains = subs.map((s) => ({
    name: typeof s === 'string' ? s : String(s?.name || ''),
    proxied: typeof s === 'object' && s !== null ? Boolean(s.proxied) : false,
  }));

  return {
    account: {
      api_token: token,
      zone_id,
      zone_name: String(entry?.zone_name || '').trim(), // resolved below if empty
      subdomains,
    },
  };
}

// Parse raw text or an already-parsed object into the upstream entry list.
// Throws (with a helpful message) on invalid JSON.
export function parseImport(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) throw new Error('the config is empty');
    obj = JSON.parse(raw);
  }
  if (!obj || typeof obj !== 'object') throw new Error('expected a JSON object');
  return Array.isArray(obj.cloudflare) ? obj.cloudflare : [];
}

// Build a preview: for each entry, map it, resolve its zone name from Cloudflare
// (validating the token), and flag duplicates against already-configured zones.
// Each item: { ok, duplicate, reason, zone_id, zone_name, subdomains, account? }.
// `account` is present only for importable rows (caller strips it before replying).
export async function buildImportPreview(raw, existingZoneIds = new Set()) {
  const list = parseImport(raw);
  const zoneCache = new Map(); // token -> resolved zones[]
  const items = [];

  for (const entry of list) {
    const mapped = mapEntry(entry);
    if (mapped.skip) {
      items.push({ ok: false, reason: mapped.skip, zone_id: String(entry?.zone_id || '') });
      continue;
    }
    const acc = mapped.account;

    if (!acc.zone_name) {
      try {
        if (!zoneCache.has(acc.api_token)) zoneCache.set(acc.api_token, await listZones(acc.api_token));
        const found = zoneCache.get(acc.api_token).find((z) => z.id === acc.zone_id);
        if (!found) {
          items.push({ ok: false, reason: 'this token cannot access that zone_id', zone_id: acc.zone_id });
          continue;
        }
        acc.zone_name = found.name;
      } catch (err) {
        items.push({ ok: false, reason: `token check failed: ${err.message}`, zone_id: acc.zone_id });
        continue;
      }
    }

    const duplicate = existingZoneIds.has(acc.zone_id);

    // For importable zones, probe DNS-record read access. If this fails the
    // token is scoped too narrowly (e.g. Zone:Read but not Zone:DNS) and syncs
    // will fail — surface that now instead of after the first run. It's still
    // importable; the warning is advisory. (Read access is what we can prove
    // non-destructively; edit is confirmed on the first sync.)
    let warn = '';
    if (!duplicate) {
      try {
        await listRecords(acc.api_token, acc.zone_id, { type: 'A' });
      } catch (err) {
        warn = `this token can't read this zone's DNS records — check its Zone → DNS permission (${err.message})`;
      }
    }

    items.push({
      ok: !duplicate,
      duplicate,
      warn,
      reason: duplicate ? 'already configured — will be skipped' : '',
      zone_id: acc.zone_id,
      zone_name: acc.zone_name,
      subdomains: acc.subdomains,
      ...(duplicate ? {} : { account: acc }),
    });
  }
  return items;
}
