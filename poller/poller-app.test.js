import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPollScheduler } from "./poller-app.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createPollScheduler", () => {
  it("coalesces overlapping poll ticks into one extra run", async () => {
    const firstRun = createDeferred();
    let callCount = 0;
    const scheduler = createPollScheduler({
      poll: async () => {
        callCount += 1;
        if (callCount === 1) {
          await firstRun.promise;
        }
      },
      logger: { debug() {}, warn() {} },
    });

    const scheduled = scheduler.schedule("tick");
    scheduler.schedule("tick");
    scheduler.schedule("tick");

    assert.equal(callCount, 1);
    firstRun.resolve();
    await scheduled;
    assert.equal(callCount, 2);
  });

  it("warns once when a poll stays busy past the stale threshold", async () => {
    const firstRun = createDeferred();
    const warnings = [];
    let nowMs = 0;
    const scheduler = createPollScheduler({
      poll: async () => {
        await firstRun.promise;
      },
      logger: {
        debug() {},
        warn(message, fields) {
          warnings.push({ message, fields });
        },
      },
      now: () => nowMs,
      staleThresholdMs: 20_000,
    });

    const scheduled = scheduler.schedule("tick");
    nowMs = 10_000;
    scheduler.schedule("tick");
    nowMs = 25_000;
    scheduler.schedule("tick");
    nowMs = 30_000;
    scheduler.schedule("tick");

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].message, "poll_running_long");
    assert.equal(warnings[0].fields.stale_threshold_ms, 20_000);
    firstRun.resolve();
    await scheduled;
  });
});
