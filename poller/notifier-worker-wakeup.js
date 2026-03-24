import {
  LISTEN_OUTBOX_READY_SQL,
  NOTIFICATION_OUTBOX_NOTIFY_CHANNEL,
  UNLISTEN_OUTBOX_READY_SQL,
} from "./outbox-schema.js";

export async function listenForOutboxReady({
  client,
  channel = NOTIFICATION_OUTBOX_NOTIFY_CHANNEL,
  onNotify = () => {},
  onDisconnect = null,
  logger = console,
} = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("listener client is required");
  }

  let stopped = false;
  let listening = false;

  const handleNotification = (message = {}) => {
    if (message.channel !== channel) return;
    logger.debug?.("outbox_ready_notified", {
      channel,
      payload: message.payload || null,
    });
    onNotify(message);
  };
  const handleError = (err) => {
    if (stopped) return;
    logger.warn?.("outbox_ready_listener_error", {
      channel,
      error: err,
    });
    onDisconnect?.({
      channel,
      reason: "error",
      error: err,
    });
  };
  const handleEnd = () => {
    if (stopped) return;
    logger.warn?.("outbox_ready_listener_ended", {
      channel,
    });
    onDisconnect?.({
      channel,
      reason: "end",
      error: null,
    });
  };

  async function cleanup({ shouldUnlisten = listening } = {}) {
    if (stopped) return;
    stopped = true;
    client.off?.("notification", handleNotification);
    client.off?.("error", handleError);
    client.off?.("end", handleEnd);
    client.removeListener?.("notification", handleNotification);
    client.removeListener?.("error", handleError);
    client.removeListener?.("end", handleEnd);
    try {
      if (shouldUnlisten) {
        await client.query(UNLISTEN_OUTBOX_READY_SQL);
      }
    } finally {
      client.release?.();
    }
  }

  client.on?.("notification", handleNotification);
  client.on?.("error", handleError);
  client.on?.("end", handleEnd);

  try {
    await client.query(LISTEN_OUTBOX_READY_SQL);
    listening = true;
  } catch (err) {
    try {
      await cleanup({ shouldUnlisten: false });
    } catch {}
    throw err;
  }

  return async () => cleanup({ shouldUnlisten: listening });
}

export function createOutboxReadyListenerSupervisor({
  channel = NOTIFICATION_OUTBOX_NOTIFY_CHANNEL,
  reconnectDelayMs = 5000,
  connectClient = async () => {
    throw new Error("connectClient is required");
  },
  listen = listenForOutboxReady,
  onNotify = () => {},
  logger = console,
  scheduleReconnect = (callback, delayMs) => setTimeout(callback, delayMs),
  clearReconnect = (timer) => clearTimeout(timer),
} = {}) {
  let started = false;
  let stopped = false;
  let connecting = false;
  let reconnectTimer = null;
  let stopListening = null;
  let activeConnectionId = 0;

  async function cleanupCurrentListener() {
    if (!stopListening) return;
    const stop = stopListening;
    stopListening = null;
    try {
      await stop();
    } catch {}
  }

  function scheduleReconnectAttempt(details = {}) {
    if (stopped || reconnectTimer) return;
    reconnectTimer = scheduleReconnect(async () => {
      reconnectTimer = null;
      await connect();
    }, reconnectDelayMs);
    reconnectTimer?.unref?.();
    logger.warn?.("outbox_ready_listener_reconnect_scheduled", {
      channel,
      reconnect_delay_ms: reconnectDelayMs,
      reason: details.reason || "connect_failed",
      error: details.error || null,
    });
  }

  async function connect() {
    if (stopped || connecting) return false;
    connecting = true;
    try {
      const client = await connectClient();
      const connectionId = activeConnectionId + 1;
      activeConnectionId = connectionId;
      let disconnecting = false;
      let localStop = null;
      const handleDisconnect = async (details = {}) => {
        if (disconnecting || stopped || connectionId !== activeConnectionId) return;
        disconnecting = true;
        if (stopListening === localStop) {
          stopListening = null;
        }
        try {
          await localStop?.();
        } catch {}
        scheduleReconnectAttempt(details);
      };

      localStop = await listen({
        client,
        channel,
        onNotify,
        onDisconnect: handleDisconnect,
        logger,
      });
      stopListening = localStop;
      logger.info?.("outbox_ready_listener_connected", {
        channel,
      });
      return true;
    } catch (err) {
      scheduleReconnectAttempt({
        reason: "connect_failed",
        error: err,
      });
      return false;
    } finally {
      connecting = false;
    }
  }

  return {
    async start() {
      if (started) return Boolean(stopListening);
      started = true;
      stopped = false;
      return connect();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearReconnect(reconnectTimer);
        reconnectTimer = null;
      }
      await cleanupCurrentListener();
    },
  };
}
