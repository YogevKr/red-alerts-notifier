import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
const DEPRECATED_PAGERDUTY_DEDUP_KEYS = new Set([
  "mqtt-credentials-blocked",
]);

export function parsePositiveIntEnv(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function hasExceededThreshold(startedAt, thresholdMs, now = Date.now()) {
  return Number.isFinite(startedAt) && thresholdMs >= 0 && now - startedAt >= thresholdMs;
}

function parseTimestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

export function getOutboxBacklogAgeMs(stats = {}, now = Date.now()) {
  const oldestAvailableAt = parseTimestampMs(stats?.oldestAvailableAt || stats?.oldest_available_at);
  if (!Number.isFinite(oldestAvailableAt)) return null;
  return Math.max(0, now - oldestAvailableAt);
}

export function hasOutboxBacklogExceededThreshold(stats = {}, thresholdMs, now = Date.now()) {
  const queued = Number(stats?.pending || 0) + Number(stats?.failed || 0);
  if (queued <= 0) return false;

  const backlogAgeMs = getOutboxBacklogAgeMs(stats, now);
  return Number.isFinite(backlogAgeMs) && backlogAgeMs >= thresholdMs;
}

export function collectStaleNotifierTransports(
  notifierState = {},
  transports = [],
  thresholdMs = 0,
  now = Date.now(),
) {
  const uniqueTransports = normalizeNotifierTransports(transports);

  return uniqueTransports.flatMap((transport) => {
    const lastCheckedAt = transport === "telegram"
      ? notifierState.telegramLastCheckedAt
      : notifierState.whatsappLastCheckedAt;
    const lastError = transport === "telegram"
      ? notifierState.telegramLastError
      : notifierState.whatsappLastError;
    const lastCheckedMs = parseTimestampMs(lastCheckedAt);
    const ageMs = Number.isFinite(lastCheckedMs) ? Math.max(0, now - lastCheckedMs) : null;

    if (Number.isFinite(lastCheckedMs) && ageMs < thresholdMs) {
      return [];
    }

    return [{
      transport,
      lastCheckedAt: lastCheckedAt || null,
      lastError: lastError || null,
      ageMs,
    }];
  });
}

export function normalizeNotifierTransports(transports = []) {
  return [...new Set(
    (Array.isArray(transports) ? transports : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  )];
}

export function hasNotifierTransport(transports = [], transport = "") {
  return normalizeNotifierTransports(transports).includes(
    String(transport || "").trim().toLowerCase(),
  );
}

export class PagerDutyIncidentManager {
  constructor({
    routingKey = "",
    eventsUrl = PAGERDUTY_EVENTS_URL,
    source = "red-alerts/poller",
    component = "poller",
    group = "red-alerts",
    className = "ops",
    filePath,
    fetchImpl = fetch,
    logger = console,
  } = {}) {
    this.routingKey = routingKey;
    this.eventsUrl = eventsUrl;
    this.source = source;
    this.component = component;
    this.group = group;
    this.className = className;
    this.filePath = filePath;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.state = this.loadState();
    this.pruneDeprecatedState();
  }

  get enabled() {
    return Boolean(this.routingKey);
  }

  status() {
    return {
      enabled: this.enabled,
      openIncidents: [...this.state.values()].filter((entry) => entry.status === "triggered").length,
      incidents: [...this.state.entries()].map(([dedupKey, entry]) => ({
        dedupKey,
        status: entry.status,
        lastEventAt: entry.lastEventAt,
      })),
    };
  }

  async triggerIncident(details = {}) {
    return this.setIncident({ ...details, active: true });
  }

  async resolveIncident(details = {}) {
    return this.setIncident({ ...details, active: false });
  }

  async setIncident({
    dedupKey,
    active,
    summary,
    severity = "critical",
    source = this.source,
    component = this.component,
    group = this.group,
    className = this.className,
    customDetails = {},
  } = {}) {
    if (!dedupKey) {
      throw new Error("dedupKey is required");
    }

    const desiredStatus = active ? "triggered" : "resolved";
    const currentStatus = this.state.get(dedupKey)?.status;
    if (!this.enabled) {
      return { skipped: true, reason: "disabled", dedupKey, status: desiredStatus };
    }
    if (currentStatus === desiredStatus) {
      return { skipped: true, reason: "unchanged", dedupKey, status: desiredStatus };
    }

    const payload = {
      routing_key: this.routingKey,
      event_action: active ? "trigger" : "resolve",
      dedup_key: dedupKey,
      client: "red-alerts-poller",
    };
    if (active) {
      payload.payload = {
        summary: summary || dedupKey,
        source,
        severity,
        component,
        group,
        class: className,
        custom_details: customDetails,
      };
    }

    const res = await this.fetchImpl(this.eventsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`pagerduty responded ${res.status}: ${await res.text()}`);
    }

    this.state.set(dedupKey, {
      status: desiredStatus,
      lastEventAt: new Date().toISOString(),
    });
    this.persist();
    this.logger.log?.(`PagerDuty ${payload.event_action} ${dedupKey}`);
    return { skipped: false, dedupKey, status: desiredStatus };
  }

  loadState() {
    if (!this.filePath) return new Map();

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      return new Map(
        (Array.isArray(parsed) ? parsed : [])
          .filter((entry) => typeof entry?.dedupKey === "string")
          .map((entry) => [
            entry.dedupKey,
            {
              status: entry.status === "resolved" ? "resolved" : "triggered",
              lastEventAt: entry.lastEventAt || null,
            },
          ]),
      );
    } catch (err) {
      if (err?.code !== "ENOENT") {
        this.logger.warn?.(`Could not load PagerDuty state ${this.filePath}: ${err.message}`);
      }
      return new Map();
    }
  }

  pruneDeprecatedState() {
    const deprecatedKeys = [...this.state.keys()].filter((dedupKey) => DEPRECATED_PAGERDUTY_DEDUP_KEYS.has(dedupKey));
    if (deprecatedKeys.length === 0) return;

    for (const dedupKey of deprecatedKeys) {
      this.state.delete(dedupKey);
    }

    this.persist();
    this.logger.log?.(`PagerDuty pruned deprecated incidents: ${deprecatedKeys.join(",")}`);
  }

  persist() {
    if (!this.filePath) return;

    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify(
        [...this.state.entries()].map(([dedupKey, entry]) => ({
          dedupKey,
          status: entry.status,
          lastEventAt: entry.lastEventAt,
        })),
      ),
      "utf8",
    );
  }
}
