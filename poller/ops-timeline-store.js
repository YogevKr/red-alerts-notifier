import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatStatusTimestamp, parseEventDate } from "./lib.js";

// Keep source confirmations together without merging separate real incidents.
const INCIDENT_WINDOW_MS = 90 * 1000;
const MAX_LOCATION_LABEL_ITEMS = 3;

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
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}(?:[ T]|$)/.test(raw)) {
    const parsedEventDate = parseEventDate(raw);
    const parsed = parsedEventDate?.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTimelineDelta(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "n/a";
  if (deltaMs < 1000) return `${Math.round(deltaMs)}ms`;
  if (deltaMs < 10_000) return `${(deltaMs / 1000).toFixed(1)}s`;
  if (deltaMs < 60_000) return `${Math.round(deltaMs / 1000)}s`;
  let minutes = Math.floor(deltaMs / 60_000);
  let seconds = Math.round((deltaMs % 60_000) / 1000);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${minutes}m${seconds}s`;
}

function normalizeLocations(locations = []) {
  return [...new Set(
    (Array.isArray(locations) ? locations : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function formatLocationSummary(locations = []) {
  const list = normalizeLocations(locations);
  if (list.length === 0) return "unknown";
  if (list.length <= MAX_LOCATION_LABEL_ITEMS) return list.join(", ");
  return `${list.slice(0, MAX_LOCATION_LABEL_ITEMS).join(", ")} (+${list.length - MAX_LOCATION_LABEL_ITEMS})`;
}

function formatFlowLocations(locations = []) {
  const list = normalizeLocations(locations)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return formatLocationSummary(list);
}

function formatFlowTitle(title = "", eventType = "") {
  const normalizedTitle = String(title || "").trim();
  if (normalizedTitle) return normalizedTitle;
  return String(eventType || "unknown").trim() || "unknown";
}

function normalizeFlowOutcome(outcome = "") {
  const normalized = String(outcome || "").trim() || "unknown";
  if (normalized === "duplicate" || normalized === "seen_source_alert") {
    return "same_event";
  }
  return normalized;
}

function normalizeTimelineActivityEntry(entry = {}) {
  const matchedLocations = normalizeLocations(entry.matchedLocations || entry.matched_locations);
  const rawLocations = normalizeLocations(entry.rawLocations || entry.raw_locations);
  const source = String(entry.source || "unknown");
  const eventType = String(entry.eventType || entry.event_type || "unknown");
  const title = String(entry.title || "");
  const outcome = String(entry.outcome || "unknown");
  const eventAt =
    entry.sourceEventAt
    || entry.source_event_at
    || entry.alertDate
    || entry.alert_date
    || entry.receivedAt
    || entry.source_received_at
    || entry.observedAt
    || entry.observed_at
    || null;
  const stepAt =
    entry.receivedAt
    || entry.source_received_at
    || entry.observedAt
    || entry.observed_at
    || eventAt;

  return {
    kind: "activity",
    source,
    eventType,
    title,
    matchedLocations,
    rawLocations,
    sourceKey: String(entry.sourceKey || entry.source_key || ""),
    semanticKey: String(entry.semanticKey || entry.semantic_key || ""),
    outcome,
    displayOutcome: normalizeFlowOutcome(outcome),
    eventAt,
    eventAtMs: parseTimestampMs(eventAt) ?? parseTimestampMs(stepAt),
    stepAt,
    stepAtMs: parseTimestampMs(stepAt) ?? parseTimestampMs(eventAt),
    count: Math.max(1, Number.parseInt(entry.observationCount ?? entry.observation_count, 10) || 1),
  };
}

function normalizeTimelineSentEntry(entry = {}) {
  const matchedLocations = normalizeLocations(entry.matchedLocations || entry.matched_locations);
  const rawLocations = normalizeLocations(
    entry.rawLocations
    || entry.raw_locations
    || entry.matchedLocations
    || entry.matched_locations,
  );
  const eventAt =
    entry.sourceEventAt
    || entry.source_event_at
    || entry.alertDate
    || entry.alert_date
    || entry.receivedAt
    || entry.received_at
    || entry.deliveredAt
    || null;

  return {
    kind: "sent",
    source: String(entry.transport || "unknown"),
    originSource: String(entry.source || "unknown"),
    transport: String(entry.transport || "unknown"),
    eventType: String(entry.eventType || entry.event_type || "unknown"),
    title: String(entry.title || ""),
    matchedLocations,
    rawLocations,
    semanticKey: String(entry.semanticKey || entry.semantic_key || ""),
    deliveryKey: String(entry.deliveryKey || entry.delivery_key || ""),
    chatId: String(entry.chatId || entry.chat_id || ""),
    eventAt,
    eventAtMs: parseTimestampMs(eventAt) ?? parseTimestampMs(entry.deliveredAt),
    stepAt: entry.deliveredAt || null,
    stepAtMs: parseTimestampMs(entry.deliveredAt),
    count: 1,
  };
}

function buildMatchedIncidentBaseKey(entry = {}) {
  const locations = normalizeLocations(entry.matchedLocations);
  if (locations.length === 0) return "";
  return JSON.stringify({
    eventType: entry.eventType || "unknown",
    title: formatFlowTitle(entry.title, entry.eventType),
    locations,
  });
}

function buildMissIncidentBaseKey(entry = {}) {
  const locations = normalizeLocations(entry.rawLocations);
  if (locations.length === 0) return "";
  return JSON.stringify({
    eventType: entry.eventType || "unknown",
    title: formatFlowTitle(entry.title, entry.eventType),
    locations,
  });
}

function createIncidentGroup(record, baseKey) {
  return {
    baseKey,
    anchorEventAtMs: record.eventAtMs,
    semanticKey: record.semanticKey || "",
    eventType: record.eventType || "unknown",
    title: record.title || "",
    matchedLocations: [...record.matchedLocations],
    rawLocations: [...record.rawLocations],
    primarySource: record.kind === "sent" ? record.originSource : record.source,
    steps: [],
    sentTargets: [],
    firstStepAtMs: null,
    firstSentAtMs: null,
    lastStepAtMs: null,
  };
}

function addRecordToIncidentGroup(group, record) {
  if (!group.title && record.title) group.title = record.title;
  if (group.matchedLocations.length === 0 && record.matchedLocations.length > 0) {
    group.matchedLocations = [...record.matchedLocations];
  }
  if (group.rawLocations.length === 0 && record.rawLocations.length > 0) {
    group.rawLocations = [...record.rawLocations];
  }
  if (
    (!group.primarySource || group.primarySource === "unknown")
    && record.kind === "sent"
    && record.originSource
  ) {
    group.primarySource = record.originSource;
  }
  if (
    (!group.primarySource || group.primarySource === "unknown")
    && record.kind === "activity"
    && record.outcome === "enqueued"
  ) {
    group.primarySource = record.source;
  }

  group.steps.push({
    source: record.kind === "sent" ? record.transport : record.source,
    outcome: record.kind === "sent" ? "sent" : record.displayOutcome,
    at: record.stepAt,
    atMs: record.stepAtMs,
    count: record.count,
  });

  if (record.kind === "sent") {
    group.sentTargets.push({
      transport: record.transport,
      chatId: record.chatId,
      at: record.stepAt,
      atMs: record.stepAtMs,
    });
    if (!Number.isFinite(group.firstSentAtMs) || record.stepAtMs < group.firstSentAtMs) {
      group.firstSentAtMs = record.stepAtMs;
    }
  }

  if (!Number.isFinite(group.firstStepAtMs) || record.stepAtMs < group.firstStepAtMs) {
    group.firstStepAtMs = record.stepAtMs;
  }
  if (!Number.isFinite(group.lastStepAtMs) || record.stepAtMs > group.lastStepAtMs) {
    group.lastStepAtMs = record.stepAtMs;
  }
}

function buildIncidentGroups(records = [], buildBaseKey) {
  const groupsByBaseKey = new Map();
  const sortedRecords = [...records].sort((left, right) => {
    const leftEventAtMs = left.eventAtMs ?? left.stepAtMs ?? 0;
    const rightEventAtMs = right.eventAtMs ?? right.stepAtMs ?? 0;
    if (leftEventAtMs !== rightEventAtMs) return leftEventAtMs - rightEventAtMs;
    return (left.stepAtMs ?? 0) - (right.stepAtMs ?? 0);
  });

  for (const record of sortedRecords) {
    const baseKey = buildBaseKey(record);
    if (!baseKey) continue;

    const matchingGroups = groupsByBaseKey.get(baseKey) || [];
    const previousGroup = matchingGroups[matchingGroups.length - 1];
    const shouldAppend =
      previousGroup
      && Number.isFinite(previousGroup.anchorEventAtMs)
      && Number.isFinite(record.eventAtMs)
      && Math.abs(record.eventAtMs - previousGroup.anchorEventAtMs) <= INCIDENT_WINDOW_MS;

    const group = shouldAppend
      ? previousGroup
      : createIncidentGroup(record, baseKey);

    if (!shouldAppend) {
      matchingGroups.push(group);
      groupsByBaseKey.set(baseKey, matchingGroups);
    }

    addRecordToIncidentGroup(group, record);
  }

  return [...groupsByBaseKey.values()]
    .flat()
    .map((group) => ({
      ...group,
      steps: group.steps.sort((left, right) => left.atMs - right.atMs),
      sentTargets: group.sentTargets.sort((left, right) => left.atMs - right.atMs),
    }))
    .sort((left, right) => (right.lastStepAtMs || 0) - (left.lastStepAtMs || 0));
}

function normalizeFlowActivityEntries({ activityEntries = [], sourceEventEntries = [] } = {}) {
  const preferredEntries =
    Array.isArray(sourceEventEntries) && sourceEventEntries.length > 0
      ? sourceEventEntries
      : activityEntries;
  return preferredEntries
    .map((entry) => normalizeTimelineActivityEntry(entry))
    .filter((entry) => Number.isFinite(entry.stepAtMs));
}

function buildMatchedIncidentGroups({
  activityEntries = [],
  sourceEventEntries = [],
  sentEntries = [],
} = {}) {
  const activityRecords = normalizeFlowActivityEntries({ activityEntries, sourceEventEntries })
    .filter((entry) => entry.matchedLocations.length > 0)
    .filter((entry) => entry.outcome !== "location_miss");
  const sentRecords = (Array.isArray(sentEntries) ? sentEntries : [])
    .map((entry) => normalizeTimelineSentEntry(entry))
    .filter((entry) => entry.matchedLocations.length > 0)
    .filter((entry) => Number.isFinite(entry.stepAtMs));

  return buildIncidentGroups([...activityRecords, ...sentRecords], buildMatchedIncidentBaseKey);
}

function buildMissIncidentGroups({
  activityEntries = [],
  sourceEventEntries = [],
} = {}) {
  const activityRecords = normalizeFlowActivityEntries({ activityEntries, sourceEventEntries })
    .filter((entry) => entry.outcome === "location_miss")
    .filter((entry) => entry.matchedLocations.length === 0)
    .filter((entry) => entry.rawLocations.length > 0);

  return buildIncidentGroups(activityRecords, buildMissIncidentBaseKey);
}

function buildFlowSummary(group = {}) {
  const steps = Array.isArray(group.steps) ? group.steps : [];
  if (steps.length === 0) return "";
  const firstStepAtMs = steps[0]?.atMs ?? null;
  const compressedSteps = compressFlowSteps(steps);

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
  const countSuffix = step.count > 1 ? ` x${step.count}` : "";
  return `${formatStatusTimestamp(step.at)}${deltaSuffix} | ${step.source} | ${step.outcome}${countSuffix}`;
}

function compressFlowSteps(steps = []) {
  const compressedSteps = [];

  for (const step of steps) {
    const previous = compressedSteps[compressedSteps.length - 1];
    if (
      previous
      && previous.source === step.source
      && previous.outcome === step.outcome
    ) {
      previous.count += Math.max(1, Number.parseInt(step.count, 10) || 1);
      previous.lastAt = step.at;
      previous.lastAtMs = step.atMs;
      continue;
    }

    compressedSteps.push({
      ...step,
      count: Math.max(1, Number.parseInt(step.count, 10) || 1),
      lastAt: step.at,
      lastAtMs: step.atMs,
    });
  }

  return compressedSteps;
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
    rawLocations: [...(entry.rawLocations || [])],
    semanticKey: String(entry.semanticKey || ""),
    deliveryKey: String(entry.deliveryKey || ""),
    alertDate: entry.alertDate ? String(entry.alertDate) : null,
    receivedAt: entry.receivedAt ? String(entry.receivedAt) : null,
    sourceEventAt: entry.sourceEventAt ? String(entry.sourceEventAt) : null,
    deliveryMode: String(entry.deliveryMode || ""),
    transport: String(entry.transport || ""),
    provider: String(entry.provider || ""),
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
  const nextEntry = {
    observedAt: entry.observedAt ? String(entry.observedAt) : null,
    receivedAt: entry.receivedAt ? String(entry.receivedAt) : null,
    alertDate: entry.alertDate ? String(entry.alertDate) : null,
    source: String(entry.source || "unknown"),
    eventType: String(entry.eventType || "unknown"),
    title: String(entry.title || ""),
    matchedLocations: [...(entry.matchedLocations || [])],
    rawLocations: [...(entry.rawLocations || [])],
    semanticKey: String(entry.semanticKey || ""),
    sourceKey: String(entry.sourceKey || ""),
    outcome: String(entry.outcome || "unknown"),
    sourceEventAt: entry.sourceEventAt ? String(entry.sourceEventAt) : null,
    observationCount: Math.max(1, Number.parseInt(entry.observationCount, 10) || 1),
  };

  const existingIndex = entries.findIndex((candidate) =>
    String(candidate?.source || "unknown") === nextEntry.source
    && String(candidate?.sourceKey || "") === nextEntry.sourceKey
    && String(candidate?.semanticKey || "") === nextEntry.semanticKey
    && String(candidate?.outcome || "unknown") === nextEntry.outcome,
  );

  if (existingIndex >= 0) {
    const existing = entries.splice(existingIndex, 1)[0];
    nextEntry.observationCount += Math.max(
      1,
      Number.parseInt(existing?.observationCount, 10) || 1,
    );
  }

  entries.unshift(nextEntry);
  while (entries.length > maxEntries) entries.pop();
  persistJsonList(filePath, entries);
  return entries;
}

export function buildRecentSentMessage(recentSentEntries = [], limit = 5) {
  const groups = buildMatchedIncidentGroups({
    sentEntries: recentSentEntries,
  }).slice(0, Math.max(1, limit));

  if (groups.length === 0) {
    return "recent_sent: none";
  }

  const lines = ["recent_sent:"];

  groups.forEach((group, index) => {
    if (index > 0) lines.push("");

    const sentTargets = [...new Map(
      group.sentTargets
        .filter((target) => target.chatId)
        .map((target) => [target.chatId, target]),
    ).values()];
    const transportCounts = sentTargets.reduce((counts, target) => {
      counts[target.transport] = (counts[target.transport] || 0) + 1;
      return counts;
    }, {});
    const transportSummary = Object.entries(transportCounts)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([transport, count]) => `${transport} x${count}`)
      .join(", ");

    lines.push(
      `${formatStatusTimestamp(group.sentTargets[0]?.at)} | ${formatFlowTitle(group.title, group.eventType)} | ${formatFlowLocations(group.matchedLocations)} | ${group.primarySource || "unknown"}`,
    );
    lines.push(`sent_to: ${transportSummary || "none"}`);
    if (sentTargets.length > 0) {
      lines.push(`targets: ${sentTargets.map((target) => target.chatId).join(", ")}`);
    }
  });

  return lines.join("\n");
}

export function buildLatestAlertFlowSnapshot({
  activityEntries = [],
  sourceEventEntries = [],
  sentEntries = [],
} = {}) {
  const group = buildMatchedIncidentGroups({
    activityEntries,
    sourceEventEntries,
    sentEntries,
  })[0];
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
  sourceEventEntries = [],
  sentEntries = [],
  limit = 3,
  maxStepsPerGroup = 20,
} = {}) {
  const groups = buildMatchedIncidentGroups({
    activityEntries,
    sourceEventEntries,
    sentEntries,
  }).slice(0, Math.max(1, limit));

  if (groups.length === 0) {
    return "recent_flow: none";
  }

  const lines = ["recent_flow:"];
  groups.forEach((group, index) => {
    if (index > 0) lines.push("");
    lines.push(
      `${formatFlowTitle(group.title, group.eventType)} | ${formatFlowLocations(group.matchedLocations)}`,
    );
    const compressedSteps = compressFlowSteps(group.steps);
    for (const step of compressedSteps.slice(0, Math.max(1, maxStepsPerGroup))) {
      lines.push(formatFlowStep(step, group.firstStepAtMs));
    }
    if (compressedSteps.length > maxStepsPerGroup) {
      lines.push(`... ${compressedSteps.length - maxStepsPerGroup} more compressed step(s)`);
    }
  });
  return lines.join("\n");
}

export function buildRecentMissMessage({
  activityEntries = [],
  sourceEventEntries = [],
  limit = 3,
  maxStepsPerGroup = 20,
} = {}) {
  const groups = buildMissIncidentGroups({
    activityEntries,
    sourceEventEntries,
  }).slice(0, Math.max(1, limit));

  if (groups.length === 0) {
    return "recent_miss: none";
  }

  const lines = ["recent_miss:"];
  groups.forEach((group, index) => {
    if (index > 0) lines.push("");
    lines.push(
      `${formatFlowTitle(group.title, group.eventType)} | ${formatFlowLocations(group.rawLocations)}`,
    );
    const compressedSteps = compressFlowSteps(group.steps);
    for (const step of compressedSteps.slice(0, Math.max(1, maxStepsPerGroup))) {
      lines.push(formatFlowStep(step, group.firstStepAtMs));
    }
    if (compressedSteps.length > maxStepsPerGroup) {
      lines.push(`... ${compressedSteps.length - maxStepsPerGroup} more compressed step(s)`);
    }
  });
  return lines.join("\n");
}
