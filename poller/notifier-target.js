import { normalizeChatTarget } from "./lib.js";

export function parseNotifierTarget(target = "") {
  const raw = String(target || "").trim();
  if (!raw) {
    return {
      transport: "",
      chatId: "",
      normalized: "",
    };
  }

  const delimiterIndex = raw.indexOf(":");
  if (delimiterIndex > 0) {
    const scheme = raw.slice(0, delimiterIndex).trim().toLowerCase();
    const remainder = raw.slice(delimiterIndex + 1).trim();

    if (scheme === "telegram") {
      return {
        transport: "telegram",
        chatId: remainder,
        normalized: remainder ? `telegram:${remainder}` : "",
      };
    }

    if (scheme === "whatsapp") {
      const chatId = normalizeChatTarget(remainder);
      return {
        transport: "whatsapp",
        chatId,
        normalized: chatId,
      };
    }
  }

  const chatId = normalizeChatTarget(raw);
  return {
    transport: "whatsapp",
    chatId,
    normalized: chatId,
  };
}

export function summarizeNotifierTargets(targets = []) {
  const entries = [...new Set(
    (Array.isArray(targets) ? targets : [])
      .map((target) => parseNotifierTarget(target).normalized)
      .filter(Boolean),
  )].map((target) => parseNotifierTarget(target));

  const byTransport = Object.fromEntries(
    ["telegram", "whatsapp"].map((transport) => [
      transport,
      entries.filter((entry) => entry.transport === transport).length,
    ]),
  );

  return {
    total: entries.length,
    labels: entries.map((entry) => entry.normalized || entry.chatId),
    byTransport,
  };
}
