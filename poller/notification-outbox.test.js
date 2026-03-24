import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DELETE_EXPIRED_TERMINAL_JOB_SQL,
  INSERT_OUTBOX_JOB_SQL,
  INSERT_OUTBOX_DUPLICATE_SQL,
  MARK_OUTBOX_DEAD_LETTERED_SQL,
  MARK_OUTBOX_FAILED_SQL,
  MARK_STALE_DISPATCHES_UNCERTAIN_SQL,
  MARK_OUTBOX_SENT_SQL,
  OUTBOX_LATENCY_SAMPLE_SQL,
  OUTBOX_STATS_SQL,
  OUTBOX_STATUSES,
  PostgresNotificationOutbox,
  SELECT_OUTBOX_JOB_SQL,
} from "./notification-outbox.js";
import { NOTIFY_OUTBOX_READY_SQL, RESERVE_OUTBOX_JOBS_SQL } from "./outbox-schema.js";

function createPoolWithClient(queryImpl) {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return queryImpl({ text, values });
    },
    release() {
      calls.push({ text: "release", values: [] });
    },
  };

  return {
    calls,
    pool: {
      async connect() {
        calls.push({ text: "connect", values: [] });
        return client;
      },
      async query(text, values) {
        calls.push({ text, values });
        return queryImpl({ text, values });
      },
    },
  };
}

describe("PostgresNotificationOutbox.enqueueMany", () => {
  it("inserts pending jobs and returns enqueued results", async () => {
    const { pool, calls } = createPoolWithClient(({ text }) => {
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text === DELETE_EXPIRED_TERMINAL_JOB_SQL) return { rows: [] };
      if (text === INSERT_OUTBOX_JOB_SQL) {
        return { rows: [{ id: 17, delivery_key: "key-1", status: OUTBOX_STATUSES.PENDING }] };
      }
      if (text === NOTIFY_OUTBOX_READY_SQL) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const outbox = new PostgresNotificationOutbox({ pool, duplicateWindowMs: 120_000 });
    const now = Date.parse("2026-03-18T10:00:00Z");
    const results = await outbox.enqueueMany([{
      deliveryKey: "key-1",
      semanticKey: "semantic-1",
      sourceKey: "source-1",
      source: "oref_history",
      eventType: "active_alert",
      chatId: "972500000000",
      sourceReceivedAt: "2026-03-18T09:59:55.000Z",
      payload: { alert: { id: "1" } },
    }], now);

    assert.deepEqual(results, [{
      id: 17,
      deliveryKey: "key-1",
      enqueued: true,
      reason: null,
      status: OUTBOX_STATUSES.PENDING,
    }]);
    assert.equal(calls[0].text, "connect");
    assert.equal(calls[1].text, "BEGIN");
    assert.equal(calls[2].text, DELETE_EXPIRED_TERMINAL_JOB_SQL);
    assert.equal(calls[3].text, INSERT_OUTBOX_JOB_SQL);
    assert.equal(calls[3].values[1], "semantic-1");
    assert.equal(calls[3].values[6]?.toISOString(), "2026-03-18T09:59:55.000Z");
    assert.equal(calls[4].text, NOTIFY_OUTBOX_READY_SQL);
    assert.equal(calls[5].text, "COMMIT");
  });

  it("drops expired dead-lettered jobs before inserting a fresh replacement", async () => {
    const { pool, calls } = createPoolWithClient(({ text }) => {
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text === DELETE_EXPIRED_TERMINAL_JOB_SQL) return { rows: [] };
      if (text === INSERT_OUTBOX_JOB_SQL) {
        return { rows: [{ id: 18, delivery_key: "key-1", status: OUTBOX_STATUSES.PENDING }] };
      }
      if (text === NOTIFY_OUTBOX_READY_SQL) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const outbox = new PostgresNotificationOutbox({ pool, duplicateWindowMs: 120_000 });
    const now = Date.parse("2026-03-18T10:00:00Z");
    const results = await outbox.enqueueMany([{
      deliveryKey: "key-1",
      semanticKey: "semantic-1",
      sourceKey: "source-1",
      source: "oref_alerts",
      eventType: "active_alert",
      chatId: "telegram:1",
      payload: {},
    }], now);

    assert.deepEqual(results, [{
      id: 18,
      deliveryKey: "key-1",
      enqueued: true,
      reason: null,
      status: OUTBOX_STATUSES.PENDING,
    }]);
    assert.equal(calls[2].text, DELETE_EXPIRED_TERMINAL_JOB_SQL);
    assert.equal(calls[2].values[1]?.toISOString(), "2026-03-18T09:58:00.000Z");
  });

  it("returns duplicate when an active row already exists", async () => {
    const { pool, calls } = createPoolWithClient(({ text }) => {
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text === DELETE_EXPIRED_TERMINAL_JOB_SQL) return { rows: [] };
      if (text === INSERT_OUTBOX_JOB_SQL) return { rows: [] };
      if (text === SELECT_OUTBOX_JOB_SQL) {
        return { rows: [{ id: 88, delivery_key: "key-1", status: OUTBOX_STATUSES.PROCESSING }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const outbox = new PostgresNotificationOutbox({ pool });
    const results = await outbox.enqueueMany([{
      deliveryKey: "key-1",
      semanticKey: "semantic-1",
      sourceKey: "source-1",
      source: "oref_history",
      eventType: "active_alert",
      chatId: "972500000000",
      payload: {},
    }]);

    assert.deepEqual(results, [{
      id: 88,
      deliveryKey: "key-1",
      enqueued: false,
      reason: "duplicate",
      status: OUTBOX_STATUSES.PROCESSING,
    }]);
    assert.equal(calls.some((call) => call.text === NOTIFY_OUTBOX_READY_SQL), false);
  });

  it("inserts duplicate observations as flagged rows", async () => {
    const { pool, calls } = createPoolWithClient(({ text }) => {
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text === INSERT_OUTBOX_DUPLICATE_SQL) {
        return {
          rows: [{
            id: 17,
            delivery_key: "key-1",
            semantic_key: "semantic-1",
            is_duplicate: true,
            status: OUTBOX_STATUSES.DUPLICATE,
          }],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const outbox = new PostgresNotificationOutbox({ pool });
    const rows = await outbox.insertDuplicateMany([{
      deliveryKey: "key-1",
      semanticKey: "semantic-1",
      sourceKey: "source-1",
      source: "oref_history",
      eventType: "active_alert",
      chatId: "972500000000",
      sourceReceivedAt: "2026-03-18T09:59:55.000Z",
      payload: { alert: { id: "1" } },
    }], Date.parse("2026-03-18T10:00:00Z"));

    assert.equal(calls[0].text, "connect");
    assert.equal(calls[1].text, "BEGIN");
    assert.equal(calls[2].text, INSERT_OUTBOX_DUPLICATE_SQL);
    assert.equal(calls[2].values[0], "key-1");
    assert.equal(calls[2].values[1], "semantic-1");
    assert.equal(calls[2].values[8]?.toISOString(), "2026-03-18T10:00:00.000Z");
    assert.equal(calls[3].text, "COMMIT");
    assert.equal(rows[0].is_duplicate, true);
    assert.equal(rows[0].status, OUTBOX_STATUSES.DUPLICATE);
  });
});

describe("PostgresNotificationOutbox.reserve", () => {
  it("reserves jobs with the worker id", async () => {
    const { pool, calls } = createPoolWithClient(({ text }) => {
      if (text === RESERVE_OUTBOX_JOBS_SQL) {
        return {
          rows: [{
            id: 5,
            delivery_key: "key-1",
            status: OUTBOX_STATUSES.PROCESSING,
            payload_json: { chatId: "972500000000" },
          }],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const outbox = new PostgresNotificationOutbox({
      pool,
      workerId: "worker-a",
      processingTimeoutMs: 45_000,
    });

    const jobs = await outbox.reserve({
      limit: 2,
      now: Date.parse("2026-03-18T10:00:45Z"),
    });

    assert.equal(calls[0].text, RESERVE_OUTBOX_JOBS_SQL);
    assert.equal(calls[0].values[1], 2);
    assert.equal(calls[0].values[2], "worker-a");
    assert.deepEqual(jobs, [{
      id: 5,
      delivery_key: "key-1",
      status: OUTBOX_STATUSES.PROCESSING,
      payload_json: { chatId: "972500000000" },
      payload: { chatId: "972500000000" },
    }]);
  });
});

describe("PostgresNotificationOutbox state updates", () => {
  it("marks jobs sent, failed, and dead-lettered", async () => {
    const { pool, calls } = createPoolWithClient(({ text }) => {
      if (text === MARK_OUTBOX_SENT_SQL) {
        return { rows: [{ id: 9, delivery_key: "key-1", status: OUTBOX_STATUSES.SENT, payload_json: {} }] };
      }
      if (text === MARK_OUTBOX_FAILED_SQL) {
        return { rows: [{ id: 9, delivery_key: "key-1", status: OUTBOX_STATUSES.FAILED }] };
      }
      if (text === MARK_OUTBOX_DEAD_LETTERED_SQL) {
        return { rows: [{ id: 9, delivery_key: "key-1", status: OUTBOX_STATUSES.DEAD_LETTERED }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const outbox = new PostgresNotificationOutbox({ pool });
    const sent = await outbox.markSent(9, { payloadPatch: { deliveryMode: "image" } });
    const failed = await outbox.markFailed(9, "boom", { retryDelayMs: 20_000 });
    const deadLettered = await outbox.markDeadLettered(9, "permanent boom");

    assert.equal(calls[0].text, MARK_OUTBOX_SENT_SQL);
    assert.equal(calls[1].text, MARK_OUTBOX_FAILED_SQL);
    assert.equal(calls[2].text, MARK_OUTBOX_DEAD_LETTERED_SQL);
    assert.equal(sent.status, OUTBOX_STATUSES.SENT);
    assert.equal(failed.status, OUTBOX_STATUSES.FAILED);
    assert.equal(deadLettered.status, OUTBOX_STATUSES.DEAD_LETTERED);
  });

  it("marks stale dispatched jobs uncertain", async () => {
    const { pool, calls } = createPoolWithClient(({ text }) => {
      if (text === MARK_STALE_DISPATCHES_UNCERTAIN_SQL) {
        return { rows: [{ id: 9, delivery_key: "key-1", status: OUTBOX_STATUSES.UNCERTAIN }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const outbox = new PostgresNotificationOutbox({ pool, processingTimeoutMs: 30_000 });
    const rows = await outbox.recoverStaleDispatches(Date.parse("2026-03-18T10:00:45Z"));

    assert.equal(calls[0].text, MARK_STALE_DISPATCHES_UNCERTAIN_SQL);
    assert.equal(rows[0].status, OUTBOX_STATUSES.UNCERTAIN);
  });
});

describe("PostgresNotificationOutbox.getStats", () => {
  it("returns aggregate counts", async () => {
    const { pool, calls } = createPoolWithClient(({ text }) => {
      if (text === OUTBOX_STATS_SQL) {
        return {
          rows: [{
            pending: 2,
            processing: 1,
            sent: 3,
            failed: 4,
            uncertain: 1,
            dead_lettered: 2,
            duplicates: 5,
            oldest_available_at: "2026-03-18T09:59:00.000Z",
          }],
        };
      }
      if (text === OUTBOX_LATENCY_SAMPLE_SQL) {
        return {
          rows: [
            {
              source_received_at: "2026-03-18T09:58:59.800Z",
              created_at: "2026-03-18T09:59:00.000Z",
              processing_started_at: "2026-03-18T09:59:00.050Z",
              dispatch_started_at: "2026-03-18T09:59:00.075Z",
              sent_at: "2026-03-18T09:59:00.200Z",
            },
            {
              source_received_at: "2026-03-18T09:59:59.700Z",
              created_at: "2026-03-18T10:00:00.000Z",
              processing_started_at: "2026-03-18T10:00:00.020Z",
              dispatch_started_at: "2026-03-18T10:00:00.040Z",
              sent_at: "2026-03-18T10:00:00.180Z",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const outbox = new PostgresNotificationOutbox({ pool });
    const stats = await outbox.getStats();

    assert.equal(calls[0].text, OUTBOX_STATS_SQL);
    assert.equal(calls[1].text, OUTBOX_LATENCY_SAMPLE_SQL);
    assert.deepEqual(stats, {
      pending: 2,
      processing: 1,
      sent: 3,
      failed: 4,
      uncertain: 1,
      deadLettered: 2,
      duplicates: 5,
      oldestAvailableAt: "2026-03-18T09:59:00.000Z",
      latency: {
        sampleLimit: 200,
        sampleSize: 2,
        lastSentAt: "2026-03-18T10:00:00.180Z",
        sourceToEnqueueMs: { count: 2, p50: 200, p95: 300, max: 300 },
        queueMs: { count: 2, p50: 20, p95: 50, max: 50 },
        sendMs: { count: 2, p50: 125, p95: 140, max: 140 },
        endToEndMs: { count: 2, p50: 400, p95: 480, max: 480 },
      },
    });
  });
});
