import { buildOutboxJobs } from "./alert-enqueue-helpers.js";

export const ALERT_SINK_NAMES = {
  LOG: "log",
  NOTIFICATION_OUTBOX: "notification_outbox",
};

const CONFIGURABLE_ALERT_SINK_NAMES = new Set(Object.values(ALERT_SINK_NAMES));

export function resolveConfiguredAlertSinkNames(csv = "", { databaseUrl = "" } = {}) {
  const explicit = String(csv || "")
    .split(",")
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => CONFIGURABLE_ALERT_SINK_NAMES.has(value));

  if (explicit.length > 0) {
    return [...new Set(explicit)];
  }

  if (String(databaseUrl || "").trim()) {
    return [ALERT_SINK_NAMES.NOTIFICATION_OUTBOX];
  }

  return [ALERT_SINK_NAMES.LOG];
}

export function createLogAlertSink({
  logger = console,
  buildAlertLogFields = () => ({}),
} = {}) {
  return {
    name: ALERT_SINK_NAMES.LOG,
    requiresTargets: false,
    async ensureReady() {},
    async dispatch({
      alert,
      matched,
      chatIds = [],
      eventType,
      sourceKey,
    } = {}) {
      logger.info("alert_sink_logged", {
        sink: ALERT_SINK_NAMES.LOG,
        ...buildAlertLogFields(alert, matched, { eventType, sourceKey }),
        target_count: chatIds.length,
      });

      return {
        sink: ALERT_SINK_NAMES.LOG,
        acceptedCount: 1,
        duplicateCount: 0,
        skipped: false,
        reason: null,
        targets: [{
          sink: ALERT_SINK_NAMES.LOG,
          skipped: false,
          reason: null,
          chatId: null,
          status: "logged",
        }],
      };
    },
  };
}

export function createNotificationOutboxAlertSink({
  notificationOutbox,
  whatsappTargetStaggerMs = 0,
  logger = console,
  suppressionReporter = { record() {} },
  buildAlertLogFields = () => ({}),
  buildTargetLogFields = () => ({}),
} = {}) {
  return {
    name: ALERT_SINK_NAMES.NOTIFICATION_OUTBOX,
    requiresTargets: true,
    async ensureReady() {
      if (!notificationOutbox) {
        throw new Error("POLLER_DATABASE_URL is required for notification_outbox sink");
      }

      await notificationOutbox.ensureSchema();
    },
    async dispatch({
      alert,
      matched,
      chatIds = [],
      eventType,
      semanticKey,
      sourceKey,
      nowMs = Date.now(),
    } = {}) {
      if (!notificationOutbox) {
        throw new Error("POLLER_DATABASE_URL is required for notification_outbox sink");
      }

      const { jobs } = buildOutboxJobs({
        alert,
        matched,
        chatIds,
        eventType,
        semanticKey,
        sourceKey,
        nowMs,
        whatsappTargetStaggerMs,
      });
      const enqueueResults = await notificationOutbox.enqueueMany(jobs, nowMs);
      const targets = enqueueResults.map((result, index) => ({
        sink: ALERT_SINK_NAMES.NOTIFICATION_OUTBOX,
        skipped: !result.enqueued,
        key: jobs[index].deliveryKey,
        eventType,
        reason: result.reason,
        chatId: jobs[index].chatId,
        outboxId: result.id,
        outboxStatus: result.status,
      }));
      const acceptedTargets = targets.filter((target) => !target.skipped);
      const duplicateTargets = targets.filter((target) => target.reason === "duplicate");

      for (const target of targets) {
        const baseFields = {
          sink: ALERT_SINK_NAMES.NOTIFICATION_OUTBOX,
          ...buildAlertLogFields(alert, matched, { eventType, sourceKey }),
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
        sink: ALERT_SINK_NAMES.NOTIFICATION_OUTBOX,
        acceptedCount: acceptedTargets.length,
        duplicateCount: duplicateTargets.length,
        skipped: acceptedTargets.length === 0,
        reason: acceptedTargets.length === 0 ? "duplicate" : null,
        targets,
      };
    },
    async recordDuplicate({
      alert,
      matched,
      chatIds = [],
      eventType,
      semanticKey,
      sourceKey,
      nowMs = Date.now(),
    } = {}) {
      if (!semanticKey || !notificationOutbox) return [];

      const { jobs } = buildOutboxJobs({
        alert,
        matched,
        chatIds,
        eventType,
        semanticKey,
        sourceKey,
        nowMs,
        whatsappTargetStaggerMs,
      });
      return notificationOutbox.insertDuplicateMany(jobs, nowMs);
    },
  };
}
