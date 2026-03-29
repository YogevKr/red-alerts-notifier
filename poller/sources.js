import { parseEventDate } from "./lib.js";

export const SOURCE_CHANNELS = {
  OREF_ALERTS: "oref_alerts",
  OREF_HISTORY: "oref_history",
  OREF_HISTORY2: "oref_history2",
  OREF_MQTT: "oref_mqtt",
  TZEVAADOM: "tzevaadom",
};

export const OREF_CURRENT_URL =
  "https://www.oref.org.il/WarningMessages/alert/alerts.json";
export const OREF_HISTORY_URL =
  "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json";
export const OREF_HISTORY2_URL =
  "https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1";
export const TZEVAADOM_WS_URL = "wss://ws.tzevaadom.co.il/socket?platform=WEB";
export const TZEVAADOM_CITIES_URL = "https://www.tzevaadom.co.il/static/cities.json";

const OREF_HEADERS = {
  Referer: "https://www.oref.org.il/",
  "X-Requested-With": "XMLHttpRequest",
  "Content-Type": "application/json",
};
const TZEVAADOM_ORIGIN = "https://www.tzevaadom.co.il";
const TZEVAADOM_PRE_ALERT = 0;
const TZEVAADOM_END = 1;
const TZEVAADOM_STAY_NEARBY = 2;
const TZEVAADOM_SYSTEM_PRE_ALERT_TITLE = "בדקות הקרובות צפויות להתקבל התרעות באזורך";
const TZEVAADOM_SYSTEM_STAY_NEARBY_TITLE = "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו";
const TZEVAADOM_SYSTEM_ALL_CLEAR_TITLE = "האירוע הסתיים";
const TZEVAADOM_THREAT_TITLES = {
  0: "ירי רקטות וטילים",
  1: "אירוע חומרים מסוכנים",
  2: "חדירת מחבלים",
  3: "רעידת אדמה",
  4: "חשש לצונאמי",
  5: "חדירת כלי טיס עוין",
  6: "חשש לאירוע רדיולוגי",
  7: "חשש לאירוע כימי",
  8: "התרעות פיקוד העורף",
};
const TZEVAADOM_THREAT_TO_CATEGORY = {
  0: 1,
  1: 12,
  2: 10,
  3: 7,
  4: 11,
  5: 2,
  6: 9,
  7: 3,
  8: 4,
};
function exactSystemMessageMatcher(field, values = []) {
  return { type: "exact", field, values };
}

function prefixSystemMessageMatcher(field, values = []) {
  return { type: "prefix", field, values };
}

const TZEVAADOM_SYSTEM_MESSAGE_RULES = [
  {
    classification: { key: "pre_alert", title: TZEVAADOM_SYSTEM_PRE_ALERT_TITLE, cat: 14 },
    instructionType: TZEVAADOM_PRE_ALERT,
    anyOf: [
      exactSystemMessageMatcher("instructionReadingDescName", ["11"]),
      exactSystemMessageMatcher("titleHe", ["מבזק פיקוד העורף - התרעה מקדימה"]),
      exactSystemMessageMatcher("titleEn", ["Home Front Command - Early Warning"]),
      prefixSystemMessageMatcher("bodyHe", ["בעקבות זיהוי שיגורים", "בדקות הקרובות צפויות להתקבל התרעות"]),
      prefixSystemMessageMatcher("bodyEn", ["Due to the detection of missile launches"]),
    ],
  },
  {
    classification: { key: "all_clear", title: TZEVAADOM_SYSTEM_ALL_CLEAR_TITLE, cat: 13 },
    instructionType: TZEVAADOM_END,
    anyOf: [
      exactSystemMessageMatcher("instructionReadingDescName", ["9"]),
      exactSystemMessageMatcher("titleHe", ["עדכון פיקוד העורף - סיום אירוע"]),
      exactSystemMessageMatcher("titleEn", ["Home Front Command - Incident Ended"]),
      prefixSystemMessageMatcher("bodyHe", ["האירוע הסתיים"]),
      prefixSystemMessageMatcher("bodyEn", ["The incident ended"]),
    ],
  },
  {
    classification: { key: "stay_nearby_update", title: TZEVAADOM_SYSTEM_STAY_NEARBY_TITLE, cat: 13 },
    instructionType: TZEVAADOM_END,
    anyOf: [
      exactSystemMessageMatcher("instructionReadingDescName", ["15"]),
      exactSystemMessageMatcher("titleHe", ["עדכון פיקוד העורף - יציאה מהמרחב המוגן"]),
      exactSystemMessageMatcher("titleEn", ["Home Front Command - Leaving the protected space", "Leaving the protected space"]),
      prefixSystemMessageMatcher("bodyHe", ["ניתן לצאת אך יש להישאר בקרבת המרחב המוגן"]),
      prefixSystemMessageMatcher("bodyEn", ["You can exit but stay close to the protected space"]),
    ],
  },
  {
    classification: { key: "all_clear", title: TZEVAADOM_SYSTEM_ALL_CLEAR_TITLE, cat: 13 },
    instructionType: TZEVAADOM_END,
    anyOf: [
      exactSystemMessageMatcher("instructionReadingDescName", ["6"]),
      exactSystemMessageMatcher("titleHe", ["עדכון פיקוד העורף - סיום שהייה בסמוך למרחב מוגן"]),
      exactSystemMessageMatcher("titleEn", ["Home Front Command - End of stay near protected space"]),
      prefixSystemMessageMatcher("bodyHe", ["האירוע הסתיים", "אין צורך לשהות יותר בסמיכות למרחב המוגן"]),
    ],
  },
  {
    classification: { key: "stay_nearby_update", title: TZEVAADOM_SYSTEM_STAY_NEARBY_TITLE, cat: 13 },
    instructionType: TZEVAADOM_STAY_NEARBY,
    anyOf: [
      exactSystemMessageMatcher("instructionReadingDescName", ["5"]),
      exactSystemMessageMatcher("titleHe", ["מבזק פיקוד העורף - שהייה בסמיכות למרחב מוגן"]),
      exactSystemMessageMatcher("titleEn", ["Home Front Command - Staying near protected space", "Staying near protected space"]),
      prefixSystemMessageMatcher("bodyHe", ["שהו בסמוך למרחב מוגן"]),
      prefixSystemMessageMatcher("bodyEn", ["Stay close to the protected space"]),
    ],
  },
  {
    classification: { key: "all_clear", title: TZEVAADOM_SYSTEM_ALL_CLEAR_TITLE, cat: 13 },
    instructionType: TZEVAADOM_STAY_NEARBY,
    anyOf: [
      exactSystemMessageMatcher("titleHe", ["מבזק פיקוד העורף"]),
      exactSystemMessageMatcher("titleEn", ["Home Front Command"]),
      prefixSystemMessageMatcher("bodyHe", ["האירוע הסתיים"]),
    ],
  },
];

function normalizeAreas(input) {
  if (Array.isArray(input)) {
    return input
      .map((value) => String(value).trim())
      .filter(Boolean);
  }
  if (typeof input === "string" && input.trim()) {
    return [input.trim()];
  }
  return [];
}

function normalizeAlert({
  id,
  source,
  alertDate,
  title,
  cat,
  data,
  desc = "",
  dedupeAt = null,
  sourceEventAt = null,
  sourceMessageId = null,
  sourceMessageType = null,
  sourceMeta = {},
}) {
  return {
    id: String(id),
    source,
    alertDate,
    title: title || "",
    cat: String(cat),
    data: normalizeAreas(data),
    desc,
    ...(dedupeAt ? { dedupeAt } : {}),
    ...(sourceEventAt ? { sourceEventAt } : {}),
    ...(sourceMessageId ? { sourceMessageId: String(sourceMessageId) } : {}),
    ...(sourceMessageType ? { sourceMessageType: String(sourceMessageType) } : {}),
    ...(
      sourceMeta && typeof sourceMeta === "object" && !Array.isArray(sourceMeta)
      && Object.keys(sourceMeta).length > 0
        ? { sourceMeta }
        : {}
    ),
  };
}

function parseJsonBody(text) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function stableAlertId(source, alertDate, category, areaOrAreas) {
  const normalizedAreas = normalizeAreas(areaOrAreas).sort().join("|");
  return `${source}:${alertDate}:${category}:${normalizedAreas}`;
}

function normalizePayloadAlertDate(alertDate) {
  const normalizedAlertDate = String(alertDate || "").trim();
  if (!normalizedAlertDate) {
    return {
      alertDate: "",
      dedupeAt: null,
      sourceEventAt: null,
    };
  }

  const parsedAlertDate = parseEventDate(normalizedAlertDate);
  return {
    alertDate: formatTimestamp(parsedAlertDate.getTime()),
    dedupeAt: parsedAlertDate.toISOString(),
    sourceEventAt: parsedAlertDate.toISOString(),
  };
}

export function normalizeWebsiteCurrentAlerts(payload) {
  const records =
    Array.isArray(payload) ? payload : payload && typeof payload === "object" ? [payload] : [];

  return records
    .map((record) => {
      const data = normalizeAreas(record?.data);
      const alertDate = record?.alertDate || formatWindowsFiletime(record?.id);
      if (!record?.id || !record?.title || !record?.cat || !alertDate || data.length === 0) {
        return null;
      }

      return normalizeAlert({
        id: record.id,
        source: SOURCE_CHANNELS.OREF_ALERTS,
        alertDate,
        title: record.title,
        cat: record.cat,
        data,
        desc: record?.desc || "",
      });
    })
    .filter(Boolean);
}

function extractRawRecords(payload) {
  if (Array.isArray(payload)) return payload.filter((record) => record && typeof record === "object");
  if (payload && typeof payload === "object") return [payload];
  return [];
}

function mapRawRecords(records = []) {
  return records.map((record) => ({
    payload: record,
    matchedLocations: normalizeAreas(record?.data),
  }));
}

export function extractWebsiteCurrentRawRecords(payload) {
  return mapRawRecords(extractRawRecords(payload));
}

export function normalizeWebsiteHistoryAlerts(payload) {
  if (!Array.isArray(payload)) return [];

  return payload
    .map((record) => {
      const data = normalizeAreas(record?.data);
      const { alertDate, dedupeAt, sourceEventAt } = normalizePayloadAlertDate(record?.alertDate);
      if (!alertDate || !record?.title || !record?.category || data.length === 0) {
        return null;
      }

      return normalizeAlert({
        id: stableAlertId(
          SOURCE_CHANNELS.OREF_HISTORY,
          alertDate,
          record.category,
          data,
        ),
        source: SOURCE_CHANNELS.OREF_HISTORY,
        alertDate,
        title: record.title,
        cat: record.category,
        data,
        dedupeAt,
        sourceEventAt,
      });
    })
    .filter(Boolean);
}

export function extractWebsiteHistoryRawRecords(payload) {
  return mapRawRecords(extractRawRecords(payload));
}

export function normalizeHistory2Alerts(payload) {
  if (!Array.isArray(payload)) return [];

  return payload
    .map((record) => {
      const data = normalizeAreas(record?.data);
      if (!record?.alertDate || !record?.category || !record?.category_desc || data.length === 0) {
        return null;
      }

      const alertDate = String(record.alertDate).replace("T", " ");
      return normalizeAlert({
        id: record.rid || stableAlertId(SOURCE_CHANNELS.OREF_HISTORY2, alertDate, record.category, data),
        source: SOURCE_CHANNELS.OREF_HISTORY2,
        alertDate,
        title: record.category_desc,
        cat: record.category,
        data,
      });
    })
    .filter(Boolean);
}

export function extractHistory2RawRecords(payload) {
  return mapRawRecords(extractRawRecords(payload));
}

export function buildTzevaadomCityMap(payload = {}) {
  return new Map(
    Object.values(payload?.cities || {}).flatMap((city) =>
      city?.id && city?.he ? [[Number(city.id), city.he]] : [],
    ),
  );
}

function normalizeObservedString(value = "") {
  return String(value || "").trim();
}

function matchesObservedValue(value, candidates = []) {
  const normalizedValue = normalizeObservedString(value);
  return normalizedValue && candidates.includes(normalizedValue);
}

function startsWithObservedPrefix(value, prefixes = []) {
  const normalizedValue = normalizeObservedString(value);
  return normalizedValue && prefixes.some((prefix) => normalizedValue.startsWith(prefix));
}

function matchesTzevaadomSystemMessageMatcher(data = {}, matcher = {}) {
  if (!matcher?.field) return false;
  if (matcher.type === "exact") {
    return matchesObservedValue(data?.[matcher.field], matcher.values || []);
  }
  if (matcher.type === "prefix") {
    return startsWithObservedPrefix(data?.[matcher.field], matcher.values || []);
  }
  return false;
}

function matchesTzevaadomSystemMessageRule(data = {}, rule = {}) {
  const instructionType = Number(data?.instructionType);
  if (Number.isFinite(instructionType) && instructionType !== rule.instructionType) return false;
  return Array.isArray(rule.anyOf) && rule.anyOf.some((matcher) =>
    matchesTzevaadomSystemMessageMatcher(data, matcher));
}

export function classifyTzevaadomSystemMessage(data = {}) {
  for (const rule of TZEVAADOM_SYSTEM_MESSAGE_RULES) {
    if (!matchesTzevaadomSystemMessageRule(data, rule)) continue;
    return {
      key: rule.classification.key,
      title: rule.classification.title,
      cat: String(rule.classification.cat),
    };
  }

  return null;
}

export function normalizeTzevaadomMessage(message = {}, cityIdToName = new Map()) {
  if (!message?.type || !message?.data) return null;

  if (message.type === "ALERT") {
    if (message.data.isDrill) return null;

    const threatId = Number(message.data.threat);
    const category = TZEVAADOM_THREAT_TO_CATEGORY[threatId];
    const title = TZEVAADOM_THREAT_TITLES[threatId];
    const data = normalizeAreas(message.data.cities);

    if (!category || !title || data.length === 0) return null;

    return normalizeAlert({
      id: `${SOURCE_CHANNELS.TZEVAADOM}:alert:${message.data.notificationId}`,
      source: SOURCE_CHANNELS.TZEVAADOM,
      alertDate: formatUnixTimestamp(message.data.time),
      title,
      cat: category,
      data,
      sourceMessageId: message.data.notificationId,
      sourceMessageType: message.type,
      sourceMeta: {
        ...(Number.isFinite(threatId)
          ? { threat: threatId }
          : (String(message.data.threat || "").trim()
            ? { threat: String(message.data.threat).trim() }
            : {})),
      },
    });
  }

  if (message.type === "SYSTEM_MESSAGE") {
    const data = normalizeAreas(
      message.data.cities ||
        (Array.isArray(message.data.citiesIds)
          ? message.data.citiesIds.map((cityId) => cityIdToName.get(Number(cityId)))
          : []),
    );
    if (data.length === 0) return null;

    const classification = classifyTzevaadomSystemMessage(message.data);
    if (!classification) return null;

    return normalizeAlert({
      id: `${SOURCE_CHANNELS.TZEVAADOM}:system:${message.data.notificationId}`,
      source: SOURCE_CHANNELS.TZEVAADOM,
      alertDate: formatUnixTimestamp(message.data.time),
      title: classification.title,
      cat: classification.cat,
      data,
      sourceMessageId: message.data.notificationId,
      sourceMessageType: message.type,
      sourceMeta: {
        ...(Number.isFinite(Number(message.data.instructionType))
          ? { instructionType: Number(message.data.instructionType) }
          : {}),
        ...(String(message.data.instructionReadingDescName || "").trim()
          ? { instructionReadingDescName: String(message.data.instructionReadingDescName).trim() }
          : {}),
      },
    });
  }

  return null;
}

function formatWindowsFiletime(filetime) {
  try {
    const windowsTicks = BigInt(String(filetime));
    const unixMs = Number((windowsTicks - 116444736000000000n) / 10000n);
    return formatTimestamp(unixMs);
  } catch {
    return "";
  }
}

function formatUnixTimestamp(unixSeconds) {
  return formatTimestamp(Number(unixSeconds) * 1000);
}

function formatTimestamp(timestampMs) {
  return parseEventDate(timestampMs)
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


export function sortAlertsByDate(alerts) {
  return [...alerts].sort(
    (left, right) => parseEventDate(left.alertDate).getTime() - parseEventDate(right.alertDate).getTime(),
  );
}

export async function fetchSourceAlerts(url, normalizer, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const res = await fetchImpl(url, {
    headers: OREF_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return normalizer(parseJsonBody(await res.text()));
}

export async function fetchSourceSnapshot(
  url,
  {
    normalizer,
    rawExtractor = () => [],
    fetchImpl = fetch,
    timeoutMs = 5000,
  } = {},
) {
  const res = await fetchImpl(url, {
    headers: OREF_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }

  const payload = parseJsonBody(await res.text());
  return {
    alerts: normalizer(payload),
    rawRecords: rawExtractor(payload),
  };
}

export async function fetchTzevaadomCityMap({ fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const res = await fetchImpl(TZEVAADOM_CITIES_URL, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${TZEVAADOM_CITIES_URL} responded ${res.status}`);
  }
  return buildTzevaadomCityMap(parseJsonBody(await res.text()));
}

function defaultWebSocketFactory(url, options) {
  return new WebSocket(url, options);
}

function parseWsData(data) {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return "";
}

export class TzevaadomStream {
  constructor({
    logger = console,
    webSocketFactory = defaultWebSocketFactory,
    reconnectDelayMs = 5000,
    cityIdToName = new Map(),
    queueAlerts = true,
    onRawMessage = null,
    onAlert = null,
    onParseError = null,
    onConnectionStateChange = null,
  } = {}) {
    this.logger = logger;
    this.webSocketFactory = webSocketFactory;
    this.reconnectDelayMs = reconnectDelayMs;
    this.ws = null;
    this.queue = [];
    this.started = false;
    this.connected = false;
    this.reconnectTimer = null;
    this.cityIdToName = cityIdToName;
    this.queueAlerts = Boolean(queueAlerts);
    this.onRawMessage = onRawMessage;
    this.onAlert = onAlert;
    this.onParseError = onParseError;
    this.onConnectionStateChange = onConnectionStateChange;
    this.receivedCount = 0;
    this.parsedCount = 0;
    this.alertCount = 0;
    this.parseErrorCount = 0;
    this.lastMessageAt = null;
    this.lastParsedAt = null;
    this.lastAlertAt = null;
    this.lastParseErrorAt = null;
    this.lastParseError = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop() {
    this.started = false;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  drain() {
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  setAlertHandler(onAlert = null, { queueAlerts = this.queueAlerts } = {}) {
    this.onAlert = onAlert;
    this.queueAlerts = Boolean(queueAlerts);
    if (!this.queueAlerts) {
      this.queue = [];
    }
  }

  status() {
    return {
      connected: this.connected,
      queued: this.queue.length,
      receivedCount: this.receivedCount,
      parsedCount: this.parsedCount,
      alertCount: this.alertCount,
      parseErrorCount: this.parseErrorCount,
      lastMessageAt: this.lastMessageAt,
      lastParsedAt: this.lastParsedAt,
      lastAlertAt: this.lastAlertAt,
      lastParseErrorAt: this.lastParseErrorAt,
      lastParseError: this.lastParseError,
    };
  }

  notifyConnectionStateChange() {
    this.onConnectionStateChange?.(this.status());
  }

  connect() {
    if (!this.started) return;

    try {
      const ws = this.webSocketFactory(TZEVAADOM_WS_URL, {
        headers: {
          Origin: TZEVAADOM_ORIGIN,
        },
      });
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.logger.log("Connected to tzevaadom websocket");
        this.notifyConnectionStateChange();
      };

      ws.onmessage = (event) => {
        const now = new Date().toISOString();
        const raw = parseWsData(event.data).trim();
        if (!raw) return;
        this.receivedCount += 1;
        this.lastMessageAt = now;
        this.onRawMessage?.({
          source: SOURCE_CHANNELS.TZEVAADOM,
          raw,
          receivedAt: now,
        });

        try {
          const message = JSON.parse(raw);
          this.parsedCount += 1;
          this.lastParsedAt = now;
          const alert = normalizeTzevaadomMessage(
            message,
            this.cityIdToName,
          );
          if (alert) {
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
          }
        } catch (err) {
          this.parseErrorCount += 1;
          this.lastParseErrorAt = now;
          this.lastParseError = err.message;
          this.onParseError?.({
            source: SOURCE_CHANNELS.TZEVAADOM,
            raw,
            error: err.message,
            receivedAt: now,
          });
          this.logger.error(`Tzevaadom message parse failed: ${err.message}`);
        }
      };

      ws.onerror = (event) => {
        const message = event?.error?.message || event?.message || "unknown error";
        this.logger.error(`Tzevaadom websocket error: ${message}`);
      };

      ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        this.notifyConnectionStateChange();
        if (!this.started || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, this.reconnectDelayMs);
      };
    } catch (err) {
      this.logger.error(`Tzevaadom websocket connect failed: ${err.message}`);
      this.notifyConnectionStateChange();
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, this.reconnectDelayMs);
      }
    }
  }

  setCityMap(cityIdToName) {
    this.cityIdToName = cityIdToName;
  }
}
