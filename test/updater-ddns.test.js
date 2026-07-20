// End-to-end over the updater's DDNS path — the rules that decide whether a
// provider's endpoint is contacted at all. These were previously only verified
// by hand, and they're the ones that quietly stop updates if they regress.
//
// No Cloudflare zones are configured, the IP comes from the `literal` provider,
// and providers point at a local stand-in server, so nothing leaves the machine.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

// Both must be set before the modules are imported: features.js reads the flag
// at import time, and config.js resolves DATA_DIR the same way.
const DATA_DIR = path.join(os.tmpdir(), `cfddns-test-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = DATA_DIR;
process.env.ENABLE_OTHER_DDNS = '1';

const { normalizeConfig } = await import('../src/config.js');
const { runUpdate } = await import('../src/updater.js');
const { getDdnsSent, setDdnsSent } = await import('../src/runtime.js');

let server;
let base;
let hits;

before(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  hits = {};
  server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    hits[p] = (hits[p] || 0) + 1;
    res.end('OK\n1.2.3.4\n\nUPDATED');
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

// A config with one DuckDNS provider pointed at our stand-in server.
const cfgWith = (provider, extra = {}) =>
  normalizeConfig({
    a: true,
    aaaa: false,
    ip4_provider: 'literal',
    ip4_literal: extra.ip || '1.2.3.4',
    ddns_force_every: extra.forceEvery ?? 30,
    ddns_force_unit: extra.forceUnit ?? 'days',
    ddns_providers: [provider],
  });

const duck = (id, pathname, over = {}) => ({
  id,
  type: 'duckdns',
  label: id,
  domains: id,
  token: 't',
  server: base + pathname,
  tested: true,
  force_update: false,
  ...over,
});

const ddnsRow = (res) => res.records.find((r) => r.type === 'DuckDNS');

describe('a provider is not contacted until its Test passes', () => {
  test('an untested provider is skipped on a scheduled run, with the reason recorded', async () => {
    const res = await runUpdate(cfgWith(duck('untested', '/untested', { tested: false })), { trigger: 'scheduled' });
    assert.equal(hits['/untested'], undefined, 'endpoint must not be contacted');
    const row = ddnsRow(res);
    assert.equal(row.status, 'disabled');
    assert.match(row.detail, /not tested yet/i);
  });

  test('but an explicit per-provider update still runs it', async () => {
    await runUpdate(cfgWith(duck('scoped', '/scoped', { tested: false })), {
      trigger: 'manual-ddns',
      ddnsId: 'scoped',
    });
    assert.equal(hits['/scoped'], 1);
  });

  test('a tested provider runs normally', async () => {
    const res = await runUpdate(cfgWith(duck('ok', '/ok')), { trigger: 'scheduled' });
    assert.equal(hits['/ok'], 1);
    assert.equal(ddnsRow(res).status, 'updated');
  });
});

describe('updates are only sent when something changed', () => {
  test('an unchanged IP reports unchanged without another request', async () => {
    const cfg = cfgWith(duck('same', '/same'));
    const first = await runUpdate(cfg, { trigger: 'scheduled' });
    assert.equal(hits['/same'], 1);
    assert.equal(ddnsRow(first).status, 'updated');

    const second = await runUpdate(cfg, { trigger: 'scheduled' });
    assert.equal(hits['/same'], 1, 'must not contact the provider again');
    assert.equal(ddnsRow(second).status, 'unchanged');
  });

  test('a changed IP re-sends', async () => {
    await runUpdate(cfgWith(duck('ipchange', '/ipchange')), { trigger: 'scheduled' });
    assert.equal(hits['/ipchange'], 1);

    const res = await runUpdate(cfgWith(duck('ipchange', '/ipchange'), { ip: '5.6.7.8' }), { trigger: 'scheduled' });
    assert.equal(hits['/ipchange'], 2);
    assert.equal(ddnsRow(res).status, 'updated');
  });

  test('editing the provider re-sends even on the same IP', async () => {
    await runUpdate(cfgWith(duck('edited', '/edited-a')), { trigger: 'scheduled' });
    assert.equal(hits['/edited-a'], 1);

    // same id + same IP, different endpoint => the settings fingerprint changed
    await runUpdate(cfgWith(duck('edited', '/edited-b')), { trigger: 'scheduled' });
    assert.equal(hits['/edited-b'], 1);
  });
});

describe('force update re-sends on a schedule', () => {
  test('fires once the interval has elapsed, and stays quiet before that', async () => {
    const cfg = () => cfgWith(duck('forced', '/forced', { force_update: true, force_default: true }), {
      forceEvery: 1,
      forceUnit: 'minutes',
    });

    await runUpdate(cfg(), { trigger: 'scheduled' });
    assert.equal(hits['/forced'], 1);

    // within the interval: nothing changed, so no request
    const within = await runUpdate(cfg(), { trigger: 'scheduled' });
    assert.equal(hits['/forced'], 1);
    assert.equal(ddnsRow(within).status, 'unchanged');

    // backdate the last send past the interval
    const sent = await getDdnsSent('forced');
    await setDdnsSent('forced', { ...sent, at: new Date(Date.now() - 2 * 60 * 1000).toISOString() });

    const due = await runUpdate(cfg(), { trigger: 'scheduled' });
    assert.equal(hits['/forced'], 2, 'forced refresh should re-send');
    assert.equal(ddnsRow(due).status, 'updated');
  });

  test('a per-provider interval overrides the master', async () => {
    const provider = duck('override', '/override', {
      force_update: true,
      force_default: false,
      force_every: 1,
      force_unit: 'days',
    });
    // master is 1 minute, but this provider opted out with 1 day
    await runUpdate(cfgWith(provider, { forceEvery: 1, forceUnit: 'minutes' }), { trigger: 'scheduled' });
    assert.equal(hits['/override'], 1);

    const sent = await getDdnsSent('override');
    await setDdnsSent('override', { ...sent, at: new Date(Date.now() - 2 * 60 * 1000).toISOString() });

    await runUpdate(cfgWith(provider, { forceEvery: 1, forceUnit: 'minutes' }), { trigger: 'scheduled' });
    assert.equal(hits['/override'], 1, 'its own 1-day interval has not elapsed');
  });
});

describe('disabled providers', () => {
  test('are never contacted', async () => {
    await runUpdate(cfgWith(duck('off', '/off', { enabled: false })), { trigger: 'scheduled' });
    assert.equal(hits['/off'], undefined);
  });
});
