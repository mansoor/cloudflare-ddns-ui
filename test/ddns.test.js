// Each DDNS provider reports success differently ("OK", "good", "Updated…",
// "nochg"). This pins the response parsing — and the {ip} substitution — against
// a local stand-in server, so no real provider is ever contacted.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { updateDdnsProvider } from '../src/ddns.js';

let server;
let base;
let seen = [];

before(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url);
    const path = req.url.split('?')[0];
    const q = new URL(req.url, 'http://x').searchParams;
    const bodies = {
      '/duck-updated': 'OK\n203.0.113.7\n\nUPDATED',
      '/duck-nochange': 'OK\n203.0.113.7\n\nNOCHANGE',
      '/duck-ko': 'KO',
      '/freedns-updated': 'Updated 1 host(s)',
      '/freedns-nochg': 'Address 203.0.113.7 has not changed.',
      '/gen-ok': 'OK',
      '/gen-error': 'ERROR',
      '/gen-nochg': 'nochg',
    };
    // DynDNS2 always posts to /nic/update, so vary the reply by hostname.
    if (path === '/nic/update') return res.end(q.get('hostname') || 'good');
    res.end(bodies[path] ?? 'OK');
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const ips = { ipv4: '203.0.113.7', ipv6: null };

describe('DuckDNS', () => {
  const duck = (path) => ({ type: 'duckdns', label: 'd', domains: 'myhost', token: 't', server: base + path });

  test('verbose UPDATED means updated', async () => {
    const r = await updateDdnsProvider(duck('/duck-updated'), ips);
    assert.equal(r.ok, true);
    assert.equal(r.status, 'updated');
  });

  test('verbose NOCHANGE means unchanged', async () => {
    const r = await updateDdnsProvider(duck('/duck-nochange'), ips);
    assert.equal(r.status, 'unchanged');
  });

  test('KO is an error', async () => {
    const r = await updateDdnsProvider(duck('/duck-ko'), ips);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'error');
  });

  test('missing domains or token is caught before any request', async () => {
    assert.equal((await updateDdnsProvider({ type: 'duckdns', token: 't' }, ips)).status, 'error');
    assert.equal((await updateDdnsProvider({ type: 'duckdns', domains: 'h' }, ips)).status, 'error');
  });
});

describe('DynDNS2', () => {
  const dyn = (hostname) => ({
    type: 'dyndns2',
    server: base.replace('http://', ''),
    hostname,
    username: 'u',
    password: 'p',
    https: false,
  });

  test('"good" means updated, "nochg" means unchanged', async () => {
    assert.equal((await updateDdnsProvider(dyn('good'), ips)).status, 'updated');
    assert.equal((await updateDdnsProvider(dyn('nochg'), ips)).status, 'unchanged');
  });

  test('protocol error codes map to friendly messages', async () => {
    const r = await updateDdnsProvider(dyn('badauth'), ips);
    assert.equal(r.ok, false);
    assert.match(r.detail, /authentication failed/i);

    const r2 = await updateDdnsProvider(dyn('abuse'), ips);
    assert.equal(r2.ok, false);
    assert.match(r2.detail, /abuse/i);
  });

  test('credentials are required', async () => {
    const r = await updateDdnsProvider({ type: 'dyndns2', server: 'x', hostname: 'h' }, ips);
    assert.equal(r.status, 'error');
  });
});

describe('FreeDNS (token/URL method)', () => {
  const fd = (path) => ({ type: 'freedns', label: 'f', method: 'token', urls: [{ label: 'h', url: base + path }] });

  test('"Updated…" means updated', async () => {
    const r = await updateDdnsProvider(fd('/freedns-updated'), ips);
    assert.equal(r.ok, true);
    assert.equal(r.status, 'updated');
  });

  test('"has not changed" means unchanged', async () => {
    assert.equal((await updateDdnsProvider(fd('/freedns-nochg'), ips)).status, 'unchanged');
  });

  test('with no URLs configured it errors instead of silently passing', async () => {
    const r = await updateDdnsProvider({ type: 'freedns', method: 'token', urls: [] }, ips);
    assert.equal(r.ok, false);
  });
});

describe('Custom URL (generic)', () => {
  const gen = (path) => ({ type: 'generic', label: 'g', urls: [{ label: 'h', url: base + path }] });

  test('a plain OK counts as updated (freemyip-style)', async () => {
    const r = await updateDdnsProvider(gen('/gen-ok'), ips);
    assert.equal(r.ok, true);
    assert.equal(r.status, 'updated');
  });

  test('an ERROR body is an error even though HTTP was 200', async () => {
    const r = await updateDdnsProvider(gen('/gen-error'), ips);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'error');
  });

  test('a nochg body is reported as unchanged', async () => {
    const r = await updateDdnsProvider(gen('/gen-nochg'), ips);
    assert.equal(r.ok, true);
    assert.equal(r.status, 'unchanged');
  });

  test('{ip} / {ip4} / {ip6} are substituted', async () => {
    seen = [];
    await updateDdnsProvider(gen('/gen-ok?myip={ip}&four={ip4}'), { ipv4: '203.0.113.7', ipv6: null });
    assert.ok(
      seen.some((u) => u.includes('myip=203.0.113.7') && u.includes('four=203.0.113.7')),
      `expected substitution, saw: ${seen.join(', ')}`
    );
  });

  test('aggregates several URLs and surfaces the first failure', async () => {
    const r = await updateDdnsProvider(
      { type: 'generic', label: 'multi', urls: [{ label: 'a', url: base + '/gen-ok' }, { label: 'b', url: base + '/gen-error' }] },
      ips
    );
    assert.equal(r.ok, false);
    assert.match(r.detail, /1\/2 failed/);
  });

  test('rejects a non-http URL without making a request', async () => {
    const r = await updateDdnsProvider({ type: 'generic', urls: [{ label: 'x', url: 'ftp://nope' }] }, ips);
    assert.equal(r.ok, false);
    assert.match(r.detail, /http/i);
  });
});

describe('unknown provider type', () => {
  test('fails loudly rather than silently doing nothing', async () => {
    const r = await updateDdnsProvider({ type: 'wat' }, ips);
    assert.equal(r.ok, false);
    assert.match(r.detail, /unknown provider/i);
  });
});
