import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DebugCaptureStore,
  captureEntriesBySource,
  createDebugCaptureStores,
  listDebugCaptureEntries,
  parseBooleanEnv,
  summarizeDebugCaptureStores,
} from "./debug-capture.js";

describe("parseBooleanEnv", () => {
  it("parses truthy values", () => {
    assert.equal(parseBooleanEnv("true"), true);
    assert.equal(parseBooleanEnv("1"), true);
  });

  it("parses falsy values", () => {
    assert.equal(parseBooleanEnv("false"), false);
    assert.equal(parseBooleanEnv(""), false);
  });
});

describe("DebugCaptureStore", () => {
  it("dedupes identical entries and increments count", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-capture-"));
    const store = new DebugCaptureStore({
      enabled: true,
      filePath: join(dir, "capture.json"),
      ttlHours: 24,
      maxEntries: 10,
    });

    store.capture({
      source: "oref_alerts",
      eventType: "active_alert",
      matchedLocations: ["תל אביב - יפו"],
      payload: { id: "1", title: "ירי רקטות וטילים" },
    });
    store.capture({
      source: "oref_alerts",
      eventType: "active_alert",
      matchedLocations: ["תל אביב - יפו"],
      payload: { id: "1", title: "ירי רקטות וטילים" },
    });

    const entries = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].count, 2);
  });

  it("captures many entries and filters by kind/source", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-capture-"));
    const store = new DebugCaptureStore({
      enabled: true,
      filePath: join(dir, "capture.json"),
      ttlHours: 24,
      maxEntries: 10,
    });

    store.captureMany([
      {
        kind: "upstream_alert",
        source: "oref_alerts",
        eventType: "all_clear",
        payload: { id: "1" },
      },
      {
        kind: "ws_raw",
        source: "tzevaadom",
        payload: "{\"type\":\"PING\"}",
      },
    ]);

    assert.equal(store.list({ kind: "ws_raw" }).length, 1);
    assert.equal(store.list({ source: "oref_alerts" }).length, 1);
    assert.equal(store.status().byKind.upstream_alert, 1);
    assert.equal(store.status().byKind.ws_raw, 1);
  });

  it("prunes expired entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-capture-"));
    const store = new DebugCaptureStore({
      enabled: true,
      filePath: join(dir, "capture.json"),
      ttlHours: 24,
      maxEntries: 10,
    });

    store.entries = [
      {
        fingerprint: "old",
        count: 1,
        firstSeenAt: "2026-03-08T00:00:00.000Z",
        lastSeenAt: "2026-03-08T00:00:00.000Z",
        kind: "matched_alert",
        source: "oref_history",
        eventType: "all_clear",
        matchedLocations: ["תל אביב - יפו"],
        payload: { id: "1" },
      },
    ];
    store.prune("2026-03-10T12:00:00.000Z");

    assert.deepEqual(store.list(), []);
  });

  it("keeps entries forever when ttlHours is 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-capture-"));
    const store = new DebugCaptureStore({
      enabled: true,
      filePath: join(dir, "capture.json"),
      ttlHours: 0,
      maxEntries: 10,
    });

    store.entries = [
      {
        fingerprint: "old",
        count: 1,
        firstSeenAt: "2026-03-08T00:00:00.000Z",
        lastSeenAt: "2026-03-08T00:00:00.000Z",
        kind: "oref_raw",
        source: "oref_alerts",
        eventType: "",
        matchedLocations: ["תל אביב - יפו"],
        payload: { id: "1" },
      },
    ];
    store.prune("2026-03-12T12:00:00.000Z");

    assert.equal(store.list().length, 1);
    assert.equal(store.status().ttlDisabled, true);
  });

  it("dedupes identical raw history rows even when key order differs", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-capture-"));
    const store = new DebugCaptureStore({
      enabled: true,
      filePath: join(dir, "capture.json"),
      ttlHours: 0,
      maxEntries: 10,
    });

    store.capture({
      kind: "oref_raw",
      source: "oref_history2",
      matchedLocations: ["תל אביב - יפו"],
      payload: {
        rid: 463421,
        alertDate: "2026-03-12T06:45:00",
        category: 13,
        category_desc: "האירוע הסתיים",
        data: "תל אביב - יפו",
      },
    });
    store.capture({
      kind: "oref_raw",
      source: "oref_history2",
      matchedLocations: ["תל אביב - יפו"],
      payload: {
        data: "תל אביב - יפו",
        category_desc: "האירוע הסתיים",
        category: 13,
        alertDate: "2026-03-12T06:45:00",
        rid: 463421,
      },
    });

    const entries = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].count, 2);
  });

  it("appends duplicate raw entries when touchDuplicates is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-capture-"));
    const store = new DebugCaptureStore({
      enabled: true,
      filePath: join(dir, "capture.json"),
      ttlHours: 0,
      maxEntries: 10,
    });

    store.captureMany(
      [
        {
          kind: "oref_raw",
          source: "oref_history2",
          matchedLocations: ["תל אביב - יפו"],
          payload: { rid: 1, data: "תל אביב - יפו" },
        },
      ],
      { touchDuplicates: false },
    );

    const first = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));

    store.captureMany(
      [
        {
          kind: "oref_raw",
          source: "oref_history2",
          matchedLocations: ["תל אביב - יפו"],
          payload: { rid: 1, data: "תל אביב - יפו" },
        },
      ],
      { touchDuplicates: false },
    );

    const second = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
    assert.deepEqual(
      second.map((entry) => entry.payload),
      [{ rid: 1, data: "תל אביב - יפו" }, { rid: 1, data: "תל אביב - יפו" }],
    );
    assert.deepEqual(second.map((entry) => entry.count), [1, 1]);
  });

  it("dedupes persisted entries after reloading from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-capture-"));
    const filePath = join(dir, "capture.json");
    const entry = {
      kind: "oref_raw",
      source: "oref_history",
      matchedLocations: ["תל אביב - יפו"],
      payload: { rid: 1, data: "תל אביב - יפו" },
    };

    new DebugCaptureStore({
      enabled: true,
      filePath,
      ttlHours: 0,
      maxEntries: 10,
    }).captureMany([entry]);

    const reloaded = new DebugCaptureStore({
      enabled: true,
      filePath,
      ttlHours: 0,
      maxEntries: 10,
    });
    reloaded.captureMany([entry]);

    const entries = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].count, 2);
  });

  it("drops trimmed fingerprints from the duplicate index", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-capture-"));
    const filePath = join(dir, "capture.json");
    const store = new DebugCaptureStore({
      enabled: true,
      filePath,
      ttlHours: 0,
      maxEntries: 1,
    });

    store.captureMany(
      [
        {
          kind: "oref_raw",
          source: "oref_history",
          matchedLocations: ["תל אביב - יפו"],
          payload: { rid: 1, data: "תל אביב - יפו" },
        },
      ],
      { touchDuplicates: true },
    );
    store.captureMany(
      [
        {
          kind: "oref_raw",
          source: "oref_history",
          matchedLocations: ["תל אביב - יפו"],
          payload: { rid: 2, data: "תל אביב - יפו" },
        },
      ],
      { touchDuplicates: true },
    );
    store.captureMany(
      [
        {
          kind: "oref_raw",
          source: "oref_history",
          matchedLocations: ["תל אביב - יפו"],
          payload: { rid: 1, data: "תל אביב - יפו" },
        },
      ],
      { touchDuplicates: true },
    );

    const entries = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].payload.rid, 1);
  });

  it("splits captures across source-specific files and aggregates status", () => {
    const dir = mkdtempSync(join(tmpdir(), "debug-capture-"));
    const stores = createDebugCaptureStores({
      enabled: true,
      dirPath: dir,
      ttlHours: 0,
      maxEntries: 10,
      sources: ["oref_alerts", "oref_history"],
    });

    captureEntriesBySource(stores, [
      {
        kind: "oref_raw",
        source: "oref_alerts",
        matchedLocations: ["תל אביב - יפו"],
        payload: { id: "1" },
      },
      {
        kind: "oref_raw",
        source: "oref_history",
        matchedLocations: ["חיפה"],
        payload: { id: "2" },
      },
    ]);

    assert.equal(listDebugCaptureEntries(stores, { source: "oref_alerts" }).length, 1);
    assert.equal(listDebugCaptureEntries(stores, {}).length, 2);

    const status = summarizeDebugCaptureStores(stores);
    assert.equal(status.entries, 2);
    assert.equal(status.byKind.oref_raw, 2);
    assert.equal(status.bySource.oref_alerts.entries, 1);
    assert.equal(status.bySource.oref_history.entries, 1);
  });
});
