import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DebugCaptureStore } from "./debug-capture.js";
import {
  buildSourceGroups,
  createPolledSourceConfigs,
} from "./source-registry.js";
import {
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
  return {
    log: (message) => logger.info(`${source}_stream_event`, { message }),
    error: (message) => logger.warn(`${source}_stream_event`, { message }),
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
    credentialsBlocked: false,
    topicsSubscribedAt: null,
    topicsError: null,
    topics: configuredTopics,
    ...createRealtimeCounterState(enabled),
  };
  const stream = enabled
    ? createStream({
      logger: createRealtimeStreamLogger(source, logger),
      reconnectDelayMs,
      queueAlerts: false,
      onRawMessage: (message) => {
        captureRealtimeEntries(source, [{
          kind: "mqtt_raw",
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
          kind: "mqtt_parse_error",
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
          disconnectedError: "mqtt disconnected",
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
        topics: [...state.topics],
        cityMapLoadedAt: state.cityMapLoadedAt,
        cityMapError: state.cityMapError,
        cityCount: state.cityCount,
        credentialsLoadedAt: state.credentialsLoadedAt,
        credentialsError: state.credentialsError,
        credentialsBlocked: state.credentialsBlocked,
        topicsSubscribedAt: state.topicsSubscribedAt,
        topicsError: state.topicsError,
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
        "mqtt disconnected",
      ),
    };
  }

  function setAlertHandler(onAlert) {
    stream?.setAlertHandler(onAlert, { queueAlerts: false });
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
      state.credentialsBlocked = Boolean(validation.blocked);
      if (validation.valid) {
        state.credentialsLoadedAt = toIsoString();
        state.credentialsError = null;
        logger.info("oref_mqtt_credentials_reused", {
          blocked: state.credentialsBlocked,
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
    state.credentialsBlocked = false;
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
    if (!enabled || !stream) return;

    try {
      const cityMap = await fetchCityMap({ timeoutMs });
      stream.setCityMap(cityMap);
      state.cityCount = cityMap.size;
      state.cityMapLoadedAt = toIsoString();
      state.cityMapError = null;
      logger.info("oref_mqtt_city_map_ready", {
        city_count: cityMap.size,
      });
    } catch (err) {
      state.cityMapError = err.message;
      logger.warn("oref_mqtt_city_map_failed", {
        error: err,
      });
    }

    let credentials = null;
    try {
      credentials = await resolveCredentials({ timeoutMs });
      stream.setCredentials(credentials);
    } catch (err) {
      state.credentialsError = err.message;
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
        topics: state.topics,
        timeoutMs,
      });
      state.topicsSubscribedAt = toIsoString();
      state.topicsError = null;
      logger.info("oref_mqtt_topics_subscribed", {
        topics_count: state.topics.length,
      });
    } catch (err) {
      state.topicsError = err.message;
      logger.warn("oref_mqtt_topics_subscribe_failed", {
        topics_count: state.topics.length,
        error: err,
      });
    }

    stream.start();
    logger.info("oref_mqtt_stream_started", {
      reconnect_delay_ms: reconnectDelayMs,
      topics_count: state.topics.length,
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
