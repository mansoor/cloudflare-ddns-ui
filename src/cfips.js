// Detect whether a detected public IP actually belongs to Cloudflare. If an IP
// provider (mis)reports a Cloudflare address, pointing your A/AAAA record at it
// would break the domain — so we refuse to use it. Ranges are Cloudflare's
// published lists (https://www.cloudflare.com/ips/); they change very rarely.

const V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

const V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function ip4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

function inV4Cidr(ipInt, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const rangeInt = ip4ToInt(range);
  if (rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (rangeInt & mask) >>> 0;
}

// Parse an IPv6 (with :: compression and optional embedded IPv4) to a BigInt.
function ip6ToBigInt(ip) {
  let s = String(ip).trim().toLowerCase();
  if (!s) return null;
  // Embedded IPv4 (e.g. ::ffff:1.2.3.4) → convert the trailing v4 to two groups.
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    const v4 = ip4ToInt(s.slice(idx + 1));
    if (v4 === null) return null;
    s = s.slice(0, idx + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const g of groups) {
    const v = parseInt(g || '0', 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    result = (result << 16n) + BigInt(v);
  }
  return result;
}

function inV6Cidr(ipB, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = BigInt(bitsStr);
  const rangeB = ip6ToBigInt(range);
  if (rangeB === null) return false;
  const mask = bits === 0n ? 0n : ((1n << 128n) - 1n) ^ ((1n << (128n - bits)) - 1n);
  return (ipB & mask) === (rangeB & mask);
}

// True if `ip` (v4 or v6) is inside any Cloudflare range.
export function isCloudflareIP(ip) {
  if (!ip) return false;
  if (String(ip).includes(':')) {
    const b = ip6ToBigInt(ip);
    return b !== null && V6.some((c) => inV6Cidr(b, c));
  }
  const n = ip4ToInt(ip);
  return n !== null && V4.some((c) => inV4Cidr(n, c));
}
