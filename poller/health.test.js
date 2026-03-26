import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHealthHelpers } from "./health.js";

describe("createHealthHelpers", () => {
  it("includes realtime sources in /health", async () => {
    const outboxOptions = [];
    const helpers = createHealthHelpers({
      loadNotifierState: () => ({}),
      runtimeState: { deliveryEnabled: true },
      activeSourceNames: ["oref_alerts", "oref_history", "tzevaadom"],
      monitor: {
        deliveryEnabled: true,
        deliveryUpdatedAt: null,
        deliveryUpdatedBy: null,
        lastPollAt: null,
        lastPollSuccessAt: null,
        lastPollErrorAt: null,
        lastPollError: null,
        consecutivePollErrors: 0,
        dbLastCheckedAt: null,
        dbLastError: null,
        dbLatencyMs: null,
        dbDatabaseName: null,
        dbServerTime: null,
        dbDisconnectedSince: null,
        outboxLastCheckedAt: null,
        outboxLastError: null,
        whatsappActiveInstance: null,
        whatsappPrimaryInstance: null,
        whatsappPrimaryState: null,
        whatsappFallbackInstance: null,
        whatsappFallbackState: null,
        whatsappConnectionState: null,
        whatsappLastCheckedAt: null,
        whatsappLastError: null,
        whatsappDisconnectedSince: null,
        telegramEnabled: false,
        telegramLastPollAt: null,
        telegramLastPollSuccessAt: null,
        telegramLastUpdateAt: null,
        telegramLastCommandAt: null,
        telegramLastCommand: null,
        telegramLastError: null,
        sourceFailures: {},
      },
      targetChatIds: [],
      locations: ["תל אביב - יפו"],
      delivered: new Set(),
      notifierDedupeGate: { size: 0, inFlightSize: 0 },
      seenSourceAlerts: new Set(),
      inFlight: new Set(),
      evolutionInstance: "default",
      evolutionFallbackInstance: "",
      debugCaptureStores: {},
      summarizeDebugCaptureStores: () => ({ enabled: false, entries: 0, byKind: {}, bySource: {} }),
      pagerDuty: { status: () => ({ enabled: false, openIncidents: 0, incidents: [] }) },
      getSourceFailureSnapshot: () => ({}),
      getRealtimeSourcesSnapshot: () => ({
        tzevaadom: {
          enabled: true,
          connected: true,
          receivedCount: 3,
          rawLog: {
            enabled: true,
            entries: 3,
          },
        },
      }),
      getLatestAlertFlowSnapshot: () => ({
        semanticKey: "flow-1",
        eventType: "all_clear",
        title: "האירוע הסתיים",
        matchedLocations: ["תל אביב - יפו"],
        summary: "tzevaadom:enqueued (+0ms) -> telegram:sent (+180ms)",
        entries: [],
      }),
      checkDatabaseHealth: async () => {},
      getOutboxStatsSnapshot: async (_now, options = {}) => {
        outboxOptions.push(options);
        return null;
      },
      pruneDeliveredKeys() {},
      toIsoString: (ts = Date.now()) => new Date(ts).toISOString(),
    });

    const response = await helpers.buildHealthResponse();

    assert.deepEqual(outboxOptions, [{ includeLatency: false }]);

    assert.deepEqual(response.sources, {
      tzevaadom: {
        enabled: true,
        connected: true,
        receivedCount: 3,
        rawLog: {
          enabled: true,
          entries: 3,
        },
      },
    });
  });

  it("includes tzevaadom socket status in ops status", () => {
    const helpers = createHealthHelpers({
      loadNotifierState: () => ({}),
      runtimeState: { deliveryEnabled: true },
      activeSourceNames: ["oref_alerts", "oref_history", "tzevaadom"],
      monitor: {
        deliveryEnabled: true,
        deliveryUpdatedAt: null,
        deliveryUpdatedBy: null,
        lastPollAt: null,
        lastPollSuccessAt: null,
        lastPollErrorAt: null,
        lastPollError: null,
        consecutivePollErrors: 0,
        dbLastCheckedAt: null,
        dbLastError: null,
        dbLatencyMs: null,
        dbDatabaseName: null,
        dbServerTime: null,
        dbDisconnectedSince: null,
        outboxLastCheckedAt: null,
        outboxLastError: null,
        whatsappActiveInstance: "red-alerts",
        whatsappPrimaryInstance: null,
        whatsappPrimaryState: "open",
        whatsappFallbackInstance: null,
        whatsappFallbackState: "disabled",
        whatsappConnectionState: null,
        whatsappLastCheckedAt: null,
        whatsappLastError: null,
        whatsappDisconnectedSince: null,
        telegramEnabled: false,
        telegramLastPollAt: null,
        telegramLastPollSuccessAt: null,
        telegramLastUpdateAt: null,
        telegramLastCommandAt: null,
        telegramLastCommand: null,
        telegramLastError: null,
        sourceFailures: {},
        lastDeliveredAt: "2026-03-23T11:48:03.890Z",
        lastDeliveredEventType: "all_clear",
        lastDeliveredSource: "tzevaadom",
      },
      targetChatIds: ["telegram:123456789"],
      locations: ["תל אביב - יפו"],
      delivered: new Set(),
      notifierDedupeGate: { size: 0, inFlightSize: 0 },
      seenSourceAlerts: new Set(),
      inFlight: new Set(),
      evolutionInstance: "default",
      evolutionFallbackInstance: "",
      debugCaptureStores: {},
      summarizeDebugCaptureStores: () => ({ enabled: false, entries: 0, byKind: {}, bySource: {} }),
      pagerDuty: { status: () => ({ enabled: false, openIncidents: 0, incidents: [] }) },
      getSourceFailureSnapshot: () => ({}),
      getRealtimeSourcesSnapshot: () => ({
        tzevaadom: {
          enabled: true,
          connected: true,
          receivedCount: 11,
          alertCount: 11,
          parseErrorCount: 0,
          lastMessageAt: "2026-03-23T11:48:03.890Z",
          lastAlertAt: "2026-03-23T11:48:03.890Z",
          lastParseError: null,
        },
      }),
      getLatestAlertFlowSnapshot: () => ({
        semanticKey: "flow-1",
        eventType: "all_clear",
        title: "האירוע הסתיים",
        matchedLocations: ["תל אביב - יפו"],
        summary: "tzevaadom:enqueued (+0ms) -> telegram:sent (+180ms)",
        entries: [
          {
            at: "2026-03-23T11:48:03.890Z",
            source: "tzevaadom",
            outcome: "enqueued",
          },
          {
            at: "2026-03-23T11:48:04.070Z",
            source: "telegram",
            outcome: "sent",
          },
        ],
      }),
      checkDatabaseHealth: async () => {},
      getOutboxStatsSnapshot: async () => null,
      pruneDeliveredKeys() {},
      toIsoString: (ts = Date.now()) => new Date(ts).toISOString(),
    });

    assert.deepEqual(helpers.buildOpsStatusPayload({
      outboxStats: {
        pending: 1,
        processing: 0,
        failed: 0,
        uncertain: 0,
        deadLettered: 0,
        latency: {
          endToEndMs: { count: 3, p50: 220, p95: 640, max: 640 },
          queueMs: { count: 3, p50: 14, p95: 30, max: 30 },
          sendMs: { count: 3, p50: 180, p95: 430, max: 430 },
          sourceToEnqueueMs: { count: 3, p50: 20, p95: 200, max: 200 },
        },
      },
    }), {
      deliveryEnabled: true,
      activeSources: ["oref_alerts", "oref_history", "tzevaadom"],
      transports: [],
      destinations: {
        total: 1,
        labels: ["telegram:123456789"],
        byTransport: {
          telegram: 1,
          whatsapp: 0,
        },
      },
      sender: {
        label: "red-alerts",
      },
      whatsapp: {
        enabled: false,
        activeInstance: null,
        primaryInstance: null,
        primaryState: null,
        fallbackInstance: null,
        fallbackState: null,
        connectionState: null,
        lastCheckedAt: null,
        lastError: null,
        disconnectedSince: null,
      },
      telegram: {
        enabled: false,
        lastCheckedAt: null,
        lastError: null,
        lastDeliveredChatId: null,
      },
      activeInstance: "red-alerts",
      primaryState: "open",
      fallbackState: "disabled",
      lastDeliveredAt: "2026-03-23T11:48:03.890Z",
      lastDeliveredEventType: "all_clear",
      lastDeliveredSource: "tzevaadom",
      lastDeliveredTransport: null,
      latestFlow: null,
      targets: ["telegram:123456789"],
      poll: {
        lastPollAt: null,
        lastPollSuccessAt: null,
        lastPollErrorAt: null,
        lastPollError: null,
        consecutivePollErrors: 0,
      },
      database: null,
      outbox: {
        pending: 1,
        processing: 0,
        failed: 0,
        uncertain: 0,
        deadLettered: 0,
        latency: {
          endToEndMs: { count: 3, p50: 220, p95: 640, max: 640 },
          queueMs: { count: 3, p50: 14, p95: 30, max: 30 },
          sendMs: { count: 3, p50: 180, p95: 430, max: 430 },
          sourceToEnqueueMs: { count: 3, p50: 20, p95: 200, max: 200 },
        },
      },
      sourceFailures: {},
      realtimeSources: {
        tzevaadom: {
          enabled: true,
          connected: true,
          receivedCount: 11,
          alertCount: 11,
          parseErrorCount: 0,
          lastMessageAt: "2026-03-23T11:48:03.890Z",
          lastAlertAt: "2026-03-23T11:48:03.890Z",
          lastParseError: null,
          lastConnectionError: null,
          brokerUrl: null,
          lastTopic: null,
          topicsSubscribedAt: null,
          topicsError: null,
        },
      },
    });
  });

  it("prefers telegram management health over delivery state in ops status", () => {
    const helpers = createHealthHelpers({
      loadNotifierState: () => ({
        telegramLastCheckedAt: "2026-03-23T11:48:01.000Z",
        telegramLastError: null,
        telegramLastDeliveredChatId: "123456789",
      }),
      runtimeState: { deliveryEnabled: true },
      activeSourceNames: ["oref_alerts"],
      configuredNotifierTransports: ["telegram"],
      monitor: {
        deliveryEnabled: true,
        deliveryUpdatedAt: null,
        deliveryUpdatedBy: null,
        lastPollAt: null,
        lastPollSuccessAt: null,
        lastPollErrorAt: null,
        lastPollError: null,
        consecutivePollErrors: 0,
        dbLastCheckedAt: null,
        dbLastError: null,
        dbLatencyMs: null,
        dbDatabaseName: null,
        dbServerTime: null,
        dbDisconnectedSince: null,
        outboxLastCheckedAt: null,
        outboxLastError: null,
        whatsappActiveInstance: null,
        whatsappPrimaryInstance: null,
        whatsappPrimaryState: null,
        whatsappFallbackInstance: null,
        whatsappFallbackState: null,
        whatsappConnectionState: null,
        whatsappLastCheckedAt: null,
        whatsappLastError: null,
        whatsappDisconnectedSince: null,
        telegramEnabled: true,
        telegramLastPollAt: "2026-03-23T11:48:03.000Z",
        telegramLastPollSuccessAt: "2026-03-23T11:48:02.000Z",
        telegramLastUpdateAt: null,
        telegramLastCommandAt: null,
        telegramLastCommand: null,
        telegramLastError: "telegram getUpdates responded 401",
        sourceFailures: {},
      },
      targetChatIds: ["telegram:123456789"],
      locations: [],
      delivered: new Set(),
      notifierDedupeGate: { size: 0, inFlightSize: 0 },
      seenSourceAlerts: new Set(),
      inFlight: new Set(),
      evolutionInstance: "default",
      evolutionFallbackInstance: "",
      debugCaptureStores: {},
      summarizeDebugCaptureStores: () => ({ enabled: false, entries: 0, byKind: {}, bySource: {} }),
      pagerDuty: { status: () => ({ enabled: false, openIncidents: 0, incidents: [] }) },
      getSourceFailureSnapshot: () => ({}),
      getRealtimeSourcesSnapshot: () => ({}),
      getLatestAlertFlowSnapshot: () => null,
      checkDatabaseHealth: async () => {},
      getOutboxStatsSnapshot: async () => null,
      pruneDeliveredKeys() {},
      toIsoString: (ts = Date.now()) => new Date(ts).toISOString(),
    });

    assert.deepEqual(helpers.buildOpsStatusPayload().telegram, {
      enabled: true,
      lastCheckedAt: "2026-03-23T11:48:02.000Z",
      lastError: "telegram getUpdates responded 401",
      lastDeliveredChatId: "123456789",
    });
  });

  it("refreshes database health when building ops status", async () => {
    const monitor = {
      deliveryEnabled: true,
      deliveryUpdatedAt: null,
      deliveryUpdatedBy: null,
      lastPollAt: null,
      lastPollSuccessAt: null,
      lastPollErrorAt: null,
      lastPollError: null,
      consecutivePollErrors: 0,
      dbLastCheckedAt: null,
      dbLastError: "stale",
      dbLatencyMs: null,
      dbDatabaseName: null,
      dbServerTime: null,
      dbDisconnectedSince: null,
      outboxLastCheckedAt: null,
      outboxLastError: null,
      whatsappActiveInstance: null,
      whatsappPrimaryInstance: null,
      whatsappPrimaryState: null,
      whatsappFallbackInstance: null,
      whatsappFallbackState: null,
      whatsappConnectionState: null,
      whatsappLastCheckedAt: null,
      whatsappLastError: null,
      whatsappDisconnectedSince: null,
      telegramEnabled: false,
      telegramLastPollAt: null,
      telegramLastPollSuccessAt: null,
      telegramLastUpdateAt: null,
      telegramLastCommandAt: null,
      telegramLastCommand: null,
      telegramLastError: null,
      sourceFailures: {},
    };

    let checks = 0;
    const helpers = createHealthHelpers({
      loadNotifierState: () => ({}),
      databaseEnabled: true,
      runtimeState: { deliveryEnabled: true },
      activeSourceNames: ["oref_alerts"],
      monitor,
      targetChatIds: [],
      locations: [],
      delivered: new Set(),
      notifierDedupeGate: { size: 0, inFlightSize: 0 },
      seenSourceAlerts: new Set(),
      inFlight: new Set(),
      evolutionInstance: "default",
      evolutionFallbackInstance: "",
      debugCaptureStores: {},
      summarizeDebugCaptureStores: () => ({ enabled: false, entries: 0, byKind: {}, bySource: {} }),
      pagerDuty: { status: () => ({ enabled: false, openIncidents: 0, incidents: [] }) },
      getSourceFailureSnapshot: () => ({}),
      getRealtimeSourcesSnapshot: () => ({}),
      getLatestAlertFlowSnapshot: () => null,
      checkDatabaseHealth: async () => {
        checks += 1;
        monitor.dbLastCheckedAt = "2026-03-25T11:36:30.993Z";
        monitor.dbLastError = null;
        monitor.dbLatencyMs = 774;
      },
      getOutboxStatsSnapshot: async (_now, options = {}) => {
        assert.equal(options.includeLatency, false);
        return null;
      },
      pruneDeliveredKeys() {},
      toIsoString: (ts = Date.now()) => new Date(ts).toISOString(),
    });

    const response = await helpers.buildOpsStatusResponse();

    assert.equal(checks, 1);
    assert.deepEqual(response.status.database, {
      enabled: true,
      lastCheckedAt: "2026-03-25T11:36:30.993Z",
      lastError: null,
      latencyMs: 774,
    });
  });
});
