import { createAlertProcessingSummary } from "./alert-pipeline.js";
import { applySourceHealthUpdate } from "./monitor-state.js";

function hasPollActivity(pollSummary = {}) {
  if (Number(pollSummary.matched_alert_count || 0) > 0) return true;
  if (Number(pollSummary.enqueued_target_count || 0) > 0) return true;
  if (Number(pollSummary.duplicate_enqueue_count || 0) > 0) return true;
  if (Number(pollSummary.seen_skipped_count || 0) > 0) return true;

  return Object.values(pollSummary.source_results || {}).some((result) =>
    result?.ok === false || Boolean(result?.error),
  );
}

export function createPollRuntime({
  logger = console,
  monitor,
  suppressionReporter,
  sourceConfigs = [],
  collectRealtimeSourceResults = async () => ({}),
  sourceTimeoutMs,
  fetchSourceSnapshot,
  sortAlertsByDate,
  captureEntriesBySource,
  debugCaptureStores,
  seedAlerts = async () => ({
    seededDeliveries: 0,
    seededSourceAlerts: 0,
  }),
  ingestAlerts = async () => [],
  pruneSourceEventLedger = async () => 0,
  toIsoString,
  syncPagerDutyHealth,
  summarizeSourceResults,
} = {}) {
  const sourceLastPolledAt = new Map();

  function updateSourceFailureState(sourceResults = {}, now = Date.now()) {
    const nowIso = toIsoString(now);
    for (const source of Object.keys(monitor.sourceFailures || {})) {
      const result = sourceResults[source];
      if (!result) continue;
      applySourceHealthUpdate(monitor, {
        source,
        ok: Boolean(result.ok),
        error: result.error || null,
        checkedAt: nowIso,
      });
    }
  }

  async function fetchPolledSource(source = {}) {
    const startedAt = Date.now();
    try {
      const { alerts, rawRecords } = await fetchSourceSnapshot(source.url, {
        normalizer: source.normalizer,
        rawExtractor: source.rawExtractor,
        timeoutMs: sourceTimeoutMs,
      });
      const receivedAt = toIsoString();
      return {
        name: source.name,
        ok: true,
        error: null,
        alerts: alerts.map((alert) => ({
          ...alert,
          receivedAt: alert.receivedAt || receivedAt,
        })),
        rawRecords,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        name: source.name,
        ok: false,
        error: err.message,
        alerts: [],
        rawRecords: [],
        durationMs: Date.now() - startedAt,
      };
    }
  }

  function shouldPollSource(source = {}, nowMs, forceAllSources = false) {
    if (forceAllSources) return true;

    const pollIntervalMs = Number(source.pollIntervalMs || 0);
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) return true;

    const lastPolledAt = sourceLastPolledAt.get(source.name);
    return !Number.isFinite(lastPolledAt) || nowMs - lastPolledAt >= pollIntervalMs;
  }

  async function fetchPolledAlertBatch({
    forceAllSources = false,
    nowMs = Date.now(),
  } = {}) {
    const dueSources = sourceConfigs.filter((source) =>
      shouldPollSource(source, nowMs, forceAllSources));
    for (const source of dueSources) {
      sourceLastPolledAt.set(source.name, nowMs);
    }

    const polledResults = await Promise.all(
      dueSources.map((source) => fetchPolledSource(source)),
    );

    return {
      alerts: sortAlertsByDate(polledResults.flatMap((result) => result.alerts)),
      rawRecords: polledResults.flatMap((result) =>
        result.rawRecords.map((entry) => ({
          source: result.name,
          ...entry,
        }))),
      sourceResults: Object.fromEntries(
        polledResults.map((result) => [
          result.name,
          {
            ok: result.ok,
            error: result.error,
            count: result.alerts.length,
            rawCount: result.rawRecords.length,
            durationMs: result.durationMs || 0,
          },
        ]),
      ),
    };
  }

  async function fetchPolledAlerts(options = {}) {
    return (await fetchPolledAlertBatch(options)).alerts;
  }

  async function seedExistingAlerts() {
    return seedAlerts(await fetchPolledAlerts({ forceAllSources: true }));
  }

  async function poll() {
    const now = Date.now();
    const startedAt = Date.now();
    monitor.lastPollAt = toIsoString(now);
    const pollSummary = {
      raw_record_count: 0,
      polled_alert_count: 0,
      source_results: {},
      ...createAlertProcessingSummary(),
    };

    try {
      const { alerts, rawRecords, sourceResults } = await fetchPolledAlertBatch();
      const realtimeSourceResults = await collectRealtimeSourceResults();
      const combinedSourceResults = {
        ...sourceResults,
        ...realtimeSourceResults,
      };

      pollSummary.raw_record_count = rawRecords.length;
      pollSummary.polled_alert_count = alerts.length;
      pollSummary.source_results = summarizeSourceResults(combinedSourceResults);
      updateSourceFailureState(combinedSourceResults, now);

      captureEntriesBySource(
        debugCaptureStores,
        rawRecords.map((entry) => ({
          kind: "oref_raw",
          source: entry.source,
          matchedLocations: entry.matchedLocations,
          payload: entry.payload,
        })),
        { touchDuplicates: false },
      );

      await ingestAlerts(alerts, {
        summary: pollSummary,
      });

      try {
        await pruneSourceEventLedger({ nowMs: now });
      } catch (err) {
        logger.warn?.("source_event_ledger_prune_failed", {
          error: err,
        });
      }

      monitor.consecutivePollErrors = 0;
      monitor.lastPollSuccessAt = toIsoString(now);
      monitor.lastPollError = null;
      suppressionReporter.flushDue(Date.now());
      const pollCompletedLevel = hasPollActivity(pollSummary) ? "info" : "debug";
      logger[pollCompletedLevel]?.("poll_completed", {
        duration_ms: Date.now() - startedAt,
        ...pollSummary,
      });
      await syncPagerDutyHealth(now);
    } catch (err) {
      monitor.consecutivePollErrors += 1;
      monitor.lastPollErrorAt = toIsoString(now);
      monitor.lastPollError = err.message;
      suppressionReporter.flushDue(Date.now());
      logger.error("poll_failed", {
        duration_ms: Date.now() - startedAt,
        consecutive_poll_errors: monitor.consecutivePollErrors,
        ...pollSummary,
        error: err,
      });
      await syncPagerDutyHealth(now);
    }
  }

  return {
    fetchPolledAlertBatch,
    fetchPolledAlerts,
    seedExistingAlerts,
    poll,
  };
}
