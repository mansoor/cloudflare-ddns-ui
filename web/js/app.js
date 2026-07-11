'use strict';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  // Only advertise a JSON body when we actually send one — otherwise Fastify
  // tries to parse an empty application/json body and returns 400.
  if (options.body != null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff >= 0 && diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff >= 60 && diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return d.toLocaleString();
}

function fmtFuture(iso) {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  if (diff <= 0) return 'due';
  if (diff < 60) return `in ${Math.ceil(diff)}s`;
  if (diff < 3600) return `in ${Math.ceil(diff / 60)}m`;
  return new Date(iso).toLocaleString();
}

const STATUS_STYLES = {
  created: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300',
  updated: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  unchanged: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  deleted: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  disabled: 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
};
const LOG_STYLES = {
  info: 'text-slate-500',
  success: 'text-green-600 dark:text-green-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

// ---------- tabs ----------
function initTabs() {
  const btns = $$('.tab-btn');
  const activate = (name) => {
    btns.forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('border-brand-500', on);
      b.classList.toggle('text-brand-600', on);
      b.classList.toggle('border-transparent', !on);
      b.classList.toggle('text-slate-500', !on);
    });
    ['dashboard', 'zones', 'waf', 'ddns', 'settings'].forEach((t) => {
      const sec = document.getElementById(`tab-${t}`);
      if (sec) sec.classList.toggle('hidden', t !== name);
    });
  };
  btns.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
  activate('dashboard');
}

// ---------- settings rendering ----------
let META = { ip4_providers: [], ip6_providers: [], features: {} };
let PAUSED = false; // last-known scheduler paused state (from /api/status)
let LAST_RECORDS = []; // most recent records, so the filter can re-apply instantly

// Show/hide feature-gated UI (the DDNS tab) based on server flags.
function applyFeatures() {
  const on = Boolean(META.features && META.features.ddns);
  const btn = $('#tab-btn-ddns');
  if (btn) btn.classList.toggle('hidden', !on);
}

function fillProviderSelect(sel, providers, value) {
  sel.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p === 'cloudflare.trace' ? 'Cloudflare (trace)' : p;
    sel.appendChild(opt);
  }
  sel.value = value;
}

function makeSubRow(node, sub = { name: '', proxied: false }) {
  const row = $('#sub-template').content.firstElementChild.cloneNode(true);
  $('.sub-name', row).value = sub.name || '';
  $('.sub-proxied', row).checked = Boolean(sub.proxied);
  $('.sub-name', row).addEventListener('input', () => updateAccountSummary(node));
  $('.sub-remove', row).addEventListener('click', () => {
    row.remove();
    updateAccountSummary(node);
  });
  return row;
}

// Refresh the collapsed-header summary from the row's current field values.
function updateAccountSummary(node) {
  const label = $('.acc-label', node).value.trim();
  const zoneSel = $('.acc-zone', node);
  const zoneOpt = zoneSel.options[zoneSel.selectedIndex];
  const zoneName = zoneOpt && zoneSel.value ? zoneOpt.dataset.name || zoneOpt.textContent : '';
  const subCount = $$('.acc-subs .sub', node).length;
  const hasToken = Boolean($('.acc-token', node).value.trim()) || node.dataset.hasToken === '1';

  $('.acc-summary-title', node).textContent = label || zoneName || 'New zone';

  const metaParts = [];
  metaParts.push(zoneName ? zoneName : 'no zone selected');
  metaParts.push(`${subCount} subdomain${subCount === 1 ? '' : 's'}`);
  $('.acc-summary-meta', node).textContent = metaParts.join(' · ');

  const badge = $('.acc-summary-badge', node);
  badge.textContent = hasToken ? 'token set' : 'no token';
  badge.className =
    'acc-summary-badge badge ' +
    (hasToken
      ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300');

  // Persistent enabled/disabled status badge (like the DDNS cards).
  const enabled = $('.acc-enabled', node).checked;
  const eb = $('.acc-enabled-badge', node);
  eb.textContent = enabled ? 'enabled' : 'disabled';
  eb.className =
    'acc-enabled-badge badge ' +
    (enabled
      ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
      : 'bg-slate-200 text-slate-600 dark:bg-slate-600 dark:text-slate-200');
}

function setCollapsed(node, collapsed) {
  $('.acc-body', node).classList.toggle('hidden', collapsed);
  $('.acc-chevron', node).classList.toggle('rotate-90', !collapsed);
}

function makeAccountRow(acc = {}, { expanded = false } = {}) {
  const node = $('#account-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = acc.id || '';
  $('.acc-label', node).value = acc.label || '';
  const tokenInput = $('.acc-token', node);
  // If a token is already stored, show a placeholder hint but keep the field
  // empty; leaving it empty on save preserves the stored token.
  if (acc.api_token_hint) {
    tokenInput.placeholder = `•••• stored (…${acc.api_token_hint}) — leave blank to keep`;
    node.dataset.hasToken = '1';
  }

  const zoneSel = $('.acc-zone', node);
  if (acc.zone_id) {
    const opt = document.createElement('option');
    opt.value = acc.zone_id;
    opt.textContent = acc.zone_name || acc.zone_id;
    opt.dataset.name = acc.zone_name || '';
    opt.selected = true;
    zoneSel.appendChild(opt);
  }

  $('.acc-enabled', node).checked = acc.enabled !== false; // default on

  const subsWrap = $('.acc-subs', node);
  const subs = acc.subdomains && acc.subdomains.length ? acc.subdomains : [{ name: '', proxied: false }];
  subs.forEach((s) => subsWrap.appendChild(makeSubRow(node, s)));

  // Keep the summary in sync as fields change.
  $('.acc-label', node).addEventListener('input', () => updateAccountSummary(node));
  $('.acc-token', node).addEventListener('input', () => updateAccountSummary(node));
  $('.acc-enabled', node).addEventListener('change', () => updateAccountSummary(node));
  zoneSel.addEventListener('change', () => updateAccountSummary(node));

  $('.acc-add-sub', node).addEventListener('click', () => {
    subsWrap.appendChild(makeSubRow(node));
    updateAccountSummary(node);
  });
  $('.acc-verify', node).addEventListener('click', () => verifyAccount(node));
  $('.acc-save', node).addEventListener('click', () => saveZone(node));
  $('.acc-delete', node).addEventListener('click', () => deleteZone(node));
  $('.acc-update', node).addEventListener('click', (e) => {
    e.stopPropagation(); // don't toggle collapse
    updateZone(node);
  });

  // Header toggles collapse.
  $('.acc-header', node).addEventListener('click', () => {
    setCollapsed(node, !$('.acc-body', node).classList.contains('hidden'));
  });

  setCollapsed(node, !expanded);
  updateAccountSummary(node);
  return node;
}

// Show the empty-state placeholder when there are no zone cards.
function updateAccountsEmpty() {
  const empty = $('#accounts-empty');
  if (empty) empty.classList.toggle('hidden', $$('#accounts .account').length > 0);
}

async function verifyAccount(node) {
  const msg = $('.acc-verify-msg', node);
  const token = $('.acc-token', node).value.trim();
  const accountId = node.dataset.id;
  msg.textContent = 'Verifying…';
  msg.className = 'acc-verify-msg mt-1 text-xs text-slate-500';
  try {
    const body = token ? { token } : { accountId }; // fall back to stored token
    const { zones } = await api('/api/cloudflare/verify', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const zoneSel = $('.acc-zone', node);
    const current = zoneSel.value;
    zoneSel.innerHTML = '<option value="">— select a zone —</option>';
    for (const z of zones) {
      const opt = document.createElement('option');
      opt.value = z.id;
      opt.textContent = z.name;
      opt.dataset.name = z.name;
      zoneSel.appendChild(opt);
    }
    if (current) zoneSel.value = current;
    updateAccountSummary(node);
    msg.textContent = `✓ Token valid — ${zones.length} zone(s) loaded`;
    msg.className = 'acc-verify-msg mt-1 text-xs text-green-600 dark:text-green-400';
  } catch (err) {
    msg.textContent = `✕ ${err.message}`;
    msg.className = 'acc-verify-msg mt-1 text-xs text-red-600 dark:text-red-400';
  }
}

function renderConfig(cfg) {
  const accWrap = $('#accounts');
  // Remember which zones were expanded so a save/re-render doesn't collapse them.
  // Track by id AND zone_id so a freshly-saved new card (which only gets an id
  // from the server) stays open.
  const expandedIds = new Set();
  const expandedZones = new Set();
  $$('#accounts .account').forEach((n) => {
    if ($('.acc-body', n).classList.contains('hidden')) return;
    if (n.dataset.id) expandedIds.add(n.dataset.id);
    const z = $('.acc-zone', n).value;
    if (z) expandedZones.add(z);
  });
  accWrap.innerHTML = '';
  (cfg.cloudflare || []).forEach((acc) =>
    accWrap.appendChild(
      makeAccountRow(acc, { expanded: expandedIds.has(acc.id) || expandedZones.has(acc.zone_id) })
    )
  );
  updateAccountsEmpty();

  $('#opt-a').checked = cfg.a;
  $('#opt-aaaa').checked = cfg.aaaa;
  $('#opt-ttl').value = cfg.ttl;
  $('#opt-interval').value = cfg.update_interval_minutes;
  $('#opt-purge').checked = cfg.purge_unknown_records;

  fillProviderSelect($('#ip4-provider'), META.ip4_providers, cfg.ip4_provider);
  fillProviderSelect($('#ip6-provider'), META.ip6_providers, cfg.ip6_provider);
  $('#ip4-custom').value = cfg.ip4_custom_url || '';
  $('#ip6-custom').value = cfg.ip6_custom_url || '';
  toggleCustom('#ip4-provider', '#ip4-custom');
  toggleCustom('#ip6-provider', '#ip6-custom');

  renderWaf(cfg.waf_lists || []);
  renderNotifications(cfg.notifications || { events: {}, channels: [] });
  renderDdns(cfg.ddns_providers || []);
}

// Re-render WAF cards, preserving which were expanded (by id / list name).
function renderWaf(wafLists) {
  const wrap = $('#waf-lists');
  const expIds = new Set();
  const expNames = new Set();
  $$('#waf-lists .waf-card').forEach((n) => {
    if ($('.acc-body', n).classList.contains('hidden')) return;
    if (n.dataset.id) expIds.add(n.dataset.id);
    if ($('.waf-list', n).value) expNames.add($('.waf-list', n).value);
  });
  wrap.innerHTML = '';
  wafLists.forEach((w) =>
    wrap.appendChild(makeWafRow(w, { expanded: expIds.has(w.id) || expNames.has(w.list_name) }))
  );
  updateWafEmpty();
}

// Re-render notification event toggles + channel cards (preserve expanded).
function renderNotifications(n) {
  $('#notif-failure').checked = n.events?.failure !== false;
  $('#notif-ipchange').checked = n.events?.ip_change !== false;
  $('#notif-success').checked = Boolean(n.events?.success);

  const wrap = $('#channels');
  const expIds = new Set(
    $$('#channels .channel-card')
      .filter((c) => !$('.acc-body', c).classList.contains('hidden'))
      .map((c) => c.dataset.id)
      .filter(Boolean)
  );
  wrap.innerHTML = '';
  (n.channels || []).forEach((c) =>
    wrap.appendChild(makeChannelRow(c, { expanded: expIds.has(c.id) }))
  );
  updateChannelsEmpty();
}

function toggleCustom(selSel, customSel) {
  const isCustom = $(selSel).value === 'custom';
  $(customSel).classList.toggle('hidden', !isCustom);
}

const REDACTED = '__stored__';

function collectConfig() {
  const accounts = $$('#accounts .account').map((node) => {
    const tokenVal = $('.acc-token', node).value.trim();
    const zoneSel = $('.acc-zone', node);
    const zoneOpt = zoneSel.options[zoneSel.selectedIndex];
    const subdomains = $$('.acc-subs .sub', node).map((s) => ({
      name: $('.sub-name', s).value.trim(),
      proxied: $('.sub-proxied', s).checked,
    }));
    return {
      id: node.dataset.id || undefined,
      enabled: $('.acc-enabled', node).checked,
      label: $('.acc-label', node).value.trim(),
      // Empty token but one is stored => send placeholder so server keeps it.
      api_token: tokenVal || (node.dataset.hasToken ? REDACTED : ''),
      zone_id: zoneSel.value,
      zone_name: zoneOpt ? zoneOpt.dataset.name || zoneOpt.textContent : '',
      subdomains,
    };
  });

  return {
    cloudflare: accounts,
    a: $('#opt-a').checked,
    aaaa: $('#opt-aaaa').checked,
    ttl: Number($('#opt-ttl').value) || 300,
    update_interval_minutes: Number($('#opt-interval').value) || 5,
    purge_unknown_records: $('#opt-purge').checked,
    ip4_provider: $('#ip4-provider').value,
    ip4_custom_url: $('#ip4-custom').value.trim(),
    ip6_provider: $('#ip6-provider').value,
    ip6_custom_url: $('#ip6-custom').value.trim(),
    waf_lists: collectWaf(),
    notifications: collectNotifications(),
    ddns_providers: collectDdns(),
  };
}

async function loadConfig() {
  const { config, meta } = await api('/api/config');
  META = meta;
  applyFeatures();
  renderConfig(config);
}

// Set a status message's text + color without disturbing its layout classes.
function setMsg(el, text, kind = 'info') {
  if (!el) return;
  el.textContent = text;
  el.classList.remove(
    'text-slate-500', 'text-green-600', 'dark:text-green-400', 'text-red-600', 'dark:text-red-400'
  );
  const colors = {
    info: ['text-slate-500'],
    ok: ['text-green-600', 'dark:text-green-400'],
    err: ['text-red-600', 'dark:text-red-400'],
  }[kind] || ['text-slate-500'];
  el.classList.add(...colors);
}

// Shared save — the whole config is persisted regardless of which button
// triggered it, since all fields live in the DOM across tabs.
async function saveConfig({ btn, msg, verb = 'Saved' }) {
  if (btn) btn.disabled = true;
  setMsg(msg, 'Saving…', 'info');
  try {
    const { config } = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ config: collectConfig() }),
    });
    renderConfig(config);
    setMsg(msg, `✓ ${verb} — scheduler updated`, 'ok');
    refreshStatus();
  } catch (err) {
    setMsg(msg, `✕ ${err.message}`, 'err');
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => setMsg(msg, '', 'info'), 5000);
  }
}

// Save a single zone card (persists the full config). Requires a selected zone.
async function saveZone(node) {
  const zonesMsg = $('#zones-msg');
  if (!$('.acc-zone', node).value) {
    setMsg(zonesMsg, '✕ Select a zone (verify the token first) before saving.', 'err');
    setTimeout(() => setMsg(zonesMsg, '', 'info'), 5000);
    return;
  }
  await saveConfig({ btn: $('.acc-save', node), msg: zonesMsg, verb: 'Saved zone' });
}

// Run a DNS sync for just this one (saved) zone.
async function updateZone(node) {
  const zonesMsg = $('#zones-msg');
  const id = node.dataset.id;
  if (!id) {
    setMsg(zonesMsg, '✕ Save the zone before updating it.', 'err');
    setTimeout(() => setMsg(zonesMsg, '', 'info'), 5000);
    return;
  }
  const btn = $('.acc-update', node);
  const original = btn.textContent;
  btn.textContent = 'updating…';
  setMsg(zonesMsg, 'Updating zone…', 'info');
  try {
    const res = await api(`/api/zones/${id}/update`, { method: 'POST' });
    const ok = res.result === 'ok';
    setMsg(zonesMsg, `${ok ? '✓' : '⚠'} ${res.message}`, ok ? 'ok' : 'err');
  } catch (err) {
    setMsg(zonesMsg, `✕ ${err.message}`, 'err');
  } finally {
    btn.textContent = original;
    refreshStatus();
    setTimeout(() => setMsg(zonesMsg, '', 'info'), 6000);
  }
}

// Delete a single zone card, then persist the removal.
async function deleteZone(node) {
  const title = ($('.acc-summary-title', node).textContent || 'this zone').trim();
  const ok = await confirmDialog({
    title: 'Delete zone',
    message: `Delete "${title}"? It will be removed from the updater configuration.`,
    confirmLabel: 'Delete zone',
  });
  if (!ok) return;
  node.remove();
  updateAccountsEmpty();
  await saveConfig({ btn: null, msg: $('#zones-msg'), verb: 'Zone deleted' });
}

// ---------- WAF lists ----------
function updateWafEmpty() {
  const empty = $('#waf-empty');
  if (empty) empty.classList.toggle('hidden', $$('#waf-lists .waf-card').length > 0);
}

function updateWafSummary(node) {
  const label = $('.waf-label', node).value.trim();
  const listSel = $('.waf-list', node);
  const listName = listSel.value;
  const account = $('.waf-account', node).value.trim();
  const hasToken = Boolean($('.waf-token', node).value.trim()) || node.dataset.hasToken === '1';

  $('.waf-summary-title', node).textContent = label || listName || 'New list';
  $('.waf-summary-meta', node).textContent =
    `${listName || 'no list selected'} · ${account ? 'acct ' + account.slice(0, 6) + '…' : 'no account'}`;

  const badge = $('.waf-summary-badge', node);
  badge.textContent = hasToken ? 'token set' : 'no token';
  badge.className =
    'waf-summary-badge badge ' +
    (hasToken
      ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300');
}

function makeWafRow(w = {}, { expanded = false } = {}) {
  const node = $('#waf-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = w.id || '';
  $('.waf-label', node).value = w.label || '';
  $('.waf-account', node).value = w.account_id || '';
  $('.waf-comment', node).value = w.item_comment || '';
  const tokenInput = $('.waf-token', node);
  if (w.api_token_hint) {
    tokenInput.placeholder = `•••• stored (…${w.api_token_hint}) — leave blank to keep`;
    node.dataset.hasToken = '1';
  }
  const listSel = $('.waf-list', node);
  if (w.list_name) {
    const opt = document.createElement('option');
    opt.value = w.list_name;
    opt.textContent = w.list_name;
    opt.dataset.listId = w.list_id || '';
    opt.selected = true;
    listSel.appendChild(opt);
  }

  $('.waf-label', node).addEventListener('input', () => updateWafSummary(node));
  $('.waf-token', node).addEventListener('input', () => updateWafSummary(node));
  $('.waf-account', node).addEventListener('input', () => updateWafSummary(node));
  listSel.addEventListener('change', () => updateWafSummary(node));
  $('.waf-verify', node).addEventListener('click', () => verifyWaf(node));
  $('.waf-save', node).addEventListener('click', () => saveWaf(node));
  $('.waf-delete', node).addEventListener('click', () => deleteWaf(node));
  $('.waf-update', node).addEventListener('click', (e) => {
    e.stopPropagation();
    updateWafList(node);
  });
  $('.acc-header', node).addEventListener('click', () => {
    setCollapsed(node, !$('.acc-body', node).classList.contains('hidden'));
  });

  setCollapsed(node, !expanded);
  updateWafSummary(node);
  return node;
}

async function verifyWaf(node) {
  const msg = $('.waf-verify-msg', node);
  const token = $('.waf-token', node).value.trim();
  const accountId = $('.waf-account', node).value.trim();
  if (!accountId) {
    msg.textContent = '✕ Enter the Account ID first';
    msg.className = 'waf-verify-msg mt-1 text-xs text-red-600 dark:text-red-400';
    return;
  }
  msg.textContent = 'Verifying…';
  msg.className = 'waf-verify-msg mt-1 text-xs text-slate-500';
  try {
    const body = token ? { token, accountId } : { wafId: node.dataset.id, accountId };
    const { lists } = await api('/api/waf/verify', { method: 'POST', body: JSON.stringify(body) });
    const listSel = $('.waf-list', node);
    const current = listSel.value;
    listSel.innerHTML = '<option value="">— select a list —</option>';
    for (const l of lists) {
      const opt = document.createElement('option');
      opt.value = l.name;
      opt.textContent = `${l.name} (${l.kind}, ${l.num_items} items)`;
      opt.dataset.listId = l.id;
      listSel.appendChild(opt);
    }
    if (current) listSel.value = current;
    updateWafSummary(node);
    msg.textContent = `✓ Token valid — ${lists.length} list(s) loaded`;
    msg.className = 'waf-verify-msg mt-1 text-xs text-green-600 dark:text-green-400';
  } catch (err) {
    msg.textContent = `✕ ${err.message}`;
    msg.className = 'waf-verify-msg mt-1 text-xs text-red-600 dark:text-red-400';
  }
}

async function saveWaf(node) {
  const wafMsg = $('#waf-msg');
  if (!$('.waf-list', node).value) {
    setMsg(wafMsg, '✕ Verify the token and pick a list before saving.', 'err');
    setTimeout(() => setMsg(wafMsg, '', 'info'), 5000);
    return;
  }
  await saveConfig({ btn: $('.waf-save', node), msg: wafMsg, verb: 'Saved list' });
}

async function deleteWaf(node) {
  const title = ($('.waf-summary-title', node).textContent || 'this list').trim();
  const ok = await confirmDialog({
    title: 'Delete list',
    message: `Delete "${title}"? It will be removed from the updater configuration.`,
    confirmLabel: 'Delete list',
  });
  if (!ok) return;
  node.remove();
  updateWafEmpty();
  await saveConfig({ btn: null, msg: $('#waf-msg'), verb: 'List deleted' });
}

async function updateWafList(node) {
  const wafMsg = $('#waf-msg');
  const id = node.dataset.id;
  if (!id) {
    setMsg(wafMsg, '✕ Save the list before updating it.', 'err');
    setTimeout(() => setMsg(wafMsg, '', 'info'), 5000);
    return;
  }
  const btn = $('.waf-update', node);
  const original = btn.textContent;
  btn.textContent = 'updating…';
  setMsg(wafMsg, 'Updating list…', 'info');
  try {
    const res = await api(`/api/waf/${id}/update`, { method: 'POST' });
    const ok = res.result === 'ok';
    setMsg(wafMsg, `${ok ? '✓' : '⚠'} ${res.message}`, ok ? 'ok' : 'err');
  } catch (err) {
    setMsg(wafMsg, `✕ ${err.message}`, 'err');
  } finally {
    btn.textContent = original;
    refreshStatus();
    setTimeout(() => setMsg(wafMsg, '', 'info'), 6000);
  }
}

function collectWaf() {
  return $$('#waf-lists .waf-card').map((node) => {
    const tokenVal = $('.waf-token', node).value.trim();
    const listSel = $('.waf-list', node);
    const listOpt = listSel.options[listSel.selectedIndex];
    return {
      id: node.dataset.id || undefined,
      label: $('.waf-label', node).value.trim(),
      account_id: $('.waf-account', node).value.trim(),
      list_name: listSel.value,
      list_id: listOpt ? listOpt.dataset.listId || '' : '',
      item_comment: $('.waf-comment', node).value.trim(),
      api_token: tokenVal || (node.dataset.hasToken ? REDACTED : ''),
    };
  });
}

// ---------- notification channels ----------
function updateChannelsEmpty() {
  const empty = $('#channels-empty');
  if (empty) empty.classList.toggle('hidden', $$('#channels .channel-card').length > 0);
}

function toggleChannelFields(node) {
  const type = $('.ch-type', node).value;
  const isWebhook = type === 'webhook';
  $('.ch-field-webhookurl', node).classList.toggle('hidden', isWebhook);
  $('.ch-field-url', node).classList.toggle('hidden', !isWebhook);
  $('.ch-field-format', node).classList.toggle('hidden', !isWebhook);
  $('.ch-field-auth', node).classList.toggle('hidden', !isWebhook);
}

function updateChannelSummary(node) {
  const type = $('.ch-type', node).value;
  const label = $('.ch-label', node).value.trim();
  const enabled = $('.ch-enabled', node).checked;
  $('.ch-summary-title', node).textContent = label || `${type} channel`;
  $('.ch-summary-meta', node).textContent = type;
  const badge = $('.ch-summary-badge', node);
  badge.textContent = enabled ? 'enabled' : 'disabled';
  badge.className =
    'ch-summary-badge badge ' +
    (enabled
      ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
      : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300');
}

function makeChannelRow(c = {}, { expanded = false } = {}) {
  const node = $('#channel-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = c.id || '';
  $('.ch-type', node).value = c.type || 'discord';
  $('.ch-label', node).value = c.label || '';
  $('.ch-enabled', node).checked = c.enabled !== false;
  $('.ch-url', node).value = c.url || '';
  $('.ch-format', node).value = c.format === 'text' ? 'text' : 'json';

  const whInput = $('.ch-webhook-url', node);
  if (c.webhook_url_hint) {
    whInput.placeholder = `•••• stored (…${c.webhook_url_hint}) — leave blank to keep`;
    node.dataset.hasWebhook = '1';
  }
  const authInput = $('.ch-auth', node);
  if (c.auth_header_set) {
    authInput.placeholder = '•••• stored — leave blank to keep';
    node.dataset.hasAuth = '1';
  }

  $('.ch-type', node).addEventListener('change', () => {
    toggleChannelFields(node);
    updateChannelSummary(node);
  });
  $('.ch-label', node).addEventListener('input', () => updateChannelSummary(node));
  $('.ch-enabled', node).addEventListener('change', () => updateChannelSummary(node));
  $('.ch-save', node).addEventListener('click', () => saveChannel(node));
  $('.ch-delete', node).addEventListener('click', () => deleteChannel(node));
  $('.ch-test', node).addEventListener('click', () => testChannel(node));
  $('.acc-header', node).addEventListener('click', () => {
    setCollapsed(node, !$('.acc-body', node).classList.contains('hidden'));
  });

  toggleChannelFields(node);
  setCollapsed(node, !expanded);
  updateChannelSummary(node);
  return node;
}

async function saveChannel(node) {
  await saveConfig({ btn: $('.ch-save', node), msg: $('#save-msg'), verb: 'Saved channel' });
}

async function deleteChannel(node) {
  const title = ($('.ch-summary-title', node).textContent || 'this channel').trim();
  const ok = await confirmDialog({
    title: 'Delete channel',
    message: `Delete "${title}"? You'll stop receiving notifications on it.`,
    confirmLabel: 'Delete channel',
  });
  if (!ok) return;
  node.remove();
  updateChannelsEmpty();
  await saveConfig({ btn: null, msg: $('#save-msg'), verb: 'Channel deleted' });
}

// Test a channel. Must be saved first (server sends through the stored config).
async function testChannel(node) {
  const msg = $('.ch-msg', node);
  const id = node.dataset.id;
  if (!id) {
    msg.textContent = 'Save the channel first';
    msg.className = 'ch-msg text-xs text-red-600 dark:text-red-400';
    setTimeout(() => (msg.textContent = ''), 5000);
    return;
  }
  msg.textContent = 'Sending…';
  msg.className = 'ch-msg text-xs text-slate-500';
  try {
    await api('/api/notifications/test', { method: 'POST', body: JSON.stringify({ channelId: id }) });
    msg.textContent = '✓ Sent';
    msg.className = 'ch-msg text-xs text-green-600 dark:text-green-400';
  } catch (err) {
    msg.textContent = `✕ ${err.message}`;
    msg.className = 'ch-msg text-xs text-red-600 dark:text-red-400';
  } finally {
    setTimeout(() => (msg.textContent = ''), 6000);
  }
}

function collectNotifications() {
  const channels = $$('#channels .channel-card').map((node) => {
    const whVal = $('.ch-webhook-url', node).value.trim();
    const authVal = $('.ch-auth', node).value.trim();
    return {
      id: node.dataset.id || undefined,
      type: $('.ch-type', node).value,
      enabled: $('.ch-enabled', node).checked,
      label: $('.ch-label', node).value.trim(),
      webhook_url: whVal || (node.dataset.hasWebhook ? REDACTED : ''),
      url: $('.ch-url', node).value.trim(),
      format: $('.ch-format', node).value,
      auth_header: authVal || (node.dataset.hasAuth ? REDACTED : ''),
    };
  });
  return {
    events: {
      failure: $('#notif-failure').checked,
      ip_change: $('#notif-ipchange').checked,
      success: $('#notif-success').checked,
    },
    channels,
  };
}

// ---------- DDNS providers (opt-in) ----------
function updateDdnsEmpty() {
  const empty = $('#ddns-empty');
  if (empty) empty.classList.toggle('hidden', $$('#ddns-list .ddns-card').length > 0);
}

function toggleDdnsFields(node) {
  const type = $('.ddns-type', node).value;
  const method = $('.ddns-fd-method', node).value;
  $$('.ddns-field', node).forEach((el) => {
    let show;
    if (type === 'freedns') {
      // FreeDNS visibility depends on the chosen method.
      if (el.classList.contains('ddns-fd-tokenrows')) show = method === 'token';
      else if (el.classList.contains('ddns-fd-userpass')) show = method === 'userpass';
      else show = el.classList.contains('ddns-f-freedns'); // the method selector
    } else {
      show = el.classList.contains(`ddns-f-${type}`);
    }
    el.classList.toggle('hidden', !show);
  });
}

// One FreeDNS update token/URL row.
function makeDdnsUrlRow(node, value = '') {
  const row = $('#ddns-url-template').content.firstElementChild.cloneNode(true);
  $('.ddns-url', row).value = value;
  $('.ddns-url-remove', row).addEventListener('click', () => row.remove());
  return row;
}

function updateDdnsSummary(node) {
  const type = $('.ddns-type', node).value;
  const method = $('.ddns-fd-method', node).value;
  const hostname = $('.ddns-hostname', node).value.trim();
  const domains = $('.ddns-domains', node).value.trim();
  const label = $('.ddns-label', node).value.trim();
  const host =
    type === 'dyndns2'
      ? hostname
      : type === 'freedns'
      ? method === 'userpass'
        ? hostname
        : label
      : domains;
  const enabled = $('.ddns-enabled', node).checked;
  const typeName = type === 'dyndns2' ? 'DynDNS2' : type === 'freedns' ? 'FreeDNS' : 'DuckDNS';
  $('.ddns-summary-title', node).textContent = label || host || 'New provider';
  $('.ddns-summary-meta', node).textContent = `${typeName} · ${host || 'not configured'}`;
  const badge = $('.ddns-summary-badge', node);
  badge.textContent = enabled ? 'enabled' : 'disabled';
  badge.className =
    'ddns-summary-badge badge ' +
    (enabled
      ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
      : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300');
}

function makeDdnsRow(p = {}, { expanded = false } = {}) {
  const node = $('#ddns-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = p.id || '';
  $('.ddns-type', node).value = p.type || 'duckdns';
  $('.ddns-label', node).value = p.label || '';
  $('.ddns-enabled', node).checked = p.enabled !== false;
  $('.ddns-domains', node).value = p.domains || '';
  $('.ddns-server', node).value = p.server || '';
  $('.ddns-hostname', node).value = p.hostname || '';
  $('.ddns-username', node).value = p.username || '';
  $('.ddns-https', node).checked = p.https !== false;
  $('.ddns-fd-method', node).value = p.method === 'userpass' ? 'userpass' : 'token';

  // FreeDNS update-URL rows (start with one empty row).
  const urlsWrap = $('.ddns-urls', node);
  const urls = p.urls && p.urls.length ? p.urls : [''];
  urls.forEach((u) => urlsWrap.appendChild(makeDdnsUrlRow(node, u)));

  const tokenInput = $('.ddns-token', node);
  if (p.token_hint) {
    tokenInput.placeholder = `•••• stored (…${p.token_hint}) — leave blank to keep`;
    node.dataset.hasToken = '1';
  }
  const pwInput = $('.ddns-password', node);
  if (p.password_set) {
    pwInput.placeholder = '•••• stored — leave blank to keep';
    node.dataset.hasPassword = '1';
  }

  $('.ddns-type', node).addEventListener('change', () => {
    toggleDdnsFields(node);
    updateDdnsSummary(node);
  });
  $('.ddns-fd-method', node).addEventListener('change', () => {
    toggleDdnsFields(node);
    updateDdnsSummary(node);
  });
  $('.ddns-add-url', node).addEventListener('click', () =>
    $('.ddns-urls', node).appendChild(makeDdnsUrlRow(node))
  );
  ['.ddns-label', '.ddns-domains', '.ddns-hostname'].forEach((sel) =>
    $(sel, node).addEventListener('input', () => updateDdnsSummary(node))
  );
  $('.ddns-enabled', node).addEventListener('change', () => updateDdnsSummary(node));
  $('.ddns-save', node).addEventListener('click', () => saveDdns(node));
  $('.ddns-delete', node).addEventListener('click', () => deleteDdns(node));
  $('.ddns-test', node).addEventListener('click', () => testDdns(node));
  $('.ddns-update', node).addEventListener('click', (e) => {
    e.stopPropagation();
    updateDdns(node);
  });
  $('.acc-header', node).addEventListener('click', () => {
    setCollapsed(node, !$('.acc-body', node).classList.contains('hidden'));
  });

  toggleDdnsFields(node);
  setCollapsed(node, !expanded);
  updateDdnsSummary(node);
  return node;
}

// Build one provider object from a card (secrets: placeholder if stored+blank).
function collectOneDdns(node) {
  const tokenVal = $('.ddns-token', node).value.trim();
  const pwVal = $('.ddns-password', node).value.trim();
  return {
    id: node.dataset.id || undefined,
    type: $('.ddns-type', node).value,
    enabled: $('.ddns-enabled', node).checked,
    label: $('.ddns-label', node).value.trim(),
    domains: $('.ddns-domains', node).value.trim(),
    token: tokenVal || (node.dataset.hasToken ? REDACTED : ''),
    method: $('.ddns-fd-method', node).value,
    urls: $$('.ddns-urls .ddns-url', node).map((i) => i.value.trim()).filter(Boolean),
    server: $('.ddns-server', node).value.trim(),
    hostname: $('.ddns-hostname', node).value.trim(),
    username: $('.ddns-username', node).value.trim(),
    password: pwVal || (node.dataset.hasPassword ? REDACTED : ''),
    https: $('.ddns-https', node).checked,
  };
}

function collectDdns() {
  return $$('#ddns-list .ddns-card').map(collectOneDdns);
}

function ddnsMissingField(node) {
  const type = $('.ddns-type', node).value;
  if (type === 'duckdns') {
    if (!$('.ddns-domains', node).value.trim()) return 'Enter the DuckDNS domain(s).';
  } else if (type === 'freedns') {
    if ($('.ddns-fd-method', node).value === 'userpass') {
      if (!$('.ddns-hostname', node).value.trim()) return 'Enter the hostname.';
      if (!$('.ddns-username', node).value.trim()) return 'Enter the username.';
      if (!$('.ddns-password', node).value.trim() && node.dataset.hasPassword !== '1')
        return 'Enter the password.';
    } else {
      const urls = $$('.ddns-urls .ddns-url', node).map((i) => i.value.trim()).filter(Boolean);
      if (!urls.length) return 'Add at least one FreeDNS update token or URL.';
    }
  } else {
    if (!$('.ddns-server', node).value.trim()) return 'Enter the DynDNS2 server host.';
    if (!$('.ddns-hostname', node).value.trim()) return 'Enter the hostname.';
    if (!$('.ddns-username', node).value.trim()) return 'Enter the username.';
  }
  return null;
}

async function saveDdns(node) {
  const msg = $('#ddns-msg');
  const missing = ddnsMissingField(node);
  if (missing) {
    setMsg(msg, `✕ ${missing}`, 'err');
    setTimeout(() => setMsg(msg, '', 'info'), 5000);
    return;
  }
  await saveConfig({ btn: $('.ddns-save', node), msg, verb: 'Saved provider' });
}

async function deleteDdns(node) {
  const title = ($('.ddns-summary-title', node).textContent || 'this provider').trim();
  const ok = await confirmDialog({
    title: 'Delete provider',
    message: `Delete "${title}"? It will stop being updated.`,
    confirmLabel: 'Delete provider',
  });
  if (!ok) return;
  node.remove();
  updateDdnsEmpty();
  await saveConfig({ btn: null, msg: $('#ddns-msg'), verb: 'Provider deleted' });
}

async function testDdns(node) {
  const msg = $('.ddns-verify-msg', node);
  const missing = ddnsMissingField(node);
  if (missing) {
    msg.textContent = `✕ ${missing}`;
    msg.className = 'ddns-verify-msg sm:col-span-2 text-xs text-red-600 dark:text-red-400';
    return;
  }
  msg.textContent = 'Testing…';
  msg.className = 'ddns-verify-msg sm:col-span-2 text-xs text-slate-500';
  try {
    const res = await api('/api/ddns/verify', {
      method: 'POST',
      body: JSON.stringify({ provider: collectOneDdns(node) }),
    });
    msg.textContent = `✓ ${res.detail || 'Provider responded OK'}`;
    msg.className = 'ddns-verify-msg sm:col-span-2 text-xs text-green-600 dark:text-green-400';
  } catch (err) {
    msg.textContent = `✕ ${err.message}`;
    msg.className = 'ddns-verify-msg sm:col-span-2 text-xs text-red-600 dark:text-red-400';
  }
}

async function updateDdns(node) {
  const msg = $('#ddns-msg');
  const id = node.dataset.id;
  if (!id) {
    setMsg(msg, '✕ Save the provider before updating it.', 'err');
    setTimeout(() => setMsg(msg, '', 'info'), 5000);
    return;
  }
  const btn = $('.ddns-update', node);
  const original = btn.textContent;
  btn.textContent = 'updating…';
  setMsg(msg, 'Updating provider…', 'info');
  try {
    const res = await api(`/api/ddns/${id}/update`, { method: 'POST' });
    const ok = res.result === 'ok';
    setMsg(msg, `${ok ? '✓' : '⚠'} ${res.message}`, ok ? 'ok' : 'err');
  } catch (err) {
    setMsg(msg, `✕ ${err.message}`, 'err');
  } finally {
    btn.textContent = original;
    refreshStatus();
    setTimeout(() => setMsg(msg, '', 'info'), 6000);
  }
}

// Re-render DDNS cards, preserving which were expanded (by id).
function renderDdns(providers) {
  const wrap = $('#ddns-list');
  if (!wrap) return;
  const expIds = new Set(
    $$('#ddns-list .ddns-card')
      .filter((n) => !$('.acc-body', n).classList.contains('hidden'))
      .map((n) => n.dataset.id)
      .filter(Boolean)
  );
  wrap.innerHTML = '';
  (providers || []).forEach((p) => wrap.appendChild(makeDdnsRow(p, { expanded: expIds.has(p.id) })));
  updateDdnsEmpty();
}

// ---------- dashboard ----------
function renderStatus(s) {
  $('#stat-ipv4').textContent = s.currentIPv4 || '—';
  $('#stat-ipv6').textContent = s.currentIPv6 || '—';
  $('#stat-last').textContent = fmtTime(s.lastRunAt);
  const resultEl = $('#stat-last-result');
  resultEl.textContent = s.lastRunMessage || '';
  resultEl.className =
    'text-xs ' +
    (s.lastRunResult === 'ok'
      ? 'text-green-600'
      : s.lastRunResult === 'error'
      ? 'text-red-600'
      : s.lastRunResult === 'partial'
      ? 'text-amber-600'
      : 'text-slate-500');
  $('#stat-next').textContent = s.paused ? 'paused' : s.schedulerActive ? fmtFuture(s.nextRunAt) : '—';
  $('#stat-interval').textContent = s.intervalMinutes ? `every ${s.intervalMinutes} min` : '';

  const badge = $('#scheduler-badge');
  const badgeState = s.paused ? 'paused' : s.schedulerActive ? 'on' : 'off';
  badge.textContent = `Scheduler: ${badgeState}`;
  badge.className =
    'badge ' +
    (s.paused
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300'
      : s.schedulerActive
      ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
      : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300');

  // Pause/resume toggle reflects the current state.
  PAUSED = Boolean(s.paused);
  const pauseBtn = $('#pause-toggle');
  if (pauseBtn) pauseBtn.textContent = PAUSED ? 'Resume scheduler' : 'Pause scheduler';

  // records table (filtered by the header search box)
  LAST_RECORDS = s.records || [];
  renderRecords(LAST_RECORDS);
}

// Catch-all filter: matches the query against name / type / status / detail / proxied.
function recordMatchesFilter(r, q) {
  if (!q) return true;
  const hay = `${r.fqdn} ${r.type} ${r.status} ${r.detail || ''} ${r.proxied ? 'proxied' : ''}`.toLowerCase();
  return hay.includes(q);
}

// Statuses whose checkbox is unchecked in the Status dropdown (hidden).
function hiddenStatuses() {
  return new Set(
    $$('#status-filter-menu .status-opt')
      .filter((c) => !c.checked)
      .map((c) => c.value)
  );
}

function renderRecords(records) {
  const body = $('#records-body');
  const q = ($('#records-filter')?.value || '').trim().toLowerCase();
  const hidden = hiddenStatuses();
  if (!records || !records.length) {
    body.innerHTML =
      '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">No records yet — run an update.</td></tr>';
    return;
  }
  const rows = records.filter((r) => !hidden.has(r.status) && recordMatchesFilter(r, q));
  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">No records match the current filter.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((r) => {
      const style = STATUS_STYLES[r.status] || STATUS_STYLES.unchanged;
      return `<tr>
          <td class="px-4 py-2 font-mono">${esc(r.fqdn)}</td>
          <td class="px-4 py-2">${esc(r.type)}</td>
          <td class="px-4 py-2">${r.proxied ? '🟠 yes' : 'no'}</td>
          <td class="px-4 py-2"><span class="badge ${style}">${esc(r.status)}</span></td>
          <td class="px-4 py-2 text-slate-500">${esc(r.detail || '')}</td>
        </tr>`;
    })
    .join('');
}

function renderLog(log) {
  const wrap = $('#log-list');
  if (!log || !log.length) {
    wrap.innerHTML = '<div class="px-4 py-6 text-center text-slate-400">No activity yet.</div>';
    return;
  }
  wrap.innerHTML = log
    .map((e) => {
      const t = new Date(e.at).toLocaleTimeString();
      const style = LOG_STYLES[e.level] || LOG_STYLES.info;
      return `<div class="flex gap-3 px-4 py-1.5">
        <span class="shrink-0 text-slate-400">${t}</span>
        <span class="${style}">${esc(e.message)}</span>
      </div>`;
    })
    .join('');
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    renderStatus(s);
    renderLog(s.log);
  } catch (err) {
    /* ignore transient errors */
  }
}

async function updateNow() {
  const btn = $('#update-now');
  const label = $('#update-now-label');
  const msg = $('#run-msg');
  btn.disabled = true;
  label.textContent = 'Updating…';
  msg.textContent = '';
  try {
    const res = await api('/api/update-now', { method: 'POST' });
    msg.textContent = res.message || 'Done';
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    label.textContent = 'Update now';
    refreshStatus();
  }
}

async function togglePause() {
  const btn = $('#pause-toggle');
  const next = !PAUSED;
  btn.disabled = true;
  btn.textContent = next ? 'Pausing…' : 'Resuming…';
  try {
    await api('/api/scheduler', { method: 'POST', body: JSON.stringify({ paused: next }) });
  } catch (err) {
    $('#run-msg').textContent = err.message;
  } finally {
    btn.disabled = false;
    await refreshStatus(); // updates PAUSED + button label
  }
}

// ---------- custom confirm dialog ----------
function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const okBtn = $('#confirm-ok');
    const cancelBtn = $('#confirm-cancel');
    okBtn.textContent = confirmLabel;
    okBtn.className = danger ? 'btn-danger' : 'btn-primary';

    modal.classList.remove('hidden');
    modal.classList.add('flex');

    function close(val) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    }
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e) => {
      if (e.target === modal) close(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}

// ---------- theme (light / dark / system) ----------
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(pref) {
  try {
    localStorage.setItem('theme', pref);
  } catch (e) {}
  const dark = pref === 'dark' || (pref === 'system' && prefersDark.matches);
  document.documentElement.classList.toggle('dark', dark);
  // Reflect the active choice in the segmented control.
  $$('#theme-toggle .theme-btn').forEach((b) => {
    const on = b.dataset.theme === pref;
    b.classList.toggle('bg-white', on);
    b.classList.toggle('text-slate-900', on);
    b.classList.toggle('shadow-sm', on);
    b.classList.toggle('dark:bg-slate-700', on);
    b.classList.toggle('dark:text-white', on);
  });
}

function initTheme() {
  let pref = 'system';
  try {
    pref = localStorage.getItem('theme') || 'system';
  } catch (e) {}
  applyTheme(pref);
  $$('#theme-toggle .theme-btn').forEach((b) =>
    b.addEventListener('click', () => applyTheme(b.dataset.theme))
  );
  // Follow the OS when on "system".
  prefersDark.addEventListener('change', () => {
    let cur = 'system';
    try {
      cur = localStorage.getItem('theme') || 'system';
    } catch (e) {}
    if (cur === 'system') applyTheme('system');
  });
}

// ---------- init ----------
async function init() {
  initTheme();
  initTabs();

  try {
    const me = await api('/api/me');
    const label = $('#user-label');
    label.textContent = me.user;
    label.classList.remove('hidden');
  } catch {
    return; // redirected to login
  }

  $('#logout-btn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });
  $('#add-account').addEventListener('click', () => {
    $('#accounts').appendChild(makeAccountRow({}, { expanded: true }));
    updateAccountsEmpty();
  });
  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveConfig({ btn: $('#save-btn'), msg: $('#save-msg') });
  });
  $('#add-waf').addEventListener('click', () => {
    $('#waf-lists').appendChild(makeWafRow({}, { expanded: true }));
    updateWafEmpty();
  });
  $('#add-channel').addEventListener('click', () => {
    $('#channels').appendChild(makeChannelRow({}, { expanded: true }));
    updateChannelsEmpty();
  });
  $('#add-ddns').addEventListener('click', () => {
    $('#ddns-list').appendChild(makeDdnsRow({}, { expanded: true }));
    updateDdnsEmpty();
  });
  $('#update-now').addEventListener('click', updateNow);
  $('#pause-toggle').addEventListener('click', togglePause);
  $('#records-filter').addEventListener('input', () => renderRecords(LAST_RECORDS));
  // Status filter dropdown
  const statusMenu = $('#status-filter-menu');
  $('#status-filter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    statusMenu.classList.toggle('hidden');
  });
  statusMenu.addEventListener('click', (e) => e.stopPropagation());
  $$('#status-filter-menu .status-opt').forEach((c) =>
    c.addEventListener('change', () => renderRecords(LAST_RECORDS))
  );
  document.addEventListener('click', () => statusMenu.classList.add('hidden'));
  $('#ip4-provider').addEventListener('change', () => toggleCustom('#ip4-provider', '#ip4-custom'));
  $('#ip6-provider').addEventListener('change', () => toggleCustom('#ip6-provider', '#ip6-custom'));

  await loadConfig();
  await refreshStatus();
  setInterval(refreshStatus, 5000);
}

init();
