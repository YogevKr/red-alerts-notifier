import {
  OREF_CURRENT_URL,
  OREF_HISTORY_URL,
  SOURCE_CHANNELS,
  extractWebsiteCurrentRawRecords,
  extractWebsiteHistoryRawRecords,
  normalizeWebsiteCurrentAlerts,
  normalizeWebsiteHistoryAlerts,
} from "./sources.js";

export const SOURCE_REGISTRY = {
  [SOURCE_CHANNELS.OREF_ALERTS]: {
    name: SOURCE_CHANNELS.OREF_ALERTS,
    kind: "polled",
    defaultActive: true,
    monitored: true,
    url: OREF_CURRENT_URL,
    normalizer: normalizeWebsiteCurrentAlerts,
    rawExtractor: extractWebsiteCurrentRawRecords,
    resolvePollIntervalMs: ({ orefAlertsPollIntervalMs }) => orefAlertsPollIntervalMs,
  },
  [SOURCE_CHANNELS.OREF_HISTORY]: {
    name: SOURCE_CHANNELS.OREF_HISTORY,
    kind: "polled",
    defaultActive: false,
    monitored: true,
    url: OREF_HISTORY_URL,
    normalizer: normalizeWebsiteHistoryAlerts,
    rawExtractor: extractWebsiteHistoryRawRecords,
    resolvePollIntervalMs: ({ orefHistoryPollIntervalMs }) => orefHistoryPollIntervalMs,
  },
  [SOURCE_CHANNELS.OREF_MQTT]: {
    name: SOURCE_CHANNELS.OREF_MQTT,
    kind: "realtime",
    defaultActive: false,
    monitored: true,
  },
  [SOURCE_CHANNELS.TZEVAADOM]: {
    name: SOURCE_CHANNELS.TZEVAADOM,
    kind: "realtime",
    defaultActive: false,
    monitored: true,
  },
};

function uniqueSourceNames(names = []) {
  return [...new Set(
    (Array.isArray(names) ? names : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value in SOURCE_REGISTRY),
  )];
}

export function resolveActiveSourceNames({
  explicitNames = [],
  legacyEnabledNames = [],
} = {}) {
  const explicit = uniqueSourceNames(explicitNames);
  if (explicit.length > 0) {
    return explicit;
  }

  return uniqueSourceNames([
    ...getDefaultActiveSourceNames(),
    ...(Array.isArray(legacyEnabledNames) ? legacyEnabledNames : []),
  ]);
}

export function getConfigurableSourceNames() {
  return Object.keys(SOURCE_REGISTRY);
}

export function getDefaultActiveSourceNames() {
  return Object.values(SOURCE_REGISTRY)
    .filter((definition) => definition.defaultActive)
    .map((definition) => definition.name);
}

export function buildSourceGroups(activeSources = []) {
  const activeNames = uniqueSourceNames(activeSources);
  return {
    activeNames,
    polledNames: activeNames.filter((name) => SOURCE_REGISTRY[name]?.kind === "polled"),
    realtimeNames: activeNames.filter((name) => SOURCE_REGISTRY[name]?.kind === "realtime"),
  };
}

export function buildMonitoredSourceNames(activeSources = []) {
  return uniqueSourceNames(activeSources)
    .filter((name) => SOURCE_REGISTRY[name]?.monitored);
}

export function createPolledSourceConfigs({
  activeSources = [],
  orefAlertsPollIntervalMs,
  orefHistoryPollIntervalMs,
} = {}) {
  return buildSourceGroups(activeSources).polledNames
    .map((name) => SOURCE_REGISTRY[name])
    .filter(Boolean)
    .map((definition) => ({
      ...definition,
      pollIntervalMs: definition.resolvePollIntervalMs({
        orefAlertsPollIntervalMs,
        orefHistoryPollIntervalMs,
      }),
    }));
}
