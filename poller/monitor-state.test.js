import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applySourceHealthUpdate,
  buildMonitoredSourceChannels,
  createPollerMonitor,
  getSourceFailureSnapshot,
} from "./monitor-state.js";

describe("buildMonitoredSourceChannels", () => {
  it("prefers explicit active source lists", () => {
    assert.deepEqual(buildMonitoredSourceChannels({
      activeSources: ["oref_history", "tzevaadom"],
    }), [
      "oref_history",
      "tzevaadom",
    ]);
  });

  it("defaults to polled sources when no explicit list is given", () => {
    assert.deepEqual(buildMonitoredSourceChannels({}), [
      "oref_alerts",
      "oref_history",
    ]);
  });
});

describe("createPollerMonitor", () => {
  it("builds initial monitor state and snapshots source failures safely", () => {
    const monitor = createPollerMonitor({
      runtimeState: {
        deliveryEnabled: true,
        deliveryUpdatedAt: null,
        deliveryUpdatedBy: "env",
      },
      monitoredSourceChannels: ["oref_alerts", "tzevaadom"],
      evolutionInstance: "primary",
      evolutionFallbackInstance: "fallback",
    });

    assert.equal(monitor.whatsappActiveInstance, "primary");
    assert.equal(monitor.whatsappFallbackInstance, "fallback");
    assert.equal(monitor.notifierWorkerEnabled, false);
    assert.equal(monitor.notifierWorkerLastHeartbeatAt, null);
    const snapshot = getSourceFailureSnapshot(monitor);
    snapshot.oref_alerts.consecutiveFailures = 99;
    assert.equal(monitor.sourceFailures.oref_alerts.consecutiveFailures, 0);
  });
});

describe("applySourceHealthUpdate", () => {
  it("updates source failure state for success and failure transitions", () => {
    const monitor = createPollerMonitor({
      runtimeState: {
        deliveryEnabled: true,
        deliveryUpdatedAt: null,
        deliveryUpdatedBy: "env",
      },
      monitoredSourceChannels: ["tzevaadom"],
    });

    applySourceHealthUpdate(monitor, {
      source: "tzevaadom",
      ok: false,
      error: "websocket disconnected",
      checkedAt: "2026-03-24T12:00:00.000Z",
    });
    assert.equal(monitor.sourceFailures.tzevaadom.consecutiveFailures, 1);
    assert.equal(monitor.sourceFailures.tzevaadom.lastFailureAt, "2026-03-24T12:00:00.000Z");
    assert.equal(monitor.sourceFailures.tzevaadom.lastError, "websocket disconnected");
    assert.equal(monitor.sourceFailures.tzevaadom.disconnectedSince, "2026-03-24T12:00:00.000Z");

    applySourceHealthUpdate(monitor, {
      source: "tzevaadom",
      ok: false,
      error: "websocket disconnected",
      checkedAt: "2026-03-24T12:00:03.000Z",
    });
    assert.equal(monitor.sourceFailures.tzevaadom.consecutiveFailures, 2);
    assert.equal(monitor.sourceFailures.tzevaadom.disconnectedSince, "2026-03-24T12:00:00.000Z");

    applySourceHealthUpdate(monitor, {
      source: "tzevaadom",
      ok: true,
      checkedAt: "2026-03-24T12:00:05.000Z",
    });
    assert.equal(monitor.sourceFailures.tzevaadom.consecutiveFailures, 0);
    assert.equal(monitor.sourceFailures.tzevaadom.lastSuccessAt, "2026-03-24T12:00:05.000Z");
    assert.equal(monitor.sourceFailures.tzevaadom.lastError, null);
    assert.equal(monitor.sourceFailures.tzevaadom.disconnectedSince, null);
  });
});
