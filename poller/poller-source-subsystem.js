import {
  captureEntriesBySource,
  createDebugCaptureStores,
  listDebugCaptureEntries,
  parseBooleanEnv,
} from "./debug-capture.js";
import {
  applySourceHealthUpdate,
  buildMonitoredSourceChannels,
  createPollerMonitor,
} from "./monitor-state.js";
import { createRuntimeStores } from "./runtime-stores.js";
import {
  createRealtimeSourceRuntimes,
  createSourceConfigs,
} from "./source-runtime.js";

export function createPollerSourceSubsystem({
  sources = {},
  timing = {},
  debugCapture = {},
  delivery = {},
  orefMqtt = {},
  tzevaadom = {},
  paths = {},
  limits = {},
  locations = [],
  evolution = {},
  logger = console,
  toIsoString = (timestampMs = Date.now()) => new Date(timestampMs).toISOString(),
  hashDeliveryKey,
  shouldSuppressDuplicateDelivery,
} = {}) {
  const monitoredSourceChannels = buildMonitoredSourceChannels({
    activeSources: sources.activeNames,
  });
  const sourceConfigs = createSourceConfigs({
    activeSources: sources.activeNames,
    orefAlertsPollIntervalMs: timing.orefAlertsPollIntervalMs,
    orefHistoryPollIntervalMs: timing.orefHistoryPollIntervalMs,
  });
  const debugCaptureStores = createDebugCaptureStores({
    enabled: debugCapture.enabled,
    dirPath: paths.debugCaptureDirPath,
    ttlHours: debugCapture.ttlHours,
    maxEntries: debugCapture.maxEntries,
    sources: monitoredSourceChannels,
  });
  const runtimeStores = createRuntimeStores({
    runtimeStatePath: paths.runtimeStatePath,
    recentSentStorePath: paths.recentSentStorePath,
    recentAlertFlowStorePath: paths.recentAlertFlowStorePath,
    dedupeStorePath: paths.dedupeStorePath,
    seenSourceAlertStorePath: paths.seenSourceAlertStorePath,
    parseBooleanEnv,
    deliveryEnabledEnv: delivery.enabledEnv,
    toIsoString,
    maxRecentSent: limits.maxRecentSent,
    maxDeliveredKeys: limits.maxDeliveredKeys,
    deliveredKeyTtlMs: limits.deliveredKeyTtlMs,
    maxSeenSourceAlerts: limits.maxSeenSourceAlerts,
    seenSourceAlertTtlMs: limits.seenSourceAlertTtlMs,
    shouldSuppressDuplicateDelivery,
    hashDeliveryKey,
    listDebugCaptureEntries,
    debugCaptureStores,
    activeSourceNames: sources.activeNames,
    locations,
    logger,
  });
  const monitor = createPollerMonitor({
    runtimeState: runtimeStores.runtimeState,
    monitoredSourceChannels,
    evolutionInstance: evolution.instance,
    evolutionFallbackInstance: evolution.fallbackInstance,
  });
  runtimeStores.bindMonitor(monitor);

  let realtimeHealthHandler = async () => {};
  const realtimeSourceRuntimes = createRealtimeSourceRuntimes({
    activeSources: sources.activeNames,
    sourceSettings: {
      orefMqtt,
      tzevaadom,
    },
    paths,
    logger,
    debugCaptureStores,
    captureEntriesBySource,
    toIsoString,
    onHealthChange: async (update) => {
      applySourceHealthUpdate(monitor, update);
      await realtimeHealthHandler(update);
    },
  });

  function setRealtimeHealthHandler(nextHandler) {
    realtimeHealthHandler = typeof nextHandler === "function" ? nextHandler : async () => {};
  }

  return {
    monitoredSourceChannels,
    sourceConfigs,
    debugCaptureStores,
    runtimeStores,
    monitor,
    realtimeSourceRuntimes,
    captureEntriesBySource,
    listDebugCaptureEntries,
    setRealtimeHealthHandler,
  };
}
