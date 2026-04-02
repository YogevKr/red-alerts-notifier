import { checkDbConnection, createDbPool } from "./db.js";
import { DeliveryDedupeGate } from "./delivery-dedupe.js";
import { summarizeDebugCaptureStores } from "./debug-capture.js";
import {
  PagerDutyIncidentManager,
  hasExceededThreshold,
  getOutboxBacklogAgeMs,
  hasOutboxBacklogExceededThreshold,
  hasNotifierTransport,
} from "./pagerduty.js";
import {
  EVENT_TYPES,
  buildEvolutionHeaders,
  resolveTargetChatIds,
  detectEventType,
  resolveEventType,
  isDeliverableEventType,
  isExplicitlySupportedAlert,
  hashDeliveryKey,
  parseEventDate,
    shouldSuppressDuplicateDelivery,
    getConnectionState,
    getInstances,
    buildDeliveryKey,
    buildSemanticAlertKey,
    matchLocations,
    chooseEvolutionInstance,
  } from "./lib.js";
import {
  fetchSourceSnapshot,
  sortAlertsByDate,
} from "./sources.js";
import { simulateAlerts } from "./simulate.js";
import { PostgresNotificationOutbox } from "./notification-outbox.js";
import { loadNotifierState } from "./notifier-service.js";
import { createLogger, createSuppressionReporter } from "./log.js";
import { startHttpServer } from "./http-server.js";
import {
  ALERT_SINK_NAMES,
  createLogAlertSink,
  createNotificationOutboxAlertSink,
} from "./alert-sinks.js";
import { createPagerDutyRuntime } from "./pagerduty-runtime.js";
import { createPollRuntime } from "./poll-runtime.js";
import { createEvolutionClient } from "./evolution-client.js";
import { buildAlertLogFields, buildTargetLogFields, createAlertEnqueuer } from "./alert-enqueue.js";
import { createAlertPipeline } from "./alert-pipeline.js";
import { getSourceFailureSnapshot } from "./monitor-state.js";
import {
  buildRealtimeSourcesSnapshot,
  collectRealtimeSourceResults,
  setRealtimeAlertHandler,
  startRealtimeSources,
} from "./source-runtime.js";
import { createPollerSourceSubsystem } from "./poller-source-subsystem.js";
import { createPollerHealthSubsystem } from "./poller-health-subsystem.js";
import { PostgresSourceEventLedger } from "./source-event-ledger.js";

function toIsoString(timestampMs = Date.now()) {
  return new Date(timestampMs).toISOString();
}

function formatDisconnectedSinceValue(timestampMs) {
  return Number.isFinite(timestampMs) ? toIsoString(timestampMs) : null;
}

function normalizeOptionalString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

export function createPollScheduler({
  poll = async () => {},
  logger = console,
  now = () => Date.now(),
  staleThresholdMs = 20_000,
} = {}) {
  let activeRun = null;
  let queued = false;
  let activeStartedAtMs = null;
  let busyLogged = false;
  let staleWarned = false;

  async function drainQueue() {
    do {
      queued = false;
      busyLogged = false;
      staleWarned = false;
      activeStartedAtMs = now();
      await poll();
    } while (queued);
  }

  function schedule(trigger = "tick") {
    if (activeRun) {
      queued = true;
      const startedAtMs = Number.isFinite(activeStartedAtMs) ? activeStartedAtMs : now();
      const runningForMs = Math.max(0, now() - startedAtMs);
      if (!busyLogged) {
        busyLogged = true;
        logger.debug?.("poll_skipped_busy", {
          trigger,
          running_for_ms: runningForMs,
        });
      }
      if (!staleWarned && runningForMs >= staleThresholdMs) {
        staleWarned = true;
        logger.warn?.("poll_running_long", {
          trigger,
          running_for_ms: runningForMs,
          stale_threshold_ms: staleThresholdMs,
        });
      }
      return activeRun;
    }

    activeRun = (async () => {
      try {
        await drainQueue();
      } finally {
        activeRun = null;
        queued = false;
        activeStartedAtMs = null;
        busyLogged = false;
        staleWarned = false;
      }
    })();

    return activeRun;
  }

  return {
    schedule,
  };
}

export function createPollerApp(config = {}) {
  const {
    locations = [],
    targetChatIds = [],
    testChatIds = [],
    configuredNotifierTransports = [],
    alertSinks: alertSinkConfig = {},
    evolution = {},
    timing = {},
    delivery = {},
    debugCapture = {},
    sources = {},
    orefMqtt = {},
    tzevaadom = {},
    pagerDuty: pagerDutyConfig = {},
    database = {},
    sourceEventLedger: sourceEventLedgerConfig = {},
    paths = {},
    limits = {},
  } = config;
  const logger = createLogger("poller");
  const notifierDedupeGate = new DeliveryDedupeGate({
    filePath: paths.notifierDeliveryStorePath,
    maxEntries: limits.maxDeliveredKeys,
    ttlMs: limits.deliveredKeyTtlMs,
    label: "notifier delivery store",
  });
  const inFlight = new Set();
  const {
    sourceConfigs,
    debugCaptureStores,
    runtimeStores,
    monitor,
    realtimeSourceRuntimes,
    captureEntriesBySource,
    listDebugCaptureEntries,
    setRealtimeHealthHandler,
  } = createPollerSourceSubsystem({
    sources,
    timing,
    debugCapture,
    delivery,
    orefMqtt,
    tzevaadom,
    paths,
    limits,
    locations,
    evolution,
    logger,
    toIsoString,
    hashDeliveryKey,
    shouldSuppressDuplicateDelivery,
  });
  const {
    runtimeState,
    delivered,
    seenSourceAlerts,
    bindMonitor,
    setDeliveryEnabled,
    buildRecentReceivedTownMessage,
    buildRecentReceivedMessage,
    buildRecentSentMessage,
    buildRecentFlowMessage,
    buildRecentMissMessage,
    getLatestAlertFlowSnapshot,
    setRecentSourceEventsLoader,
    hasDeliveredKey,
    rememberRecentAlertFlow,
    rememberDeliveredKey,
    pruneDeliveredKeys,
    buildSeenSourceAlertKey,
    hasSeenSourceAlertKey,
    rememberSeenSourceAlertKey,
    pruneSeenSourceAlertKeys,
  } = runtimeStores;
  bindMonitor(monitor);

  const pagerDuty = new PagerDutyIncidentManager({
    routingKey: pagerDutyConfig.routingKey,
    eventsUrl: pagerDutyConfig.eventsUrl,
    source: pagerDutyConfig.source,
    component: pagerDutyConfig.component,
    group: pagerDutyConfig.group,
    className: pagerDutyConfig.className,
    filePath: paths.pagerDutyStatePath,
  });
  const configuredAlertSinkNames = Array.isArray(alertSinkConfig.names)
    ? [...new Set(alertSinkConfig.names)]
    : [];
  const notificationOutboxEnabled = configuredAlertSinkNames.includes(
    ALERT_SINK_NAMES.NOTIFICATION_OUTBOX,
  );
  const dbRequired = notificationOutboxEnabled || sourceEventLedgerConfig.enabled;
  const dbPool = dbRequired && database.pollerUrl
    ? createDbPool({
      connectionString: database.pollerUrl,
      applicationName: "red-alerts-poller",
    })
    : null;
  const notificationOutbox = notificationOutboxEnabled && dbPool
    ? new PostgresNotificationOutbox({ pool: dbPool })
    : null;
  const sourceEventLedger = sourceEventLedgerConfig.enabled && dbPool
    ? new PostgresSourceEventLedger({ pool: dbPool })
    : null;
  setRecentSourceEventsLoader(async (activeSources, limitPerSource) => {
    if (!sourceEventLedger) return [];
    return sourceEventLedger.listRecentBySource(activeSources, limitPerSource);
  });
  const suppressionReporter = createSuppressionReporter(logger, {
    intervalMs: timing.logSuppressionIntervalMs,
  });
  const {
    ensureEvolutionInstance,
    getEvolutionConnectInfo,
    resolveActiveEvolutionInstance,
  } = createEvolutionClient({
    baseUrl: evolution.url,
    apiKey: evolution.apiKey,
    timeoutMs: evolution.timeoutMs,
    primaryInstance: evolution.instance,
    fallbackInstance: evolution.fallbackInstance,
    buildEvolutionHeaders,
    getInstances,
    getConnectionState,
    chooseEvolutionInstance,
    monitor,
  });
  const {
    checkDatabaseHealth,
    getOutboxStatsSnapshot,
    syncPagerDutyHealth,
  } = createPagerDutyRuntime({
    pagerDuty,
    monitor,
    dbPool,
    notificationOutbox,
    logger,
    configuredNotifierTransports,
    activeSourceNames: sources.activeNames,
    toIsoString,
    formatDisconnectedSince: formatDisconnectedSinceValue,
    getSourceFailureSnapshot: () => getSourceFailureSnapshot(monitor),
    getNotifierStateSnapshot: () => loadNotifierState(),
    resolveActiveEvolutionInstance,
    evolutionInstance: evolution.instance,
    checkDbConnection,
    hasExceededThreshold,
    getOutboxBacklogAgeMs,
    hasOutboxBacklogExceededThreshold,
    hasNotifierTransport,
    whatsappDisconnectThresholdMs: pagerDutyConfig.whatsappDisconnectThresholdMs,
    sourceFailureThreshold: pagerDutyConfig.sourceFailureThreshold,
    pollErrorThreshold: pagerDutyConfig.pollErrorThreshold,
    dbDisconnectThresholdMs: pagerDutyConfig.dbDisconnectThresholdMs,
    outboxBacklogThresholdMs: pagerDutyConfig.outboxBacklogThresholdMs,
    notifierStaleThresholdMs: pagerDutyConfig.notifierStaleThresholdMs,
    telegramBotStaleThresholdMs: pagerDutyConfig.telegramBotStaleThresholdMs,
    tzevaadomDisconnectThresholdMs: pagerDutyConfig.tzevaadomDisconnectThresholdMs,
  });
  setRealtimeHealthHandler(async (update) => {
    const checkedAtMs = Date.parse(update.checkedAt || "");
    await syncPagerDutyHealth(Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now());
  });
  const {
    buildOpsStatusResponse,
    buildOpsTargetLabel,
    buildOpsDeliveryResponse,
    buildOpsSendPresetResponse,
    buildHealthResponse,
    buildHealthErrorResponse,
  } = createPollerHealthSubsystem({
    loadNotifierState,
    databaseEnabled: Boolean(dbPool),
    runtimeState,
    monitor,
    activeSourceNames: sources.activeNames,
    configuredNotifierTransports,
    targetChatIds,
    locations,
    delivered,
    notifierDedupeGate,
    seenSourceAlerts,
    inFlight,
    evolutionInstance: evolution.instance,
    evolutionFallbackInstance: evolution.fallbackInstance,
    debugCaptureStores,
    summarizeDebugCaptureStores,
    pagerDuty,
    getSourceFailureSnapshot: () => getSourceFailureSnapshot(monitor),
    getRealtimeSourcesSnapshot: () => buildRealtimeSourcesSnapshot(realtimeSourceRuntimes),
    getLatestAlertFlowSnapshot,
    checkDatabaseHealth,
    getOutboxStatsSnapshot,
    pruneDeliveredKeys,
    toIsoString,
  });
  function setTelegramManagementState(update = {}) {
    const enabled = typeof update.enabled === "boolean" ? update.enabled : monitor.telegramEnabled;
    monitor.telegramEnabled = Boolean(enabled);
    monitor.telegramLastPollAt = normalizeOptionalString(update.lastPollAt) || monitor.telegramLastPollAt || null;
    monitor.telegramLastPollSuccessAt =
      normalizeOptionalString(update.lastPollSuccessAt) || monitor.telegramLastPollSuccessAt || null;
    monitor.telegramLastUpdateAt =
      normalizeOptionalString(update.lastUpdateAt) || monitor.telegramLastUpdateAt || null;
    monitor.telegramLastCommandAt =
      normalizeOptionalString(update.lastCommandAt) || monitor.telegramLastCommandAt || null;
    monitor.telegramLastCommand =
      normalizeOptionalString(update.lastCommand) || monitor.telegramLastCommand || null;
    monitor.telegramLastError =
      Object.hasOwn(update, "lastError")
        ? normalizeOptionalString(update.lastError)
        : monitor.telegramLastError || null;
    return {
      enabled: monitor.telegramEnabled,
      lastPollAt: monitor.telegramLastPollAt,
      lastPollSuccessAt: monitor.telegramLastPollSuccessAt,
      lastUpdateAt: monitor.telegramLastUpdateAt,
      lastCommandAt: monitor.telegramLastCommandAt,
      lastCommand: monitor.telegramLastCommand,
      lastError: monitor.telegramLastError,
    };
  }
  function setNotifierWorkerState(update = {}) {
    const enabled = typeof update.enabled === "boolean"
      ? update.enabled
      : monitor.notifierWorkerEnabled;
    monitor.notifierWorkerEnabled = Boolean(enabled);
    monitor.notifierWorkerId =
      normalizeOptionalString(update.workerId) || monitor.notifierWorkerId || null;
    monitor.notifierWorkerWakeupMode =
      normalizeOptionalString(update.wakeupMode) || monitor.notifierWorkerWakeupMode || null;
    monitor.notifierWorkerLastHeartbeatAt =
      normalizeOptionalString(update.lastHeartbeatAt) || monitor.notifierWorkerLastHeartbeatAt || null;
    monitor.notifierWorkerLastStatusRefreshAt =
      normalizeOptionalString(update.lastStatusRefreshAt)
      || monitor.notifierWorkerLastStatusRefreshAt
      || null;
    monitor.notifierWorkerLastError =
      Object.hasOwn(update, "lastError")
        ? normalizeOptionalString(update.lastError)
        : monitor.notifierWorkerLastError || null;
    return {
      enabled: monitor.notifierWorkerEnabled,
      workerId: monitor.notifierWorkerId,
      wakeupMode: monitor.notifierWorkerWakeupMode,
      lastHeartbeatAt: monitor.notifierWorkerLastHeartbeatAt,
      lastStatusRefreshAt: monitor.notifierWorkerLastStatusRefreshAt,
      lastError: monitor.notifierWorkerLastError,
    };
  }
  const scopedBuildAlertLogFields = (alert, matched, options = {}) =>
    buildAlertLogFields(alert, matched, { ...options, buildSeenSourceAlertKey });
  const alertSinks = configuredAlertSinkNames.map((sinkName) => {
    if (sinkName === ALERT_SINK_NAMES.NOTIFICATION_OUTBOX) {
      return createNotificationOutboxAlertSink({
        notificationOutbox,
        whatsappTargetStaggerMs: alertSinkConfig.whatsappTargetStaggerMs,
        logger,
        suppressionReporter,
        buildAlertLogFields: scopedBuildAlertLogFields,
        buildTargetLogFields,
      });
    }

    return createLogAlertSink({
      logger,
      buildAlertLogFields: scopedBuildAlertLogFields,
    });
  });
  const {
    ensureAlertSinksReady,
    recordDuplicateAlert,
    enqueuePresetAlert,
    enqueueAlertNotifications,
    buildAlertLogFields: buildRuntimeAlertLogFields,
    summarizeSourceResults,
  } = createAlertEnqueuer({
    logger,
    pagerDuty,
    suppressionReporter,
    runtimeState,
    locations,
    targetChatIds,
    alertSinks,
    buildOpsTargetLabel,
    buildSeenSourceAlertKey,
  });
  const {
    ingestAlert,
    ingestAlerts,
    seedAlerts,
  } = createAlertPipeline({
    suppressionReporter,
    matchLocations,
    locations,
    buildSeenSourceAlertKey,
    hasSeenSourceAlertKey,
    rememberSeenSourceAlertKey,
    enqueueAlertNotifications,
    targetChatIds,
    parseEventDate,
    buildAlertLogFields: buildRuntimeAlertLogFields,
    detectEventType,
    buildSemanticAlertKey,
    isExplicitlySupportedAlert,
    isDeliverableEventType,
    rememberRecentAlertFlow,
    recordSourceEvent: async (entry = {}) => {
      if (!sourceEventLedger) return;
      try {
        await sourceEventLedger.record(entry);
      } catch (err) {
        logger.warn("source_event_ledger_record_failed", {
          source: entry.source || "unknown",
          source_key: entry.sourceKey || "",
          outcome: entry.outcome || "unknown",
          error: err,
        });
      }
    },
    toIsoString,
    hasDeliveredKey,
    rememberDeliveredKey,
    recordDuplicateAlert,
    hashDeliveryKey,
    buildDeliveryKey,
  });
  function handleRealtimeAlert(alert) {
    void ingestAlert(alert).catch((err) => {
      logger.error("realtime_alert_process_failed", {
        ...buildRuntimeAlertLogFields(alert, matchLocations(alert, locations)),
        error: err,
      });
    });
  }
  setRealtimeAlertHandler(realtimeSourceRuntimes, handleRealtimeAlert);
  const {
    seedExistingAlerts,
    poll,
  } = createPollRuntime({
    logger,
    monitor,
    suppressionReporter,
    sourceConfigs,
    collectRealtimeSourceResults: () => collectRealtimeSourceResults(realtimeSourceRuntimes),
    sourceTimeoutMs: timing.sourceTimeoutMs,
    fetchSourceSnapshot,
    sortAlertsByDate,
    captureEntriesBySource,
    debugCaptureStores,
    seedAlerts,
    ingestAlerts,
    pruneSourceEventLedger: async ({ nowMs } = {}) => {
      if (!sourceEventLedger) return 0;
      const deletedRowCount = await sourceEventLedger.prune({ nowMs });
      if (deletedRowCount > 0) {
        logger.info("source_event_ledger_pruned", {
          deleted_row_count: deletedRowCount,
        });
      }
      return deletedRowCount;
    },
    toIsoString,
    syncPagerDutyHealth,
    summarizeSourceResults,
  });
  const pollScheduler = createPollScheduler({
    poll,
    logger,
    staleThresholdMs: Math.max(20_000, timing.sourceTimeoutMs * 4),
  });

  async function start() {
    const shouldManageWhatsApp = notificationOutboxEnabled
      && configuredNotifierTransports.includes("whatsapp");
    logger.info("poller_starting", {
      poll_interval_ms: timing.defaultPollIntervalMs,
      poll_tick_interval_ms: timing.pollTickIntervalMs,
      oref_alerts_poll_interval_ms: timing.orefAlertsPollIntervalMs,
      oref_history_poll_interval_ms: timing.orefHistoryPollIntervalMs,
      locations,
      targets: targetChatIds,
      target_transports: [...new Set(targetChatIds.map((chatId) => buildTargetLogFields(chatId).transport))],
      notifier_transports: configuredNotifierTransports,
      alert_sinks: configuredAlertSinkNames,
      source_event_ledger_enabled: Boolean(sourceEventLedger),
      active_sources: sources.activeNames,
      oref_mqtt_enabled: orefMqtt.enabled,
      oref_mqtt_topic_count: Array.isArray(orefMqtt.topics) ? orefMqtt.topics.length : 0,
      oref_mqtt_raw_log_enabled: orefMqtt.rawLogEnabled,
      tzevaadom_enabled: tzevaadom.enabled,
      tzevaadom_raw_log_enabled: tzevaadom.rawLogEnabled,
      notification_outbox_enabled: notificationOutboxEnabled,
      debug_capture_enabled: debugCaptureStores.enabled,
      log_suppression_interval_ms: timing.logSuppressionIntervalMs,
    });
    if (sourceEventLedgerConfig.enabled && !dbPool) {
      logger.warn("source_event_ledger_disabled_no_db", {
        database_configured: Boolean(database.pollerUrl),
      });
    }
    if (sourceEventLedger) {
      await sourceEventLedger.ensureSchema();
    }
    await ensureAlertSinksReady();
    logger.info("poller_alert_sinks_ready", {
      alert_sinks: configuredAlertSinkNames,
    });

    if (shouldManageWhatsApp) {
      try {
        await ensureEvolutionInstance();
        logger.info("evolution_instance_ready", {
          instance_name: evolution.instance,
        });
      } catch (err) {
        logger.warn("evolution_instance_not_ready", {
          instance_name: evolution.instance,
          error: err,
        });
      }
    }

    try {
      const { seededDeliveries, seededSourceAlerts } = await seedExistingAlerts();
      logger.info("poller_seed_completed", {
        seeded_delivery_keys: seededDeliveries,
        seeded_source_alerts: seededSourceAlerts,
      });
    } catch (err) {
      logger.warn("poller_seed_failed", {
        error: err,
      });
    }

    try {
      pruneSeenSourceAlertKeys();
    } catch {}

    await startRealtimeSources(realtimeSourceRuntimes, { timeoutMs: timing.sourceTimeoutMs });
    await syncPagerDutyHealth();
    logger.info("telegram_management_externalized");
    if (sourceConfigs.length === 0) {
      setInterval(() => {
        void pollScheduler.schedule("tick");
      }, timing.pollTickIntervalMs);
    } else {
      for (const source of sourceConfigs) {
        const sourceScheduler = createPollScheduler({
          poll: () => poll({ sourceNames: [source.name] }),
          logger,
          staleThresholdMs: Math.max(20_000, timing.sourceTimeoutMs * 4),
        });
        setInterval(() => {
          void sourceScheduler.schedule("tick");
        }, source.pollIntervalMs);
      }
    }
    startHttpServer({
      port: 3000,
      logger,
      locations,
      targetChatIds,
      testChatIds,
      eventTypes: EVENT_TYPES,
      resolveEventType,
      isDeliverableEventType,
      resolveTargetChatIds,
      enqueuePresetAlert,
      simulateAlerts,
      enqueueAlertNotifications,
      getEvolutionConnectInfo: async () => {
        if (!shouldManageWhatsApp) {
          throw new Error("WhatsApp management is unavailable without the notification_outbox sink");
        }
        return getEvolutionConnectInfo();
      },
      evolutionInstance: evolution.instance,
      summarizeDebugCaptureStores,
      debugCaptureStores,
      listDebugCaptureEntries,
      buildOpsStatusResponse,
      buildRecentReceivedMessage,
      buildRecentReceivedTownMessage,
      buildRecentSentMessage,
      buildRecentFlowMessage,
      buildRecentMissMessage,
      setDeliveryEnabled,
      buildOpsDeliveryResponse,
      buildOpsSendPresetResponse,
      setTelegramManagementState,
      setNotifierWorkerState,
      buildHealthResponse,
      buildHealthErrorResponse,
    });
  }

  return {
    start,
  };
}
