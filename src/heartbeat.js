// Heartbeat / uptime monitoring: ping an external monitor after each full run
// so it can alert you if this updater stops running. Supported:
//   - Healthchecks.io: ping the check URL on success, URL + "/fail" on failure.
//   - Uptime Kuma (push monitor): the push URL with ?status=up|down&msg=...
// Best-effort; a ping failure never affects the update itself.

export const HEARTBEAT_TYPES = ['healthchecks', 'uptimekuma'];

async function ping(url, { method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: body != null ? { 'Content-Type': 'text/plain' } : {},
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(t);
  }
}

export async function sendHeartbeat(hb, { ok, message = '' }) {
  if (!hb?.url) return { ok: false, error: 'no URL configured' };

  if (hb.type === 'uptimekuma') {
    let u;
    try {
      u = new URL(hb.url);
    } catch {
      return { ok: false, error: 'invalid push URL' };
    }
    u.searchParams.set('status', ok ? 'up' : 'down');
    if (message) u.searchParams.set('msg', message);
    return ping(u.toString());
  }

  // healthchecks (default)
  let url = hb.url.replace(/\/+$/, '');
  if (!ok) url += '/fail';
  return ping(url, { method: 'POST', body: message });
}

// Fire all enabled heartbeats for a completed run.
export async function sendHeartbeats(heartbeats, { ok, message }) {
  const results = [];
  for (const hb of (heartbeats || []).filter((h) => h.enabled && h.url)) {
    results.push({ hb, result: await sendHeartbeat(hb, { ok, message }) });
  }
  return results;
}
