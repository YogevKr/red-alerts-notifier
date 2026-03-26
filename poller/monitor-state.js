import {
  buildMonitoredSourceNames,
  resolveActiveSourceNames,
} from "./source-registry.js";

export function buildMonitoredSourceChannels({
  activeSources = [],
} = {}) {
  return buildMonitoredSourceNames(resolveActiveSourceNames({
    explicitNames: activeSources,
  }));
}

export function createPollerMonitor({
  runtimeState,
  monitoredSourceChannels = [],
  evolutionInstance = "",
  evolutionFallbackInstance = "",
} = {}) {
  return {
    deliveryEnabled: runtimeState.deliveryEnabled,
    deliveryUpdatedAt: runtimeState.deliveryUpdatedAt,
    deliveryUpdatedBy: runtimeState.deliveryUpdatedBy,
    lastPollAt: null,
    lastPollSuccessAt: null,
    lastPollErrorAt: null,
    lastPollError: null,
    consecutivePollErrors: 0,
    sourceFailures: Object.fromEntries(
      monitoredSourceChannels.map((source) => [
        source,
        {
          consecutiveFailures: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastError: null,
          disconnectedSince: null,
        },
      ]),
    ),
    whatsappConnectionState: null,
    whatsappActiveInstance: evolutionInstance,
    whatsappPrimaryInstance: evolutionInstance,
    whatsappPrimaryState: null,
    whatsappFallbackInstance: evolutionFallbackInstance || null,
    whatsappFallbackState: null,
    whatsappLastCheckedAt: null,
    whatsappLastError: null,
    whatsappDisconnectedSince: null,
    dbLastCheckedAt: null,
    dbLastError: null,
    dbLatencyMs: null,
    dbDatabaseName: null,
    dbServerTime: null,
    dbDisconnectedSince: null,
    outboxLastCheckedAt: null,
    outboxLastError: null,
    lastDeliveredAt: null,
    lastDeliveredEventType: null,
    lastDeliveredSource: null,
    telegramEnabled: false,
    telegramLastPollAt: null,
    telegramLastUpdateAt: null,
    telegramLastCommandAt: null,
    telegramLastCommand: null,
    telegramLastError: null,
  };
}

export function applySourceHealthUpdate(
  monitor = {},
  {
    source = "",
    ok = false,
    error = null,
    checkedAt = null,
  } = {},
) {
  const state = monitor?.sourceFailures?.[source];
  if (!state) return null;

  if (ok) {
    state.consecutiveFailures = 0;
    state.lastSuccessAt = checkedAt;
    state.lastError = null;
    state.disconnectedSince = null;
    return state;
  }

  state.consecutiveFailures += 1;
  state.lastFailureAt = checkedAt;
  state.lastError = error || "unknown";
  if (!state.disconnectedSince) {
    state.disconnectedSince = checkedAt || null;
  }
  return state;
}

export function getSourceFailureSnapshot(monitor = {}) {
  return Object.fromEntries(
    Object.entries(monitor.sourceFailures || {}).map(([source, state]) => [
      source,
      { ...state },
    ]),
  );
}
