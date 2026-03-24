import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createAlertPipeline,
  createAlertProcessingSummary,
} from "./alert-pipeline.js";

describe("createAlertPipeline", () => {
  it("ingests matched alerts through the shared enqueue path", async () => {
    const seenKeys = new Set();
    const enqueued = [];
    const summary = createAlertProcessingSummary();
    const pipeline = createAlertPipeline({
      suppressionReporter: { record() {} },
      matchLocations: (alert, locations) => alert.data.filter((location) => locations.includes(location)),
      locations: ["תל אביב - יפו"],
      buildSeenSourceAlertKey: (alert) => `${alert.source}:${alert.id}`,
      hasSeenSourceAlertKey: (key) => seenKeys.has(key),
      rememberSeenSourceAlertKey: (key) => {
        seenKeys.add(key);
        return true;
      },
      enqueueAlertNotifications: async (alert, matched, { chatIds }) => {
        enqueued.push({ alert, matched, chatIds });
        return { enqueuedCount: chatIds.length, duplicateCount: 0 };
      },
      targetChatIds: ["telegram:123456789"],
      parseEventDate: (value) => new Date(`${value.replace(" ", "T")}Z`),
      buildAlertLogFields: () => ({}),
      detectEventType: () => "active_alert",
      isExplicitlySupportedAlert: () => true,
      isDeliverableEventType: () => true,
      rememberDeliveredKey: () => true,
      hashDeliveryKey: (value) => value,
      buildDeliveryKey: () => "delivery-key",
    });

    const result = await pipeline.ingestAlert({
      id: "1",
      source: "tzevaadom",
      alertDate: "2026-03-23 12:00:00",
      data: ["תל אביב - יפו"],
    }, { summary });

    assert.equal(result.matchedAlert, true);
    assert.equal(result.sourceKey, "tzevaadom:1");
    assert.deepEqual(enqueued, [{
      alert: {
        id: "1",
        source: "tzevaadom",
        alertDate: "2026-03-23 12:00:00",
        data: ["תל אביב - יפו"],
      },
      matched: ["תל אביב - יפו"],
      chatIds: ["telegram:123456789"],
    }]);
    assert.deepEqual(summary, {
      matched_alert_count: 1,
      seen_skipped_count: 0,
      enqueued_target_count: 1,
      duplicate_enqueue_count: 0,
    });
  });

  it("suppresses already-seen source alerts before enqueue", async () => {
    const suppressions = [];
    const pipeline = createAlertPipeline({
      suppressionReporter: {
        record(type, key) {
          suppressions.push({ type, key });
        },
      },
      matchLocations: () => ["תל אביב - יפו"],
      locations: ["תל אביב - יפו"],
      buildSeenSourceAlertKey: () => "seen-key",
      hasSeenSourceAlertKey: () => true,
      rememberSeenSourceAlertKey: () => false,
      enqueueAlertNotifications: async () => {
        assert.fail("enqueueAlertNotifications should not be called");
      },
      targetChatIds: ["telegram:123456789"],
      parseEventDate: () => new Date("2026-03-23T12:00:00.000Z"),
      buildAlertLogFields: () => ({}),
      detectEventType: () => "active_alert",
      isExplicitlySupportedAlert: () => true,
      isDeliverableEventType: () => true,
      rememberDeliveredKey: () => true,
      hashDeliveryKey: (value) => value,
      buildDeliveryKey: () => "delivery-key",
    });

    const result = await pipeline.ingestAlert({
      id: "1",
      source: "oref_alerts",
      alertDate: "2026-03-23 12:00:00",
      data: ["תל אביב - יפו"],
    });

    assert.equal(result.reason, "seen_source_alert");
    assert.deepEqual(suppressions, [{
      type: "seen_source_alert",
      key: "seen-key",
    }]);
  });

  it("seeds delivery keys only for matched deliverable alerts", async () => {
    const delivered = [];
    const seen = [];
    const pipeline = createAlertPipeline({
      suppressionReporter: { record() {} },
      matchLocations: (alert) => alert.data || [],
      locations: ["תל אביב - יפו"],
      buildSeenSourceAlertKey: (alert) => alert.id,
      hasSeenSourceAlertKey: () => false,
      rememberSeenSourceAlertKey: (key) => {
        seen.push(key);
        return true;
      },
      enqueueAlertNotifications: async () => ({ enqueuedCount: 0, duplicateCount: 0 }),
      targetChatIds: ["telegram:1", "telegram:2"],
      parseEventDate: () => new Date("2026-03-23T12:00:00.000Z"),
      buildAlertLogFields: () => ({}),
      detectEventType: () => "all_clear",
      isExplicitlySupportedAlert: () => true,
      isDeliverableEventType: () => true,
      rememberDeliveredKey: (key) => {
        delivered.push(key);
        return true;
      },
      hashDeliveryKey: (value) => `hash:${value}`,
      buildDeliveryKey: (_alert, matched, { chatId, eventType }) =>
        `${chatId}:${eventType}:${matched.join(",")}`,
    });

    const seeded = await pipeline.seedAlerts([{
      id: "alert:1",
      source: "oref_history",
      alertDate: "2026-03-23 12:00:00",
      data: ["תל אביב - יפו"],
    }]);

    assert.deepEqual(seen, ["alert:1"]);
    assert.deepEqual(delivered, [
      "hash:telegram:1:all_clear:תל אביב - יפו",
      "hash:telegram:2:all_clear:תל אביב - יפו",
    ]);
    assert.deepEqual(seeded, {
      seededDeliveries: 2,
      seededSourceAlerts: 1,
    });
  });
});
