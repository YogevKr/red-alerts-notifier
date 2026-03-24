import { buildDeliveryKey, hashDeliveryKey } from "./lib.js";

export function buildOutboxJobs({
  alert,
  matched = [],
  chatIds = [],
  eventType,
  sourceKey,
  nowMs = Date.now(),
} = {}) {
  const source = alert?.source || "manual";
  const sourceReceivedAt = String(alert?.receivedAt || new Date(nowMs).toISOString()).trim()
    || new Date(nowMs).toISOString();

  return {
    source,
    sourceReceivedAt,
    jobs: chatIds.map((chatId) => ({
      deliveryKey: hashDeliveryKey(buildDeliveryKey(alert, matched, { chatId, eventType })),
      sourceKey,
      source,
      eventType,
      chatId,
      sourceReceivedAt,
      payload: {
        alert,
        matched,
        chatId,
        eventType,
        source,
      },
    })),
  };
}

export async function handleUnsupportedAlert({
  alert,
  matched = [],
  eventType,
  chatIds = [],
  pagerDuty,
  logger = console,
  buildAlertLogFields = () => ({}),
} = {}) {
  try {
    await pagerDuty?.triggerIncident?.({
      dedupKey: `unsupported-alert:${alert?.source || "manual"}:${alert?.id || "missing"}`,
      summary: `Unsupported alert payload matched ${matched.join(", ") || "configured locations"}`,
      severity: "critical",
      className: "unsupported-alert-payload",
      customDetails: {
        eventType,
        matchedLocations: matched,
        alert,
      },
    });
  } catch (err) {
    logger.warn?.("unsupported_alert_page_failed", {
      ...buildAlertLogFields(alert, matched, { eventType }),
      error: err,
    });
  }

  logger.warn?.("enqueue_skipped_unsupported_payload", {
    ...buildAlertLogFields(alert, matched, { eventType }),
    target_count: chatIds.length,
  });

  return {
    skipped: true,
    reason: "unsupported_alert_payload",
    eventType,
    targets: [],
  };
}
