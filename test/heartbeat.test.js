// Heartbeat providers differ in a way that's easy to get subtly wrong: two of
// them signal failure by *staying silent*. This pins each one's request shape.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendHeartbeat, sendHeartbeats } from '../src/heartbeat.js';

let server;
let base;
let seen;

before(async () => {
  seen = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      if (req.url.startsWith('/boom')) {
        res.statusCode = 500;
        return res.end('nope');
      }
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe('Healthchecks.io', () => {
  test('POSTs the check URL on success', async () => {
    seen = [];
    const r = await sendHeartbeat({ type: 'healthchecks', url: `${base}/hc` }, { ok: true, message: 'all good' });
    assert.equal(r.ok, true);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/hc');
    assert.equal(seen[0].body, 'all good');
  });

  test('appends /fail on failure', async () => {
    seen = [];
    await sendHeartbeat({ type: 'healthchecks', url: `${base}/hc/` }, { ok: false, message: 'bad' });
    assert.equal(seen[0].url, '/hc/fail', 'trailing slash trimmed before /fail');
  });

  test('an HTTP error is reported, not swallowed', async () => {
    const r = await sendHeartbeat({ type: 'healthchecks', url: `${base}/boom` }, { ok: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
  });
});

describe('Uptime Kuma', () => {
  test('always pings, carrying status and message in the query', async () => {
    seen = [];
    await sendHeartbeat({ type: 'uptimekuma', url: `${base}/push/abc` }, { ok: true, message: 'fine' });
    assert.match(seen[0].url, /status=up/);
    assert.match(seen[0].url, /msg=fine/);

    seen = [];
    await sendHeartbeat({ type: 'uptimekuma', url: `${base}/push/abc` }, { ok: false, message: 'broke' });
    assert.match(seen[0].url, /status=down/);
  });

  test('an unparseable URL is rejected before any request', async () => {
    const r = await sendHeartbeat({ type: 'uptimekuma', url: 'not a url' }, { ok: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid push URL/i);
  });
});

describe('Better Stack (absence-based)', () => {
  test('pings on success', async () => {
    seen = [];
    const r = await sendHeartbeat({ type: 'betterstack', url: `${base}/bs` }, { ok: true, message: 'm' });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1);
  });

  test('stays silent on failure so the missed ping raises the alert', async () => {
    seen = [];
    const r = await sendHeartbeat({ type: 'betterstack', url: `${base}/bs` }, { ok: false });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(seen.length, 0, 'no request should be made');
  });
});

describe('Custom URL', () => {
  test('{status} and {message} are substituted, and it pings on failure too', async () => {
    seen = [];
    await sendHeartbeat(
      { type: 'custom', url: `${base}/c?s={status}&m={message}` },
      { ok: false, message: 'it broke' }
    );
    assert.match(seen[0].url, /s=down/);
    assert.match(seen[0].url, /m=it%20broke/);
  });

  test('without {status} it behaves as an absence heartbeat — success only', async () => {
    seen = [];
    const r = await sendHeartbeat({ type: 'custom', url: `${base}/c` }, { ok: false });
    assert.equal(r.skipped, true);
    assert.equal(seen.length, 0);

    await sendHeartbeat({ type: 'custom', url: `${base}/c` }, { ok: true });
    assert.equal(seen.length, 1);
  });
});

describe('sendHeartbeats', () => {
  test('only fires enabled monitors that have a URL', async () => {
    seen = [];
    const results = await sendHeartbeats(
      [
        { type: 'healthchecks', url: `${base}/a`, enabled: true },
        { type: 'healthchecks', url: `${base}/b`, enabled: false },
        { type: 'healthchecks', url: '', enabled: true },
      ],
      { ok: true, message: '' }
    );
    assert.equal(results.length, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/a');
  });
});

describe('missing configuration', () => {
  test('a monitor with no URL fails cleanly', async () => {
    const r = await sendHeartbeat({ type: 'healthchecks' }, { ok: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /no URL/i);
  });
});
