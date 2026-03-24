import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPollerConfig } from "./config.js";

describe("createPollerConfig", () => {
  it("parses polling intervals, targets, notifier transports, and active sources", () => {
    const config = createPollerConfig({
      ALERT_LOCATIONS: "תל אביב - יפו",
      WHATSAPP_TARGETS: "telegram:1,972500000000",
      TEST_NOTIFICATION_TARGETS: "telegram:9",
      NOTIFIER_ACTIVE_TRANSPORTS: "",
      ACTIVE_SOURCES: "oref_history,tzevaadom",
      OREF_ALERTS_POLL_INTERVAL_MS: "1000",
      OREF_HISTORY_POLL_INTERVAL_MS: "5000",
      POLL_INTERVAL_MS: "2000",
      TZEVAADOM_RAW_LOG_ENABLED: "true",
    });

    assert.deepEqual(config.locations, ["תל אביב - יפו"]);
    assert.deepEqual(config.targetChatIds, ["telegram:1", "972500000000"]);
    assert.deepEqual(config.testChatIds, ["telegram:9"]);
    assert.deepEqual(config.configuredNotifierTransports, ["telegram", "whatsapp"]);
    assert.deepEqual(config.sources.activeNames, ["oref_history", "tzevaadom"]);
    assert.deepEqual(config.sources.polledNames, ["oref_history"]);
    assert.deepEqual(config.sources.realtimeNames, ["tzevaadom"]);
    assert.equal(config.timing.pollTickIntervalMs, 5000);
    assert.equal(config.tzevaadom.rawLogEnabled, true);
  });
});
