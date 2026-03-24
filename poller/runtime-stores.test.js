import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStores } from "./runtime-stores.js";

function createStoresFixture({
  activeSourceNames = ["oref_alerts", "oref_mqtt"],
  listDebugCaptureEntries = () => [],
  debugCaptureStores = {},
} = {}) {
  const dirPath = mkdtempSync(join(tmpdir(), "red-alerts-runtime-stores-"));
  const paths = {
    runtimeStatePath: join(dirPath, "runtime-state.json"),
    recentSentStorePath: join(dirPath, "recent-sent.json"),
    recentAlertFlowStorePath: join(dirPath, "recent-alert-flow.json"),
    dedupeStorePath: join(dirPath, "dedupe.json"),
    seenSourceAlertStorePath: join(dirPath, "seen-source-alerts.json"),
  };
  const stores = createRuntimeStores({
    ...paths,
    parseBooleanEnv: () => true,
    deliveryEnabledEnv: "true",
    toIsoString: (value = Date.now()) => new Date(value).toISOString(),
    maxRecentSent: 10,
    maxDeliveredKeys: 10,
    deliveredKeyTtlMs: 60_000,
    maxSeenSourceAlerts: 10,
    seenSourceAlertTtlMs: 60_000,
    shouldSuppressDuplicateDelivery: () => false,
    hashDeliveryKey: (value) => String(value),
    listDebugCaptureEntries,
    debugCaptureStores,
    activeSourceNames,
    locations: ["תל אביב - יפו"],
    logger: console,
  });
  return {
    stores,
    paths,
  };
}

describe("createRuntimeStores", () => {
  it("reloads recent sent rows from disk when formatting recent_sent", () => {
    const { stores, paths } = createStoresFixture();

    writeFileSync(paths.recentSentStorePath, JSON.stringify([{
      deliveredAt: "2026-03-24T00:30:09.000Z",
      eventType: "active_alert",
      source: "ops_api",
      title: "ירי רקטות וטילים",
      chatId: "telegram:123456789",
      matchedLocations: ["תל אביב - יפו"],
      transport: "telegram",
      usedFallback: false,
    }], null, 2), "utf8");

    assert.equal(
      stores.buildRecentSentMessage(1),
      [
        "recent_sent:",
        "2026-03-24T00:30:09.000Z | active_alert | ops_api | telegram:123456789 | ירי רקטות וטילים",
      ].join("\n"),
    );
  });

  it("builds grouped recent flow output and latest flow summary", () => {
    const { stores, paths } = createStoresFixture();

    stores.rememberRecentAlertFlow({
      observedAt: "2026-03-24T00:33:32.490Z",
      receivedAt: "2026-03-24T00:33:32.471Z",
      alertDate: "2026-03-24 02:33:32",
      source: "tzevaadom",
      eventType: "all_clear",
      title: "האירוע הסתיים",
      matchedLocations: ["תל אביב - יפו"],
      semanticKey: "flow-1",
      sourceKey: "tzevaadom:1",
      outcome: "enqueued",
    });
    stores.rememberRecentAlertFlow({
      observedAt: "2026-03-24T00:33:36.600Z",
      receivedAt: "2026-03-24T00:33:36.575Z",
      alertDate: "2026-03-24 02:33:36",
      source: "oref_alerts",
      eventType: "all_clear",
      title: "האירוע הסתיים",
      matchedLocations: ["תל אביב - יפו"],
      semanticKey: "flow-1",
      sourceKey: "oref_alerts:1",
      outcome: "duplicate",
    });

    writeFileSync(paths.recentSentStorePath, JSON.stringify([{
      deliveredAt: "2026-03-24T00:33:32.637Z",
      eventType: "all_clear",
      source: "tzevaadom",
      title: "האירוע הסתיים",
      chatId: "telegram:123456789",
      matchedLocations: ["תל אביב - יפו"],
      semanticKey: "flow-1",
      deliveryKey: "delivery-1",
      alertDate: "2026-03-24 02:33:32",
      receivedAt: "2026-03-24T00:33:32.471Z",
      transport: "telegram",
      usedFallback: false,
    }], null, 2), "utf8");

    assert.equal(
      stores.getLatestAlertFlowSnapshot()?.summary,
      "tzevaadom:enqueued (+0ms) -> telegram:sent (+166ms) -> oref_alerts:duplicate (+4.1s)",
    );
    assert.equal(
      stores.buildRecentFlowMessage(1),
      [
        "recent_flow:",
        "האירוע הסתיים | תל אביב - יפו",
        "2026-03-24T00:33:32.471Z (+0ms) | tzevaadom | enqueued",
        "2026-03-24T00:33:32.637Z (+166ms) | telegram | sent",
        "2026-03-24T00:33:36.575Z (+4.1s) | oref_alerts | duplicate",
      ].join("\n"),
    );
  });

  it("compresses repeated latest flow steps in the status summary", () => {
    const { stores } = createStoresFixture();

    for (let index = 0; index < 20; index += 1) {
      stores.rememberRecentAlertFlow({
        observedAt: "2026-03-24T00:33:32.490Z",
        receivedAt: "2026-03-24T00:33:32.471Z",
        alertDate: "2026-03-24 02:33:32",
        source: "oref_history",
        eventType: "all_clear",
        title: "האירוע הסתיים",
        matchedLocations: ["תל אביב - יפו"],
        semanticKey: "flow-repeat",
        sourceKey: `oref_history:${index}`,
        outcome: "location_miss",
      });
    }

    assert.equal(
      stores.getLatestAlertFlowSnapshot()?.summary,
      "oref_history:location_miss (+0ms) x20",
    );
  });

  it("builds recent received output from DB rows per active source", async () => {
    const { stores } = createStoresFixture();
    stores.setRecentSourceEventsLoader(async () => [
      {
        source: "oref_alerts",
        alert_date: "2026-03-24 23:00:01",
        title: "Website alert",
        outcome: "location_miss",
        raw_locations: ["תל אביב - יפו"],
        matched_locations: [],
      },
      {
        source: "oref_mqtt",
        source_received_at: "2026-03-24T21:00:02.000Z",
        title: "MQTT message",
        outcome: "enqueued",
        raw_locations: ["תל אביב - יפו"],
        matched_locations: ["תל אביב - יפו"],
      },
    ]);

    assert.equal(
      await stores.buildRecentReceivedMessage(2),
      [
        "recent_received:",
        "oref_alerts:",
        "oref_alerts | 2026-03-24 23:00:01 | location_miss | Website alert | תל אביב - יפו",
        "oref_mqtt:",
        "oref_mqtt | 2026-03-24T21:00:02.000Z | enqueued | MQTT message | תל אביב - יפו",
      ].join("\n"),
    );
  });

  it("falls back to debug capture output per active source", async () => {
    const entries = [
      {
        source: "oref_alerts",
        kind: "oref_raw",
        lastSeenAt: "2026-03-24T21:00:01.000Z",
        payload: {
          title: "Website alert",
          alertDate: "2026-03-24 23:00:01",
          cat: 1,
          data: ["תל אביב - יפו"],
        },
      },
      {
        source: "oref_mqtt",
        kind: "mqtt_raw",
        lastSeenAt: "2026-03-24T21:00:02.000Z",
        payload: {
          title: "MQTT message",
          time: "2026-03-24T21:00:02.000Z",
        },
      },
      {
        source: "tzevaadom",
        kind: "ws_raw",
        lastSeenAt: "2026-03-24T21:00:03.000Z",
        payload: {
          title: "WS message",
          time: "2026-03-24T21:00:03.000Z",
        },
      },
    ];
    const dirPath = mkdtempSync(join(tmpdir(), "red-alerts-runtime-stores-"));
    const stores = createRuntimeStores({
      runtimeStatePath: join(dirPath, "runtime-state.json"),
      recentSentStorePath: join(dirPath, "recent-sent.json"),
      recentAlertFlowStorePath: join(dirPath, "recent-alert-flow.json"),
      dedupeStorePath: join(dirPath, "dedupe.json"),
      seenSourceAlertStorePath: join(dirPath, "seen-source-alerts.json"),
      parseBooleanEnv: () => true,
      deliveryEnabledEnv: "true",
      toIsoString: (value = Date.now()) => new Date(value).toISOString(),
      maxRecentSent: 10,
      maxDeliveredKeys: 10,
      deliveredKeyTtlMs: 60_000,
      maxSeenSourceAlerts: 10,
      seenSourceAlertTtlMs: 60_000,
      shouldSuppressDuplicateDelivery: () => false,
      hashDeliveryKey: (value) => String(value),
      listDebugCaptureEntries: (_stores, { limit = 100, kind = "", source = "" } = {}) =>
        entries
          .filter((entry) => (!kind || entry.kind === kind) && (!source || entry.source === source))
          .slice(0, limit),
      debugCaptureStores: {
        oref_alerts: {},
        oref_history: {},
        oref_mqtt: {},
        tzevaadom: {},
      },
      activeSourceNames: ["oref_alerts", "oref_history", "oref_mqtt", "tzevaadom"],
      locations: ["תל אביב - יפו"],
      logger: console,
    });

    assert.equal(
      await stores.buildRecentReceivedMessage(2),
      [
        "recent_received:",
        "oref_alerts:",
        "oref_alerts | 2026-03-24 23:00:01 cat=1 | Website alert | תל אביב - יפו",
        "oref_history:",
        "none",
        "oref_mqtt:",
        "oref_mqtt | 2026-03-24T21:00:02.000Z | MQTT message",
        "tzevaadom:",
        "tzevaadom | 2026-03-24T21:00:03.000Z | WS message",
      ].join("\n"),
    );
  });
});
