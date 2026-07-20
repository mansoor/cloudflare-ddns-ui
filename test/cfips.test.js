// The guard that refuses to point a record at a Cloudflare-owned IP. A false
// negative here breaks the user's domain, so the CIDR maths is worth pinning.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isCloudflareIP } from '../src/cfips.js';

describe('isCloudflareIP — IPv4', () => {
  test('detects addresses inside published Cloudflare ranges', () => {
    assert.equal(isCloudflareIP('104.16.0.1'), true); // 104.16.0.0/13
    assert.equal(isCloudflareIP('104.23.255.254'), true); // upper end of /13
    assert.equal(isCloudflareIP('172.64.0.1'), true); // 172.64.0.0/13
    assert.equal(isCloudflareIP('131.0.72.5'), true); // 131.0.72.0/22
    assert.equal(isCloudflareIP('173.245.48.1'), true); // 173.245.48.0/20
  });

  test('leaves ordinary public and private addresses alone', () => {
    assert.equal(isCloudflareIP('8.8.8.8'), false);
    assert.equal(isCloudflareIP('192.168.1.10'), false);
    assert.equal(isCloudflareIP('203.0.113.7'), false);
    assert.equal(isCloudflareIP('104.15.255.255'), false); // just below 104.16.0.0/13
    assert.equal(isCloudflareIP('131.0.76.1'), false); // just past 131.0.72.0/22
  });
});

describe('isCloudflareIP — IPv6', () => {
  test('detects addresses inside published Cloudflare ranges', () => {
    assert.equal(isCloudflareIP('2606:4700::1111'), true); // 2606:4700::/32
    assert.equal(isCloudflareIP('2400:cb00:1234::1'), true); // 2400:cb00::/32
    assert.equal(isCloudflareIP('2a06:98c0:0:1::5'), true); // 2a06:98c0::/29
  });

  test('leaves other addresses alone', () => {
    assert.equal(isCloudflareIP('2001:db8::1'), false);
    assert.equal(isCloudflareIP('2606:4701::1'), false); // outside the /32
    assert.equal(isCloudflareIP('fe80::1'), false);
  });
});

describe('isCloudflareIP — bad input', () => {
  test('never throws, just says no', () => {
    for (const junk of ['', null, undefined, 'not-an-ip', '1.2.3', '999.1.1.1', '1.2.3.4.5', {}]) {
      assert.equal(isCloudflareIP(junk), false, `input: ${JSON.stringify(junk)}`);
    }
  });
});
