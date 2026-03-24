export const NOTIFICATION_OUTBOX_SCHEMA =
  String(process.env.POLLER_DATABASE_SCHEMA || "poller").trim() || "poller";
export const NOTIFICATION_OUTBOX_BASENAME = "notification_outbox";
export const NOTIFICATION_OUTBOX_TABLE =
  `${NOTIFICATION_OUTBOX_SCHEMA}.${NOTIFICATION_OUTBOX_BASENAME}`;
export const NOTIFICATION_OUTBOX_NOTIFY_CHANNEL =
  `${NOTIFICATION_OUTBOX_SCHEMA}_${NOTIFICATION_OUTBOX_BASENAME}_ready`.replace(/[^a-zA-Z0-9_]/g, "_");
export const LISTEN_OUTBOX_READY_SQL = `listen ${NOTIFICATION_OUTBOX_NOTIFY_CHANNEL}`;
export const UNLISTEN_OUTBOX_READY_SQL = `unlisten ${NOTIFICATION_OUTBOX_NOTIFY_CHANNEL}`;
export const NOTIFY_OUTBOX_READY_SQL =
  `select pg_notify('${NOTIFICATION_OUTBOX_NOTIFY_CHANNEL}', 'jobs_ready')`;

export const RESERVE_OUTBOX_JOBS_SQL = `
with jobs as (
  select id
  from ${NOTIFICATION_OUTBOX_TABLE}
  where (
    status = 'pending'
    and available_at <= now()
  ) or (
    status = 'failed'
    and available_at <= now()
  ) or (
    status = 'processing'
    and dispatch_started_at is null
    and processing_started_at <= $1
  )
  order by available_at asc, id asc
  limit $2
  for update skip locked
)
update ${NOTIFICATION_OUTBOX_TABLE}
set
  status = 'processing',
  processing_started_at = now(),
  updated_at = now(),
  attempt_count = attempt_count + 1,
  processing_by = $3
from jobs
where ${NOTIFICATION_OUTBOX_TABLE}.id = jobs.id
returning ${NOTIFICATION_OUTBOX_TABLE}.*;
`;

const CREATE_OUTBOX_TABLE_SQL = `
create table if not exists ${NOTIFICATION_OUTBOX_TABLE} (
  id bigserial primary key,
  delivery_key text not null,
  source_key text not null,
  source text not null,
  event_type text not null,
  chat_id text not null,
  source_received_at timestamptz,
  payload_json jsonb not null,
  status text not null,
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  processing_started_at timestamptz,
  dispatch_started_at timestamptz,
  processing_by text,
  sent_at timestamptz,
  failed_at timestamptz,
  uncertain_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

const ADD_DEAD_LETTERED_AT_COLUMN_SQL = `
alter table ${NOTIFICATION_OUTBOX_TABLE}
add column if not exists dead_lettered_at timestamptz
`;

const ADD_SOURCE_RECEIVED_AT_COLUMN_SQL = `
alter table ${NOTIFICATION_OUTBOX_TABLE}
add column if not exists source_received_at timestamptz
`;

const CREATE_DELIVERY_KEY_INDEX_SQL = `
create unique index if not exists notification_outbox_delivery_key_idx
on ${NOTIFICATION_OUTBOX_TABLE} (delivery_key);
`;

const CREATE_STATUS_AVAILABLE_INDEX_SQL = `
create index if not exists notification_outbox_status_available_idx
on ${NOTIFICATION_OUTBOX_TABLE} (status, available_at, id);
`;

const CREATE_PROCESSING_INDEX_SQL = `
create index if not exists notification_outbox_processing_idx
on ${NOTIFICATION_OUTBOX_TABLE} (status, processing_started_at, id);
`;

const CREATE_SENT_INDEX_SQL = `
create index if not exists notification_outbox_sent_idx
on ${NOTIFICATION_OUTBOX_TABLE} (status, sent_at desc, id desc);
`;

export async function ensureOutboxSchema(db) {
  await db.query(`create schema if not exists ${NOTIFICATION_OUTBOX_SCHEMA}`);
  await db.query(CREATE_OUTBOX_TABLE_SQL);
  await db.query(ADD_DEAD_LETTERED_AT_COLUMN_SQL);
  await db.query(ADD_SOURCE_RECEIVED_AT_COLUMN_SQL);
  await db.query(CREATE_DELIVERY_KEY_INDEX_SQL);
  await db.query(CREATE_STATUS_AVAILABLE_INDEX_SQL);
  await db.query(CREATE_PROCESSING_INDEX_SQL);
  await db.query(CREATE_SENT_INDEX_SQL);
}
