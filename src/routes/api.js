import {
  loadConfig,
  saveConfig,
  redactConfig,
  mergeIncomingConfig,
  IP_PROVIDERS_V4,
  IP_PROVIDERS_V6,
} from '../config.js';
import { listZones, listAccountLists } from '../cloudflare.js';
import { getState } from '../state.js';
import { enabledTargetFqdns, reconcileRecords } from '../updater.js';
import { applySchedule, setPaused, triggerNow } from '../scheduler.js';
import { REDACTED_TOKEN } from '../config.js';
import { sendNotification } from '../notify.js';
import { updateDdnsProvider } from '../ddns.js';
import { features } from '../features.js';
import { getVersionInfo } from '../version.js';

export default async function apiRoutes(app) {
  // --- Auth ---
  app.post('/api/login', async (req, reply) => {
    const { username, password } = req.body || {};
    if (!app.verifyCredentials(username, password)) {
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    req.session.set('user', username);
    return { ok: true, username };
  });

  app.post('/api/logout', async (req) => {
    req.session.delete();
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const user = req.session.get('user');
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return { user };
  });

  // Everything below requires a valid session.
  const auth = { preHandler: app.requireAuth };

  // --- Config ---
  app.get('/api/config', auth, async () => {
    const cfg = await loadConfig();
    return {
      config: redactConfig(cfg),
      meta: { ip4_providers: IP_PROVIDERS_V4, ip6_providers: IP_PROVIDERS_V6, features },
    };
  });

  app.put('/api/config', auth, async (req, reply) => {
    const incoming = req.body?.config ?? req.body;
    if (!incoming || typeof incoming !== 'object') {
      return reply.code(400).send({ error: 'invalid config payload' });
    }
    const existing = await loadConfig();
    const merged = mergeIncomingConfig(existing, incoming);
    await saveConfig(merged);
    applySchedule(merged);
    // Rebuild the managed list right away: keep last-sync rows for enabled
    // targets, mark disabled ones "disabled", and drop anything removed.
    const before = enabledTargetFqdns(existing);
    const after = enabledTargetFqdns(merged);
    reconcileRecords(merged);
    // If a target was (re-)enabled or added, refresh in the background so its
    // rows repopulate with real status instead of waiting for the next run.
    const hasNewTarget = [...after].some((f) => !before.has(f));
    if (hasNewTarget && !merged.scheduler_paused) triggerNow().catch(() => {});
    return { ok: true, config: redactConfig(merged) };
  });

  // --- Cloudflare token verify + zone listing ---
  app.post('/api/cloudflare/verify', auth, async (req, reply) => {
    let { token, accountId } = req.body || {};
    // If the client sent the redacted placeholder, use the stored token for
    // the referenced account instead of leaking it to the browser.
    if (!token || token === REDACTED_TOKEN) {
      const cfg = await loadConfig();
      const acc = cfg.cloudflare.find((a) => a.id === accountId);
      token = acc?.api_token;
    }
    if (!token) return reply.code(400).send({ error: 'No API token provided' });
    try {
      const zones = await listZones(token);
      return { ok: true, zones };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // --- Status / logs ---
  app.get('/api/status', auth, async () => getState());

  app.get('/api/logs', auth, async () => ({ log: getState().log }));

  // --- Version + update check (for the footer) ---
  app.get('/api/version', auth, async () => getVersionInfo());

  // --- Manual trigger (all zones + WAF lists) ---
  app.post('/api/update-now', auth, async () => {
    return triggerNow();
  });

  // --- Manual trigger for a single zone ---
  app.post('/api/zones/:id/update', auth, async (req) => {
    return triggerNow({ accountId: req.params.id });
  });

  // --- WAF: verify a token + list the account's IP lists ---
  app.post('/api/waf/verify', auth, async (req, reply) => {
    let { token, accountId, wafId } = req.body || {};
    if (!token || token === REDACTED_TOKEN) {
      const cfg = await loadConfig();
      const w = cfg.waf_lists.find((x) => x.id === wafId);
      token = w?.api_token;
      if (!accountId) accountId = w?.account_id;
    }
    if (!token) return reply.code(400).send({ error: 'No API token provided' });
    if (!accountId) return reply.code(400).send({ error: 'No account ID provided' });
    try {
      const lists = await listAccountLists(token, accountId);
      return { ok: true, lists };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // --- WAF: sync a single list now ---
  app.post('/api/waf/:id/update', auth, async (req) => {
    return triggerNow({ wafId: req.params.id });
  });

  // --- Notifications: send a test message through a stored channel ---
  app.post('/api/notifications/test', auth, async (req, reply) => {
    const { channelId } = req.body || {};
    const cfg = await loadConfig();
    const channel = cfg.notifications.channels.find((c) => c.id === channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found — save it first' });
    const res = await sendNotification(channel, {
      event: 'test',
      title: 'Cloudflare DDNS UI — test',
      message: 'This is a test notification. If you can read this, the channel works. ✅',
      ipv4: getState().currentIPv4,
      ipv6: getState().currentIPv6,
    });
    return res.ok ? { ok: true } : reply.code(400).send({ error: res.error });
  });

  // --- Non-Cloudflare DDNS (opt-in) ---
  // Test a provider by performing an update with the current detected IPs.
  app.post('/api/ddns/verify', auth, async (req, reply) => {
    if (!features.ddns) return reply.code(404).send({ error: 'DDNS providers are disabled' });
    const incoming = req.body?.provider || {};
    const cfg = await loadConfig();
    const stored = cfg.ddns_providers.find((p) => p.id === incoming.id);
    // Restore any redacted secrets from the stored provider.
    const provider = {
      ...incoming,
      token: !incoming.token || incoming.token === REDACTED_TOKEN ? stored?.token || '' : incoming.token,
      password:
        !incoming.password || incoming.password === REDACTED_TOKEN
          ? stored?.password || ''
          : incoming.password,
    };
    const st = getState();
    const res = await updateDdnsProvider(provider, {
      ipv4: st.currentIPv4 || null,
      ipv6: st.currentIPv6 || null,
    });
    return res.ok ? { ok: true, status: res.status, detail: res.detail } : reply.code(400).send({ error: res.detail });
  });

  // Sync a single DDNS provider now.
  app.post('/api/ddns/:id/update', auth, async (req, reply) => {
    if (!features.ddns) return reply.code(404).send({ error: 'DDNS providers are disabled' });
    return triggerNow({ ddnsId: req.params.id });
  });

  // --- Pause / resume the scheduler ---
  app.post('/api/scheduler', auth, async (req, reply) => {
    const paused = req.body?.paused;
    if (typeof paused !== 'boolean') {
      return reply.code(400).send({ error: 'body must include a boolean "paused"' });
    }
    const result = await setPaused(paused);
    return { ok: true, ...result };
  });
}
