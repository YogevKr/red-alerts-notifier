import { queryRows } from "./db.js";
import { NOTIFICATION_OUTBOX_SCHEMA } from "./outbox-schema.js";

export const SOURCE_EVENT_LEDGER_BASENAME = "source_events";
export const SOURCE_EVENT_LEDGER_TABLE =
  `${NOTIFICATION_OUTBOX_SCHEMA}.${SOURCE_EVENT_LEDGER_BASENAME}`;

export const INSERT_SOURCE_EVENT_SQL = `
with existing as (
  select id
  from ${SOURCE_EVENT_LEDGER_TABLE}
  where source = $5
    and source_key = $6
    and outcome = $16
  order by observed_at desc, id desc
  limit 1
),
updated as (
  update ${SOURCE_EVENT_LEDGER_TABLE}
  set
    observed_at = $1,
    source_received_at = $2,
    alert_date = $3,
    source_event_at = $4,
    source_message_id = $7,
    source_message_type = $8,
    semantic_key = $9,
    event_type = $10,
    category = $11,
    title = $12,
    source_meta = $13::jsonb,
    raw_locations = $14::jsonb,
    matched_locations = $15::jsonb,
    observation_count = coalesce(observation_count, 1) + 1
  where id = (select id from existing)
  returning id, observed_at, source, source_key, semantic_key, event_type, outcome, observation_count
),
inserted as (
  insert into ${SOURCE_EVENT_LEDGER_TABLE} (
    observed_at,
    source_received_at,
    alert_date,
    source_event_at,
    source,
    source_key,
    source_message_id,
    source_message_type,
    semantic_key,
    event_type,
    category,
    title,
    source_meta,
    raw_locations,
    matched_locations,
    outcome,
    observation_count,
    created_at
  )
  select
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13::jsonb,
    $14::jsonb,
    $15::jsonb,
    $16,
    1,
    $1
  where not exists (select 1 from existing)
  returning id, observed_at, source, source_key, semantic_key, event_type, outcome, observation_count
)
select * from updated
union all
select * from inserted
limit 1
`;

const CREATE_SOURCE_EVENT_TABLE_SQL = `
create table if not exists ${SOURCE_EVENT_LEDGER_TABLE} (
  id bigserial primary key,
  observed_at timestamptz not null,
  source_received_at timestamptz,
  alert_date text,
  source_event_at timestamptz,
  source text not null,
  source_key text not null,
  source_message_id text,
  source_message_type text,
  semantic_key text,
  event_type text not null,
  category text,
  title text not null default '',
  source_meta jsonb not null default '{}'::jsonb,
  raw_locations jsonb not null default '[]'::jsonb,
  matched_locations jsonb not null default '[]'::jsonb,
  outcome text not null,
  observation_count integer not null default 1,
  created_at timestamptz not null default now()
);
`;

const ALTER_SOURCE_EVENT_COLUMNS_SQL = `
alter table ${SOURCE_EVENT_LEDGER_TABLE}
  add column if not exists source_event_at timestamptz,
  add column if not exists source_message_id text,
  add column if not exists source_message_type text,
  add column if not exists category text,
  add column if not exists source_meta jsonb not null default '{}'::jsonb,
  add column if not exists raw_locations jsonb not null default '[]'::jsonb,
  add column if not exists observation_count integer not null default 1;
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

const CREATE_UPSERT_LOOKUP_INDEX_SQL = `
create index if not exists source_events_upsert_lookup_idx
on ${SOURCE_EVENT_LEDGER_TABLE} (source, source_key, outcome, observed_at desc, id desc);
`;

export const LIST_RECENT_SOURCE_EVENTS_SQL = `
with deduped as (
  select distinct on (source, source_key)
    id,
    observed_at,
    source_received_at,
    alert_date,
    source_event_at,
    source,
    source_key,
    source_message_id,
    source_message_type,
    semantic_key,
    event_type,
    category,
    title,
    source_meta,
    raw_locations,
    matched_locations,
    outcome,
    observation_count
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
    source_event_at,
    source,
    source_key,
    source_message_id,
    source_message_type,
    semantic_key,
    event_type,
    category,
    title,
    source_meta,
    raw_locations,
    matched_locations,
    outcome,
    observation_count,
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
  source_event_at,
  source,
  source_key,
  source_message_id,
  source_message_type,
  semantic_key,
  event_type,
  category,
  title,
  source_meta,
  raw_locations,
  matched_locations,
  outcome,
  observation_count
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

function normalizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [String(key || "").trim(), entryValue])
      .filter(([key, entryValue]) => key && entryValue !== undefined),
  );
}

export async function ensureSourceEventLedgerSchema(db) {
  await db.query(`create schema if not exists ${NOTIFICATION_OUTBOX_SCHEMA}`);
  await db.query(CREATE_SOURCE_EVENT_TABLE_SQL);
  await db.query(ALTER_SOURCE_EVENT_COLUMNS_SQL);
  await db.query(CREATE_OBSERVED_AT_INDEX_SQL);
  await db.query(CREATE_SEMANTIC_KEY_INDEX_SQL);
  await db.query(CREATE_SOURCE_OBSERVED_INDEX_SQL);
  await db.query(CREATE_UPSERT_LOOKUP_INDEX_SQL);
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
      normalizeTimestamp(entry.sourceEventAt),
      normalizeText(entry.source, "unknown"),
      normalizeText(entry.sourceKey, "unknown"),
      normalizeText(entry.sourceMessageId, null),
      normalizeText(entry.sourceMessageType, null),
      normalizeText(entry.semanticKey, null),
      normalizeText(entry.eventType, "unknown"),
      normalizeText(entry.category, null),
      normalizeText(entry.title),
      JSON.stringify(normalizeJsonObject(entry.sourceMeta)),
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
      source_meta: normalizeJsonObject(row.source_meta),
      raw_locations: normalizeLocations(row.raw_locations),
      matched_locations: normalizeLocations(row.matched_locations),
    }));
  }
}
