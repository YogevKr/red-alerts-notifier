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
  WhatsAppNotifier,
} from "./notifier-service.js";

const appDir = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(appDir, "assets");
const assetFiles = readdirSync(assetsDir);

describe("notifier asset names", () => {
  it("match the committed asset basenames", () => {
    const baseNames = getConfiguredMediaBaseNames();

    for (const baseName of baseNames) {
      const filename = resolveMediaAssetFilename(baseName, assetFiles);
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
    assert.equal(calls[0].payload.get("photo")?.name, "active-alert.jpeg");
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

describe("WhatsAppNotifier", () => {
  it("routes configured targets through WAHA", async () => {
    const dirPath = mkdtempSync(join(tmpdir(), "waha-route-"));
    const stateFilePath = join(dirPath, "whatsapp-state.json");
    const recentSentFilePath = join(dirPath, "recent-sent.json");
    const dedupeFilePath = join(dirPath, "dedupe.json");
    const notifier = new WhatsAppNotifier({
      evolutionUrl: "http://evolution-api:8080",
      evolutionApiKey: "evolution-key",
      evolutionInstance: "Hamal",
      wahaUrl: "http://waha:3000",
      wahaApiKey: "waha-key",
      wahaSession: "YogevWaha",
      wahaTargets: ["group-secondary@g.us"],
      stateFilePath,
      recentSentFilePath,
      dedupeFilePath,
    });
    notifier.resolveActiveEvolutionInstance = async () => {
      assert.fail("resolveActiveEvolutionInstance should not be called for WAHA-routed targets");
    };
    notifier.resolveWahaSession = async () => ({
      name: "YogevWaha",
      status: "WORKING",
    });
    notifier.sendWahaImageMessage = async ({ chatId, sessionName }) => {
      assert.equal(chatId, "group-secondary@g.us");
      assert.equal(sessionName, "YogevWaha");
      return {
        mode: "text",
        providerMessageId: "waha-msg-1",
      };
    };

    const result = await notifier.send({
      delivery_key: "waha-key-1",
      chat_id: "group-secondary@g.us",
      payload_json: {
        alert: {
          id: "alert-1",
          source: "manual",
          cat: "1",
          title: "ירי רקטות וטילים",
          desc: "",
          data: ["חיפה"],
          alertDate: "2026-03-26 21:11:00",
        },
        matched: ["חיפה"],
        chatId: "group-secondary@g.us",
        eventType: "active_alert",
        source: "manual",
      },
    });

    assert.equal(result.provider, "waha");
    assert.equal(result.instanceName, "YogevWaha");
    assert.equal(result.mode, "text");

    const recentSent = loadRecentSent(recentSentFilePath);
    assert.equal(recentSent[0].provider, "waha");
    assert.equal(recentSent[0].instanceName, "YogevWaha");

    const state = loadNotifierState(stateFilePath, {
      includeTelegram: false,
    });
    assert.equal(state.whatsappWahaSession, "YogevWaha");
    assert.equal(state.whatsappWahaState, "WORKING");
  });

  it("keeps non-WAHA targets on Evolution", async () => {
    const dirPath = mkdtempSync(join(tmpdir(), "evolution-route-"));
    const stateFilePath = join(dirPath, "whatsapp-state.json");
    const recentSentFilePath = join(dirPath, "recent-sent.json");
    const dedupeFilePath = join(dirPath, "dedupe.json");
    const notifier = new WhatsAppNotifier({
      evolutionUrl: "http://evolution-api:8080",
      evolutionApiKey: "evolution-key",
      evolutionInstance: "Hamal",
      wahaUrl: "http://waha:3000",
      wahaApiKey: "waha-key",
      wahaSession: "YogevWaha",
      wahaTargets: ["group-secondary@g.us"],
      stateFilePath,
      recentSentFilePath,
      dedupeFilePath,
    });
    notifier.resolveActiveEvolutionInstance = async () => ({
      instanceName: "Hamal",
      connectionState: "open",
      usedFallback: false,
      primary: {
        instanceName: "Hamal",
        connectionState: "open",
      },
      fallback: {
        instanceName: null,
        connectionState: null,
      },
    });
    notifier.sendImageMessage = async ({ chatId, instanceName }) => {
      assert.equal(chatId, "group-primary@g.us");
      assert.equal(instanceName, "Hamal");
      return {
        mode: "image",
        providerMessageId: "evolution-msg-1",
      };
    };
    notifier.resolveWahaSession = async () => {
      assert.fail("resolveWahaSession should not be called for Evolution targets");
    };

    const result = await notifier.send({
      delivery_key: "evolution-key-1",
      chat_id: "group-primary@g.us",
      payload_json: {
        alert: {
          id: "alert-2",
          source: "manual",
          cat: "1",
          title: "ירי רקטות וטילים",
          desc: "",
          data: ["חיפה"],
          alertDate: "2026-03-26 21:11:00",
        },
        matched: ["חיפה"],
        chatId: "group-primary@g.us",
        eventType: "active_alert",
        source: "manual",
      },
    });

    assert.equal(result.provider, "evolution");
    assert.equal(result.instanceName, "Hamal");
  });

  it("mirrors configured targets through WAHA after Evolution succeeds", async () => {
    const dirPath = mkdtempSync(join(tmpdir(), "waha-mirror-"));
    const stateFilePath = join(dirPath, "whatsapp-state.json");
    const recentSentFilePath = join(dirPath, "recent-sent.json");
    const dedupeFilePath = join(dirPath, "dedupe.json");
    const calls = [];
    const notifier = new WhatsAppNotifier({
      evolutionUrl: "http://evolution-api:8080",
      evolutionApiKey: "evolution-key",
      evolutionInstance: "Hamal",
      wahaUrl: "http://waha:3000",
      wahaApiKey: "waha-key",
      wahaSession: "default",
      wahaMirrorTargets: ["group-secondary@g.us"],
      stateFilePath,
      recentSentFilePath,
      dedupeFilePath,
    });
    notifier.resolveActiveEvolutionInstance = async () => ({
      instanceName: "Hamal",
      connectionState: "open",
      usedFallback: false,
      primary: {
        instanceName: "Hamal",
        connectionState: "open",
      },
      fallback: {
        instanceName: null,
        connectionState: null,
      },
    });
    notifier.sendImageMessage = async ({ chatId, instanceName }) => {
      calls.push({ provider: "evolution", chatId, instanceName });
      return {
        mode: "image",
        providerMessageId: "evolution-msg-1",
      };
    };
    notifier.resolveWahaSession = async () => ({
      name: "default",
      status: "WORKING",
    });
    notifier.sendWahaImageMessage = async ({ chatId, sessionName }) => {
      calls.push({ provider: "waha", chatId, instanceName: sessionName });
      return {
        mode: "text",
        providerMessageId: "waha-msg-2",
      };
    };

    const result = await notifier.send({
      delivery_key: "mirror-key-1",
      chat_id: "group-secondary@g.us",
      payload_json: {
        alert: {
          id: "alert-3",
          source: "manual",
          cat: "1",
          title: "ירי רקטות וטילים",
          desc: "",
          data: ["חיפה"],
          alertDate: "2026-03-26 21:11:00",
        },
        matched: ["חיפה"],
        chatId: "group-secondary@g.us",
        eventType: "active_alert",
        source: "manual",
      },
    });

    assert.deepEqual(calls, [
      {
        provider: "evolution",
        chatId: "group-secondary@g.us",
        instanceName: "Hamal",
      },
      {
        provider: "waha",
        chatId: "group-secondary@g.us",
        instanceName: "default",
      },
    ]);
    assert.equal(result.provider, "evolution");
    assert.deepEqual(result.mirroredProviders, ["waha"]);

    const recentSent = loadRecentSent(recentSentFilePath);
    assert.equal(recentSent.length, 2);
    assert.equal(recentSent[0].provider, "waha");
    assert.equal(recentSent[1].provider, "evolution");

    const state = loadNotifierState(stateFilePath, {
      includeTelegram: false,
    });
    assert.equal(state.whatsappWahaSession, "default");
    assert.equal(state.whatsappWahaState, "WORKING");
  });
});
