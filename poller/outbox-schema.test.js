import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureOutboxSchema,
  LISTEN_OUTBOX_READY_SQL,
  NOTIFICATION_OUTBOX_NOTIFY_CHANNEL,
  NOTIFICATION_OUTBOX_SCHEMA,
  NOTIFICATION_OUTBOX_TABLE,
  NOTIFY_OUTBOX_READY_SQL,
  RESERVE_OUTBOX_JOBS_SQL,
  UNLISTEN_OUTBOX_READY_SQL,
} from "./outbox-schema.js";

describe("ensureOutboxSchema", () => {
  it("creates the notification outbox table and indexes", async () => {
    const queries = [];
    const db = {
      async query(text) {
        queries.push(text);
        return { rows: [] };
      },
    };

    await ensureOutboxSchema(db);

    assert.equal(queries.length, 8);
    assert.match(queries[0], new RegExp(`create schema if not exists ${NOTIFICATION_OUTBOX_SCHEMA}`, "i"));
    assert.match(queries[1], new RegExp(`create table if not exists ${NOTIFICATION_OUTBOX_TABLE.replace(".", "\\.")}`, "i"));
    assert.match(queries[1], /delivery_key text not null/i);
    assert.match(queries[1], /source_received_at timestamptz/i);
    assert.match(queries[1], /payload_json jsonb not null/i);
    assert.match(queries[1], /dead_lettered_at timestamptz/i);
    assert.match(queries[2], new RegExp(`alter table ${NOTIFICATION_OUTBOX_TABLE.replace(".", "\\.")}`, "i"));
    assert.match(queries[2], /add column if not exists dead_lettered_at timestamptz/i);
    assert.match(queries[3], new RegExp(`alter table ${NOTIFICATION_OUTBOX_TABLE.replace(".", "\\.")}`, "i"));
    assert.match(queries[3], /add column if not exists source_received_at timestamptz/i);
    assert.match(queries[4], /create unique index if not exists notification_outbox_delivery_key_idx/i);
    assert.match(queries[5], /create index if not exists notification_outbox_status_available_idx/i);
    assert.match(queries[6], /create index if not exists notification_outbox_processing_idx/i);
    assert.match(queries[7], /create index if not exists notification_outbox_sent_idx/i);
  });
});

describe("RESERVE_OUTBOX_JOBS_SQL", () => {
  it("skips already-locked rows and expired processing only", () => {
    assert.match(RESERVE_OUTBOX_JOBS_SQL, /for update skip locked/i);
    assert.match(RESERVE_OUTBOX_JOBS_SQL, /status = 'pending'/i);
    assert.match(RESERVE_OUTBOX_JOBS_SQL, /status = 'failed'/i);
    assert.match(RESERVE_OUTBOX_JOBS_SQL, /status = 'processing'/i);
    assert.match(RESERVE_OUTBOX_JOBS_SQL, /dispatch_started_at is null/i);
    assert.match(RESERVE_OUTBOX_JOBS_SQL, /processing_started_at <= \$1/i);
    assert.match(RESERVE_OUTBOX_JOBS_SQL, new RegExp(`update\\s+${NOTIFICATION_OUTBOX_TABLE}`, "i"));
  });
});

describe("outbox wakeup sql", () => {
  it("uses a sanitized listen/notify channel", () => {
    assert.match(NOTIFICATION_OUTBOX_NOTIFY_CHANNEL, /^[a-zA-Z0-9_]+$/);
    assert.equal(LISTEN_OUTBOX_READY_SQL, `listen ${NOTIFICATION_OUTBOX_NOTIFY_CHANNEL}`);
    assert.equal(UNLISTEN_OUTBOX_READY_SQL, `unlisten ${NOTIFICATION_OUTBOX_NOTIFY_CHANNEL}`);
    assert.equal(
      NOTIFY_OUTBOX_READY_SQL,
      `select pg_notify('${NOTIFICATION_OUTBOX_NOTIFY_CHANNEL}', 'jobs_ready')`,
    );
  });
});
