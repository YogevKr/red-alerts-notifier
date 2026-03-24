import { DebugCaptureStore } from "./debug-capture.js";
import {
  buildSourceGroups,
  createPolledSourceConfigs,
} from "./source-registry.js";
import {
  SOURCE_CHANNELS,
  fetchTzevaadomCityMap,
  TzevaadomStream,
} from "./sources.js";

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
