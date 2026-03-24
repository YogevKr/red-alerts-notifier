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
      ACTIVE_SOURCES: "oref_history,oref_mqtt",
      OREF_MQTT_ENABLED: "true",
      OREF_MQTT_RAW_LOG_ENABLED: "true",
      OREF_ALERTS_POLL_INTERVAL_MS: "1000",
      OREF_HISTORY_POLL_INTERVAL_MS: "5000",
      POLL_INTERVAL_MS: "2000",
      TZEVAADOM_ENABLED: "true",
      TZEVAADOM_RAW_LOG_ENABLED: "true",
    });

    assert.deepEqual(config.locations, ["תל אביב - יפו"]);
    assert.deepEqual(config.targetChatIds, ["telegram:1", "972500000000"]);
    assert.deepEqual(config.testChatIds, ["telegram:9"]);
    assert.deepEqual(config.configuredNotifierTransports, ["telegram", "whatsapp"]);
    assert.deepEqual(config.alertSinks.names, ["log"]);
    assert.deepEqual(config.sources.activeNames, ["oref_history", "oref_mqtt"]);
    assert.deepEqual(config.sources.polledNames, ["oref_history"]);
    assert.deepEqual(config.sources.realtimeNames, ["oref_mqtt"]);
    assert.equal(config.timing.pollTickIntervalMs, 5000);
    assert.equal(config.orefMqtt.enabled, true);
    assert.deepEqual(config.orefMqtt.topics, ["com.alert.meserhadash"]);
    assert.equal(config.orefMqtt.rawLogEnabled, true);
    assert.equal(config.tzevaadom.enabled, false);
    assert.equal(config.tzevaadom.rawLogEnabled, false);
  });

  it("falls back to legacy enabled source flags when ACTIVE_SOURCES is unset", () => {
    const config = createPollerConfig({
      WHATSAPP_TARGETS: "telegram:1",
      TZEVAADOM_ENABLED: "true",
      OREF_MQTT_ENABLED: "true",
      POLLER_DATABASE_URL: "postgresql://postgres:postgres@db:5432/red_alerts",
    });

    assert.deepEqual(config.alertSinks.names, ["notification_outbox"]);
    assert.deepEqual(config.sources.activeNames, [
      "oref_alerts",
      "oref_history",
      "oref_mqtt",
      "tzevaadom",
    ]);
    assert.deepEqual(config.orefMqtt.topics, ["com.alert.meserhadash"]);
  });
});
