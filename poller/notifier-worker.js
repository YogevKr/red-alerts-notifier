import { fileURLToPath } from "node:url";
import { createDbPool } from "./db.js";
import { PostgresNotificationOutbox } from "./notification-outbox.js";
import { NOTIFICATION_OUTBOX_NOTIFY_CHANNEL } from "./outbox-schema.js";
import { TelegramNotifier, WhatsAppNotifier } from "./notifier-service.js";
import { createLogger } from "./log.js";
import { createNotifierWorkerLoop } from "./notifier-worker-loop.js";
import {
  buildPostSendPersistenceError,
  chooseNotifier,
  computeRetryDelay,
  createPermanentJobError,
  isAmbiguousSendError,
  processReservedJob,
  processReservedJobs,
  shouldDeadLetterJob,
} from "./notifier-worker-jobs.js";
import {
  createOutboxReadyListenerSupervisor,
  listenForOutboxReady,
} from "./notifier-worker-wakeup.js";

const {
  POLLER_DATABASE_URL = "",
  OUTBOX_POLL_INTERVAL_MS = "1000",
  OUTBOX_RESERVE_BATCH = "5",
  OUTBOX_MAX_CONCURRENCY = "",
  OUTBOX_RETRY_BASE_MS = "15000",
  OUTBOX_PROCESSING_TIMEOUT_MS = "30000",
  OUTBOX_STATUS_REFRESH_MS = "15000",
  OUTBOX_NOTIFY_RECONNECT_DELAY_MS = "5000",
  OUTBOX_MAX_ATTEMPTS = "8",
  NOTIFIER_ACTIVE_TRANSPORTS = "",
  NOTIFIER_WORKER_ID = `notifier-${process.pid}`,
  TELEGRAM_BOT_TOKEN = "",
  POLLER_INTERNAL_URL = "http://poller:3000",
} = process.env;

const logger = createLogger("notifier-worker");
const pool = POLLER_DATABASE_URL
  ? createDbPool({
    connectionString: POLLER_DATABASE_URL,
    applicationName: "red-alerts-notifier-worker",
  })
  : null;
const outbox = pool
  ? new PostgresNotificationOutbox({
    pool,
    workerId: NOTIFIER_WORKER_ID,
    processingTimeoutMs: parsePositiveInt(OUTBOX_PROCESSING_TIMEOUT_MS, 30_000),
  })
  : null;
const whatsappNotifier = new WhatsAppNotifier();
const telegramNotifier = new TelegramNotifier();
const pollIntervalMs = parsePositiveInt(OUTBOX_POLL_INTERVAL_MS, 1000);
const reserveBatch = parsePositiveInt(OUTBOX_RESERVE_BATCH, 5);
const maxConcurrency = parsePositiveInt(OUTBOX_MAX_CONCURRENCY, reserveBatch);
const retryBaseMs = parsePositiveInt(OUTBOX_RETRY_BASE_MS, 15_000);
const statusRefreshMs = parsePositiveInt(OUTBOX_STATUS_REFRESH_MS, 15_000);
const outboxNotifyReconnectDelayMs = parsePositiveInt(OUTBOX_NOTIFY_RECONNECT_DELAY_MS, 5_000);
const maxAttempts = parsePositiveInt(OUTBOX_MAX_ATTEMPTS, 8);
const activeTransportSet = parseNotifierTransports(NOTIFIER_ACTIVE_TRANSPORTS, {
  telegramEnabled: TELEGRAM_BOT_TOKEN.trim().length > 0,
});
const activeNotifiers = [
  ...(activeTransportSet.has("whatsapp") ? [["whatsapp", whatsappNotifier]] : []),
  ...(activeTransportSet.has("telegram") ? [["telegram", telegramNotifier]] : []),
];

export {
  buildPostSendPersistenceError,
  chooseNotifier,
  computeRetryDelay,
  createOutboxReadyListenerSupervisor,
  createPermanentJobError,
  isAmbiguousSendError,
  listenForOutboxReady,
  processReservedJob,
  processReservedJobs,
  shouldDeadLetterJob,
};

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requireOutbox() {
  if (!outbox) {
    throw new Error("POLLER_DATABASE_URL is required");
  }
  return outbox;
}

function parseNotifierTransports(csv = "", { telegramEnabled = false } = {}) {
  const explicit = String(csv)
    .split(",")
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);
  if (explicit.length > 0) {
    return new Set(explicit);
  }

  return new Set([
    "whatsapp",
    ...(telegramEnabled ? ["telegram"] : []),
  ]);
}

function isMainModule(importMetaUrl) {
  return process.argv[1] && fileURLToPath(importMetaUrl) === process.argv[1];
}

async function fetchPoller(path, options = {}) {
  const res = await fetch(`${POLLER_INTERNAL_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.error || `poller ${path} responded ${res.status}`);
  }
  return body;
}

async function reportNotifierWorkerState(update = {}) {
  try {
    await fetchPoller("/ops/notifier_worker", {
      method: "POST",
      body: JSON.stringify({
        enabled: true,
        workerId: NOTIFIER_WORKER_ID,
        ...update,
      }),
    });
  } catch (err) {
    logger.warn("notifier_worker_state_report_failed", {
      error: err,
      poller_internal_url: POLLER_INTERNAL_URL,
    });
  }
}

async function init() {
  const workerOutbox = requireOutbox();
  await workerOutbox.ensureSchema();

  let wakeupMode = "poll_only";
  const workerLoop = createNotifierWorkerLoop({
    outbox: workerOutbox,
    logger,
    activeNotifiers,
    pollIntervalMs,
    statusRefreshMs,
    heartbeatIntervalMs: statusRefreshMs,
    reserveBatch,
    maxConcurrency,
    onHeartbeat: (update) => reportNotifierWorkerState({
      wakeupMode,
      ...update,
    }),
    processReservedJobs,
    processJob: (job, options = {}) => processReservedJob(job, {
      ...options,
      chooseNotifier: (targetJob) => chooseNotifier(targetJob, {
        activeTransportSet,
        telegramNotifier,
        whatsappNotifier,
      }),
      retryBaseMs,
      maxAttempts,
      workerId: NOTIFIER_WORKER_ID,
    }),
  });

  if (pool) {
    try {
      const listener = createOutboxReadyListenerSupervisor({
        channel: NOTIFICATION_OUTBOX_NOTIFY_CHANNEL,
        reconnectDelayMs: outboxNotifyReconnectDelayMs,
        connectClient: async () => pool.connect(),
        listen: listenForOutboxReady,
        onNotify: () => workerLoop.requestImmediateTick(),
        logger,
      });
      const listenerConnected = await listener.start();
      if (listenerConnected) {
        wakeupMode = "listen_notify";
      }
    } catch (err) {
      logger.warn("outbox_ready_listener_unavailable", {
        channel: NOTIFICATION_OUTBOX_NOTIFY_CHANNEL,
        error: err,
      });
    }
  }

  const readiness = await Promise.allSettled(activeNotifiers.map(([, notifier]) => notifier.ensureReady()));
  for (const [index, result] of readiness.entries()) {
    if (result.status === "rejected") {
      const transport = activeNotifiers[index]?.[0] || "unknown";
      logger.warn("notifier_transport_not_ready", {
        transport,
        error: result.reason,
      });
    }
  }

  logger.info("notifier_worker_starting", {
    worker_id: NOTIFIER_WORKER_ID || null,
    transports: [...activeTransportSet],
    reserve_batch: reserveBatch,
    max_concurrency: maxConcurrency,
    poll_interval_ms: pollIntervalMs,
    status_refresh_ms: statusRefreshMs,
    max_attempts: maxAttempts,
    outbox_notify_channel: NOTIFICATION_OUTBOX_NOTIFY_CHANNEL,
    outbox_notify_reconnect_delay_ms: outboxNotifyReconnectDelayMs,
    wakeup_mode: wakeupMode,
  });

  await reportNotifierWorkerState({
    wakeupMode,
    lastError: null,
  });
  workerLoop.start();
}

if (isMainModule(import.meta.url)) {
  init().catch((err) => {
    logger.error("notifier_worker_start_failed", {
      error: err,
    });
    process.exitCode = 1;
  });
}
