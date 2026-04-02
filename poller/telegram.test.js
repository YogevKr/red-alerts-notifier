import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTelegramConfirmationMarkup,
  buildTelegramConfirmationPrompt,
  buildTelegramSimulationMessage,
  formatTelegramError,
  buildTelegramStatusFocus,
  buildTelegramStatusMessage,
  resolveTelegramStatusReply,
  isTelegramTransientError,
  normalizeTelegramCommand,
  parseTelegramCallbackAction,
  parseTelegramAllowedUserIds,
  retryTelegramOperation,
  TELEGRAM_CALLBACK_ACTIONS,
  TELEGRAM_COMMANDS,
} from "./telegram.js";

describe("parseTelegramAllowedUserIds", () => {
  it("parses unique user ids", () => {
    assert.deepEqual(
      parseTelegramAllowedUserIds("123, 456,123"),
      ["123", "456"],
    );
  });
});

describe("normalizeTelegramCommand", () => {
  it("strips bot suffix", () => {
    assert.equal(normalizeTelegramCommand("/mute@red_alerts_bot"), "/mute");
  });

  it("normalizes the recent_recieve typo alias", () => {
    assert.equal(normalizeTelegramCommand("/recent_recieve"), "/recent_received");
  });
});

describe("telegram command metadata", () => {
  it("exposes slash commands for menu sync", () => {
    assert.deepEqual(
      TELEGRAM_COMMANDS.map((command) => command.command),
      ["status", "recent_received", "recent_received_town", "recent_flow", "recent_sent", "recent_miss", "simulate", "send", "mute", "unmute"],
    );
  });
});

describe("buildTelegramSimulationMessage", () => {
  it("renders a compact simulate summary", () => {
    assert.equal(
      buildTelegramSimulationMessage({
        targetMode: "test",
        received: 1,
        summary: {
          matchedAlerts: 1,
          sentTargets: 1,
          skippedTargets: 0,
          duplicateTargets: 0,
          unmatchedAlerts: 0,
        },
        alerts: [
          {
            matchedLocations: ["חיפה"],
            targets: [
              { chatId: "972500000000" },
            ],
          },
        ],
      }),
      [
        "simulate: ok target_mode=test",
        "targets: 972500000000",
        "matched_locations: חיפה",
        "summary: received=1 matched=1 sent=1 skipped=0 dup=0 unmatched=0",
      ].join("\n"),
    );
  });
});

describe("buildTelegramConfirmationMarkup", () => {
  it("builds a mute confirmation keyboard", () => {
    assert.deepEqual(buildTelegramConfirmationMarkup(TELEGRAM_CALLBACK_ACTIONS.CONFIRM_MUTE), {
      inline_keyboard: [[
        {
          text: "Confirm mute",
          callback_data: "confirm_mute",
          style: "danger",
        },
        {
          text: "Cancel",
          callback_data: "cancel",
        },
      ]],
    });
  });
});

describe("parseTelegramCallbackAction", () => {
  it("accepts known callback data only", () => {
    assert.equal(parseTelegramCallbackAction("confirm_unmute"), "confirm_unmute");
    assert.equal(parseTelegramCallbackAction("other"), "");
  });
});

describe("buildTelegramConfirmationPrompt", () => {
  it("renders action prompts", () => {
    assert.equal(
      buildTelegramConfirmationPrompt(TELEGRAM_CALLBACK_ACTIONS.CONFIRM_MUTE),
      "Mute WhatsApp delivery?\nPolling and debug capture will keep running.",
    );
    assert.equal(
      buildTelegramConfirmationPrompt(TELEGRAM_CALLBACK_ACTIONS.CANCEL),
      "Action cancelled.",
    );
  });
});

describe("buildTelegramStatusMessage", () => {
  it("renders compact bot status", () => {
    assert.equal(
      buildTelegramStatusMessage({
        deliveryEnabled: false,
        activeSources: ["oref_alerts", "oref_history", "tzevaadom"],
        transports: ["telegram", "whatsapp"],
        destinations: {
          total: 2,
          labels: ["telegram:1", "972500000000"],
        },
        sender: {
          label: "red-alerts",
        },
        whatsapp: {
          enabled: true,
          primaryState: "close",
          fallbackState: "open",
        },
        telegram: {
          enabled: true,
          lastCheckedAt: "2026-03-24T12:00:10.400Z",
          lastError: null,
          lastDeliveredChatId: "1",
        },
        activeInstance: "red-alerts",
        primaryState: "close",
        fallbackState: "open",
        lastDeliveredAt: "2026-03-12T15:00:00.000Z",
        lastDeliveredEventType: "all_clear",
        lastDeliveredSource: "oref_history",
        latestFlow: {
          summary: "tzevaadom:enqueued (+0ms) -> telegram:sent (+180ms) -> oref_alerts:same_event (+4.0s)",
        },
        targets: ["a", "b"],
        poll: {
          lastPollAt: "2026-03-24T12:00:10.000Z",
          lastPollSuccessAt: "2026-03-24T12:00:09.000Z",
          lastPollErrorAt: null,
          lastPollError: null,
          consecutivePollErrors: 0,
        },
        database: {
          enabled: true,
          lastCheckedAt: "2026-03-24T12:00:10.500Z",
          lastError: null,
          latencyMs: 3,
        },
        outbox: {
          pending: 1,
          processing: 2,
          failed: 0,
          uncertain: 0,
          deadLettered: 1,
          latency: {
            endToEndMs: { count: 4, p50: 280, p95: 950 },
            queueMs: { p50: 18, p95: 60 },
            sendMs: { p50: 170, p95: 520 },
            sourceToEnqueueMs: { count: 4, p50: 22, p95: 240 },
          },
        },
        sourceFailures: {
          oref_alerts: {
            consecutiveFailures: 0,
            lastSuccessAt: "2026-03-24T12:00:09.000Z",
            lastFailureAt: null,
            lastError: null,
          },
          oref_history: {
            consecutiveFailures: 2,
            lastSuccessAt: "2026-03-24T11:59:55.000Z",
            lastFailureAt: "2026-03-24T12:00:08.000Z",
            lastError: "timeout",
          },
        },
        realtimeSources: {
          tzevaadom: {
            enabled: true,
            connected: true,
            receivedCount: 11,
            alertCount: 4,
            parseErrorCount: 0,
            lastMessageAt: "2026-03-23T11:48:03.890Z",
            lastAlertAt: "2026-03-23T11:48:03.891Z",
          },
        },
      }),
      [
        "focus: delivery muted",
        "active_sources: oref_alerts, oref_history, tzevaadom",
        "delivery: off",
        "sender: red-alerts",
        "transports: telegram, whatsapp",
        "destinations: telegram:1, 972500000000",
        "primary: close",
        "fallback: open",
        "telegram: ok checked_at=2026-03-24 14:00:10",
        "telegram_last_chat: telegram:1",
        "poll: ok errs=0 last_ok=2026-03-24 14:00:09",
        "db: ok latency_ms=3 checked_at=2026-03-24 14:00:10",
        "last_delivered_at: 2026-03-12 17:00:00",
        "last_delivered_type: all_clear",
        "last_delivered_source: oref_history",
        "outbox: pending=1 processing=2 failed=0 uncertain=0 dead=1",
        "latency_ms: e2e p50=280 p95=950 queue p50=18 p95=60 send p50=170 p95=520 n=4",
        "latency_src_enqueue_ms: p50=22 p95=240",
        "oref_alerts: ok fails=0 last_ok=2026-03-24 14:00:09",
        "oref_history: fail fails=2 last_ok=2026-03-24 13:59:55",
        "oref_history_error: timeout",
        "tzevaadom: connected recv=11 alerts=4 errs=0",
        "tzevaadom_last_message_at: 2026-03-23 13:48:03",
        "tzevaadom_last_alert_at: 2026-03-23 13:48:03",
      ].join("\n"),
    );
  });

  it("renders telegram-only status without fake whatsapp fields", () => {
    assert.equal(
      buildTelegramStatusMessage({
        deliveryEnabled: true,
        activeSources: ["oref_alerts", "oref_history", "tzevaadom"],
        transports: ["telegram"],
        destinations: {
          total: 1,
          labels: ["telegram:123456789"],
        },
        sender: {
          label: "telegram-bot",
        },
        telegram: {
          enabled: true,
          lastCheckedAt: "2026-03-24T12:00:10.400Z",
          lastError: null,
          lastDeliveredChatId: "123456789",
        },
        targets: ["telegram:123456789"],
      }),
      [
        "focus: healthy",
        "active_sources: oref_alerts, oref_history, tzevaadom",
        "delivery: on",
        "sender: telegram-bot",
        "transports: telegram",
        "destination: telegram:123456789",
        "telegram: ok checked_at=2026-03-24 14:00:10",
        "telegram_last_chat: telegram:123456789",
      ].join("\n"),
    );
  });

  it("renders the focus line in bold for html telegram output", () => {
    assert.equal(
      buildTelegramStatusMessage({
        deliveryEnabled: false,
        activeSources: ["oref_alerts"],
        format: "html",
      }),
      [
        "<b>focus: delivery muted</b>",
        "active_sources: oref_alerts",
        "delivery: off",
        "sender: unknown",
        "targets: 0",
      ].join("\n"),
    );
  });
});

describe("resolveTelegramStatusReply", () => {
  it("prefers structured status over preformatted endpoint text", () => {
    assert.equal(
      resolveTelegramStatusReply({
        telegramMessage: "bad passthrough",
        message: "bad plain passthrough",
        status: {
          deliveryEnabled: true,
          activeSources: ["oref_alerts"],
          transports: ["telegram"],
          destinations: {
            total: 1,
            labels: ["telegram:123456789"],
          },
          sender: {
            label: "telegram-bot",
          },
        },
      }),
      [
        "<b>focus: healthy</b>",
        "active_sources: oref_alerts",
        "delivery: on",
        "sender: telegram-bot",
        "transports: telegram",
        "destination: telegram:123456789",
        "telegram: ok checked_at=never",
      ].join("\n"),
    );
  });
});

describe("buildTelegramStatusFocus", () => {
  it("prioritizes the most actionable operator issue", () => {
    assert.equal(
      buildTelegramStatusFocus({
        deliveryEnabled: true,
        outbox: {
          pending: 0,
          processing: 0,
          failed: 0,
          uncertain: 2,
          deadLettered: 4,
        },
        sourceFailures: {
          oref_alerts: {
            consecutiveFailures: 3,
          },
        },
      }),
      "focus: uncertain deliveries=2",
    );
  });

  it("surfaces realtime disconnects ahead of generic source failures", () => {
    assert.equal(
      buildTelegramStatusFocus({
        deliveryEnabled: true,
        realtimeSources: {
          tzevaadom: {
            enabled: true,
            connected: false,
          },
        },
        sourceFailures: {
          tzevaadom: {
            consecutiveFailures: 2,
          },
        },
      }),
      "focus: tzevaadom disconnected",
    );
  });
});

describe("formatTelegramError", () => {
  it("includes cause details when present", () => {
    const err = new Error("fetch failed", {
      cause: { message: "socket hang up", code: "ECONNRESET" },
    });

    assert.equal(
      formatTelegramError(err),
      "fetch failed | cause=socket hang up | code=ECONNRESET",
    );
  });
});

describe("isTelegramTransientError", () => {
  it("accepts transport failures", () => {
    const err = new Error("fetch failed", {
      cause: { message: "socket hang up", code: "ECONNRESET" },
    });

    assert.equal(isTelegramTransientError(err), true);
  });

  it("rejects permanent api failures", () => {
    const err = new Error("bot was blocked by the user");
    err.status = 403;

    assert.equal(isTelegramTransientError(err), false);
  });
});

describe("retryTelegramOperation", () => {
  it("retries transient failures", async () => {
    let attempts = 0;
    const err = new Error("fetch failed", {
      cause: { message: "connect timeout", code: "ETIMEDOUT" },
    });

    const result = await retryTelegramOperation("sendMessage", async () => {
      attempts += 1;
      if (attempts === 1) throw err;
      return "ok";
    }, { retryDelaysMs: [0], sleep: async () => {} });

    assert.equal(result, "ok");
    assert.equal(attempts, 2);
  });

  it("stops on permanent failures", async () => {
    let attempts = 0;
    const err = new Error("bot was blocked by the user");
    err.status = 403;

    await assert.rejects(() => retryTelegramOperation("sendMessage", async () => {
      attempts += 1;
      throw err;
    }, { retryDelaysMs: [0], sleep: async () => {} }), /blocked/);
    assert.equal(attempts, 1);
  });
});
