// In-memory runtime status + a rolling activity log. The log is always held in
// memory (newest first) for the dashboard; optionally it's also mirrored to a
// file (see logfile.js) so it survives restarts.

import { appendEntry, configureLogFile, loadRecent } from './logfile.js';

let maxLog = 200; // rows kept in memory; overridden from config

const state = {
  running: false,
  lastRunAt: null,
  lastRunResult: null, // 'ok' | 'error' | 'partial'
  lastRunMessage: '',
  nextRunAt: null,
  schedulerActive: false,
  paused: false,
  intervalMinutes: null,
  currentIPv4: null,
  currentIPv6: null,
  records: [], // [{ fqdn, type, proxied, status, detail, at }]
  log: [], // newest first
};

export function getState() {
  return {
    ...state,
    records: [...state.records],
    log: [...state.log],
  };
}

export function setRunning(v) {
  state.running = v;
}

export function setScheduler({ active, paused, intervalMinutes, nextRunAt }) {
  if (active !== undefined) state.schedulerActive = active;
  if (paused !== undefined) state.paused = paused;
  if (intervalMinutes !== undefined) state.intervalMinutes = intervalMinutes;
  if (nextRunAt !== undefined) state.nextRunAt = nextRunAt;
}

export function setIPs({ v4, v6 }) {
  if (v4 !== undefined) state.currentIPv4 = v4;
  if (v6 !== undefined) state.currentIPv6 = v6;
}

export function setRecords(records) {
  state.records = records;
}

// Drop dashboard records whose FQDN is no longer configured, so deleting a zone
// (or subdomain / WAF list / DDNS provider) clears its rows immediately instead
// of waiting for the next run.
export function pruneRecords(keepFqdns) {
  state.records = state.records.filter((r) => keepFqdns.has(r.fqdn));
}

export function finishRun({ result, message }) {
  state.lastRunAt = new Date().toISOString();
  state.lastRunResult = result;
  state.lastRunMessage = message || '';
}

// Log grouping: every entry emitted between beginLogRun() and endLogRun() shares
// a runId, so the UI can collapse a whole update into one row. Runs never overlap
// (the updater guards on `running`), so a single module-level id is safe.
let runCounter = 0;
let currentRunId = null;

export function beginLogRun() {
  runCounter += 1;
  currentRunId = `run-${runCounter}`;
  return currentRunId;
}

export function endLogRun() {
  currentRunId = null;
}

// phase: 'start' | 'end' marks the update's start/finish lines so the UI knows
// which entry heads the collapsible group.
// Configure how many rows the in-memory log keeps (trims immediately if lower).
export function setMaxLog(n) {
  maxLog = Math.min(5000, Math.max(10, Number(n) || 200));
  if (state.log.length > maxLog) state.log.length = maxLog;
}

// Replace the in-memory log wholesale (used to repopulate from the file on boot).
export function setLog(entries) {
  state.log = Array.isArray(entries) ? entries.slice(0, maxLog) : [];
}

// Apply the config's log settings: in-memory size + file persistence. Safe to
// call on every config save; does not touch the current in-memory entries.
export function applyLogConfig(cfg) {
  const log = cfg?.log || {};
  setMaxLog(log.memory_rows);
  configureLogFile({
    enabled: log.persistent,
    fileName: log.file_name,
    retentionDays: log.retention_days,
  });
}

// On boot, if persistence is on, seed the in-memory log from the file so the
// dashboard shows history from before the restart.
export async function initLogFromFile() {
  const recent = await loadRecent(maxLog);
  if (recent.length) setLog(recent);
}

export function log(level, message, meta, phase) {
  const entry = {
    at: new Date().toISOString(),
    level, // 'info' | 'success' | 'warn' | 'error'
    message,
    ...(currentRunId ? { runId: currentRunId } : {}),
    ...(phase ? { phase } : {}),
    ...(meta ? { meta } : {}),
  };
  state.log.unshift(entry);
  if (state.log.length > maxLog) state.log.length = maxLog;
  // Mirror to disk when persistence is on (best-effort, non-blocking).
  appendEntry(entry);
  return entry;
}
