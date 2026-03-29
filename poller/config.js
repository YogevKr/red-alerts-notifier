import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfiguredAlertSinkNames } from "./alert-sinks.js";
import { parseBooleanEnv } from "./debug-capture.js";
import { parseLocations, parseChatTargets, resolveChatIds } from "./lib.js";
import { parseNotifierTarget } from "./notifier-target.js";
import {
  PAGERDUTY_EVENTS_URL as DEFAULT_PAGERDUTY_EVENTS_URL,
  parsePositiveIntEnv,
} from "./pagerduty.js";
import { SOURCE_CHANNELS } from "./sources.js";
import {
  buildSourceGroups,
  getConfigurableSourceNames,
  resolveActiveSourceNames as resolveConfiguredActiveSourceNames,
} from "./source-registry.js";

const MAX_DELIVERED_KEYS = 10000;
const DELIVERED_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SEEN_SOURCE_ALERTS = 50000;
const SEEN_SOURCE_ALERT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECENT_SENT = 100;
const CONFIGURABLE_SOURCE_NAMES = new Set(getConfigurableSourceNames());
const DEFAULT_OREF_MQTT_TOPICS = [
  "com.alert.meserhadash",
  "alerts",
  "all",
  "broadcast",
];
const DEFAULT_OREF_MQTT_ROTATE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_OREF_MQTT_LISTENER_COUNT = 2;

function parseCsvValues(csv = "") {
  return [...new Set(
    String(csv || "")
      .split(",")
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function parseCsvLowercaseValues(csv = "") {
  return parseCsvValues(csv).map((value) => value.toLowerCase());
}

function resolveActiveSourceNames({
  activeSourcesCsv = "",
  orefMqttEnabled = false,
  tzevaadomEnabled = false,
} = {}) {
  return resolveConfiguredActiveSourceNames({
    explicitNames: parseCsvLowercaseValues(activeSourcesCsv)
      .filter((name) => CONFIGURABLE_SOURCE_NAMES.has(name)),
    legacyEnabledNames: [
      ...(orefMqttEnabled ? [SOURCE_CHANNELS.OREF_MQTT] : []),
      ...(tzevaadomEnabled ? [SOURCE_CHANNELS.TZEVAADOM] : []),
    ],
  });
}

export function resolveConfiguredNotifierTransports(csv = "", chatIds = []) {
  const explicit = String(csv || "")
    .split(",")
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => value === "whatsapp" || value === "telegram");

  if (explicit.length > 0) {
    return [...new Set(explicit)];
  }

  const derived = [...new Set(
    (Array.isArray(chatIds) ? chatIds : [])
      .map((chatId) => parseNotifierTarget(chatId).transport)
      .filter(Boolean),
  )];

  return derived;
}

export function createPollerConfig(env = process.env) {
  const {
    EVOLUTION_URL = "http://evolution-api:8080",
    EVOLUTION_API_KEY = "",
    EVOLUTION_INSTANCE = "default",
    EVOLUTION_FALLBACK_INSTANCE = "",
    EVOLUTION_TIMEOUT_MS = "10000",
    WHATSAPP_TARGETS = "",
    WHATSAPP_CHAT_ID = "",
    WHATSAPP_NUMBER,
    WHATSAPP_TARGET_STAGGER_MS = "0",
    DELIVERY_ENABLED = "true",
    DEBUG_CAPTURE_ENABLED = "false",
    DEBUG_CAPTURE_TTL_HOURS = "24",
    DEBUG_CAPTURE_MAX_ENTRIES = "10000",
    TEST_NOTIFICATION_TARGETS = "",
    NOTIFIER_ACTIVE_TRANSPORTS = "",
    ALERT_SINKS = "",
    ACTIVE_SOURCES = "",
    OREF_MQTT_ENABLED = "false",
    OREF_MQTT_RECONNECT_MS = "5000",
    OREF_MQTT_ROTATE_MS = String(DEFAULT_OREF_MQTT_ROTATE_INTERVAL_MS),
    OREF_MQTT_LISTENER_COUNT = String(DEFAULT_OREF_MQTT_LISTENER_COUNT),
    OREF_MQTT_BROKER_URLS = "",
    OREF_MQTT_TOPICS = "",
    OREF_MQTT_RAW_LOG_ENABLED = "false",
    OREF_MQTT_RAW_LOG_MAX_ENTRIES = "500",
    TZEVAADOM_ENABLED = "false",
    TZEVAADOM_RECONNECT_MS = "5000",
    TZEVAADOM_RAW_LOG_ENABLED = "false",
    TZEVAADOM_RAW_LOG_MAX_ENTRIES = "500",
    LOG_SUPPRESSION_INTERVAL_MS = "60000",
    OREF_ALERTS_POLL_INTERVAL_MS = "",
    OREF_HISTORY_POLL_INTERVAL_MS = "",
    POLL_INTERVAL_MS = "10000",
    POLLER_DATABASE_URL = "",
    SOURCE_EVENT_LEDGER_ENABLED = "false",
    ALERT_LOCATIONS = "",
    PAGERDUTY_ROUTING_KEY = "",
    PAGERDUTY_EVENTS_URL = DEFAULT_PAGERDUTY_EVENTS_URL,
    PAGERDUTY_SOURCE = "red-alerts/poller",
    PAGERDUTY_COMPONENT = "poller",
    PAGERDUTY_GROUP = "red-alerts",
    PAGERDUTY_CLASS = "ops",
    PAGERDUTY_WHATSAPP_DISCONNECT_MS = "120000",
    PAGERDUTY_SOURCE_FAILURE_CYCLES = "6",
    PAGERDUTY_POLL_ERROR_CYCLES = "3",
    PAGERDUTY_DB_DISCONNECT_MS = "30000",
    PAGERDUTY_OUTBOX_BACKLOG_MS = "60000",
    PAGERDUTY_NOTIFIER_STALE_MS = "45000",
    PAGERDUTY_TELEGRAM_BOT_STALE_MS = "120000",
    PAGERDUTY_TZEVAADOM_DISCONNECT_MS = "300000",
  } = env;

  const appDir = dirname(fileURLToPath(import.meta.url));
  const locations = parseLocations(ALERT_LOCATIONS);
  const defaultPollIntervalMs = parsePositiveIntEnv(POLL_INTERVAL_MS, 10_000);
  const orefAlertsPollIntervalMs = parsePositiveIntEnv(
    OREF_ALERTS_POLL_INTERVAL_MS,
    defaultPollIntervalMs,
  );
  const orefHistoryPollIntervalMs = parsePositiveIntEnv(
    OREF_HISTORY_POLL_INTERVAL_MS,
    defaultPollIntervalMs,
  );
  const targetChatIds = resolveChatIds({
    targets: WHATSAPP_TARGETS,
    chatId: WHATSAPP_CHAT_ID,
    number: WHATSAPP_NUMBER,
  });
  const configuredTestChatIds = parseChatTargets(TEST_NOTIFICATION_TARGETS);
  const testChatIds = configuredTestChatIds.length > 0
    ? configuredTestChatIds
    : WHATSAPP_NUMBER
      ? resolveChatIds({ number: WHATSAPP_NUMBER })
      : targetChatIds;
  const configuredNotifierTransports = resolveConfiguredNotifierTransports(
    NOTIFIER_ACTIVE_TRANSPORTS,
    targetChatIds,
  );
  const configuredAlertSinkNames = resolveConfiguredAlertSinkNames(ALERT_SINKS, {
    databaseUrl: POLLER_DATABASE_URL,
  });
  const orefMqttEnabled = parseBooleanEnv(OREF_MQTT_ENABLED);
  const orefMqttReconnectDelayMs = parsePositiveIntEnv(OREF_MQTT_RECONNECT_MS, 5000);
  const orefMqttRotateIntervalMs = parsePositiveIntEnv(
    OREF_MQTT_ROTATE_MS,
    DEFAULT_OREF_MQTT_ROTATE_INTERVAL_MS,
  );
  const configuredOrefMqttBrokerUrls = parseCsvValues(OREF_MQTT_BROKER_URLS);
  const orefMqttListenerCount = configuredOrefMqttBrokerUrls.length > 0
    ? configuredOrefMqttBrokerUrls.length
    : parsePositiveIntEnv(OREF_MQTT_LISTENER_COUNT, DEFAULT_OREF_MQTT_LISTENER_COUNT);
  const configuredOrefMqttTopics = parseCsvValues(OREF_MQTT_TOPICS);
  const tzevaadomEnabled = parseBooleanEnv(TZEVAADOM_ENABLED);
  const tzevaadomReconnectDelayMs = parsePositiveIntEnv(TZEVAADOM_RECONNECT_MS, 5000);
  const activeSourceNames = resolveActiveSourceNames({
    activeSourcesCsv: ACTIVE_SOURCES,
    orefMqttEnabled,
    tzevaadomEnabled,
  });
  const activeSourceNameSet = new Set(activeSourceNames);
  const sourceGroups = buildSourceGroups(activeSourceNames);
  const debugCaptureTtlHours = Number.parseInt(DEBUG_CAPTURE_TTL_HOURS, 10);
  const pollTickIntervalMs = sourceGroups.polledNames.length > 0
    ? Math.min(
      ...sourceGroups.polledNames.map((name) =>
        name === SOURCE_CHANNELS.OREF_ALERTS
          ? orefAlertsPollIntervalMs
          : orefHistoryPollIntervalMs),
    )
    : defaultPollIntervalMs;

  return {
    locations,
    targetChatIds,
    testChatIds,
    configuredNotifierTransports,
    alertSinks: {
      names: configuredAlertSinkNames,
      whatsappTargetStaggerMs: parsePositiveIntEnv(WHATSAPP_TARGET_STAGGER_MS, 0),
    },
    sources: {
      activeNames: sourceGroups.activeNames,
      polledNames: sourceGroups.polledNames,
      realtimeNames: sourceGroups.realtimeNames,
    },
    evolution: {
      url: EVOLUTION_URL,
      apiKey: EVOLUTION_API_KEY,
      instance: EVOLUTION_INSTANCE,
      fallbackInstance: String(EVOLUTION_FALLBACK_INSTANCE || "").trim(),
      timeoutMs: parsePositiveIntEnv(EVOLUTION_TIMEOUT_MS, 10_000),
    },
    timing: {
      defaultPollIntervalMs,
      orefAlertsPollIntervalMs,
      orefHistoryPollIntervalMs,
      pollTickIntervalMs,
      sourceTimeoutMs: 5000,
      logSuppressionIntervalMs: parsePositiveIntEnv(LOG_SUPPRESSION_INTERVAL_MS, 60_000),
    },
    delivery: {
      enabledEnv: DELIVERY_ENABLED,
    },
    debugCapture: {
      enabled: parseBooleanEnv(DEBUG_CAPTURE_ENABLED),
      ttlHours: Number.isFinite(debugCaptureTtlHours)
        ? debugCaptureTtlHours
        : 24,
      maxEntries: parseInt(DEBUG_CAPTURE_MAX_ENTRIES, 10) || 1000,
    },
    orefMqtt: {
      enabled: activeSourceNameSet.has(SOURCE_CHANNELS.OREF_MQTT),
      reconnectDelayMs: orefMqttReconnectDelayMs,
      rotateIntervalMs: orefMqttRotateIntervalMs,
      listenerCount: orefMqttListenerCount,
      brokerUrls: configuredOrefMqttBrokerUrls,
      topicsExplicit: configuredOrefMqttTopics.length > 0,
      topics: configuredOrefMqttTopics.length > 0
        ? configuredOrefMqttTopics
        : [...DEFAULT_OREF_MQTT_TOPICS],
      rawLogEnabled: activeSourceNameSet.has(SOURCE_CHANNELS.OREF_MQTT)
        && parseBooleanEnv(OREF_MQTT_RAW_LOG_ENABLED),
      rawLogMaxEntries: parsePositiveIntEnv(OREF_MQTT_RAW_LOG_MAX_ENTRIES, 500),
    },
    tzevaadom: {
      enabled: activeSourceNameSet.has(SOURCE_CHANNELS.TZEVAADOM),
      reconnectDelayMs: tzevaadomReconnectDelayMs,
      rawLogEnabled: activeSourceNameSet.has(SOURCE_CHANNELS.TZEVAADOM)
        && parseBooleanEnv(TZEVAADOM_RAW_LOG_ENABLED),
      rawLogMaxEntries: parsePositiveIntEnv(TZEVAADOM_RAW_LOG_MAX_ENTRIES, 500),
    },
    pagerDuty: {
      routingKey: PAGERDUTY_ROUTING_KEY,
      eventsUrl: PAGERDUTY_EVENTS_URL,
      source: PAGERDUTY_SOURCE,
      component: PAGERDUTY_COMPONENT,
      group: PAGERDUTY_GROUP,
      className: PAGERDUTY_CLASS,
      whatsappDisconnectThresholdMs: parsePositiveIntEnv(PAGERDUTY_WHATSAPP_DISCONNECT_MS, 2 * 60 * 1000),
      sourceFailureThreshold: parsePositiveIntEnv(PAGERDUTY_SOURCE_FAILURE_CYCLES, 6),
      pollErrorThreshold: parsePositiveIntEnv(PAGERDUTY_POLL_ERROR_CYCLES, 3),
      dbDisconnectThresholdMs: parsePositiveIntEnv(PAGERDUTY_DB_DISCONNECT_MS, 30_000),
      outboxBacklogThresholdMs: parsePositiveIntEnv(PAGERDUTY_OUTBOX_BACKLOG_MS, 60_000),
      notifierStaleThresholdMs: parsePositiveIntEnv(PAGERDUTY_NOTIFIER_STALE_MS, 45_000),
      telegramBotStaleThresholdMs: parsePositiveIntEnv(PAGERDUTY_TELEGRAM_BOT_STALE_MS, 120_000),
      tzevaadomDisconnectThresholdMs: parsePositiveIntEnv(PAGERDUTY_TZEVAADOM_DISCONNECT_MS, 300_000),
    },
    database: {
      pollerUrl: String(POLLER_DATABASE_URL || "").trim(),
    },
    sourceEventLedger: {
      enabled: parseBooleanEnv(SOURCE_EVENT_LEDGER_ENABLED),
    },
    paths: {
      dedupeStorePath: join(appDir, "data", "sent-alerts.json"),
      seenSourceAlertStorePath: join(appDir, "data", "seen-source-alerts.json"),
      debugCaptureDirPath: join(appDir, "data", "debug-captures"),
      pagerDutyStatePath: join(appDir, "data", "pagerduty-state.json"),
      runtimeStatePath: join(appDir, "data", "runtime-state.json"),
      recentSentStorePath: join(appDir, "data", "recent-sent.json"),
      recentAlertFlowStorePath: join(appDir, "data", "recent-alert-flow.json"),
      notifierDeliveryStorePath: join(appDir, "data", "notifier-deliveries.json"),
      orefMqttCredentialsPath: join(appDir, "data", "oref-mqtt-credentials.json"),
      orefMqttRawLogPath: join(appDir, "data", "oref-mqtt-raw-log.json"),
      tzevaadomRawLogPath: join(appDir, "data", "tzevaadom-raw-log.json"),
    },
    limits: {
      maxDeliveredKeys: MAX_DELIVERED_KEYS,
      deliveredKeyTtlMs: DELIVERED_KEY_TTL_MS,
      maxSeenSourceAlerts: MAX_SEEN_SOURCE_ALERTS,
      seenSourceAlertTtlMs: SEEN_SOURCE_ALERT_TTL_MS,
      maxRecentSent: MAX_RECENT_SENT,
    },
  };
}
