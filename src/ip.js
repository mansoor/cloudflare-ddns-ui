// Public IP detection. Each provider returns a string IP or throws.

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

function validate(ip, version) {
  if (!ip) throw new Error('empty IP response');
  if (version === 4 && !V4_RE.test(ip)) throw new Error(`not a valid IPv4: ${ip}`);
  if (version === 6 && !V6_RE.test(ip)) throw new Error(`not a valid IPv6: ${ip}`);
  return ip;
}

/**
 * @param {number} version 4 | 6
 * @param {string} provider 'cloudflare.trace' | 'ipify' | 'custom' | 'none'
 * @param {string} customUrl used when provider === 'custom'
 * @returns {Promise<string|null>} the IP, or null when provider is 'none'
 */
export async function detectIP(version, provider, customUrl = '') {
  if (provider === 'none') return null;

  let raw;
  switch (provider) {
    case 'cloudflare.trace':
      raw = parseTrace(await fetchText(version === 4 ? TRACE_V4 : TRACE_V6));
      break;
    case 'ipify':
      raw = await fetchText(version === 4 ? IPIFY_V4 : IPIFY_V6);
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
