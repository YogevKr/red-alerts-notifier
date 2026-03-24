import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectEventType, EVENT_TYPES } from "./lib.js";
import {
  SOURCE_CHANNELS,
  TzevaadomStream,
  buildTzevaadomCityMap,
  classifyTzevaadomSystemMessage,
  extractHistory2RawRecords,
  extractWebsiteCurrentRawRecords,
  extractWebsiteHistoryRawRecords,
  normalizeHistory2Alerts,
  normalizeTzevaadomMessage,
  normalizeWebsiteCurrentAlerts,
  normalizeWebsiteHistoryAlerts,
  sortAlertsByDate,
} from "./sources.js";
import { OBSERVED_RAW_ALERTS } from "./test-fixtures/observed-raw-alerts.js";

describe("normalizeWebsiteCurrentAlerts", () => {
  it("normalizes alerts.json records and derives alertDate from the id", () => {
    assert.deepEqual(
      normalizeWebsiteCurrentAlerts({
        id: "134176212030000000",
        cat: "10",
        title: "האירוע הסתיים",
        data: ["תל אביב - יפו", "רמת ישי"],
        desc: "השוהים במרחב המוגן יכולים לצאת.",
      }),
      [
        {
          id: "134176212030000000",
          source: SOURCE_CHANNELS.OREF_ALERTS,
          alertDate: "2026-03-10 15:00:03",
          title: "האירוע הסתיים",
          cat: "10",
          data: ["תל אביב - יפו", "רמת ישי"],
          desc: "השוהים במרחב המוגן יכולים לצאת.",
        },
      ],
    );
  });

  it("normalizes the observed pre-alert alerts.json payload variant", () => {
    assert.deepEqual(
      normalizeWebsiteCurrentAlerts(OBSERVED_RAW_ALERTS.orefAlerts.preAlertCat10),
      [
        {
          id: "134177031500000000",
          source: SOURCE_CHANNELS.OREF_ALERTS,
          alertDate: "2026-03-11 13:45:50",
          title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
          cat: "10",
          data: ["תל אביב - יפו"],
          desc: "על תושבי האזורים הבאים לשפר את המיקום למיגון המיטבי בקרבתך.",
        },
      ],
    );
  });
});

describe("extractWebsiteCurrentRawRecords", () => {
  it("captures raw alerts.json records before location filtering", () => {
    assert.deepEqual(
      extractWebsiteCurrentRawRecords(
        [
          OBSERVED_RAW_ALERTS.orefAlerts.preAlertCat10,
          {
            id: "134199999999999999",
            cat: "10",
            title: "בדיקות",
            data: ["חיפה"],
            desc: "",
          },
        ],
      ),
      [
        {
          payload: OBSERVED_RAW_ALERTS.orefAlerts.preAlertCat10,
          matchedLocations: ["תל אביב - יפו"],
        },
        {
          payload: {
            id: "134199999999999999",
            cat: "10",
            title: "בדיקות",
            data: ["חיפה"],
            desc: "",
          },
          matchedLocations: ["חיפה"],
        },
      ],
    );
  });
});

describe("normalizeWebsiteHistoryAlerts", () => {
  it("normalizes oref_history records", () => {
    assert.deepEqual(
      normalizeWebsiteHistoryAlerts([
        {
          alertDate: "2026-03-10 17:27:00",
          title: "האירוע הסתיים",
          data: "תל אביב - יפו",
          category: 13,
        },
      ]),
      [
        {
          id: "oref_history:2026-03-10 17:27:00:13:תל אביב - יפו",
          source: SOURCE_CHANNELS.OREF_HISTORY,
          alertDate: "2026-03-10 17:27:00",
          title: "האירוע הסתיים",
          cat: "13",
          data: ["תל אביב - יפו"],
          desc: "",
        },
      ],
    );
  });

  it("normalizes observed oref_history pre-alert payloads", () => {
    assert.deepEqual(
      normalizeWebsiteHistoryAlerts([OBSERVED_RAW_ALERTS.orefHistory.preAlertCat14]),
      [
        {
          id: "oref_history:2026-03-11 13:45:48:14:תל אביב - יפו",
          source: SOURCE_CHANNELS.OREF_HISTORY,
          alertDate: "2026-03-11 13:45:48",
          title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
          cat: "14",
          data: ["תל אביב - יפו"],
          desc: "",
        },
      ],
    );
  });
});

describe("extractWebsiteHistoryRawRecords", () => {
  it("captures raw oref_history rows before location filtering", () => {
    assert.deepEqual(
      extractWebsiteHistoryRawRecords(
        [
          OBSERVED_RAW_ALERTS.orefHistory.stayNearbyUpdateCat13,
          {
            alertDate: "2026-03-11 20:48:31",
            title: "האירוע הסתיים",
            data: "חיפה",
            category: 13,
          },
        ],
      ),
      [
        {
          payload: OBSERVED_RAW_ALERTS.orefHistory.stayNearbyUpdateCat13,
          matchedLocations: ["תל אביב - יפו"],
        },
        {
          payload: {
            alertDate: "2026-03-11 20:48:31",
            title: "האירוע הסתיים",
            data: "חיפה",
            category: 13,
          },
          matchedLocations: ["חיפה"],
        },
      ],
    );
  });
});

describe("normalizeHistory2Alerts", () => {
  it("uses category_desc and normalizes timestamps", () => {
    assert.deepEqual(
      normalizeHistory2Alerts([
        {
          rid: 438867,
          alertDate: "2026-03-10T17:27:00",
          category: 13,
          category_desc: "האירוע הסתיים",
          data: "תל אביב - יפו",
        },
      ]),
      [
        {
          id: "438867",
          source: SOURCE_CHANNELS.OREF_HISTORY2,
          alertDate: "2026-03-10 17:27:00",
          title: "האירוע הסתיים",
          cat: "13",
          data: ["תל אביב - יפו"],
          desc: "",
        },
      ],
    );
  });

  it("normalizes observed oref_history2 pre-alert payloads", () => {
    assert.deepEqual(
      normalizeHistory2Alerts([OBSERVED_RAW_ALERTS.orefHistory2.preAlertCat14]),
      [
        {
          id: "450136",
          source: SOURCE_CHANNELS.OREF_HISTORY2,
          alertDate: "2026-03-11 13:46:00",
          title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
          cat: "14",
          data: ["תל אביב - יפו"],
          desc: "",
        },
      ],
    );
  });
});

describe("extractHistory2RawRecords", () => {
  it("captures raw oref_history2 rows before location filtering", () => {
    assert.deepEqual(
      extractHistory2RawRecords(
        [
          OBSERVED_RAW_ALERTS.orefHistory2.allClearCat13,
          {
            rid: 999999,
            alertDate: "2026-03-11T14:00:00",
            category: 13,
            category_desc: "האירוע הסתיים",
            data: "חיפה",
          },
        ],
      ),
      [
        {
          payload: OBSERVED_RAW_ALERTS.orefHistory2.allClearCat13,
          matchedLocations: ["תל אביב - יפו"],
        },
        {
          payload: {
            rid: 999999,
            alertDate: "2026-03-11T14:00:00",
            category: 13,
            category_desc: "האירוע הסתיים",
            data: "חיפה",
          },
          matchedLocations: ["חיפה"],
        },
      ],
    );
  });
});

describe("buildTzevaadomCityMap", () => {
  it("maps city ids to Hebrew names", () => {
    const cityMap = buildTzevaadomCityMap({
      cities: {
        "תל אביב - יפו": {
          id: 1405,
          he: "תל אביב - יפו",
        },
      },
    });

    assert.equal(cityMap.get(1405), "תל אביב - יפו");
  });
});

describe("normalizeTzevaadomMessage", () => {
  it("normalizes alert messages", () => {
    assert.deepEqual(
      normalizeTzevaadomMessage({
        type: "ALERT",
        data: {
          notificationId: "abc",
          time: 1751284800,
          threat: 5,
          isDrill: false,
          cities: ["תל אביב - יפו", "חיפה"],
        },
      }),
      {
        id: "tzevaadom:alert:abc",
        source: SOURCE_CHANNELS.TZEVAADOM,
        alertDate: "2025-06-30 15:00:00",
        title: "חדירת כלי טיס עוין",
        cat: "2",
        data: ["תל אביב - יפו", "חיפה"],
        desc: "",
      },
    );
  });

  it("normalizes pre-alert system messages with city ids", () => {
    assert.deepEqual(
      normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemPreAlert,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      {
        id: "tzevaadom:system:pre-1",
        source: SOURCE_CHANNELS.TZEVAADOM,
        alertDate: "2025-06-30 15:00:00",
        title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        cat: "14",
        data: ["תל אביב - יפו"],
        desc: "",
      },
    );
  });

  it("normalizes text-based early warning system messages without relying on instructionType", () => {
    assert.deepEqual(
      normalizeTzevaadomMessage(
        {
          type: "SYSTEM_MESSAGE",
          data: {
            notificationId: "pre-text-1",
            time: 1751284800,
            titleHe: "מבזק פיקוד העורף - התרעה מקדימה",
            titleEn: "Home Front Command - Early Warning",
            bodyHe: "בעקבות זיהוי שיגורים ייתכן שיופעלו התרעות בדקות הקרובות.",
            bodyEn: "Due to the detection of missile launches, alerts may be activated in the coming minutes.",
            citiesIds: [1405],
          },
        },
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      {
        id: "tzevaadom:system:pre-text-1",
        source: SOURCE_CHANNELS.TZEVAADOM,
        alertDate: "2025-06-30 15:00:00",
        title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        cat: "14",
        data: ["תל אביב - יפו"],
        desc: "",
      },
    );
  });

  it("normalizes incident-ended system messages", () => {
    assert.deepEqual(
      normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemIncidentEnded,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      {
        id: "tzevaadom:system:end-1",
        source: SOURCE_CHANNELS.TZEVAADOM,
        alertDate: "2026-02-28 15:51:47",
        title: "האירוע הסתיים",
        cat: "13",
        data: ["תל אביב - יפו"],
        desc: "",
      },
    );
  });

  it("normalizes leaving-protected-space system messages as stay-nearby updates", () => {
    assert.deepEqual(
      normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemLeavingProtectedSpace,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      {
        id: "tzevaadom:system:nearby-1",
        source: SOURCE_CHANNELS.TZEVAADOM,
        alertDate: "2026-02-28 15:51:50",
        title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
        cat: "13",
        data: ["תל אביב - יפו"],
        desc: "",
      },
    );
  });

  it("normalizes end-nearby-stay system messages as all-clear", () => {
    assert.deepEqual(
      normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemEndNearbyStay,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      {
        id: "tzevaadom:system:end-nearby-1",
        source: SOURCE_CHANNELS.TZEVAADOM,
        alertDate: "2026-02-28 15:51:51",
        title: "האירוע הסתיים",
        cat: "13",
        data: ["תל אביב - יפו"],
        desc: "",
      },
    );
  });

  it("normalizes staying-near-protected-space system messages as stay-nearby updates", () => {
    assert.deepEqual(
      normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemStayNearby,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      {
        id: "tzevaadom:system:stay-nearby-1",
        source: SOURCE_CHANNELS.TZEVAADOM,
        alertDate: "2026-03-11 20:04:20",
        title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
        cat: "13",
        data: ["תל אביב - יפו"],
        desc: "",
      },
    );
  });

  it("normalizes generic all-clear system messages from body text", () => {
    assert.deepEqual(
      normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemGenericAllClear,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      {
        id: "tzevaadom:system:generic-end-1",
        source: SOURCE_CHANNELS.TZEVAADOM,
        alertDate: "2026-03-05 20:17:43",
        title: "האירוע הסתיים",
        cat: "13",
        data: ["תל אביב - יפו"],
        desc: "",
      },
    );
  });

  it("normalizes observed rocket alert websocket payloads", () => {
    assert.deepEqual(
      normalizeTzevaadomMessage(OBSERVED_RAW_ALERTS.tzevaadom.rocketAlert),
      {
        id: "tzevaadom:alert:rocket-1",
        source: SOURCE_CHANNELS.TZEVAADOM,
        alertDate: "2025-03-11 00:56:35",
        title: "ירי רקטות וטילים",
        cat: "1",
        data: ["תל אביב - יפו"],
        desc: "",
      },
    );
  });
});

describe("classifyTzevaadomSystemMessage", () => {
  const observedSystemMessages = [
    {
      name: "pre-alert",
      message: OBSERVED_RAW_ALERTS.tzevaadom.systemPreAlert.data,
      expected: {
        key: "pre_alert",
        title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        cat: "14",
      },
    },
    {
      name: "incident ended",
      message: OBSERVED_RAW_ALERTS.tzevaadom.systemIncidentEnded.data,
      expected: {
        key: "all_clear",
        title: "האירוע הסתיים",
        cat: "13",
      },
    },
    {
      name: "leaving protected space",
      message: OBSERVED_RAW_ALERTS.tzevaadom.systemLeavingProtectedSpace.data,
      expected: {
        key: "stay_nearby_update",
        title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
        cat: "13",
      },
    },
    {
      name: "end nearby stay",
      message: OBSERVED_RAW_ALERTS.tzevaadom.systemEndNearbyStay.data,
      expected: {
        key: "all_clear",
        title: "האירוע הסתיים",
        cat: "13",
      },
    },
    {
      name: "staying near protected space",
      message: OBSERVED_RAW_ALERTS.tzevaadom.systemStayNearby.data,
      expected: {
        key: "stay_nearby_update",
        title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
        cat: "13",
      },
    },
    {
      name: "generic all-clear body",
      message: OBSERVED_RAW_ALERTS.tzevaadom.systemGenericAllClear.data,
      expected: {
        key: "all_clear",
        title: "האירוע הסתיים",
        cat: "13",
      },
    },
  ];

  for (const { name, message, expected } of observedSystemMessages) {
    it(`classifies ${name}`, () => {
      assert.deepEqual(classifyTzevaadomSystemMessage(message), expected);
    });
  }
});

describe("observed payload regressions", () => {
  const observedAlerts = [
    {
      name: "oref_alerts all-clear cat 10",
      alert: normalizeWebsiteCurrentAlerts(OBSERVED_RAW_ALERTS.orefAlerts.allClearCat10)[0],
      expected: EVENT_TYPES.ALL_CLEAR,
    },
    {
      name: "oref_alerts pre-alert cat 10",
      alert: normalizeWebsiteCurrentAlerts(OBSERVED_RAW_ALERTS.orefAlerts.preAlertCat10)[0],
      expected: EVENT_TYPES.PRE_ALERT,
    },
    {
      name: "oref_history all-clear cat 13",
      alert: normalizeWebsiteHistoryAlerts([OBSERVED_RAW_ALERTS.orefHistory.allClearCat13])[0],
      expected: EVENT_TYPES.ALL_CLEAR,
    },
    {
      name: "oref_history stay-nearby update cat 13",
      alert: normalizeWebsiteHistoryAlerts([
        OBSERVED_RAW_ALERTS.orefHistory.stayNearbyUpdateCat13,
      ])[0],
      expected: EVENT_TYPES.STAY_NEARBY_UPDATE,
    },
    {
      name: "oref_history pre-alert cat 14",
      alert: normalizeWebsiteHistoryAlerts([OBSERVED_RAW_ALERTS.orefHistory.preAlertCat14])[0],
      expected: EVENT_TYPES.PRE_ALERT,
    },
    {
      name: "oref_history2 all-clear cat 13",
      alert: normalizeHistory2Alerts([OBSERVED_RAW_ALERTS.orefHistory2.allClearCat13])[0],
      expected: EVENT_TYPES.ALL_CLEAR,
    },
    {
      name: "oref_history2 stay-nearby update cat 13",
      alert: normalizeHistory2Alerts([
        OBSERVED_RAW_ALERTS.orefHistory2.stayNearbyUpdateCat13,
      ])[0],
      expected: EVENT_TYPES.STAY_NEARBY_UPDATE,
    },
    {
      name: "oref_history2 pre-alert cat 14",
      alert: normalizeHistory2Alerts([OBSERVED_RAW_ALERTS.orefHistory2.preAlertCat14])[0],
      expected: EVENT_TYPES.PRE_ALERT,
    },
    {
      name: "tzevaadom system pre-alert",
      alert: normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemPreAlert,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      expected: EVENT_TYPES.PRE_ALERT,
    },
    {
      name: "tzevaadom system incident ended",
      alert: normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemIncidentEnded,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      expected: EVENT_TYPES.ALL_CLEAR,
    },
    {
      name: "tzevaadom system leaving protected space",
      alert: normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemLeavingProtectedSpace,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      expected: EVENT_TYPES.STAY_NEARBY_UPDATE,
    },
    {
      name: "tzevaadom system end nearby stay",
      alert: normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemEndNearbyStay,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      expected: EVENT_TYPES.ALL_CLEAR,
    },
    {
      name: "tzevaadom system stay near protected space",
      alert: normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemStayNearby,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      expected: EVENT_TYPES.STAY_NEARBY_UPDATE,
    },
    {
      name: "tzevaadom system generic all-clear",
      alert: normalizeTzevaadomMessage(
        OBSERVED_RAW_ALERTS.tzevaadom.systemGenericAllClear,
        new Map([[1405, "תל אביב - יפו"]]),
      ),
      expected: EVENT_TYPES.ALL_CLEAR,
    },
    {
      name: "tzevaadom active rocket alert",
      alert: normalizeTzevaadomMessage(OBSERVED_RAW_ALERTS.tzevaadom.rocketAlert),
      expected: EVENT_TYPES.ACTIVE_ALERT,
    },
    {
      name: "tzevaadom drone alert",
      alert: normalizeTzevaadomMessage({
        type: "ALERT",
        data: {
          notificationId: "drone-1",
          time: 1751284800,
          threat: 5,
          isDrill: false,
          cities: ["תל אביב - יפו"],
        },
      }),
      expected: EVENT_TYPES.DRONE_ALERT,
    },
    {
      name: "oref_alerts stay-nearby update cat 10",
      alert: normalizeWebsiteCurrentAlerts(
        OBSERVED_RAW_ALERTS.orefAlerts.stayNearbyUpdateCat10,
      )[0],
      expected: EVENT_TYPES.STAY_NEARBY_UPDATE,
    },
    {
      name: "oref_alerts end nearby stay cat 10",
      alert: normalizeWebsiteCurrentAlerts(
        OBSERVED_RAW_ALERTS.orefAlerts.endNearbyStayCat10,
      )[0],
      expected: EVENT_TYPES.ALL_CLEAR,
    },
  ];

  for (const { name, alert, expected } of observedAlerts) {
    it(`classifies ${name}`, () => {
      assert.ok(alert);
      assert.equal(detectEventType(alert), expected);
    });
  }
});

describe("sortAlertsByDate", () => {
  it("sorts mixed-source alerts chronologically", () => {
    assert.deepEqual(
      sortAlertsByDate([
        { alertDate: "2026-03-10 17:27:00", source: "oref_history2" },
        { alertDate: "2026-03-10 17:25:00", source: "oref_alerts" },
        { alertDate: "2026-03-10 17:26:00", source: "oref_history" },
      ]).map((alert) => alert.source),
      ["oref_alerts", "oref_history", "oref_history2"],
    );
  });
});

describe("TzevaadomStream", () => {
  it("tracks raw messages and parsed alerts", () => {
    const rawMessages = [];
    let ws = null;
    const stream = new TzevaadomStream({
      logger: { log() {}, error() {} },
      webSocketFactory: () => {
        ws = {
          close() {},
        };
        return ws;
      },
      onRawMessage: (message) => rawMessages.push(message),
    });

    stream.start();
    ws.onopen();
    ws.onmessage({
      data: JSON.stringify({
        type: "ALERT",
        data: {
          notificationId: "abc",
          time: 1751284800,
          threat: 5,
          isDrill: false,
          cities: ["תל אביב - יפו"],
        },
      }),
    });

    assert.equal(rawMessages.length, 1);
    assert.equal(stream.status().connected, true);
    assert.equal(stream.status().receivedCount, 1);
    assert.equal(stream.status().parsedCount, 1);
    assert.equal(stream.status().alertCount, 1);
    assert.equal(stream.drain().length, 1);
  });

  it("tracks parse errors and keeps raw payload", () => {
    const parseErrors = [];
    let ws = null;
    const stream = new TzevaadomStream({
      logger: { log() {}, error() {} },
      webSocketFactory: () => {
        ws = {
          close() {},
        };
        return ws;
      },
      onParseError: (message) => parseErrors.push(message),
    });

    stream.start();
    ws.onmessage({ data: "{" });

    assert.equal(parseErrors.length, 1);
    assert.equal(parseErrors[0].raw, "{");
    assert.match(parseErrors[0].error, /JSON|Unexpected|Expected/);
    assert.equal(stream.status().receivedCount, 1);
    assert.equal(stream.status().parseErrorCount, 1);
    assert.equal(stream.status().parsedCount, 0);
  });

  it("ignores empty websocket frames", () => {
    const rawMessages = [];
    const parseErrors = [];
    let ws = null;
    const stream = new TzevaadomStream({
      logger: { log() {}, error() {} },
      webSocketFactory: () => {
        ws = {
          close() {},
        };
        return ws;
      },
      onRawMessage: (message) => rawMessages.push(message),
      onParseError: (message) => parseErrors.push(message),
    });

    stream.start();
    ws.onmessage({ data: "" });
    ws.onmessage({ data: "   " });

    assert.equal(rawMessages.length, 0);
    assert.equal(parseErrors.length, 0);
    assert.equal(stream.status().receivedCount, 0);
    assert.equal(stream.status().parseErrorCount, 0);
    assert.equal(stream.status().parsedCount, 0);
  });
});
