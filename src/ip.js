// Public IP detection. Each provider returns a string IP or throws.

import os from 'node:os';
import dgram from 'node:dgram';

const TRACE_V4 = 'https://1.1.1.1/cdn-cgi/trace';
const TRACE_V6 = 'https://[2606:4700:4700::1111]/cdn-cgi/trace';
const IPIFY_V4 = 'https://api.ipify.org';
const IPIFY_V6 = 'https://api6.ipify.org';

const V4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const V6_RE = /:/;

async function fetchText(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.text()).trim();
  } finally {
    clearTimeout(t);
  }
}

function parseTrace(body) {
  const line = body.split('\n').find((l) => l.startsWith('ip='));
  return line ? line.slice(3).trim() : '';
}

// --- Cloudflare DoH "what's my IP" ---
// whoami.cloudflare (class CHAOS, type TXT) returns the querying client's IP.
// It only works over DoH *wireformat* (the JSON API can't express class CH),
// queried directly against 1.1.1.1 / 2606:4700:4700::1111 so the source IP is
// the right family.
function encodeDnsQuery(name, type, cls) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0100, 2); // RD; id 0 per DoH guidance
  header.writeUInt16BE(1, 4); // QDCOUNT
  const labels = name
    .split('.')
    .map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(cls, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), q]);
}

function parseFirstTxt(buf) {
  let off = 12;
  while (off < buf.length && buf[off] !== 0) off += buf[off] + 1; // question name
  off += 1 + 4; // null terminator + qtype + qclass
  if (off < buf.length && (buf[off] & 0xc0) === 0xc0) off += 2; // answer name (usually a pointer)
  else {
    while (off < buf.length && buf[off] !== 0) off += buf[off] + 1;
    off += 1;
  }
  off += 2 + 2 + 4 + 2; // type + class + ttl + rdlength
  const txtLen = buf[off];
  return buf.toString('ascii', off + 1, off + 1 + txtLen).trim();
}

async function dohMyIP(version) {
  const host = version === 6 ? '[2606:4700:4700::1111]' : '1.1.1.1';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://${host}/dns-query`, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
      body: encodeDnsQuery('whoami.cloudflare', 16, 3), // TXT, class CHAOS
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 12 || buf.readUInt16BE(6) < 1) throw new Error('DoH returned no answer');
    return parseFirstTxt(buf);
  } finally {
    clearTimeout(t);
  }
}

function validate(ip, version) {
  if (!ip) throw new Error('empty IP response');
  if (version === 4 && !V4_RE.test(ip)) throw new Error(`not a valid IPv4: ${ip}`);
  if (version === 6 && !V6_RE.test(ip)) throw new Error(`not a valid IPv6: ${ip}`);
  return ip;
}

const isFamily = (a, version) => a.family === (version === 6 ? 'IPv6' : 'IPv4') || a.family === version;

// A globally-routable IPv6 (skip link-local fe80::, ULA fc00::/7, loopback).
function isGlobalV6(addr) {
  const a = String(addr).toLowerCase();
  return !(a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd') || a === '::1');
}

// The source IP the OS would use to reach the internet. "Connecting" a UDP
// socket sets the route without sending any packet, so the kernel picks the
// local source address via normal routing (CGNAT-aware, prefers a global v6).
function routedLocalIP(version) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(version === 6 ? 'udp6' : 'udp4');
    const target = version === 6 ? '2606:4700:4700::1111' : '1.1.1.1';
    const done = (fn, arg) => {
      try { sock.close(); } catch {}
      fn(arg);
    };
    sock.once('error', (e) => done(reject, e));
    try {
      sock.connect(53, target, () => {
        let addr = '';
        try { addr = sock.address().address; } catch {}
        addr = (addr || '').split('%')[0];
        // '::' / '0.0.0.0' means no route of that family; a link-local v6 isn't usable.
        if (!addr || addr === '::' || addr === '0.0.0.0' || (version === 6 && !isGlobalV6(addr))) {
          done(reject, new Error(version === 6 ? 'no global IPv6 address/route on this host' : 'could not determine a local IPv4 address'));
        } else {
          done(resolve, addr);
        }
      });
    } catch (e) {
      done(reject, e);
    }
  });
}

// Pick an address of the right family from a named interface, preferring a
// global IPv6 over link-local/ULA.
function ifaceIP(version, name) {
  const list = os.networkInterfaces()[name];
  if (!list) throw new Error(`network interface "${name}" not found`);
  const candidates = list.filter((a) => isFamily(a, version) && !a.internal);
  const pick =
    version === 6 ? candidates.find((a) => isGlobalV6(a.address)) || candidates[0] : candidates[0];
  if (!pick) throw new Error(`no ${version === 6 ? 'IPv6' : 'IPv4'} address on interface "${name}"`);
  return pick.address.split('%')[0]; // strip any %zone suffix
}

/**
 * @param {number} version 4 | 6
 * @param {string} provider 'cloudflare.trace' | 'cloudflare.doh' | 'ipify' | 'local' | 'literal' | 'custom' | 'none'
 * @param {string} customUrl used when provider === 'custom'
 * @param {string} iface interface name when provider === 'local' (blank = default route)
 * @param {string} literal fixed IP when provider === 'literal'
 * @returns {Promise<string|null>} the IP, or null when provider is 'none'
 */
export async function detectIP(version, provider, customUrl = '', iface = '', literal = '') {
  if (provider === 'none') return null;

  let raw;
  switch (provider) {
    case 'cloudflare.trace':
      raw = parseTrace(await fetchText(version === 4 ? TRACE_V4 : TRACE_V6));
      break;
    case 'cloudflare.doh':
      raw = await dohMyIP(version);
      break;
    case 'ipify':
      raw = await fetchText(version === 4 ? IPIFY_V4 : IPIFY_V6);
      break;
    case 'local':
      raw = iface ? ifaceIP(version, iface) : await routedLocalIP(version);
      break;
    case 'literal':
      if (!literal) throw new Error('static IP provider selected but no IP set');
      raw = String(literal).trim();
      break;
    case 'custom':
      if (!customUrl) throw new Error('custom IP provider selected but no URL configured');
      raw = await fetchText(customUrl);
      // A custom endpoint might return a trace-style body or a bare IP.
      if (raw.includes('ip=')) raw = parseTrace(raw);
      break;
    default:
      throw new Error(`unknown IP provider: ${provider}`);
  }
  return validate(raw, version);
}

// Enumerate non-internal interfaces + their addresses, for the settings UI.
export function listInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    const usable = (addrs || [])
      .filter((a) => !a.internal)
      .map((a) => ({ address: a.address.split('%')[0], family: isFamily(a, 6) ? 6 : 4 }));
    if (usable.length) out.push({ name, addresses: usable });
  }
  return out;
}
