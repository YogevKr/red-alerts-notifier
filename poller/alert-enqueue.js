import { alertKey, detectEventType, formatMessage, isDeliverableEventType, isExplicitlySupportedAlert } from "./lib.js";
import { parseNotifierTarget } from "./notifier-target.js";
import { buildPresetAlert } from "./preset-alerts.js";
import { handleUnsupportedAlert } from "./alert-enqueue-helpers.js";

export function buildTargetLogFields(chatId = "") {
  const target = parseNotifierTarget(chatId);
  return {
    chat_id: target.normalized || String(chatId || "").trim(),
    transport: target.transport || "whatsapp",
  };
}

export function buildAlertLogFields(alert = {}, matched = [], { eventType, sourceKey, buildSeenSourceAlertKey } = {}) {
  return {
    alert_id: alert.id || null,
    alert_key: alertKey(alert),
    source: alert.source || "manual",
    source_key: sourceKey || buildSeenSourceAlertKey(alert),
    event_type: eventType || detectEventType(alert),
    matched_locations: matched,
    alert_date: alert.alertDate || null,
    title: alert.title || "",
  };
}

export function summarizeSourceResults(sourceResults = {}) {
  return Object.fromEntries(
    Object.entries(sourceResults).map(([source, result]) => [
      source,
      {
        ok: Boolean(result?.ok),
        alert_count: result?.count || 0,
        raw_record_count: result?.rawCount || 0,
        duration_ms: result?.durationMs || 0,
        error: result?.error || null,
      },
    ]),
  );
}

export function createAlertEnqueuer({
  logger = console,
  pagerDuty,
  suppressionReporter,
  runtimeState,
  locations,
  targetChatIds,
  alertSinks = [],
  buildOpsTargetLabel,
  buildSeenSourceAlertKey,
} = {}) {
  function requireAlertSinks() {
    if (!Array.isArray(alertSinks) || alertSinks.length === 0) {
      throw new Error("At least one alert sink must be configured");
    }

    return alertSinks;
  }

  async function ensureAlertSinksReady() {
    for (const sink of requireAlertSinks()) {
      await sink.ensureReady?.();
    }
  }

  async function recordDuplicateAlert({
    alert,
    matched,
    chatIds = targetChatIds,
    eventType,
    semanticKey,
    sourceKey,
  } = {}) {
    if (!semanticKey) return;

    for (const sink of requireAlertSinks()) {
      await sink.recordDuplicate?.({
        alert,
        matched,
        chatIds,
        eventType,
        semanticKey,
        sourceKey,
      });
    }
  }

  async function enqueueAlertNotifications(
    alert,
    matched,
    { chatIds = targetChatIds, semanticKey = "" } = {},
  ) {
    if (!runtimeState.deliveryEnabled) {
      logger.warn("enqueue_skipped_muted", {
        ...buildAlertLogFields(alert, matched, { buildSeenSourceAlertKey }),
        target_count: chatIds.length,
      });
      return {
        skipped: true,
        reason: "delivery_disabled",
        eventType: detectEventType(alert),
        targets: [],
      };
    }

    const eventType = detectEventType(alert);
    if (!isDeliverableEventType(eventType)) {
      logger.warn("enqueue_skipped_unknown_event_type", {
        ...buildAlertLogFields(alert, matched, { eventType, buildSeenSourceAlertKey }),
        target_count: chatIds.length,
      });
      return {
        skipped: true,
        reason: "unknown_event_type",
        eventType,
        targets: [],
      };
    }

    if (!isExplicitlySupportedAlert(alert, eventType)) {
      return handleUnsupportedAlert({
        alert,
        matched,
        eventType,
        chatIds,
        pagerDuty,
        logger,
        buildAlertLogFields: (value, areas, options = {}) =>
          buildAlertLogFields(value, areas, { ...options, buildSeenSourceAlertKey }),
      });
    }

    const caption = formatMessage(alert, matched, { eventType });
    const sourceKey = buildSeenSourceAlertKey(alert);
    const sinks = requireAlertSinks();

    logger.info("alert_matched", {
      ...buildAlertLogFields(alert, matched, { eventType, sourceKey, buildSeenSourceAlertKey }),
      target_count: chatIds.length,
    });
    const runnableSinks = [];

    for (const sink of sinks) {
      if (sink.requiresTargets && chatIds.length === 0) {
        logger.warn("alert_sink_skipped_no_targets", {
          sink: sink.name || "unknown",
          ...buildAlertLogFields(alert, matched, { eventType, sourceKey, buildSeenSourceAlertKey }),
        });
        continue;
      }
      runnableSinks.push(sink);
    }

    if (runnableSinks.length === 0) {
      return {
        skipped: true,
        reason: "no_targets",
        eventType,
        targets: [],
        sinkResults: [],
      };
    }

    const sinkResults = [];
    for (const sink of runnableSinks) {
      sinkResults.push(await sink.dispatch({
        alert,
        matched,
        chatIds,
        eventType,
        semanticKey,
        sourceKey,
      }));
    }

    const targets = sinkResults.flatMap((result) => result.targets || []);
    const enqueuedCount = sinkResults.reduce(
      (total, result) => total + Number(result.acceptedCount || 0),
      0,
    );
    const duplicateCount = sinkResults.reduce(
      (total, result) => total + Number(result.duplicateCount || 0),
      0,
    );
    const reason = enqueuedCount === 0
      ? sinkResults.find((result) => result.reason)?.reason || "no_targets"
      : undefined;

    return {
      skipped: enqueuedCount === 0,
      reason,
      eventType,
      caption,
      enqueuedCount,
      duplicateCount,
      targets,
      sinkResults,
      chatId: targets.length === 1 ? targets[0].chatId : undefined,
    };
  }

  async function enqueuePresetAlert({
    eventType,
    chatIds = targetChatIds,
    source = "ops_api",
    desc = "זוהי הודעת בדיקה בלבד",
    idPrefix = "preset-alert",
  } = {}) {
    const needsTargets = requireAlertSinks().some((sink) => sink.requiresTargets);
    if (needsTargets && (!Array.isArray(chatIds) || chatIds.length === 0)) {
      throw new Error("No targets configured");
    }

    const alert = buildPresetAlert(eventType, locations, {
      idPrefix,
      source,
      desc,
    });
    const caption = formatMessage(alert, locations, { eventType });
    const result = await enqueueAlertNotifications(alert, locations, { chatIds });

    return {
      ...result,
      message: caption,
      targetLabel: buildOpsTargetLabel(chatIds),
    };
  }

  return {
    requireAlertSinks,
    ensureAlertSinksReady,
    recordDuplicateAlert,
    enqueuePresetAlert,
    enqueueAlertNotifications,
    buildTargetLogFields,
    buildAlertLogFields: (alert, matched, options = {}) =>
      buildAlertLogFields(alert, matched, { ...options, buildSeenSourceAlertKey }),
    summarizeSourceResults,
  };
}
