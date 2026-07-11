// Runs the updater on a fixed interval. Uses a self-rescheduling timer (not a
// wall-clock cron) so "every N minutes" means exactly N minutes between runs,
// and the displayed "next run" always matches when the timer will actually fire.

import { loadConfig, saveConfig } from './config.js';
import * as state from './state.js';
import { runUpdate } from './updater.js';

let timer = null;
let intervalMinutes = 5;
let active = false;

function clampMinutes(m) {
  return Math.min(1440, Math.max(1, Number(m) || 5));
}

// Load fresh config each run so saved changes take effect without a restart.
async function runScheduled() {
  const cfg = await loadConfig();
  await runUpdate(cfg, { trigger: 'scheduled' });
}

// Arm the next run exactly intervalMinutes from now and reflect it in state.
function armTimer() {
  if (timer) clearTimeout(timer);
  const ms = intervalMinutes * 60 * 1000;
  state.setScheduler({
    active: true,
    paused: false,
    intervalMinutes,
    nextRunAt: new Date(Date.now() + ms).toISOString(),
  });
  timer = setTimeout(async () => {
    try {
      await runScheduled();
    } finally {
      if (active) armTimer();
    }
  }, ms);
}

export async function startScheduler({ runOnStart = true } = {}) {
  const cfg = await loadConfig();
  applySchedule(cfg);
  if (runOnStart && !cfg.scheduler_paused) {
    // Fire an initial run shortly after boot, then re-arm so the first
    // scheduled run is a full interval after it.
    setTimeout(async () => {
      try {
        await runScheduled();
      } finally {
        if (active) armTimer();
      }
    }, 1500);
  }
}

// Start or stop the timer to match the config's paused flag + interval.
export function applySchedule(cfg) {
  intervalMinutes = clampMinutes(cfg.update_interval_minutes);
  if (cfg.scheduler_paused) {
    stopScheduler();
  } else {
    active = true;
    armTimer();
  }
}

export function reschedule(minutes) {
  intervalMinutes = clampMinutes(minutes);
  active = true;
  armTimer();
}

export function stopScheduler() {
  active = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  state.setScheduler({ active: false, nextRunAt: null });
}

// Pause or resume the scheduler and persist the choice so it survives restarts.
export async function setPaused(paused) {
  const cfg = await loadConfig();
  cfg.scheduler_paused = Boolean(paused);
  await saveConfig(cfg);
  state.setScheduler({ paused: cfg.scheduler_paused });
  applySchedule(cfg);
  state.log('info', `Scheduler ${cfg.scheduler_paused ? 'paused' : 'resumed'}`);
  return { paused: cfg.scheduler_paused };
}

// Manual trigger from the API — runs immediately with the latest config.
// Pass { accountId } for one zone, { wafId } for one WAF list, or { ddnsId } for
// one DDNS provider. A full manual run also resets the cadence so the next
// scheduled run is a whole interval away.
export async function triggerNow({ accountId = null, wafId = null, ddnsId = null } = {}) {
  const cfg = await loadConfig();
  const trigger = accountId
    ? 'manual-zone'
    : wafId
    ? 'manual-waf'
    : ddnsId
    ? 'manual-ddns'
    : 'manual';
  const res = await runUpdate(cfg, { trigger, accountId, wafId, ddnsId });
  if (!accountId && !wafId && !ddnsId && active) armTimer();
  return res;
}
