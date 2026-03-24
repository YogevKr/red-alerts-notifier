import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNotifierWorkerLoop } from "./notifier-worker-loop.js";

describe("createNotifierWorkerLoop", () => {
  it("wakes immediately when notified instead of waiting for the next poll", async () => {
    const scheduled = [];
    const calls = [];
    const loop = createNotifierWorkerLoop({
      outbox: {
        async recoverStaleDispatches() {
          calls.push("recover");
          return [];
        },
        async reserve() {
          calls.push("reserve");
          return [];
        },
      },
      logger: { warn() {} },
      activeNotifiers: [],
      pollIntervalMs: 1000,
      statusRefreshMs: 15_000,
      reserveBatch: 5,
      maxConcurrency: 5,
      processReservedJobs: async () => {},
      processJob: async () => {},
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return { callback, delayMs };
      },
      clearSchedule() {},
      now: (() => {
        let value = 0;
        return () => value += 100;
      })(),
    });

    loop.start();
    assert.equal(scheduled[0].delayMs, 0);

    await scheduled[0].callback();
    assert.deepEqual(calls, ["recover", "reserve"]);
    assert.equal(scheduled[1].delayMs, 1000);

    loop.requestImmediateTick();
    assert.equal(scheduled[2].delayMs, 0);
  });
});
