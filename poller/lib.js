import { createHash } from "node:crypto";
import { MESSAGE_TEMPLATES } from "./message-templates.js";

export function parseLocations(csv) {
  return csv.split(",").map((l) => l.trim());
}

export const EVENT_TYPES = {
  PRE_ALERT: "pre_alert",
  ACTIVE_ALERT: "active_alert",
  DRONE_ALERT: "drone_alert",
  EARTHQUAKE_ALERT: "earthquake_alert",
  GENERAL_ALERT: "general_alert",
  STAY_NEARBY_UPDATE: "stay_nearby_update",
  ALL_CLEAR: "all_clear",
  UNKNOWN: "unknown",
};

export const EVENT_TIMEZONE = "Asia/Jerusalem";

const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const ENGLISH_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DELIVERY_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const CLASSIFIER = MESSAGE_TEMPLATES.classifier;
const WHATSAPP = MESSAGE_TEMPLATES.whatsapp;
const PRE_ALERT_TITLES = new Set([CLASSIFIER.preAlert.upcomingAlertsRawTitle]);
const STAY_NEARBY_UPDATE_TITLES = new Set(CLASSIFIER.stayNearbyUpdate.rawTitles);
const ALL_CLEAR_TITLES = new Set(CLASSIFIER.allClear.rawTitles);
const ROCKET_ACTIVE_TITLES = new Set([CLASSIFIER.activeAlert.rocketRawTitle]);
const DRONE_ALERT_TITLES = new Set([CLASSIFIER.droneAlert.rawTitle]);
const EARTHQUAKE_ALERT_TITLES = new Set([CLASSIFIER.earthquakeAlert.rawTitle]);

const JERUSALEM_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: EVENT_TIMEZONE,
  weekday: "short",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const JERUSALEM_STATUS_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  timeZone: EVENT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const JERUSALEM_OFFSET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: EVENT_TIMEZONE,
  timeZoneName: "shortOffset",
});

export function buildEvolutionHeaders(apiKey = "") {
  return {
    "Content-Type": "application/json",
    ...(apiKey && { apikey: apiKey }),
  };
}

export function shouldFallbackToText(status, body = "") {
  const message = String(body).toLowerCase();
  return (
    status === 404 ||
    message.includes("available only in plus version") ||
    message.includes("not found")
  );
}

export function resolveChatId({ targets = "", chatId = "", number = "" } = {}) {
  return resolveChatIds({ targets, chatId, number })[0];
}

export function parseChatTargets(targets = "") {
  return String(targets)
    .split(",")
    .map((target) => normalizeChatTarget(target.trim()))
    .filter(Boolean);
}

export function resolveChatIds({ targets = "", chatId = "", number = "" } = {}) {
  const parsedTargets = parseChatTargets(targets);
  if (parsedTargets.length > 0) return [...new Set(parsedTargets)];

  const uniqueTargets = [...new Set(
    [chatId || number].map((target) => normalizeChatTarget(target)).filter(Boolean),
  )];
  return uniqueTargets;
}

export function resolveTargetChatId(payload = {}, fallbackChatId) {
  return resolveTargetChatIds(payload, [fallbackChatId])[0];
}

export function resolveTargetChatIds(payload = {}, fallbackChatIds = []) {
  const payloadTargets = Array.isArray(payload.targets)
    ? payload.targets
    : parseChatTargets(payload.targets || "");
  const explicitTargets = [
    ...payloadTargets.map((target) => normalizeChatTarget(target)).filter(Boolean),
    ...[payload.chatId, payload.target, payload.number]
      .map((target) => normalizeChatTarget(target))
      .filter(Boolean),
  ];
  if (explicitTargets.length > 0) return [...new Set(explicitTargets)];
  return [...new Set(fallbackChatIds.map((target) => normalizeChatTarget(target)).filter(Boolean))];
}

function isTruthySimulationFlag(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "on", "true", "yes"].includes(normalized);
}

export function resolveSimulationTargets(
  payload = {},
  fallbackChatIds = [],
  testFallbackChatIds = [],
) {
  const explicitTargets = resolveTargetChatIds(payload, []);
  if (explicitTargets.length > 0) {
    return { chatIds: explicitTargets, targetMode: "explicit" };
  }

  if (isTruthySimulationFlag(payload.useTestTarget ?? payload.testTarget)) {
    const chatIds = [...new Set(
      testFallbackChatIds.map((target) => normalizeChatTarget(target)).filter(Boolean),
    )];
    if (chatIds.length === 0) {
      throw new Error("TEST_NOTIFICATION_TARGETS or WHATSAPP_NUMBER is required when useTestTarget is true");
    }
    return { chatIds, targetMode: "test" };
  }

  return {
    chatIds: [...new Set(fallbackChatIds.map((target) => normalizeChatTarget(target)).filter(Boolean))],
    targetMode: "default",
  };
}

export function normalizeChatTarget(target = "") {
  if (!target) return "";
  if (target.endsWith("@c.us")) return target.slice(0, -5);
  return target;
}

export function getConnectionState(payload = {}) {
  return payload?.instance?.state ?? payload?.state ?? null;
}

export function getInstances(payload = {}) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.response)) return payload.response;
  if (Array.isArray(payload?.instances)) return payload.instances;
  if (payload?.instance) return [payload.instance];
  return [];
}

export function chooseEvolutionInstance({
  primaryInstance = "",
  primaryState = null,
  fallbackInstance = "",
  fallbackState = null,
} = {}) {
  const normalizedPrimaryState = String(primaryState || "").toLowerCase();
  const normalizedFallbackState = String(fallbackState || "").toLowerCase();

  if (normalizedPrimaryState === "open") {
    return {
      instanceName: primaryInstance,
      usedFallback: false,
      connectionState: primaryState,
    };
  }

  if (fallbackInstance && normalizedFallbackState === "open") {
    return {
      instanceName: fallbackInstance,
      usedFallback: true,
      connectionState: fallbackState,
    };
  }

  return {
    instanceName: primaryInstance,
    usedFallback: false,
    connectionState: primaryState,
  };
}

export function resolveMediaAssetFilename(baseName, availableFiles = []) {
  const filesByLowerName = new Map(
    availableFiles.map((filename) => [String(filename).toLowerCase(), filename]),
  );

  for (const extension of [".jpeg", ".jpg", ".png"]) {
    const filename = filesByLowerName.get(`${baseName}${extension}`);
    if (filename) return filename;
  }

  throw new Error(`No supported media asset found for ${baseName}`);
}

export function getMediaAssetMimeType(filename = "") {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith(".jpeg") || lower.endsWith(".jpg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  throw new Error(`Unsupported media asset type for ${filename}`);
}

export function getConfiguredMediaBaseNames(messageTemplates = MESSAGE_TEMPLATES.whatsapp) {
  return [...new Set(
    Object.values(messageTemplates)
      .map((config) => String(config?.mediaBaseName || "").trim())
      .filter(Boolean),
  )];
}

export function resolveEventType(eventType = "") {
  if (Object.values(EVENT_TYPES).includes(eventType)) return eventType;
  return EVENT_TYPES.UNKNOWN;
}

export function detectEventType(alert = {}) {
  const title = String(alert.title || "").trim();

  if (PRE_ALERT_TITLES.has(title)) {
    return EVENT_TYPES.PRE_ALERT;
  }

  if (STAY_NEARBY_UPDATE_TITLES.has(title)) {
    return EVENT_TYPES.STAY_NEARBY_UPDATE;
  }

  if (ALL_CLEAR_TITLES.has(title)) {
    return EVENT_TYPES.ALL_CLEAR;
  }

  if (ROCKET_ACTIVE_TITLES.has(title)) {
    return EVENT_TYPES.ACTIVE_ALERT;
  }

  if (DRONE_ALERT_TITLES.has(title)) {
    return EVENT_TYPES.DRONE_ALERT;
  }

  if (EARTHQUAKE_ALERT_TITLES.has(title)) {
    return EVENT_TYPES.EARTHQUAKE_ALERT;
  }

  if (title) {
    return EVENT_TYPES.GENERAL_ALERT;
  }

  return EVENT_TYPES.UNKNOWN;
}

export function isDeliverableEventType(eventType = "") {
  return [
    EVENT_TYPES.PRE_ALERT,
    EVENT_TYPES.ACTIVE_ALERT,
    EVENT_TYPES.DRONE_ALERT,
    EVENT_TYPES.EARTHQUAKE_ALERT,
    EVENT_TYPES.GENERAL_ALERT,
    EVENT_TYPES.STAY_NEARBY_UPDATE,
    EVENT_TYPES.ALL_CLEAR,
  ].includes(eventType);
}

export function isExplicitlySupportedAlert(alert = {}, eventType = detectEventType(alert)) {
  const resolvedEventType = resolveEventType(eventType);
  return isDeliverableEventType(resolvedEventType);
}

export function parseEventDate(dateLike) {
  if (!dateLike) return new Date();
  if (dateLike instanceof Date) return new Date(dateLike);

  if (typeof dateLike === "string") {
    const jerusalemDate = parseJerusalemLocalDate(dateLike);
    if (jerusalemDate) return jerusalemDate;
  }

  const normalized =
    typeof dateLike === "string" && /^\d{4}-\d{2}-\d{2} /.test(dateLike)
      ? dateLike.replace(" ", "T")
      : dateLike;

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function parseJerusalemLocalDate(dateLike) {
  const match = String(dateLike).match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!match) return null;

  const [, year, month, day, hours = "00", minutes = "00", seconds = "00"] = match;
  const utcGuess = Date.UTC(+year, +month - 1, +day, +hours, +minutes, +seconds);
  let offsetMs = getJerusalemOffsetMs(utcGuess);
  let timestampMs = utcGuess - offsetMs;
  const adjustedOffsetMs = getJerusalemOffsetMs(timestampMs);
  if (adjustedOffsetMs !== offsetMs) {
    offsetMs = adjustedOffsetMs;
    timestampMs = utcGuess - offsetMs;
  }

  return new Date(timestampMs);
}

function getJerusalemOffsetMs(timestampMs) {
  const offsetLabel = JERUSALEM_OFFSET_FORMATTER.formatToParts(new Date(timestampMs)).find(
    ({ type }) => type === "timeZoneName",
  )?.value;
  const match = offsetLabel?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 0;

  const [, sign, hours, minutes = "00"] = match;
  const totalMinutes = Number(hours) * 60 + Number(minutes);
  return (sign === "-" ? -1 : 1) * totalMinutes * 60 * 1000;
}

function parseJerusalemLocalTimestamp(dateLike) {
  if (typeof dateLike !== "string") return null;
  const match = dateLike.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!match) return null;

  const [, year, month, day, hours = "00", minutes = "00"] = match;
  const weekday = WEEKDAYS[new Date(Date.UTC(+year, +month - 1, +day, 12, 0, 0)).getUTCDay()];

  return {
    weekday,
    day: String(+day),
    month: String(+month),
    year,
    hours: String(+hours).padStart(2, "0"),
    minutes: String(+minutes).padStart(2, "0"),
  };
}

export function formatEventTimestamp(dateLike) {
  const localTimestamp = parseJerusalemLocalTimestamp(dateLike);
  if (localTimestamp) {
    return `${localTimestamp.weekday} | ${localTimestamp.day}.${localTimestamp.month}.${localTimestamp.year} | שעה ${localTimestamp.hours}:${localTimestamp.minutes}`;
  }

  const date = parseEventDate(dateLike);
  const parts = Object.fromEntries(
    JERUSALEM_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  const weekday = WEEKDAYS[ENGLISH_WEEKDAYS.indexOf(parts.weekday)];
  const day = String(+parts.day);
  const month = String(+parts.month);
  const year = parts.year;
  const hours = parts.hour;
  const minutes = parts.minute;

  return `${weekday} | ${day}.${month}.${year} | שעה ${hours}:${minutes}`;
}

export function formatStatusTimestamp(dateLike) {
  const raw = String(dateLike || "").trim();
  if (!raw) return "unknown";

  const date = parseEventDate(raw);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return raw;
  }

  return JERUSALEM_STATUS_FORMATTER.format(date);
}

export function alertKey(alert) {
  return `${alert.id}:${alert.cat}`;
}

export function buildDeliveryKey(alert, matched = [], options = {}) {
  const eventType = resolveEventType(options.eventType || detectEventType(alert));
  const key = {
    chatId: options.chatId || "",
    eventType,
    body: resolveMessageBody(alert, { eventType }),
    locations: [...matched]
      .map((location) => location.trim())
      .filter(Boolean)
      .sort(),
  };

  return JSON.stringify(key);
}

export function buildSemanticAlertKey(alert, matched = [], options = {}) {
  return hashDeliveryKey(buildDeliveryKey(alert, matched, {
    ...options,
    chatId: "__semantic__",
  }));
}

export function hashDeliveryKey(key) {
  return createHash("sha256").update(String(key)).digest("hex");
}

export function shouldSuppressDuplicateDelivery(
  lastDeliveredAt,
  now = Date.now(),
  duplicateWindowMs = DELIVERY_DUPLICATE_WINDOW_MS,
) {
  if (!Number.isFinite(lastDeliveredAt) || lastDeliveredAt <= 0) return false;
  if (!Number.isFinite(now)) return false;
  return now - lastDeliveredAt < duplicateWindowMs;
}

export function matchLocations(alert, locations) {
  if (!alert) return [];

  const alertLocations = Array.isArray(alert.data)
    ? alert.data
    : typeof alert.data === "string" && alert.data.trim()
      ? [alert.data.trim()]
      : [];

  return alertLocations.filter((loc) => locations.includes(loc));
}

export function formatMessage(alert, matched = [], options = {}) {
  const eventType = resolveEventType(options.eventType || detectEventType(alert));
  if (!isDeliverableEventType(eventType)) {
    throw new Error(`Unknown event type: ${eventType}`);
  }
  const timestamp = formatEventTimestamp(options.timestamp || alert.alertDate);
  const locationLabel = [...matched]
    .map((location) => location.trim())
    .filter(Boolean)
    .join(", ");
  const updateLine = locationLabel
    ? `\n\n*הודעת עדכון מצח"י ${locationLabel}:*`
    : `\n\n*הודעת עדכון מצח"י:*`;

  return `${timestamp}${updateLine}\n\n${formatBoldBody(resolveMessageBody(alert, { eventType }))}`;
}

export function resolveMessageMediaBaseName(alert = {}, eventType = detectEventType(alert)) {
  const resolvedEventType = resolveEventType(eventType);
  if (resolvedEventType === EVENT_TYPES.PRE_ALERT) {
    return WHATSAPP.preAlert.mediaBaseName;
  }

  if (resolvedEventType === EVENT_TYPES.STAY_NEARBY_UPDATE) {
    return WHATSAPP.stayNearbyUpdate.mediaBaseName;
  }

  if (resolvedEventType === EVENT_TYPES.ALL_CLEAR) {
    return WHATSAPP.allClear.mediaBaseName;
  }

  if (resolvedEventType === EVENT_TYPES.ACTIVE_ALERT && isRocketActiveAlert(alert)) {
    return WHATSAPP.activeAlert.mediaBaseName;
  }

  if (resolvedEventType === EVENT_TYPES.DRONE_ALERT) {
    return WHATSAPP.droneAlert.mediaBaseName;
  }

  if (resolvedEventType === EVENT_TYPES.EARTHQUAKE_ALERT) {
    return WHATSAPP.earthquakeAlert.mediaBaseName;
  }

  return WHATSAPP.generalAlert.mediaBaseName;
}

function resolvePreAlertBody(alert = {}) {
  const title = String(alert.title || "").trim();
  if (title === CLASSIFIER.preAlert.upcomingAlertsRawTitle) {
    return WHATSAPP.preAlert.upcomingAlertsTemplate;
  }

  return WHATSAPP.preAlert.defaultTemplate;
}

function resolveActiveAlertBody(alert = {}) {
  if (isRocketActiveAlert(alert)) {
    return WHATSAPP.activeAlert.rocketTemplate;
  }

  return (
    (WHATSAPP.generalAlert.useRawTitleAsTemplate && alert.title?.trim()) ||
    WHATSAPP.generalAlert.fallbackTemplate
  );
}

function resolveDroneAlertBody(alert = {}) {
  return WHATSAPP.droneAlert.template;
}

function resolveEarthquakeAlertBody() {
  return WHATSAPP.earthquakeAlert.template;
}

function resolveStayNearbyUpdateBody() {
  return WHATSAPP.stayNearbyUpdate.template;
}

function resolveAllClearBody() {
  return WHATSAPP.allClear.template;
}

function formatBoldBody(body = "") {
  return String(body)
    .split("\n\n")
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => `*${line}*`)
        .join("\n"),
    )
    .join("\n\n");
}

export function resolveMessageBody(alert = {}, options = {}) {
  const eventType = resolveEventType(options.eventType || detectEventType(alert));

  if (eventType === EVENT_TYPES.PRE_ALERT) {
    return resolvePreAlertBody(alert);
  }

  if (eventType === EVENT_TYPES.STAY_NEARBY_UPDATE) {
    return resolveStayNearbyUpdateBody();
  }

  if (eventType === EVENT_TYPES.ALL_CLEAR) {
    return resolveAllClearBody();
  }

  if (eventType === EVENT_TYPES.DRONE_ALERT) {
    return resolveDroneAlertBody(alert);
  }

  if (eventType === EVENT_TYPES.EARTHQUAKE_ALERT) {
    return resolveEarthquakeAlertBody();
  }

  if (
    eventType === EVENT_TYPES.ACTIVE_ALERT ||
    eventType === EVENT_TYPES.GENERAL_ALERT
  ) {
    return resolveActiveAlertBody(alert);
  }

  throw new Error(`Unknown event type: ${eventType}`);
}

function isRocketActiveAlert(alert = {}) {
  return ROCKET_ACTIVE_TITLES.has(String(alert.title || "").trim());
}

export function parseAlertBody(text) {
  if (!text || !text.trim()) return null;
  return JSON.parse(text);
}

export function parseJsonObject(text) {
  if (!text || !text.trim()) return {};

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("JSON body must be an object");
  }

  return parsed;
}
