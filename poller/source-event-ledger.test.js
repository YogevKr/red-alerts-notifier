import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureSourceEventLedgerSchema,
  INSERT_SOURCE_EVENT_SQL,
  LIST_RECENT_SOURCE_EVENTS_SQL,
  PostgresSourceEventLedger,
  SOURCE_EVENT_LEDGER_TABLE,
} from "./source-event-ledger.js";
import { NOTIFICATION_OUTBOX_SCHEMA } from "./outbox-schema.js";

describe("ensureSourceEventLedgerSchema", () => {
  it("creates the source event ledger table and indexes", async () => {
    const queries = [];
    const db = {
      async query(text) {
        queries.push(text);
        return { rows: [] };
      },
    };

    await ensureSourceEventLedgerSchema(db);

    assert.equal(queries.length, 6);
    assert.match(queries[0], new RegExp(`create schema if not exists ${NOTIFICATION_OUTBOX_SCHEMA}`, "i"));
    assert.match(queries[1], new RegExp(`create table if not exists ${SOURCE_EVENT_LEDGER_TABLE.replace(".", "\\.")}`, "i"));
    assert.match(queries[1], /observed_at timestamptz not null/i);
    assert.match(queries[1], /source_received_at timestamptz/i);
    assert.match(queries[1], /raw_locations jsonb not null default '\[\]'::jsonb/i);
    assert.match(queries[1], /matched_locations jsonb not null default '\[\]'::jsonb/i);
    assert.match(queries[2], /add column if not exists raw_locations jsonb not null default '\[\]'::jsonb/i);
    assert.match(queries[3], /create index if not exists source_events_observed_at_idx/i);
    assert.match(queries[4], /create index if not exists source_events_semantic_key_idx/i);
    assert.match(queries[5], /create index if not exists source_events_source_observed_idx/i);
  });
});

describe("PostgresSourceEventLedger", () => {
  it("records normalized source events", async () => {
    const calls = [];
    const ledger = new PostgresSourceEventLedger({
      pool: {
        async query(text, values) {
          calls.push({ text, values });
          return { rows: [{ id: "1", source: values[3], outcome: values[10] }] };
        },
      },
    });

    const row = await ledger.record({
      observedAt: "2026-03-24T21:10:00.000Z",
      receivedAt: "2026-03-24T21:09:59.800Z",
      alertDate: "2026-03-24 23:09:59",
      source: "tzevaadom",
      sourceKey: "tzevaadom:1",
      semanticKey: "all_clear|חיפה",
      eventType: "all_clear",
      title: "האירוע הסתיים",
      matchedLocations: ["חיפה"],
      outcome: "enqueued",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, INSERT_SOURCE_EVENT_SQL);
    assert.deepEqual(calls[0].values, [
      "2026-03-24T21:10:00.000Z",
      "2026-03-24T21:09:59.800Z",
      "2026-03-24 23:09:59",
      "tzevaadom",
      "tzevaadom:1",
      "all_clear|חיפה",
      "all_clear",
      "האירוע הסתיים",
      JSON.stringify([]),
      JSON.stringify(["חיפה"]),
      "enqueued",
    ]);
    assert.deepEqual(row, { id: "1", source: "tzevaadom", outcome: "enqueued" });
  });

  it("lists recent source events grouped by source", async () => {
    const calls = [];
    const ledger = new PostgresSourceEventLedger({
      pool: {
        async query(text, values) {
          calls.push({ text, values });
          return {
            rows: [
              {
                source: "oref_alerts",
                observed_at: "2026-03-24T21:10:00.000Z",
                title: "ירי רקטות וטילים",
                raw_locations: ["תל אביב - יפו"],
                matched_locations: ["תל אביב - יפו"],
                outcome: "enqueued",
              },
              {
                source: "tzevaadom",
                observed_at: "2026-03-24T21:09:59.000Z",
                title: "האירוע הסתיים",
                raw_locations: [],
                matched_locations: [],
                outcome: "location_miss",
              },
            ],
          };
        },
      },
    });

    const rows = await ledger.listRecentBySource(["oref_alerts", "tzevaadom"], 3);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, LIST_RECENT_SOURCE_EVENTS_SQL);
    assert.match(LIST_RECENT_SOURCE_EVENTS_SQL, /distinct on \(source, source_key\)/i);
    assert.deepEqual(calls[0].values, [["oref_alerts", "tzevaadom"], 3]);
    assert.deepEqual(rows, [
      {
        source: "oref_alerts",
        observed_at: "2026-03-24T21:10:00.000Z",
        title: "ירי רקטות וטילים",
        raw_locations: ["תל אביב - יפו"],
        matched_locations: ["תל אביב - יפו"],
        outcome: "enqueued",
      },
      {
        source: "tzevaadom",
        observed_at: "2026-03-24T21:09:59.000Z",
        title: "האירוע הסתיים",
        raw_locations: [],
        matched_locations: [],
        outcome: "location_miss",
      },
    ]);
  });
});
