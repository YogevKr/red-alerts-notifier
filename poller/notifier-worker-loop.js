export function createNotifierWorkerLoop({
  outbox,
  logger = console,
  activeNotifiers = [],
  pollIntervalMs = 1000,
  statusRefreshMs = 15_000,
  reserveBatch = 5,
  maxConcurrency = reserveBatch,
  processReservedJobs,
  processJob,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  clearSchedule = (timer) => clearTimeout(timer),
  now = () => Date.now(),
} = {}) {
  let tickInFlight = false;
  let lastStatusRefreshAt = 0;
  let nextTickTimer = null;
  let immediateTickRequested = false;

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
          try {
            await Promise.allSettled(activeNotifiers.map(([, notifier]) => notifier.refreshStatus()));
          } catch (err) {
            logger.warn?.("notifier_status_refresh_failed", {
              error: err,
            });
          } finally {
            lastStatusRefreshAt = currentNow;
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
