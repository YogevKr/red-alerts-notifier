import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDeliveryKey, detectEventType } from "./lib.js";
import { buildAlertFromPayload, buildSimulationAlerts, simulateAlerts } from "./simulate.js";

function createDeliverAlertDouble() {
  const delivered = new Set();
  const calls = [];

  return {
    calls,
    async deliverAlert(alert, matched, options = {}) {
      calls.push({
        alert,
        matched,
        options,
      });

      const chatId = options.chatIds[0];
      const eventType = detectEventType(alert);
      const key = buildDeliveryKey(alert, matched, { chatId, eventType });
      const duplicate = options.dedupe && delivered.has(key);
      if (!duplicate) {
        delivered.add(key);
      }

      return {
        skipped: duplicate,
        reason: duplicate ? "duplicate" : undefined,
        eventType,
        caption: alert.title,
        targets: [
          duplicate
            ? { skipped: true, chatId, key, eventType, reason: "duplicate" }
            : { skipped: false, chatId, key, eventType, deliveryMode: "image" },
        ],
        chatId,
        deliveryMode: duplicate ? undefined : "image",
      };
    },
  };
}

function createEnqueueAlertDouble() {
  const enqueued = new Set();
  const calls = [];

  return {
    calls,
    async deliverAlert(alert, matched, options = {}) {
      calls.push({
        alert,
        matched,
        options,
      });

      const chatId = options.chatIds[0];
      const eventType = detectEventType(alert);
      const key = buildDeliveryKey(alert, matched, { chatId, eventType });
      const duplicate = enqueued.has(key);

      if (!duplicate) {
        enqueued.add(key);
      }

      return {
        skipped: duplicate,
        reason: duplicate ? "duplicate" : undefined,
        eventType,
        caption: alert.title,
        targets: [
          {
            skipped: duplicate,
            chatId,
            key,
            eventType,
            reason: duplicate ? "duplicate" : undefined,
            outboxId: duplicate ? 17 : 18,
            outboxStatus: duplicate ? "pending" : "pending",
          },
        ],
        chatId,
      };
    },
  };
}

describe("buildAlertFromPayload", () => {
  it("preserves source and defaults locations", () => {
    assert.deepEqual(
      buildAlertFromPayload(
        {
          id: "a1",
          source: "oref_alerts",
          title: "title",
        },
        ["תל אביב - יפו"],
      ),
      {
        id: "a1",
        source: "oref_alerts",
        cat: "1",
        title: "title",
        desc: "",
        data: ["תל אביב - יפו"],
        alertDate: undefined,
      },
    );
  });
});

describe("buildSimulationAlerts", () => {
  it("sorts batch alerts by alertDate", () => {
    const alerts = buildSimulationAlerts({
      alerts: [
        { id: "late", source: "oref_history", alertDate: "2026-03-17 21:31:00" },
        { id: "early", source: "oref_alerts", alertDate: "2026-03-17 21:30:00" },
      ],
    }, ["תל אביב - יפו"]);

    assert.deepEqual(alerts.map((alert) => alert.id), ["early", "late"]);
  });
});

describe("simulateAlerts", () => {
  it("batches multiple source alerts and suppresses duplicates", async () => {
    const double = createDeliverAlertDouble();

    const result = await simulateAlerts(
      {
        useTestTarget: true,
        alerts: [
          {
            id: "oref-1",
            source: "oref_alerts",
            title: "SIM BATCH DUP",
            alertDate: "2026-03-17 21:30:00",
            data: ["תל אביב - יפו"],
          },
          {
            id: "history-1",
            source: "oref_history",
            category: "13",
            title: "SIM BATCH DUP",
            alertDate: "2026-03-17 21:30:05",
            data: ["תל אביב - יפו"],
          },
          {
            id: "tzevaadom-1",
            source: "tzevaadom",
            title: "SIM BATCH UNIQUE",
            alertDate: "2026-03-17 21:30:20",
            data: ["תל אביב - יפו"],
          },
        ],
      },
      {
        locations: ["תל אביב - יפו"],
        targetChatIds: ["group@g.us"],
        testChatIds: ["972500000000"],
        deliverAlert: double.deliverAlert,
      },
    );

    assert.equal(result.targetMode, "test");
    assert.equal(result.received, 3);
    assert.deepEqual(result.alerts.map((alert) => alert.source), [
      "oref_alerts",
      "oref_history",
      "tzevaadom",
    ]);
    assert.equal(result.alerts[1].targets[0].reason, "duplicate");
    assert.equal(result.summary.sentTargets, 2);
    assert.equal(result.summary.duplicateTargets, 1);
    assert.equal(double.calls[0].options.notifierDedupe, true);
    assert.equal(double.calls[0].options.chatIds[0], "972500000000");
  });

  it("disables both dedupe layers when requested", async () => {
    const double = createDeliverAlertDouble();

    const result = await simulateAlerts(
      {
        useTestTarget: true,
        dedupe: false,
        alerts: [
          {
            id: "oref-1",
            source: "oref_alerts",
            title: "SIM NO DEDUPE",
            alertDate: "2026-03-17 21:30:00",
            data: ["תל אביב - יפו"],
          },
          {
            id: "history-1",
            source: "oref_history",
            title: "SIM NO DEDUPE",
            alertDate: "2026-03-17 21:30:05",
            data: ["תל אביב - יפו"],
          },
        ],
      },
      {
        locations: ["תל אביב - יפו"],
        targetChatIds: ["group@g.us"],
        testChatIds: ["972500000000"],
        deliverAlert: double.deliverAlert,
      },
    );

    assert.equal(result.summary.sentTargets, 2);
    assert.equal(result.summary.duplicateTargets, 0);
    assert.equal(double.calls[0].options.dedupe, false);
    assert.equal(double.calls[0].options.notifierDedupe, false);
  });

  it("keeps explicit targets ahead of test mode", async () => {
    const double = createDeliverAlertDouble();

    const result = await simulateAlerts(
      {
        useTestTarget: true,
        number: "972511111111",
        title: "SIM EXPLICIT",
        data: ["תל אביב - יפו"],
      },
      {
        locations: ["תל אביב - יפו"],
        targetChatIds: ["group@g.us"],
        testChatIds: ["972500000000"],
        deliverAlert: double.deliverAlert,
      },
    );

    assert.equal(result.targetMode, "explicit");
    assert.equal(result.chatId, "972511111111");
  });

  it("supports telegram targets in test mode", async () => {
    const double = createEnqueueAlertDouble();

    const result = await simulateAlerts(
      {
        useTestTarget: true,
        title: "SIM TELEGRAM TEST",
        data: ["תל אביב - יפו"],
      },
      {
        locations: ["תל אביב - יפו"],
        targetChatIds: ["group@g.us"],
        testChatIds: ["telegram:123456789"],
        deliverAlert: double.deliverAlert,
      },
    );

    assert.equal(result.targetMode, "test");
    assert.equal(result.chatId, "telegram:123456789");
    assert.equal(double.calls[0].options.chatIds[0], "telegram:123456789");
  });

  it("returns unmatched alerts without calling delivery", async () => {
    const double = createDeliverAlertDouble();

    const result = await simulateAlerts(
      {
        useTestTarget: true,
        title: "SIM NO MATCH",
        data: ["חיפה"],
      },
      {
        locations: ["תל אביב - יפו"],
        targetChatIds: ["group@g.us"],
        testChatIds: ["972500000000"],
        deliverAlert: double.deliverAlert,
      },
    );

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "no_matching_locations");
    assert.equal(double.calls.length, 0);
  });

  it("supports enqueue-style responses for outbox simulation", async () => {
    const double = createEnqueueAlertDouble();

    const result = await simulateAlerts(
      {
        useTestTarget: true,
        title: "SIM OUTBOX",
        data: ["תל אביב - יפו"],
      },
      {
        locations: ["תל אביב - יפו"],
        targetChatIds: ["group@g.us"],
        testChatIds: ["972500000000"],
        deliverAlert: double.deliverAlert,
      },
    );

    assert.equal(result.skipped, false);
    assert.equal(result.chatId, "972500000000");
    assert.equal(result.targets[0].outboxStatus, "pending");
    assert.equal(result.deliveryMode, undefined);
  });
});
