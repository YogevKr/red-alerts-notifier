import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chooseNotifier,
  createOutboxReadyListenerSupervisor,
  listenForOutboxReady,
  processReservedJobs,
  processReservedJob,
} from "./notifier-worker.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

describe("processReservedJob", () => {
  it("When sent delivery cannot be persisted, then it marks the job uncertain", async () => {
    const calls = [];
    const outbox = {
      async markDispatchStarted() { calls.push("dispatch"); },
      async markSent() { throw new Error("db down"); },
      async markUncertain(id, message) { calls.push(["uncertain", id, message]); },
      async markFailed() { assert.fail("markFailed should not be called"); },
      async markDeadLettered() { assert.fail("markDeadLettered should not be called"); },
    };

    await processReservedJob(
      { id: 7, attempt_count: 1, chat_id: "telegram:1" },
      {
        outbox,
        logger: createLogger(),
        chooseNotifier: () => ({ send: async () => ({ skipped: false, transport: "telegram" }) }),
        now: () => Date.parse("2026-03-18T20:00:00Z"),
      },
    );

    assert.equal(calls[0], "dispatch");
    assert.equal(calls[1][0], "uncertain");
    assert.equal(calls[1][1], 7);
    assert.match(calls[1][2], /post-send state persistence failed after provider accepted delivery: db down/);
  });

  it("When transport is disabled, then it dead-letters the job immediately", async () => {
    const calls = [];
    const outbox = {
      async markDispatchStarted() { assert.fail("markDispatchStarted should not be called"); },
      async markDeadLettered(id, message) { calls.push(["dead", id, message]); },
      async markFailed() { assert.fail("markFailed should not be called"); },
      async markUncertain() { assert.fail("markUncertain should not be called"); },
    };
    const chooseDisabled = (job) => chooseNotifier(job, {
      activeTransportSet: new Set(["whatsapp"]),
      telegramNotifier: { send: async () => ({}) },
      whatsappNotifier: { send: async () => ({}) },
    });

    await processReservedJob(
      { id: 9, attempt_count: 1, chat_id: "telegram:123456789" },
      {
        outbox,
        logger: createLogger(),
        chooseNotifier: chooseDisabled,
      },
    );

    assert.deepEqual(calls, [[
      "dead",
      9,
      "notifier transport disabled: telegram",
    ]]);
  });

  it("When max attempts is reached, then it dead-letters instead of retrying forever", async () => {
    const calls = [];
    const outbox = {
      async markDispatchStarted() { calls.push("dispatch"); },
      async markDeadLettered(id, message) { calls.push(["dead", id, message]); },
      async markFailed() { assert.fail("markFailed should not be called"); },
      async markUncertain() { assert.fail("markUncertain should not be called"); },
      async markSent() { assert.fail("markSent should not be called"); },
    };

    await processReservedJob(
      { id: 12, attempt_count: 3, chat_id: "972500000000" },
      {
        outbox,
        logger: createLogger(),
        chooseNotifier: () => ({ send: async () => { throw new Error("template bad"); } }),
        maxAttempts: 3,
      },
    );

    assert.equal(calls[0], "dispatch");
    assert.deepEqual(calls[1], ["dead", 12, "template bad"]);
  });
});

describe("listenForOutboxReady", () => {
  it("registers for notifications and forwards matching events", async () => {
    const events = new Map();
    const calls = [];
    const notifications = [];
    const client = {
      async query(text) {
        calls.push(text);
        return { rows: [] };
      },
      on(event, handler) {
        events.set(event, handler);
      },
      off(event, handler) {
        if (events.get(event) === handler) {
          events.delete(event);
        }
      },
      release() {
        calls.push("release");
      },
    };

    const stop = await listenForOutboxReady({
      client,
      channel: "poller_notification_outbox_ready",
      onNotify: (message) => notifications.push(message.payload),
      logger: createLogger(),
    });

    events.get("notification")?.({
      channel: "poller_notification_outbox_ready",
      payload: "jobs_ready",
    });
    events.get("notification")?.({
      channel: "other_channel",
      payload: "ignore",
    });

    assert.deepEqual(notifications, ["jobs_ready"]);
    assert.equal(calls[0], "listen poller_notification_outbox_ready");

    await stop();

    assert.equal(calls[1], "unlisten poller_notification_outbox_ready");
    assert.equal(calls[2], "release");
  });

  it("releases the client when LISTEN setup fails", async () => {
    const events = new Map();
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        throw new Error("listen failed");
      },
      on(event, handler) {
        events.set(event, handler);
      },
      off(event, handler) {
        if (events.get(event) === handler) {
          events.delete(event);
        }
      },
      release() {
        calls.push("release");
      },
    };

    await assert.rejects(
      listenForOutboxReady({
        client,
        channel: "poller_notification_outbox_ready",
        logger: createLogger(),
      }),
      /listen failed/,
    );

    assert.deepEqual(calls, [
      "listen poller_notification_outbox_ready",
      "release",
    ]);
    assert.equal(events.size, 0);
  });
});

describe("createOutboxReadyListenerSupervisor", () => {
  it("reconnects after disconnect", async () => {
    const calls = [];
    const scheduled = [];
    const disconnects = [];
    let clientId = 0;

    const supervisor = createOutboxReadyListenerSupervisor({
      reconnectDelayMs: 250,
      connectClient: async () => ({ id: ++clientId }),
      listen: async ({ client, onDisconnect }) => {
        calls.push(`listen:${client.id}`);
        disconnects.push(onDisconnect);
        return async () => {
          calls.push(`stop:${client.id}`);
        };
      },
      scheduleReconnect: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return { callback, delayMs };
      },
      clearReconnect() {},
      logger: createLogger(),
    });

    const connected = await supervisor.start();
    assert.equal(connected, true);
    assert.deepEqual(calls, ["listen:1"]);

    await disconnects[0]({ reason: "end" });
    assert.equal(scheduled[0].delayMs, 250);

    await scheduled[0].callback();
    assert.deepEqual(calls, ["listen:1", "stop:1", "listen:2"]);
  });

  it("returns false when initial listener setup does not connect", async () => {
    const scheduled = [];
    let released = 0;
    const client = {
      async query() {
        throw new Error("listen failed");
      },
      on() {},
      off() {},
      removeListener() {},
      release() {
        released += 1;
      },
    };

    const supervisor = createOutboxReadyListenerSupervisor({
      reconnectDelayMs: 250,
      connectClient: async () => client,
      scheduleReconnect: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return { callback, delayMs };
      },
      clearReconnect() {},
      logger: createLogger(),
    });

    const connected = await supervisor.start();

    assert.equal(connected, false);
    assert.equal(released, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delayMs, 250);
  });
});

describe("processReservedJobs", () => {
  it("processes jobs up to the configured concurrency", async () => {
    const starts = [];
    const resolvers = [];
    let active = 0;
    let maxActive = 0;

    const run = processReservedJobs(
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      {
        concurrency: 2,
        processJob: async (job) => new Promise((resolve) => {
          starts.push(job.id);
          active += 1;
          maxActive = Math.max(maxActive, active);
          resolvers.push(() => {
            active -= 1;
            resolve();
          });
        }),
        logger: createLogger(),
      },
    );

    await Promise.resolve();
    assert.deepEqual(starts, [1, 2]);

    resolvers.shift()();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(starts, [1, 2, 3]);

    while (resolvers.length > 0) {
      resolvers.shift()();
    }
    await run;

    assert.equal(maxActive, 2);
  });
});
