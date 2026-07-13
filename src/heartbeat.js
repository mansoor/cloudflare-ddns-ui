// Heartbeat / uptime monitoring: ping an external monitor after each full run
// so it can alert you if this updater stops running. Supported:
//   - Healthchecks.io: POST the check URL on success, URL + "/fail" on failure.
//   - Uptime Kuma (push monitor): the push URL with ?status=up|down&msg=...
//   - Better Stack: absence-based — ping on success only; a missed ping alerts.
//   - Custom URL: any ping endpoint. Include {status} (up/down) and/or {message}
//     to signal failures too; without {status} it pings only on success.
// Best-effort; a ping failure never affects the update itself.

export const HEARTBEAT_TYPES = ['healthchecks', 'uptimekuma', 'betterstack', 'custom'];

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

  switch (hb.type) {
    case 'uptimekuma': {
      // Push monitor: always ping; status reflects the run result.
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

    case 'betterstack': {
      // Absence-based: ping on success only; stay silent on failure so the
      // missed heartbeat trips the alert.
      if (!ok) return { ok: true, skipped: true };
      return ping(hb.url, { method: 'POST', body: message });
    }

    case 'custom': {
      // {status} → up/down (ping on both); {message} → url-encoded run message.
      // No {status} placeholder ⇒ pure absence heartbeat: ping on success only.
      if (!hb.url.includes('{status}') && !ok) return { ok: true, skipped: true };
      const url = hb.url
        .replace(/\{status\}/g, ok ? 'up' : 'down')
        .replace(/\{message\}/g, encodeURIComponent(message || ''));
      return ping(url);
    }

    case 'healthchecks':
    default: {
      let url = hb.url.replace(/\/+$/, '');
      if (!ok) url += '/fail';
      return ping(url, { method: 'POST', body: message });
    }
  }
}

// Fire all enabled heartbeats for a completed run.
export async function sendHeartbeats(heartbeats, { ok, message }) {
  const results = [];
  for (const hb of (heartbeats || []).filter((h) => h.enabled && h.url)) {
    results.push({ hb, result: await sendHeartbeat(hb, { ok, message }) });
  }
  return results;
}
