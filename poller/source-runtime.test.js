import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRealtimeSourcesSnapshot,
  collectRealtimeSourceResults,
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
        activeSources: ["oref_history", "tzevaadom"],
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
      activeSources: ["oref_alerts", "tzevaadom"],
      runtimeFactories: {
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

    assert.deepEqual(Object.keys(runtimes), ["tzevaadom"]);
    setRealtimeAlertHandler(runtimes, () => {});
    await startRealtimeSources(runtimes, { timeoutMs: 1234 });
    assert.deepEqual(buildRealtimeSourcesSnapshot(runtimes), {
      tzevaadom: { enabled: true, connected: false, receivedCount: 0 },
    });
    assert.deepEqual(await collectRealtimeSourceResults(runtimes), {
      tzevaadom: { ok: false, count: 0 },
    });
    assert.deepEqual(calls, [
      ["handler", "tzevaadom", "function"],
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
