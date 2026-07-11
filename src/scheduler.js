// Wraps the updater in a cron schedule that can be (re)configured at runtime.

import cron from 'node-cron';
import { loadConfig, saveConfig } from './config.js';
import * as state from './state.js';
import { runUpdate } from './updater.js';

let task = null;
let intervalMinutes = null;

function cronExprFor(minutes) {
  const m = Math.min(1440, Math.max(1, Number(minutes) || 5));
  if (m < 60) return `*/${m} * * * *`; // every m minutes
  const hours = Math.max(1, Math.round(m / 60));
  return `0 */${hours} * * *`; // every N hours
}

function computeNextRun(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// Load fresh config each tick so saved changes take effect without a restart.
async function tick(trigger) {
  const cfg = await loadConfig();
  state.setScheduler({ nextRunAt: computeNextRun(intervalMinutes) });
  await runUpdate(cfg, { trigger });
}

export async function startScheduler({ runOnStart = true } = {}) {
  const cfg = await loadConfig();
  applySchedule(cfg);
  if (runOnStart && !cfg.scheduler_paused) {
    // Fire an initial run shortly after boot (non-blocking).
    setTimeout(() => tick('startup').catch(() => {}), 1500);
  }
}

// Start or stop the cron loop to match the config's paused flag + interval.
export function applySchedule(cfg) {
  state.setScheduler({ paused: Boolean(cfg.scheduler_paused) });
  if (cfg.scheduler_paused) {
    stopScheduler();
  } else {
    reschedule(cfg.update_interval_minutes);
  }
}

// Pause or resume the scheduler and persist the choice so it survives restarts.
export async function setPaused(paused) {
  const cfg = await loadConfig();
  cfg.scheduler_paused = Boolean(paused);
  await saveConfig(cfg);
  applySchedule(cfg);
  state.log('info', `Scheduler ${cfg.scheduler_paused ? 'paused' : 'resumed'}`);
  return { paused: cfg.scheduler_paused };
}

export function reschedule(minutes) {
  intervalMinutes = Math.min(1440, Math.max(1, Number(minutes) || 5));
  if (task) {
    task.stop();
    task = null;
  }
  task = cron.schedule(cronExprFor(intervalMinutes), () => {
    tick('scheduled').catch(() => {});
  });
  state.setScheduler({
    active: true,
    intervalMinutes,
    nextRunAt: computeNextRun(intervalMinutes),
  });
}

export function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
  state.setScheduler({ active: false, nextRunAt: null });
}

// Manual trigger from the API — runs immediately with the latest config.
// Pass { accountId } to sync one zone, or { wafId } to sync one WAF list.
export async function triggerNow({ accountId = null, wafId = null } = {}) {
  const cfg = await loadConfig();
  const trigger = accountId ? 'manual-zone' : wafId ? 'manual-waf' : 'manual';
  return runUpdate(cfg, { trigger, accountId, wafId });
}
