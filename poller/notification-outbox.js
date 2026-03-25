import { withDbTransaction, queryRows } from "./db.js";
import { DELIVERY_DUPLICATE_WINDOW_MS } from "./lib.js";
import {
  OUTBOX_LATENCY_SAMPLE_LIMIT,
  summarizeOutboxLatencyRows,
} from "./outbox-latency.js";
import {
  ensureOutboxSchema,
  NOTIFICATION_OUTBOX_TABLE,
  NOTIFY_OUTBOX_READY_SQL,
  RESERVE_OUTBOX_JOBS_SQL,
} from "./outbox-schema.js";

const DEFAULT_PROCESSING_TIMEOUT_MS = 30_000;

export const OUTBOX_STATUSES = {
  PENDING: "pending",
  PROCESSING: "processing",
  SENT: "sent",
  FAILED: "failed",
  UNCERTAIN: "uncertain",
  DEAD_LETTERED: "dead_lettered",
  DUPLICATE: "duplicate",
};

export const DELETE_EXPIRED_TERMINAL_JOB_SQL = `
delete from ${NOTIFICATION_OUTBOX_TABLE}
where delivery_key = $1
  and status in ('${OUTBOX_STATUSES.SENT}', '${OUTBOX_STATUSES.DEAD_LETTERED}')
  and available_at <= $2
`;

export const INSERT_OUTBOX_JOB_SQL = `
insert into ${NOTIFICATION_OUTBOX_TABLE} (
  delivery_key,
  semantic_key,
  source_key,
  source,
  event_type,
  chat_id,
  source_received_at,
  payload_json,
  status,
  is_duplicate,
  available_at,
  created_at,
  updated_at
)
values (
  $1,
  $2,
  $3,
  $4,
  $5,
  $6,
  $7,
  $8::jsonb,
  '${OUTBOX_STATUSES.PENDING}',
  false,
  $9,
  $9,
  $9
)
on conflict (delivery_key) where (coalesce(is_duplicate, false) = false) do nothing
returning id, delivery_key, status
`;

export const SELECT_OUTBOX_JOB_SQL = `
select id, delivery_key, status, available_at, sent_at, failed_at, uncertain_at, dead_lettered_at
from ${NOTIFICATION_OUTBOX_TABLE}
where delivery_key = $1
  and coalesce(is_duplicate, false) = false
limit 1
`;

export const INSERT_OUTBOX_DUPLICATE_SQL = `
insert into ${NOTIFICATION_OUTBOX_TABLE} (
  delivery_key,
  semantic_key,
  source_key,
  source,
  event_type,
  chat_id,
  source_received_at,
  payload_json,
  status,
  is_duplicate,
  available_at,
  sent_at,
  created_at,
  updated_at
)
values (
  $1,
  $2,
  $3,
  $4,
  $5,
  $6,
  $7,
  $8::jsonb,
  '${OUTBOX_STATUSES.DUPLICATE}',
  true,
  $9,
  $9,
  $9,
  $9
)
returning id, delivery_key, semantic_key, is_duplicate, status
`;

export const MARK_OUTBOX_DISPATCH_STARTED_SQL = `
update ${NOTIFICATION_OUTBOX_TABLE}
set
  dispatch_started_at = $2,
  updated_at = $2
where id = $1
  and status = '${OUTBOX_STATUSES.PROCESSING}'
returning id, delivery_key, status, dispatch_started_at
`;

export const MARK_OUTBOX_SENT_SQL = `
update ${NOTIFICATION_OUTBOX_TABLE}
set
  status = '${OUTBOX_STATUSES.SENT}',
  sent_at = $2,
  updated_at = $2,
  available_at = $2,
  processing_started_at = null,
  dispatch_started_at = null,
  processing_by = null,
  last_error = null,
  payload_json = coalesce(payload_json, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'outboxReservedAt', processing_started_at,
      'dispatchStartedAt', dispatch_started_at
    ))
    || $3::jsonb
where id = $1
returning id, delivery_key, status, sent_at, payload_json
`;

export const MARK_OUTBOX_FAILED_SQL = `
update ${NOTIFICATION_OUTBOX_TABLE}
set
  status = '${OUTBOX_STATUSES.FAILED}',
  failed_at = $2,
  updated_at = $2,
  available_at = $3,
  processing_started_at = null,
  dispatch_started_at = null,
  processing_by = null,
  last_error = $4
where id = $1
returning id, delivery_key, status, failed_at, available_at, last_error
`;

export const MARK_OUTBOX_UNCERTAIN_SQL = `
update ${NOTIFICATION_OUTBOX_TABLE}
set
  status = '${OUTBOX_STATUSES.UNCERTAIN}',
  uncertain_at = $2,
  updated_at = $2,
  processing_started_at = null,
  processing_by = null,
  last_error = $3
where id = $1
returning id, delivery_key, status, uncertain_at, last_error
`;

export const MARK_OUTBOX_DEAD_LETTERED_SQL = `
update ${NOTIFICATION_OUTBOX_TABLE}
set
  status = '${OUTBOX_STATUSES.DEAD_LETTERED}',
  dead_lettered_at = $2,
  updated_at = $2,
  available_at = $2,
  processing_started_at = null,
  dispatch_started_at = null,
  processing_by = null,
  last_error = $3
where id = $1
returning id, delivery_key, status, dead_lettered_at, last_error
`;

export const MARK_STALE_DISPATCHES_UNCERTAIN_SQL = `
update ${NOTIFICATION_OUTBOX_TABLE}
set
  status = '${OUTBOX_STATUSES.UNCERTAIN}',
  uncertain_at = now(),
  updated_at = now(),
  processing_started_at = null,
  processing_by = null,
  last_error = coalesce(last_error, 'worker lease expired after dispatch start')
where status = '${OUTBOX_STATUSES.PROCESSING}'
  and dispatch_started_at is not null
  and processing_started_at <= $1
returning id, delivery_key, status, uncertain_at, last_error
`;

export const OUTBOX_STATS_SQL = `
select
  count(*) filter (
    where coalesce(is_duplicate, false) = false
      and status = '${OUTBOX_STATUSES.PENDING}'
  )::integer as pending,
  count(*) filter (
    where coalesce(is_duplicate, false) = false
      and status = '${OUTBOX_STATUSES.PROCESSING}'
  )::integer as processing,
  count(*) filter (
    where coalesce(is_duplicate, false) = false
      and status = '${OUTBOX_STATUSES.SENT}'
  )::integer as sent,
  count(*) filter (
    where coalesce(is_duplicate, false) = false
      and status = '${OUTBOX_STATUSES.FAILED}'
  )::integer as failed,
  count(*) filter (
    where coalesce(is_duplicate, false) = false
      and status = '${OUTBOX_STATUSES.UNCERTAIN}'
  )::integer as uncertain,
  count(*) filter (
    where coalesce(is_duplicate, false) = false
      and status = '${OUTBOX_STATUSES.DEAD_LETTERED}'
  )::integer as dead_lettered,
  count(*) filter (
    where coalesce(is_duplicate, false) = true
  )::integer as duplicates,
  min(available_at) filter (
    where coalesce(is_duplicate, false) = false
      and status in ('${OUTBOX_STATUSES.PENDING}', '${OUTBOX_STATUSES.FAILED}')
  ) as oldest_available_at
from ${NOTIFICATION_OUTBOX_TABLE}
`;

export const OUTBOX_LATENCY_SAMPLE_SQL = `
select
  source_received_at,
  created_at,
  processing_started_at,
  dispatch_started_at,
  sent_at,
  payload_json->>'outboxReservedAt' as payload_outbox_reserved_at,
  payload_json->>'dispatchStartedAt' as payload_dispatch_started_at
from ${NOTIFICATION_OUTBOX_TABLE}
where status = '${OUTBOX_STATUSES.SENT}'
  and coalesce(is_duplicate, false) = false
  and sent_at is not null
order by sent_at desc, id desc
limit $1
`;

function normalizeDate(value) {
  if (value instanceof Date) return value;

  const parsed = Date.parse(value || "");
  if (Number.isFinite(parsed)) return new Date(parsed);

  return null;
}

function buildJobPayload(item) {
  return item?.payload && typeof item.payload === "object" ? item.payload : {};
}

function normalizeJobRow(row = {}) {
  return {
    ...row,
    payload: row.payload_json && typeof row.payload_json === "object"
      ? row.payload_json
      : {},
  };
}

export class PostgresNotificationOutbox {
  constructor({
    pool,
    duplicateWindowMs = DELIVERY_DUPLICATE_WINDOW_MS,
    processingTimeoutMs = DEFAULT_PROCESSING_TIMEOUT_MS,
    workerId = "",
  } = {}) {
    if (!pool) {
      throw new Error("PostgresNotificationOutbox requires a pool");
    }

    this.pool = pool;
    this.duplicateWindowMs = duplicateWindowMs;
    this.processingTimeoutMs = processingTimeoutMs;
    this.workerId = String(workerId || "").trim();
  }

  async ensureSchema() {
    await ensureOutboxSchema(this.pool);
  }

  async enqueueMany(items = [], now = Date.now()) {
    const createdAt = new Date(now);
    const duplicateCutoff = new Date(createdAt.getTime() - this.duplicateWindowMs);

    return withDbTransaction(this.pool, async (db) => {
      const results = [];
      let insertedCount = 0;

      for (const item of items) {
        const deliveryKey = String(item?.deliveryKey || item?.key || "").trim();
        if (!deliveryKey) {
          results.push({
            id: null,
            deliveryKey,
            enqueued: false,
            reason: "missing_delivery_key",
            status: null,
          });
          continue;
        }

        await db.query(DELETE_EXPIRED_TERMINAL_JOB_SQL, [deliveryKey, duplicateCutoff]);

        const insertedRows = await queryRows(db, INSERT_OUTBOX_JOB_SQL, [
          deliveryKey,
          String(item?.semanticKey || "").trim(),
          String(item?.sourceKey || "").trim(),
          String(item?.source || "unknown").trim(),
          String(item?.eventType || "").trim(),
          String(item?.chatId || "").trim(),
          normalizeDate(item?.sourceReceivedAt),
          JSON.stringify(buildJobPayload(item)),
          createdAt,
        ]);

        if (insertedRows.length > 0) {
          const inserted = insertedRows[0];
          insertedCount += 1;
          results.push({
            id: inserted.id ?? null,
            deliveryKey,
            enqueued: true,
            reason: null,
            status: inserted.status || OUTBOX_STATUSES.PENDING,
          });
          continue;
        }

        const [existing] = await queryRows(db, SELECT_OUTBOX_JOB_SQL, [deliveryKey]);
        results.push({
          id: existing?.id ?? null,
          deliveryKey,
          enqueued: false,
          reason: "duplicate",
          status: existing?.status || null,
        });
      }

      if (insertedCount > 0) {
        await db.query(NOTIFY_OUTBOX_READY_SQL);
      }

      return results;
    });
  }

  async reserve({
    limit = 1,
    now = Date.now(),
    workerId = this.workerId,
    processingTimeoutMs = this.processingTimeoutMs,
  } = {}) {
    const staleBefore = new Date(now - processingTimeoutMs);
    const rows = await queryRows(this.pool, RESERVE_OUTBOX_JOBS_SQL, [
      staleBefore,
      Math.max(1, limit),
      String(workerId || "").trim() || null,
    ]);
    return rows.map(normalizeJobRow);
  }

  async insertDuplicateMany(items = [], now = Date.now()) {
    const createdAt = new Date(now);

    return withDbTransaction(this.pool, async (db) => {
      const rows = [];

      for (const item of items) {
        const deliveryKey = String(item?.deliveryKey || item?.key || "").trim();
        if (!deliveryKey) continue;

        const insertedRows = await queryRows(db, INSERT_OUTBOX_DUPLICATE_SQL, [
          deliveryKey,
          String(item?.semanticKey || "").trim(),
          String(item?.sourceKey || "").trim(),
          String(item?.source || "unknown").trim(),
          String(item?.eventType || "").trim(),
          String(item?.chatId || "").trim(),
          normalizeDate(item?.sourceReceivedAt),
          JSON.stringify(buildJobPayload(item)),
          createdAt,
        ]);
        rows.push(...insertedRows);
      }

      return rows;
    });
  }

  async recoverStaleDispatches(now = Date.now(), {
    processingTimeoutMs = this.processingTimeoutMs,
  } = {}) {
    const staleBefore = new Date(now - processingTimeoutMs);
    return queryRows(this.pool, MARK_STALE_DISPATCHES_UNCERTAIN_SQL, [staleBefore]);
  }

  async markDispatchStarted(jobId, now = Date.now()) {
    const rows = await queryRows(this.pool, MARK_OUTBOX_DISPATCH_STARTED_SQL, [
      jobId,
      new Date(now),
    ]);
    return rows[0] || null;
  }

  async markSent(jobId, {
    now = Date.now(),
    payloadPatch = {},
  } = {}) {
    const rows = await queryRows(this.pool, MARK_OUTBOX_SENT_SQL, [
      jobId,
      new Date(now),
      JSON.stringify(payloadPatch && typeof payloadPatch === "object" ? payloadPatch : {}),
    ]);
    return normalizeJobRow(rows[0] || {});
  }

  async markFailed(jobId, errorMessage, {
    now = Date.now(),
    retryDelayMs = 15_000,
  } = {}) {
    const failedAt = new Date(now);
    const nextAttemptAt = new Date(failedAt.getTime() + Math.max(1_000, retryDelayMs));
    const rows = await queryRows(this.pool, MARK_OUTBOX_FAILED_SQL, [
      jobId,
      failedAt,
      nextAttemptAt,
      String(errorMessage || "delivery failed"),
    ]);
    return rows[0] || null;
  }

  async markUncertain(jobId, errorMessage, now = Date.now()) {
    const rows = await queryRows(this.pool, MARK_OUTBOX_UNCERTAIN_SQL, [
      jobId,
      new Date(now),
      String(errorMessage || "delivery uncertain"),
    ]);
    return rows[0] || null;
  }

  async markDeadLettered(jobId, errorMessage, now = Date.now()) {
    const rows = await queryRows(this.pool, MARK_OUTBOX_DEAD_LETTERED_SQL, [
      jobId,
      new Date(now),
      String(errorMessage || "delivery dead-lettered"),
    ]);
    return rows[0] || null;
  }

  async getStats({ includeLatency = true } = {}) {
    const [row] = await queryRows(this.pool, OUTBOX_STATS_SQL);
    const oldestAvailableAt = normalizeDate(row?.oldest_available_at);
    const latencyRows = includeLatency
      ? await queryRows(this.pool, OUTBOX_LATENCY_SAMPLE_SQL, [OUTBOX_LATENCY_SAMPLE_LIMIT])
      : [];

    return {
      pending: row?.pending || 0,
      processing: row?.processing || 0,
      sent: row?.sent || 0,
      failed: row?.failed || 0,
      uncertain: row?.uncertain || 0,
      deadLettered: row?.dead_lettered || 0,
      duplicates: row?.duplicates || 0,
      oldestAvailableAt: oldestAvailableAt ? oldestAvailableAt.toISOString() : null,
      latency: includeLatency ? summarizeOutboxLatencyRows(latencyRows) : null,
    };
  }
}
