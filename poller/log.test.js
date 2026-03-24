import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger, createSuppressionReporter } from "./log.js";

describe("createLogger", () => {
  it("serializes structured entries with nested error causes", () => {
    const entries = [];
    const logger = createLogger("poller", {
      level: "debug",
      now: () => "2026-03-18T16:00:00.000Z",
      write: (_level, entry) => {
        entries.push(entry);
      },
    });
    const err = new Error("outer");
    err.code = "OUTER";
    err.cause = new Error("inner");
    err.cause.code = "INNER";

    logger.warn("poll_failed", {
      error: err,
      source: "oref_history",
      count: 3,
    });

    assert.deepEqual(entries, [
      {
        ts: "2026-03-18T16:00:00.000Z",
        level: "warn",
        component: "poller",
        msg: "poll_failed",
        error: {
          name: "Error",
          message: "outer",
          code: "OUTER",
          status: null,
          cause: {
            name: "Error",
            message: "inner",
            code: "INNER",
            status: null,
          },
        },
        source: "oref_history",
        count: 3,
      },
    ]);
  });
});

describe("createSuppressionReporter", () => {
  it("aggregates repeated events into one summary", () => {
    const entries = [];
    const logger = createLogger("poller", {
      level: "info",
      now: () => "2026-03-18T16:00:00.000Z",
      write: (_level, entry) => {
        entries.push(entry);
      },
    });
    const reporter = createSuppressionReporter(logger, { intervalMs: 60_000 });

    reporter.record("seen_source_alert", "oref:1", {
      source: "oref_history",
      alert_key: "alert-1",
    }, 0);
    reporter.record("seen_source_alert", "oref:1", {
      source: "oref_history",
      alert_key: "alert-1",
    }, 30_000);
    reporter.record("seen_source_alert", "oref:1", {
      source: "oref_history",
      alert_key: "alert-1",
    }, 60_000);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].msg, "suppressed_events_summary");
    assert.equal(entries[0].suppression_kind, "seen_source_alert");
    assert.equal(entries[0].suppression_key, "oref:1");
    assert.equal(entries[0].count, 3);
    assert.equal(entries[0].window_ms, 60_000);
    assert.equal(entries[0].source, "oref_history");
    assert.equal(entries[0].alert_key, "alert-1");
  });
});
