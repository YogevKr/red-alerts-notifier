import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatStatusTimestamp } from "./lib.js";

function loadJsonList(filePath, label, logger = console) {
  if (!filePath) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logger.warn?.(`Could not load ${label} ${filePath}: ${err.message}`);
    }
    return [];
  }
}

function persistJsonList(filePath, value) {
  if (!filePath) return;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTimelineDelta(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "n/a";
  if (deltaMs < 1000) return `${Math.round(deltaMs)}ms`;
  if (deltaMs < 10_000) return `${(deltaMs / 1000).toFixed(1)}s`;
  if (deltaMs < 60_000) return `${Math.round(deltaMs / 1000)}s`;
  const minutes = Math.floor(deltaMs / 60_000);
  const seconds = Math.round((deltaMs % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

function formatFlowLocations(locations = []) {
  const list = (Array.isArray(locations) ? locations : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return list.length > 0 ? list.join(", ") : "unknown";
}

function formatFlowTitle(title = "", eventType = "") {
  const normalizedTitle = String(title || "").trim();
  if (normalizedTitle) return normalizedTitle;
  return String(eventType || "unknown").trim() || "unknown";
}

function buildRecentFlowGroups({
  activityEntries = [],
  sentEntries = [],
} = {}) {
  const groups = new Map();

  for (const entry of activityEntries) {
    const semanticKey = String(entry?.semanticKey || "").trim();
    if (!semanticKey) continue;
    const at = entry.receivedAt || entry.observedAt || entry.alertDate || null;
    const atMs = parseTimestampMs(at);
    if (!Number.isFinite(atMs)) continue;
    const current = groups.get(semanticKey) || {
      semanticKey,
      eventType: entry.eventType || "unknown",
      title: entry.title || "",
      matchedLocations: [...(entry.matchedLocations || [])],
      steps: [],
    };
    current.steps.push({
      source: String(entry.source || "unknown"),
      outcome: String(entry.outcome || "unknown"),
      at,
      atMs,
    });
    groups.set(semanticKey, current);
  }

  for (const entry of sentEntries) {
    const semanticKey = String(entry?.semanticKey || "").trim();
    if (!semanticKey) continue;
    const at = entry.deliveredAt || null;
    const atMs = parseTimestampMs(at);
    if (!Number.isFinite(atMs)) continue;
    const current = groups.get(semanticKey) || {
      semanticKey,
      eventType: entry.eventType || "unknown",
      title: entry.title || "",
      matchedLocations: [...(entry.matchedLocations || [])],
      steps: [],
    };
    current.steps.push({
      source: String(entry.transport || "unknown"),
      outcome: "sent",
      at,
      atMs,
    });
    groups.set(semanticKey, current);
  }

  return [...groups.values()]
    .map((group) => {
      const steps = group.steps.sort((left, right) => left.atMs - right.atMs);
      const firstStepAtMs = steps[0]?.atMs ?? null;
      const lastStepAtMs = steps[steps.length - 1]?.atMs ?? null;
      return {
        ...group,
        steps,
        firstStepAtMs,
        lastStepAtMs,
      };
    })
    .sort((left, right) => (right.lastStepAtMs || 0) - (left.lastStepAtMs || 0));
}

function buildFlowSummary(group = {}) {
  const steps = Array.isArray(group.steps) ? group.steps : [];
  if (steps.length === 0) return "";
  const firstStepAtMs = steps[0]?.atMs ?? null;
  const compressedSteps = [];

  for (const step of steps) {
    const previous = compressedSteps[compressedSteps.length - 1];
    if (
      previous
      && previous.source === step.source
      && previous.outcome === step.outcome
    ) {
      previous.count += 1;
      previous.lastAt = step.at;
      previous.lastAtMs = step.atMs;
      continue;
    }

    compressedSteps.push({
      ...step,
      count: 1,
      lastAt: step.at,
      lastAtMs: step.atMs,
    });
  }

  const summary = compressedSteps
    .map((step) => {
      const deltaSuffix = Number.isFinite(firstStepAtMs) && Number.isFinite(step.atMs)
        ? ` (+${formatTimelineDelta(step.atMs - firstStepAtMs)})`
        : "";
      const countSuffix = step.count > 1 ? ` x${step.count}` : "";
      return `${step.source}:${step.outcome}${deltaSuffix}${countSuffix}`;
    })
    .join(" -> ");

  return summary.length > 500
    ? `${summary.slice(0, 497)}...`
    : summary;
}

function formatFlowStep(step = {}, firstStepAtMs = null) {
  const deltaSuffix = Number.isFinite(firstStepAtMs) && Number.isFinite(step.atMs)
    ? ` (+${formatTimelineDelta(step.atMs - firstStepAtMs)})`
    : "";
  return `${formatStatusTimestamp(step.at)}${deltaSuffix} | ${step.source} | ${step.outcome}`;
}

export function loadRecentSentEntries(filePath, logger = console) {
  return loadJsonList(filePath, "recent sent store", logger);
}

export function appendRecentSentEntry(
  entry = {},
  {
    filePath = "",
    maxEntries = 100,
    logger = console,
  } = {},
) {
  const entries = loadRecentSentEntries(filePath, logger);
  entries.unshift({
    deliveredAt: entry.deliveredAt || null,
    eventType: String(entry.eventType || "unknown"),
    source: String(entry.source || "manual"),
    title: String(entry.title || ""),
    chatId: String(entry.chatId || ""),
    matchedLocations: [...(entry.matchedLocations || [])],
    semanticKey: String(entry.semanticKey || ""),
    deliveryKey: String(entry.deliveryKey || ""),
    alertDate: entry.alertDate ? String(entry.alertDate) : null,
    receivedAt: entry.receivedAt ? String(entry.receivedAt) : null,
    deliveryMode: String(entry.deliveryMode || ""),
    transport: String(entry.transport || ""),
    providerMessageId: entry.providerMessageId ?? null,
    instanceName: String(entry.instanceName || ""),
    usedFallback: Boolean(entry.usedFallback),
  });
  while (entries.length > maxEntries) entries.pop();
  persistJsonList(filePath, entries);
  return entries;
}

export function loadRecentAlertFlowEntries(filePath, logger = console) {
  return loadJsonList(filePath, "recent alert flow store", logger);
}

export function appendRecentAlertFlowEntry(
  entry = {},
  {
    filePath = "",
    maxEntries = 500,
    logger = console,
  } = {},
) {
  const entries = loadRecentAlertFlowEntries(filePath, logger);
  entries.unshift({
    observedAt: entry.observedAt ? String(entry.observedAt) : null,
    receivedAt: entry.receivedAt ? String(entry.receivedAt) : null,
    alertDate: entry.alertDate ? String(entry.alertDate) : null,
    source: String(entry.source || "unknown"),
    eventType: String(entry.eventType || "unknown"),
    title: String(entry.title || ""),
    matchedLocations: [...(entry.matchedLocations || [])],
    semanticKey: String(entry.semanticKey || ""),
    sourceKey: String(entry.sourceKey || ""),
    outcome: String(entry.outcome || "unknown"),
  });
  while (entries.length > maxEntries) entries.pop();
  persistJsonList(filePath, entries);
  return entries;
}

export function buildRecentSentMessage(recentSentEntries = [], limit = 5) {
  if (!Array.isArray(recentSentEntries) || recentSentEntries.length === 0) {
    return "recent_sent: none";
  }

  return [
    "recent_sent:",
    ...recentSentEntries.slice(0, Math.max(1, limit)).map((entry) => {
      const titleSuffix = entry.title ? ` | ${entry.title}` : "";
      const fallbackSuffix = entry.usedFallback ? " | fallback" : "";
      return `${formatStatusTimestamp(entry.deliveredAt)} | ${entry.eventType} | ${entry.source} | ${entry.chatId}${fallbackSuffix}${titleSuffix}`;
    }),
  ].join("\n");
}

export function buildLatestAlertFlowSnapshot({
  activityEntries = [],
  sentEntries = [],
} = {}) {
  const group = buildRecentFlowGroups({ activityEntries, sentEntries })[0];
  if (!group) return null;

  return {
    semanticKey: group.semanticKey,
    eventType: group.eventType,
    title: formatFlowTitle(group.title, group.eventType),
    matchedLocations: group.matchedLocations,
    summary: buildFlowSummary(group),
    entries: group.steps.map((step) => ({
      at: step.at,
      source: step.source,
      outcome: step.outcome,
    })),
  };
}

export function buildRecentFlowMessage({
  activityEntries = [],
  sentEntries = [],
  limit = 3,
} = {}) {
  const groups = buildRecentFlowGroups({
    activityEntries,
    sentEntries,
  }).slice(0, Math.max(1, limit));

  if (groups.length === 0) {
    return "recent_flow: none";
  }

  const lines = ["recent_flow:"];
  for (const group of groups) {
    lines.push(
      `${formatFlowTitle(group.title, group.eventType)} | ${formatFlowLocations(group.matchedLocations)}`,
    );
    for (const step of group.steps) {
      lines.push(formatFlowStep(step, group.firstStepAtMs));
    }
  }
  return lines.join("\n");
}
