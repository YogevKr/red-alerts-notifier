import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  appendRecentAlertFlowEntry,
  buildLatestAlertFlowSnapshot as buildLatestTimelineFlowSnapshot,
  buildRecentFlowMessage as formatRecentFlowMessage,
  buildRecentSentMessage as formatRecentSentMessage,
  loadRecentAlertFlowEntries,
  loadRecentSentEntries,
} from "./ops-timeline-store.js";

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
    String(payload.alertDate || payload.date || payload.time || entry.lastSeenAt || "").trim() || "unknown";
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
  locations,
  logger = console,
} = {}) {
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

  function loadRecentSentSnapshot() {
    return loadRecentSentEntries(recentSentStorePath, logger);
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

  function buildRecentReceivedTownMessage(limit = 5) {
    const recentTownEntries = listDebugCaptureEntries(debugCaptureStores, {
      limit: 500,
      kind: "oref_raw",
    }).filter((entry) =>
      entry.matchedLocations?.some((location) => locations.includes(location)),
    );

    if (recentTownEntries.length === 0) {
      return `recent_received_town: none for ${locations.join(", ")}`;
    }

    return [
      `recent_received_town: ${locations.join(", ")}`,
      ...recentTownEntries
        .slice(0, Math.max(1, limit))
        .map((entry) => formatRawCaptureSummary(entry)),
    ].join("\n");
  }

  function buildRecentReceivedMessage(limit = 5) {
    const recentEntries = listDebugCaptureEntries(debugCaptureStores, {
      limit: Math.max(1, limit),
      kind: "oref_raw",
    });

    if (recentEntries.length === 0) {
      return "recent_received: none";
    }

    return [
      "recent_received:",
      ...recentEntries.map((entry) => formatRawCaptureSummary(entry)),
    ].join("\n");
  }

  function buildRecentSentMessage(limit = 5) {
    return formatRecentSentMessage(loadRecentSentSnapshot(), limit);
  }

  function getLatestAlertFlowSnapshot() {
    return buildLatestTimelineFlowSnapshot({
      activityEntries: loadRecentAlertFlowEntries(recentAlertFlowStorePath, logger),
      sentEntries: loadRecentSentSnapshot(),
    });
  }

  function buildRecentFlowMessage(limit = 3) {
    return formatRecentFlowMessage({
      activityEntries: loadRecentAlertFlowEntries(recentAlertFlowStorePath, logger),
      sentEntries: loadRecentSentSnapshot(),
      limit,
    });
  }

  function pruneDeliveredKeys(now = Date.now(), { persist = true } = {}) {
    let changed = false;
    for (const [key, lastDeliveredAt] of delivered.entries()) {
      if (
        !Number.isFinite(lastDeliveredAt) ||
        lastDeliveredAt > now + 60 * 1000 ||
        now - lastDeliveredAt >= deliveredKeyTtlMs
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
    let changed = false;
    for (const [key, lastSeenAt] of seenSourceAlerts.entries()) {
      if (
        !Number.isFinite(lastSeenAt) ||
        lastSeenAt > now + 60 * 1000 ||
        now - lastSeenAt >= seenSourceAlertTtlMs
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
    persistRuntimeState,
    setDeliveryEnabled,
    rememberRecentAlertFlow,
    buildRecentReceivedTownMessage,
    buildRecentReceivedMessage,
    buildRecentSentMessage,
    buildRecentFlowMessage,
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
