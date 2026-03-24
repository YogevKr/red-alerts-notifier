import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DELIVERY_DUPLICATE_WINDOW_MS, shouldSuppressDuplicateDelivery } from "./lib.js";

export class DeliveryDedupeGate {
  constructor({
    filePath,
    duplicateWindowMs = DELIVERY_DUPLICATE_WINDOW_MS,
    ttlMs = 30 * 24 * 60 * 60 * 1000,
    maxEntries = 10000,
    label = "delivery dedupe store",
  } = {}) {
    this.filePath = filePath;
    this.duplicateWindowMs = duplicateWindowMs;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.label = label;
    this.entries = this.loadEntries();
    this.inFlight = new Set();
  }

  get size() {
    return this.entries.size;
  }

  get inFlightSize() {
    return this.inFlight.size;
  }

  loadEntries() {
    if (!this.filePath) return new Map();

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      const loaded = new Map();
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        const key = typeof entry?.key === "string" ? entry.key : "";
        if (!key) continue;

        const deliveredAt =
          typeof entry.lastDeliveredAt === "number"
            ? entry.lastDeliveredAt
            : Date.parse(entry.lastDeliveredAt || "");
        loaded.set(key, Number.isFinite(deliveredAt) ? deliveredAt : 0);
      }
      return loaded;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`Could not load ${this.label} ${this.filePath}: ${err.message}`);
      }
      return new Map();
    }
  }

  persist() {
    if (!this.filePath) return;

    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify(
        [...this.entries.entries()]
          .sort((left, right) => left[1] - right[1])
          .map(([key, lastDeliveredAt]) => ({
            key,
            lastDeliveredAt: new Date(lastDeliveredAt).toISOString(),
          })),
      ),
      "utf8",
    );
  }

  prune(now = Date.now(), { persist = true } = {}) {
    let changed = false;
    for (const [key, lastDeliveredAt] of this.entries.entries()) {
      if (
        !Number.isFinite(lastDeliveredAt) ||
        lastDeliveredAt > now + 60 * 1000 ||
        now - lastDeliveredAt >= this.ttlMs
      ) {
        this.entries.delete(key);
        changed = true;
      }
    }

    if (changed && persist) this.persist();
  }

  trim() {
    if (this.entries.size <= this.maxEntries) return;

    const overflow = this.entries.size - this.maxEntries;
    const oldestKeys = [...this.entries.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(0, overflow)
      .map(([key]) => key);
    for (const key of oldestKeys) this.entries.delete(key);
  }

  shouldSuppress(key, now = Date.now()) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;

    this.prune(now);
    return (
      this.inFlight.has(normalizedKey) ||
      shouldSuppressDuplicateDelivery(
        this.entries.get(normalizedKey),
        now,
        this.duplicateWindowMs,
      )
    );
  }

  markInFlight(key) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;

    this.inFlight.add(normalizedKey);
    return true;
  }

  clearInFlight(key) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;

    return this.inFlight.delete(normalizedKey);
  }

  remember(key, deliveredAt = Date.now()) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;

    const normalizedDeliveredAt =
      Number.isFinite(deliveredAt) && deliveredAt > 0 ? deliveredAt : Date.now();
    this.prune(normalizedDeliveredAt, { persist: false });
    this.entries.set(normalizedKey, normalizedDeliveredAt);
    this.trim();
    this.persist();
    return true;
  }
}
