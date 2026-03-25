import { formatStatusTimestamp } from "./lib.js";

export const TELEGRAM_COMMANDS = [
  { command: "status", description: "Show delivery and sender status" },
  { command: "recent_received", description: "Show latest raw OREF rows" },
  { command: "recent_received_town", description: "Show latest town-matched raw OREF rows" },
  { command: "recent_flow", description: "Show recent cross-source timing flow" },
  { command: "recent_sent", description: "Show latest WhatsApp deliveries" },
  { command: "send", description: "Send a preset WhatsApp alert" },
  { command: "mute", description: "Mute WhatsApp delivery" },
  { command: "unmute", description: "Unmute WhatsApp delivery" },
];

export const TELEGRAM_CALLBACK_ACTIONS = {
  CONFIRM_MUTE: "confirm_mute",
  CONFIRM_UNMUTE: "confirm_unmute",
  CANCEL: "cancel",
};

const TELEGRAM_TRANSIENT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TELEGRAM_TRANSIENT_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const TELEGRAM_RETRY_DELAYS_MS = [500, 1500];

export function parseTelegramAllowedUserIds(csv = "") {
  return [...new Set(
    String(csv)
      .split(",")
      .map((value) => String(value).trim())
      .filter(Boolean),
  )];
}

export function normalizeTelegramCommand(text = "") {
  const command = String(text).trim().split(/\s+/, 1)[0] || "";
  const normalized = command.replace(/@\w+$/, "").toLowerCase();
  if (normalized === "/recent_recieve") return "/recent_received";
  return normalized;
}

export function buildTelegramConfirmationMarkup(action) {
  const isMute = action === TELEGRAM_CALLBACK_ACTIONS.CONFIRM_MUTE;
  const confirmText = isMute ? "Confirm mute" : "Confirm unmute";
  return {
    inline_keyboard: [
      [
        {
          text: confirmText,
          callback_data: action,
          style: isMute ? "danger" : "success",
        },
        {
          text: "Cancel",
          callback_data: TELEGRAM_CALLBACK_ACTIONS.CANCEL,
        },
      ],
    ],
  };
}

export function parseTelegramCallbackAction(data = "") {
  const value = String(data).trim().toLowerCase();
  return Object.values(TELEGRAM_CALLBACK_ACTIONS).includes(value) ? value : "";
}

export function buildTelegramConfirmationPrompt(action) {
  if (action === TELEGRAM_CALLBACK_ACTIONS.CONFIRM_MUTE) {
    return "Mute WhatsApp delivery?\nPolling and debug capture will keep running.";
  }

  if (action === TELEGRAM_CALLBACK_ACTIONS.CONFIRM_UNMUTE) {
    return "Unmute WhatsApp delivery and resume sends?";
  }

  return "Action cancelled.";
}

function escapeTelegramHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildTelegramStatusFocus({
  deliveryEnabled = true,
  poll = null,
  database = null,
  outbox = null,
  sourceFailures = null,
  realtimeSources = null,
  whatsapp = null,
  telegram = null,
} = {}) {
  if (!deliveryEnabled) {
    return "focus: delivery muted";
  }

  if (database?.enabled && database.lastError) {
    return "focus: database error";
  }

  if (Number(poll?.consecutivePollErrors || 0) > 0) {
    return `focus: poll failing errs=${Number(poll?.consecutivePollErrors || 0)}`;
  }

  if (Number(outbox?.uncertain || 0) > 0) {
    return `focus: uncertain deliveries=${Number(outbox.uncertain || 0)}`;
  }

  if (Number(outbox?.failed || 0) > 0) {
    return `focus: failed deliveries=${Number(outbox.failed || 0)}`;
  }

  if (Number(outbox?.deadLettered || 0) > 0) {
    return `focus: dead-lettered deliveries=${Number(outbox.deadLettered || 0)}`;
  }

  if (Number(outbox?.pending || 0) > 0 || Number(outbox?.processing || 0) > 0) {
    return (
      `focus: outbox backlog pending=${Number(outbox?.pending || 0)}`
      + ` processing=${Number(outbox?.processing || 0)}`
    );
  }

  if (telegram?.enabled && telegram.lastError) {
    return "focus: telegram sender error";
  }

  if (whatsapp?.enabled && whatsapp.lastError) {
    return "focus: whatsapp sender error";
  }

  const disconnectedRealtimeSource = Object.entries(realtimeSources || {})
    .find(([, status]) => status?.enabled && !status?.connected);
  if (disconnectedRealtimeSource) {
    return `focus: ${disconnectedRealtimeSource[0]} disconnected`;
  }

  const failingSource = Object.entries(sourceFailures || {})
    .filter(([, status]) => Number(status?.consecutiveFailures || 0) > 0)
    .sort((left, right) =>
      Number(right[1]?.consecutiveFailures || 0) - Number(left[1]?.consecutiveFailures || 0))[0];
  if (failingSource) {
    const [source, status] = failingSource;
    return `focus: ${source} failing (${Number(status?.consecutiveFailures || 0)})`;
  }

  return "focus: healthy";
}

export function buildTelegramStatusMessage({
  deliveryEnabled = true,
  activeSources = [],
  transports = [],
  destinations = null,
  sender = null,
  whatsapp = null,
  telegram = null,
  activeInstance = "",
  primaryState = "",
  fallbackState = "",
  lastDeliveredAt = null,
  lastDeliveredEventType = null,
  lastDeliveredSource = null,
  latestFlow = null,
  targets = [],
  poll = null,
  database = null,
  outbox = null,
  sourceFailures = null,
  realtimeSources = null,
  format = "plain",
} = {}) {
  const formatTimestamp = (value) => (value ? formatStatusTimestamp(value) : "never");
  const normalizedTransports = [...new Set(
    (Array.isArray(transports) ? transports : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  )];
  const destinationLabels = Array.isArray(destinations?.labels) && destinations.labels.length > 0
    ? destinations.labels
    : Array.isArray(targets)
      ? targets
      : [];
  const senderLabel = String(
    sender?.label
    || (normalizedTransports.length === 1 && normalizedTransports[0] === "telegram"
      ? "telegram-bot"
      : activeInstance || ""),
  ).trim() || "unknown";
  const focusLine = buildTelegramStatusFocus({
    deliveryEnabled,
    poll,
    database,
    outbox,
    sourceFailures,
    realtimeSources,
    whatsapp,
    telegram,
  });
  const lines = [
    focusLine,
    `active_sources: ${Array.isArray(activeSources) && activeSources.length > 0 ? activeSources.join(", ") : "none"}`,
    `delivery: ${deliveryEnabled ? "on" : "off"}`,
    `sender: ${senderLabel}`,
  ];

  if (normalizedTransports.length > 0) {
    lines.push(`transports: ${normalizedTransports.join(", ")}`);
  }

  if (destinationLabels.length > 0) {
    lines.push(`${destinationLabels.length === 1 ? "destination" : "destinations"}: ${destinationLabels.join(", ")}`);
  } else {
    lines.push(`targets: ${targets.length}`);
  }

  const whatsappEnabled = Boolean(whatsapp?.enabled)
    || normalizedTransports.includes("whatsapp");
  if (whatsappEnabled) {
    lines.push(`primary: ${whatsapp?.primaryState || primaryState || "unknown"}`);
    lines.push(`fallback: ${whatsapp?.fallbackState || fallbackState || "unknown"}`);
  }

  const telegramEnabled = Boolean(telegram?.enabled)
    || normalizedTransports.includes("telegram");
  if (telegramEnabled) {
    lines.push(
      `telegram: ${telegram?.lastError ? "error" : "ok"}`
      + ` checked_at=${formatTimestamp(telegram?.lastCheckedAt)}`,
    );
    if (telegram?.lastDeliveredChatId) {
      lines.push(`telegram_last_chat: telegram:${telegram.lastDeliveredChatId}`);
    }
    if (telegram?.lastError) {
      lines.push(`telegram_error: ${telegram.lastError}`);
    }
  }

  if (poll) {
    const pollHealthy = Number(poll.consecutivePollErrors || 0) === 0;
    lines.push(
      `poll: ${pollHealthy ? "ok" : "failing"}`
      + ` errs=${Number(poll.consecutivePollErrors || 0)}`
      + ` last_ok=${formatTimestamp(poll.lastPollSuccessAt)}`,
    );
    if (!pollHealthy && poll.lastPollError) {
      lines.push(`poll_error: ${poll.lastPollError}`);
    }
  }

  if (database?.enabled) {
    lines.push(
      `db: ${database.lastError ? "error" : "ok"}`
      + ` latency_ms=${database.latencyMs ?? "n/a"}`
      + ` checked_at=${formatTimestamp(database.lastCheckedAt)}`,
    );
    if (database.lastError) {
      lines.push(`db_error: ${database.lastError}`);
    }
  }

  if (lastDeliveredAt) {
    lines.push(`last_delivered_at: ${formatStatusTimestamp(lastDeliveredAt)}`);
    lines.push(`last_delivered_type: ${lastDeliveredEventType || "unknown"}`);
    lines.push(`last_delivered_source: ${lastDeliveredSource || "unknown"}`);
  }
  if (outbox) {
    lines.push(
      `outbox: pending=${Number(outbox.pending || 0)}`
      + ` processing=${Number(outbox.processing || 0)}`
      + ` failed=${Number(outbox.failed || 0)}`
      + ` uncertain=${Number(outbox.uncertain || 0)}`
      + ` dead=${Number(outbox.deadLettered || 0)}`,
    );
    const latency = outbox.latency || {};
    if (latency.endToEndMs?.count > 0) {
      lines.push(
        `latency_ms: e2e p50=${latency.endToEndMs.p50} p95=${latency.endToEndMs.p95}`
        + ` queue p50=${latency.queueMs?.p50 ?? "n/a"} p95=${latency.queueMs?.p95 ?? "n/a"}`
        + ` send p50=${latency.sendMs?.p50 ?? "n/a"} p95=${latency.sendMs?.p95 ?? "n/a"}`
        + ` n=${latency.endToEndMs.count}`,
      );
      if (latency.sourceToEnqueueMs?.count > 0) {
        lines.push(
          `latency_src_enqueue_ms: p50=${latency.sourceToEnqueueMs.p50}`
          + ` p95=${latency.sourceToEnqueueMs.p95}`,
        );
      }
    }
  }

  const realtimeSourceStatuses = realtimeSources || {};

  for (const [source, status] of Object.entries(sourceFailures || {})) {
    if (source in realtimeSourceStatuses) continue;
    if (!status) continue;
    const isFailing = Number(status.consecutiveFailures || 0) > 0;
    lines.push(
      `${source}: ${isFailing ? "fail" : "ok"}`
      + ` fails=${Number(status.consecutiveFailures || 0)}`
      + ` last_ok=${formatTimestamp(status.lastSuccessAt)}`,
    );
    if (isFailing && status.lastError) {
      lines.push(`${source}_error: ${status.lastError}`);
    }
  }

  for (const [source, status] of Object.entries(realtimeSourceStatuses)) {
    if (!status?.enabled) continue;
    lines.push(
      `${source}: ${status.connected ? "connected" : "disconnected"}`
      + ` recv=${Number(status.receivedCount || 0)}`
      + ` alerts=${Number(status.alertCount || 0)}`
      + ` errs=${Number(status.parseErrorCount || 0)}`,
    );
    if (status.lastMessageAt) {
      lines.push(`${source}_last_message_at: ${formatStatusTimestamp(status.lastMessageAt)}`);
    }
    if (status.lastAlertAt) {
      lines.push(`${source}_last_alert_at: ${formatStatusTimestamp(status.lastAlertAt)}`);
    }
    if (status.lastTopic) {
      lines.push(`${source}_last_topic: ${status.lastTopic}`);
    }
    if (!status.connected && (status.lastConnectionError || status.lastParseError)) {
      lines.push(`${source}_error: ${status.lastConnectionError || status.lastParseError}`);
    }
  }

  if (format === "html") {
    return lines
      .map((line, index) => (index === 0
        ? `<b>${escapeTelegramHtml(line)}</b>`
        : escapeTelegramHtml(line)))
      .join("\n");
  }

  return lines.join("\n");
}

export function formatTelegramError(err) {
  const parts = [];
  const message = String(err?.message || "").trim();
  const causeMessage = String(err?.cause?.message || "").trim();
  const code = String(err?.cause?.code || err?.code || "").trim();

  if (message) {
    parts.push(message);
  }
  if (causeMessage && causeMessage !== message) {
    parts.push(`cause=${causeMessage}`);
  }
  if (code) {
    parts.push(`code=${code}`);
  }

  return parts.join(" | ") || "unknown error";
}

export function isTelegramTransientError(err) {
  const status = Number(err?.status || err?.cause?.status || 0);
  if (TELEGRAM_TRANSIENT_STATUS_CODES.has(status)) {
    return true;
  }

  const code = String(err?.cause?.code || err?.code || "").trim().toUpperCase();
  if (TELEGRAM_TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }

  const name = String(err?.name || "").trim();
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }

  const text = `${err?.message || ""} ${err?.cause?.message || ""}`.toLowerCase();
  return [
    "connect timeout",
    "connection reset",
    "dns",
    "fetch failed",
    "network",
    "socket",
    "timed out",
    "timeout",
  ].some((fragment) => text.includes(fragment));
}

export async function retryTelegramOperation(operation, run, options = {}) {
  const {
    retryDelaysMs = TELEGRAM_RETRY_DELAYS_MS,
    shouldRetry = isTelegramTransientError,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    onRetry = null,
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      const delayMs = retryDelaysMs[attempt];
      if (delayMs == null || !shouldRetry(err)) {
        throw err;
      }
      if (typeof onRetry === "function") {
        onRetry({
          attempt: attempt + 1,
          delayMs,
          error: err,
          operation,
        });
      }
      await sleep(delayMs);
    }
  }

  throw lastError;
}
