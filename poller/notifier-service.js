import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appDir } from "./customization-paths.js";
import { DeliveryDedupeGate } from "./delivery-dedupe.js";
import {
  buildDeliveryKey,
  buildSemanticAlertKey,
  buildEvolutionHeaders,
  chooseEvolutionInstance,
  detectEventType,
  formatMessage,
  getConnectionState,
  getInstances,
  hashDeliveryKey,
  normalizeChatTarget,
  parseChatTargets,
  resolveEventType,
  resolveMessageMediaBaseName,
  shouldFallbackToText,
} from "./lib.js";
import { parseNotifierTarget } from "./notifier-target.js";
import { loadConfiguredEventMedia } from "./message-assets.js";
import {
  formatTelegramError,
  isTelegramTransientError,
  retryTelegramOperation,
} from "./telegram.js";
import { createLogger } from "./log.js";
import { appendRecentSentEntry, loadRecentSentEntries } from "./ops-timeline-store.js";

const DEFAULT_EVOLUTION_URL = "http://evolution-api:8080";
const DEFAULT_EVOLUTION_TIMEOUT_MS = 10_000;
const DEFAULT_WAHA_URL = "http://waha:3000";
const DEFAULT_WAHA_TIMEOUT_MS = 15_000;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 15_000;
const MAX_RECENT_SENT = 100;
const logger = createLogger("notifier-service");

export const notifierStatePath = join(appDir, "data", "notifier-state.json");
export const telegramNotifierStatePath = join(appDir, "data", "telegram-notifier-state.json");
export const recentSentStorePath = join(appDir, "data", "recent-sent.json");
export const notifierDeliveryStorePath = join(appDir, "data", "notifier-deliveries.json");

function toIsoString(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function persistJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function loadJson(filePath, fallback, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logger.warn("notifier_store_load_failed", {
        label,
        file_path: filePath,
        error: err,
      });
    }
    return fallback;
  }
}

function loadWhatsAppNotifierState(filePath = notifierStatePath) {
  if (!filePath) {
    return {
      whatsappConnectionState: null,
      whatsappActiveInstance: null,
      whatsappPrimaryInstance: null,
      whatsappPrimaryState: null,
      whatsappFallbackInstance: null,
      whatsappFallbackState: null,
      whatsappLastCheckedAt: null,
      whatsappLastError: null,
      whatsappDisconnectedSince: null,
      whatsappWahaSession: null,
      whatsappWahaState: null,
      whatsappWahaLastCheckedAt: null,
      whatsappWahaLastError: null,
      whatsappWahaRoutedTargets: [],
      lastDeliveredAt: null,
      lastDeliveredEventType: null,
      lastDeliveredSource: null,
      lastDeliveredTransport: null,
    };
  }

  const parsed = loadJson(filePath, {}, "notifier state");
  return {
    whatsappConnectionState: parsed?.whatsappConnectionState || null,
    whatsappActiveInstance: parsed?.whatsappActiveInstance || null,
    whatsappPrimaryInstance: parsed?.whatsappPrimaryInstance || null,
    whatsappPrimaryState: parsed?.whatsappPrimaryState || null,
    whatsappFallbackInstance: parsed?.whatsappFallbackInstance || null,
    whatsappFallbackState: parsed?.whatsappFallbackState || null,
    whatsappLastCheckedAt: parsed?.whatsappLastCheckedAt || null,
    whatsappLastError: parsed?.whatsappLastError || null,
    whatsappDisconnectedSince: parsed?.whatsappDisconnectedSince || null,
    whatsappWahaSession: parsed?.whatsappWahaSession || null,
    whatsappWahaState: parsed?.whatsappWahaState || null,
    whatsappWahaLastCheckedAt: parsed?.whatsappWahaLastCheckedAt || null,
    whatsappWahaLastError: parsed?.whatsappWahaLastError || null,
    whatsappWahaRoutedTargets: Array.isArray(parsed?.whatsappWahaRoutedTargets)
      ? parsed.whatsappWahaRoutedTargets.filter(Boolean)
      : [],
    lastDeliveredAt: parsed?.lastDeliveredAt || null,
    lastDeliveredEventType: parsed?.lastDeliveredEventType || null,
    lastDeliveredSource: parsed?.lastDeliveredSource || null,
    lastDeliveredTransport: parsed?.lastDeliveredTransport || null,
  };
}

function loadTelegramNotifierState(filePath = telegramNotifierStatePath) {
  if (!filePath) {
    return {
      telegramLastCheckedAt: null,
      telegramLastError: null,
      telegramLastDeliveredChatId: null,
      lastDeliveredAt: null,
      lastDeliveredEventType: null,
      lastDeliveredSource: null,
      lastDeliveredTransport: null,
    };
  }

  const parsed = loadJson(filePath, {}, "telegram notifier state");
  return {
    telegramLastCheckedAt: parsed?.telegramLastCheckedAt || null,
    telegramLastError: parsed?.telegramLastError || null,
    telegramLastDeliveredChatId: parsed?.telegramLastDeliveredChatId || null,
    lastDeliveredAt: parsed?.lastDeliveredAt || null,
    lastDeliveredEventType: parsed?.lastDeliveredEventType || null,
    lastDeliveredSource: parsed?.lastDeliveredSource || null,
    lastDeliveredTransport: parsed?.lastDeliveredTransport || null,
  };
}

function pickLatestDeliveryState(whatsAppState = {}, telegramState = {}) {
  const whatsAppDeliveredAt = Date.parse(whatsAppState.lastDeliveredAt || "");
  const telegramDeliveredAt = Date.parse(telegramState.lastDeliveredAt || "");

  if (Number.isFinite(telegramDeliveredAt) && telegramDeliveredAt > (Number.isFinite(whatsAppDeliveredAt) ? whatsAppDeliveredAt : -Infinity)) {
    return telegramState;
  }

  return whatsAppState;
}

export function loadNotifierState(
  filePath = notifierStatePath,
  {
    telegramFilePath = telegramNotifierStatePath,
    includeTelegram = true,
  } = {},
) {
  const whatsAppState = loadWhatsAppNotifierState(filePath);
  const telegramState = includeTelegram
    ? loadTelegramNotifierState(telegramFilePath)
    : loadTelegramNotifierState(null);
  const latestDelivery = pickLatestDeliveryState(whatsAppState, telegramState);

  return {
    ...whatsAppState,
    telegramLastCheckedAt: includeTelegram ? telegramState.telegramLastCheckedAt : null,
    telegramLastError: includeTelegram ? telegramState.telegramLastError : null,
    telegramLastDeliveredAt: includeTelegram ? telegramState.lastDeliveredAt : null,
    telegramLastDeliveredEventType: includeTelegram ? telegramState.lastDeliveredEventType : null,
    telegramLastDeliveredSource: includeTelegram ? telegramState.lastDeliveredSource : null,
    telegramLastDeliveredChatId: includeTelegram ? telegramState.telegramLastDeliveredChatId : null,
    lastDeliveredAt: latestDelivery.lastDeliveredAt || whatsAppState.lastDeliveredAt || null,
    lastDeliveredEventType: latestDelivery.lastDeliveredEventType || whatsAppState.lastDeliveredEventType || null,
    lastDeliveredSource: latestDelivery.lastDeliveredSource || whatsAppState.lastDeliveredSource || null,
    lastDeliveredTransport: latestDelivery.lastDeliveredTransport || whatsAppState.lastDeliveredTransport || null,
  };
}

export function loadRecentSent(filePath = recentSentStorePath) {
  return loadRecentSentEntries(filePath, logger);
}

function loadEventMedia() {
  return loadConfiguredEventMedia();
}

function buildNotifierDeliveryKey({ alert, matched = [], chatId = "", eventType } = {}) {
  return hashDeliveryKey(buildDeliveryKey(alert, matched, { chatId, eventType }));
}

function buildTargetLogFields(chatId = "") {
  const target = parseNotifierTarget(chatId);
  return {
    chat_id: target.normalized || String(chatId || "").trim(),
    transport: target.transport || "whatsapp",
  };
}

function getJobPayload(job = {}) {
  return job?.payload && typeof job.payload === "object"
    ? job.payload
    : job?.payload_json && typeof job.payload_json === "object"
      ? job.payload_json
      : {};
}
export { parseNotifierTarget };

function buildWahaHeaders(apiKey = "") {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Api-Key": String(apiKey || "").trim(),
  };
}

function getWahaSessionStatus(payload = {}) {
  return String(payload?.status || "").trim().toUpperCase() || null;
}

function normalizeWahaChatId(chatId = "") {
  const normalized = normalizeChatTarget(chatId);
  if (!normalized) return "";
  if (normalized.includes("@")) return normalized;
  return `${normalized}@c.us`;
}

function extractWahaMessageId(payload = {}) {
  return payload?.id
    || payload?.message?.id
    || payload?.key?.id
    || payload?.data?.id
    || null;
}

function resolveJobContext(job = {}) {
  const payload = getJobPayload(job);
  const alert = payload.alert && typeof payload.alert === "object" ? payload.alert : null;
  const matched = Array.isArray(payload.matched) ? payload.matched : [];
  const rawChatId = String(payload.chatId || job?.chat_id || "").trim();
  const target = parseNotifierTarget(rawChatId);
  const eventType = resolveEventType(payload.eventType || job?.event_type || detectEventType(alert));
  const source = String(payload.source || job?.source || alert?.source || "manual");
  const deliveryKey = String(job?.delivery_key || job?.deliveryKey || "").trim()
    || buildNotifierDeliveryKey({
      alert,
      matched,
      chatId: target.normalized || rawChatId,
      eventType,
    });

  return {
    payload,
    alert,
    matched,
    target,
    eventType,
    source,
    deliveryKey,
  };
}

export class WhatsAppNotifier {
  constructor({
    evolutionUrl = process.env.EVOLUTION_URL || DEFAULT_EVOLUTION_URL,
    evolutionApiKey = process.env.EVOLUTION_API_KEY || "",
    evolutionInstance = process.env.EVOLUTION_INSTANCE || "default",
    evolutionFallbackInstance = process.env.EVOLUTION_FALLBACK_INSTANCE || "",
    evolutionTimeoutMs = DEFAULT_EVOLUTION_TIMEOUT_MS,
    wahaUrl = process.env.WAHA_URL || DEFAULT_WAHA_URL,
    wahaApiKey = process.env.WAHA_API_KEY || "",
    wahaSession = process.env.WAHA_SESSION || "default",
    wahaTimeoutMs = DEFAULT_WAHA_TIMEOUT_MS,
    wahaTargets = parseChatTargets(process.env.WAHA_TARGETS || ""),
    wahaDeviceName = process.env.WAHA_DEVICE_NAME || "WAHA",
    wahaBrowserName = process.env.WAHA_BROWSER_NAME || "Red Alerts",
    stateFilePath = notifierStatePath,
    recentSentFilePath = recentSentStorePath,
    dedupeFilePath = notifierDeliveryStorePath,
  } = {}) {
    this.evolutionUrl = evolutionUrl;
    this.evolutionApiKey = evolutionApiKey;
    this.evolutionInstance = evolutionInstance;
    this.evolutionFallbackInstance = String(evolutionFallbackInstance || "").trim();
    this.evolutionTimeoutMs = evolutionTimeoutMs;
    this.wahaUrl = String(wahaUrl || "").trim();
    this.wahaApiKey = String(wahaApiKey || "").trim();
    this.wahaSession = String(wahaSession || "").trim() || "default";
    this.wahaTimeoutMs = wahaTimeoutMs;
    this.wahaTargetSet = new Set(parseChatTargets(wahaTargets).map((target) => normalizeChatTarget(target)));
    this.wahaDeviceName = String(wahaDeviceName || "").trim() || "WAHA";
    this.wahaBrowserName = String(wahaBrowserName || "").trim() || "Red Alerts";
    this.stateFilePath = stateFilePath;
    this.recentSentFilePath = recentSentFilePath;
    this.state = loadWhatsAppNotifierState(stateFilePath);
    this.dedupeGate = new DeliveryDedupeGate({
      filePath: dedupeFilePath,
      maxEntries: 10_000,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      label: "notifier delivery store",
    });
    this.eventMedia = loadEventMedia();
  }

  get wahaEnabled() {
    return this.wahaTargetSet.size > 0;
  }

  status() {
    return {
      ...this.state,
      dedupeSize: this.dedupeGate.size,
      dedupeInFlight: this.dedupeGate.inFlightSize,
    };
  }

  updateState(patch = {}) {
    this.state = {
      ...this.state,
      ...patch,
    };
    persistJson(this.stateFilePath, this.state);
    return this.state;
  }

  async ensureReady() {
    try {
      await this.ensureEvolutionInstance();
    } catch (err) {
      this.updateState({
        whatsappLastCheckedAt: toIsoString(),
        whatsappLastError: err.message,
      });
      throw err;
    }

    if (this.wahaEnabled) {
      try {
        await this.ensureWahaSession();
      } catch (err) {
        this.updateState({
          whatsappWahaSession: this.wahaSession,
          whatsappWahaLastCheckedAt: toIsoString(),
          whatsappWahaLastError: err.message,
          whatsappWahaRoutedTargets: [...this.wahaTargetSet],
        });
        logger.warn("waha_notifier_not_ready", {
          session_name: this.wahaSession,
          routed_targets: [...this.wahaTargetSet],
          error: err,
        });
      }
    }
  }

  async refreshStatus() {
    let wahaPatch = {
      whatsappWahaSession: this.wahaEnabled ? this.wahaSession : null,
      whatsappWahaState: this.wahaEnabled ? this.state.whatsappWahaState : null,
      whatsappWahaLastCheckedAt: this.wahaEnabled ? this.state.whatsappWahaLastCheckedAt : null,
      whatsappWahaLastError: this.wahaEnabled ? this.state.whatsappWahaLastError : null,
      whatsappWahaRoutedTargets: this.wahaEnabled ? [...this.wahaTargetSet] : [],
    };
    if (this.wahaEnabled) {
      wahaPatch = await this.refreshWahaStatus();
    }

    try {
      const active = await this.resolveActiveEvolutionInstance();
      this.updateState({
        ...wahaPatch,
        whatsappLastCheckedAt: toIsoString(),
        whatsappLastError: null,
        whatsappDisconnectedSince: null,
        whatsappConnectionState: active.connectionState,
        whatsappPrimaryInstance: active.primary.instanceName,
        whatsappPrimaryState: active.primary.connectionState,
        whatsappFallbackInstance: active.fallback.instanceName,
        whatsappFallbackState: active.fallback.connectionState,
        whatsappActiveInstance: active.instanceName,
      });
      return this.status();
    } catch (err) {
      const disconnectedSince = this.state.whatsappDisconnectedSince || toIsoString();
      this.updateState({
        ...wahaPatch,
        whatsappLastCheckedAt: toIsoString(),
        whatsappLastError: err.message,
        whatsappDisconnectedSince: disconnectedSince,
      });
      throw err;
    }
  }

  async send(job = {}) {
    const {
      alert,
      matched,
      target,
      eventType,
      source,
      deliveryKey,
    } = resolveJobContext(job);

    if (!alert || !target.chatId) {
      throw new Error("outbox job missing alert or chatId");
    }
    if (target.transport !== "whatsapp") {
      throw new Error(`unsupported WhatsApp notifier target transport: ${target.transport || "unknown"}`);
    }

    const caption = formatMessage(alert, matched, { eventType });

    if (this.dedupeGate.shouldSuppress(deliveryKey)) {
      return {
        skipped: true,
        reason: "notifier_duplicate",
        key: deliveryKey,
        eventType,
        chatId: target.normalized,
      };
    }

    this.dedupeGate.markInFlight(deliveryKey);
    try {
      if (this.shouldRouteTargetToWaha(target.normalized || target.chatId)) {
        return await this.sendViaWaha({
          alert,
          matched,
          target,
          eventType,
          source,
          deliveryKey,
          caption,
        });
      }

      return await this.sendViaEvolution({
        alert,
        matched,
        target,
        eventType,
        source,
        deliveryKey,
        caption,
      });
    } finally {
      this.dedupeGate.clearInFlight(deliveryKey);
    }
  }

  shouldRouteTargetToWaha(chatId = "") {
    const normalized = normalizeChatTarget(chatId);
    return normalized ? this.wahaTargetSet.has(normalized) : false;
  }

  async sendViaEvolution({
    alert,
    matched,
    target,
    eventType,
    source,
    deliveryKey,
    caption,
  }) {
    const active = await this.resolveActiveEvolutionInstance();
    const result = await this.sendImageMessage({
      alert,
      caption,
      chatId: target.chatId,
      eventType,
      instanceName: active.instanceName,
    });
    this.dedupeGate.remember(deliveryKey);
    appendRecentSentEntry({
      deliveredAt: toIsoString(),
      eventType,
      source,
      title: alert.title || "",
      chatId: target.normalized,
      matchedLocations: matched,
      semanticKey: buildSemanticAlertKey(alert, matched, { eventType }),
      deliveryKey,
      alertDate: alert.alertDate || null,
      receivedAt: alert.receivedAt || null,
      deliveryMode: result.mode,
      transport: "whatsapp",
      instanceName: active.instanceName,
      usedFallback: Boolean(active.usedFallback),
      provider: "evolution",
    }, {
      filePath: this.recentSentFilePath,
      maxEntries: MAX_RECENT_SENT,
      logger,
    });
    this.updateState({
      whatsappLastCheckedAt: toIsoString(),
      whatsappLastError: null,
      whatsappDisconnectedSince: null,
      whatsappConnectionState: active.connectionState,
      whatsappPrimaryInstance: active.primary.instanceName,
      whatsappPrimaryState: active.primary.connectionState,
      whatsappFallbackInstance: active.fallback.instanceName,
      whatsappFallbackState: active.fallback.connectionState,
      whatsappActiveInstance: active.instanceName,
      lastDeliveredAt: toIsoString(),
      lastDeliveredEventType: eventType,
      lastDeliveredSource: source,
      lastDeliveredTransport: "whatsapp",
    });
    return {
      ...result,
      skipped: false,
      key: deliveryKey,
      eventType,
      chatId: target.normalized,
      transport: "whatsapp",
      instanceName: active.instanceName,
      usedFallback: Boolean(active.usedFallback),
      provider: "evolution",
    };
  }

  async sendViaWaha({
    alert,
    matched,
    target,
    eventType,
    source,
    deliveryKey,
    caption,
  }) {
    const session = await this.resolveWahaSession();
    const result = await this.sendWahaImageMessage({
      alert,
      caption,
      chatId: target.chatId,
      eventType,
      sessionName: session.name,
    });
    this.dedupeGate.remember(deliveryKey);
    appendRecentSentEntry({
      deliveredAt: toIsoString(),
      eventType,
      source,
      title: alert.title || "",
      chatId: target.normalized,
      matchedLocations: matched,
      semanticKey: buildSemanticAlertKey(alert, matched, { eventType }),
      deliveryKey,
      alertDate: alert.alertDate || null,
      receivedAt: alert.receivedAt || null,
      deliveryMode: result.mode,
      transport: "whatsapp",
      instanceName: session.name,
      usedFallback: false,
      provider: "waha",
    }, {
      filePath: this.recentSentFilePath,
      maxEntries: MAX_RECENT_SENT,
      logger,
    });
    this.updateState({
      whatsappWahaSession: session.name,
      whatsappWahaState: session.status,
      whatsappWahaLastCheckedAt: toIsoString(),
      whatsappWahaLastError: null,
      whatsappWahaRoutedTargets: [...this.wahaTargetSet],
      lastDeliveredAt: toIsoString(),
      lastDeliveredEventType: eventType,
      lastDeliveredSource: source,
      lastDeliveredTransport: "whatsapp",
    });
    return {
      ...result,
      skipped: false,
      key: deliveryKey,
      eventType,
      chatId: target.normalized,
      transport: "whatsapp",
      instanceName: session.name,
      usedFallback: false,
      provider: "waha",
    };
  }

  async fetchEvolution(path, options = {}) {
    return fetch(`${this.evolutionUrl}${path}`, {
      ...options,
      headers: {
        ...buildEvolutionHeaders(this.evolutionApiKey),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(this.evolutionTimeoutMs),
    });
  }

  async ensureEvolutionInstance(instanceName = this.evolutionInstance, { createIfMissing = true } = {}) {
    const instancesRes = await this.fetchEvolution("/instance/fetchInstances");
    if (!instancesRes.ok) {
      throw new Error(`evolution fetchInstances responded ${instancesRes.status}: ${await instancesRes.text()}`);
    }

    const instances = getInstances(await instancesRes.json());
    const exists = instances.some((instance) =>
      instance?.name === instanceName || instance?.instanceName === instanceName,
    );

    if (exists || !createIfMissing) return;

    const createRes = await this.fetchEvolution("/instance/create", {
      method: "POST",
      body: JSON.stringify({
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
      }),
    });
    if (!createRes.ok) {
      throw new Error(`evolution create responded ${createRes.status}: ${await createRes.text()}`);
    }
  }

  async fetchEvolutionConnectionState(instanceName = this.evolutionInstance) {
    const stateRes = await this.fetchEvolution(`/instance/connectionState/${instanceName}`);
    if (!stateRes.ok) {
      throw new Error(
        `evolution connectionState ${instanceName} responded ${stateRes.status}: ${await stateRes.text()}`,
      );
    }

    return getConnectionState(await stateRes.json());
  }

  async fetchEvolutionInstanceStatus(instanceName, { createIfMissing = false } = {}) {
    if (!instanceName) {
      return { instanceName: null, connectionState: null, error: null };
    }

    try {
      await this.ensureEvolutionInstance(instanceName, { createIfMissing });
      const connectionState = await this.fetchEvolutionConnectionState(instanceName);
      return { instanceName, connectionState, error: null };
    } catch (err) {
      return { instanceName, connectionState: null, error: err.message };
    }
  }

  async resolveActiveEvolutionInstance() {
    const primary = await this.fetchEvolutionInstanceStatus(this.evolutionInstance, {
      createIfMissing: true,
    });
    const fallback = this.evolutionFallbackInstance
      ? await this.fetchEvolutionInstanceStatus(this.evolutionFallbackInstance, {
        createIfMissing: false,
      })
      : { instanceName: null, connectionState: null, error: null };

    const choice = chooseEvolutionInstance({
      primaryInstance: primary.instanceName,
      primaryState: primary.connectionState,
      fallbackInstance: fallback.instanceName,
      fallbackState: fallback.connectionState,
    });

    if (choice.instanceName && String(choice.connectionState).toLowerCase() === "open") {
      return {
        ...choice,
        primary,
        fallback,
      };
    }

    throw new Error(
      `evolution sender unavailable: primary=${primary.connectionState || primary.error || "missing"} fallback=${fallback.instanceName ? fallback.connectionState || fallback.error || "missing" : "disabled"}`,
    );
  }

  async fetchWaha(path, options = {}) {
    return fetch(`${this.wahaUrl}${path}`, {
      ...options,
      headers: {
        ...buildWahaHeaders(this.wahaApiKey),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(this.wahaTimeoutMs),
    });
  }

  requireWahaConfig() {
    if (!this.wahaUrl || !this.wahaApiKey || !this.wahaSession) {
      throw new Error("WAHA_URL, WAHA_API_KEY, and WAHA_SESSION are required for WAHA-routed targets");
    }
  }

  async fetchWahaSession(sessionName = this.wahaSession) {
    this.requireWahaConfig();
    const res = await this.fetchWaha(`/api/sessions/${encodeURIComponent(sessionName)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`waha session ${sessionName} responded ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  async ensureWahaSession(sessionName = this.wahaSession) {
    this.requireWahaConfig();
    const existing = await this.fetchWahaSession(sessionName);
    if (existing) return existing;

    const res = await this.fetchWaha("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        name: sessionName,
        config: {
          client: {
            deviceName: this.wahaDeviceName,
            browserName: this.wahaBrowserName,
          },
          ignore: {
            groups: false,
            channels: true,
          },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`waha create session responded ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  async refreshWahaStatus() {
    const basePatch = {
      whatsappWahaSession: this.wahaSession,
      whatsappWahaRoutedTargets: [...this.wahaTargetSet],
    };
    try {
      await this.ensureWahaSession();
      const session = await this.fetchWahaSession(this.wahaSession);
      return {
        ...basePatch,
        whatsappWahaState: getWahaSessionStatus(session),
        whatsappWahaLastCheckedAt: toIsoString(),
        whatsappWahaLastError: null,
      };
    } catch (err) {
      logger.warn("waha_status_refresh_failed", {
        session_name: this.wahaSession,
        error: err,
      });
      return {
        ...basePatch,
        whatsappWahaState: this.state.whatsappWahaState,
        whatsappWahaLastCheckedAt: toIsoString(),
        whatsappWahaLastError: err.message,
      };
    }
  }

  async resolveWahaSession() {
    await this.ensureWahaSession();
    const session = await this.fetchWahaSession(this.wahaSession);
    const status = getWahaSessionStatus(session);
    if (status === "WORKING") {
      return {
        name: this.wahaSession,
        status,
      };
    }
    throw new Error(`waha sender unavailable: session=${this.wahaSession} status=${status || "missing"}`);
  }

  async sendTextMessage({ caption, chatId, instanceName }) {
    const res = await this.fetchEvolution(`/message/sendText/${instanceName}`, {
      method: "POST",
      body: JSON.stringify({
        number: chatId,
        text: caption,
        delay: 0,
        linkPreview: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`evolution responded ${res.status}: ${await res.text()}`);
    }
    return { mode: "text" };
  }

  async sendImageMessage({ alert, caption, chatId, eventType, instanceName }) {
    const baseName = resolveMessageMediaBaseName(alert, eventType);
    const file = this.eventMedia[baseName];
    const res = await this.fetchEvolution(`/message/sendMedia/${instanceName}`, {
      method: "POST",
      body: JSON.stringify({
        number: chatId,
        mediatype: "image",
        mimetype: file.mimetype,
        media: file.data,
        fileName: file.filename,
        caption,
      }),
    });
    if (res.ok) {
      return { mode: "image" };
    }

    const body = await res.text();
    if (shouldFallbackToText(res.status, body)) {
      logger.warn("whatsapp_media_fallback", {
        ...buildTargetLogFields(chatId),
        event_type: eventType,
        instance_name: instanceName,
        fallback_to: "text",
        response_status: res.status,
        response_body: body,
      });
      return this.sendTextMessage({ caption, chatId, instanceName });
    }

    throw new Error(`evolution responded ${res.status}: ${body}`);
  }

  async sendWahaTextMessage({ caption, chatId, sessionName }) {
    const res = await this.fetchWaha("/api/sendText", {
      method: "POST",
      body: JSON.stringify({
        session: sessionName,
        chatId: normalizeWahaChatId(chatId),
        text: caption,
        linkPreview: false,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`waha responded ${res.status}: ${JSON.stringify(body)}`);
    }
    return {
      mode: "text",
      providerMessageId: extractWahaMessageId(body),
    };
  }

  async sendWahaImageMessage({ alert, caption, chatId, eventType, sessionName }) {
    const baseName = resolveMessageMediaBaseName(alert, eventType);
    const file = this.eventMedia[baseName];
    const res = await this.fetchWaha("/api/sendImage", {
      method: "POST",
      body: JSON.stringify({
        session: sessionName,
        chatId: normalizeWahaChatId(chatId),
        file: {
          mimetype: file.mimetype,
          filename: file.filename,
          data: file.data,
        },
        caption,
      }),
    });
    const body = await res.json().catch(async () => ({ raw: await res.text().catch(() => "") }));
    if (res.ok) {
      return {
        mode: "image",
        providerMessageId: extractWahaMessageId(body),
      };
    }

    const serializedBody = JSON.stringify(body);
    if (shouldFallbackToText(res.status, serializedBody)) {
      logger.warn("whatsapp_media_fallback", {
        ...buildTargetLogFields(chatId),
        event_type: eventType,
        instance_name: sessionName,
        fallback_to: "text",
        response_status: res.status,
        response_body: serializedBody,
        provider: "waha",
      });
      return this.sendWahaTextMessage({ caption, chatId, sessionName });
    }

    throw new Error(`waha responded ${res.status}: ${serializedBody}`);
  }
}

export class TelegramNotifier {
  constructor({
    botToken = process.env.TELEGRAM_BOT_TOKEN || "",
    telegramTimeoutMs = DEFAULT_TELEGRAM_TIMEOUT_MS,
    stateFilePath = telegramNotifierStatePath,
    recentSentFilePath = recentSentStorePath,
    callTelegramApi = null,
  } = {}) {
    this.botToken = String(botToken || "").trim();
    this.telegramTimeoutMs = telegramTimeoutMs;
    this.stateFilePath = stateFilePath;
    this.recentSentFilePath = recentSentFilePath;
    this.state = loadTelegramNotifierState(stateFilePath);
    this.eventMedia = loadEventMedia();
    this.callTelegramApi = typeof callTelegramApi === "function"
      ? callTelegramApi
      : (method, payload = null) => this.fetchTelegram(method, payload);
  }

  status() {
    return {
      ...this.state,
    };
  }

  updateState(patch = {}) {
    this.state = {
      ...this.state,
      ...patch,
    };
    persistJson(this.stateFilePath, this.state);
    return this.state;
  }

  async ensureReady() {
    if (!this.botToken) {
      return this.status();
    }

    try {
      await this.callTelegramApi("getMe");
      this.updateState({
        telegramLastCheckedAt: toIsoString(),
        telegramLastError: null,
      });
      return this.status();
    } catch (err) {
      this.updateState({
        telegramLastCheckedAt: toIsoString(),
        telegramLastError: formatTelegramError(err),
      });
      throw err;
    }
  }

  async refreshStatus() {
    return this.ensureReady();
  }

  async send(job = {}) {
    const {
      alert,
      matched,
      target,
      eventType,
      source,
      deliveryKey,
    } = resolveJobContext(job);

    if (!alert || !target.chatId) {
      throw new Error("outbox job missing alert or chatId");
    }
    if (target.transport !== "telegram") {
      throw new Error(`unsupported Telegram notifier target transport: ${target.transport || "unknown"}`);
    }
    if (!this.botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required for telegram notifier targets");
    }

    const caption = formatMessage(alert, matched, { eventType });
    const result = await this.sendTelegramMessage({
      alert,
      caption,
      chatId: target.chatId,
      eventType,
      deliveryKey,
      source,
      targetLabel: target.normalized,
    });

    appendRecentSentEntry({
      deliveredAt: toIsoString(),
      eventType,
      source,
      title: alert.title || "",
      chatId: target.normalized,
      matchedLocations: matched,
      semanticKey: buildSemanticAlertKey(alert, matched, { eventType }),
      deliveryKey,
      alertDate: alert.alertDate || null,
      receivedAt: alert.receivedAt || null,
      deliveryMode: result.mode,
      transport: "telegram",
      providerMessageId: result?.providerMessageId ?? null,
      instanceName: "",
      usedFallback: false,
    }, {
      filePath: this.recentSentFilePath,
      maxEntries: MAX_RECENT_SENT,
      logger,
    });

    this.updateState({
      telegramLastCheckedAt: toIsoString(),
      telegramLastError: null,
      telegramLastDeliveredChatId: target.chatId,
      lastDeliveredAt: toIsoString(),
      lastDeliveredEventType: eventType,
      lastDeliveredSource: source,
      lastDeliveredTransport: "telegram",
    });

    return {
      skipped: false,
      mode: result.mode,
      key: deliveryKey,
      eventType,
      chatId: target.normalized,
      transport: "telegram",
      providerMessageId: result?.providerMessageId ?? null,
      instanceName: "",
      usedFallback: false,
    };
  }

  async sendTelegramMessage({
    alert,
    caption,
    chatId,
    eventType,
    deliveryKey,
    source,
    targetLabel,
  } = {}) {
    try {
      return await this.sendTelegramPhotoMessage({
        alert,
        caption,
        chatId,
        eventType,
        deliveryKey,
        source,
        targetLabel,
      });
    } catch (err) {
      logger.warn("telegram_media_fallback", {
        delivery_key: deliveryKey,
        source,
        event_type: eventType,
        ...buildTargetLogFields(targetLabel || chatId),
        fallback_to: "text",
        error: formatTelegramError(err),
      });
      return this.sendTelegramTextMessage({
        caption,
        chatId,
        deliveryKey,
        source,
        eventType,
        targetLabel,
      });
    }
  }

  async sendTelegramTextMessage({
    caption,
    chatId,
    deliveryKey,
    source,
    eventType,
    targetLabel,
  } = {}) {
    const result = await retryTelegramOperation(
      "sendMessage",
      () => this.callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: caption,
      }),
      {
        shouldRetry: isTelegramTransientError,
        onRetry: (detail) => {
          logger.warn("telegram_notifier_retry", {
            attempt: detail.attempt,
            delay_ms: detail.delayMs,
            delivery_key: deliveryKey,
            source,
            event_type: eventType,
            ...buildTargetLogFields(targetLabel || chatId),
            error: detail.error,
          });
        },
      },
    );

    return {
      mode: "text",
      providerMessageId: result?.message_id ?? null,
    };
  }

  async sendTelegramPhotoMessage({
    alert,
    caption,
    chatId,
    eventType,
    deliveryKey,
    source,
    targetLabel,
  } = {}) {
    const baseName = resolveMessageMediaBaseName(alert, eventType);
    const file = this.eventMedia[baseName];
    if (!file) {
      throw new Error(`telegram media asset missing for ${baseName}`);
    }

    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", caption);
    form.set(
      "photo",
      new Blob([Buffer.from(file.data, "base64")], { type: file.mimetype }),
      file.filename,
    );

    const result = await retryTelegramOperation(
      "sendPhoto",
      () => this.callTelegramApi("sendPhoto", form),
      {
        shouldRetry: isTelegramTransientError,
        onRetry: (detail) => {
          logger.warn("telegram_notifier_retry", {
            attempt: detail.attempt,
            delay_ms: detail.delayMs,
            delivery_key: deliveryKey,
            source,
            event_type: eventType,
            ...buildTargetLogFields(targetLabel || chatId),
            error: detail.error,
          });
        },
      },
    );

    return {
      mode: "image",
      providerMessageId: result?.message_id ?? null,
    };
  }

  async fetchTelegram(method, payload = null) {
    const isFormDataPayload = typeof FormData !== "undefined" && payload instanceof FormData;
    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/${method}`,
      {
        method: payload ? "POST" : "GET",
        headers: payload && !isFormDataPayload
          ? { "Content-Type": "application/json" }
          : undefined,
        body: payload
          ? isFormDataPayload ? payload : JSON.stringify(payload)
          : undefined,
        signal: AbortSignal.timeout(this.telegramTimeoutMs),
      },
    );

    if (!res.ok) {
      const bodyText = await res.text();
      const err = new Error(`telegram ${method} responded ${res.status}: ${bodyText || "empty response"}`);
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
}
