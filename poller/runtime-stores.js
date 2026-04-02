import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  appendRecentAlertFlowEntry,
  buildLatestAlertFlowSnapshot as buildLatestTimelineFlowSnapshot,
  buildRecentFlowMessage as formatRecentFlowMessage,
  buildRecentMissMessage as formatRecentMissMessage,
  buildRecentSentMessage as formatRecentSentMessage,
  loadRecentAlertFlowEntries,
  loadRecentSentEntries,
} from "./ops-timeline-store.js";
import { formatStatusTimestamp } from "./lib.js";

function loadJson(filePath, fallback, label, logger = console) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logger.warn?.(`Could not load ${label} ${filePath}: ${err.message}`);
    }
    return fallback;
  }
}

function persistJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function normalizeDeliveredKey(key, hashDeliveryKey) {
  return /^[a-f0-9]{64}$/i.test(String(key)) ? String(key).toLowerCase() : hashDeliveryKey(key);
}

function formatRawCaptureSummary(entry = {}) {
  const payload = entry.payload || {};
  const title =
    String(payload.title || payload.category_desc || payload.desc || "unknown").trim() || "unknown";
  const when =
    formatStatusTimestamp(payload.alertDate || payload.date || payload.time || entry.lastSeenAt);
  const category =
    payload.cat !== undefined
      ? String(payload.cat)
      : payload.category !== undefined
        ? String(payload.category)
        : "";
  const areas = (Array.isArray(payload.data) ? payload.data : [payload.data])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const categorySuffix = category ? ` cat=${category}` : "";
  const areasSuffix = areas.length
    ? ` | ${areas.slice(0, 3).join(", ")}${areas.length > 3 ? ` (+${areas.length - 3})` : ""}`
    : "";
  return `${entry.source} | ${when}${categorySuffix} | ${title}${areasSuffix}`;
}

function normalizeEntryLocations(locations = []) {
  return (Array.isArray(locations) ? locations : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function formatSourceEventSummary(entry = {}) {
  const title = String(entry.title || entry.event_type || "unknown").trim() || "unknown";
  const when =
    formatStatusTimestamp(entry.alert_date || entry.source_received_at || entry.observed_at);
  const outcome = String(entry.outcome || "").trim();
  const areas = normalizeEntryLocations(entry.raw_locations || entry.matched_locations);
  const areasSuffix = areas.length
    ? ` | ${areas.slice(0, 3).join(", ")}${areas.length > 3 ? ` (+${areas.length - 3})` : ""}`
    : "";
  const outcomeSuffix = outcome ? ` | ${outcome}` : "";
  return `${entry.source} | ${when}${outcomeSuffix} | ${title}${areasSuffix}`;
}

function formatRecentReceivedTownEntry(entry = {}) {
  return entry?.payload ? formatRawCaptureSummary(entry) : formatSourceEventSummary(entry);
}

const RECENT_RECEIVED_KIND_BY_SOURCE = {
  oref_alerts: "oref_raw",
  oref_history: "oref_raw",
  oref_history2: "oref_raw",
  oref_mqtt: "mqtt_raw",
  tzevaadom: "ws_raw",
};

function listRecentReceivedEntriesBySource(listDebugCaptureEntries, debugCaptureStores, source, limit) {
  const kind = RECENT_RECEIVED_KIND_BY_SOURCE[source];
  if (!kind) return [];

  return listDebugCaptureEntries(debugCaptureStores, {
    limit: Math.max(1, limit),
    kind,
    source,
  });
}

export function createRuntimeStores({
  runtimeStatePath,
  recentSentStorePath,
  recentAlertFlowStorePath,
  dedupeStorePath,
  seenSourceAlertStorePath,
  parseBooleanEnv,
  deliveryEnabledEnv,
  toIsoString,
  monitor,
  maxRecentSent,
  maxDeliveredKeys,
  deliveredKeyTtlMs,
  maxSeenSourceAlerts,
  seenSourceAlertTtlMs,
  shouldSuppressDuplicateDelivery,
  hashDeliveryKey,
  listDebugCaptureEntries,
  debugCaptureStores,
  activeSourceNames = [],
  locations,
  logger = console,
} = {}) {
  let recentSourceEventsLoader = async () => [];
  let boundMonitor = monitor || null;
  const runtimeStateDefaults = {
    deliveryEnabled: parseBooleanEnv(deliveryEnabledEnv),
    deliveryUpdatedAt: null,
    deliveryUpdatedBy: "env",
  };
  const runtimeState = (() => {
    const parsed = loadJson(runtimeStatePath, {}, "runtime state", logger);
    return {
      ...runtimeStateDefaults,
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      deliveryEnabled:
        typeof parsed?.deliveryEnabled === "boolean"
          ? parsed.deliveryEnabled
          : runtimeStateDefaults.deliveryEnabled,
    };
  })();

  const delivered = (() => {
    const parsed = loadJson(dedupeStorePath, [], "dedupe store", logger);
    const loaded = new Map();
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      if (typeof entry === "string") {
        loaded.set(normalizeDeliveredKey(entry, hashDeliveryKey), 0);
        continue;
      }

      const key = typeof entry?.key === "string" ? entry.key : "";
      if (!key) continue;

      const deliveredAt =
        typeof entry.lastDeliveredAt === "number"
          ? entry.lastDeliveredAt
          : Date.parse(entry.lastDeliveredAt || "");
      loaded.set(normalizeDeliveredKey(key, hashDeliveryKey), Number.isFinite(deliveredAt) ? deliveredAt : 0);
    }
    return loaded;
  })();

  const seenSourceAlerts = (() => {
    const parsed = loadJson(seenSourceAlertStorePath, [], "source replay store", logger);
    const loaded = new Map();
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const key = typeof entry?.key === "string" ? entry.key : "";
      if (!key) continue;

      const seenAt =
        typeof entry.lastSeenAt === "number"
          ? entry.lastSeenAt
          : Date.parse(entry.lastSeenAt || "");
      loaded.set(key, Number.isFinite(seenAt) ? seenAt : 0);
    }
    return loaded;
  })();

  function persistRuntimeState() {
    persistJson(runtimeStatePath, runtimeState);
  }

  function persistDeliveredKeys() {
    persistJson(
      dedupeStorePath,
      [...delivered.entries()]
        .sort((left, right) => left[1] - right[1])
        .map(([key, lastDeliveredAt]) => ({
          key,
          lastDeliveredAt: new Date(lastDeliveredAt).toISOString(),
        })),
    );
  }

  function persistSeenSourceAlertKeys() {
    persistJson(
      seenSourceAlertStorePath,
      [...seenSourceAlerts.entries()]
        .sort((left, right) => left[1] - right[1])
        .map(([key, lastSeenAt]) => ({
          key,
          lastSeenAt: new Date(lastSeenAt).toISOString(),
        })),
    );
  }

  function setDeliveryEnabled(enabled, updatedBy = "manual") {
    runtimeState.deliveryEnabled = Boolean(enabled);
    runtimeState.deliveryUpdatedAt = toIsoString();
    runtimeState.deliveryUpdatedBy = updatedBy;
    if (boundMonitor) {
      boundMonitor.deliveryEnabled = runtimeState.deliveryEnabled;
      boundMonitor.deliveryUpdatedAt = runtimeState.deliveryUpdatedAt;
      boundMonitor.deliveryUpdatedBy = runtimeState.deliveryUpdatedBy;
    }
    persistRuntimeState();
    return runtimeState.deliveryEnabled;
  }

  function bindMonitor(nextMonitor) {
    boundMonitor = nextMonitor || null;
  }

  function setRecentSourceEventsLoader(nextLoader) {
    recentSourceEventsLoader =
      typeof nextLoader === "function" ? nextLoader : async () => [];
  }

  function loadRecentSentSnapshot() {
    return loadRecentSentEntries(recentSentStorePath, logger);
  }

  function loadRecentAlertFlowSnapshot() {
    return loadRecentAlertFlowEntries(recentAlertFlowStorePath, logger);
  }

  function rememberRecentAlertFlow(entry = {}) {
    appendRecentAlertFlowEntry({
      ...entry,
      observedAt: entry.observedAt ? String(entry.observedAt) : toIsoString(),
    }, {
      filePath: recentAlertFlowStorePath,
      maxEntries: maxRecentSent * 5,
      logger,
    });
  }

  async function buildRecentReceivedTownMessage(limit = 5) {
    const sources = (
      Array.isArray(activeSourceNames) && activeSourceNames.length > 0
        ? activeSourceNames
        : Object.keys(debugCaptureStores)
    ).filter((source) => RECENT_RECEIVED_KIND_BY_SOURCE[source] === "oref_raw");
    const sourceSet = new Set(sources);

    const hasConfiguredLocation = (entry = {}) =>
      normalizeEntryLocations(entry.matched_locations || entry.matchedLocations)
        .some((location) => locations.includes(location));

    try {
      const recentSourceEvents = await recentSourceEventsLoader(
        sources,
        Math.max(50, limit * 10),
      );
      const recentTownSourceEvents = (Array.isArray(recentSourceEvents) ? recentSourceEvents : [])
        .filter((entry) => sourceSet.has(String(entry?.source || "").trim()))
        .filter((entry) => hasConfiguredLocation(entry));
      if (recentTownSourceEvents.length > 0) {
        return [
          `recent_received_town: ${locations.join(", ")}`,
          ...recentTownSourceEvents
            .slice(0, Math.max(1, limit))
            .map((entry) => formatRecentReceivedTownEntry(entry)),
        ].join("\n");
      }
    } catch (err) {
      logger.warn?.(`Could not load recent town source events: ${err.message}`);
    }

    const recentTownEntries = listDebugCaptureEntries(debugCaptureStores, {
      limit: 500,
      kind: "oref_raw",
    }).filter((entry) => hasConfiguredLocation(entry));

    if (recentTownEntries.length === 0) {
      return `recent_received_town: none for ${locations.join(", ")}`;
    }

    return [
      `recent_received_town: ${locations.join(", ")}`,
      ...recentTownEntries
        .slice(0, Math.max(1, limit))
        .map((entry) => formatRecentReceivedTownEntry(entry)),
    ].join("\n");
  }

  async function buildRecentReceivedMessage(limit = 5) {
    const sources = (
      Array.isArray(activeSourceNames) && activeSourceNames.length > 0
        ? activeSourceNames
        : Object.keys(debugCaptureStores)
    ).filter((source) => RECENT_RECEIVED_KIND_BY_SOURCE[source]);

    if (sources.length === 0) {
      return "recent_received: none";
    }

    try {
      const recentSourceEvents = await recentSourceEventsLoader(
        sources,
        Math.max(1, limit),
      );
      if (Array.isArray(recentSourceEvents) && recentSourceEvents.length > 0) {
        const groupedRows = new Map();
        for (const source of sources) groupedRows.set(source, []);
        for (const row of recentSourceEvents) {
          const source = String(row?.source || "").trim();
          if (!groupedRows.has(source)) continue;
          groupedRows.get(source).push(row);
        }

        const lines = ["recent_received:"];
        let hasAnyEntries = false;

        for (const source of sources) {
          const entries = groupedRows.get(source) || [];
          lines.push(`${source}:`);
          if (entries.length === 0) {
            lines.push("none");
            continue;
          }
          hasAnyEntries = true;
          lines.push(...entries.map((entry) => formatSourceEventSummary(entry)));
        }

        if (hasAnyEntries) {
          return lines.join("\n");
        }
      }
    } catch (err) {
      logger.warn?.(`Could not load recent source events: ${err.message}`);
    }

    const lines = ["recent_received:"];
    let hasAnyEntries = false;

    for (const source of sources) {
      const entries = listRecentReceivedEntriesBySource(
        listDebugCaptureEntries,
        debugCaptureStores,
        source,
        limit,
      );
      lines.push(`${source}:`);
      if (entries.length === 0) {
        lines.push("none");
        continue;
      }
      hasAnyEntries = true;
      lines.push(...entries.map((entry) => formatRawCaptureSummary(entry)));
    }

    return hasAnyEntries ? lines.join("\n") : "recent_received: none";
  }

  function buildRecentSentMessage(limit = 5) {
    return formatRecentSentMessage(loadRecentSentSnapshot(), limit);
  }

  function getLatestAlertFlowSnapshot() {
    return buildLatestTimelineFlowSnapshot({
      activityEntries: loadRecentAlertFlowSnapshot(),
      sentEntries: loadRecentSentSnapshot(),
    });
  }

  function buildRecentFlowMessage(limit = 3) {
    return formatRecentFlowMessage({
      activityEntries: loadRecentAlertFlowSnapshot(),
      sentEntries: loadRecentSentSnapshot(),
      limit,
    });
  }

  async function buildRecentMissMessage(limit = 3) {
    const sources = (
      Array.isArray(activeSourceNames) && activeSourceNames.length > 0
        ? activeSourceNames
        : Object.keys(debugCaptureStores)
    ).filter(Boolean);

    try {
      const recentSourceEvents = await recentSourceEventsLoader(
        sources,
        Math.max(50, limit * 50),
      );
      const message = formatRecentMissMessage({
        sourceEventEntries: recentSourceEvents,
        limit,
      });
      if (message !== "recent_miss: none") {
        return message;
      }
    } catch (err) {
      logger.warn?.(`Could not load recent miss source events: ${err.message}`);
    }

    return formatRecentMissMessage({
      activityEntries: loadRecentAlertFlowSnapshot(),
      limit,
    });
  }

  function pruneDeliveredKeys(now = Date.now(), { persist = true } = {}) {
    // Source event timestamps can replay out of order; retention must follow wall clock.
    const pruneNow = Date.now();
    let changed = false;
    for (const [key, lastDeliveredAt] of delivered.entries()) {
      if (
        !Number.isFinite(lastDeliveredAt) ||
        lastDeliveredAt > pruneNow + 60 * 1000 ||
        pruneNow - lastDeliveredAt >= deliveredKeyTtlMs
      ) {
        delivered.delete(key);
        changed = true;
      }
    }

    if (changed && persist) persistDeliveredKeys();
  }

  function trimDeliveredKeys() {
    if (delivered.size <= maxDeliveredKeys) return;

    const overflow = delivered.size - maxDeliveredKeys;
    const oldestKeys = [...delivered.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(0, overflow)
      .map(([key]) => key);
    for (const key of oldestKeys) delivered.delete(key);
  }

  function hasDeliveredKey(key, now = Date.now()) {
    pruneDeliveredKeys(now);
    return shouldSuppressDuplicateDelivery(delivered.get(key), now);
  }

  function rememberDeliveredKey(key, deliveredAt = Date.now()) {
    const normalizedDeliveredAt =
      Number.isFinite(deliveredAt) && deliveredAt > 0 ? deliveredAt : Date.now();
    pruneDeliveredKeys(normalizedDeliveredAt, { persist: false });
    delivered.set(key, normalizedDeliveredAt);

    trimDeliveredKeys();
    persistDeliveredKeys();
    return delivered.has(key);
  }

  function buildSeenSourceAlertKey(alert = {}) {
    return `${alert.source || "unknown"}:${alert.id || "missing"}`;
  }

  function pruneSeenSourceAlertKeys(now = Date.now(), { persist = true } = {}) {
    // Source event timestamps can replay out of order; retention must follow wall clock.
    const pruneNow = Date.now();
    let changed = false;
    for (const [key, lastSeenAt] of seenSourceAlerts.entries()) {
      if (
        !Number.isFinite(lastSeenAt) ||
        lastSeenAt > pruneNow + 60 * 1000 ||
        pruneNow - lastSeenAt >= seenSourceAlertTtlMs
      ) {
        seenSourceAlerts.delete(key);
        changed = true;
      }
    }

    if (changed && persist) persistSeenSourceAlertKeys();
  }

  function trimSeenSourceAlertKeys() {
    if (seenSourceAlerts.size <= maxSeenSourceAlerts) return;

    const overflow = seenSourceAlerts.size - maxSeenSourceAlerts;
    const oldestKeys = [...seenSourceAlerts.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(0, overflow)
      .map(([key]) => key);
    for (const key of oldestKeys) seenSourceAlerts.delete(key);
  }

  function hasSeenSourceAlertKey(key, now = Date.now()) {
    pruneSeenSourceAlertKeys(now);
    return seenSourceAlerts.has(key);
  }

  function rememberSeenSourceAlertKey(key, seenAt = Date.now()) {
    const normalizedSeenAt = Number.isFinite(seenAt) && seenAt > 0 ? seenAt : Date.now();
    pruneSeenSourceAlertKeys(normalizedSeenAt, { persist: false });
    seenSourceAlerts.set(key, normalizedSeenAt);

    trimSeenSourceAlertKeys();
    persistSeenSourceAlertKeys();
    return seenSourceAlerts.has(key);
  }

  return {
    runtimeState,
    delivered,
    seenSourceAlerts,
    bindMonitor,
    setRecentSourceEventsLoader,
    persistRuntimeState,
    setDeliveryEnabled,
    rememberRecentAlertFlow,
    buildRecentReceivedTownMessage,
    buildRecentReceivedMessage,
    buildRecentSentMessage,
    buildRecentFlowMessage,
    buildRecentMissMessage,
    getLatestAlertFlowSnapshot,
    hasDeliveredKey,
    rememberDeliveredKey,
    pruneDeliveredKeys,
    buildSeenSourceAlertKey,
    hasSeenSourceAlertKey,
    rememberSeenSourceAlertKey,
    pruneSeenSourceAlertKeys,
  };
}
