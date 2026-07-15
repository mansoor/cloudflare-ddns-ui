// Simple "update-a-hostname" DDNS providers (DuckDNS, DynDNS2, FreeDNS).
// Each updater returns { ok, status, detail } and never throws.
// status: 'updated' | 'unchanged' | 'error'.

export const DDNS_TYPES = ['duckdns', 'dyndns2', 'freedns', 'generic'];

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
    headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'cloudflare-ddns-plus/1.x' },
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

// --- FreeDNS (afraid.org) ---
// Two official methods:
//   token   → per-host random-token update URL(s); we pass &address=<ip>
//   userpass→ DynDNS2-style /nic/update at freedns.afraid.org with Basic auth
// FreeDNS replies with either plain text ("Updated…" / "…has not changed") or
// DynDNS2 codes ("good" / "nochg") — accept both.
function parseFreeDns(r, label, ip) {
  const who = `FreeDNS ${label}`;
  if (r.error) return { ok: false, status: 'error', detail: `${who}: ${r.error}` };
  if (!r.httpOk) return { ok: false, status: 'error', detail: `${who}: server error (HTTP ${r.status})` };
  const body = r.body;
  const first = body.split(/\s+/)[0].toLowerCase();
  if (/has not changed/i.test(body) || first === 'nochg') {
    return { ok: true, status: 'unchanged', detail: `${who} already ${ip || '(current)'}` };
  }
  if (/^updated/i.test(body.trim()) || first === 'good') {
    return { ok: true, status: 'updated', detail: `${who} → ${ip || '(current)'}` };
  }
  return { ok: false, status: 'error', detail: `${who}: ${shorten(body)}` };
}

async function hitFreeDnsUrl(entry, server, ip) {
  // entry is `{ label, url }`; tolerate a bare string for safety.
  const token = String(typeof entry === 'string' ? entry : entry?.url || '').trim();
  const label = (typeof entry === 'string' ? '' : entry?.label || '').trim() || 'host';
  const isUrl = /^https?:\/\//i.test(token);
  let url = isUrl ? token : `${server || 'https://freedns.afraid.org/dynamic/update.php'}?${token}`;
  if (ip) url += (url.includes('?') ? '&' : '?') + 'address=' + encodeURIComponent(ip);
  return parseFreeDns(await httpGet(url), label, ip);
}

async function updateFreeDns(p, { ipv4, ipv6 }) {
  const ip = ipv4 || ipv6;

  if (p.method === 'userpass') {
    if (!p.hostname) return { ok: false, status: 'error', detail: 'hostname required' };
    if (!p.username || !p.password) return { ok: false, status: 'error', detail: 'username/password required' };
    const scheme = p.https === false ? 'http' : 'https';
    const server = p.server || 'freedns.afraid.org';
    const params = new URLSearchParams({ hostname: p.hostname });
    if (ip) params.set('myip', ip);
    const auth = Buffer.from(`${p.username}:${p.password}`).toString('base64');
    const r = await httpGet(`${scheme}://${server}/nic/update?${params.toString()}`, {
      headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'cloudflare-ddns-plus/1.x' },
    });
    return parseFreeDns(r, p.hostname, ip);
  }

  // token / URL method — update each entry and aggregate.
  const urls = (p.urls || []).filter((u) => (typeof u === 'string' ? u : u?.url));
  if (!urls.length) return { ok: false, status: 'error', detail: 'no update tokens/URLs configured' };
  const results = [];
  for (const u of urls) results.push(await hitFreeDnsUrl(u, p.server, ip));

  const errs = results.filter((r) => !r.ok);
  const updated = results.filter((r) => r.ok && r.status === 'updated').length;
  const name = p.label || 'FreeDNS';
  if (errs.length) {
    // Surface the first failing entry's detail (which now carries its label).
    return { ok: false, status: 'error', detail: `${name}: ${errs.length}/${results.length} failed — ${errs[0].detail}` };
  }
  const n = results.length;
  return {
    ok: true,
    status: updated ? 'updated' : 'unchanged',
    detail: `FreeDNS ${name}: ${updated} updated, ${n - updated} unchanged (${n} URL${n > 1 ? 's' : ''})`,
  };
}

// --- Generic Custom URL ---
// A list of full update URLs (like FreeDNS's URL method) for the many simple
// "GET this URL" services — freemyip, dynv6, Google Domains, Namecheap, etc.
// Each URL may use {ip}/{ip4}/{ip6} placeholders; substitution is skipped when
// the URL has none (the provider then auto-detects the caller's IP). Success =
// HTTP 2xx whose body doesn't start with a known error word; the body snippet
// is surfaced either way since these services have no single response format.
function subPlaceholders(url, ipv4, ipv6) {
  return url
    .replace(/\{ip4\}/gi, ipv4 || '')
    .replace(/\{ip6\}/gi, ipv6 || '')
    .replace(/\{ip\}/gi, ipv4 || ipv6 || '');
}

// Body starts with one of these → treat as an error even on HTTP 200 (freemyip
// "ERROR", DuckDNS-style "KO", DynDNS2 "badauth"/"nohost"/"911", …).
const GENERIC_ERROR_RE = /^(err|error|ko|bad|nohost|notfqdn|numhost|abuse|dnserr|fail|911|!)/i;
const GENERIC_NOCHG_RE = /(nochg|no change|has not changed|unchanged|already)/i;

async function hitGenericUrl(entry, ipv4, ipv6) {
  const rawUrl = String(typeof entry === 'string' ? entry : entry?.url || '').trim();
  const label = (typeof entry === 'string' ? '' : entry?.label || '').trim() || 'host';
  const who = `Custom URL ${label}`;
  if (!/^https?:\/\//i.test(rawUrl)) return { ok: false, status: 'error', detail: `${who}: not an http(s) URL` };

  const r = await httpGet(subPlaceholders(rawUrl, ipv4, ipv6));
  if (r.error) return { ok: false, status: 'error', detail: `${who}: ${r.error}` };
  if (!r.httpOk) return { ok: false, status: 'error', detail: `${who}: server error (HTTP ${r.status}) ${shorten(r.body)}` };

  const first = r.body.split(/\s+/)[0].toLowerCase();
  if (GENERIC_ERROR_RE.test(first)) return { ok: false, status: 'error', detail: `${who}: ${shorten(r.body)}` };
  const unchanged = GENERIC_NOCHG_RE.test(r.body);
  return { ok: true, status: unchanged ? 'unchanged' : 'updated', detail: `${who}: ${shorten(r.body)}` };
}

async function updateGeneric(p, { ipv4, ipv6 }) {
  const urls = (p.urls || []).filter((u) => (typeof u === 'string' ? u : u?.url));
  if (!urls.length) return { ok: false, status: 'error', detail: 'no update URLs configured' };
  const results = [];
  for (const u of urls) results.push(await hitGenericUrl(u, ipv4, ipv6));

  const errs = results.filter((r) => !r.ok);
  const updated = results.filter((r) => r.ok && r.status === 'updated').length;
  const name = p.label || 'Custom URL';
  if (errs.length) {
    return { ok: false, status: 'error', detail: `${name}: ${errs.length}/${results.length} failed — ${errs[0].detail}` };
  }
  const n = results.length;
  return {
    ok: true,
    status: updated ? 'updated' : 'unchanged',
    detail: `Custom URL ${name}: ${updated} updated, ${n - updated} unchanged (${n} URL${n > 1 ? 's' : ''})`,
  };
}

// Dispatch by provider type. `p` is a normalized ddns_providers entry.
export async function updateDdnsProvider(p, ips) {
  switch (p.type) {
    case 'duckdns':
      return updateDuckDns(p, ips);
    case 'dyndns2':
      return updateDynDns2(p, ips);
    case 'freedns':
      return updateFreeDns(p, ips);
    case 'generic':
      return updateGeneric(p, ips);
    default:
      return { ok: false, status: 'error', detail: `unknown provider type: ${p.type}` };
  }
}
