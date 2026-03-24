import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function parseBooleanEnv(value = "") {
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}

export class DebugCaptureStore {
  constructor({
    enabled = false,
    filePath,
    ttlHours = 24,
    maxEntries = 1000,
    logger = console,
  } = {}) {
    this.enabled = enabled;
    this.filePath = filePath;
    this.ttlHours = ttlHours;
    this.maxEntries = maxEntries;
    this.logger = logger;
    this.entries = this.loadEntries();
    this.prune();
  }

  get entries() {
    return this._entries || [];
  }

  set entries(entries) {
    this._entries = Array.isArray(entries) ? entries : [];
    this.entryIndex = new Map(
      this._entries
        .filter((entry) => typeof entry?.fingerprint === "string" && entry.fingerprint)
        .map((entry) => [entry.fingerprint, entry]),
    );
  }

  status() {
    this.prune();
    const byKind = this.entries.reduce((counts, entry) => {
      counts[entry.kind] = (counts[entry.kind] || 0) + 1;
      return counts;
    }, {});
    return {
      enabled: this.enabled,
      ttlHours: this.ttlHours,
      ttlDisabled: !this.hasFiniteTtl(),
      entries: this.entries.length,
      filePath: this.filePath,
      byKind,
    };
  }

  list({ limit = 100, kind = "", source = "" } = {}) {
    this.prune();
    return this.entries
      .filter((entry) => {
        if (kind && entry.kind !== kind) return false;
        if (source && entry.source !== source) return false;
        return true;
      })
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, Math.max(0, limit));
  }

  capture(entry = {}, options = {}) {
    const fingerprints = this.captureMany([entry], options);
    return fingerprints[0] || null;
  }

  captureMany(entries = [], { touchDuplicates = true } = {}) {
    if (!this.enabled) return [];

    const now = new Date().toISOString();
    this.prune(now);
    const fingerprints = [];
    let changed = false;

    for (const entry of entries) {
      const normalizedEntry = {
        kind: entry?.kind || "matched_alert",
        source: String(entry?.source || "unknown"),
        eventType: String(entry?.eventType || ""),
        matchedLocations: [...(entry?.matchedLocations || [])]
          .map((location) => String(location).trim())
          .filter(Boolean)
          .sort(),
        payload: sortJsonValue(entry?.payload ?? {}),
      };
      const fingerprint = createHash("sha1")
        .update(JSON.stringify(normalizedEntry))
        .digest("hex");
      fingerprints.push(fingerprint);

      if (!touchDuplicates) {
        this.entries.push({
          ...normalizedEntry,
          fingerprint,
          count: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        changed = true;
        continue;
      }

      const existing = this.entryIndex.get(fingerprint);
      if (existing) {
        existing.lastSeenAt = now;
        existing.count += 1;
        changed = true;
        continue;
      }

      const created = {
        ...normalizedEntry,
        fingerprint,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      this.entries.push(created);
      this.entryIndex.set(fingerprint, created);
      changed = true;
    }

    if (this.entries.length > this.maxEntries) {
      if (touchDuplicates) {
        this.entries = [...this.entries]
          .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))
          .slice(-this.maxEntries);
      } else {
        this.entries = this.entries.slice(-this.maxEntries);
      }
    }

    if (changed) this.persist();
    return fingerprints;
  }

  loadEntries() {
    if (!this.enabled || !this.filePath) return [];

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err?.code !== "ENOENT") {
        this.logger.warn?.(`Could not load debug capture store ${this.filePath}: ${err.message}`);
      }
      return [];
    }
  }

  prune(now = new Date().toISOString()) {
    if (!this.enabled) return;
    if (!this.hasFiniteTtl()) return;

    const cutoffMs = Date.parse(now) - this.ttlHours * 60 * 60 * 1000;
    const nextEntries = this.entries.filter((entry) => Date.parse(entry.lastSeenAt) >= cutoffMs);
    if (nextEntries.length !== this.entries.length) {
      this.entries = nextEntries;
      this.persist();
    }
  }

  hasFiniteTtl() {
    return Number.isFinite(this.ttlHours) && this.ttlHours > 0;
  }

  persist() {
    if (!this.enabled || !this.filePath) return;

    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf8");
  }
}

export function createDebugCaptureStores({
  enabled = false,
  dirPath,
  ttlHours = 24,
  maxEntries = 1000,
  sources = [],
  logger = console,
} = {}) {
  return Object.fromEntries(
    [...new Set(sources.map((source) => String(source).trim()).filter(Boolean))].map((source) => [
      source,
      new DebugCaptureStore({
        enabled,
        filePath: join(dirPath, `${source}.json`),
        ttlHours,
        maxEntries,
        logger,
      }),
    ]),
  );
}

export function captureEntriesBySource(stores = {}, entries = [], options = {}) {
  const groupedEntries = new Map();

  for (const entry of entries) {
    const source = String(entry?.source || "").trim();
    if (!source || !stores[source]) continue;
    if (!groupedEntries.has(source)) groupedEntries.set(source, []);
    groupedEntries.get(source).push(entry);
  }

  return [...groupedEntries.entries()].flatMap(([source, sourceEntries]) =>
    stores[source].captureMany(sourceEntries, options),
  );
}

export function listDebugCaptureEntries(
  stores = {},
  { limit = 100, kind = "", source = "" } = {},
) {
  if (source) {
    return stores[source]?.list({ limit, kind }) || [];
  }

  return Object.values(stores)
    .flatMap((store) => store.list({ limit: store.maxEntries, kind }))
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, Math.max(0, limit));
}

export function summarizeDebugCaptureStores(stores = {}) {
  const statuses = Object.entries(stores).map(([source, store]) => [source, store.status()]);
  const firstStatus = statuses[0]?.[1] || {
    enabled: false,
    ttlHours: null,
    ttlDisabled: false,
  };
  const byKind = {};
  const bySource = {};

  for (const [source, status] of statuses) {
    bySource[source] = {
      entries: status.entries,
      filePath: status.filePath,
      byKind: status.byKind,
    };
    for (const [kind, count] of Object.entries(status.byKind || {})) {
      byKind[kind] = (byKind[kind] || 0) + count;
    }
  }

  return {
    enabled: firstStatus.enabled,
    ttlHours: firstStatus.ttlHours,
    ttlDisabled: firstStatus.ttlDisabled,
    entries: statuses.reduce((sum, [, status]) => sum + status.entries, 0),
    byKind,
    bySource,
  };
}
