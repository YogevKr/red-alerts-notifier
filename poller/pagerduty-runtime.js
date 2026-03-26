export function createPagerDutyRuntime({
  pagerDuty,
  monitor,
  dbPool,
  notificationOutbox,
  runtimeStartedAt = Date.now(),
  logger = console,
  configuredNotifierTransports = [],
  activeSourceNames = [],
  toIsoString,
  formatDisconnectedSince,
  getSourceFailureSnapshot,
  getNotifierStateSnapshot,
  resolveActiveEvolutionInstance,
  evolutionInstance,
  checkDbConnection,
  hasExceededThreshold,
  getOutboxBacklogAgeMs,
  hasOutboxBacklogExceededThreshold,
  hasNotifierTransport,
  whatsappDisconnectThresholdMs,
  sourceFailureThreshold,
  pollErrorThreshold,
  dbDisconnectThresholdMs,
  outboxBacklogThresholdMs,
  notifierStaleThresholdMs,
  telegramBotStaleThresholdMs,
  tzevaadomDisconnectThresholdMs,
} = {}) {
  const activeSourceSet = new Set(
    (Array.isArray(activeSourceNames) ? activeSourceNames : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );

  function hasActiveSource(source = "") {
    return activeSourceSet.has(String(source || "").trim().toLowerCase());
  }

  async function checkDatabaseHealth(now = Date.now()) {
    const checkedAt = toIsoString(now);
    if (!dbPool) {
      const err = new Error("POLLER_DATABASE_URL is not configured");
      monitor.dbLastCheckedAt = checkedAt;
      monitor.dbLastError = err.message;
      monitor.dbLatencyMs = null;
      monitor.dbDatabaseName = null;
      monitor.dbServerTime = null;
      if (!Number.isFinite(monitor.dbDisconnectedSince)) {
        monitor.dbDisconnectedSince = now;
      }
      throw err;
    }

    try {
      const snapshot = await checkDbConnection(dbPool, now);
      monitor.dbLastCheckedAt = snapshot.checkedAt;
      monitor.dbLastError = null;
      monitor.dbLatencyMs = snapshot.latencyMs;
      monitor.dbDatabaseName = snapshot.databaseName;
      monitor.dbServerTime = snapshot.serverTime;
      monitor.dbDisconnectedSince = null;
      return snapshot;
    } catch (err) {
      monitor.dbLastCheckedAt = checkedAt;
      monitor.dbLastError = err.message;
      monitor.dbLatencyMs = null;
      monitor.dbServerTime = null;
      if (!Number.isFinite(monitor.dbDisconnectedSince)) {
        monitor.dbDisconnectedSince = now;
      }
      throw err;
    }
  }

  async function getOutboxStatsSnapshot(now = Date.now(), { includeLatency = true } = {}) {
    if (!notificationOutbox) return null;

    const checkedAt = toIsoString(now);
    try {
      const stats = await notificationOutbox.getStats({ includeLatency });
      monitor.outboxLastCheckedAt = checkedAt;
      monitor.outboxLastError = null;
      return stats;
    } catch (err) {
      monitor.outboxLastCheckedAt = checkedAt;
      monitor.outboxLastError = err.message;
      throw err;
    }
  }

  async function syncPagerDutyWhatsApp(now = Date.now()) {
    if (!hasNotifierTransport(configuredNotifierTransports, "whatsapp")) {
      monitor.whatsappLastCheckedAt = null;
      monitor.whatsappLastError = null;
      monitor.whatsappDisconnectedSince = null;
      await pagerDuty.resolveIncident({
        dedupKey: "whatsapp-disconnected",
      });
      return;
    }

    const checkedAt = toIsoString(now);
    try {
      await resolveActiveEvolutionInstance();
      monitor.whatsappLastCheckedAt = checkedAt;
      monitor.whatsappLastError = null;
      monitor.whatsappDisconnectedSince = null;
      await pagerDuty.resolveIncident({
        dedupKey: "whatsapp-disconnected",
      });
    } catch (err) {
      monitor.whatsappLastCheckedAt = checkedAt;
      monitor.whatsappLastError = err.message;
      if (!Number.isFinite(monitor.whatsappDisconnectedSince)) {
        monitor.whatsappDisconnectedSince = now;
      }

      if (
        hasExceededThreshold(
          monitor.whatsappDisconnectedSince,
          whatsappDisconnectThresholdMs,
          now,
        )
      ) {
        await pagerDuty.triggerIncident({
          dedupKey: "whatsapp-disconnected",
          summary: "WhatsApp connection check failed",
          severity: "critical",
          customDetails: {
            instance: monitor.whatsappActiveInstance || evolutionInstance,
            primaryInstance: monitor.whatsappPrimaryInstance,
            primaryState: monitor.whatsappPrimaryState,
            fallbackInstance: monitor.whatsappFallbackInstance,
            fallbackState: monitor.whatsappFallbackState,
            disconnectedSince: toIsoString(monitor.whatsappDisconnectedSince),
            lastCheckedAt: checkedAt,
            error: err.message,
          },
        });
      }
    }
  }

  async function syncPagerDutyOrefSources(now = Date.now()) {
    const allSourcesFailing = Object.values(monitor.sourceFailures).length > 0
      && Object.values(monitor.sourceFailures).every(
        (state) => (state?.consecutiveFailures || 0) >= sourceFailureThreshold,
      );

    if (!allSourcesFailing) {
      await pagerDuty.resolveIncident({
        dedupKey: "oref-sources-unavailable",
      });
      return;
    }

    await pagerDuty.triggerIncident({
      dedupKey: "oref-sources-unavailable",
      summary: "All alert sources are failing",
      severity: "critical",
      customDetails: {
        threshold: sourceFailureThreshold,
        checkedAt: toIsoString(now),
        sources: getSourceFailureSnapshot(),
      },
    });
  }

  async function syncPagerDutyPollLoop(now = Date.now()) {
    if (monitor.consecutivePollErrors < pollErrorThreshold) {
      await pagerDuty.resolveIncident({
        dedupKey: "poll-loop-error",
      });
      return;
    }

    await pagerDuty.triggerIncident({
      dedupKey: "poll-loop-error",
      summary: `Poll loop failing ${monitor.consecutivePollErrors} times in a row`,
      severity: "critical",
      customDetails: {
        checkedAt: toIsoString(now),
        consecutivePollErrors: monitor.consecutivePollErrors,
        lastPollErrorAt: monitor.lastPollErrorAt,
        lastPollError: monitor.lastPollError,
      },
    });
  }

  async function syncPagerDutyDatabase(now = Date.now()) {
    try {
      const snapshot = await checkDatabaseHealth(now);
      await pagerDuty.resolveIncident({
        dedupKey: "db-unavailable",
      });
      return snapshot;
    } catch (err) {
      if (
        hasExceededThreshold(
          monitor.dbDisconnectedSince,
          dbDisconnectThresholdMs,
          now,
        )
      ) {
        await pagerDuty.triggerIncident({
          dedupKey: "db-unavailable",
          summary: "Poller database health check failed",
          severity: "critical",
          customDetails: {
            checkedAt: toIsoString(now),
            disconnectedSince: formatDisconnectedSince(monitor.dbDisconnectedSince),
            lastError: err.message,
            database: monitor.dbDatabaseName,
          },
        });
      }
      return null;
    }
  }

  async function syncPagerDutyOutbox(now = Date.now(), outboxStats = null) {
    if (!notificationOutbox || !outboxStats) return;

    if (Number(outboxStats.uncertain || 0) > 0) {
      await pagerDuty.triggerIncident({
        dedupKey: "outbox-uncertain",
        summary: "Notification outbox has uncertain deliveries",
        severity: "critical",
        customDetails: {
          checkedAt: toIsoString(now),
          outbox: outboxStats,
        },
      });
    } else {
      await pagerDuty.resolveIncident({
        dedupKey: "outbox-uncertain",
      });
    }

    if (hasOutboxBacklogExceededThreshold(outboxStats, outboxBacklogThresholdMs, now)) {
      await pagerDuty.triggerIncident({
        dedupKey: "outbox-backlog",
        summary: "Notification outbox backlog is growing",
        severity: "critical",
        customDetails: {
          checkedAt: toIsoString(now),
          backlogAgeMs: getOutboxBacklogAgeMs(outboxStats, now),
          thresholdMs: outboxBacklogThresholdMs,
          outbox: outboxStats,
        },
      });
    } else {
      await pagerDuty.resolveIncident({
        dedupKey: "outbox-backlog",
      });
    }
  }

  async function syncPagerDutyOutboxAvailability(now = Date.now(), outboxError = null) {
    if (!notificationOutbox) return;

    if (!outboxError) {
      await pagerDuty.resolveIncident({
        dedupKey: "outbox-unavailable",
      });
      return;
    }

    await pagerDuty.triggerIncident({
      dedupKey: "outbox-unavailable",
      summary: "Notification outbox queries are failing",
      severity: "critical",
      customDetails: {
        checkedAt: toIsoString(now),
        lastError: outboxError.message || String(outboxError),
      },
    });
  }

  async function syncPagerDutyNotifier(now = Date.now(), notifierState = getNotifierStateSnapshot()) {
    if (
      !hasNotifierTransport(configuredNotifierTransports, "whatsapp")
      && !hasNotifierTransport(configuredNotifierTransports, "telegram")
    ) {
      await pagerDuty.resolveIncident({
        dedupKey: "notifier-stale",
      });
      return;
    }

    const lastHeartbeatAt = monitor.notifierWorkerLastHeartbeatAt || null;
    const lastHeartbeatMs = Date.parse(lastHeartbeatAt || "");

    if (
      Number.isFinite(lastHeartbeatMs)
      && !hasExceededThreshold(lastHeartbeatMs, notifierStaleThresholdMs, now)
    ) {
      await pagerDuty.resolveIncident({
        dedupKey: "notifier-stale",
      });
      return;
    }

    if (
      !Number.isFinite(lastHeartbeatMs)
      && !hasExceededThreshold(runtimeStartedAt, notifierStaleThresholdMs, now)
    ) {
      await pagerDuty.resolveIncident({
        dedupKey: "notifier-stale",
      });
      return;
    }

    await pagerDuty.triggerIncident({
      dedupKey: "notifier-stale",
      summary: "Notifier worker heartbeat is stale",
      severity: "critical",
      customDetails: {
        checkedAt: toIsoString(now),
        thresholdMs: notifierStaleThresholdMs,
        enabled: Boolean(monitor.notifierWorkerEnabled),
        workerId: monitor.notifierWorkerId || null,
        wakeupMode: monitor.notifierWorkerWakeupMode || null,
        lastHeartbeatAt,
        lastStatusRefreshAt: monitor.notifierWorkerLastStatusRefreshAt || null,
        lastError: monitor.notifierWorkerLastError || null,
        transports: configuredNotifierTransports,
        transportChecks: configuredNotifierTransports.map((transport) => ({
          transport,
          lastCheckedAt: transport === "telegram"
            ? (notifierState.telegramLastCheckedAt || null)
            : (notifierState.whatsappLastCheckedAt || null),
          lastError: transport === "telegram"
            ? (notifierState.telegramLastError || null)
            : (notifierState.whatsappLastError || null),
        })),
      },
    });
  }

  async function syncPagerDutyTelegramBot(now = Date.now()) {
    if (!hasNotifierTransport(configuredNotifierTransports, "telegram")) {
      await pagerDuty.resolveIncident({
        dedupKey: "telegram-bot-stale",
      });
      return;
    }

    const lastPollSuccessAt = monitor.telegramLastPollSuccessAt || null;
    const lastPollSuccessMs = Date.parse(lastPollSuccessAt || "");
    if (
      Number.isFinite(lastPollSuccessMs)
      && !hasExceededThreshold(lastPollSuccessMs, telegramBotStaleThresholdMs, now)
      && !monitor.telegramLastError
    ) {
      await pagerDuty.resolveIncident({
        dedupKey: "telegram-bot-stale",
      });
      return;
    }

    if (
      !Number.isFinite(lastPollSuccessMs)
      && !hasExceededThreshold(runtimeStartedAt, telegramBotStaleThresholdMs, now)
    ) {
      await pagerDuty.resolveIncident({
        dedupKey: "telegram-bot-stale",
      });
      return;
    }

    if (
      Number.isFinite(lastPollSuccessMs)
      && !hasExceededThreshold(lastPollSuccessMs, telegramBotStaleThresholdMs, now)
    ) {
      await pagerDuty.resolveIncident({
        dedupKey: "telegram-bot-stale",
      });
      return;
    }

    await pagerDuty.triggerIncident({
      dedupKey: "telegram-bot-stale",
      summary: "Telegram management bot health checks are stale",
      severity: "warning",
      customDetails: {
        checkedAt: toIsoString(now),
        thresholdMs: telegramBotStaleThresholdMs,
        enabled: Boolean(monitor.telegramEnabled),
        lastPollAt: monitor.telegramLastPollAt || null,
        lastPollSuccessAt,
        lastUpdateAt: monitor.telegramLastUpdateAt || null,
        lastCommandAt: monitor.telegramLastCommandAt || null,
        lastCommand: monitor.telegramLastCommand || null,
        lastError: monitor.telegramLastError || null,
      },
    });
  }

  async function syncPagerDutyTzevaadom(now = Date.now()) {
    if (!hasActiveSource("tzevaadom")) {
      await pagerDuty.resolveIncident({
        dedupKey: "tzevaadom-disconnected",
      });
      return;
    }

    const state = monitor.sourceFailures?.tzevaadom;
    const disconnectedSinceMs = Date.parse(state?.disconnectedSince || "");
    const lastError = String(state?.lastError || "");
    const isDisconnected = Number(state?.consecutiveFailures || 0) > 0
      && lastError.includes("disconnected");

    if (
      !isDisconnected
      || !Number.isFinite(disconnectedSinceMs)
      || !hasExceededThreshold(disconnectedSinceMs, tzevaadomDisconnectThresholdMs, now)
    ) {
      await pagerDuty.resolveIncident({
        dedupKey: "tzevaadom-disconnected",
      });
      return;
    }

    await pagerDuty.triggerIncident({
      dedupKey: "tzevaadom-disconnected",
      summary: "Tzevaadom stream is disconnected",
      severity: "warning",
      customDetails: {
        checkedAt: toIsoString(now),
        disconnectedSince: state.disconnectedSince,
        thresholdMs: tzevaadomDisconnectThresholdMs,
        consecutiveFailures: state.consecutiveFailures,
        lastFailureAt: state.lastFailureAt,
        lastError,
      },
    });
  }

  async function syncPagerDutyHealth(now = Date.now()) {
    if (!pagerDuty.enabled) return;

    const notifierState = getNotifierStateSnapshot();
    const dbSnapshot = await syncPagerDutyDatabase(now);
    let outboxError = null;
    const outboxStats = dbSnapshot
      ? await getOutboxStatsSnapshot(now).catch((err) => {
        outboxError = err;
        logger.warn("outbox_stats_fetch_failed", {
          error: err,
        });
        return null;
      })
      : null;

    const results = await Promise.allSettled([
      syncPagerDutyWhatsApp(now),
      syncPagerDutyOrefSources(now),
      syncPagerDutyPollLoop(now),
      syncPagerDutyOutboxAvailability(now, outboxError),
      syncPagerDutyOutbox(now, outboxStats),
      syncPagerDutyNotifier(now, notifierState),
      syncPagerDutyTelegramBot(now),
      syncPagerDutyTzevaadom(now),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("pagerduty_sync_failed", {
          error: result.reason,
        });
      }
    }
  }

  return {
    checkDatabaseHealth,
    getOutboxStatsSnapshot,
    syncPagerDutyHealth,
  };
}
