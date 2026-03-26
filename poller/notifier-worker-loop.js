export function createNotifierWorkerLoop({
  outbox,
  logger = console,
  activeNotifiers = [],
  pollIntervalMs = 1000,
  statusRefreshMs = 15_000,
  heartbeatIntervalMs = statusRefreshMs,
  reserveBatch = 5,
  maxConcurrency = reserveBatch,
  processReservedJobs,
  processJob,
  onHeartbeat = null,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  clearSchedule = (timer) => clearTimeout(timer),
  now = () => Date.now(),
} = {}) {
  let tickInFlight = false;
  let lastStatusRefreshAt = 0;
  let lastHeartbeatReportAt = null;
  let nextTickTimer = null;
  let immediateTickRequested = false;

  async function reportHeartbeat(patch = {}, timestampMs = now()) {
    if (typeof onHeartbeat !== "function") return;
    try {
      await onHeartbeat({
        lastHeartbeatAt: new Date(timestampMs).toISOString(),
        ...patch,
      });
    } catch (err) {
      logger.warn?.("notifier_worker_heartbeat_report_failed", {
        error: err,
      });
    }
  }

  function scheduleNext(delayMs = pollIntervalMs) {
    if (nextTickTimer) {
      clearSchedule(nextTickTimer);
    }
    const nextDelayMs = immediateTickRequested ? 0 : delayMs;
    nextTickTimer = schedule(async () => {
      nextTickTimer = null;
      await tick();
    }, nextDelayMs);
    nextTickTimer?.unref?.();
  }

  async function tick() {
    if (tickInFlight) {
      immediateTickRequested = true;
      return;
    }

    tickInFlight = true;
    immediateTickRequested = false;
    try {
      const currentNow = now();
      if (
        !Number.isFinite(lastHeartbeatReportAt)
        || currentNow - lastHeartbeatReportAt >= heartbeatIntervalMs
      ) {
        await reportHeartbeat({}, currentNow);
        lastHeartbeatReportAt = currentNow;
      }

      const uncertainJobs = await outbox.recoverStaleDispatches(currentNow);
      for (const job of uncertainJobs) {
        logger.warn?.("outbox_job_marked_uncertain", {
          outbox_id: job.id || null,
          delivery_key: job.delivery_key,
          outbox_status: job.status,
          last_error: job.last_error || null,
        });
      }

      const jobs = await outbox.reserve({
        limit: reserveBatch,
        now: currentNow,
      });

      if (jobs.length === 0) {
        if (currentNow - lastStatusRefreshAt >= statusRefreshMs) {
          let statusRefreshError = null;
          try {
            const results = await Promise.allSettled(
              activeNotifiers.map(([, notifier]) => notifier.refreshStatus()),
            );
            const rejected = results
              .filter((result) => result.status === "rejected")
              .map((result) => result.reason?.message || String(result.reason || "unknown"));
            statusRefreshError = rejected.length > 0 ? rejected.join("; ") : null;
          } catch (err) {
            statusRefreshError = err?.message || String(err);
            logger.warn?.("notifier_status_refresh_failed", {
              error: err,
            });
          } finally {
            lastStatusRefreshAt = currentNow;
            await reportHeartbeat({
              lastStatusRefreshAt: new Date(currentNow).toISOString(),
              lastError: statusRefreshError,
            }, currentNow);
            lastHeartbeatReportAt = currentNow;
          }
        }
        return;
      }

      await processReservedJobs(jobs, {
        concurrency: maxConcurrency,
        outbox,
        logger,
        processJob,
      });
    } finally {
      tickInFlight = false;
      const nextDelayMs = immediateTickRequested ? 0 : pollIntervalMs;
      immediateTickRequested = false;
      scheduleNext(nextDelayMs);
    }
  }

  return {
    start() {
      scheduleNext(0);
    },
    stop() {
      if (nextTickTimer) {
        clearSchedule(nextTickTimer);
        nextTickTimer = null;
      }
    },
    requestImmediateTick() {
      immediateTickRequested = true;
      if (tickInFlight) {
        return;
      }
      scheduleNext(0);
    },
    tick,
  };
}
