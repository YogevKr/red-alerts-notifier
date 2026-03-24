export function createAlertProcessingSummary() {
  return {
    matched_alert_count: 0,
    seen_skipped_count: 0,
    enqueued_target_count: 0,
    duplicate_enqueue_count: 0,
  };
}

export function createAlertPipeline({
  suppressionReporter = { record() {} },
  matchLocations,
  locations,
  buildSeenSourceAlertKey,
  hasSeenSourceAlertKey,
  rememberSeenSourceAlertKey,
  enqueueAlertNotifications,
  targetChatIds,
  parseEventDate,
  buildAlertLogFields,
  detectEventType,
  buildSemanticAlertKey = () => "",
  isExplicitlySupportedAlert,
  isDeliverableEventType,
  rememberRecentAlertFlow = () => {},
  toIsoString = (timestampMs = Date.now()) => new Date(timestampMs).toISOString(),
  rememberDeliveredKey,
  hashDeliveryKey,
  buildDeliveryKey,
} = {}) {
  function inspectAlert(alert) {
    const matched = matchLocations(alert, locations);
    const eventType = detectEventType(alert);
    const sourceKey = buildSeenSourceAlertKey(alert);
    const eventTimestampMs = parseEventDate(alert.alertDate).getTime();

    return {
      alert,
      matched,
      eventType,
      semanticKey: buildSemanticAlertKey(alert, matched, { eventType }),
      sourceKey,
      eventTimestampMs,
      supported: isExplicitlySupportedAlert(alert, eventType),
      deliverable: isDeliverableEventType(eventType),
    };
  }

  function rememberFlow(context, outcome) {
    rememberRecentAlertFlow({
      observedAt: toIsoString(),
      receivedAt: context.alert?.receivedAt || null,
      alertDate: context.alert?.alertDate || null,
      source: context.alert?.source || "unknown",
      eventType: context.eventType,
      title: context.alert?.title || "",
      matchedLocations: context.matched,
      semanticKey: context.semanticKey,
      sourceKey: context.sourceKey,
      outcome,
    });
  }

  function recordSeenSuppression(context) {
    suppressionReporter.record("seen_source_alert", context.sourceKey, {
      ...buildAlertLogFields(context.alert, context.matched, {
        eventType: context.eventType,
        sourceKey: context.sourceKey,
      }),
    });
  }

  async function ingestAlert(alert, {
    chatIds = targetChatIds,
    summary = null,
  } = {}) {
    const context = inspectAlert(alert);
    if (context.matched.length === 0) {
      return {
        ...context,
        matchedAlert: false,
        skipped: true,
        reason: "location_miss",
      };
    }

    if (summary) {
      summary.matched_alert_count += 1;
    }

    if (hasSeenSourceAlertKey(context.sourceKey)) {
      if (summary) {
        summary.seen_skipped_count += 1;
      }
      recordSeenSuppression(context);
      rememberFlow(context, "seen_source_alert");
      return {
        ...context,
        matchedAlert: true,
        skipped: true,
        reason: "seen_source_alert",
      };
    }

    const enqueueResult = await enqueueAlertNotifications(context.alert, context.matched, {
      chatIds,
    });

    if (summary) {
      summary.enqueued_target_count += enqueueResult.enqueuedCount || 0;
      summary.duplicate_enqueue_count += enqueueResult.duplicateCount || 0;
    }
    rememberFlow(
      context,
      enqueueResult.reason || (enqueueResult.skipped ? "skipped" : "enqueued"),
    );

    rememberSeenSourceAlertKey(context.sourceKey, context.eventTimestampMs);

    return {
      ...context,
      matchedAlert: true,
      skipped: Boolean(enqueueResult.skipped),
      reason: enqueueResult.reason || null,
      enqueueResult,
    };
  }

  async function ingestAlerts(alerts = [], options = {}) {
    const results = [];
    for (const alert of alerts) {
      results.push(await ingestAlert(alert, options));
    }
    return results;
  }

  function seedAlert(alert, { chatIds = targetChatIds } = {}) {
    const context = inspectAlert(alert);
    if (context.matched.length === 0) {
      return {
        ...context,
        seededDeliveries: 0,
        seededSourceAlerts: 0,
      };
    }

    let seededSourceAlerts = 0;
    let seededDeliveries = 0;

    if (rememberSeenSourceAlertKey(context.sourceKey, context.eventTimestampMs)) {
      seededSourceAlerts += 1;
    }

    if (!context.supported || !context.deliverable) {
      return {
        ...context,
        seededDeliveries,
        seededSourceAlerts,
      };
    }

    for (const chatId of chatIds) {
      if (rememberDeliveredKey(
        hashDeliveryKey(buildDeliveryKey(context.alert, context.matched, {
          chatId,
          eventType: context.eventType,
        })),
        context.eventTimestampMs,
      )) {
        seededDeliveries += 1;
      }
    }

    return {
      ...context,
      seededDeliveries,
      seededSourceAlerts,
    };
  }

  async function seedAlerts(alerts = [], options = {}) {
    let seededDeliveries = 0;
    let seededSourceAlerts = 0;

    for (const alert of alerts) {
      const result = seedAlert(alert, options);
      seededDeliveries += result.seededDeliveries;
      seededSourceAlerts += result.seededSourceAlerts;
    }

    return {
      seededDeliveries,
      seededSourceAlerts,
    };
  }

  return {
    inspectAlert,
    ingestAlert,
    ingestAlerts,
    seedAlert,
    seedAlerts,
  };
}
