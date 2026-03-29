import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPollerConfig } from "./config.js";

describe("createPollerConfig", () => {
  it("parses polling intervals, targets, notifier transports, and active sources", () => {
    const config = createPollerConfig({
      ALERT_LOCATIONS: "תל אביב - יפו",
      WHATSAPP_TARGETS: "telegram:1,972500000000",
      WHATSAPP_TARGET_STAGGER_MS: "2000",
      TEST_NOTIFICATION_TARGETS: "telegram:9",
      NOTIFIER_ACTIVE_TRANSPORTS: "",
      ACTIVE_SOURCES: "oref_history,oref_mqtt",
      OREF_MQTT_ENABLED: "true",
      OREF_MQTT_TOPICS: "com.alert.meserhadash,alerts",
      OREF_MQTT_RAW_LOG_ENABLED: "true",
      OREF_MQTT_ROTATE_MS: "60000",
      OREF_MQTT_LISTENER_COUNT: "3",
      OREF_ALERTS_POLL_INTERVAL_MS: "1000",
      OREF_HISTORY_POLL_INTERVAL_MS: "20000",
      POLL_INTERVAL_MS: "2000",
      EVOLUTION_TIMEOUT_MS: "30000",
      TZEVAADOM_ENABLED: "true",
      TZEVAADOM_RAW_LOG_ENABLED: "true",
    });

    assert.deepEqual(config.locations, ["תל אביב - יפו"]);
    assert.deepEqual(config.targetChatIds, ["telegram:1", "972500000000"]);
    assert.deepEqual(config.testChatIds, ["telegram:9"]);
    assert.deepEqual(config.configuredNotifierTransports, ["telegram", "whatsapp"]);
    assert.deepEqual(config.alertSinks.names, ["log"]);
    assert.equal(config.alertSinks.whatsappTargetStaggerMs, 2000);
    assert.deepEqual(config.sources.activeNames, ["oref_history", "oref_mqtt"]);
    assert.deepEqual(config.sources.polledNames, ["oref_history"]);
    assert.deepEqual(config.sources.realtimeNames, ["oref_mqtt"]);
    assert.equal(config.timing.pollTickIntervalMs, 20000);
    assert.equal(config.orefMqtt.enabled, true);
    assert.equal(config.orefMqtt.rotateIntervalMs, 60000);
    assert.equal(config.orefMqtt.listenerCount, 3);
    assert.deepEqual(config.orefMqtt.brokerUrls, []);
    assert.equal(config.orefMqtt.topicsExplicit, true);
    assert.deepEqual(config.orefMqtt.topics, ["com.alert.meserhadash", "alerts"]);
    assert.equal(config.orefMqtt.rawLogEnabled, true);
    assert.equal(config.tzevaadom.enabled, false);
    assert.equal(config.tzevaadom.rawLogEnabled, false);
    assert.equal(config.evolution.timeoutMs, 30000);
  });

  it("falls back to legacy enabled source flags when ACTIVE_SOURCES is unset", () => {
    const config = createPollerConfig({
      WHATSAPP_TARGETS: "telegram:1",
      TZEVAADOM_ENABLED: "true",
      OREF_MQTT_ENABLED: "true",
      OREF_MQTT_TOPICS: "com.alert.meserhadash,alerts",
      POLLER_DATABASE_URL: "postgresql://postgres:postgres@db:5432/red_alerts",
    });

    assert.deepEqual(config.alertSinks.names, ["notification_outbox"]);
    assert.deepEqual(config.sources.activeNames, [
      "oref_alerts",
      "oref_mqtt",
      "tzevaadom",
    ]);
    assert.deepEqual(config.orefMqtt.topics, ["com.alert.meserhadash", "alerts"]);
    assert.equal(config.orefMqtt.topicsExplicit, true);
  });

  it("keeps source event ledger off by default and allows opt-in", () => {
    const defaultConfig = createPollerConfig({
      WHATSAPP_TARGETS: "telegram:1",
    });
    const enabledConfig = createPollerConfig({
      WHATSAPP_TARGETS: "telegram:1",
      SOURCE_EVENT_LEDGER_ENABLED: "true",
    });

    assert.equal(defaultConfig.sourceEventLedger.enabled, false);
    assert.equal(enabledConfig.sourceEventLedger.enabled, true);
  });

  it("uses the full documented mqtt topic set by default", () => {
    const config = createPollerConfig({
      WHATSAPP_TARGETS: "telegram:1",
      OREF_MQTT_ENABLED: "true",
      ACTIVE_SOURCES: "oref_mqtt",
    });

    assert.deepEqual(config.orefMqtt.topics, [
      "com.alert.meserhadash",
      "alerts",
      "all",
      "broadcast",
    ]);
    assert.equal(config.orefMqtt.topicsExplicit, false);
    assert.equal(config.orefMqtt.rotateIntervalMs, 300000);
    assert.equal(config.orefMqtt.listenerCount, 2);
  });

  it("prefers explicit mqtt broker urls over derived listener count", () => {
    const config = createPollerConfig({
      WHATSAPP_TARGETS: "telegram:1",
      OREF_MQTT_ENABLED: "true",
      ACTIVE_SOURCES: "oref_mqtt",
      OREF_MQTT_LISTENER_COUNT: "5",
      OREF_MQTT_BROKER_URLS: "mqtts://mqtt-a.ioref.io:443,mqtts://mqtt-b.ioref.io:443",
    });

    assert.equal(config.orefMqtt.listenerCount, 2);
    assert.deepEqual(config.orefMqtt.brokerUrls, [
      "mqtts://mqtt-a.ioref.io:443",
      "mqtts://mqtt-b.ioref.io:443",
    ]);
  });
});
