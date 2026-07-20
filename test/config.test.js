// Config schema: normalization, the migrations that keep older configs working,
// and the secret redact/restore round-trip. These are the rules an upgrade can
// silently break, so they're worth pinning down.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultConfig,
  normalizeConfig,
  mergeIncomingConfig,
  redactConfig,
  sanitizeLogFileName,
  REDACTED_TOKEN,
} from '../src/config.js';

describe('defaults', () => {
  test('ships the documented defaults', () => {
    const d = defaultConfig();
    assert.equal(d.a, true);
    assert.equal(d.aaaa, false);
    assert.equal(d.ttl, 300);
    assert.equal(d.update_interval_minutes, 5);
    assert.equal(d.reject_cloudflare_ips, true);
    assert.equal(d.record_comment, 'cf-ddns-plus');
    assert.equal(d.ip4_provider, 'cloudflare.trace');
    assert.equal(d.ip6_provider, 'none');
    assert.equal(d.ddns_force_every, 30);
    assert.equal(d.ddns_force_unit, 'days');
    assert.deepEqual(d.notifications, { channels: [] });
  });
});

describe('normalizeConfig', () => {
  test('clamps numbers and rejects unknown providers', () => {
    const cfg = normalizeConfig({
      ttl: 999999,
      update_interval_minutes: 0,
      ip4_provider: 'not-a-provider',
      ip6_provider: 'ipify',
    });
    assert.equal(cfg.ttl, 86400);
    assert.equal(cfg.update_interval_minutes, 1);
    assert.equal(cfg.ip4_provider, 'cloudflare.trace'); // fell back
    assert.equal(cfg.ip6_provider, 'ipify'); // valid, kept
  });

  test('record_comment is trimmed and capped at 100 chars', () => {
    const cfg = normalizeConfig({ record_comment: `  ${'x'.repeat(150)}  ` });
    assert.equal(cfg.record_comment.length, 100);
  });

  test('subdomains: "@" means the apex, A/AAAA default on', () => {
    const cfg = normalizeConfig({
      cloudflare: [{ id: 'a1', api_token: 't', zone_id: 'z', subdomains: ['@', { name: 'www', proxied: true }] }],
    });
    const subs = cfg.cloudflare[0].subdomains;
    assert.equal(subs[0].name, '');
    assert.equal(subs[0].a, true);
    assert.equal(subs[0].aaaa, true);
    assert.equal(subs[1].proxied, true);
  });
});

describe('sanitizeLogFileName', () => {
  test('keeps the log file inside the data dir', () => {
    assert.equal(sanitizeLogFileName('../../etc/passwd'), 'etcpasswd');
    assert.equal(sanitizeLogFileName('sub/dir/app.log'), 'subdirapp.log');
    assert.equal(sanitizeLogFileName('..'), 'activity.log');
    assert.equal(sanitizeLogFileName(''), 'activity.log');
    assert.equal(sanitizeLogFileName('my log!.txt'), 'mylog.txt');
    assert.equal(sanitizeLogFileName('activity.log'), 'activity.log');
  });
});

describe('notifications — legacy global events migrate per-channel', () => {
  test('an old global events block is copied onto every channel', () => {
    const cfg = normalizeConfig({
      notifications: {
        events: { failure: true, ip_change: false, success: true },
        channels: [{ type: 'webhook', url: 'https://ntfy.sh/a' }, { type: 'discord', webhook_url: 'https://d' }],
      },
    });
    for (const ch of cfg.notifications.channels) {
      assert.deepEqual(ch.events, { failure: true, ip_change: false, success: true });
    }
    // the global block is dropped once migrated
    assert.equal(cfg.notifications.events, undefined);
  });

  test('explicit per-channel events win, and new channels get the defaults', () => {
    const cfg = normalizeConfig({
      notifications: {
        channels: [
          { type: 'webhook', url: 'u', events: { failure: false, ip_change: true, success: false } },
          { type: 'webhook', url: 'u2' },
        ],
      },
    });
    assert.deepEqual(cfg.notifications.channels[0].events, { failure: false, ip_change: true, success: false });
    assert.deepEqual(cfg.notifications.channels[1].events, { failure: true, ip_change: true, success: false });
  });
});

describe('DDNS providers — Test gating', () => {
  test('providers that predate the flag stay eligible (upgrades must not stop updates)', () => {
    const p = normalizeConfig({ ddns_providers: [{ id: 'existing', type: 'duckdns', domains: 'h', token: 't' }] })
      .ddns_providers[0];
    assert.equal(p.tested, true);
  });

  test('a brand new provider (no id yet) starts untested', () => {
    const p = normalizeConfig({ ddns_providers: [{ type: 'duckdns', domains: 'h', token: 't' }] }).ddns_providers[0];
    assert.equal(p.tested, false);
  });

  test('an explicit value is honoured', () => {
    const p = normalizeConfig({ ddns_providers: [{ id: 'x', type: 'duckdns', tested: false }] }).ddns_providers[0];
    assert.equal(p.tested, false);
  });
});

describe('DDNS providers — force-update interval', () => {
  test('a custom interval differing from the master is preserved as an override', () => {
    const p = normalizeConfig({ ddns_providers: [{ id: 'x', type: 'duckdns', force_every: 6, force_unit: 'hours' }] })
      .ddns_providers[0];
    assert.equal(p.force_default, false);
    assert.equal(p.force_every, 6);
    assert.equal(p.force_unit, 'hours');
  });

  test('an interval matching the master just follows the default', () => {
    const p = normalizeConfig({ ddns_providers: [{ id: 'x', type: 'duckdns', force_every: 30, force_unit: 'days' }] })
      .ddns_providers[0];
    assert.equal(p.force_default, true);
  });

  test('invalid unit and out-of-range interval are clamped', () => {
    const p = normalizeConfig({ ddns_providers: [{ id: 'x', type: 'duckdns', force_unit: 'weeks', force_every: 0 }] })
      .ddns_providers[0];
    assert.equal(p.force_unit, 'days');
    assert.equal(p.force_every, 1);
  });
});

describe('WAF managed-item comment', () => {
  test('new lists take the current default', () => {
    const w = normalizeConfig({ waf_lists: [{ label: 'w' }] }).waf_lists[0];
    assert.equal(w.item_comment, 'cf-ddns-plus');
  });

  test('an existing comment is never rewritten (that would orphan tagged items)', () => {
    const w = normalizeConfig({ waf_lists: [{ label: 'w', item_comment: 'cf-ddns-ui' }] }).waf_lists[0];
    assert.equal(w.item_comment, 'cf-ddns-ui');
  });
});

describe('redactConfig', () => {
  const cfg = normalizeConfig({
    cloudflare: [{ id: 'a1', api_token: 'abcd1234efgh', zone_id: 'z', zone_name: 'e.com' }],
    waf_lists: [{ id: 'w1', api_token: 'wafTOKEN9999' }],
    notifications: { channels: [{ id: 'c1', type: 'discord', webhook_url: 'https://d/hook', auth_header: 'Bearer x' }] },
    heartbeats: [{ id: 'h1', type: 'healthchecks', url: 'https://hc-ping.com/secret' }],
    ddns_providers: [{ id: 'd1', type: 'duckdns', token: 'tok123456', password: 'pw' }],
  });
  const red = redactConfig(cfg);

  test('secrets are replaced with the placeholder plus a last-4 hint', () => {
    assert.equal(red.cloudflare[0].api_token, REDACTED_TOKEN);
    assert.equal(red.cloudflare[0].api_token_hint, 'efgh');
    assert.equal(red.waf_lists[0].api_token, REDACTED_TOKEN);
    assert.equal(red.notifications.channels[0].webhook_url, REDACTED_TOKEN);
    assert.equal(red.notifications.channels[0].auth_header, REDACTED_TOKEN);
    assert.equal(red.ddns_providers[0].token, REDACTED_TOKEN);
    assert.equal(red.ddns_providers[0].token_hint, '3456');
    assert.equal(red.ddns_providers[0].password, REDACTED_TOKEN);
  });

  test('heartbeat URLs are deliberately sent as-is (masked client-side with a reveal)', () => {
    assert.equal(red.heartbeats[0].url, 'https://hc-ping.com/secret');
  });
});

describe('mergeIncomingConfig', () => {
  const existing = normalizeConfig({
    scheduler_paused: true,
    cloudflare: [{ id: 'a1', api_token: 'REALTOKEN', zone_id: 'z', zone_name: 'e.com' }],
    ddns_providers: [{ id: 'd1', type: 'duckdns', domains: 'h', token: 'REALDUCK', tested: true }],
  });

  test('a placeholder secret keeps whatever is on disk', () => {
    const merged = mergeIncomingConfig(existing, {
      cloudflare: [{ id: 'a1', api_token: REDACTED_TOKEN, zone_id: 'z', zone_name: 'e.com' }],
    });
    assert.equal(merged.cloudflare[0].api_token, 'REALTOKEN');
  });

  test('a real incoming secret replaces the stored one', () => {
    const merged = mergeIncomingConfig(existing, {
      cloudflare: [{ id: 'a1', api_token: 'NEWTOKEN', zone_id: 'z', zone_name: 'e.com' }],
    });
    assert.equal(merged.cloudflare[0].api_token, 'NEWTOKEN');
  });

  test('pause state is owned by the scheduler endpoint, not a settings save', () => {
    const merged = mergeIncomingConfig(existing, { scheduler_paused: false });
    assert.equal(merged.scheduler_paused, true);
  });

  test('a settings save cannot flip `tested` back off', () => {
    const merged = mergeIncomingConfig(existing, {
      ddns_providers: [{ id: 'd1', type: 'duckdns', domains: 'h', token: REDACTED_TOKEN, tested: false }],
    });
    assert.equal(merged.ddns_providers[0].tested, true);
    assert.equal(merged.ddns_providers[0].token, 'REALDUCK');
  });

  test('a provider added through a save stays untested', () => {
    const merged = mergeIncomingConfig(existing, {
      ddns_providers: [{ type: 'duckdns', domains: 'new', token: 'z' }],
    });
    assert.equal(merged.ddns_providers[0].tested, false);
  });
});
