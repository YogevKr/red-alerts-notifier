import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOutboxJobs, handleUnsupportedAlert } from "./alert-enqueue-helpers.js";

describe("buildOutboxJobs", () => {
  it("builds one outbox job per target with a stable source payload", () => {
    const { source, sourceReceivedAt, jobs } = buildOutboxJobs({
      alert: {
        id: "alert:1",
        source: "oref_alerts",
        receivedAt: "2026-03-24T10:00:00.000Z",
      },
      matched: ["תל אביב - יפו"],
      chatIds: ["telegram:1", "telegram:2"],
      eventType: "active_alert",
      sourceKey: "oref_alerts:alert:1",
      nowMs: Date.parse("2026-03-24T10:00:01.000Z"),
    });

    assert.equal(source, "oref_alerts");
    assert.equal(sourceReceivedAt, "2026-03-24T10:00:00.000Z");
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].sourceKey, "oref_alerts:alert:1");
    assert.equal(jobs[0].payload.source, "oref_alerts");
    assert.equal(jobs[1].chatId, "telegram:2");
    assert.ok(jobs[0].deliveryKey);
  });

  it("stages whatsapp targets while leaving telegram immediate", () => {
    const { jobs } = buildOutboxJobs({
      alert: {
        id: "alert:1",
        source: "tzevaadom",
        receivedAt: "2026-03-24T10:00:00.000Z",
      },
      matched: ["חיפה"],
      chatIds: [
        "group-primary@g.us",
        "group-secondary@g.us",
        "telegram:123456789",
      ],
      eventType: "active_alert",
      sourceKey: "tzevaadom:alert:1",
      nowMs: Date.parse("2026-03-24T10:00:01.000Z"),
      whatsappTargetStaggerMs: 2000,
    });

    assert.equal(jobs[0].availableAt, "2026-03-24T10:00:01.000Z");
    assert.equal(jobs[1].availableAt, "2026-03-24T10:00:03.000Z");
    assert.equal(jobs[2].availableAt, "2026-03-24T10:00:01.000Z");
  });
});

describe("handleUnsupportedAlert", () => {
  it("pages and returns a skipped unsupported result", async () => {
    const calls = [];
    const result = await handleUnsupportedAlert({
      alert: { id: "alert:1", source: "tzevaadom" },
      matched: ["תל אביב - יפו"],
      eventType: "unknown",
      chatIds: ["telegram:1"],
      pagerDuty: {
        async triggerIncident(payload) {
          calls.push(payload);
        },
      },
      logger: { warn() {} },
      buildAlertLogFields: () => ({ source: "tzevaadom" }),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].dedupKey, "unsupported-alert:tzevaadom:alert:1");
    assert.deepEqual(result, {
      skipped: true,
      reason: "unsupported_alert_payload",
      eventType: "unknown",
      targets: [],
    });
  });
});
