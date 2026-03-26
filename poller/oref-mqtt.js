import { createHash, randomBytes } from "node:crypto";
import mqtt from "mqtt";
import { detectEventType, EVENT_TYPES, parseEventDate } from "./lib.js";
import { SOURCE_CHANNELS } from "./sources.js";

export const OREF_CITIES_URL = "https://www.oref.org.il/districts/cities_heb.json";
export const OREF_MQTT_PUSHY_API_URL = "https://pushy.ioref.app";
export const OREF_MQTT_APP_ID = "66c20ac875260a035a3af7b2";
export const OREF_MQTT_APP = null;
export const OREF_MQTT_PLATFORM = "android";
export const OREF_MQTT_SDK = 10117;
export const OREF_MQTT_ANDROID_ID_SUFFIX = "-Google-Android-SDK-built-for-x86_64";
export const OREF_MQTT_DEFAULT_TOPICS = [
  "com.alert.meserhadash",
];
export const OREF_MQTT_DEFAULT_ROTATE_INTERVAL_MS = 5 * 60 * 1000;

const OREF_HEADERS = {
  Referer: "https://www.oref.org.il/",
  "X-Requested-With": "XMLHttpRequest",
  "Content-Type": "application/json",
};

const EVENT_TYPE_TO_CATEGORY = {
  [EVENT_TYPES.PRE_ALERT]: "14",
  [EVENT_TYPES.STAY_NEARBY_UPDATE]: "13",
  [EVENT_TYPES.ALL_CLEAR]: "13",
  [EVENT_TYPES.ACTIVE_ALERT]: "1",
  [EVENT_TYPES.DRONE_ALERT]: "2",
  [EVENT_TYPES.EARTHQUAKE_ALERT]: "7",
};

const THREAT_ID_TO_CATEGORY = {
  "0": "1",
  "1": "12",
  "2": "10",
  "3": "7",
  "4": "11",
  "5": "2",
  "6": "9",
  "7": "14",
  "8": "13",
  "9": "8",
  "11": "3",
};

function normalizeAreas(input) {
  if (Array.isArray(input)) {
    return input
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }

  if (typeof input === "string" && input.trim()) {
    return [input.trim()];
  }

  return [];
}

function normalizeLocationName(value = "") {
  return String(value || "").trim();
}

function formatTimestamp(dateLike) {
  return parseEventDate(dateLike)
    .toLocaleString("sv-SE", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(",", "");
}

function parseJsonText(text = "") {
  const trimmed = String(text || "").replace(/^\uFEFF/, "").trim();
  return trimmed ? JSON.parse(trimmed) : {};
}

async function fetchJson(url, {
  fetchImpl = fetch,
  method = "GET",
  headers = {},
  body = null,
  timeoutMs = 15_000,
} = {}) {
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${url} responded ${res.status}${text ? `: ${text}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return parseJsonText(text);
}

function normalizeTopicList(topics = []) {
  return [...new Set(
    (Array.isArray(topics) ? topics : [])
      .map((topic) => String(topic || "").trim())
      .filter(Boolean),
  )];
}

function normalizeCityIds(citiesIds = "") {
  if (Array.isArray(citiesIds)) {
    return citiesIds
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }

  return String(citiesIds || "")
    .split(",")
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function normalizeOrefMqttAndroidId(androidId = "") {
  const normalized = normalizeLocationName(androidId);
  if (!normalized) return "";
  return normalized.endsWith(OREF_MQTT_ANDROID_ID_SUFFIX)
    ? normalized
    : `${normalized}${OREF_MQTT_ANDROID_ID_SUFFIX}`;
}

export function buildOrefMqttAndroidId(seed = randomBytes(8).toString("hex")) {
  const digest = createHash("sha256")
    .update(normalizeLocationName(seed) || randomBytes(8).toString("hex"))
    .digest("hex")
    .slice(0, 16);
  return normalizeOrefMqttAndroidId(digest);
}

export function buildOrefMqttPushyDevicePayload({
  appId = OREF_MQTT_APP_ID,
  app = OREF_MQTT_APP,
  platform = OREF_MQTT_PLATFORM,
  sdk = OREF_MQTT_SDK,
  androidId = "",
  includeAndroidId = Boolean(androidId),
} = {}) {
  const payload = {
    app,
    appId,
    platform,
    sdk,
  };
  const normalizedAndroidId = normalizeOrefMqttAndroidId(androidId);
  if (includeAndroidId && normalizedAndroidId) {
    payload.androidId = normalizedAndroidId;
  }
  return payload;
}

function resolveOrefMqttCategory(message = {}) {
  const eventType = detectEventType({
    title: String(message?.title || "").trim(),
  });

  if (EVENT_TYPE_TO_CATEGORY[eventType]) {
    return EVENT_TYPE_TO_CATEGORY[eventType];
  }

  const threatId = String(message?.threatId || "").trim();
  if (THREAT_ID_TO_CATEGORY[threatId]) {
    return THREAT_ID_TO_CATEGORY[threatId];
  }

  return String(message?.title || "").trim() ? "4" : null;
}

export function buildOrefCityMap(payload = []) {
  return new Map(
    (Array.isArray(payload) ? payload : [])
      .flatMap((city) => {
        const id = String(city?.id || "").trim();
        const label = String(city?.label || "").trim();
        if (!id || !label) return [];
        return [[id, label.split("|")[0].trim()]];
      }),
  );
}

export function buildOrefMqttSubscriptionTopics(
  payload = [],
  { baseTopics = OREF_MQTT_DEFAULT_TOPICS } = {},
) {
  const topics = new Set(normalizeTopicList(baseTopics));

  for (const city of Array.isArray(payload) ? payload : []) {
    const cityId = String(city?.id || "").trim();
    const areaId = String(city?.areaid || "").trim();

    if (cityId) {
      topics.add(cityId);
      topics.add(`500${cityId}`);
    }

    if (areaId) {
      topics.add(areaId);
    }
  }

  return [...topics];
}

export function resolveOrefMqttCityNames(citiesIds = "", cityIdToName = new Map()) {
  return [...new Set(
    normalizeCityIds(citiesIds)
      .map((cityId) => cityId.replace(/^500/, ""))
      .map((cityId) => cityIdToName.get(cityId) || "")
      .filter(Boolean),
  )];
}

export function normalizeOrefMqttMessage(message = {}, cityIdToName = new Map()) {
  const title = String(message?.title || "").trim();
  const data = resolveOrefMqttCityNames(message?.citiesIds, cityIdToName);
  const id = String(message?.id || message?.alertTitle || message?.msgId || "").trim();
  const cat = resolveOrefMqttCategory(message);

  if (!title || !id || !cat || data.length === 0) {
    return null;
  }

  return {
    id: `${SOURCE_CHANNELS.OREF_MQTT}:${id}`,
    source: SOURCE_CHANNELS.OREF_MQTT,
    alertDate: formatTimestamp(message?.time || Date.now()),
    sourceEventAt: message?.time ? new Date(message.time).toISOString() : null,
    sourceMessageId: id,
    sourceMessageType: "mqtt_message",
    title,
    cat,
    data: normalizeAreas(data),
    desc: String(message?.desc || "").trim(),
    sourceMeta: {
      ...(String(message?.msgId || "").trim()
        ? { msgId: String(message.msgId).trim() }
        : {}),
      ...(String(message?.threatId || "").trim()
        ? { threatId: String(message.threatId).trim() }
        : {}),
    },
  };
}

export async function fetchOrefCityMap({ fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  return buildOrefCityMap(
    await fetchOrefCityCatalog({
      fetchImpl,
      timeoutMs,
    }),
  );
}

export async function fetchOrefCityCatalog({ fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  return fetchJson(OREF_CITIES_URL, {
    fetchImpl,
    headers: OREF_HEADERS,
    timeoutMs,
  });
}

export async function registerOrefMqttDevice({
  fetchImpl = fetch,
  apiUrl = OREF_MQTT_PUSHY_API_URL,
  appId = OREF_MQTT_APP_ID,
  platform = OREF_MQTT_PLATFORM,
  sdk = OREF_MQTT_SDK,
  androidId = buildOrefMqttAndroidId(),
  timeoutMs = 15_000,
} = {}) {
  const normalizedAndroidId = normalizeOrefMqttAndroidId(androidId) || buildOrefMqttAndroidId();
  const response = await fetchJson(`${apiUrl}/register`, {
    fetchImpl,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: buildOrefMqttPushyDevicePayload({
      appId,
      platform,
      sdk,
      androidId: normalizedAndroidId,
      includeAndroidId: true,
    }),
    timeoutMs,
  });

  const token = String(response?.token || "").trim();
  const auth = String(response?.auth || "").trim();
  if (!token || !auth) {
    throw new Error("pushy registration response missing token/auth");
  }

  return { token, auth, androidId: normalizedAndroidId };
}

export async function validateOrefMqttCredentials({
  token = "",
  auth = "",
  androidId = "",
  fetchImpl = fetch,
  apiUrl = OREF_MQTT_PUSHY_API_URL,
  appId = OREF_MQTT_APP_ID,
  platform = OREF_MQTT_PLATFORM,
  sdk = OREF_MQTT_SDK,
  timeoutMs = 15_000,
} = {}) {
  const includeAndroidDevicePayload = Boolean(normalizeOrefMqttAndroidId(androidId));
  try {
    const response = await fetchJson(`${apiUrl}/devices/auth`, {
      fetchImpl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        ...(includeAndroidDevicePayload
          ? buildOrefMqttPushyDevicePayload({
            appId,
            platform,
            sdk,
            androidId,
            includeAndroidId: true,
          })
          : {}),
        token,
        auth,
      },
      timeoutMs,
    });
    return {
      valid: Boolean(response?.success),
      validationStatus: "ok",
      response,
    };
  } catch (err) {
    if (Number(err?.status) === 403) {
      return {
        valid: true,
        validationStatus: "forbidden",
        error: err.message,
      };
    }

    return {
      valid: false,
      validationStatus: "invalid",
      error: err.message,
    };
  }
}

export async function subscribeOrefMqttTopics({
  token = "",
  auth = "",
  topics = OREF_MQTT_DEFAULT_TOPICS,
  fetchImpl = fetch,
  apiUrl = OREF_MQTT_PUSHY_API_URL,
  timeoutMs = 15_000,
} = {}) {
  return fetchJson(`${apiUrl}/devices/subscribe`, {
    fetchImpl,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      token,
      auth,
      topics: normalizeTopicList(topics),
    },
    timeoutMs,
  });
}

export function buildOrefMqttBrokerUrl(timestampSeconds = Math.floor(Date.now() / 1000)) {
  return `mqtts://mqtt-${timestampSeconds}.ioref.io:443`;
}

function defaultMqttConnect(url, options) {
  return mqtt.connect(url, options);
}

export class OrefMqttStream {
  constructor({
    logger = console,
    mqttConnect = defaultMqttConnect,
    reconnectDelayMs = 5000,
    rotateIntervalMs = OREF_MQTT_DEFAULT_ROTATE_INTERVAL_MS,
    keepaliveSeconds = 300,
    brokerUrlFactory = buildOrefMqttBrokerUrl,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    cityIdToName = new Map(),
    queueAlerts = true,
    token = "",
    auth = "",
    onRawMessage = null,
    onAlert = null,
    onParseError = null,
    onConnectionStateChange = null,
  } = {}) {
    this.logger = logger;
    this.mqttConnect = mqttConnect;
    this.reconnectDelayMs = reconnectDelayMs;
    this.rotateIntervalMs = Number(rotateIntervalMs) > 0 ? Number(rotateIntervalMs) : 0;
    this.keepaliveSeconds = keepaliveSeconds;
    this.brokerUrlFactory = brokerUrlFactory;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.cityIdToName = cityIdToName;
    this.queueAlerts = Boolean(queueAlerts);
    this.token = String(token || "").trim();
    this.auth = String(auth || "").trim();
    this.onRawMessage = onRawMessage;
    this.onAlert = onAlert;
    this.onParseError = onParseError;
    this.onConnectionStateChange = onConnectionStateChange;
    this.client = null;
    this.queue = [];
    this.started = false;
    this.connected = false;
    this.receivedCount = 0;
    this.parsedCount = 0;
    this.alertCount = 0;
    this.parseErrorCount = 0;
    this.lastMessageAt = null;
    this.lastParsedAt = null;
    this.lastAlertAt = null;
    this.lastParseErrorAt = null;
    this.lastParseError = null;
    this.lastConnectionErrorAt = null;
    this.lastConnectionError = null;
    this.lastTopic = null;
    this.brokerUrl = null;
    this.rotationTimer = null;
  }

  setCredentials({ token = "", auth = "" } = {}) {
    this.token = String(token || "").trim();
    this.auth = String(auth || "").trim();
  }

  setCityMap(cityIdToName) {
    this.cityIdToName = cityIdToName;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop() {
    this.started = false;
    this.connected = false;
    this.clearRotationTimer();
    this.client?.end(true);
    this.client = null;
  }

  setAlertHandler(onAlert = null, { queueAlerts = this.queueAlerts } = {}) {
    this.onAlert = onAlert;
    this.queueAlerts = Boolean(queueAlerts);
    if (!this.queueAlerts) {
      this.queue = [];
    }
  }

  drain() {
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  status() {
    return {
      connected: this.connected,
      queued: this.queue.length,
      brokerUrl: this.brokerUrl,
      lastTopic: this.lastTopic,
      receivedCount: this.receivedCount,
      parsedCount: this.parsedCount,
      alertCount: this.alertCount,
      parseErrorCount: this.parseErrorCount,
      lastMessageAt: this.lastMessageAt,
      lastParsedAt: this.lastParsedAt,
      lastAlertAt: this.lastAlertAt,
      lastParseErrorAt: this.lastParseErrorAt,
      lastParseError: this.lastParseError,
      lastConnectionErrorAt: this.lastConnectionErrorAt,
      lastConnectionError: this.lastConnectionError,
    };
  }

  notifyConnectionStateChange() {
    this.onConnectionStateChange?.(this.status());
  }

  clearRotationTimer() {
    if (!this.rotationTimer) return;
    this.clearTimeoutImpl(this.rotationTimer);
    this.rotationTimer = null;
  }

  scheduleRotation() {
    this.clearRotationTimer();
    if (!this.rotateIntervalMs || !this.started) return;
    this.rotationTimer = this.setTimeoutImpl(() => {
      this.rotationTimer = null;
      this.rotateBroker();
    }, this.rotateIntervalMs);
  }

  rotateBroker() {
    if (!this.started || !this.client) return;
    const oldClient = this.client;
    this.logger.log("Rotating oref mqtt broker");
    this.clearRotationTimer();
    this.client = null;
    this.connect();
    const newClient = this.client;
    if (newClient) {
      const teardown = () => {
        if (oldClient) oldClient.end(true);
      };
      newClient.once("connect", teardown);
      newClient.once("error", teardown);
    } else {
      oldClient.end(true);
      this.connected = false;
      this.notifyConnectionStateChange();
    }
  }

  connect() {
    if (!this.started || !this.token || !this.auth) return;

    this.brokerUrl = this.brokerUrlFactory(Math.floor(Date.now() / 1000));
    const client = this.mqttConnect(this.brokerUrl, {
      clientId: this.token,
      username: this.token,
      password: this.auth,
      clean: false,
      keepalive: this.keepaliveSeconds,
      protocolVersion: 4,
      rejectUnauthorized: true,
      reconnectPeriod: this.reconnectDelayMs,
    });
    this.client = client;

    client.on("connect", () => {
      if (this.client !== client) return;
      this.connected = true;
      this.lastConnectionError = null;
      this.logger.log("Connected to oref mqtt broker");
      client.subscribe(this.token, { qos: 1 }, (err) => {
        if (this.client !== client) return;
        if (err) {
          this.lastConnectionErrorAt = new Date().toISOString();
          this.lastConnectionError = err.message;
          this.logger.error(`Oref mqtt subscribe failed: ${err.message}`);
          this.notifyConnectionStateChange();
          return;
        }

        this.scheduleRotation();
        this.notifyConnectionStateChange();
      });
    });

    client.on("message", (topic, payload) => {
      if (this.client !== client) return;
      const now = new Date().toISOString();
      const raw = payload.toString("utf8").trim();
      if (!raw) return;
      this.receivedCount += 1;
      this.lastMessageAt = now;
      this.lastTopic = String(topic || "").trim() || null;
      this.onRawMessage?.({
        source: SOURCE_CHANNELS.OREF_MQTT,
        topic,
        raw,
        receivedAt: now,
      });

      try {
        const message = JSON.parse(raw);
        this.parsedCount += 1;
        this.lastParsedAt = now;
        const alert = normalizeOrefMqttMessage(message, this.cityIdToName);
        if (!alert) return;

        const queuedAlert = {
          ...alert,
          receivedAt: now,
        };
        if (this.queueAlerts) {
          this.queue.push(queuedAlert);
        }
        this.alertCount += 1;
        this.lastAlertAt = now;
        this.onAlert?.(queuedAlert);
      } catch (err) {
        this.parseErrorCount += 1;
        this.lastParseErrorAt = now;
        this.lastParseError = err.message;
        this.onParseError?.({
          source: SOURCE_CHANNELS.OREF_MQTT,
          topic,
          raw,
          error: err.message,
          receivedAt: now,
        });
        this.logger.error(`Oref mqtt message parse failed: ${err.message}`);
      }
    });

    client.on("reconnect", () => {
      if (this.client !== client) return;
      this.connected = false;
      this.clearRotationTimer();
      this.logger.log("Reconnecting to oref mqtt broker");
      this.notifyConnectionStateChange();
    });

    client.on("close", () => {
      if (this.client !== client) return;
      this.connected = false;
      this.clearRotationTimer();
      this.notifyConnectionStateChange();
    });

    client.on("error", (err) => {
      if (this.client !== client) return;
      this.lastConnectionErrorAt = new Date().toISOString();
      this.lastConnectionError = err.message;
      this.clearRotationTimer();
      this.logger.error(`Oref mqtt broker error: ${err.message}`);
      this.notifyConnectionStateChange();
    });
  }
}
