import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveConfiguredAlertSinkNames } from "./alert-sinks.js";

describe("resolveConfiguredAlertSinkNames", () => {
  it("defaults to the outbox sink when a database url is configured", () => {
    assert.deepEqual(
      resolveConfiguredAlertSinkNames("", {
        databaseUrl: "postgresql://postgres:postgres@db:5432/red_alerts",
      }),
      ["notification_outbox"],
    );
  });

  it("defaults to the log sink when the poller has no database", () => {
    assert.deepEqual(resolveConfiguredAlertSinkNames(""), ["log"]);
  });

  it("keeps explicit sink selections", () => {
    assert.deepEqual(
      resolveConfiguredAlertSinkNames("log,notification_outbox,log", {
        databaseUrl: "postgresql://postgres:postgres@db:5432/red_alerts",
      }),
      ["log", "notification_outbox"],
    );
  });
});
