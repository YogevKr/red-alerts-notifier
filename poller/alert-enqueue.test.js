import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAlertEnqueuer } from "./alert-enqueue.js";
import { createLogAlertSink } from "./alert-sinks.js";

describe("createAlertEnqueuer", () => {
  it("delivers matched alerts to a log sink without requiring notifier targets", async () => {
    const events = [];
    const logger = {
      info(event, fields) {
        events.push({ event, fields });
      },
      warn() {},
      debug() {},
    };
    const enqueuer = createAlertEnqueuer({
      logger,
      suppressionReporter: { record() {} },
      runtimeState: { deliveryEnabled: true },
      locations: ["תל אביב - יפו"],
      targetChatIds: [],
      alertSinks: [
        createLogAlertSink({
          logger,
          buildAlertLogFields: (alert, matched, options = {}) => ({
            alert_id: alert.id || null,
            matched_locations: matched,
            event_type: options.eventType || null,
            source_key: options.sourceKey || null,
          }),
        }),
      ],
      buildOpsTargetLabel: () => "none",
      buildSeenSourceAlertKey: () => "source-key",
    });

    const result = await enqueuer.enqueueAlertNotifications(
      {
        id: "alert-1",
        source: "manual",
        cat: "1",
        title: "ירי רקטות וטילים",
        data: ["תל אביב - יפו"],
        alertDate: "2026-03-24 20:00:00",
      },
      ["תל אביב - יפו"],
    );

    assert.equal(result.skipped, false);
    assert.equal(result.reason, undefined);
    assert.equal(result.enqueuedCount, 1);
    assert.equal(result.duplicateCount, 0);
    assert.equal(result.sinkResults.length, 1);
    assert.equal(result.sinkResults[0].sink, "log");
    assert.equal(result.targets[0].status, "logged");
    assert.equal(events.some(({ event }) => event === "alert_sink_logged"), true);
  });
});
