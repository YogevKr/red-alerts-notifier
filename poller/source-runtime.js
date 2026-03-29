import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DebugCaptureStore } from "./debug-capture.js";
import { createRepeatedEventLogger } from "./log.js";
import {
  buildSourceGroups,
  createPolledSourceConfigs,
} from "./source-registry.js";
import {
  buildOrefCityMap,
  buildOrefMqttBrokerUrl,
  buildOrefMqttSubscriptionTopics,
  fetchOrefCityCatalog,
  fetchOrefCityMap,
  OrefMqttStream,
  OREF_MQTT_DEFAULT_TOPICS,
  registerOrefMqttDevice,
  subscribeOrefMqttTopics,
  validateOrefMqttCredentials,
} from "./oref-mqtt.js";
import {
  SOURCE_CHANNELS,
  fetchTzevaadomCityMap,
  TzevaadomStream,
} from "./sources.js";

function loadJson(filePath, fallback, label, logger = console) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logger.warn(`${label}_load_failed`, {
        file_path: filePath,
        error: err,
      });
    }
    return fallback;
  }
}

function persistJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createRealtimeCounterState(enabled = false) {
  return {
    enabled,
    lastPollReceivedCount: 0,
    lastPollParsedCount: 0,
    lastPollAlertCount: 0,
    lastPollParseErrorCount: 0,
  };
}

function resolveRealtimeSourceError(status = {}, disconnectedError = "disconnected") {
  return status.lastConnectionError || status.lastParseError || disconnectedError;
}

function buildRealtimeSourceResult(status = {}, counterState = {}, disconnectedError) {
  const receivedCount = Math.max(0, Number(status.receivedCount || 0) - counterState.lastPollReceivedCount);
  const parsedCount = Math.max(0, Number(status.parsedCount || 0) - counterState.lastPollParsedCount);
  const alertCount = Math.max(0, Number(status.alertCount || 0) - counterState.lastPollAlertCount);
  const parseErrorCount = Math.max(
    0,
    Number(status.parseErrorCount || 0) - counterState.lastPollParseErrorCount,
  );

  counterState.lastPollReceivedCount = Number(status.receivedCount || 0);
  counterState.lastPollParsedCount = Number(status.parsedCount || 0);
  counterState.lastPollAlertCount = Number(status.alertCount || 0);
  counterState.lastPollParseErrorCount = Number(status.parseErrorCount || 0);

  return {
    ok: Boolean(status.connected),
    error: status.connected ? null : resolveRealtimeSourceError(status, disconnectedError),
    count: alertCount,
    rawCount: 0,
    queued: Number(status.queued || 0),
    receivedCount,
    parsedCount,
    alertCount,
    parseErrorCount,
  };
}

function notifyRealtimeHealthChange({
  source = "",
  status = {},
  disconnectedError = "disconnected",
  onHealthChange = null,
  toIsoString = (timestampMs = Date.now()) => new Date(timestampMs).toISOString(),
  logger = console,
} = {}) {
  if (!onHealthChange) return;
  Promise.resolve(onHealthChange({
    source,
    ok: Boolean(status.connected),
    error: status.connected ? null : resolveRealtimeSourceError(status, disconnectedError),
    checkedAt: toIsoString(),
    status,
  })).catch((err) => {
    logger.warn("realtime_source_health_change_handler_failed", {
      source,
      error: err,
    });
  });
}

function captureRealtimeEntries(
  source,
  entries,
  {
    rawLogStore,
    debugCaptureStores = {},
    captureEntriesBySource = () => [],
  } = {},
) {
  captureEntriesBySource(debugCaptureStores, entries, { touchDuplicates: false });
  rawLogStore.captureMany(
    entries.filter((entry) => String(entry?.source || "").trim() === source),
    { touchDuplicates: false },
  );
}

function createRealtimeStreamLogger(source, logger = console) {
  const repeatedEventLogger = createRepeatedEventLogger(logger, {
    intervalMs: 60_000,
  });

  return {
    log: (message) => {
      const normalizedMessage = String(message || "").trim() || "unknown";
      repeatedEventLogger.record(
        `${source}_stream_event`,
        "info",
        normalizedMessage,
        {
          source,
          severity: "info",
          message: normalizedMessage,
        },
      );
    },
    error: (message) => {
      const normalizedMessage = String(message || "").trim() || "unknown";
      repeatedEventLogger.record(
        `${source}_stream_event`,
        "warn",
        normalizedMessage,
        {
          source,
          severity: "warn",
          message: normalizedMessage,
        },
        "warn",
      );
    },
  };
}

function toIsoOrNull(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function maxIsoTimestamp(...values) {
  return values
    .map((value) => toIsoOrNull(value))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function sumListenerMetric(listenerStatuses = [], key) {
  return listenerStatuses.reduce(
    (sum, status) => sum + Number(status?.[key] || 0),
    0,
  );
}

function buildListenerSnapshot(status = {}, index = 0) {
  return {
    id: `listener-${index + 1}`,
    connected: Boolean(status?.connected),
    brokerUrl: status?.brokerUrl || null,
    lastTopic: status?.lastTopic || null,
    receivedCount: Number(status?.receivedCount || 0),
    parsedCount: Number(status?.parsedCount || 0),
    alertCount: Number(status?.alertCount || 0),
    parseErrorCount: Number(status?.parseErrorCount || 0),
    queued: Number(status?.queued || 0),
    lastMessageAt: status?.lastMessageAt || null,
    lastParsedAt: status?.lastParsedAt || null,
    lastAlertAt: status?.lastAlertAt || null,
    lastParseErrorAt: status?.lastParseErrorAt || null,
    lastParseError: status?.lastParseError || null,
    lastConnectionErrorAt: status?.lastConnectionErrorAt || null,
    lastConnectionError: status?.lastConnectionError || null,
  };
}

function summarizeListenerStatuses(listenerStatuses = []) {
  const listeners = listenerStatuses.map(buildListenerSnapshot);
  const connectedListener = listeners.find((listener) => listener.connected) || null;
  const lastErroredListener = [...listeners]
    .reverse()
    .find((listener) => listener.lastConnectionError || listener.lastParseError) || null;

  return {
    connected: listeners.some((listener) => listener.connected),
    queued: sumListenerMetric(listeners, "queued"),
    receivedCount: sumListenerMetric(listeners, "receivedCount"),
    parsedCount: sumListenerMetric(listeners, "parsedCount"),
    alertCount: sumListenerMetric(listeners, "alertCount"),
    parseErrorCount: sumListenerMetric(listeners, "parseErrorCount"),
    lastMessageAt: maxIsoTimestamp(...listeners.map((listener) => listener.lastMessageAt)),
    lastParsedAt: maxIsoTimestamp(...listeners.map((listener) => listener.lastParsedAt)),
    lastAlertAt: maxIsoTimestamp(...listeners.map((listener) => listener.lastAlertAt)),
    lastParseErrorAt: maxIsoTimestamp(...listeners.map((listener) => listener.lastParseErrorAt)),
    lastParseError: lastErroredListener?.lastParseError || null,
    lastConnectionErrorAt: maxIsoTimestamp(...listeners.map((listener) => listener.lastConnectionErrorAt)),
    lastConnectionError: lastErroredListener?.lastConnectionError || null,
    lastTopic: connectedListener?.lastTopic || listeners.find((listener) => listener.lastTopic)?.lastTopic || null,
    brokerUrl: connectedListener?.brokerUrl || listeners.find((listener) => listener.brokerUrl)?.brokerUrl || null,
    listeners,
  };
}

export function createSourceConfigs({
  activeSources = [],
  orefAlertsPollIntervalMs,
  orefHistoryPollIntervalMs,
} = {}) {
  return createPolledSourceConfigs({
    activeSources,
    orefAlertsPollIntervalMs,
    orefHistoryPollIntervalMs,
  });
}

export function buildRealtimeSourcesSnapshot(sourceRuntimes = {}) {
  return Object.values(sourceRuntimes).reduce((snapshot, runtime) => ({
    ...snapshot,
    ...(runtime?.getRealtimeSourcesSnapshot?.() || {}),
  }), {});
}

export async function collectRealtimeSourceResults(sourceRuntimes = {}) {
  const results = await Promise.all(
    Object.values(sourceRuntimes).map(async (runtime) =>
      runtime?.collectRealtimeSourceResults?.() || {}),
  );
  return results.reduce((combined, result) => ({
    ...combined,
    ...result,
  }), {});
}

export function setRealtimeAlertHandler(sourceRuntimes = {}, onAlert) {
  for (const runtime of Object.values(sourceRuntimes)) {
    runtime?.setAlertHandler?.(onAlert);
  }
}

export async function startRealtimeSources(sourceRuntimes = {}, options = {}) {
  for (const runtime of Object.values(sourceRuntimes)) {
    await runtime?.start?.(options);
  }
}

export function createTzevaadomSourceRuntime({
  enabled = false,
  reconnectDelayMs = 5000,
  rawLogPath = "",
  rawLogEnabled = false,
  rawLogMaxEntries = 500,
  logger = console,
  debugCaptureStores = {},
  captureEntriesBySource = () => [],
  toIsoString = (timestampMs = Date.now()) => new Date(timestampMs).toISOString(),
  createStream = (options) => new TzevaadomStream(options),
  fetchCityMap = fetchTzevaadomCityMap,
  onHealthChange = null,
} = {}) {
  const rawLogStore = new DebugCaptureStore({
    enabled: rawLogEnabled,
    filePath: rawLogPath,
    ttlHours: 0,
    maxEntries: rawLogMaxEntries,
    logger,
  });
  const state = {
    cityMapLoadedAt: null,
    cityMapError: null,
    cityCount: 0,
    ...createRealtimeCounterState(enabled),
  };
  const source = SOURCE_CHANNELS.TZEVAADOM;
  const stream = enabled
    ? createStream({
      logger: createRealtimeStreamLogger(source, logger),
      reconnectDelayMs,
      queueAlerts: false,
      onRawMessage: (message) => {
        captureRealtimeEntries(source, [{
          kind: "ws_raw",
          source,
          matchedLocations: [],
          payload: message,
        }], {
          rawLogStore,
          debugCaptureStores,
          captureEntriesBySource,
        });
      },
      onParseError: (message) => {
        captureRealtimeEntries(source, [{
          kind: "ws_parse_error",
          source,
          matchedLocations: [],
          payload: message,
        }], {
          rawLogStore,
          debugCaptureStores,
          captureEntriesBySource,
        });
      },
      onConnectionStateChange: (status) => {
        notifyRealtimeHealthChange({
          source,
          status,
          disconnectedError: "websocket disconnected",
          onHealthChange,
          toIsoString,
          logger,
        });
      },
    })
    : null;

  function getRealtimeSourcesSnapshot() {
    if (!enabled || !stream) return {};

    return {
      [source]: {
        enabled: true,
        reconnectDelayMs,
        cityMapLoadedAt: state.cityMapLoadedAt,
        cityMapError: state.cityMapError,
        cityCount: state.cityCount,
        rawLog: rawLogStore.status(),
        ...stream.status(),
      },
    };
  }

  async function collectRealtimeSourceResults() {
    if (!enabled || !stream) return {};

    return {
      [source]: buildRealtimeSourceResult(
        stream.status(),
        state,
        "websocket disconnected",
      ),
    };
  }

  function setAlertHandler(onAlert) {
    stream?.setAlertHandler(onAlert, { queueAlerts: false });
  }

  async function start({ timeoutMs } = {}) {
    if (!enabled || !stream) return;

    try {
      const cityMap = await fetchCityMap({ timeoutMs });
      stream.setCityMap(cityMap);
      state.cityCount = cityMap.size;
      state.cityMapLoadedAt = toIsoString();
      state.cityMapError = null;
      logger.info("tzevaadom_city_map_ready", {
        city_count: cityMap.size,
      });
    } catch (err) {
      state.cityMapError = err.message;
      logger.warn("tzevaadom_city_map_failed", {
        error: err,
      });
    }

    stream.start();
    logger.info("tzevaadom_stream_started", {
      reconnect_delay_ms: reconnectDelayMs,
    });
  }

  return {
    setAlertHandler,
    getRealtimeSourcesSnapshot,
    collectRealtimeSourceResults,
    start,
  };
}

export function createOrefMqttSourceRuntime({
  enabled = false,
  reconnectDelayMs = 5000,
  rotateIntervalMs = 5 * 60 * 1000,
  listenerCount = 2,
  brokerUrls = [],
  topicsExplicit = false,
  topics = OREF_MQTT_DEFAULT_TOPICS,
  credentialsPath = "",
  rawLogPath = "",
  rawLogEnabled = false,
  rawLogMaxEntries = 500,
  logger = console,
  debugCaptureStores = {},
  captureEntriesBySource = () => [],
  toIsoString = (timestampMs = Date.now()) => new Date(timestampMs).toISOString(),
  createStream = (options) => new OrefMqttStream(options),
  fetchCityCatalog = fetchOrefCityCatalog,
  fetchCityMap = fetchOrefCityMap,
  registerDevice = registerOrefMqttDevice,
  validateCredentials = validateOrefMqttCredentials,
  subscribeTopics = subscribeOrefMqttTopics,
  onHealthChange = null,
} = {}) {
  const source = SOURCE_CHANNELS.OREF_MQTT;
  const configuredTopics = Array.isArray(topics) && topics.length > 0
    ? [...new Set(topics.map((topic) => String(topic || "").trim()).filter(Boolean))]
    : [...OREF_MQTT_DEFAULT_TOPICS];
  const rawLogStore = new DebugCaptureStore({
    enabled: rawLogEnabled,
    filePath: rawLogPath,
    ttlHours: 0,
    maxEntries: rawLogMaxEntries,
    logger,
  });
  const state = {
    cityMapLoadedAt: null,
    cityMapError: null,
    cityCount: 0,
    credentialsLoadedAt: null,
    credentialsError: null,
    credentialsValidationStatus: "unknown",
    credentialsUsable: false,
    topicsSubscribedAt: null,
    topicsError: null,
    topicCount: configuredTopics.length,
    ...createRealtimeCounterState(enabled),
  };
  const normalizedBrokerUrls = Array.isArray(brokerUrls)
    ? [...new Set(brokerUrls.map((url) => String(url || "").trim()).filter(Boolean))]
    : [];
  const resolvedListenerCount = normalizedBrokerUrls.length > 0
    ? normalizedBrokerUrls.length
    : Math.max(1, Number(listenerCount) || 1);
  const streams = enabled
    ? Array.from({ length: resolvedListenerCount }, (_, index) =>
      createStream({
        logger: createRealtimeStreamLogger(source, logger),
        reconnectDelayMs,
        rotateIntervalMs,
        queueAlerts: false,
        brokerUrlFactory: normalizedBrokerUrls[index]
          ? () => normalizedBrokerUrls[index]
          : (timestampSeconds = Math.floor(Date.now() / 1000)) =>
            buildOrefMqttBrokerUrl(timestampSeconds + index),
        onRawMessage: (message) => {
          captureRealtimeEntries(source, [{
            kind: "mqtt_raw",
            source,
            matchedLocations: [],
            payload: {
              ...message,
              listenerId: `listener-${index + 1}`,
            },
          }], {
            rawLogStore,
            debugCaptureStores,
            captureEntriesBySource,
          });
        },
        onParseError: (message) => {
          captureRealtimeEntries(source, [{
            kind: "mqtt_parse_error",
            source,
            matchedLocations: [],
            payload: {
              ...message,
              listenerId: `listener-${index + 1}`,
            },
          }], {
            rawLogStore,
            debugCaptureStores,
            captureEntriesBySource,
          });
        },
        onConnectionStateChange: () => {
          notifyRealtimeHealthChange({
            source,
            status: summarizeListenerStatuses(streams.map((stream) => stream.status())),
            disconnectedError: "mqtt disconnected",
            onHealthChange,
            toIsoString,
            logger,
          });
        },
      }))
    : [];

  function getRealtimeSourcesSnapshot() {
    if (!enabled || streams.length === 0) return {};

    const summary = summarizeListenerStatuses(streams.map((stream) => stream.status()));

    return {
      [source]: {
        enabled: true,
        reconnectDelayMs,
        rotateIntervalMs,
        listenerCount: resolvedListenerCount,
        topicCount: state.topicCount,
        cityMapLoadedAt: state.cityMapLoadedAt,
        cityMapError: state.cityMapError,
        cityCount: state.cityCount,
        credentialsLoadedAt: state.credentialsLoadedAt,
        credentialsError: state.credentialsError,
        credentialsValidationStatus: state.credentialsValidationStatus,
        credentialsUsable: state.credentialsUsable,
        topicsSubscribedAt: state.topicsSubscribedAt,
        topicsError: state.topicsError,
        rawLog: rawLogStore.status(),
        ...summary,
      },
    };
  }

  async function collectRealtimeSourceResults() {
    if (!enabled || streams.length === 0) return {};

    const summary = summarizeListenerStatuses(streams.map((stream) => stream.status()));

    return {
      [source]: buildRealtimeSourceResult(
        summary,
        state,
        "mqtt disconnected",
      ),
    };
  }

  function setAlertHandler(onAlert) {
    for (const stream of streams) {
      stream.setAlertHandler(onAlert, { queueAlerts: false });
    }
  }

  function loadCredentials() {
    const parsed = loadJson(credentialsPath, {}, "oref_mqtt_credentials", logger);
    const token = String(parsed?.token || "").trim();
    const auth = String(parsed?.auth || "").trim();
    const androidId = String(parsed?.androidId || "").trim();
    return token && auth ? {
      token,
      auth,
      ...(androidId ? { androidId } : {}),
    } : null;
  }

  function persistCredentials(credentials = {}) {
    const normalized = {
      token: String(credentials.token || "").trim(),
      auth: String(credentials.auth || "").trim(),
      androidId: String(credentials.androidId || "").trim(),
    };
    persistJson(credentialsPath, Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => Boolean(value)),
    ));
  }

  async function resolveCredentials({ timeoutMs } = {}) {
    const persisted = loadCredentials();
    if (persisted) {
      const validation = await validateCredentials({
        ...persisted,
        timeoutMs,
      });
      state.credentialsValidationStatus = validation.validationStatus || "unknown";
      state.credentialsUsable = Boolean(validation.valid);
      if (validation.valid) {
        state.credentialsLoadedAt = toIsoString();
        state.credentialsError = null;
        logger.info("oref_mqtt_credentials_reused", {
          validation_status: state.credentialsValidationStatus,
        });
        return persisted;
      }

      state.credentialsError = validation.error || "persisted credentials invalid";
      logger.warn("oref_mqtt_credentials_invalid", {
        error: state.credentialsError,
      });
    }

    const credentials = await registerDevice({ timeoutMs });
    persistCredentials(credentials);
    state.credentialsLoadedAt = toIsoString();
    state.credentialsError = null;
    state.credentialsValidationStatus = "registered";
    state.credentialsUsable = true;
    logger.info("oref_mqtt_credentials_registered");
    return credentials;
  }

  function reportStartupFailure(error) {
    notifyRealtimeHealthChange({
      source,
      status: {
        connected: false,
        lastConnectionError: error,
      },
      disconnectedError: "mqtt disconnected",
      onHealthChange,
      toIsoString,
      logger,
    });
  }

  async function start({ timeoutMs } = {}) {
    if (!enabled || streams.length === 0) return;

    let topicsToSubscribe = configuredTopics;

    try {
      const cityCatalog = await fetchCityCatalog({ timeoutMs });
      const cityMap = buildOrefCityMap(cityCatalog);
      for (const stream of streams) {
        stream.setCityMap(cityMap);
      }
      state.cityCount = cityMap.size;
      topicsToSubscribe = topicsExplicit
        ? configuredTopics
        : buildOrefMqttSubscriptionTopics(cityCatalog, {
          baseTopics: configuredTopics,
        });
      state.topicCount = topicsToSubscribe.length;
      state.cityMapLoadedAt = toIsoString();
      state.cityMapError = null;
      logger.info("oref_mqtt_city_map_ready", {
        city_count: cityMap.size,
        topics_count: topicsToSubscribe.length,
      });
    } catch (err) {
      try {
        const cityMap = await fetchCityMap({ timeoutMs });
        for (const stream of streams) {
          stream.setCityMap(cityMap);
        }
        state.cityCount = cityMap.size;
        state.cityMapLoadedAt = toIsoString();
        state.cityMapError = null;
        logger.info("oref_mqtt_city_map_ready", {
          city_count: cityMap.size,
          topics_count: state.topicCount,
        });
      } catch {
        state.cityMapError = err.message;
        logger.warn("oref_mqtt_city_map_failed", {
          error: err,
        });
      }
    }

    let credentials = null;
    try {
      credentials = await resolveCredentials({ timeoutMs });
      for (const stream of streams) {
        stream.setCredentials(credentials);
      }
    } catch (err) {
      state.credentialsError = err.message;
      state.credentialsUsable = false;
      logger.warn("oref_mqtt_credentials_failed", {
        error: err,
      });
      reportStartupFailure(err.message);
      return;
    }

    try {
      await subscribeTopics({
        token: credentials.token,
        auth: credentials.auth,
        topics: topicsToSubscribe,
        timeoutMs,
      });
      state.topicsSubscribedAt = toIsoString();
      state.topicsError = null;
      logger.info("oref_mqtt_topics_subscribed", {
        topics_count: topicsToSubscribe.length,
      });
    } catch (err) {
      state.topicsError = err.message;
      logger.warn("oref_mqtt_topics_subscribe_failed", {
        topics_count: topicsToSubscribe.length,
        error: err,
      });
    }

    for (const stream of streams) {
      stream.start();
    }
    logger.info("oref_mqtt_stream_started", {
      listener_count: resolvedListenerCount,
      reconnect_delay_ms: reconnectDelayMs,
      rotate_interval_ms: rotateIntervalMs,
      topics_count: topicsToSubscribe.length,
    });
  }

  return {
    setAlertHandler,
    getRealtimeSourcesSnapshot,
    collectRealtimeSourceResults,
    start,
  };
}

export function createRealtimeSourceRuntimes({
  activeSources = [],
  sourceSettings = {},
  paths = {},
  logger = console,
  debugCaptureStores = {},
  captureEntriesBySource = () => [],
  toIsoString = (timestampMs = Date.now()) => new Date(timestampMs).toISOString(),
  onHealthChange = null,
  runtimeFactories = {},
} = {}) {
  const factoryMap = {
    [SOURCE_CHANNELS.OREF_MQTT]: () => createOrefMqttSourceRuntime({
      ...(sourceSettings.orefMqtt || {}),
      credentialsPath: paths.orefMqttCredentialsPath,
      rawLogPath: paths.orefMqttRawLogPath,
      logger,
      debugCaptureStores,
      captureEntriesBySource,
      toIsoString,
      onHealthChange,
    }),
    [SOURCE_CHANNELS.TZEVAADOM]: () => createTzevaadomSourceRuntime({
      ...(sourceSettings.tzevaadom || {}),
      rawLogPath: paths.tzevaadomRawLogPath,
      logger,
      debugCaptureStores,
      captureEntriesBySource,
      toIsoString,
      onHealthChange,
    }),
    ...runtimeFactories,
  };

  return Object.fromEntries(
    buildSourceGroups(activeSources).realtimeNames
      .filter((sourceName) => sourceName in factoryMap)
      .map((sourceName) => [sourceName, factoryMap[sourceName]()]),
  );
}
