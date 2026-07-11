// Notification senders. Native REST — no third-party library. Each sender
// returns { ok: boolean, error?: string } and never throws.

async function post(url, { body, headers = {}, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', body, headers, signal: ctrl.signal });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `HTTP ${res.status}${text ? `: ${text}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(t);
  }
}

// Parse an "Header-Name: value" string into a headers object entry.
function parseAuthHeader(str) {
  const s = String(str || '').trim();
  if (!s) return {};
  const idx = s.indexOf(':');
  if (idx === -1) return { Authorization: s }; // bare value → Authorization
  const name = s.slice(0, idx).trim();
  const value = s.slice(idx + 1).trim();
  return name ? { [name]: value } : {};
}

/**
 * Send a notification through one channel.
 * @param {object} channel  { type, webhook_url, url, format, auth_header, label }
 * @param {object} payload  { event, title, message, ipv4, ipv6 }
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function sendNotification(channel, payload) {
  const { title, message } = payload;
  try {
    switch (channel.type) {
      case 'discord': {
        if (!channel.webhook_url) return { ok: false, error: 'no webhook URL' };
        return post(channel.webhook_url, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `**${title}**\n${message}` }),
        });
      }
      case 'slack': {
        if (!channel.webhook_url) return { ok: false, error: 'no webhook URL' };
        return post(channel.webhook_url, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `*${title}*\n${message}` }),
        });
      }
      case 'webhook': {
        if (!channel.url) return { ok: false, error: 'no URL' };
        const auth = parseAuthHeader(channel.auth_header);
        if (channel.format === 'text') {
          // Plain-text body — ntfy-style. Title carried in a header.
          return post(channel.url, {
            headers: { 'Content-Type': 'text/plain', Title: title, ...auth },
            body: message,
          });
        }
        return post(channel.url, {
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify({
            event: payload.event,
            title,
            message,
            ipv4: payload.ipv4 ?? null,
            ipv6: payload.ipv6 ?? null,
            timestamp: new Date().toISOString(),
          }),
        });
      }
      default:
        return { ok: false, error: `unknown channel type: ${channel.type}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Fan out one payload to every enabled channel. Returns per-channel results.
export async function notifyAll(channels, payload) {
  const enabled = (channels || []).filter((c) => c.enabled);
  const results = await Promise.allSettled(
    enabled.map((c) => sendNotification(c, payload))
  );
  return enabled.map((c, i) => ({
    channel: c,
    result: results[i].status === 'fulfilled' ? results[i].value : { ok: false, error: 'crashed' },
  }));
}
