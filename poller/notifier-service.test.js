import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getConfiguredMediaBaseNames,
  getMediaAssetMimeType,
  resolveMediaAssetFilename,
} from "./lib.js";
import {
  loadNotifierState,
  loadRecentSent,
  parseNotifierTarget,
  TelegramNotifier,
} from "./notifier-service.js";

const appDir = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(appDir, "assets");
const assetFiles = readdirSync(assetsDir);

describe("notifier asset names", () => {
  it("match the committed asset basenames or fall back to general", () => {
    const baseNames = getConfiguredMediaBaseNames();

    for (const baseName of baseNames) {
      let filename;
      try {
        filename = resolveMediaAssetFilename(baseName, assetFiles);
      } catch {
        filename = resolveMediaAssetFilename("general", assetFiles);
      }
      const filePath = join(assetsDir, filename);
      assert.ok(readFileSync(filePath).length > 0);
      assert.match(getMediaAssetMimeType(filename), /^image\//);
    }
  });
});

describe("parseNotifierTarget", () => {
  it("preserves telegram targets with an explicit prefix", () => {
    assert.deepEqual(parseNotifierTarget("telegram:123456789"), {
      transport: "telegram",
      chatId: "123456789",
      normalized: "telegram:123456789",
    });
  });

  it("normalizes plain WhatsApp targets", () => {
    assert.deepEqual(parseNotifierTarget("972500000000@c.us"), {
      transport: "whatsapp",
      chatId: "972500000000",
      normalized: "972500000000",
    });
  });
});

describe("TelegramNotifier", () => {
  it("sends image alerts to telegram targets and records state", async () => {
    const dirPath = mkdtempSync(join(tmpdir(), "telegram-notifier-"));
    const stateFilePath = join(dirPath, "telegram-state.json");
    const recentSentFilePath = join(dirPath, "recent-sent.json");
    const calls = [];
    const notifier = new TelegramNotifier({
      botToken: "test-token",
      stateFilePath,
      recentSentFilePath,
      callTelegramApi: async (method, payload = null) => {
        calls.push({ method, payload });
        return { message_id: 321 };
      },
    });

    const result = await notifier.send({
      delivery_key: "telegram-key",
      chat_id: "telegram:123456789",
      payload_json: {
        alert: {
          id: "alert-1",
          source: "manual",
          cat: "1",
          title: "ירי רקטות וטילים",
          desc: "",
          data: ["תל אביב - יפו"],
          alertDate: "2026-03-18 18:00:00",
        },
        matched: ["תל אביב - יפו"],
        chatId: "telegram:123456789",
        eventType: "active_alert",
        source: "manual",
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "sendPhoto");
    assert.equal(calls[0].payload.get("chat_id"), "123456789");
    assert.match(String(calls[0].payload.get("caption") || ""), /תל אביב - יפו/);
    assert.match(calls[0].payload.get("photo")?.name, /\.(jpeg|jpg|png)$/);
    assert.equal(result.transport, "telegram");
    assert.equal(result.mode, "image");
    assert.equal(result.chatId, "telegram:123456789");
    assert.equal(result.providerMessageId, 321);

    const recentSent = loadRecentSent(recentSentFilePath);
    assert.equal(recentSent[0].transport, "telegram");
    assert.equal(recentSent[0].chatId, "telegram:123456789");
    assert.equal(recentSent[0].deliveryKey, "telegram-key");
    assert.equal(recentSent[0].alertDate, "2026-03-18 18:00:00");
    assert.equal(recentSent[0].receivedAt, null);
    assert.equal(recentSent[0].deliveryMode, "image");
    assert.match(String(recentSent[0].semanticKey || ""), /^[a-f0-9]{64}$/);

    const state = loadNotifierState(join(dirPath, "whatsapp-state.json"), {
      telegramFilePath: stateFilePath,
    });
    assert.equal(state.telegramLastDeliveredChatId, "123456789");
    assert.equal(state.lastDeliveredTransport, "telegram");
    assert.equal(state.lastDeliveredEventType, "active_alert");
  });

  it("falls back to text when telegram media delivery fails", async () => {
    const dirPath = mkdtempSync(join(tmpdir(), "telegram-notifier-fallback-"));
    const stateFilePath = join(dirPath, "telegram-state.json");
    const recentSentFilePath = join(dirPath, "recent-sent.json");
    const calls = [];
    const notifier = new TelegramNotifier({
      botToken: "test-token",
      stateFilePath,
      recentSentFilePath,
      callTelegramApi: async (method, payload = null) => {
        calls.push({ method, payload });
        if (method === "sendPhoto") {
          const err = new Error("telegram sendPhoto responded 400: bad request");
          err.status = 400;
          throw err;
        }
        return { message_id: 654 };
      },
    });

    const result = await notifier.send({
      delivery_key: "telegram-fallback-key",
      chat_id: "telegram:123456789",
      payload_json: {
        alert: {
          id: "alert-2",
          source: "manual",
          cat: "1",
          title: "ירי רקטות וטילים",
          desc: "",
          data: ["תל אביב - יפו"],
          alertDate: "2026-03-18 18:05:00",
        },
        matched: ["תל אביב - יפו"],
        chatId: "telegram:123456789",
        eventType: "active_alert",
        source: "manual",
      },
    });

    assert.deepEqual(calls.map((call) => call.method), ["sendPhoto", "sendMessage"]);
    assert.equal(calls[1].payload.chat_id, "123456789");
    assert.match(String(calls[1].payload.text || ""), /תל אביב - יפו/);
    assert.equal(result.mode, "text");
    assert.equal(result.providerMessageId, 654);

    const recentSent = loadRecentSent(recentSentFilePath);
    assert.equal(recentSent[0].deliveryMode, "text");
  });
});
