import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeOutboxLatencyRows } from "./outbox-latency.js";

describe("summarizeOutboxLatencyRows", () => {
  it("builds latency percentiles from sent rows", () => {
    const summary = summarizeOutboxLatencyRows([
      {
        source_received_at: "2026-03-18T09:58:59.800Z",
        created_at: "2026-03-18T09:59:00.000Z",
        processing_started_at: "2026-03-18T09:59:00.050Z",
        dispatch_started_at: "2026-03-18T09:59:00.075Z",
        sent_at: "2026-03-18T09:59:00.200Z",
      },
      {
        source_received_at: "2026-03-18T10:00:00.400Z",
        created_at: "2026-03-18T10:00:00.500Z",
        payload_outbox_reserved_at: "2026-03-18T10:00:00.550Z",
        payload_dispatch_started_at: "2026-03-18T10:00:00.600Z",
        sent_at: "2026-03-18T10:00:00.900Z",
      },
    ]);

    assert.deepEqual(summary, {
      sampleLimit: 200,
      sampleSize: 2,
      lastSentAt: "2026-03-18T10:00:00.900Z",
      sourceToEnqueueMs: { count: 2, p50: 100, p95: 200, max: 200 },
      queueMs: { count: 2, p50: 50, p95: 50, max: 50 },
      sendMs: { count: 2, p50: 125, p95: 300, max: 300 },
      endToEndMs: { count: 2, p50: 400, p95: 500, max: 500 },
    });
  });
});
