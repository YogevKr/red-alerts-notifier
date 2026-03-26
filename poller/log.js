const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(level = "info") {
  const normalized = String(level || "").trim().toLowerCase();
  return Object.hasOwn(LOG_LEVELS, normalized) ? normalized : "info";
}

function serializeError(err) {
  if (!err) return null;
  return compactObject({
    name: err.name || null,
    message: err.message || String(err),
    code: err.code || err.cause?.code || null,
    status: err.status || err.cause?.status || null,
    cause: err.cause instanceof Error ? serializeError(err.cause) : undefined,
  });
}

function serializeValue(value) {
  if (value === undefined) return undefined;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    return compactObject(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeValue(item)]),
    ));
  }
  return value;
}

function compactObject(object = {}) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

function defaultWrite(level, entry) {
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function createLogger(
  component,
  {
    level = process.env.LOG_LEVEL || "info",
    now = () => new Date().toISOString(),
    write = defaultWrite,
  } = {},
) {
  const threshold = LOG_LEVELS[normalizeLevel(level)];

  function log(entryLevel, msg, fields = {}) {
    const normalizedLevel = normalizeLevel(entryLevel);
    if (LOG_LEVELS[normalizedLevel] < threshold) return;

    write(normalizedLevel, compactObject({
      ts: now(),
      level: normalizedLevel,
      component,
      msg,
      ...serializeValue(fields),
    }));
  }

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}

export function createSuppressionReporter(
  logger,
  {
    intervalMs = 60_000,
  } = {},
) {
  const buckets = new Map();

  function flushBucket(bucketKey) {
    const bucket = buckets.get(bucketKey);
    if (!bucket) return;

    logger.info("suppressed_events_summary", {
      suppression_kind: bucket.kind,
      suppression_key: bucket.key,
      count: bucket.count,
      first_seen_at: new Date(bucket.firstSeenAt).toISOString(),
      last_seen_at: new Date(bucket.lastSeenAt).toISOString(),
      window_ms: bucket.lastSeenAt - bucket.firstSeenAt,
      ...bucket.fields,
    });
    buckets.delete(bucketKey);
  }

  return {
    record(kind, key, fields = {}, now = Date.now()) {
      const bucketKey = `${kind}:${key}`;
      const bucket = buckets.get(bucketKey);

      if (!bucket) {
        buckets.set(bucketKey, {
          kind,
          key,
          count: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          fields: compactObject(serializeValue(fields)),
        });
        return;
      }

      bucket.count += 1;
      bucket.lastSeenAt = now;
      bucket.fields = {
        ...bucket.fields,
        ...compactObject(serializeValue(fields)),
      };

      if (bucket.lastSeenAt - bucket.firstSeenAt >= intervalMs) {
        flushBucket(bucketKey);
      }
    },
    flushDue(now = Date.now()) {
      for (const [bucketKey, bucket] of buckets.entries()) {
        if (now - bucket.firstSeenAt >= intervalMs) {
          flushBucket(bucketKey);
        }
      }
    },
    flushAll() {
      for (const bucketKey of buckets.keys()) {
        flushBucket(bucketKey);
      }
    },
  };
}

export function createRepeatedEventLogger(
  logger,
  {
    intervalMs = 60_000,
    shouldLogFirst = true,
    now = () => Date.now(),
  } = {},
) {
  const reporter = createSuppressionReporter(logger, { intervalMs });
  const lastValues = new Map();

  return {
    record(kind, key, valueKey, fields = {}, level = "info") {
      const bucketKey = `${kind}:${key}`;
      const previousValue = lastValues.get(bucketKey);
      const changed = previousValue !== valueKey;
      lastValues.set(bucketKey, valueKey);

      if (changed) {
        if (shouldLogFirst || previousValue !== undefined) {
          logger[level]?.(kind, fields);
        }
        return true;
      }

      reporter.record(kind, key, fields, now());
      reporter.flushDue(now());
      return false;
    },
    flushAll() {
      reporter.flushAll();
    },
  };
}
