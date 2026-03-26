import { summarizeNotifierTargets } from "./notifier-target.js";

export function createHealthSnapshotBuilders({
  loadNotifierState,
  databaseEnabled = false,
  runtimeState,
  monitor,
  activeSourceNames = [],
  configuredNotifierTransports = [],
  targetChatIds,
  locations,
  delivered,
  notifierDedupeGate,
  seenSourceAlerts,
  inFlight,
  evolutionInstance,
  evolutionFallbackInstance,
  debugCaptureStores,
  summarizeDebugCaptureStores,
  pagerDuty,
  getSourceFailureSnapshot,
  getRealtimeSourcesSnapshot = () => ({}),
  getLatestAlertFlowSnapshot = () => null,
  checkDatabaseHealth,
  getOutboxStatsSnapshot,
  pruneDeliveredKeys,
  toIsoString,
} = {}) {
  function getNotifierStateSnapshot() {
    return loadNotifierState();
  }

  function formatDisconnectedSince(timestampMs) {
    return Number.isFinite(timestampMs) ? toIsoString(timestampMs) : null;
  }

  function getConfiguredTransports() {
    return [...new Set(
      (Array.isArray(configuredNotifierTransports) ? configuredNotifierTransports : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => value === "whatsapp" || value === "telegram"),
    )];
  }

  function isTransportEnabled(transport) {
    return getConfiguredTransports().includes(transport);
  }

  function buildOpsDestinationStatus() {
    return summarizeNotifierTargets(targetChatIds);
  }

  function getActiveSourceNames() {
    return [...new Set(
      (Array.isArray(activeSourceNames) ? activeSourceNames : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    )];
  }

  function buildOpsSenderStatus(notifierState = {}) {
    const transports = getConfiguredTransports();
    const whatsappEnabled = transports.includes("whatsapp");
    const telegramEnabled = transports.includes("telegram");

    if (whatsappEnabled && telegramEnabled) {
      return {
        label: notifierState.whatsappActiveInstance || monitor.whatsappActiveInstance || "whatsapp + telegram-bot",
      };
    }

    if (whatsappEnabled) {
      return {
        label: notifierState.whatsappActiveInstance || monitor.whatsappActiveInstance || "whatsapp",
      };
    }

    if (telegramEnabled) {
      return {
        label: "telegram-bot",
      };
    }

    return {
      label: notifierState.whatsappActiveInstance || monitor.whatsappActiveInstance || "unknown",
    };
  }

  function buildOpsWhatsAppStatus(notifierState = {}) {
    const enabled = isTransportEnabled("whatsapp");
    if (!enabled) {
      return {
        enabled: false,
        activeInstance: null,
        primaryInstance: null,
        primaryState: null,
        fallbackInstance: null,
        fallbackState: null,
        connectionState: null,
        lastCheckedAt: null,
        lastError: null,
        disconnectedSince: null,
      };
    }

    return {
      enabled: true,
      activeInstance: notifierState.whatsappActiveInstance || monitor.whatsappActiveInstance,
      primaryInstance: notifierState.whatsappPrimaryInstance || monitor.whatsappPrimaryInstance,
      primaryState: notifierState.whatsappPrimaryState || monitor.whatsappPrimaryState,
      fallbackInstance: notifierState.whatsappFallbackInstance || monitor.whatsappFallbackInstance,
      fallbackState: notifierState.whatsappFallbackState || monitor.whatsappFallbackState,
      connectionState: notifierState.whatsappConnectionState || monitor.whatsappConnectionState,
      lastCheckedAt: notifierState.whatsappLastCheckedAt || monitor.whatsappLastCheckedAt,
      lastError: notifierState.whatsappLastError || monitor.whatsappLastError,
      disconnectedSince: notifierState.whatsappDisconnectedSince
        || formatDisconnectedSince(monitor.whatsappDisconnectedSince),
    };
  }

  function buildOpsTelegramStatus(notifierState = {}) {
    const enabled = isTransportEnabled("telegram");
    return {
      enabled,
      lastCheckedAt: enabled
        ? (monitor.telegramLastPollSuccessAt || notifierState.telegramLastCheckedAt || null)
        : null,
      lastError: enabled
        ? (monitor.telegramLastError || notifierState.telegramLastError || null)
        : null,
      lastDeliveredChatId: enabled ? (notifierState.telegramLastDeliveredChatId || null) : null,
    };
  }

  function buildOpsRealtimeSourceStatuses() {
    const realtimeSources = getRealtimeSourcesSnapshot();
    return Object.fromEntries(
      Object.entries(realtimeSources || {}).map(([source, status]) => [
        source,
        {
          enabled: true,
          connected: Boolean(status?.connected),
          receivedCount: Number(status?.receivedCount || 0),
          alertCount: Number(status?.alertCount || 0),
          parseErrorCount: Number(status?.parseErrorCount || 0),
          lastMessageAt: status?.lastMessageAt || null,
          lastAlertAt: status?.lastAlertAt || null,
          lastParseError: status?.lastParseError || null,
          lastConnectionError: status?.lastConnectionError || null,
          brokerUrl: status?.brokerUrl || null,
          lastTopic: status?.lastTopic || null,
          topicsSubscribedAt: status?.topicsSubscribedAt || null,
          topicsError: status?.topicsError || null,
        },
      ]),
    );
  }

  function buildOpsOutboxStatus(outboxStats = null) {
    if (!outboxStats) return null;

    return {
      pending: Number(outboxStats.pending || 0),
      processing: Number(outboxStats.processing || 0),
      failed: Number(outboxStats.failed || 0),
      uncertain: Number(outboxStats.uncertain || 0),
      deadLettered: Number(outboxStats.deadLettered || 0),
      latency: outboxStats.latency || null,
    };
  }

  function buildOpsDatabaseStatus() {
    if (!databaseEnabled) return null;

    return {
      enabled: true,
      lastCheckedAt: monitor.dbLastCheckedAt,
      lastError: monitor.dbLastError,
      latencyMs: monitor.dbLatencyMs,
    };
  }

  function buildOpsPollStatus() {
    return {
      lastPollAt: monitor.lastPollAt,
      lastPollSuccessAt: monitor.lastPollSuccessAt,
      lastPollErrorAt: monitor.lastPollErrorAt,
      lastPollError: monitor.lastPollError,
      consecutivePollErrors: Number(monitor.consecutivePollErrors || 0),
    };
  }

  function buildOpsStatusPayload({ outboxStats = null, includeLatestFlow = false } = {}) {
    const notifierState = getNotifierStateSnapshot();
    const sender = buildOpsSenderStatus(notifierState);
    const whatsapp = buildOpsWhatsAppStatus(notifierState);
    const telegram = buildOpsTelegramStatus(notifierState);
    const realtimeSources = buildOpsRealtimeSourceStatuses();
    return {
      deliveryEnabled: runtimeState.deliveryEnabled,
      activeSources: getActiveSourceNames(),
      transports: getConfiguredTransports(),
      destinations: buildOpsDestinationStatus(),
      sender,
      whatsapp,
      telegram,
      activeInstance: notifierState.whatsappActiveInstance || monitor.whatsappActiveInstance,
      primaryState: notifierState.whatsappPrimaryState || monitor.whatsappPrimaryState,
      fallbackState: notifierState.whatsappFallbackState || monitor.whatsappFallbackState,
      lastDeliveredAt: notifierState.lastDeliveredAt || monitor.lastDeliveredAt,
      lastDeliveredEventType: notifierState.lastDeliveredEventType || monitor.lastDeliveredEventType,
      lastDeliveredSource: notifierState.lastDeliveredSource || monitor.lastDeliveredSource,
      lastDeliveredTransport: notifierState.lastDeliveredTransport || null,
      latestFlow: includeLatestFlow ? getLatestAlertFlowSnapshot() : null,
      targets: targetChatIds,
      poll: buildOpsPollStatus(),
      database: buildOpsDatabaseStatus(),
      outbox: buildOpsOutboxStatus(outboxStats),
      sourceFailures: getSourceFailureSnapshot(),
      realtimeSources,
    };
  }

  async function collectOpsStatusSnapshot() {
    if (databaseEnabled) {
      try {
        await checkDatabaseHealth();
      } catch {}
    }

    let outboxStats = null;
    try {
      outboxStats = await getOutboxStatsSnapshot(Date.now(), { includeLatency: false });
    } catch {}

    return buildOpsStatusPayload({ outboxStats, includeLatestFlow: false });
  }

  function buildDatabaseHealthSnapshot() {
    return {
      enabled: Boolean(databaseEnabled),
      lastCheckedAt: monitor.dbLastCheckedAt,
      lastError: monitor.dbLastError,
      latencyMs: monitor.dbLatencyMs,
      databaseName: monitor.dbDatabaseName,
      serverTime: monitor.dbServerTime,
      disconnectedSince: formatDisconnectedSince(monitor.dbDisconnectedSince),
    };
  }

  function buildMonitoringSnapshot(notifierState) {
    return {
      deliveryEnabled: monitor.deliveryEnabled,
      deliveryUpdatedAt: monitor.deliveryUpdatedAt,
      deliveryUpdatedBy: monitor.deliveryUpdatedBy,
      lastPollAt: monitor.lastPollAt,
      lastPollSuccessAt: monitor.lastPollSuccessAt,
      lastPollErrorAt: monitor.lastPollErrorAt,
      lastPollError: monitor.lastPollError,
      consecutivePollErrors: monitor.consecutivePollErrors,
      whatsappActiveInstance: notifierState.whatsappActiveInstance || monitor.whatsappActiveInstance,
      whatsappPrimaryInstance: notifierState.whatsappPrimaryInstance || monitor.whatsappPrimaryInstance,
      whatsappPrimaryState: notifierState.whatsappPrimaryState || monitor.whatsappPrimaryState,
      whatsappFallbackInstance: notifierState.whatsappFallbackInstance || monitor.whatsappFallbackInstance,
      whatsappFallbackState: notifierState.whatsappFallbackState || monitor.whatsappFallbackState,
      whatsappConnectionState: notifierState.whatsappConnectionState || monitor.whatsappConnectionState,
      whatsappLastCheckedAt: notifierState.whatsappLastCheckedAt || monitor.whatsappLastCheckedAt,
      whatsappLastError: notifierState.whatsappLastError || monitor.whatsappLastError,
      dbLastCheckedAt: monitor.dbLastCheckedAt,
      dbLastError: monitor.dbLastError,
      dbLatencyMs: monitor.dbLatencyMs,
      dbDatabaseName: monitor.dbDatabaseName,
      dbServerTime: monitor.dbServerTime,
      dbDisconnectedSince: formatDisconnectedSince(monitor.dbDisconnectedSince),
      outboxLastCheckedAt: monitor.outboxLastCheckedAt,
      outboxLastError: monitor.outboxLastError,
      lastDeliveredAt: notifierState.lastDeliveredAt || monitor.lastDeliveredAt,
      lastDeliveredEventType: notifierState.lastDeliveredEventType || monitor.lastDeliveredEventType,
      lastDeliveredSource: notifierState.lastDeliveredSource || monitor.lastDeliveredSource,
      whatsappDisconnectedSince: notifierState.whatsappDisconnectedSince
        || (Number.isFinite(monitor.whatsappDisconnectedSince)
          ? toIsoString(monitor.whatsappDisconnectedSince)
          : null),
      telegramEnabled: monitor.telegramEnabled,
      telegramLastPollAt: monitor.telegramLastPollAt,
      telegramLastPollSuccessAt: monitor.telegramLastPollSuccessAt,
      telegramLastUpdateAt: monitor.telegramLastUpdateAt,
      telegramLastCommandAt: monitor.telegramLastCommandAt,
      telegramLastCommand: monitor.telegramLastCommand,
      telegramLastError: monitor.telegramLastError,
      sourceFailures: getSourceFailureSnapshot(),
    };
  }

  async function buildHealthResponse() {
    pruneDeliveredKeys();
    await checkDatabaseHealth();
    const notifierState = getNotifierStateSnapshot();
    const outboxStats = await getOutboxStatsSnapshot(Date.now(), { includeLatency: false });

    return {
      ok: true,
      delivered: delivered.size,
      notifierDelivered: notifierDedupeGate.size,
      seenSourceAlerts: seenSourceAlerts.size,
      inFlight: inFlight.size,
      notifierInFlight: notifierDedupeGate.inFlightSize,
      instance: notifierState.whatsappActiveInstance || evolutionInstance,
      primaryInstance: notifierState.whatsappPrimaryInstance || evolutionInstance,
      fallbackInstance: notifierState.whatsappFallbackInstance || evolutionFallbackInstance || null,
      connectionState: notifierState.whatsappConnectionState || null,
      primaryConnectionState: notifierState.whatsappPrimaryState || null,
      fallbackConnectionState: notifierState.whatsappFallbackState || null,
      transports: getConfiguredTransports(),
      destinations: buildOpsDestinationStatus(),
      locations,
      targets: targetChatIds,
      debugCapture: summarizeDebugCaptureStores(debugCaptureStores),
      sources: getRealtimeSourcesSnapshot(),
      database: buildDatabaseHealthSnapshot(),
      outbox: outboxStats,
      notifier: notifierState,
      pagerDuty: pagerDuty.status(),
      monitoring: buildMonitoringSnapshot(notifierState),
    };
  }

  function buildHealthErrorResponse(err) {
    return {
      ok: false,
      error: err.message,
      sources: getRealtimeSourcesSnapshot(),
      database: buildDatabaseHealthSnapshot(),
      monitoring: {
        dbLastCheckedAt: monitor.dbLastCheckedAt,
        dbLastError: monitor.dbLastError,
        dbLatencyMs: monitor.dbLatencyMs,
        dbDatabaseName: monitor.dbDatabaseName,
        dbServerTime: monitor.dbServerTime,
        dbDisconnectedSince: formatDisconnectedSince(monitor.dbDisconnectedSince),
        outboxLastCheckedAt: monitor.outboxLastCheckedAt,
        outboxLastError: monitor.outboxLastError,
      },
    };
  }

  return {
    getNotifierStateSnapshot,
    buildOpsStatusPayload,
    collectOpsStatusSnapshot,
    formatDisconnectedSince,
    buildDatabaseHealthSnapshot,
    buildHealthResponse,
    buildHealthErrorResponse,
  };
}
