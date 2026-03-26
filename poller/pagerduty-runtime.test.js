import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPagerDutyRuntime } from "./pagerduty-runtime.js";
import {
  collectStaleNotifierTransports,
  getOutboxBacklogAgeMs,
  hasExceededThreshold,
  hasNotifierTransport,
  hasOutboxBacklogExceededThreshold,
} from "./pagerduty.js";

function createPagerDutyStub() {
  const calls = [];
  return {
    enabled: true,
    calls,
    async triggerIncident(payload) {
      calls.push({ kind: "trigger", payload });
    },
    async resolveIncident(payload) {
      calls.push({ kind: "resolve", payload });
    },
  };
}

function createRuntime(now = Date.parse("2026-03-18T21:02:00.000Z"), overrides = {}) {
  const pagerDuty = createPagerDutyStub();
  const monitor = {
    sourceFailures: {},
    consecutivePollErrors: 0,
    lastPollErrorAt: null,
    lastPollError: null,
    dbDisconnectedSince: null,
    dbDatabaseName: "red_alerts",
    outboxLastCheckedAt: null,
    outboxLastError: null,
    ...(overrides.monitor || {}),
  };
  const runtime = createPagerDutyRuntime({
    pagerDuty,
    monitor,
    dbPool: {},
    notificationOutbox: {
      async getStats() {
        return {
          pending: 0,
          processing: 0,
          sent: 0,
          failed: 0,
          uncertain: 0,
          deadLettered: 0,
          oldestAvailableAt: null,
        };
      },
    },
    runtimeStartedAt: now,
    logger: { warn() {}, info() {}, log() {} },
    configuredNotifierTransports: ["telegram"],
    activeSourceNames: ["oref_alerts", "oref_history", "tzevaadom"],
    toIsoString(timestampMs = Date.now()) {
      return new Date(timestampMs).toISOString();
    },
    formatDisconnectedSince(timestampMs) {
      return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
    },
    getSourceFailureSnapshot() {
      return { ...monitor.sourceFailures };
    },
    getNotifierStateSnapshot() {
      return {
        telegramLastCheckedAt: null,
        telegramLastError: null,
      };
    },
    resolveActiveEvolutionInstance: async () => ({}),
    evolutionInstance: "test",
    checkDbConnection: async (_, checkNow) => ({
      checkedAt: new Date(checkNow).toISOString(),
      latencyMs: 2,
      databaseName: "red_alerts",
      serverTime: new Date(checkNow).toISOString(),
    }),
    hasExceededThreshold,
    getOutboxBacklogAgeMs,
    hasOutboxBacklogExceededThreshold,
    collectStaleNotifierTransports,
    hasNotifierTransport,
    whatsappDisconnectThresholdMs: 120_000,
    sourceFailureThreshold: 6,
    pollErrorThreshold: 3,
    dbDisconnectThresholdMs: 30_000,
    outboxBacklogThresholdMs: 60_000,
    notifierStaleThresholdMs: 45_000,
    tzevaadomDisconnectThresholdMs: 300_000,
  });

  return { pagerDuty, runtime };
}

describe("createPagerDutyRuntime", () => {
  it("suppresses notifier-stale during startup grace", async () => {
    const startedAt = Date.parse("2026-03-18T21:02:00.000Z");
    const { pagerDuty, runtime } = createRuntime(startedAt);

    await runtime.syncPagerDutyHealth(startedAt + 10_000);

    const notifierCalls = pagerDuty.calls.filter((call) => call.payload.dedupKey === "notifier-stale");
    assert.deepEqual(notifierCalls, [
      {
        kind: "resolve",
        payload: { dedupKey: "notifier-stale" },
      },
    ]);
  });

  it("triggers notifier-stale after startup grace expires", async () => {
    const startedAt = Date.parse("2026-03-18T21:02:00.000Z");
    const { pagerDuty, runtime } = createRuntime(startedAt);

    await runtime.syncPagerDutyHealth(startedAt + 46_000);

    const notifierCalls = pagerDuty.calls.filter((call) => call.payload.dedupKey === "notifier-stale");
    assert.equal(notifierCalls.length, 1);
    assert.equal(notifierCalls[0].kind, "trigger");
    assert.equal(notifierCalls[0].payload.summary, "Notifier worker health checks are stale");
  });

  it("triggers source outage when all monitored sources are failing", async () => {
    const { pagerDuty, runtime } = createRuntime(undefined, {
      monitor: {
        sourceFailures: {
          oref_alerts: { consecutiveFailures: 6, lastError: "timeout" },
          oref_history: { consecutiveFailures: 7, lastError: "timeout" },
          tzevaadom: { consecutiveFailures: 6, lastError: "websocket disconnected" },
        },
      },
    });

    await runtime.syncPagerDutyHealth();

    const sourceCalls = pagerDuty.calls.filter((call) => call.payload.dedupKey === "oref-sources-unavailable");
    assert.equal(sourceCalls.length, 1);
    assert.equal(sourceCalls[0].kind, "trigger");
    assert.equal(sourceCalls[0].payload.summary, "All alert sources are failing");
  });

  it("triggers tzevaadom disconnect after the configured threshold", async () => {
    const disconnectedAt = "2026-03-18T21:00:00.000Z";
    const now = Date.parse("2026-03-18T21:05:01.000Z");
    const { pagerDuty, runtime } = createRuntime(now, {
      monitor: {
        sourceFailures: {
          oref_alerts: { consecutiveFailures: 0, lastError: null, disconnectedSince: null },
          oref_history: { consecutiveFailures: 0, lastError: null, disconnectedSince: null },
          tzevaadom: {
            consecutiveFailures: 12,
            lastFailureAt: "2026-03-18T21:05:00.000Z",
            lastError: "websocket disconnected",
            disconnectedSince: disconnectedAt,
          },
        },
      },
    });

    await runtime.syncPagerDutyHealth(now);

    const calls = pagerDuty.calls.filter((call) => call.payload.dedupKey === "tzevaadom-disconnected");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "trigger");
    assert.equal(calls[0].payload.summary, "Tzevaadom stream is disconnected");
    assert.equal(calls[0].payload.severity, "warning");
  });

  it("resolves tzevaadom disconnect before the threshold", async () => {
    const disconnectedAt = "2026-03-18T21:04:30.000Z";
    const now = Date.parse("2026-03-18T21:05:00.000Z");
    const { pagerDuty, runtime } = createRuntime(now, {
      monitor: {
        sourceFailures: {
          oref_alerts: { consecutiveFailures: 0, lastError: null, disconnectedSince: null },
          oref_history: { consecutiveFailures: 0, lastError: null, disconnectedSince: null },
          tzevaadom: {
            consecutiveFailures: 2,
            lastFailureAt: "2026-03-18T21:04:59.000Z",
            lastError: "websocket disconnected",
            disconnectedSince: disconnectedAt,
          },
        },
      },
    });

    await runtime.syncPagerDutyHealth(now);

    const calls = pagerDuty.calls.filter((call) => call.payload.dedupKey === "tzevaadom-disconnected");
    assert.deepEqual(calls, [
      {
        kind: "resolve",
        payload: { dedupKey: "tzevaadom-disconnected" },
      },
    ]);
  });
});
