import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOrefCityMap,
  normalizeOrefMqttMessage,
  OrefMqttStream,
} from "./oref-mqtt.js";
import { OBSERVED_RAW_ALERTS } from "./test-fixtures/observed-raw-alerts.js";

describe("buildOrefCityMap", () => {
  it("maps OREF city ids to display names", () => {
    assert.deepEqual(
      [...buildOrefCityMap([
        { id: "1405", label: "תל אביב - יפו | גוש דן" },
        { id: "1234", label: "רמת ישי" },
      ]).entries()],
      [
        ["1405", "תל אביב - יפו"],
        ["1234", "רמת ישי"],
      ],
    );
  });
});

describe("normalizeOrefMqttMessage", () => {
  const cityMap = new Map([
    ["1405", "תל אביב - יפו"],
    ["1234", "רמת ישי"],
  ]);

  it("normalizes observed mqtt pre-alert payloads", () => {
    assert.deepEqual(
      normalizeOrefMqttMessage(OBSERVED_RAW_ALERTS.orefMqtt.preAlert, cityMap),
      {
        id: "oref_mqtt:19442819",
        source: "oref_mqtt",
        alertDate: "2026-03-24 12:48:42",
        title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        cat: "14",
        data: ["תל אביב - יפו"],
        desc: "היכנסו למרחב המוגן",
      },
    );
  });

  it("normalizes observed mqtt all-clear payloads", () => {
    assert.deepEqual(
      normalizeOrefMqttMessage(OBSERVED_RAW_ALERTS.orefMqtt.allClear, cityMap),
      {
        id: "oref_mqtt:19443111",
        source: "oref_mqtt",
        alertDate: "2026-03-24 12:50:10",
        title: "האירוע הסתיים",
        cat: "13",
        data: ["תל אביב - יפו"],
        desc: "השוהים במרחב המוגן יכולים לצאת",
      },
    );
  });
});

describe("OrefMqttStream", () => {
  it("subscribes to the device token and emits normalized alerts", () => {
    class FakeClient extends EventEmitter {
      subscribe(topic, options, callback) {
        this.subscription = { topic, options };
        callback?.(null);
      }

      end() {}
    }

    const client = new FakeClient();
    const alerts = [];
    const rawMessages = [];
    const stream = new OrefMqttStream({
      token: "device-token",
      auth: "device-auth",
      brokerUrlFactory: () => "mqtts://mqtt-test.ioref.io:443",
      mqttConnect(url, options) {
        assert.equal(url, "mqtts://mqtt-test.ioref.io:443");
        assert.equal(options.clientId, "device-token");
        assert.equal(options.username, "device-token");
        assert.equal(options.password, "device-auth");
        return client;
      },
      cityIdToName: new Map([
        ["1405", "תל אביב - יפו"],
        ["1234", "רמת ישי"],
      ]),
      queueAlerts: false,
      logger: { log() {}, error() {} },
      onRawMessage(message) {
        rawMessages.push(message);
      },
      onAlert(alert) {
        alerts.push(alert);
      },
    });

    stream.start();
    client.emit("connect");
    client.emit("message", "device-token", Buffer.from(JSON.stringify(OBSERVED_RAW_ALERTS.orefMqtt.rocketAlert)));

    assert.deepEqual(client.subscription, {
      topic: "device-token",
      options: { qos: 1 },
    });
    assert.equal(rawMessages.length, 1);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].source, "oref_mqtt");
    assert.equal(alerts[0].title, "ירי רקטות וטילים");
    assert.deepEqual(alerts[0].data, ["תל אביב - יפו", "רמת ישי"]);
    assert.equal(stream.status().connected, true);
    assert.equal(stream.status().alertCount, 1);
  });
});
