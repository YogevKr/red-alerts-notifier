import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPollRuntime } from "./poll-runtime.js";

describe("createPollRuntime", () => {
  it("polls oref sources on their own intervals", async () => {
    const fetchCalls = [];
    const runtime = createPollRuntime({
      logger: { info() {}, error() {} },
      monitor: {
        sourceFailures: {
          oref_alerts: {
            consecutiveFailures: 0,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
          },
          oref_history: {
            consecutiveFailures: 0,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
          },
        },
      },
      suppressionReporter: { flushDue() {} },
      sourceConfigs: [
        {
          name: "oref_alerts",
          url: "https://example.test/alerts",
          normalizer: () => [],
          rawExtractor: () => [],
          pollIntervalMs: 1000,
        },
        {
          name: "oref_history",
          url: "https://example.test/history",
          normalizer: () => [],
          rawExtractor: () => [],
          pollIntervalMs: 5000,
        },
      ],
      collectRealtimeSourceResults: async () => ({}),
      sourceTimeoutMs: 5000,
      fetchSourceSnapshot: async (url) => {
        fetchCalls.push(url);
        return { alerts: [], rawRecords: [] };
      },
      sortAlertsByDate: (alerts) => alerts,
      captureEntriesBySource() {},
      debugCaptureStores: {},
      seedAlerts: async () => ({ seededDeliveries: 0, seededSourceAlerts: 0 }),
      ingestAlerts: async () => [],
      toIsoString: (ts = Date.now()) => new Date(ts).toISOString(),
      syncPagerDutyHealth: async () => {},
      summarizeSourceResults: (results) => results,
    });

    await runtime.fetchPolledAlertBatch({ nowMs: 0 });
    assert.deepEqual(fetchCalls, [
      "https://example.test/alerts",
      "https://example.test/history",
    ]);

    fetchCalls.length = 0;
    await runtime.fetchPolledAlertBatch({ nowMs: 1000 });
    assert.deepEqual(fetchCalls, [
      "https://example.test/alerts",
    ]);

    fetchCalls.length = 0;
    await runtime.fetchPolledAlertBatch({ nowMs: 5000 });
    assert.deepEqual(fetchCalls, [
      "https://example.test/alerts",
      "https://example.test/history",
    ]);
  });

  it("hands polled alerts to the shared ingest pipeline and merges realtime status", async () => {
    const ingested = [];
    const monitor = {
      sourceFailures: {
        oref_alerts: {
          consecutiveFailures: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastError: null,
        },
        tzevaadom: {
          consecutiveFailures: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastError: null,
        },
      },
      consecutivePollErrors: 0,
      lastPollSuccessAt: null,
      lastPollError: null,
    };
    const runtime = createPollRuntime({
      logger: { info() {}, error() {} },
      monitor,
      suppressionReporter: { flushDue() {} },
      sourceConfigs: [{
        name: "oref_alerts",
        url: "https://example.test/alerts",
        normalizer: () => [],
        rawExtractor: () => [],
      }],
      collectRealtimeSourceResults: async () => ({
        tzevaadom: {
          ok: true,
          error: null,
          count: 4,
          rawCount: 0,
        },
      }),
      sourceTimeoutMs: 5000,
      fetchSourceSnapshot: async () => ({
        alerts: [{
          id: "oref:1",
          source: "oref_alerts",
          alertDate: "2026-03-23 12:00:00",
        }],
        rawRecords: [{
          payload: { id: "oref:1" },
        }],
      }),
      sortAlertsByDate: (alerts) => alerts,
      captureEntriesBySource() {},
      debugCaptureStores: {},
      seedAlerts: async () => ({ seededDeliveries: 0, seededSourceAlerts: 0 }),
      ingestAlerts: async (alerts, options) => {
        ingested.push({ alerts, options });
        return [];
      },
      toIsoString: (ts = Date.now()) => new Date(ts).toISOString(),
      syncPagerDutyHealth: async () => {},
      summarizeSourceResults: (results) => results,
    });

    await runtime.poll();

    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].alerts[0].source, "oref_alerts");
    assert.equal(ingested[0].options.summary.polled_alert_count, 1);
    assert.deepEqual(ingested[0].options.summary.source_results, {
      oref_alerts: {
        ok: true,
        error: null,
        count: 1,
        rawCount: 1,
        durationMs: ingested[0].options.summary.source_results.oref_alerts.durationMs,
      },
      tzevaadom: {
        ok: true,
        error: null,
        count: 4,
        rawCount: 0,
      },
    });
    assert.equal(monitor.sourceFailures.tzevaadom.consecutiveFailures, 0);
  });

  it("delegates seedExistingAlerts to the shared alert seeding pipeline", async () => {
    const seedCalls = [];
    const runtime = createPollRuntime({
      logger: { info() {}, error() {} },
      monitor: { sourceFailures: {} },
      suppressionReporter: { flushDue() {} },
      sourceConfigs: [{
        name: "oref_alerts",
        url: "https://example.test/alerts",
      }],
      collectRealtimeSourceResults: async () => ({}),
      sourceTimeoutMs: 5000,
      fetchSourceSnapshot: async () => ({
        alerts: [{ id: "oref:1", source: "oref_alerts" }],
        rawRecords: [],
      }),
      sortAlertsByDate: (alerts) => alerts,
      captureEntriesBySource() {},
      debugCaptureStores: {},
      seedAlerts: async (alerts) => {
        seedCalls.push(alerts);
        return { seededDeliveries: 2, seededSourceAlerts: 1 };
      },
      ingestAlerts: async () => [],
      toIsoString: (ts = Date.now()) => new Date(ts).toISOString(),
      syncPagerDutyHealth: async () => {},
      summarizeSourceResults: (results) => results,
    });

    const seeded = await runtime.seedExistingAlerts();

    assert.equal(seedCalls.length, 1);
    assert.equal(seedCalls[0][0].source, "oref_alerts");
    assert.deepEqual(seeded, {
      seededDeliveries: 2,
      seededSourceAlerts: 1,
    });
  });

  it("tracks tzevaadom disconnects in source failure state", async () => {
    const monitor = {
      sourceFailures: {
        tzevaadom: {
          consecutiveFailures: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastError: null,
        },
      },
      consecutivePollErrors: 0,
      lastPollSuccessAt: null,
      lastPollError: null,
    };
    const runtime = createPollRuntime({
      logger: { info() {}, error() {} },
      monitor,
      suppressionReporter: { flushDue() {} },
      sourceConfigs: [],
      collectRealtimeSourceResults: async () => ({
        tzevaadom: {
          ok: false,
          error: "websocket disconnected",
          count: 0,
          rawCount: 0,
        },
      }),
      sourceTimeoutMs: 5000,
      fetchSourceSnapshot: async () => ({ alerts: [], rawRecords: [] }),
      sortAlertsByDate: (alerts) => alerts,
      captureEntriesBySource() {},
      debugCaptureStores: {},
      seedAlerts: async () => ({ seededDeliveries: 0, seededSourceAlerts: 0 }),
      ingestAlerts: async () => [],
      toIsoString: (ts = Date.now()) => new Date(ts).toISOString(),
      syncPagerDutyHealth: async () => {},
      summarizeSourceResults: (results) => results,
    });

    await runtime.poll();

    assert.equal(monitor.sourceFailures.tzevaadom.consecutiveFailures, 1);
    assert.equal(monitor.sourceFailures.tzevaadom.lastError, "websocket disconnected");
    assert.match(monitor.sourceFailures.tzevaadom.lastFailureAt, /^2026-/);
  });

  it("treats source-event pruning as non-fatal maintenance", async () => {
    const warnings = [];
    const pruneCalls = [];
    const monitor = {
      sourceFailures: {},
      consecutivePollErrors: 0,
      lastPollSuccessAt: null,
      lastPollError: null,
    };
    const runtime = createPollRuntime({
      logger: {
        info() {},
        error() {
          assert.fail("poll should not fail on prune errors");
        },
        warn(event, fields) {
          warnings.push({ event, fields });
        },
      },
      monitor,
      suppressionReporter: { flushDue() {} },
      sourceConfigs: [],
      collectRealtimeSourceResults: async () => ({}),
      sourceTimeoutMs: 5000,
      fetchSourceSnapshot: async () => ({ alerts: [], rawRecords: [] }),
      sortAlertsByDate: (alerts) => alerts,
      captureEntriesBySource() {},
      debugCaptureStores: {},
      seedAlerts: async () => ({ seededDeliveries: 0, seededSourceAlerts: 0 }),
      ingestAlerts: async () => [],
      pruneSourceEventLedger: async ({ nowMs }) => {
        pruneCalls.push(nowMs);
        throw new Error("delete failed");
      },
      toIsoString: (ts = Date.now()) => new Date(ts).toISOString(),
      syncPagerDutyHealth: async () => {},
      summarizeSourceResults: (results) => results,
    });

    await runtime.poll();

    assert.equal(pruneCalls.length, 1);
    assert.equal(monitor.consecutivePollErrors, 0);
    assert.match(monitor.lastPollSuccessAt, /^2026-/);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].event, "source_event_ledger_prune_failed");
  });
});
