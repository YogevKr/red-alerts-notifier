import { checkDbConnection, createDbPool } from "./db.js";
import { DeliveryDedupeGate } from "./delivery-dedupe.js";
import { summarizeDebugCaptureStores } from "./debug-capture.js";
import {
  PagerDutyIncidentManager,
  hasExceededThreshold,
  collectStaleNotifierTransports,
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

function toIsoString(timestampMs = Date.now()) {
  return new Date(timestampMs).toISOString();
}

function formatDisconnectedSinceValue(timestampMs) {
  return Number.isFinite(timestampMs) ? toIsoString(timestampMs) : null;
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
    getLatestAlertFlowSnapshot,
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
  const dbPool = notificationOutboxEnabled && database.pollerUrl
    ? createDbPool({
      connectionString: database.pollerUrl,
      applicationName: "red-alerts-poller",
    })
    : null;
  const notificationOutbox = notificationOutboxEnabled && dbPool
    ? new PostgresNotificationOutbox({ pool: dbPool })
    : null;
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
    collectStaleNotifierTransports,
    hasNotifierTransport,
    whatsappDisconnectThresholdMs: pagerDutyConfig.whatsappDisconnectThresholdMs,
    sourceFailureThreshold: pagerDutyConfig.sourceFailureThreshold,
    pollErrorThreshold: pagerDutyConfig.pollErrorThreshold,
    dbDisconnectThresholdMs: pagerDutyConfig.dbDisconnectThresholdMs,
    outboxBacklogThresholdMs: pagerDutyConfig.outboxBacklogThresholdMs,
    notifierStaleThresholdMs: pagerDutyConfig.notifierStaleThresholdMs,
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
  const scopedBuildAlertLogFields = (alert, matched, options = {}) =>
    buildAlertLogFields(alert, matched, { ...options, buildSeenSourceAlertKey });
  const alertSinks = configuredAlertSinkNames.map((sinkName) => {
    if (sinkName === ALERT_SINK_NAMES.NOTIFICATION_OUTBOX) {
      return createNotificationOutboxAlertSink({
        notificationOutbox,
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
    toIsoString,
    syncPagerDutyHealth,
    summarizeSourceResults,
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
      active_sources: sources.activeNames,
      oref_mqtt_enabled: orefMqtt.enabled,
      oref_mqtt_topics: orefMqtt.topics,
      oref_mqtt_raw_log_enabled: orefMqtt.rawLogEnabled,
      tzevaadom_enabled: tzevaadom.enabled,
      tzevaadom_raw_log_enabled: tzevaadom.rawLogEnabled,
      notification_outbox_enabled: notificationOutboxEnabled,
      debug_capture_enabled: debugCaptureStores.enabled,
      log_suppression_interval_ms: timing.logSuppressionIntervalMs,
    });
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
    setInterval(poll, timing.pollTickIntervalMs);
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
      setDeliveryEnabled,
      buildOpsDeliveryResponse,
      buildOpsSendPresetResponse,
      buildHealthResponse,
      buildHealthErrorResponse,
    });
  }

  return {
    start,
  };
}
