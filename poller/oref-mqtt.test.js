import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOrefMqttSubscriptionTopics,
  buildOrefMqttPushyDevicePayload,
  buildOrefCityMap,
  normalizeOrefMqttMessage,
  OrefMqttStream,
  registerOrefMqttDevice,
  validateOrefMqttCredentials,
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

describe("buildOrefMqttSubscriptionTopics", () => {
  it("builds the Pushy topic set from city, segment, and area ids", () => {
    assert.deepEqual(
      buildOrefMqttSubscriptionTopics([
        { id: "1405", areaid: "7" },
        { id: "1234", areaid: "9" },
        { id: "1405", areaid: "7" },
      ]),
      [
        "com.alert.meserhadash",
        "1405",
        "5001405",
        "7",
        "1234",
        "5001234",
        "9",
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
        sourceEventAt: "2026-03-24T10:48:42.000Z",
        sourceMessageId: "19442819",
        sourceMessageType: "mqtt_message",
        title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        cat: "14",
        data: ["תל אביב - יפו"],
        desc: "היכנסו למרחב המוגן",
        sourceMeta: {
          msgId: "19442818",
          threatId: "7",
        },
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
        sourceEventAt: "2026-03-24T10:50:10.000Z",
        sourceMessageId: "19443111",
        sourceMessageType: "mqtt_message",
        title: "האירוע הסתיים",
        cat: "13",
        data: ["תל אביב - יפו"],
        desc: "השוהים במרחב המוגן יכולים לצאת",
        sourceMeta: {
          msgId: "19443110",
          threatId: "8",
        },
      },
    );
  });
});

describe("Pushy device payload", () => {
  it("builds the fuller android payload shape", () => {
    assert.deepEqual(
      buildOrefMqttPushyDevicePayload({
        androidId: "1234567890abcdef",
        includeAndroidId: true,
      }),
      {
        app: null,
        appId: "66c20ac875260a035a3af7b2",
        platform: "android",
        sdk: 10117,
        androidId: "1234567890abcdef-Google-Android-SDK-built-for-x86_64",
      },
    );
  });
});

describe("Pushy API requests", () => {
  it("registers with android metadata and returns the persisted androidId", async () => {
    const requests = [];

    const credentials = await registerOrefMqttDevice({
      androidId: "deadbeefcafebabe",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: true,
          async text() {
            return JSON.stringify({ token: "device-token", auth: "device-auth" });
          },
        };
      },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://pushy.ioref.app/register");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      app: null,
      appId: "66c20ac875260a035a3af7b2",
      platform: "android",
      sdk: 10117,
      androidId: "deadbeefcafebabe-Google-Android-SDK-built-for-x86_64",
    });
    assert.deepEqual(credentials, {
      token: "device-token",
      auth: "device-auth",
      androidId: "deadbeefcafebabe-Google-Android-SDK-built-for-x86_64",
    });
  });

  it("validates credentials with the fuller android payload when androidId exists", async () => {
    const requests = [];

    const result = await validateOrefMqttCredentials({
      token: "device-token",
      auth: "device-auth",
      androidId: "deadbeefcafebabe",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: true,
          async text() {
            return JSON.stringify({ success: true });
          },
        };
      },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://pushy.ioref.app/devices/auth");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      app: null,
      appId: "66c20ac875260a035a3af7b2",
      platform: "android",
      sdk: 10117,
      androidId: "deadbeefcafebabe-Google-Android-SDK-built-for-x86_64",
      token: "device-token",
      auth: "device-auth",
    });
    assert.deepEqual(result, {
      valid: true,
      validationStatus: "ok",
      response: { success: true },
    });
  });

  it("keeps legacy auth payloads minimal when androidId is missing", async () => {
    const requests = [];

    await validateOrefMqttCredentials({
      token: "device-token",
      auth: "device-auth",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: true,
          async text() {
            return JSON.stringify({ success: true });
          },
        };
      },
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      token: "device-token",
      auth: "device-auth",
    });
  });

  it("treats 403 auth responses as usable but forbidden validation", async () => {
    const result = await validateOrefMqttCredentials({
      token: "device-token",
      auth: "device-auth",
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        async text() {
          return "forbidden";
        },
      }),
    });

    assert.deepEqual(result, {
      valid: true,
      validationStatus: "forbidden",
      error: "https://pushy.ioref.app/devices/auth responded 403: forbidden",
    });
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
