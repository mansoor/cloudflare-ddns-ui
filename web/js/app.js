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
  btns.forEach((b) =>
    b.addEventListener('click', () => {
      activate(b.dataset.tab);
      setNavOpen(false); // close the mobile drawer after choosing a tab
    })
  );
  activate('dashboard');

  // Mobile hamburger slides the nav drawer in/out; backdrop closes it.
  const toggle = $('#nav-toggle');
  const backdrop = $('#nav-backdrop');
  if (toggle) {
    toggle.addEventListener('click', () =>
      setNavOpen(!$('#nav-menu').classList.contains('nav-open'))
    );
  }
  if (backdrop) backdrop.addEventListener('click', () => setNavOpen(false));
}

// Open/close the mobile slide-out nav. No visual effect on desktop, where the
// drawer's transform only applies under the max-width media query.
function setNavOpen(open) {
  const menu = $('#nav-menu');
  const backdrop = $('#nav-backdrop');
  const toggle = $('#nav-toggle');
  if (menu) menu.classList.toggle('nav-open', open);
  if (backdrop) backdrop.classList.toggle('hidden', !open);
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
}

// ---------- settings rendering ----------
let META = { ip4_providers: [], ip6_providers: [], interfaces: [], features: {} };
let PAUSED = false; // last-known scheduler paused state (from /api/status)
let LAST_RECORDS = []; // most recent records, so the filter can re-apply instantly

// Show/hide feature-gated UI (the DDNS tab) based on server flags.
function applyFeatures() {
  const on = Boolean(META.features && META.features.ddns);
  const btn = $('#tab-btn-ddns');
  if (btn) btn.classList.toggle('hidden', !on);
  // The DDNS force-update default only means anything with the feature on.
  const forceField = $('#ddns-force-default-field');
  if (forceField) forceField.classList.toggle('hidden', !on);
}

const PROVIDER_LABELS = {
  'cloudflare.trace': 'Cloudflare (trace)',
  'cloudflare.doh': 'Cloudflare (DoH)',
  ipify: 'ipify',
  local: 'This machine (local)',
  literal: 'Static IP',
  custom: 'Custom URL',
  none: 'Off',
};

function fillProviderSelect(sel, providers, value) {
  sel.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = PROVIDER_LABELS[p] || p;
    sel.appendChild(opt);
  }
  sel.value = value;
}

// Interface picker for the "local" provider: "Auto (default route)" + each
// interface that has an address of the right family.
function fillIfaceSelect(sel, version, value) {
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Auto (default route)';
  sel.appendChild(auto);
  for (const ifc of META.interfaces || []) {
    const addr = (ifc.addresses || []).find((a) => a.family === version);
    if (!addr) continue;
    const opt = document.createElement('option');
    opt.value = ifc.name;
    opt.textContent = `${ifc.name} (${addr.address})`;
    sel.appendChild(opt);
  }
  // Keep a saved interface selectable even if it's not currently present.
  if (value && !Array.from(sel.options).some((o) => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = `${value} (not found)`;
    sel.appendChild(opt);
  }
  sel.value = value || '';
}

function makeSubRow(node, sub = { name: '', proxied: false }) {
  const row = $('#sub-template').content.firstElementChild.cloneNode(true);
  $('.sub-name', row).value = sub.name || '';
  $('.sub-proxied', row).checked = Boolean(sub.proxied);
  $('.sub-a', row).checked = sub.a !== false;
  $('.sub-aaaa', row).checked = sub.aaaa !== false;
  $('.sub-name', row).addEventListener('input', () => updateAccountSummary(node));
  $('.sub-remove', row).addEventListener('click', () => {
    row.remove();
    updateAccountSummary(node);
  });
  applySubFamilyState(row);
  return row;
}

// Grey out a subdomain's A / AAAA checkbox when that family is switched off
// globally (in Settings), so it's clear why it won't apply.
function applySubFamilyState(root = document) {
  const aOn = $('#opt-a')?.checked !== false;
  const aaaaOn = Boolean($('#opt-aaaa')?.checked);
  $$('.sub-a', root).forEach((c) => {
    c.disabled = !aOn;
    const lbl = c.closest('.sub-a-label');
    if (lbl) {
      lbl.classList.toggle('opacity-40', !aOn);
      lbl.title = aOn ? '' : 'Enable “Manage A (IPv4)” in Settings first';
    }
  });
  $$('.sub-aaaa', root).forEach((c) => {
    c.disabled = !aaaaOn;
    const lbl = c.closest('.sub-aaaa-label');
    if (lbl) {
      lbl.classList.toggle('opacity-40', !aaaaOn);
      lbl.title = aaaaOn ? '' : 'Enable “Manage AAAA (IPv6)” in Settings first';
    }
  });
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

// Bring a freshly added card/row into view and put the cursor in its first
// editable field. With a screenful of items an append lands off-screen, so
// "+ Add" otherwise looks like it did nothing.
function revealNewCard(node) {
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const preferred = $(
    '.acc-label, .waf-label, .ch-label, .hb-label, .ddns-label, .sub-name, .ddns-url-label',
    node
  );
  const field =
    preferred ||
    $$('input:not([type="hidden"]):not([type="checkbox"]), select, textarea', node).find(
      (el) => !el.disabled && !el.readOnly
    );
  if (field) field.focus({ preventScroll: true });
}

// Deep-clone a plain config object to stash a card's last-saved snapshot.
const cloneData = (o) => (o ? JSON.parse(JSON.stringify(o)) : {});

// Cancel button behavior, shared by every card: revert an existing card to its
// last-saved snapshot, or discard it entirely if it was never saved (no id).
function revertCard(node, makeRow, updateEmpty) {
  if (!node.dataset.id) {
    node.remove();
    if (updateEmpty) updateEmpty();
    return;
  }
  node.replaceWith(makeRow(node.__saved || {}, { expanded: true }));
}

function makeAccountRow(acc = {}, { expanded = false } = {}) {
  const node = $('#account-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = acc.id || '';
  node.__saved = cloneData(acc);
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
    const row = makeSubRow(node);
    subsWrap.appendChild(row);
    updateAccountSummary(node);
    revealNewCard(row);
  });
  $('.acc-verify', node).addEventListener('click', () => verifyAccount(node));
  $('.acc-save', node).addEventListener('click', () => saveZone(node));
  $('.acc-delete', node).addEventListener('click', () => deleteZone(node));
  $('.acc-cancel', node).addEventListener('click', () => revertCard(node, makeAccountRow, updateAccountsEmpty));
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
  applySubFamilyState(); // reflect the global A/AAAA switches on subdomain rows
  $('#opt-ttl').value = cfg.ttl;
  $('#opt-interval').value = cfg.update_interval_minutes;
  $('#opt-purge').checked = cfg.purge_unknown_records;
  $('#opt-reject-cf').checked = cfg.reject_cloudflare_ips !== false;
  $('#opt-record-comment').value = cfg.record_comment ?? 'cf-ddns-plus';
  // Master DDNS force-update default (mirrored into each provider card's label).
  $('#ddns-force-every').value = cfg.ddns_force_every ?? 30;
  $('#ddns-force-unit').value = ['minutes', 'hours', 'days'].includes(cfg.ddns_force_unit)
    ? cfg.ddns_force_unit
    : 'days';
  refreshDdnsForceDefaultSummary();

  fillProviderSelect($('#ip4-provider'), META.ip4_providers, cfg.ip4_provider);
  fillProviderSelect($('#ip6-provider'), META.ip6_providers, cfg.ip6_provider);
  // Show which detection provider each dashboard IP card is using.
  const providerLabel = (p) => `Provider: ${PROVIDER_LABELS[p] || p || 'Off'}`;
  $('#stat-ipv4-provider').textContent = providerLabel(cfg.ip4_provider);
  $('#stat-ipv6-provider').textContent = providerLabel(cfg.ip6_provider);
  $('#ip4-custom').value = cfg.ip4_custom_url || '';
  $('#ip6-custom').value = cfg.ip6_custom_url || '';
  fillIfaceSelect($('#ip4-iface'), 4, cfg.ip4_iface || '');
  fillIfaceSelect($('#ip6-iface'), 6, cfg.ip6_iface || '');
  $('#ip4-literal').value = cfg.ip4_literal || '';
  $('#ip6-literal').value = cfg.ip6_literal || '';
  toggleIpProvider('#ip4-provider', '#ip4-custom', '#ip4-iface', '#ip4-literal');
  toggleIpProvider('#ip6-provider', '#ip6-custom', '#ip6-iface', '#ip6-literal');

  renderLogSettings(cfg.log || {});
  renderWaf(cfg.waf_lists || []);
  renderNotifications(cfg.notifications || { channels: [] });
  renderHeartbeats(cfg.heartbeats || []);
  renderDdns(cfg.ddns_providers || []);
  updateOnboarding(cfg);
}

// Show the first-run onboarding/migration panel until something is configured.
function updateOnboarding(cfg) {
  const empty =
    (cfg.cloudflare || []).length === 0 &&
    (cfg.waf_lists || []).length === 0 &&
    (cfg.ddns_providers || []).length === 0;
  $('#onboarding').classList.toggle('hidden', !empty);
}

function renderImportPreview(items) {
  const wrap = $('#import-preview-list');
  const commit = $('#import-commit-btn');
  const importable = items.filter((i) => i.ok).length;
  if (!items.length) {
    wrap.innerHTML = '<p class="text-slate-500">No Cloudflare zones found in that config.</p>';
  } else {
    wrap.innerHTML = items
      .map((i) => {
        const icon = i.ok ? (i.warn ? '🟡' : '✅') : i.duplicate ? '↔️' : '⚠️';
        const name = esc(i.zone_name || i.zone_id || '(unknown zone)');
        const subs = i.ok && i.subdomains ? ` · ${i.subdomains.length} subdomain(s)` : '';
        const reason = i.reason ? ` — <span class="text-slate-500">${esc(i.reason)}</span>` : '';
        const warn = i.warn
          ? `<div class="pl-6 text-xs text-amber-600 dark:text-amber-400">${esc(i.warn)}</div>`
          : '';
        return `<div class="${i.ok ? '' : 'text-slate-500'}">${icon} <span class="font-medium">${name}</span>${subs}${reason}</div>${warn}`;
      })
      .join('');
  }
  commit.textContent = importable ? `Import ${importable} zone${importable === 1 ? '' : 's'}` : 'Nothing to import';
  commit.classList.toggle('hidden', importable === 0);
  $('#import-preview').classList.remove('hidden');
}

async function previewImport() {
  const msg = $('#import-msg');
  const raw = $('#import-config').value.trim();
  if (!raw) return setMsg(msg, '✕ Paste or upload a config.json first.', 'err');
  const btn = $('#import-preview-btn');
  btn.disabled = true;
  setMsg(msg, 'Checking config + verifying tokens…', 'info');
  try {
    const res = await api('/api/zones/import/preview', {
      method: 'POST',
      body: JSON.stringify({ config: raw }),
    });
    if (res.notice) {
      renderImportNotice(res.notice);
      setMsg(msg, '', 'info');
      return;
    }
    renderImportPreview(res.items || []);
    setMsg(msg, '', 'info');
  } catch (err) {
    setMsg(msg, `✕ ${err.message}`, 'err');
    $('#import-preview').classList.add('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function commitImport() {
  const msg = $('#import-msg');
  const raw = $('#import-config').value.trim();
  if (!raw) return;
  const btn = $('#import-commit-btn');
  btn.disabled = true;
  setMsg(msg, 'Importing…', 'info');
  try {
    const res = await api('/api/zones/import', { method: 'POST', body: JSON.stringify({ config: raw }) });
    setMsg(msg, `✓ Imported ${res.imported} zone(s)${res.skipped ? `, skipped ${res.skipped}` : ''}.`, 'ok');
    $('#import-config').value = '';
    $('#import-preview').classList.add('hidden');
    await loadConfig(); // re-render zones + hide onboarding
    refreshStatus();
  } catch (err) {
    setMsg(msg, `✕ ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function handleImportFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('#import-config').value = String(reader.result || '');
    setMsg($('#import-msg'), `Loaded ${file.name} — click “Preview import”.`, 'info');
  };
  reader.onerror = () => setMsg($('#import-msg'), '✕ Could not read that file.', 'err');
  reader.readAsText(file);
  e.target.value = ''; // allow re-selecting the same file
}

// Shown when the wizard is fed a Cloudflare DDNS+ backup instead of an upstream
// config — steer the user to Settings → Backup & restore rather than importing
// only its zones.
function renderImportNotice(text) {
  $('#import-preview-list').innerHTML =
    `<div class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">${esc(text)}</div>`;
  $('#import-commit-btn').classList.add('hidden');
  $('#import-preview').classList.remove('hidden');
}

// ---------- backup & restore ----------

function filenameFromDisposition(header) {
  const m = /filename="?([^"]+)"?/i.exec(header || '');
  return m ? m[1] : '';
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportBackup() {
  const pw = $('#backup-export-pw');
  const msg = $('#backup-export-msg');
  const btn = $('#backup-export-btn');
  if (!pw.value) return setMsg(msg, '✕ Enter your password.', 'err');
  btn.disabled = true;
  setMsg(msg, 'Preparing backup…', 'info');
  try {
    // Not via api(): a success returns a file download, not JSON.
    const res = await fetch('/api/config/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw.value }),
    });
    if (res.status === 401) return void (window.location.href = '/login');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    triggerDownload(
      blob,
      filenameFromDisposition(res.headers.get('Content-Disposition')) || 'cloudflare-ddns-plus-backup.json'
    );
    pw.value = '';
    setMsg(msg, '✓ Backup downloaded.', 'ok');
  } catch (err) {
    setMsg(msg, `✕ ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    setTimeout(() => setMsg(msg, '', 'info'), 6000);
  }
}

async function restoreBackup() {
  const cfgEl = $('#backup-restore-config');
  const pw = $('#backup-restore-pw');
  const confirmEl = $('#backup-restore-confirm');
  const msg = $('#backup-restore-msg');
  const btn = $('#backup-restore-btn');
  const raw = cfgEl.value.trim();
  if (!raw) return setMsg(msg, '✕ Paste or upload a backup first.', 'err');
  if (!pw.value) return setMsg(msg, '✕ Enter your password.', 'err');
  if (confirmEl.value.trim() !== 'REPLACE') return setMsg(msg, '✕ Type REPLACE to confirm.', 'err');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return setMsg(msg, '✕ That is not valid JSON.', 'err');
  }
  const ok = await confirmDialog({
    title: 'Overwrite entire configuration?',
    message:
      'This replaces every zone, token, and setting on this instance with the backup. It cannot be undone.',
    confirmLabel: 'Overwrite',
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  setMsg(msg, 'Restoring…', 'info');
  try {
    await api('/api/config/restore', {
      method: 'POST',
      body: JSON.stringify({ password: pw.value, confirm: confirmEl.value.trim(), config: parsed }),
    });
    cfgEl.value = '';
    pw.value = '';
    confirmEl.value = '';
    setMsg(msg, '✓ Configuration restored.', 'ok');
    await loadConfig(); // re-render every tab from the restored config
    refreshStatus();
  } catch (err) {
    setMsg(msg, `✕ ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function handleRestoreFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('#backup-restore-config').value = String(reader.result || '');
    setMsg($('#backup-restore-file-msg'), `Loaded ${file.name}.`, 'info');
  };
  reader.onerror = () => setMsg($('#backup-restore-file-msg'), '✕ Could not read that file.', 'err');
  reader.readAsText(file);
  e.target.value = '';
}

// Show the in-memory row count OR the file-name + retention fields, depending
// on whether persistence is on.
function toggleLogFields() {
  const on = $('#log-persistent').checked;
  $('#log-memory-field').classList.toggle('hidden', on);
  $('#log-file-field').classList.toggle('hidden', !on);
  $('#log-retention-field').classList.toggle('hidden', !on);
}

function renderLogSettings(log) {
  $('#log-persistent').checked = Boolean(log.persistent);
  $('#log-memory-rows').value = log.memory_rows ?? 200;
  $('#log-file-name').value = log.file_name || 'activity.log';
  $('#log-retention').value = log.retention_days ?? 30;
  toggleLogFields();
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

// Re-render channel cards (preserve expanded). Event prefs live per-channel.
function renderNotifications(n) {
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

// Reveal the extra field for the chosen provider: custom URL, interface
// picker ('local'), or the static-IP input ('literal').
function toggleIpProvider(selSel, customSel, ifaceSel, literalSel) {
  const v = $(selSel).value;
  $(customSel).classList.toggle('hidden', v !== 'custom');
  $(ifaceSel).classList.toggle('hidden', v !== 'local');
  $(literalSel).classList.toggle('hidden', v !== 'literal');
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
      a: $('.sub-a', s).checked,
      aaaa: $('.sub-aaaa', s).checked,
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
    reject_cloudflare_ips: $('#opt-reject-cf').checked,
    record_comment: $('#opt-record-comment').value.trim(),
    ip4_provider: $('#ip4-provider').value,
    ip4_custom_url: $('#ip4-custom').value.trim(),
    ip4_iface: $('#ip4-iface').value,
    ip4_literal: $('#ip4-literal').value.trim(),
    ip6_provider: $('#ip6-provider').value,
    ip6_custom_url: $('#ip6-custom').value.trim(),
    ip6_iface: $('#ip6-iface').value,
    ip6_literal: $('#ip6-literal').value.trim(),
    waf_lists: collectWaf(),
    notifications: collectNotifications(),
    heartbeats: collectHeartbeats(),
    ddns_providers: collectDdns(),
    ddns_force_every: Number($('#ddns-force-every').value) || 30,
    ddns_force_unit: $('#ddns-force-unit').value,
    log: {
      persistent: $('#log-persistent').checked,
      memory_rows: Number($('#log-memory-rows').value) || 200,
      file_name: $('#log-file-name').value.trim() || 'activity.log',
      retention_days: Number($('#log-retention').value) || 30,
    },
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
    setMsg(msg, `✓ ${verb}`, 'ok');
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
  node.__saved = cloneData(w);
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
  $('.waf-cancel', node).addEventListener('click', () => revertCard(node, makeWafRow, updateWafEmpty));
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
  const evts = [];
  if ($('.ch-evt-failure', node).checked) evts.push('failures');
  if ($('.ch-evt-ipchange', node).checked) evts.push('IP change');
  if ($('.ch-evt-success', node).checked) evts.push('successful');
  $('.ch-summary-meta', node).textContent = `${type} · ${evts.length ? evts.join(', ') : 'no events'}`;
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
  node.__saved = cloneData(c);
  $('.ch-type', node).value = c.type || 'discord';
  $('.ch-label', node).value = c.label || '';
  $('.ch-enabled', node).checked = c.enabled !== false;
  const ev = c.events || {};
  $('.ch-evt-failure', node).checked = ev.failure !== false; // default on
  $('.ch-evt-ipchange', node).checked = ev.ip_change !== false; // default on
  $('.ch-evt-success', node).checked = Boolean(ev.success); // default off
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
  $$('.ch-evt-failure, .ch-evt-ipchange, .ch-evt-success', node).forEach((cb) =>
    cb.addEventListener('change', () => updateChannelSummary(node))
  );
  $('.ch-save', node).addEventListener('click', () => saveChannel(node));
  $('.ch-delete', node).addEventListener('click', () => deleteChannel(node));
  $('.ch-cancel', node).addEventListener('click', () => revertCard(node, makeChannelRow, updateChannelsEmpty));
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
  await saveConfig({ btn: $('.ch-save', node), msg: $('.ch-msg', node), verb: 'Saved channel' });
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
      events: {
        failure: $('.ch-evt-failure', node).checked,
        ip_change: $('.ch-evt-ipchange', node).checked,
        success: $('.ch-evt-success', node).checked,
      },
    };
  });
  return { channels };
}

// ---------- heartbeat monitors ----------
const HB_TYPE_LABELS = {
  healthchecks: 'Healthchecks.io',
  uptimekuma: 'Uptime Kuma',
  betterstack: 'Better Stack',
  custom: 'Custom URL',
};

function updateHeartbeatsEmpty() {
  $('#heartbeats-empty').classList.toggle('hidden', $$('#heartbeats .heartbeat-card').length > 0);
}

function updateHeartbeatSummary(node) {
  const type = $('.hb-type', node).value;
  const label = $('.hb-label', node).value.trim();
  const enabled = $('.hb-enabled', node).checked;
  const typeName = HB_TYPE_LABELS[type] || type;
  $('.hb-summary-title', node).textContent = label || `${typeName} monitor`;
  $('.hb-summary-meta', node).textContent = typeName;
  const badge = $('.hb-summary-badge', node);
  badge.textContent = enabled ? 'enabled' : 'disabled';
  badge.className =
    'hb-summary-badge badge ' +
    (enabled
      ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
      : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300');
}

// The {status}/{message} hint only applies to the custom type.
function toggleHeartbeatHint(node) {
  const hint = $('.hb-url-hint', node);
  const isCustom = $('.hb-type', node).value === 'custom';
  const code = (t) => `<code class="rounded bg-slate-100 px-1 dark:bg-slate-700">${t}</code>`;
  hint.innerHTML = isCustom
    ? `Include ${code('{status}')} (up/down) and/or ${code('{message}')} to also signal failures; without ${code('{status}')} it pings only on success.`
    : '';
  hint.classList.toggle('hidden', !isCustom);
}

function makeHeartbeatRow(hb = {}, { expanded = false } = {}) {
  const node = $('#heartbeat-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = hb.id || '';
  node.__saved = cloneData(hb);
  $('.hb-type', node).value = hb.type || 'healthchecks';
  $('.hb-label', node).value = hb.label || '';
  $('.hb-enabled', node).checked = hb.enabled !== false;

  // URL stays plain while unsaved; a saved URL loads masked with an eye toggle.
  const urlInput = $('.hb-url', node);
  urlInput.value = hb.url || '';
  const reveal = $('.hb-url-reveal', node);
  if (hb.url) {
    urlInput.type = 'password';
    reveal.classList.remove('hidden');
    reveal.addEventListener('click', () => {
      const hidden = urlInput.type === 'password';
      urlInput.type = hidden ? 'text' : 'password';
      $('.hb-eye', reveal).classList.toggle('hidden', hidden);
      $('.hb-eye-off', reveal).classList.toggle('hidden', !hidden);
      reveal.title = hidden ? 'Hide URL' : 'Show URL';
    });
  }

  $('.hb-type', node).addEventListener('change', () => {
    updateHeartbeatSummary(node);
    toggleHeartbeatHint(node);
  });
  $('.hb-label', node).addEventListener('input', () => updateHeartbeatSummary(node));
  $('.hb-enabled', node).addEventListener('change', () => updateHeartbeatSummary(node));
  $('.hb-save', node).addEventListener('click', () => saveHeartbeat(node));
  $('.hb-delete', node).addEventListener('click', () => deleteHeartbeat(node));
  $('.hb-cancel', node).addEventListener('click', () => revertCard(node, makeHeartbeatRow, updateHeartbeatsEmpty));
  $('.hb-test', node).addEventListener('click', () => testHeartbeat(node));
  $('.acc-header', node).addEventListener('click', () => {
    setCollapsed(node, !$('.acc-body', node).classList.contains('hidden'));
  });

  toggleHeartbeatHint(node);
  setCollapsed(node, !expanded);
  updateHeartbeatSummary(node);
  return node;
}

function renderHeartbeats(list) {
  const wrap = $('#heartbeats');
  const expIds = new Set(
    $$('#heartbeats .heartbeat-card')
      .filter((c) => !$('.acc-body', c).classList.contains('hidden'))
      .map((c) => c.dataset.id)
      .filter(Boolean)
  );
  wrap.innerHTML = '';
  (list || []).forEach((hb) => wrap.appendChild(makeHeartbeatRow(hb, { expanded: expIds.has(hb.id) })));
  updateHeartbeatsEmpty();
}

function collectHeartbeats() {
  return $$('#heartbeats .heartbeat-card').map((node) => ({
    id: node.dataset.id || undefined,
    type: $('.hb-type', node).value,
    enabled: $('.hb-enabled', node).checked,
    label: $('.hb-label', node).value.trim(),
    url: $('.hb-url', node).value.trim(),
  }));
}

async function saveHeartbeat(node) {
  await saveConfig({ btn: $('.hb-save', node), msg: $('#save-msg'), verb: 'Saved monitor' });
}

async function deleteHeartbeat(node) {
  const title = ($('.hb-summary-title', node).textContent || 'this monitor').trim();
  const ok = await confirmDialog({
    title: 'Delete monitor',
    message: `Delete "${title}"? Heartbeats will no longer be sent to it.`,
    confirmLabel: 'Delete monitor',
  });
  if (!ok) return;
  node.remove();
  updateHeartbeatsEmpty();
  await saveConfig({ btn: null, msg: $('#save-msg'), verb: 'Monitor deleted' });
}

async function testHeartbeat(node) {
  const msg = $('.hb-msg', node);
  const set = (t, cls) => {
    msg.textContent = t;
    msg.className = `hb-msg text-xs ${cls}`;
  };
  if (!node.dataset.id) {
    set('Save the monitor first, then test.', 'text-red-600 dark:text-red-400');
    setTimeout(() => set('', ''), 5000);
    return;
  }
  set('Pinging…', 'text-slate-500');
  try {
    await api('/api/heartbeats/test', { method: 'POST', body: JSON.stringify({ heartbeatId: node.dataset.id }) });
    set('✓ Pinged', 'text-green-600 dark:text-green-400');
  } catch (err) {
    set(`✕ ${err.message}`, 'text-red-600 dark:text-red-400');
  } finally {
    setTimeout(() => set('', ''), 6000);
  }
}

// ---------- DDNS providers (opt-in) ----------
function updateDdnsEmpty() {
  const empty = $('#ddns-empty');
  if (empty) empty.classList.toggle('hidden', $$('#ddns-list .ddns-card').length > 0);
}

function toggleDdnsFields(node) {
  const type = $('.ddns-type', node).value;
  const method = $('.ddns-fd-method', node).value;
  // The URL-rows block is shared by FreeDNS (token method) and Custom URL.
  const showUrlRows = (type === 'freedns' && method === 'token') || type === 'generic';
  $$('.ddns-field', node).forEach((el) => {
    let show;
    if (el.classList.contains('ddns-urlrows')) {
      show = showUrlRows;
    } else if (type === 'freedns') {
      if (el.classList.contains('ddns-fd-userpass')) show = method === 'userpass';
      else show = el.classList.contains('ddns-f-freedns'); // the method selector
    } else {
      show = el.classList.contains(`ddns-f-${type}`);
    }
    el.classList.toggle('hidden', !show);
  });
  // Retitle the shared URL block for whichever type is using it.
  const title = $('.ddns-urls-title', node);
  const hint = $('.ddns-urls-hint', node);
  if (type === 'generic') {
    title.textContent = 'Update URLs';
    const code = (t) => `<code class="rounded bg-slate-100 px-1 dark:bg-slate-700">${t}</code>`;
    hint.innerHTML =
      `Full update URL for each host. Use ${code('{ip}')}, ${code('{ip4}')} or ${code('{ip6}')} where the ` +
      `URL needs your IP (omit to let the provider auto-detect). Shown in plain text.`;
  } else {
    title.textContent = 'Update tokens / URLs';
    hint.textContent = "Each host's update token or full update URL (FreeDNS → Dynamic DNS). Shown in plain text.";
  }
}

// Force update off → hide everything. On → show the "Default" checkbox, and show
// the custom interval row only when the user opts out of the default.
function toggleDdnsForce(node) {
  const on = $('.ddns-force', node).checked;
  const useDefault = $('.ddns-force-default', node).checked;
  $('.ddns-force-fields', node).classList.toggle('hidden', !on);
  $('.ddns-force-custom', node).classList.toggle('hidden', !on || useDefault);
}

// The master default lives in Settings → Schedule & advanced; mirror it into
// every card's "Default: Re-send every N unit" label.
function ddnsForceDefaultText() {
  const every = $('#ddns-force-every');
  const unit = $('#ddns-force-unit');
  return `Re-send every ${(every && Number(every.value)) || 30} ${(unit && unit.value) || 'days'}`;
}

// Scoped to a card — makeDdnsRow builds the node before it's in the document, so
// a document-wide query wouldn't reach it.
function setDdnsForceDefaultSummary(node) {
  const el = $('.ddns-force-default-summary', node);
  if (el) el.textContent = ddnsForceDefaultText();
}

function refreshDdnsForceDefaultSummary() {
  const text = ddnsForceDefaultText();
  $$('.ddns-force-default-summary').forEach((el) => (el.textContent = text));
}

// Stepper arrows for the force-update interval (mobile browsers show no native
// number spinners, so we drive the value ourselves).
function stepDdnsForce(node, delta) {
  const input = $('.ddns-force-every', node);
  const min = Number(input.min) || 1;
  const max = Number(input.max) || 100000;
  input.value = String(Math.min(max, Math.max(min, (Number(input.value) || min) + delta)));
}

// One FreeDNS update token/URL row.
function makeDdnsUrlRow(node, entry = {}, { masked = false } = {}) {
  // Accept a string (legacy) or a { label, url } object.
  const { label = '', url = '' } =
    typeof entry === 'string' ? { url: entry } : entry || {};
  const row = $('#ddns-url-template').content.firstElementChild.cloneNode(true);
  const input = $('.ddns-url', row);
  const value = url;
  input.value = value;
  $('.ddns-url-label', row).value = label;
  $('.ddns-url-remove', row).addEventListener('click', () => {
    row.remove();
    updateDdnsSummary(node);
  });
  input.addEventListener('input', () => updateDdnsSummary(node));

  // Existing (already-saved) URLs load masked with an eye toggle to reveal.
  // A blank/new row has nothing to hide, so it stays plain text.
  const reveal = $('.ddns-url-reveal', row);
  if (masked && value) {
    input.type = 'password';
    reveal.classList.remove('hidden');
    reveal.addEventListener('click', () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      $('.ddns-eye', reveal).classList.toggle('hidden', hidden);
      $('.ddns-eye-off', reveal).classList.toggle('hidden', !hidden);
      reveal.title = hidden ? 'Hide URL' : 'Show URL';
    });
  }
  return row;
}

function updateDdnsSummary(node) {
  const type = $('.ddns-type', node).value;
  const method = $('.ddns-fd-method', node).value;
  const hostname = $('.ddns-hostname', node).value.trim();
  const domains = $('.ddns-domains', node).value.trim();
  const label = $('.ddns-label', node).value.trim();
  const urlCount = $$('.ddns-urls .ddns-url-row', node).filter((r) => $('.ddns-url', r).value.trim()).length;
  const host =
    type === 'dyndns2'
      ? hostname
      : type === 'freedns'
      ? method === 'userpass'
        ? hostname
        : label
      : type === 'generic'
      ? urlCount
        ? `${urlCount} URL${urlCount > 1 ? 's' : ''}`
        : 'no URLs'
      : domains;
  const enabled = $('.ddns-enabled', node).checked;
  const typeName =
    type === 'dyndns2' ? 'DynDNS2' : type === 'freedns' ? 'FreeDNS' : type === 'generic' ? 'Custom URL' : 'DuckDNS';
  $('.ddns-summary-title', node).textContent = label || host || 'New provider';
  $('.ddns-summary-meta', node).textContent = `${typeName} · ${host || 'not configured'}`;
  const badge = $('.ddns-summary-badge', node);
  const tested = node.dataset.tested === '1';
  // Enabled but untested is a real state: it won't run on the schedule yet.
  const [text, style] = !enabled
    ? ['disabled', 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300']
    : !tested
    ? ['needs test', 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300']
    : ['enabled', 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'];
  badge.textContent = text;
  badge.className = 'ddns-summary-badge badge ' + style;
}

function makeDdnsRow(p = {}, { expanded = false } = {}) {
  const node = $('#ddns-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = p.id || '';
  if (p.tested) node.dataset.tested = '1'; // gates inclusion in scheduled runs
  node.__saved = cloneData(p);
  $('.ddns-type', node).value = p.type || 'duckdns';
  $('.ddns-label', node).value = p.label || '';
  $('.ddns-enabled', node).checked = p.enabled !== false;
  $('.ddns-domains', node).value = p.domains || '';
  $('.ddns-server', node).value = p.server || '';
  $('.ddns-hostname', node).value = p.hostname || '';
  $('.ddns-username', node).value = p.username || '';
  $('.ddns-https', node).checked = p.https !== false;
  $('.ddns-fd-method', node).value = p.method === 'userpass' ? 'userpass' : 'token';
  $('.ddns-force', node).checked = p.force_update !== false; // default on
  $('.ddns-force-default', node).checked = p.force_default !== false; // follow master
  $('.ddns-force-every', node).value = p.force_every ?? 30;
  $('.ddns-force-unit', node).value = ['minutes', 'hours', 'days'].includes(p.force_unit)
    ? p.force_unit
    : 'days';

  // FreeDNS update-URL rows (start with one empty row).
  const urlsWrap = $('.ddns-urls', node);
  const urls = p.urls && p.urls.length ? p.urls : [''];
  urls.forEach((u) => urlsWrap.appendChild(makeDdnsUrlRow(node, u, { masked: true })));

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
  $('.ddns-add-url', node).addEventListener('click', () => {
    const row = makeDdnsUrlRow(node);
    $('.ddns-urls', node).appendChild(row);
    revealNewCard(row);
  });
  $('.ddns-force', node).addEventListener('change', (e) => {
    // Turning force update on starts from the master default.
    if (e.target.checked) $('.ddns-force-default', node).checked = true;
    toggleDdnsForce(node);
  });
  $('.ddns-force-default', node).addEventListener('change', () => toggleDdnsForce(node));
  $('.ddns-step-up', node).addEventListener('click', () => stepDdnsForce(node, 1));
  $('.ddns-step-down', node).addEventListener('click', () => stepDdnsForce(node, -1));
  ['.ddns-label', '.ddns-domains', '.ddns-hostname'].forEach((sel) =>
    $(sel, node).addEventListener('input', () => updateDdnsSummary(node))
  );
  $('.ddns-enabled', node).addEventListener('change', () => updateDdnsSummary(node));
  $('.ddns-save', node).addEventListener('click', () => saveDdns(node));
  $('.ddns-delete', node).addEventListener('click', () => deleteDdns(node));
  $('.ddns-cancel', node).addEventListener('click', () => revertCard(node, makeDdnsRow, updateDdnsEmpty));
  $('.ddns-test', node).addEventListener('click', () => testDdns(node));
  $('.ddns-update', node).addEventListener('click', (e) => {
    e.stopPropagation();
    updateDdns(node);
  });
  $('.acc-header', node).addEventListener('click', () => {
    setCollapsed(node, !$('.acc-body', node).classList.contains('hidden'));
  });

  toggleDdnsFields(node);
  toggleDdnsForce(node);
  setDdnsForceDefaultSummary(node);
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
    urls: $$('.ddns-urls .ddns-url-row', node)
      .map((row) => ({
        label: $('.ddns-url-label', row).value.trim(),
        url: $('.ddns-url', row).value.trim(),
      }))
      .filter((e) => e.url),
    force_update: $('.ddns-force', node).checked,
    force_default: $('.ddns-force-default', node).checked,
    force_every: Number($('.ddns-force-every', node).value) || 30,
    force_unit: $('.ddns-force-unit', node).value,
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
  } else if (type === 'generic') {
    const urls = $$('.ddns-urls .ddns-url', node).map((i) => i.value.trim()).filter(Boolean);
    if (!urls.length) return 'Add at least one update URL.';
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
  const fail = (text) => {
    msg.textContent = `✕ ${text}`;
    msg.className = 'ddns-verify-msg sm:col-span-2 text-xs text-red-600 dark:text-red-400';
  };
  const missing = ddnsMissingField(node);
  if (missing) return fail(missing);
  // A passing Test is what admits the provider to scheduled runs, and that flag
  // is stored against its id — so it has to be saved before it can be tested.
  if (!node.dataset.id) return fail('Save the provider first, then Test it.');
  msg.textContent = 'Testing…';
  msg.className = 'ddns-verify-msg sm:col-span-2 text-xs text-slate-500';
  try {
    const res = await api('/api/ddns/verify', {
      method: 'POST',
      body: JSON.stringify({ provider: collectOneDdns(node) }),
    });
    msg.textContent = `✓ ${res.detail || 'Provider responded OK'}`;
    msg.className = 'ddns-verify-msg sm:col-span-2 text-xs text-green-600 dark:text-green-400';
    // The server just marked it tested — reflect that in the summary badge.
    node.dataset.tested = '1';
    updateDdnsSummary(node);
  } catch (err) {
    fail(err.message);
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
  setPauseLabel(PAUSED);

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

function recordTableRow(r) {
  const style = STATUS_STYLES[r.status] || STATUS_STYLES.unchanged;
  return `<tr>
      <td class="px-4 py-2 font-mono">${esc(r.fqdn)}</td>
      <td class="px-4 py-2">${esc(r.type)}</td>
      <td class="px-4 py-2">${r.proxied ? '🟠 yes' : 'no'}</td>
      <td class="px-4 py-2"><span class="badge ${style}">${esc(r.status)}</span></td>
      <td class="px-4 py-2 text-slate-500">${esc(r.detail || '')}</td>
    </tr>`;
}

// Compact card for the mobile records view (no horizontal scrolling).
function recordCard(r) {
  const style = STATUS_STYLES[r.status] || STATUS_STYLES.unchanged;
  const detail = r.detail
    ? `<p class="mt-1 break-words text-xs text-slate-500">${esc(r.detail)}</p>`
    : '';
  return `<div class="px-4 py-3">
      <div class="flex items-center justify-between gap-2">
        <span class="truncate font-mono text-sm font-medium">${esc(r.fqdn)}</span>
        <span class="badge shrink-0 ${style}">${esc(r.status)}</span>
      </div>
      <div class="mt-1 flex items-center gap-3 text-xs text-slate-500">
        <span>${esc(r.type)}</span>
        <span>${r.proxied ? '🟠 proxied' : 'not proxied'}</span>
      </div>
      ${detail}
    </div>`;
}

function renderRecords(records) {
  const body = $('#records-body');
  const cards = $('#records-cards');
  const q = ($('#records-filter')?.value || '').trim().toLowerCase();
  const hidden = hiddenStatuses();
  const setEmpty = (msg) => {
    body.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">${msg}</td></tr>`;
    cards.innerHTML = `<div class="px-4 py-6 text-center text-slate-400">${msg}</div>`;
  };
  if (!records || !records.length) return setEmpty('No records yet — run an update.');
  const rows = records.filter((r) => !hidden.has(r.status) && recordMatchesFilter(r, q));
  if (!rows.length) return setEmpty('No records match the current filter.');
  body.innerHTML = rows.map(recordTableRow).join('');
  cards.innerHTML = rows.map(recordCard).join('');
}

// runIds the user has expanded — kept across the 5s auto-refresh so an open
// group doesn't snap shut under them.
const EXPANDED_RUNS = new Set();

function logRow(e, indent) {
  const t = new Date(e.at).toLocaleTimeString();
  const style = LOG_STYLES[e.level] || LOG_STYLES.info;
  return `<div class="flex gap-3 px-4 py-1.5 ${indent ? 'pl-11' : ''}">
    <span class="shrink-0 text-slate-400">${t}</span>
    <span class="${style}">${esc(e.message)}</span>
  </div>`;
}

function renderLog(log) {
  const wrap = $('#log-list');
  if (!log || !log.length) {
    wrap.innerHTML = '<div class="px-4 py-6 text-center text-slate-400">No activity yet.</div>';
    return;
  }

  // Group consecutive entries that share a runId into one collapsible update.
  const groups = [];
  for (const e of log) {
    const last = groups[groups.length - 1];
    if (e.runId && last && last.runId === e.runId) last.entries.push(e);
    else groups.push({ runId: e.runId || null, entries: [e] });
  }

  wrap.innerHTML = groups
    .map((g) => {
      // Ungrouped or single-line entries render flat (no disclosure).
      if (!g.runId || g.entries.length < 2) {
        return `<div>${g.entries.map((e) => logRow(e, false)).join('')}</div>`;
      }
      // The "Update finished/failed" line heads the group; the rest are details
      // shown oldest-first when expanded.
      const header = g.entries.find((e) => e.phase === 'end') || g.entries[0];
      const details = g.entries.filter((e) => e !== header).reverse();
      const open = EXPANDED_RUNS.has(g.runId);
      const t = new Date(header.at).toLocaleTimeString();
      const style = LOG_STYLES[header.level] || LOG_STYLES.info;
      const n = details.length;
      return `<div class="log-group" data-run="${esc(g.runId)}">
        <button type="button" class="log-head flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-700/40">
          <svg class="log-chevron h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" /></svg>
          <span class="shrink-0 text-slate-400">${t}</span>
          <span class="${style} truncate">${esc(header.message)}</span>
          <span class="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-slate-400">${n} step${n === 1 ? '' : 's'}</span>
        </button>
        <div class="log-details ${open ? '' : 'hidden'} bg-slate-50/60 dark:bg-slate-900/40">
          ${details.map((e) => logRow(e, true)).join('')}
        </div>
      </div>`;
    })
    .join('');

  // innerHTML was replaced, so (re)wire the disclosure toggles each render.
  wrap.querySelectorAll('.log-group').forEach((el) => {
    const runId = el.dataset.run;
    el.querySelector('.log-head').addEventListener('click', () => {
      const details = el.querySelector('.log-details');
      const collapsed = details.classList.toggle('hidden');
      el.querySelector('.log-chevron').classList.toggle('rotate-90', !collapsed);
      if (collapsed) EXPANDED_RUNS.delete(runId);
      else EXPANDED_RUNS.add(runId);
    });
  });
}

async function loadVersion() {
  try {
    const v = await api('/api/version');
    if (v.repoUrl) {
      $('#footer-repo').href = v.repoUrl;
      $('#footer-license').href = `${v.repoUrl}/blob/main/LICENSE`;
    }
    $('#footer-version').textContent = `v${v.current}`;
    const upd = $('#footer-update');
    if (v.updateAvailable && v.latest) {
      $('#footer-update-text').textContent = `Update available: v${v.latest}`;
      if (v.releasesUrl) upd.href = v.releasesUrl;
      upd.classList.remove('hidden');
      upd.classList.add('flex');
    } else {
      upd.classList.add('hidden');
      upd.classList.remove('flex');
    }
  } catch {
    /* footer stays with its default version placeholder */
  }
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

// Full label on desktop, short on mobile (keeps the dashboard action row on one line).
function setPauseLabel(paused) {
  const btn = $('#pause-toggle');
  if (!btn) return;
  const full = paused ? 'Resume scheduler' : 'Pause scheduler';
  const short = paused ? 'Resume' : 'Pause';
  btn.innerHTML = `<span class="sm:hidden">${short}</span><span class="hidden sm:inline">${full}</span>`;
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
  // 'paper' is an explicit choice, so it never follows the system setting.
  const dark = pref === 'dark' || (pref === 'system' && prefersDark.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('paper', pref === 'paper');
  // Collapsed control: show only the active theme's icon.
  $$('#theme-current [data-theme-icon]').forEach((el) =>
    el.classList.toggle('hidden', el.dataset.themeIcon !== pref)
  );
  // Highlight the active option in the dropdown.
  $$('#theme-menu .theme-opt').forEach((b) => {
    const on = b.dataset.theme === pref;
    b.classList.toggle('bg-slate-100', on);
    b.classList.toggle('dark:bg-slate-700/50', on);
    b.classList.toggle('font-medium', on);
  });
}

function initTheme() {
  let pref = 'system';
  try {
    pref = localStorage.getItem('theme') || 'system';
  } catch (e) {}
  applyTheme(pref);

  // The active icon toggles a small dropdown with the other choices.
  const menu = $('#theme-menu');
  const current = $('#theme-current');
  if (current && menu) {
    current.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('hidden') === false;
      current.setAttribute('aria-expanded', String(open));
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
    $$('#theme-menu .theme-opt').forEach((b) =>
      b.addEventListener('click', () => {
        applyTheme(b.dataset.theme);
        menu.classList.add('hidden');
        current.setAttribute('aria-expanded', 'false');
      })
    );
    document.addEventListener('click', () => menu.classList.add('hidden'));
  }

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
    const node = makeAccountRow({}, { expanded: true });
    $('#accounts').appendChild(node);
    updateAccountsEmpty();
    revealNewCard(node);
  });
  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveConfig({ btn: $('#save-btn'), msg: $('#save-msg') });
  });
  $('#add-waf').addEventListener('click', () => {
    const node = makeWafRow({}, { expanded: true });
    $('#waf-lists').appendChild(node);
    updateWafEmpty();
    revealNewCard(node);
  });
  $('#add-channel').addEventListener('click', () => {
    const node = makeChannelRow({}, { expanded: true });
    $('#channels').appendChild(node);
    updateChannelsEmpty();
    revealNewCard(node);
  });
  $('#add-heartbeat').addEventListener('click', () => {
    const node = makeHeartbeatRow({ enabled: true }, { expanded: true });
    $('#heartbeats').appendChild(node);
    updateHeartbeatsEmpty();
    revealNewCard(node);
  });
  $('#add-ddns').addEventListener('click', () => {
    const node = makeDdnsRow({}, { expanded: true });
    $('#ddns-list').appendChild(node);
    updateDdnsEmpty();
    revealNewCard(node);
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
  $('#ip4-provider').addEventListener('change', () => toggleIpProvider('#ip4-provider', '#ip4-custom', '#ip4-iface', '#ip4-literal'));
  $('#ip6-provider').addEventListener('change', () => toggleIpProvider('#ip6-provider', '#ip6-custom', '#ip6-iface', '#ip6-literal'));
  $('#opt-a').addEventListener('change', () => applySubFamilyState());
  $('#opt-aaaa').addEventListener('change', () => applySubFamilyState());
  $('#log-persistent').addEventListener('change', toggleLogFields);
  // Master DDNS force-update default: stepper arrows + live label in each card.
  $('#ddns-force-up').addEventListener('click', () => {
    const el = $('#ddns-force-every');
    el.value = String(Math.min(100000, (Number(el.value) || 1) + 1));
    refreshDdnsForceDefaultSummary();
  });
  $('#ddns-force-down').addEventListener('click', () => {
    const el = $('#ddns-force-every');
    el.value = String(Math.max(1, (Number(el.value) || 1) - 1));
    refreshDdnsForceDefaultSummary();
  });
  $('#ddns-force-every').addEventListener('input', refreshDdnsForceDefaultSummary);
  $('#ddns-force-unit').addEventListener('change', refreshDdnsForceDefaultSummary);
  // Onboarding / import-from-cloudflare-ddns
  $('#onboarding-to-zones').addEventListener('click', () => $('[data-tab="zones"]').click());
  $('#import-preview-btn').addEventListener('click', previewImport);
  $('#import-commit-btn').addEventListener('click', commitImport);
  $('#import-file').addEventListener('change', handleImportFile);
  // Backup & restore
  $('#backup-export-btn').addEventListener('click', exportBackup);
  $('#backup-restore-btn').addEventListener('click', restoreBackup);
  $('#backup-restore-file').addEventListener('change', handleRestoreFile);

  await loadConfig();
  await refreshStatus();
  loadVersion();
  setInterval(refreshStatus, 5000);
}

init();
