import { queryRows } from "./db.js";
import { NOTIFICATION_OUTBOX_SCHEMA } from "./outbox-schema.js";

export const SOURCE_EVENT_LEDGER_BASENAME = "source_events";
export const SOURCE_EVENT_LEDGER_TABLE =
  `${NOTIFICATION_OUTBOX_SCHEMA}.${SOURCE_EVENT_LEDGER_BASENAME}`;

export const INSERT_SOURCE_EVENT_SQL = `
insert into ${SOURCE_EVENT_LEDGER_TABLE} (
  observed_at,
  source_received_at,
  alert_date,
  source,
  source_key,
  semantic_key,
  event_type,
  title,
  raw_locations,
  matched_locations,
  outcome,
  created_at
)
values (
  $1,
  $2,
  $3,
  $4,
  $5,
  $6,
  $7,
  $8,
  $9::jsonb,
  $10::jsonb,
  $11,
  $1
)
returning id, observed_at, source, source_key, semantic_key, event_type, outcome
`;

const CREATE_SOURCE_EVENT_TABLE_SQL = `
create table if not exists ${SOURCE_EVENT_LEDGER_TABLE} (
  id bigserial primary key,
  observed_at timestamptz not null,
  source_received_at timestamptz,
  alert_date text,
  source text not null,
  source_key text not null,
  semantic_key text,
  event_type text not null,
  title text not null default '',
  raw_locations jsonb not null default '[]'::jsonb,
  matched_locations jsonb not null default '[]'::jsonb,
  outcome text not null,
  created_at timestamptz not null default now()
);
`;

const ALTER_RAW_LOCATIONS_SQL = `
alter table ${SOURCE_EVENT_LEDGER_TABLE}
add column if not exists raw_locations jsonb not null default '[]'::jsonb;
`;

const CREATE_OBSERVED_AT_INDEX_SQL = `
create index if not exists source_events_observed_at_idx
on ${SOURCE_EVENT_LEDGER_TABLE} (observed_at desc, id desc);
`;

const CREATE_SEMANTIC_KEY_INDEX_SQL = `
create index if not exists source_events_semantic_key_idx
on ${SOURCE_EVENT_LEDGER_TABLE} (semantic_key, observed_at desc, id desc);
`;

const CREATE_SOURCE_OBSERVED_INDEX_SQL = `
create index if not exists source_events_source_observed_idx
on ${SOURCE_EVENT_LEDGER_TABLE} (source, observed_at desc, id desc);
`;

export const LIST_RECENT_SOURCE_EVENTS_SQL = `
with deduped as (
  select distinct on (source, source_key)
    id,
    observed_at,
    source_received_at,
    alert_date,
    source,
    source_key,
    semantic_key,
    event_type,
    title,
    raw_locations,
    matched_locations,
    outcome
  from ${SOURCE_EVENT_LEDGER_TABLE}
  where source = any($1::text[])
  order by source, source_key, observed_at desc, id desc
),
ranked as (
  select
    id,
    observed_at,
    source_received_at,
    alert_date,
    source,
    source_key,
    semantic_key,
    event_type,
    title,
    raw_locations,
    matched_locations,
    outcome,
    row_number() over (
      partition by source
      order by observed_at desc, id desc
    ) as source_rank
  from deduped
)
select
  id,
  observed_at,
  source_received_at,
  alert_date,
  source,
  source_key,
  semantic_key,
  event_type,
  title,
  raw_locations,
  matched_locations,
  outcome
from ranked
where source_rank <= $2
order by source asc, observed_at desc, id desc
`;

function normalizeTimestamp(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeLocations(locations = []) {
  return (Array.isArray(locations) ? locations : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

export async function ensureSourceEventLedgerSchema(db) {
  await db.query(`create schema if not exists ${NOTIFICATION_OUTBOX_SCHEMA}`);
  await db.query(CREATE_SOURCE_EVENT_TABLE_SQL);
  await db.query(ALTER_RAW_LOCATIONS_SQL);
  await db.query(CREATE_OBSERVED_AT_INDEX_SQL);
  await db.query(CREATE_SEMANTIC_KEY_INDEX_SQL);
  await db.query(CREATE_SOURCE_OBSERVED_INDEX_SQL);
}

export class PostgresSourceEventLedger {
  constructor({ pool }) {
    this.pool = pool;
  }

  async ensureSchema() {
    await ensureSourceEventLedgerSchema(this.pool);
  }

  async record(entry = {}) {
    const rows = await queryRows(this.pool, INSERT_SOURCE_EVENT_SQL, [
      normalizeTimestamp(entry.observedAt) || new Date().toISOString(),
      normalizeTimestamp(entry.receivedAt),
      normalizeText(entry.alertDate, null),
      normalizeText(entry.source, "unknown"),
      normalizeText(entry.sourceKey, "unknown"),
      normalizeText(entry.semanticKey, null),
      normalizeText(entry.eventType, "unknown"),
      normalizeText(entry.title),
      JSON.stringify(normalizeLocations(entry.rawLocations)),
      JSON.stringify(normalizeLocations(entry.matchedLocations)),
      normalizeText(entry.outcome, "unknown"),
    ]);

    return rows[0] || null;
  }

  async listRecentBySource(sources = [], limitPerSource = 5) {
    const normalizedSources = [...new Set(
      (Array.isArray(sources) ? sources : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    )];
    if (normalizedSources.length === 0) return [];

    const rows = await queryRows(this.pool, LIST_RECENT_SOURCE_EVENTS_SQL, [
      normalizedSources,
      Math.max(1, Number.parseInt(limitPerSource, 10) || 5),
    ]);

    return rows.map((row) => ({
      ...row,
      raw_locations: normalizeLocations(row.raw_locations),
      matched_locations: normalizeLocations(row.matched_locations),
    }));
  }
}
