import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, createRepeatedEventLogger } from "./log.js";
import {
  buildTelegramStatusMessage,
  buildTelegramConfirmationMarkup,
  buildTelegramConfirmationPrompt,
  buildTelegramSimulationMessage,
  formatTelegramError,
  isTelegramTransientError,
  normalizeTelegramCommand,
  parseTelegramAllowedUserIds,
  parseTelegramCallbackAction,
  retryTelegramOperation,
  TELEGRAM_CALLBACK_ACTIONS,
  TELEGRAM_COMMANDS,
} from "./telegram.js";
import { EVENT_TYPES, resolveEventType } from "./lib.js";
import { parsePositiveIntEnv } from "./pagerduty.js";
import { getPresetAlertLabel, PRESET_ALERTS } from "./preset-alerts.js";

const {
  TELEGRAM_BOT_TOKEN = "",
  TELEGRAM_ALLOWED_USER_IDS = "",
  TELEGRAM_POLL_TIMEOUT_SECONDS = "50",
  TELEGRAM_POLL_RETRY_MS = "5000",
  POLLER_INTERNAL_URL = "http://poller:3000",
} = process.env;

const telegramAllowedUserIds = parseTelegramAllowedUserIds(TELEGRAM_ALLOWED_USER_IDS);
const telegramPollTimeoutSeconds = parsePositiveIntEnv(TELEGRAM_POLL_TIMEOUT_SECONDS, 50);
const telegramPollRetryMs = parsePositiveIntEnv(TELEGRAM_POLL_RETRY_MS, 5000);
const telegramEnabled =
  TELEGRAM_BOT_TOKEN.trim().length > 0 && telegramAllowedUserIds.length > 0;
const appDir = dirname(fileURLToPath(import.meta.url));
const runtimeStatePath = join(appDir, "data", "runtime-state.json");
const runtimeState = loadRuntimeState();
const logger = createLogger("telegram-bot");
const repeatedEventLogger = createRepeatedEventLogger(logger, {
  intervalMs: telegramPollRetryMs * 6,
});
const monitor = {
  enabled: telegramEnabled,
  lastPollAt: null,
  lastPollSuccessAt: null,
  lastUpdateAt: null,
  lastCommandAt: null,
  lastCommand: null,
  lastError: null,
};

const telegramSendPresetByType = new Map(
  PRESET_ALERTS.map((preset) => [preset.eventType, preset]),
);

function toIsoString(timestampMs = Date.now()) {
  return new Date(timestampMs).toISOString();
}

function loadRuntimeState() {
  const defaults = { telegramUpdateOffset: 0 };

  try {
    const parsed = JSON.parse(readFileSync(runtimeStatePath, "utf8"));
    return {
      ...defaults,
      ...(parsed && typeof parsed === "object" ? parsed : {}),
    };
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logger.warn("telegram_runtime_state_load_failed", {
        runtime_state_path: runtimeStatePath,
        error: err,
      });
    }
    return defaults;
  }
}

function persistRuntimeState() {
  mkdirSync(dirname(runtimeStatePath), { recursive: true });
  writeFileSync(runtimeStatePath, JSON.stringify(runtimeState, null, 2), "utf8");
}

async function fetchTelegram(method, payload = null) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: payload ? "POST" : "GET",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout((telegramPollTimeoutSeconds + 10) * 1000),
    },
  );
  if (!res.ok) {
    const err = new Error(`telegram ${method} responded ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const body = await res.json();
  if (!body?.ok) {
    const err = new Error(body?.description || `telegram ${method} failed`);
    err.status = body?.error_code;
    throw err;
  }
  return body.result;
}

async function sendTelegramMessage(chatId, text, options = {}) {
  return fetchTelegram("sendMessage", {
    chat_id: chatId,
    text,
    ...options,
  });
}

async function sendTelegramMessageWithMarkup(chatId, text, replyMarkup, options = {}) {
  return fetchTelegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
    ...options,
  });
}

function logTelegramRetry(method, context, detail) {
  const error = formatTelegramError(detail.error);
  repeatedEventLogger.record(
    "telegram_retry",
    `${method}:${context}`,
    `${error}:${detail.delayMs}`,
    {
      method,
      context,
      attempt: detail.attempt,
      delay_ms: detail.delayMs,
      error,
    },
    "warn",
  );
}

async function runTelegramSafely(method, run, context, options = {}) {
  const { retryTransient = false } = options;

  try {
    if (retryTransient) {
      return await retryTelegramOperation(method, run, {
        shouldRetry: isTelegramTransientError,
        onRetry: (detail) => logTelegramRetry(method, context, detail),
      });
    }
    return await run();
  } catch (err) {
    const detail = formatTelegramError(err);
    monitor.lastError = `${method}: ${detail}`;
    repeatedEventLogger.record(
      "telegram_operation_failed",
      `${method}:${context}`,
      detail,
      {
        method,
        context,
        error: detail,
      },
      "warn",
    );
    return null;
  }
}

async function sendTelegramMessageSafely(chatId, text, options = {}) {
  return runTelegramSafely(
    "sendMessage",
    () => sendTelegramMessage(chatId, text, options),
    `chatId=${chatId}`,
    { retryTransient: true },
  );
}

async function sendTelegramMessageWithMarkupSafely(chatId, text, replyMarkup, options = {}) {
  return runTelegramSafely(
    "sendMessage",
    () => sendTelegramMessageWithMarkup(chatId, text, replyMarkup, options),
    `chatId=${chatId}`,
    { retryTransient: true },
  );
}

async function answerTelegramCallbackQuery(callbackQueryId, text = "") {
  return fetchTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

async function answerTelegramCallbackQuerySafely(callbackQueryId, text = "") {
  return runTelegramSafely(
    "answerCallbackQuery",
    () => answerTelegramCallbackQuery(callbackQueryId, text),
    `callbackQueryId=${callbackQueryId}`,
    { retryTransient: true },
  );
}

async function clearTelegramInlineMarkup(chatId, messageId) {
  return fetchTelegram("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

async function clearTelegramInlineMarkupSafely(chatId, messageId) {
  return runTelegramSafely(
    "editMessageReplyMarkup",
    () => clearTelegramInlineMarkup(chatId, messageId),
    `chatId=${chatId} messageId=${messageId}`,
    { retryTransient: true },
  );
}

async function syncTelegramCommands() {
  await fetchTelegram("setMyCommands", {
    commands: TELEGRAM_COMMANDS,
  });
  await fetchTelegram("setChatMenuButton", {
    menu_button: { type: "commands" },
  });
}

async function syncTelegramCommandsSafely() {
  return runTelegramSafely(
    "commandSync",
    () => syncTelegramCommands(),
    "startup",
    { retryTransient: true },
  );
}

function buildTelegramSendPresetMarkup() {
  return {
    inline_keyboard: [
      ...PRESET_ALERTS.map((preset) => [
        {
          text: preset.label,
          callback_data: `send:preset:${preset.eventType}`,
        },
      ]),
      [
        {
          text: "Cancel",
          callback_data: TELEGRAM_CALLBACK_ACTIONS.CANCEL,
        },
      ],
    ],
  };
}

function buildTelegramSendConfirmMarkup(eventType) {
  return {
    inline_keyboard: [
      [
        {
          text: "Confirm send",
          callback_data: `send:confirm:${eventType}`,
        },
        {
          text: "Cancel",
          callback_data: TELEGRAM_CALLBACK_ACTIONS.CANCEL,
        },
      ],
    ],
  };
}

function parseTelegramSendAction(data = "") {
  const parts = String(data).trim().split(":");
  if (parts[0] !== "send") return null;
  const stage = parts[1] || "";
  const eventType = resolveEventType(parts[2] || "");
  if (!stage || eventType === EVENT_TYPES.UNKNOWN) return null;
  return { stage, eventType };
}

function buildTelegramSendPrompt(stage, eventType, targetLabel = "") {
  const label = getPresetAlertLabel(eventType);
  if (stage === "preset") {
    return "Choose alert variant:";
  }
  if (stage === "confirm") {
    return `Send ${label} to ${targetLabel}?`;
  }
  return "Action cancelled.";
}

function buildOpsTargetLabel(targets = []) {
  if (!Array.isArray(targets) || targets.length === 0) return "";
  return targets.length === 1 ? "default target" : `default targets (${targets.length})`;
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

async function reportTelegramManagementState() {
  try {
    await fetchPoller("/ops/telegram_management", {
      method: "POST",
      body: JSON.stringify({
        enabled: monitor.enabled,
        lastPollAt: monitor.lastPollAt,
        lastPollSuccessAt: monitor.lastPollSuccessAt,
        lastUpdateAt: monitor.lastUpdateAt,
        lastCommandAt: monitor.lastCommandAt,
        lastCommand: monitor.lastCommand,
        lastError: monitor.lastError,
      }),
    });
  } catch (err) {
    repeatedEventLogger.record(
      "telegram_management_state_report_failed",
      "poller",
      formatTelegramError(err),
      {
        error: err,
        poller_internal_url: POLLER_INTERNAL_URL,
      },
      "warn",
    );
  }
}

async function handleTelegramCallbackQuery(callbackQuery = {}) {
  const callbackId = callbackQuery?.id;
  const callbackData = String(callbackQuery?.data || "");
  const sendAction = parseTelegramSendAction(callbackData);
  const action = parseTelegramCallbackAction(callbackData);
  const userId = String(callbackQuery?.from?.id || "");
  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;

  if (!callbackId) return;
  monitor.lastUpdateAt = toIsoString();

  if (!telegramAllowedUserIds.includes(userId)) {
    await answerTelegramCallbackQuerySafely(callbackId, "Not allowed");
    return;
  }

  monitor.lastCommandAt = toIsoString();
  monitor.lastCommand =
    sendAction?.stage && sendAction.eventType
      ? `send:${sendAction.stage}:${sendAction.eventType}`
      : action || "callback_unknown";

  if (chatId && Number.isFinite(messageId)) {
    await clearTelegramInlineMarkupSafely(chatId, messageId);
  }

  if (sendAction) {
    const preset = telegramSendPresetByType.get(sendAction.eventType);
    if (!preset) {
      await answerTelegramCallbackQuerySafely(callbackId, "unknown preset");
      return;
    }

    if (sendAction.stage === "preset") {
      await answerTelegramCallbackQuerySafely(callbackId, preset.label);
      try {
        const status = await fetchPoller("/ops/status");
        const targetLabel = buildOpsTargetLabel(status?.status?.targets);
        if (!targetLabel) {
          throw new Error("no default targets configured");
        }
        if (chatId) {
          await sendTelegramMessageWithMarkupSafely(
            chatId,
            buildTelegramSendPrompt("confirm", sendAction.eventType, targetLabel),
            buildTelegramSendConfirmMarkup(sendAction.eventType),
            messageId ? { reply_parameters: { message_id: messageId } } : undefined,
          );
        }
      } catch (err) {
        if (chatId) {
          await sendTelegramMessageSafely(chatId, `Send failed: ${err.message}`);
        }
      }
      return;
    }

    if (sendAction.stage !== "confirm") {
      await answerTelegramCallbackQuerySafely(callbackId, "stale action");
      if (chatId) {
        await sendTelegramMessageSafely(chatId, "This action is stale. Run /send again.");
      }
      return;
    }

    try {
      const result = await fetchPoller("/ops/send_preset", {
        method: "POST",
        body: JSON.stringify({
          eventType: sendAction.eventType,
          updatedBy: `telegram:${userId}`,
        }),
      });
      await answerTelegramCallbackQuerySafely(callbackId, "sent");
      if (chatId) {
        await sendTelegramMessageSafely(chatId, result.message || `Sent ${preset.label}.`);
      }
    } catch (err) {
      await answerTelegramCallbackQuerySafely(callbackId, "send failed");
      if (chatId) {
        await sendTelegramMessageSafely(chatId, `Send failed: ${err.message}`);
      }
    }
    return;
  }

  if (action === TELEGRAM_CALLBACK_ACTIONS.CONFIRM_MUTE) {
    try {
      const result = await fetchPoller("/ops/delivery", {
        method: "POST",
        body: JSON.stringify({
          enabled: false,
          updatedBy: `telegram:${userId}`,
        }),
      });
      await answerTelegramCallbackQuerySafely(callbackId, "delivery muted");
      if (chatId) {
        await sendTelegramMessageSafely(chatId, result.message || "delivery muted");
      }
    } catch (err) {
      await answerTelegramCallbackQuerySafely(callbackId, "mute failed");
      if (chatId) {
        await sendTelegramMessageSafely(chatId, `Mute failed: ${err.message}`);
      }
    }
    return;
  }

  if (action === TELEGRAM_CALLBACK_ACTIONS.CONFIRM_UNMUTE) {
    try {
      const result = await fetchPoller("/ops/delivery", {
        method: "POST",
        body: JSON.stringify({
          enabled: true,
          updatedBy: `telegram:${userId}`,
        }),
      });
      await answerTelegramCallbackQuerySafely(callbackId, "delivery unmuted");
      if (chatId) {
        await sendTelegramMessageSafely(chatId, result.message || "delivery unmuted");
      }
    } catch (err) {
      await answerTelegramCallbackQuerySafely(callbackId, "unmute failed");
      if (chatId) {
        await sendTelegramMessageSafely(chatId, `Unmute failed: ${err.message}`);
      }
    }
    return;
  }

  await answerTelegramCallbackQuerySafely(callbackId, "cancelled");
  if (chatId) {
    await sendTelegramMessageSafely(
      chatId,
      buildTelegramConfirmationPrompt(TELEGRAM_CALLBACK_ACTIONS.CANCEL),
    );
  }
}

async function handleTelegramUpdate(update = {}) {
  if (update?.callback_query) {
    await handleTelegramCallbackQuery(update.callback_query);
    return;
  }

  const message = update?.message || update?.edited_message;
  const userId = String(message?.from?.id || "");
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const text = String(message?.text || "").trim();
  if (!chatId || !text) return;

  monitor.lastUpdateAt = toIsoString();

  if (!telegramAllowedUserIds.includes(userId)) {
    return;
  }

  const command = normalizeTelegramCommand(text);
  monitor.lastCommandAt = toIsoString();
  monitor.lastCommand = command;

  if (command === "/mute") {
    await sendTelegramMessageWithMarkupSafely(
      chatId,
      buildTelegramConfirmationPrompt(TELEGRAM_CALLBACK_ACTIONS.CONFIRM_MUTE),
      buildTelegramConfirmationMarkup(TELEGRAM_CALLBACK_ACTIONS.CONFIRM_MUTE),
      messageId ? { reply_parameters: { message_id: messageId } } : undefined,
    );
    return;
  }

  if (command === "/unmute") {
    await sendTelegramMessageWithMarkupSafely(
      chatId,
      buildTelegramConfirmationPrompt(TELEGRAM_CALLBACK_ACTIONS.CONFIRM_UNMUTE),
      buildTelegramConfirmationMarkup(TELEGRAM_CALLBACK_ACTIONS.CONFIRM_UNMUTE),
      messageId ? { reply_parameters: { message_id: messageId } } : undefined,
    );
    return;
  }

  if (command === "/status" || command === "/start" || command === "/help") {
    const result = await fetchPoller("/ops/status");
    const statusMessage = result.telegramMessage
      || (result.status ? buildTelegramStatusMessage({ ...result.status, format: "html" }) : null)
      || result.message
      || "status unavailable";
    await sendTelegramMessageSafely(
      chatId,
      statusMessage,
      {
        ...(messageId ? { reply_parameters: { message_id: messageId } } : {}),
        parse_mode: "HTML",
      },
    );
    return;
  }

  if (command === "/recent_received") {
    const result = await fetchPoller("/ops/recent_received");
    await sendTelegramMessageSafely(
      chatId,
      result.message || "recent_received: none",
      messageId ? { reply_parameters: { message_id: messageId } } : undefined,
    );
    return;
  }

  if (command === "/recent_received_town") {
    const result = await fetchPoller("/ops/recent_received_town");
    await sendTelegramMessageSafely(
      chatId,
      result.message || "recent_received_town: none",
      messageId ? { reply_parameters: { message_id: messageId } } : undefined,
    );
    return;
  }

  if (command === "/recent_flow") {
    const result = await fetchPoller("/ops/recent_flow");
    await sendTelegramMessageSafely(
      chatId,
      result.message || "recent_flow: none",
      messageId ? { reply_parameters: { message_id: messageId } } : undefined,
    );
    return;
  }

  if (command === "/recent_sent") {
    const result = await fetchPoller("/ops/recent_sent");
    await sendTelegramMessageSafely(
      chatId,
      result.message || "recent_sent: none",
      messageId ? { reply_parameters: { message_id: messageId } } : undefined,
    );
    return;
  }

  if (command === "/simulate") {
    const result = await fetchPoller("/simulate", {
      method: "POST",
      body: JSON.stringify({
        useTestTarget: true,
        source: "telegram_simulate",
        title: "SIMULATED ALERT",
        desc: "Telegram-triggered simulation",
      }),
    });
    await sendTelegramMessageSafely(
      chatId,
      buildTelegramSimulationMessage(result),
      messageId ? { reply_parameters: { message_id: messageId } } : undefined,
    );
    return;
  }

  if (command === "/send") {
    await sendTelegramMessageWithMarkupSafely(
      chatId,
      buildTelegramSendPrompt("preset"),
      buildTelegramSendPresetMarkup(),
      messageId ? { reply_parameters: { message_id: messageId } } : undefined,
    );
  }
}

function scheduleTelegramPoll(delayMs = 0) {
  setTimeout(() => {
    void pollTelegram();
  }, delayMs);
}

async function pollTelegram() {
  if (!telegramEnabled) return;

  monitor.lastPollAt = toIsoString();
  let shouldRetryWithDelay = false;
  try {
    const updates = await fetchTelegram("getUpdates", {
      offset: runtimeState.telegramUpdateOffset,
      timeout: telegramPollTimeoutSeconds,
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
    monitor.lastPollSuccessAt = toIsoString();
    let hadUpdateError = false;

    for (const update of updates) {
      runtimeState.telegramUpdateOffset = Math.max(
        Number(runtimeState.telegramUpdateOffset) || 0,
        Number(update?.update_id || 0) + 1,
      );
      persistRuntimeState();
      try {
        await handleTelegramUpdate(update);
      } catch (err) {
        hadUpdateError = true;
        monitor.lastError = err.message;
        repeatedEventLogger.record(
          "telegram_update_handling_failed",
          "update",
          err.message,
          {
            error: err,
          },
          "warn",
        );
      }
    }
    if (!hadUpdateError) {
      monitor.lastError = null;
    }
  } catch (err) {
    shouldRetryWithDelay = true;
    monitor.lastError = err.message;
    repeatedEventLogger.record(
      "telegram_poll_failed",
      "poll",
      err.message,
      {
        error: err,
        retry_ms: telegramPollRetryMs,
      },
      "warn",
    );
  } finally {
    void reportTelegramManagementState();
    scheduleTelegramPoll(shouldRetryWithDelay ? telegramPollRetryMs : 0);
  }
}

async function init() {
  if (!telegramEnabled) {
    logger.info("telegram_bot_disabled");
    return;
  }

  logger.info("telegram_bot_enabled", {
    allowed_user_count: telegramAllowedUserIds.length,
    poller_internal_url: POLLER_INTERNAL_URL,
  });
  await syncTelegramCommandsSafely();
  void reportTelegramManagementState();
  scheduleTelegramPoll();
}

init();
