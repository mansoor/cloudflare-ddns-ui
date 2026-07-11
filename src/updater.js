// Core sync engine: detect current public IP(s), then ensure each configured
// subdomain's A/AAAA records match. Idempotent — a second run with no IP change
// results in "no change" for every record.

import * as cf from './cloudflare.js';
import { detectIP } from './ip.js';
import * as state from './state.js';
import { getLastIPs, setLastIPs } from './runtime.js';
import { notifyAll } from './notify.js';
import { updateDdnsProvider } from './ddns.js';
import { DDNS_ENABLED } from './features.js';

// Build the fully-qualified domain name for a subdomain within a zone.
function buildFqdn(subName, zoneName) {
  const n = String(subName || '').trim();
  if (n === '' || n === '@') return zoneName;
  if (n === '*') return `*.${zoneName}`;
  return `${n}.${zoneName}`;
}

// Display label + host for a non-Cloudflare DDNS provider (also the record fqdn).
function ddnsTypeLabel(type) {
  return type === 'dyndns2' ? 'DynDNS2' : type === 'freedns' ? 'FreeDNS' : 'DuckDNS';
}
function ddnsHost(p) {
  if (p.type === 'dyndns2') return p.hostname;
  if (p.type === 'freedns') return (p.method === 'userpass' ? p.hostname : p.label) || p.label || 'FreeDNS';
  return p.domains;
}

// FQDNs of currently-ENABLED sync targets (used to keep their last-sync rows).
export function enabledTargetFqdns(cfg) {
  const set = new Set();
  for (const acc of cfg.cloudflare || []) {
    if (acc.enabled === false || !acc.zone_name) continue;
    for (const sub of acc.subdomains || []) set.add(buildFqdn(sub.name, acc.zone_name));
  }
  for (const w of cfg.waf_lists || []) if (w.list_name) set.add(w.list_name);
  for (const p of cfg.ddns_providers || []) {
    if (p.enabled === false) continue;
    const host = ddnsHost(p);
    if (host) set.add(host);
  }
  return set;
}

// Synthetic "disabled" rows for disabled zones/providers, so they still appear
// in Managed records (just filtered out by default in the UI).
export function disabledRecords(cfg) {
  const out = [];
  const at = new Date().toISOString();
  for (const acc of cfg.cloudflare || []) {
    if (acc.enabled !== false || !acc.zone_name) continue;
    for (const sub of acc.subdomains || []) {
      const fqdn = buildFqdn(sub.name, acc.zone_name);
      const proxied = Boolean(sub.proxied);
      if (cfg.a) out.push({ fqdn, type: 'A', proxied, status: 'disabled', detail: 'zone disabled', at });
      if (cfg.aaaa) out.push({ fqdn, type: 'AAAA', proxied, status: 'disabled', detail: 'zone disabled', at });
    }
  }
  if (DDNS_ENABLED) {
    for (const p of cfg.ddns_providers || []) {
      if (p.enabled !== false) continue;
      const host = ddnsHost(p);
      if (host) out.push({ fqdn: host, type: ddnsTypeLabel(p.type), status: 'disabled', detail: 'provider disabled', at });
    }
  }
  return out;
}

// After a config save, rebuild the managed list: keep last-sync rows for
// still-enabled targets, add "disabled" rows for disabled ones, drop anything
// removed.
export function reconcileRecords(cfg) {
  const enabled = enabledTargetFqdns(cfg);
  const kept = state.getState().records.filter((r) => enabled.has(r.fqdn) && r.status !== 'disabled');
  state.setRecords([...kept, ...disabledRecords(cfg)]);
}

// Decide whether an existing record already matches what we want.
function recordMatches(existing, { content, proxied, ttl }) {
  // When proxied, Cloudflare forces ttl to 1 (auto); don't churn on that.
  const effectiveTtl = proxied ? 1 : ttl;
  return (
    existing.content === content &&
    Boolean(existing.proxied) === Boolean(proxied) &&
    Number(existing.ttl) === Number(effectiveTtl)
  );
}

async function syncOne({ token, zoneId, zoneName, subName, type, ip, proxied, ttl }) {
  const fqdn = buildFqdn(subName, zoneName);
  const desired = {
    type,
    name: fqdn,
    content: ip,
    proxied,
    ttl: proxied ? 1 : ttl,
  };

  const existing = (await cf.listRecords(token, zoneId, { type, name: fqdn }))[0];

  if (!existing) {
    await cf.createRecord(token, zoneId, desired);
    return { fqdn, type, proxied, status: 'created', detail: `${type} ${fqdn} → ${ip}` };
  }

  if (recordMatches(existing, desired)) {
    return { fqdn, type, proxied, status: 'unchanged', detail: `${type} ${fqdn} already ${ip}` };
  }

  await cf.updateRecord(token, zoneId, existing.id, desired);
  return {
    fqdn,
    type,
    proxied,
    status: 'updated',
    detail: `${type} ${fqdn}: ${existing.content} → ${ip}`,
  };
}

// Optional cleanup: remove A/AAAA records in the zone that aren't managed here.
async function purgeUnknown({ token, zoneId, zoneName, managedFqdns, types }) {
  const removed = [];
  for (const type of types) {
    const all = await cf.listRecords(token, zoneId, { type });
    for (const rec of all) {
      if (!managedFqdns.has(`${type}:${rec.name}`)) {
        await cf.deleteRecord(token, zoneId, rec.id);
        removed.push({ fqdn: rec.name, type, status: 'deleted', detail: `purged ${type} ${rec.name}` });
        state.log('warn', `Purged unmanaged ${type} record ${rec.name}`);
      }
    }
  }
  return removed;
}

// Sync one Cloudflare account IP List to hold the current IP(s). Only touches
// items tagged with the list's item_comment, leaving manual items alone.
async function syncWafList(list, { ipv4, ipv6, wantV4, wantV6 }) {
  const lists = await cf.listAccountLists(list.api_token, list.account_id);
  const match = lists.find((l) => l.name === list.list_name);
  if (!match) throw new Error(`list "${list.list_name}" not found in account`);

  const items = await cf.getListItems(list.api_token, list.account_id, match.id);
  const managed = items.filter((it) => it.comment === list.item_comment);

  const desired = [];
  if (wantV4 && ipv4) desired.push(ipv4);
  if (wantV6 && ipv6) desired.push(ipv6);
  const desiredSet = new Set(desired);
  const managedIps = new Set(managed.map((m) => m.ip));

  const toAdd = desired.filter((ip) => !managedIps.has(ip));
  const toRemove = managed.filter((m) => !desiredSet.has(m.ip));

  const label = `list ${list.list_name}`;
  if (!toAdd.length && !toRemove.length) {
    return {
      fqdn: list.list_name,
      type: 'WAF',
      status: 'unchanged',
      detail: `${label} already ${desired.join(', ') || '(empty)'}`,
    };
  }
  if (toAdd.length) {
    await cf.addListItems(
      list.api_token,
      list.account_id,
      match.id,
      toAdd.map((ip) => ({ ip, comment: list.item_comment }))
    );
  }
  if (toRemove.length) {
    await cf.deleteListItems(list.api_token, list.account_id, match.id, toRemove.map((m) => m.id));
  }
  const parts = [];
  if (toAdd.length) parts.push(`+${toAdd.join(', ')}`);
  if (toRemove.length) parts.push(`−${toRemove.map((m) => m.ip).join(', ')}`);
  return {
    fqdn: list.list_name,
    type: 'WAF',
    status: managed.length ? 'updated' : 'created',
    detail: `${label}: ${parts.join(' ')} (submitted)`,
  };
}

/**
 * Run one sync pass over the given config.
 * Scope: pass accountId to sync one zone only, or wafId to sync one WAF list only.
 * @returns {Promise<{result:'ok'|'partial'|'error', message:string, records:Array}>}
 */
export async function runUpdate(
  cfg,
  { trigger = 'manual', accountId = null, wafId = null, ddnsId = null } = {}
) {
  if (state.getState().running) {
    return { result: 'partial', message: 'An update is already in progress', records: [] };
  }
  // Scope selection: a scoped run touches only its own section.
  const accounts =
    wafId || ddnsId
      ? []
      : accountId
      ? cfg.cloudflare.filter((a) => a.id === accountId)
      : cfg.cloudflare;
  const wafLists =
    accountId || ddnsId
      ? []
      : wafId
      ? cfg.waf_lists.filter((w) => w.id === wafId)
      : cfg.waf_lists;
  const ddnsProviders =
    !DDNS_ENABLED || accountId || wafId
      ? []
      : ddnsId
      ? cfg.ddns_providers.filter((p) => p.id === ddnsId)
      : cfg.ddns_providers;

  if (accountId && accounts.length === 0) {
    return { result: 'error', message: 'Zone not found — save it first', records: [] };
  }
  if (wafId && wafLists.length === 0) {
    return { result: 'error', message: 'WAF list not found — save it first', records: [] };
  }
  if (ddnsId && ddnsProviders.length === 0) {
    return { result: 'error', message: 'DDNS provider not found — save it first', records: [] };
  }
  state.setRunning(true);
  state.beginLogRun();
  state.log('info', `Update started (${trigger})`, null, 'start');

  const records = [];
  let hadError = false;

  try {
    // 1) Resolve current public IPs for the enabled record types.
    let ipv4 = null;
    let ipv6 = null;

    if (cfg.a) {
      try {
        ipv4 = await detectIP(4, cfg.ip4_provider, cfg.ip4_custom_url);
        state.setIPs({ v4: ipv4 });
        state.log('info', `Detected IPv4: ${ipv4} (${cfg.ip4_provider})`);
      } catch (err) {
        hadError = true;
        state.log('error', `IPv4 detection failed: ${err.message}`);
      }
    }
    if (cfg.aaaa) {
      try {
        ipv6 = await detectIP(6, cfg.ip6_provider, cfg.ip6_custom_url);
        state.setIPs({ v6: ipv6 });
        state.log('info', `Detected IPv6: ${ipv6} (${cfg.ip6_provider})`);
      } catch (err) {
        hadError = true;
        state.log('error', `IPv6 detection failed: ${err.message}`);
      }
    }

    // 2) Walk each selected account / subdomain / record type.
    for (const acc of accounts) {
      if (acc.enabled === false) continue; // shown as "disabled" rows below
      if (!acc.api_token || !acc.zone_id || !acc.zone_name) {
        state.log('warn', `Skipping account "${acc.label || acc.zone_id}" — missing token/zone`);
        continue;
      }

      const managedFqdns = new Set();

      for (const sub of acc.subdomains) {
        const proxied = Boolean(sub.proxied);
        const plans = [];
        if (cfg.a && ipv4) plans.push({ type: 'A', ip: ipv4 });
        if (cfg.aaaa && ipv6) plans.push({ type: 'AAAA', ip: ipv6 });

        for (const plan of plans) {
          try {
            const r = await syncOne({
              token: acc.api_token,
              zoneId: acc.zone_id,
              zoneName: acc.zone_name,
              subName: sub.name,
              type: plan.type,
              ip: plan.ip,
              proxied,
              ttl: cfg.ttl,
            });
            managedFqdns.add(`${plan.type}:${r.fqdn}`);
            records.push({ ...r, at: new Date().toISOString() });
            const level = r.status === 'unchanged' ? 'info' : 'success';
            state.log(level, r.detail, { status: r.status });
          } catch (err) {
            hadError = true;
            const fqdn = buildFqdn(sub.name, acc.zone_name);
            records.push({
              fqdn,
              type: plan.type,
              proxied,
              status: 'error',
              detail: err.message,
              at: new Date().toISOString(),
            });
            state.log('error', `${plan.type} ${fqdn}: ${err.message}`);
          }
        }
      }

      // 3) Optional purge of unmanaged records.
      if (cfg.purge_unknown_records) {
        const types = [];
        if (cfg.a) types.push('A');
        if (cfg.aaaa) types.push('AAAA');
        try {
          const removed = await purgeUnknown({
            token: acc.api_token,
            zoneId: acc.zone_id,
            zoneName: acc.zone_name,
            managedFqdns,
            types,
          });
          for (const r of removed) records.push({ ...r, at: new Date().toISOString() });
        } catch (err) {
          hadError = true;
          state.log('error', `Purge failed for "${acc.label || acc.zone_id}": ${err.message}`);
        }
      }
    }

    // 4) WAF / Cloudflare IP Lists.
    for (const list of wafLists) {
      if (!list.api_token || !list.account_id || !list.list_name) {
        state.log('warn', `Skipping WAF list "${list.label || list.list_name}" — missing token/account/list`);
        continue;
      }
      try {
        const r = await syncWafList(list, { ipv4, ipv6, wantV4: cfg.a, wantV6: cfg.aaaa });
        records.push({ ...r, at: new Date().toISOString() });
        state.log(r.status === 'unchanged' ? 'info' : 'success', r.detail, { status: r.status });
      } catch (err) {
        hadError = true;
        records.push({
          fqdn: list.list_name,
          type: 'WAF',
          status: 'error',
          detail: err.message,
          at: new Date().toISOString(),
        });
        state.log('error', `WAF ${list.list_name}: ${err.message}`);
      }
    }

    // 5) Non-Cloudflare DDNS providers (opt-in; scoped out when disabled).
    for (const p of ddnsProviders) {
      if (!p.enabled) continue;
      const typeLabel = ddnsTypeLabel(p.type);
      const host = ddnsHost(p);
      try {
        const r = await updateDdnsProvider(p, { ipv4: cfg.a ? ipv4 : null, ipv6: cfg.aaaa ? ipv6 : null });
        records.push({
          fqdn: host || p.label || typeLabel,
          type: typeLabel,
          status: r.ok ? r.status : 'error',
          detail: r.detail,
          at: new Date().toISOString(),
        });
        if (r.ok) {
          state.log(r.status === 'unchanged' ? 'info' : 'success', r.detail, { status: r.status });
        } else {
          hadError = true;
          state.log('error', `${typeLabel} ${host || p.label}: ${r.detail}`);
        }
      } catch (err) {
        hadError = true;
        records.push({
          fqdn: host || p.label || typeLabel,
          type: typeLabel,
          status: 'error',
          detail: err.message,
          at: new Date().toISOString(),
        });
        state.log('error', `${typeLabel} ${host || p.label}: ${err.message}`);
      }
    }

    // Full runs show the complete picture, including "disabled" rows; scoped
    // (per-item) runs only touch their own scope.
    const isFullRun = !accountId && !wafId && !ddnsId;
    state.setRecords(isFullRun ? [...records, ...disabledRecords(cfg)] : records);
    const result = hadError ? 'partial' : 'ok';
    const message = hadError
      ? 'Completed with some errors — see the activity log'
      : `Synced ${records.length} record(s)`;
    state.finishRun({ result, message });
    state.log(hadError ? 'warn' : 'success', `Update finished: ${message}`, null, 'end');

    // 5) Notifications (best-effort; never affect the run result).
    await dispatchNotifications(cfg, { result, message, records, ipv4, ipv6 }).catch(() => {});

    return { result, message, records };
  } catch (err) {
    state.finishRun({ result: 'error', message: err.message });
    state.log('error', `Update failed: ${err.message}`, null, 'end');
    return { result: 'error', message: err.message, records };
  } finally {
    state.setRunning(false);
    state.endLogRun();
  }
}

// Decide which notifications to send for this run and fan them out. Updates the
// persisted last-IP so an IP change only alerts once.
async function dispatchNotifications(cfg, { result, message, records, ipv4, ipv6 }) {
  const events = cfg.notifications?.events || {};
  const channels = cfg.notifications?.channels || [];
  const enabled = channels.filter((c) => c.enabled);

  // Track IP changes regardless of whether we notify.
  const last = await getLastIPs();
  const v4Changed = ipv4 && last.v4 && last.v4 !== ipv4;
  const v6Changed = ipv6 && last.v6 && last.v6 !== ipv6;
  await setLastIPs({ v4: ipv4 ?? last.v4, v6: ipv6 ?? last.v6 });

  if (!enabled.length) return;

  const payloads = [];

  if (events.ip_change && (v4Changed || v6Changed)) {
    const lines = [];
    if (v4Changed) lines.push(`IPv4: ${last.v4} → ${ipv4}`);
    if (v6Changed) lines.push(`IPv6: ${last.v6} → ${ipv6}`);
    payloads.push({
      event: 'ip_change',
      title: 'Public IP changed',
      message: lines.join('\n'),
      ipv4,
      ipv6,
    });
  }

  if (events.failure && (result === 'error' || result === 'partial')) {
    const errs = records.filter((r) => r.status === 'error').map((r) => `• ${r.type} ${r.fqdn}: ${r.detail}`);
    payloads.push({
      event: 'failure',
      title: 'DDNS update failed',
      message: [message, ...errs].join('\n'),
      ipv4,
      ipv6,
    });
  }

  if (events.success) {
    const changed = records.filter((r) => ['created', 'updated', 'deleted'].includes(r.status));
    if (changed.length) {
      payloads.push({
        event: 'success',
        title: 'DNS records updated',
        message: changed.map((r) => `• ${r.detail}`).join('\n'),
        ipv4,
        ipv6,
      });
    }
  }

  for (const payload of payloads) {
    const results = await notifyAll(enabled, payload);
    for (const { channel, result: res } of results) {
      if (res.ok) {
        state.log('info', `Notified ${channel.type} (${channel.label || 'channel'}): ${payload.event}`);
      } else {
        state.log('warn', `Notify ${channel.type} (${channel.label || 'channel'}) failed: ${res.error}`);
      }
    }
  }
}
