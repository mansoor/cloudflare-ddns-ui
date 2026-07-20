// Backup envelope + the detection that stops a Cloudflare DDNS+ backup being
// fed to the first-run "migrate from cloudflare-ddns" importer.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_TYPE, buildBackup, looksLikePlusConfig, parseRestore } from '../src/backup.js';

describe('buildBackup', () => {
  test('wraps the config in a typed, dated envelope', () => {
    const b = buildBackup({ a: true }, new Date('2026-07-13T10:00:00Z'));
    assert.equal(b._type, BACKUP_TYPE);
    assert.equal(b._exported_at, '2026-07-13T10:00:00.000Z');
    assert.ok(b._version, 'carries the app version');
    assert.deepEqual(b.config, { a: true });
  });
});

describe('looksLikePlusConfig', () => {
  test('recognises our own envelope', () => {
    assert.equal(looksLikePlusConfig(buildBackup({})), true);
  });

  test('recognises a bare Cloudflare DDNS+ config by its marker keys', () => {
    assert.equal(looksLikePlusConfig({ ip4_provider: 'ipify' }), true);
    assert.equal(looksLikePlusConfig({ ddns_providers: [] }), true);
    assert.equal(looksLikePlusConfig({ waf_lists: [] }), true);
    assert.equal(looksLikePlusConfig({ record_comment: 'x' }), true);
  });

  test('does NOT claim an upstream cloudflare-ddns config', () => {
    const upstream = {
      cloudflare: [{ authentication: { api_token: 'x' }, zone_id: 'z', subdomains: ['www'] }],
      a: true,
      aaaa: false,
      proxied: false,
      ttl: 300,
    };
    assert.equal(looksLikePlusConfig(upstream), false);
  });

  test('is safe on junk', () => {
    assert.equal(looksLikePlusConfig(null), false);
    assert.equal(looksLikePlusConfig('nope'), false);
    assert.equal(looksLikePlusConfig(42), false);
  });
});

describe('parseRestore', () => {
  test('accepts the envelope, a bare config, and JSON strings of either', () => {
    const cfg = { ip4_provider: 'ipify' };
    assert.deepEqual(parseRestore(buildBackup(cfg)), cfg);
    assert.deepEqual(parseRestore(cfg), cfg);
    assert.deepEqual(parseRestore(JSON.stringify(buildBackup(cfg))), cfg);
    assert.deepEqual(parseRestore(JSON.stringify(cfg)), cfg);
  });

  test('rejects junk with a readable message', () => {
    assert.throws(() => parseRestore(''), /empty/i);
    assert.throws(() => parseRestore('{not json'), SyntaxError);
    assert.throws(() => parseRestore(null), /JSON object/i);
    assert.throws(() => parseRestore({ _type: BACKUP_TYPE }), /no config/i);
  });
});
