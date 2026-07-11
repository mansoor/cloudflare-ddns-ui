// In-memory runtime status + a rolling activity log. Not persisted — resets on
// restart, which is fine for status/observability.

const MAX_LOG = 200;

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

export function log(level, message, meta) {
  const entry = {
    at: new Date().toISOString(),
    level, // 'info' | 'success' | 'warn' | 'error'
    message,
    ...(meta ? { meta } : {}),
  };
  state.log.unshift(entry);
  if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;
  return entry;
}
