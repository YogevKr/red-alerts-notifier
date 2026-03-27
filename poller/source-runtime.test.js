import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRealtimeSourcesSnapshot,
  collectRealtimeSourceResults,
  createOrefMqttSourceRuntime,
  createRealtimeSourceRuntimes,
  createSourceConfigs,
  createTzevaadomSourceRuntime,
  setRealtimeAlertHandler,
  startRealtimeSources,
} from "./source-runtime.js";

describe("createSourceConfigs", () => {
  it("returns only active polled sources", () => {
    assert.deepEqual(
      createSourceConfigs({
        activeSources: ["oref_history", "oref_mqtt"],
        orefAlertsPollIntervalMs: 1000,
        orefHistoryPollIntervalMs: 5000,
      }).map((source) => source.name),
      ["oref_history"],
    );
  });
});

describe("realtime source runtime helpers", () => {
  it("creates and orchestrates only active realtime sources", async () => {
    const calls = [];
    const runtimes = createRealtimeSourceRuntimes({
      activeSources: ["oref_alerts", "oref_mqtt", "tzevaadom"],
      runtimeFactories: {
        oref_mqtt: () => ({
          setAlertHandler(handler) {
            calls.push(["handler", "oref_mqtt", typeof handler]);
          },
          getRealtimeSourcesSnapshot() {
            return { oref_mqtt: { enabled: true, connected: true, receivedCount: 1 } };
          },
          async collectRealtimeSourceResults() {
            return { oref_mqtt: { ok: true, count: 1 } };
          },
          async start(options) {
            calls.push(["start", "oref_mqtt", options.timeoutMs]);
          },
        }),
        tzevaadom: () => ({
          setAlertHandler(handler) {
            calls.push(["handler", "tzevaadom", typeof handler]);
          },
          getRealtimeSourcesSnapshot() {
            return { tzevaadom: { enabled: true, connected: false, receivedCount: 0 } };
          },
          async collectRealtimeSourceResults() {
            return { tzevaadom: { ok: false, count: 0 } };
          },
          async start(options) {
            calls.push(["start", "tzevaadom", options.timeoutMs]);
          },
        }),
      },
    });

    assert.deepEqual(Object.keys(runtimes), ["oref_mqtt", "tzevaadom"]);
    setRealtimeAlertHandler(runtimes, () => {});
    await startRealtimeSources(runtimes, { timeoutMs: 1234 });
    assert.deepEqual(buildRealtimeSourcesSnapshot(runtimes), {
      oref_mqtt: { enabled: true, connected: true, receivedCount: 1 },
      tzevaadom: { enabled: true, connected: false, receivedCount: 0 },
    });
    assert.deepEqual(await collectRealtimeSourceResults(runtimes), {
      oref_mqtt: { ok: true, count: 1 },
      tzevaadom: { ok: false, count: 0 },
    });
    assert.deepEqual(calls, [
      ["handler", "oref_mqtt", "function"],
      ["handler", "tzevaadom", "function"],
      ["start", "oref_mqtt", 1234],
      ["start", "tzevaadom", 1234],
    ]);
  });
});

describe("createTzevaadomSourceRuntime", () => {
  it("reports realtime deltas between polls", async () => {
    const statuses = [
      {
        connected: true,
        queued: 0,
        receivedCount: 2,
        parsedCount: 2,
        alertCount: 1,
        parseErrorCount: 0,
        lastParseError: null,
      },
      {
        connected: true,
        queued: 0,
        receivedCount: 5,
        parsedCount: 4,
        alertCount: 3,
        parseErrorCount: 1,
        lastParseError: "bad payload",
      },
    ];
    const runtime = createTzevaadomSourceRuntime({
      enabled: true,
      rawLogEnabled: false,
      rawLogPath: "/tmp/tzevaadom-source-runtime-test.json",
      debugCaptureStores: {},
      captureEntriesBySource() {},
      createStream: () => ({
        status: () => statuses.shift() || statuses[0],
        setAlertHandler() {},
        start() {},
        setCityMap() {},
      }),
      logger: { info() {}, warn() {} },
    });

    const first = await runtime.collectRealtimeSourceResults();
    const second = await runtime.collectRealtimeSourceResults();

    assert.deepEqual(first.tzevaadom, {
      ok: true,
      error: null,
      count: 1,
      rawCount: 0,
      queued: 0,
      receivedCount: 2,
      parsedCount: 2,
      alertCount: 1,
      parseErrorCount: 0,
    });
    assert.deepEqual(second.tzevaadom, {
      ok: true,
      error: null,
      count: 2,
      rawCount: 0,
      queued: 0,
      receivedCount: 3,
      parsedCount: 2,
      alertCount: 2,
      parseErrorCount: 1,
    });
  });

  it("loads the city map and starts the stream", async () => {
    const infoCalls = [];
    let setCityMapArg = null;
    let started = false;
    let timeoutArg = null;
    const runtime = createTzevaadomSourceRuntime({
      enabled: true,
      rawLogEnabled: false,
      rawLogPath: "/tmp/tzevaadom-source-runtime-start-test.json",
      createStream: () => ({
        status: () => ({
          connected: true,
          queued: 0,
          receivedCount: 0,
          parsedCount: 0,
          alertCount: 0,
          parseErrorCount: 0,
          lastParseError: null,
        }),
        setAlertHandler() {},
        start() {
          started = true;
        },
        setCityMap(cityMap) {
          setCityMapArg = cityMap;
        },
      }),
      fetchCityMap: async ({ timeoutMs }) => {
        timeoutArg = timeoutMs;
        return new Map([[1, "תל אביב - יפו"]]);
      },
      logger: {
        info(event, payload) {
          infoCalls.push({ event, payload });
        },
        warn() {},
      },
    });

    await runtime.start({ timeoutMs: 4321 });

    const snapshot = runtime.getRealtimeSourcesSnapshot();
    assert.equal(timeoutArg, 4321);
    assert.equal(started, true);
    assert.ok(setCityMapArg instanceof Map);
    assert.equal(snapshot.tzevaadom.cityCount, 1);
    assert.ok(snapshot.tzevaadom.cityMapLoadedAt);
    assert.equal(snapshot.tzevaadom.cityMapError, null);
    assert.ok(infoCalls.some((entry) => entry.event === "tzevaadom_city_map_ready"));
    assert.ok(infoCalls.some((entry) => entry.event === "tzevaadom_stream_started"));
  });

  it("starts the stream even when city map loading fails", async () => {
    const warnCalls = [];
    let started = false;
    const runtime = createTzevaadomSourceRuntime({
      enabled: true,
      rawLogEnabled: false,
      rawLogPath: "/tmp/tzevaadom-source-runtime-failure-test.json",
      createStream: () => ({
        status: () => ({
          connected: false,
          queued: 0,
          receivedCount: 0,
          parsedCount: 0,
          alertCount: 0,
          parseErrorCount: 0,
          lastParseError: null,
        }),
        setAlertHandler() {},
        start() {
          started = true;
        },
        setCityMap() {},
      }),
      fetchCityMap: async () => {
        throw new Error("city map unavailable");
      },
      logger: {
        info() {},
        warn(event, payload) {
          warnCalls.push({ event, payload });
        },
      },
    });

    await runtime.start({ timeoutMs: 1234 });

    const snapshot = runtime.getRealtimeSourcesSnapshot();
    assert.equal(started, true);
    assert.equal(snapshot.tzevaadom.cityCount, 0);
    assert.equal(snapshot.tzevaadom.cityMapLoadedAt, null);
    assert.equal(snapshot.tzevaadom.cityMapError, "city map unavailable");
    assert.ok(warnCalls.some((entry) => entry.event === "tzevaadom_city_map_failed"));
  });

  it("reports connection health changes outside the poll loop", async () => {
    const healthEvents = [];
    let connectionStateHandler = null;
    const runtime = createTzevaadomSourceRuntime({
      enabled: true,
      rawLogEnabled: false,
      rawLogPath: "/tmp/tzevaadom-source-runtime-health-test.json",
      createStream: (options) => {
        connectionStateHandler = options.onConnectionStateChange;
        return {
          status: () => ({
            connected: false,
            queued: 0,
            receivedCount: 0,
            parsedCount: 0,
            alertCount: 0,
            parseErrorCount: 0,
            lastParseError: "websocket disconnected",
          }),
          setAlertHandler() {},
          start() {},
          setCityMap() {},
        };
      },
      onHealthChange(event) {
        healthEvents.push(event);
      },
      logger: { info() {}, warn() {} },
    });

    connectionStateHandler({
      connected: false,
      lastParseError: "websocket disconnected",
    });
    connectionStateHandler({
      connected: true,
      lastParseError: null,
    });
    await Promise.resolve();

    assert.deepEqual(healthEvents.map((event) => ({
      source: event.source,
      ok: event.ok,
      error: event.error,
    })), [
      {
        source: "tzevaadom",
        ok: false,
        error: "websocket disconnected",
      },
      {
        source: "tzevaadom",
        ok: true,
        error: null,
      },
    ]);
    assert.ok(healthEvents.every((event) => typeof event.checkedAt === "string" && event.checkedAt));
  });
});

describe("createOrefMqttSourceRuntime", () => {
  it("reports realtime deltas between polls", async () => {
    const statuses = [
      {
        connected: true,
        queued: 0,
        receivedCount: 1,
        parsedCount: 1,
        alertCount: 1,
        parseErrorCount: 0,
        lastConnectionError: null,
        lastParseError: null,
      },
      {
        connected: true,
        queued: 0,
        receivedCount: 4,
        parsedCount: 3,
        alertCount: 2,
        parseErrorCount: 1,
        lastConnectionError: null,
        lastParseError: "bad payload",
      },
    ];
    const runtime = createOrefMqttSourceRuntime({
      enabled: true,
      rawLogEnabled: false,
      rawLogPath: "/tmp/oref-mqtt-source-runtime-test.json",
      credentialsPath: "/tmp/oref-mqtt-credentials-runtime-test.json",
      debugCaptureStores: {},
      captureEntriesBySource() {},
      createStream: () => ({
        status: () => statuses.shift() || statuses[0],
        setAlertHandler() {},
        start() {},
        setCityMap() {},
        setCredentials() {},
      }),
      logger: { info() {}, warn() {} },
    });

    const first = await runtime.collectRealtimeSourceResults();
    const second = await runtime.collectRealtimeSourceResults();

    assert.deepEqual(first.oref_mqtt, {
      ok: true,
      error: null,
      count: 1,
      rawCount: 0,
      queued: 0,
      receivedCount: 1,
      parsedCount: 1,
      alertCount: 1,
      parseErrorCount: 0,
    });
    assert.deepEqual(second.oref_mqtt, {
      ok: true,
      error: null,
      count: 1,
      rawCount: 0,
      queued: 0,
      receivedCount: 3,
      parsedCount: 2,
      alertCount: 1,
      parseErrorCount: 1,
    });
  });

  it("reuses valid credentials, subscribes topics, and starts the stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oref-mqtt-runtime-"));
    const credentialsPath = join(dir, "creds.json");
    const infoCalls = [];
    let setCityMapArg = null;
    let setCredentialsArg = null;
    let started = false;
    let subscribedArgs = null;
    const runtime = createOrefMqttSourceRuntime({
      enabled: true,
      topics: ["com.alert.meserhadash"],
      rotateIntervalMs: 60_000,
      rawLogEnabled: false,
      rawLogPath: join(dir, "raw-log.json"),
      credentialsPath,
      createStream: () => ({
        status: () => ({
          connected: true,
          queued: 0,
          receivedCount: 0,
          parsedCount: 0,
          alertCount: 0,
          parseErrorCount: 0,
          lastConnectionError: null,
          lastParseError: null,
        }),
        setAlertHandler() {},
        start() {
          started = true;
        },
        setCityMap(cityMap) {
          setCityMapArg = cityMap;
        },
        setCredentials(credentials) {
          setCredentialsArg = credentials;
        },
      }),
      fetchCityCatalog: async () => [
        { id: "1405", label: "תל אביב - יפו | גוש דן", areaid: "7" },
      ],
      validateCredentials: async () => ({ valid: true, validationStatus: "forbidden" }),
      registerDevice: async () => {
        throw new Error("register should not be called");
      },
      subscribeTopics: async (options) => {
        subscribedArgs = options;
      },
      logger: {
        info(event, payload) {
          infoCalls.push({ event, payload });
        },
        warn() {},
      },
    });

    writeFileSync(credentialsPath, JSON.stringify({
      token: "persisted-token",
      auth: "persisted-auth",
      androidId: "persisted-android-id",
    }), "utf8");

    await runtime.start({ timeoutMs: 4321 });

    const snapshot = runtime.getRealtimeSourcesSnapshot();
    assert.equal(started, true);
    assert.ok(setCityMapArg instanceof Map);
    assert.deepEqual(setCredentialsArg, {
      token: "persisted-token",
      auth: "persisted-auth",
      androidId: "persisted-android-id",
    });
    assert.equal(snapshot.oref_mqtt.cityCount, 1);
    assert.equal(snapshot.oref_mqtt.topicCount, 4);
    assert.equal("topics" in snapshot.oref_mqtt, false);
    assert.equal(snapshot.oref_mqtt.credentialsValidationStatus, "forbidden");
    assert.equal(snapshot.oref_mqtt.credentialsUsable, true);
    assert.equal(snapshot.oref_mqtt.rotateIntervalMs, 60_000);
    assert.equal(snapshot.oref_mqtt.credentialsError, null);
    assert.ok(snapshot.oref_mqtt.credentialsLoadedAt);
    assert.ok(snapshot.oref_mqtt.topicsSubscribedAt);
    assert.deepEqual(subscribedArgs, {
      token: "persisted-token",
      auth: "persisted-auth",
      topics: ["com.alert.meserhadash", "1405", "5001405", "7"],
      timeoutMs: 4321,
    });
    assert.ok(infoCalls.some((entry) => entry.event === "oref_mqtt_credentials_reused"));
    assert.ok(infoCalls.some((entry) => entry.event === "oref_mqtt_topics_subscribed"));
    assert.ok(infoCalls.some((entry) => entry.event === "oref_mqtt_stream_started"));
  });

  it("uses explicit configured topics without expanding to the full city catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oref-mqtt-explicit-"));
    const credentialsPath = join(dir, "creds.json");
    let started = false;
    let subscribedArgs = null;
    const runtime = createOrefMqttSourceRuntime({
      enabled: true,
      topicsExplicit: true,
      topics: ["5001231"],
      rawLogEnabled: false,
      rawLogPath: join(dir, "raw-log.json"),
      credentialsPath,
      createStream: () => ({
        status: () => ({
          connected: true,
          queued: 0,
          receivedCount: 0,
          parsedCount: 0,
          alertCount: 0,
          parseErrorCount: 0,
          lastConnectionError: null,
          lastParseError: null,
        }),
        setAlertHandler() {},
        start() {
          started = true;
        },
        setCityMap() {},
        setCredentials() {},
      }),
      fetchCityCatalog: async () => [
        { id: "1231", label: "חיפה", areaid: "5" },
      ],
      validateCredentials: async () => ({ valid: true, validationStatus: "forbidden" }),
      registerDevice: async () => {
        throw new Error("register should not be called");
      },
      subscribeTopics: async (options) => {
        subscribedArgs = options;
      },
      logger: { info() {}, warn() {} },
    });

    writeFileSync(credentialsPath, JSON.stringify({
      token: "persisted-token",
      auth: "persisted-auth",
      androidId: "persisted-android-id",
    }), "utf8");

    await runtime.start({ timeoutMs: 4321 });

    const snapshot = runtime.getRealtimeSourcesSnapshot();
    assert.equal(started, true);
    assert.equal(snapshot.oref_mqtt.topicCount, 1);
    assert.deepEqual(subscribedArgs, {
      token: "persisted-token",
      auth: "persisted-auth",
      topics: ["5001231"],
      timeoutMs: 4321,
    });
  });
});
