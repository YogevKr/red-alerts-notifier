import { parseNotifierTarget } from "./notifier-service.js";

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createPermanentJobError(message, code = "permanent_notifier_error") {
  const err = new Error(message);
  err.code = code;
  err.permanent = true;
  return err;
}

export function buildPostSendPersistenceError(err) {
  const message = String(err?.message || err || "post-send persistence failed");
  const wrapped = createPermanentJobError(
    `post-send state persistence failed after provider accepted delivery: ${message}`,
    "post_send_persistence_failed",
  );
  wrapped.cause = err;
  return wrapped;
}

export function shouldDeadLetterJob(err, job = {}, { maxAttempts = 8 } = {}) {
  if (err?.permanent) {
    return true;
  }

  return Number(job?.attempt_count || 0) >= maxAttempts;
}

export function chooseNotifier(job = {}, {
  activeTransportSet = new Set(["whatsapp"]),
  telegramNotifier = null,
  whatsappNotifier = null,
} = {}) {
  const payload = job?.payload && typeof job.payload === "object"
    ? job.payload
    : job?.payload_json && typeof job.payload_json === "object"
      ? job.payload_json
      : {};
  const target = parseNotifierTarget(payload.chatId || job?.chat_id || "");
  const transport = target.transport === "telegram" ? "telegram" : "whatsapp";
  if (!activeTransportSet.has(transport)) {
    throw createPermanentJobError(`notifier transport disabled: ${transport}`, "transport_disabled");
  }
  return transport === "telegram" ? telegramNotifier : whatsappNotifier;
}

function buildJobLogFields(job = {}, workerId = "") {
  const payload = job?.payload && typeof job.payload === "object"
    ? job.payload
    : job?.payload_json && typeof job.payload_json === "object"
      ? job.payload_json
      : {};
  const target = parseNotifierTarget(payload.chatId || job?.chat_id || "");
  return {
    outbox_id: job.id || null,
    delivery_key: job.delivery_key || null,
    source_key: job.source_key || null,
    source: job.source || payload.source || "unknown",
    event_type: job.event_type || payload.eventType || null,
    chat_id: target.normalized || String(job.chat_id || payload.chatId || "").trim(),
    transport: target.transport || "whatsapp",
    attempt_count: job.attempt_count || 0,
    worker_id: workerId || null,
  };
}

export function computeRetryDelay(attemptCount = 1, retryBaseMs = 15_000) {
  return Math.min(
    retryBaseMs * Math.max(1, 2 ** Math.max(0, attemptCount - 1)),
    2 * 60 * 1000,
  );
}

export function isAmbiguousSendError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return [
    "aborted",
    "timeout",
    "timed out",
    "fetch failed",
    "socket hang up",
    "network",
    "econnreset",
    "terminated",
  ].some((fragment) => message.includes(fragment));
}

async function markJobUncertain(job, outbox, logger, fields, err, timestamp) {
  try {
    await outbox.markUncertain(job.id, err.message, timestamp);
  } catch (markErr) {
    logger.error?.("outbox_transition_failed", {
      ...fields,
      intended_status: "uncertain",
      original_error: err,
      transition_error: markErr,
    });
    return;
  }

  logger.warn?.("notifier_delivery_uncertain", {
    ...fields,
    error: err,
  });
}

async function markJobDeadLettered(job, outbox, logger, fields, err, timestamp) {
  try {
    await outbox.markDeadLettered(job.id, err.message, timestamp);
  } catch (markErr) {
    logger.error?.("outbox_transition_failed", {
      ...fields,
      intended_status: "dead_lettered",
      original_error: err,
      transition_error: markErr,
    });
    return;
  }

  logger.warn?.("notifier_delivery_dead_lettered", {
    ...fields,
    error: err,
  });
}

export async function processReservedJob(job, {
  outbox,
  logger = console,
  chooseNotifier: chooseNotifierFn,
  retryBaseMs = 15_000,
  maxAttempts = 8,
  now = () => Date.now(),
  workerId = "",
} = {}) {
  const reservedAt = now();
  const fields = buildJobLogFields(job, workerId);
  let deliveryResult = null;

  try {
    const notifier = chooseNotifierFn(job);
    await outbox.markDispatchStarted(job.id, reservedAt);
    logger.info?.("outbox_job_reserved", fields);

    const result = await notifier.send(job);
    deliveryResult = result;
    const sentAt = now();

    await outbox.markSent(job.id, {
      now: sentAt,
      payloadPatch: {
        sentAt: new Date(sentAt).toISOString(),
        deliveryMode: result.deliveryMode || result.mode || "",
        transport: result.transport || "whatsapp",
        instanceName: result.instanceName || "",
        usedFallback: Boolean(result.usedFallback),
        providerMessageId: result.providerMessageId ?? null,
      },
    });

    if (result.skipped) {
      logger.debug?.("notifier_delivery_skipped", {
        ...fields,
        reason: result.reason,
      });
      return;
    }

    logger.info?.("notifier_delivery_completed", {
      ...fields,
      delivery_mode: result.deliveryMode || result.mode || "",
      provider_message_id: result.providerMessageId ?? null,
      instance_name: result.instanceName || "",
      used_fallback: Boolean(result.usedFallback),
      transport: result.transport || fields.transport,
    });
  } catch (err) {
    const timestamp = now();

    if (deliveryResult && !deliveryResult.skipped) {
      await markJobUncertain(
        job,
        outbox,
        logger,
        fields,
        buildPostSendPersistenceError(err),
        timestamp,
      );
      return;
    }

    if (isAmbiguousSendError(err)) {
      await markJobUncertain(job, outbox, logger, fields, err, timestamp);
      return;
    }

    if (shouldDeadLetterJob(err, job, { maxAttempts })) {
      await markJobDeadLettered(job, outbox, logger, fields, err, timestamp);
      return;
    }

    const retryDelayMs = computeRetryDelay(job.attempt_count, retryBaseMs);
    await outbox.markFailed(job.id, err.message, {
      now: timestamp,
      retryDelayMs,
    });
    logger.warn?.("notifier_delivery_failed", {
      ...fields,
      retry_delay_ms: retryDelayMs,
      error: err,
    });
  }
}

export async function processReservedJobs(jobs = [], {
  concurrency = 1,
  processJob = processReservedJob,
  outbox,
  logger = console,
} = {}) {
  const queue = [...jobs];
  const workerCount = Math.min(queue.length, Math.max(1, parsePositiveInt(concurrency, 1)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      try {
        await processJob(job, {
          outbox,
          logger,
        });
      } catch (err) {
        logger.error?.("outbox_job_process_failed", {
          outbox_id: job.id || null,
          error: err,
        });
      }
    }
  }));
}
