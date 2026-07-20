// Smaller pure helpers: the update-available comparison shown in the footer,
// and the upstream cloudflare-ddns config parser used by the first-run wizard.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/version.js';
import { parseImport } from '../src/import.js';

describe('isNewer', () => {
  test('detects a newer release', () => {
    assert.equal(isNewer('0.5.1', '0.5.0'), true);
    assert.equal(isNewer('0.6.0', '0.5.9'), true);
    assert.equal(isNewer('1.0.0', '0.9.9'), true);
    assert.equal(isNewer('v0.5.1', '0.5.0'), true, 'tolerates a leading v');
  });

  test('is false for same or older', () => {
    assert.equal(isNewer('0.5.0', '0.5.0'), false);
    assert.equal(isNewer('0.4.9', '0.5.0'), false);
    assert.equal(isNewer('0.9.9', '1.0.0'), false);
  });

  test('compares numerically, not as strings', () => {
    // the classic trap: "0.4.10" < "0.4.9" lexically, but not numerically
    assert.equal(isNewer('0.4.10', '0.4.9'), true);
    assert.equal(isNewer('0.4.9', '0.4.10'), false);
  });

  test('handles missing/short versions without throwing', () => {
    assert.equal(isNewer('', '0.5.0'), false);
    assert.equal(isNewer('1', '0.5.0'), true);
    assert.equal(isNewer(undefined, '0.5.0'), false);
  });
});

describe('parseImport (upstream cloudflare-ddns config)', () => {
  test('pulls the cloudflare[] entries out of an object or a JSON string', () => {
    const cfg = { cloudflare: [{ zone_id: 'z1' }, { zone_id: 'z2' }] };
    assert.equal(parseImport(cfg).length, 2);
    assert.equal(parseImport(JSON.stringify(cfg)).length, 2);
  });

  test('returns nothing when there are no zones, rather than throwing', () => {
    assert.deepEqual(parseImport({ a: true }), []);
  });

  test('rejects junk with a readable message', () => {
    assert.throws(() => parseImport(''), /empty/i);
    assert.throws(() => parseImport('{not json'), SyntaxError);
    assert.throws(() => parseImport(null), /JSON object/i);
  });
});
