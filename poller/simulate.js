import { detectEventType, matchLocations, resolveSimulationTargets } from "./lib.js";
import { sortAlertsByDate } from "./sources.js";

export function buildAlertFromPayload(payload = {}, defaultLocations = []) {
  const data = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.locations)
      ? payload.locations
      : typeof payload.data === "string" && payload.data.trim()
        ? [payload.data.trim()]
        : defaultLocations;

  return {
    id: payload.id || `simulate-${Date.now()}`,
    source: String(payload.source || "manual"),
    cat: String(payload.cat || payload.category || "1"),
    title: payload.title || "",
    desc: payload.desc || "",
    data,
    alertDate: payload.alertDate || payload.timestamp,
  };
}

export function buildSimulationAlerts(payload = {}, defaultLocations = []) {
  const items = Array.isArray(payload.alerts) && payload.alerts.length > 0
    ? payload.alerts
    : [payload];

  return sortAlertsByDate(items.map((item) => buildAlertFromPayload(item, defaultLocations)));
}

function buildSimulationSummary(results = []) {
  const targets = results.flatMap((result) => result.targets || []);
  return {
    alerts: results.length,
    matchedAlerts: results.filter((result) => result.matchedLocations.length > 0).length,
    sentTargets: targets.filter((target) => !target.skipped).length,
    skippedTargets: targets.filter((target) => target.skipped).length,
    duplicateTargets: targets.filter(
      (target) => target.reason === "duplicate" || target.reason === "notifier_duplicate",
    ).length,
    unmatchedAlerts: results.filter((result) => result.reason === "no_matching_locations").length,
  };
}

function buildSingleAlertCompat(result = {}) {
  return {
    skipped: result.skipped,
    reason: result.reason,
    eventType: result.eventType,
    caption: result.caption,
    targets: result.targets,
    chatId: result.chatId,
    deliveryMode: result.deliveryMode,
  };
}

export async function simulateAlerts(
  payload = {},
  {
    locations = [],
    targetChatIds = [],
    testChatIds = [],
    deliverAlert,
  } = {},
) {
  if (typeof deliverAlert !== "function") {
    throw new TypeError("deliverAlert function is required");
  }

  const dedupeEnabled = payload.dedupe !== false;
  const { chatIds, targetMode } = resolveSimulationTargets(payload, targetChatIds, testChatIds);
  const alerts = buildSimulationAlerts(payload, locations);
  const results = [];

  for (const alert of alerts) {
    const matched = matchLocations(alert, locations);
    if (matched.length === 0) {
      results.push({
        id: alert.id,
        source: alert.source || "manual",
        title: alert.title || "",
        matchedLocations: [],
        skipped: true,
        reason: "no_matching_locations",
        eventType: detectEventType(alert),
        caption: null,
        targets: [],
        chatId: undefined,
        deliveryMode: undefined,
      });
      continue;
    }

    const delivery = await deliverAlert(alert, matched, {
      chatIds,
      dedupe: dedupeEnabled,
      notifierDedupe: dedupeEnabled,
    });
    results.push({
      id: alert.id,
      source: alert.source || "manual",
      title: alert.title || "",
      matchedLocations: matched,
      ...delivery,
    });
  }

  const response = {
    targetMode,
    dedupeEnabled,
    received: alerts.length,
    summary: buildSimulationSummary(results),
    alerts: results,
  };

  if (results.length === 1) {
    return {
      ...response,
      ...buildSingleAlertCompat(results[0]),
    };
  }

  return response;
}
