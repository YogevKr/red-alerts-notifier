import { alertKey, detectEventType, formatMessage, isDeliverableEventType, isExplicitlySupportedAlert } from "./lib.js";
import { parseNotifierTarget } from "./notifier-target.js";
import { buildPresetAlert } from "./preset-alerts.js";
import { buildOutboxJobs, handleUnsupportedAlert } from "./alert-enqueue-helpers.js";

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
  notificationOutbox,
  buildOpsTargetLabel,
  buildSeenSourceAlertKey,
} = {}) {
  function requireNotificationOutbox() {
    if (!notificationOutbox) {
      throw new Error("POLLER_DATABASE_URL is required");
    }

    return notificationOutbox;
  }

  async function enqueueAlertNotifications(
    alert,
    matched,
    { chatIds = targetChatIds } = {},
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

    const outbox = requireNotificationOutbox();
    const caption = formatMessage(alert, matched, { eventType });
    const sourceKey = buildSeenSourceAlertKey(alert);
    const enqueueNowMs = Date.now();
    const { jobs } = buildOutboxJobs({
      alert,
      matched,
      chatIds,
      eventType,
      sourceKey,
      nowMs: enqueueNowMs,
    });

    logger.info("alert_matched", {
      ...buildAlertLogFields(alert, matched, { eventType, sourceKey, buildSeenSourceAlertKey }),
      target_count: chatIds.length,
    });
    const enqueueResults = await outbox.enqueueMany(jobs, enqueueNowMs);
    const targets = enqueueResults.map((result, index) => ({
      skipped: !result.enqueued,
      key: jobs[index].deliveryKey,
      eventType,
      reason: result.reason,
      chatId: jobs[index].chatId,
      outboxId: result.id,
      outboxStatus: result.status,
    }));
    const enqueuedTargets = targets.filter((target) => !target.skipped);
    const duplicateTargets = targets.filter((target) => target.reason === "duplicate");

    for (const target of targets) {
      const baseFields = {
        ...buildAlertLogFields(alert, matched, { eventType, sourceKey, buildSeenSourceAlertKey }),
        outbox_id: target.outboxId || null,
        outbox_status: target.outboxStatus || null,
        delivery_key: target.key,
        ...buildTargetLogFields(target.chatId),
      };

      if (target.skipped) {
        suppressionReporter.record("duplicate_enqueue", target.key, {
          ...baseFields,
          reason: target.reason,
        });
        logger.debug("outbox_job_duplicate", {
          ...baseFields,
          reason: target.reason,
        });
        continue;
      }

      logger.info("outbox_job_enqueued", baseFields);
    }

    return {
      skipped: enqueuedTargets.length === 0,
      reason: enqueuedTargets.length === 0 ? "duplicate" : undefined,
      eventType,
      caption,
      enqueuedCount: enqueuedTargets.length,
      duplicateCount: duplicateTargets.length,
      targets,
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
    if (!Array.isArray(chatIds) || chatIds.length === 0) {
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
    requireNotificationOutbox,
    enqueuePresetAlert,
    enqueueAlertNotifications,
    buildTargetLogFields,
    buildAlertLogFields: (alert, matched, options = {}) =>
      buildAlertLogFields(alert, matched, { ...options, buildSeenSourceAlertKey }),
    summarizeSourceResults,
  };
}
