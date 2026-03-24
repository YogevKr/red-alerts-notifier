export const OUTBOX_LATENCY_SAMPLE_LIMIT = 200;

function normalizeDate(value) {
  if (value instanceof Date) return value;

  const parsed = Date.parse(value || "");
  if (Number.isFinite(parsed)) return new Date(parsed);

  return null;
}

function computeDurationMs(startValue, endValue) {
  const start = normalizeDate(startValue);
  const end = normalizeDate(endValue);
  if (!start || !end) return null;
  const durationMs = end.getTime() - start.getTime();
  return durationMs >= 0 ? durationMs : null;
}

function computePercentile(sortedValues, percentile) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const index = Math.max(0, Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * percentile) - 1,
  ));
  return Math.round(sortedValues[index]);
}

function summarizeLatencyMetric(values = []) {
  const sortedValues = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sortedValues.length === 0) return null;

  return {
    count: sortedValues.length,
    p50: computePercentile(sortedValues, 0.5),
    p95: computePercentile(sortedValues, 0.95),
    max: Math.round(sortedValues[sortedValues.length - 1]),
  };
}

export function summarizeOutboxLatencyRows(rows = []) {
  const orderedRows = [...rows].sort((left, right) =>
    (normalizeDate(right?.sent_at)?.getTime() || 0) - (normalizeDate(left?.sent_at)?.getTime() || 0));
  const sourceToEnqueue = [];
  const queue = [];
  const send = [];
  const endToEnd = [];
  let lastSentAt = null;

  for (const row of orderedRows) {
    const sourceReceivedAt = normalizeDate(row?.source_received_at);
    const createdAt = normalizeDate(row?.created_at);
    const processingStartedAt =
      normalizeDate(row?.processing_started_at) || normalizeDate(row?.payload_outbox_reserved_at);
    const dispatchStartedAt =
      normalizeDate(row?.dispatch_started_at)
      || normalizeDate(row?.payload_dispatch_started_at)
      || processingStartedAt;
    const sentAt = normalizeDate(row?.sent_at);

    if (!lastSentAt && sentAt) {
      lastSentAt = sentAt.toISOString();
    }

    const sourceToEnqueueMs = computeDurationMs(sourceReceivedAt, createdAt);
    if (Number.isFinite(sourceToEnqueueMs)) {
      sourceToEnqueue.push(sourceToEnqueueMs);
    }

    const queueMs = computeDurationMs(createdAt, processingStartedAt);
    if (Number.isFinite(queueMs)) {
      queue.push(queueMs);
    }

    const sendMs = computeDurationMs(dispatchStartedAt, sentAt);
    if (Number.isFinite(sendMs)) {
      send.push(sendMs);
    }

    const endToEndMs = computeDurationMs(sourceReceivedAt || createdAt, sentAt);
    if (Number.isFinite(endToEndMs)) {
      endToEnd.push(endToEndMs);
    }
  }

  return {
    sampleLimit: OUTBOX_LATENCY_SAMPLE_LIMIT,
    sampleSize: rows.length,
    lastSentAt,
    sourceToEnqueueMs: summarizeLatencyMetric(sourceToEnqueue),
    queueMs: summarizeLatencyMetric(queue),
    sendMs: summarizeLatencyMetric(send),
    endToEndMs: summarizeLatencyMetric(endToEnd),
  };
}
