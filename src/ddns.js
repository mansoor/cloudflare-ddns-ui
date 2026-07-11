// Simple "update-a-hostname" DDNS providers (DuckDNS + generic DynDNS2).
// Each updater returns { ok, status, detail } and never throws.
// status: 'updated' | 'unchanged' | 'error'.

export const DDNS_TYPES = ['duckdns', 'dyndns2'];

// Collapse a response body to a short, safe snippet for error messages — never
// dump a full HTML error page (e.g. a provider's 503 page) into the log.
function shorten(body, max = 140) {
  const t = String(body || '').replace(/\s+/g, ' ').trim();
  if (!t) return '(empty response)';
  if (t.startsWith('<') || /<html|<!doctype/i.test(t)) return 'unexpected HTML response (provider may be down)';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// DuckDNS wants a strict comma-separated list with no spaces.
function cleanDomains(domains) {
  return String(domains || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');
}

async function httpGet(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    const body = (await res.text().catch(() => '')).trim();
    return { httpOk: res.ok, status: res.status, body };
  } catch (err) {
    return { httpOk: false, status: 0, body: '', error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(t);
  }
}

// --- DuckDNS: GET duckdns.org/update?domains=&token=&ip=&ipv6= → "OK" / "KO" ---
async function updateDuckDns(p, { ipv4, ipv6 }) {
  if (!p.domains) return { ok: false, status: 'error', detail: 'no domains configured' };
  if (!p.token) return { ok: false, status: 'error', detail: 'no token configured' };

  const domains = cleanDomains(p.domains);
  const base = p.server || 'https://www.duckdns.org/update';
  const params = new URLSearchParams({ domains, token: p.token });
  if (ipv4) params.set('ip', ipv4);
  if (ipv6) params.set('ipv6', ipv6);
  // verbose=true makes DuckDNS return whether it changed anything.
  params.set('verbose', 'true');

  const r = await httpGet(`${base}?${params.toString()}`);
  if (r.error) return { ok: false, status: 'error', detail: r.error };
  if (!r.httpOk) return { ok: false, status: 'error', detail: `DuckDNS server error (HTTP ${r.status})` };

  const firstLine = r.body.split('\n')[0].trim().toUpperCase();
  if (firstLine !== 'OK') {
    return { ok: false, status: 'error', detail: `DuckDNS rejected the update: ${shorten(r.body)}` };
  }
  // verbose body: OK\n<ip>\n<ipv6>\n<UPDATED|NOCHANGE>
  const changed = /UPDATED/i.test(r.body);
  return {
    ok: true,
    status: changed ? 'updated' : 'unchanged',
    detail: `DuckDNS ${domains} → ${ipv4 || ipv6 || '(current)'}`,
  };
}

// --- DynDNS2: GET <server>/nic/update?hostname=&myip= with Basic auth ---
const DYNDNS2_ERRORS = {
  badauth: 'authentication failed (check username/password)',
  '!donator': 'requested feature not available for this account',
  notfqdn: 'hostname is not a fully-qualified domain name',
  nohost: 'hostname does not exist for this account',
  numhost: 'too many hosts specified',
  abuse: 'hostname blocked for abuse',
  badagent: 'client blocked',
  dnserr: 'provider DNS error',
  '911': 'provider server error — try again later',
};

async function updateDynDns2(p, { ipv4, ipv6 }) {
  if (!p.server) return { ok: false, status: 'error', detail: 'no server configured' };
  if (!p.hostname) return { ok: false, status: 'error', detail: 'no hostname configured' };
  if (!p.username || !p.password) return { ok: false, status: 'error', detail: 'username/password required' };

  const scheme = p.https === false ? 'http' : 'https';
  const params = new URLSearchParams({ hostname: p.hostname });
  if (ipv4) params.set('myip', ipv4);
  if (ipv6) params.set('myipv6', ipv6);

  const auth = Buffer.from(`${p.username}:${p.password}`).toString('base64');
  const r = await httpGet(`${scheme}://${p.server}/nic/update?${params.toString()}`, {
    headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'cloudflare-ddns-ui/1.x' },
  });
  if (r.error) return { ok: false, status: 'error', detail: r.error };

  const code = r.body.split(/\s+/)[0].toLowerCase();
  if (code === 'good' || code === 'nochg') {
    return {
      ok: true,
      status: code === 'good' ? 'updated' : 'unchanged',
      detail: `DynDNS2 ${p.hostname} → ${ipv4 || ipv6 || '(current)'}`,
    };
  }
  if (DYNDNS2_ERRORS[code]) return { ok: false, status: 'error', detail: DYNDNS2_ERRORS[code] };
  if (!r.httpOk) return { ok: false, status: 'error', detail: `server error (HTTP ${r.status})` };
  return { ok: false, status: 'error', detail: `unexpected response: ${shorten(r.body)}` };
}

// Dispatch by provider type. `p` is a normalized ddns_providers entry.
export async function updateDdnsProvider(p, ips) {
  switch (p.type) {
    case 'duckdns':
      return updateDuckDns(p, ips);
    case 'dyndns2':
      return updateDynDns2(p, ips);
    default:
      return { ok: false, status: 'error', detail: `unknown provider type: ${p.type}` };
  }
}
