import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLocations,
  parseChatTargets,
  EVENT_TYPES,
  buildEvolutionHeaders,
  shouldFallbackToText,
  resolveChatId,
  resolveChatIds,
  resolveTargetChatId,
  resolveTargetChatIds,
  resolveSimulationTargets,
  resolveEventType,
  detectEventType,
  isDeliverableEventType,
  isExplicitlySupportedAlert,
    parseEventDate,
    formatEventTimestamp,
    hashDeliveryKey,
    shouldSuppressDuplicateDelivery,
    getConnectionState,
    chooseEvolutionInstance,
    getConfiguredMediaBaseNames,
    getMediaAssetMimeType,
    normalizeChatTarget,
    alertKey,
    buildDeliveryKey,
    matchLocations,
    formatMessage,
    parseAlertBody,
    parseJsonObject,
    resolveMessageMediaBaseName,
    resolveMediaAssetFilename,
} from "./lib.js";
import { MESSAGE_TEMPLATES } from "./message-templates.js";

describe("parseLocations", () => {
  it("splits comma-separated locations", () => {
    assert.deepEqual(parseLocations("תל אביב - יפו,חיפה"), ["תל אביב - יפו", "חיפה"]);
  });

  it("trims whitespace", () => {
    assert.deepEqual(parseLocations(" תל אביב - יפו , חיפה "), ["תל אביב - יפו", "חיפה"]);
  });

  it("handles single location", () => {
    assert.deepEqual(parseLocations("תל אביב - יפו"), ["תל אביב - יפו"]);
  });
});

describe("alertKey", () => {
  it("creates key from id and cat", () => {
    assert.equal(alertKey({ id: "123", cat: "1" }), "123:1");
  });
});

describe("buildDeliveryKey", () => {
  it("builds a stable key regardless of matched location order", () => {
    const alert = {
      id: "123",
      cat: "1",
      alertDate: "2026-03-10 14:46:00",
      title: "ירי רקטות וטילים",
      desc: "desc",
    };

    assert.equal(
      buildDeliveryKey(alert, ["חיפה", "תל אביב - יפו"], {
        chatId: "group@g.us",
        eventType: EVENT_TYPES.ACTIVE_ALERT,
      }),
      buildDeliveryKey(alert, ["תל אביב - יפו", "חיפה"], {
        chatId: "group@g.us",
        eventType: EVENT_TYPES.ACTIVE_ALERT,
      }),
    );
  });

  it("changes key when event type changes", () => {
    const alert = { id: "123", cat: "1", title: "same" };

    assert.notEqual(
      buildDeliveryKey(alert, ["תל אביב - יפו"], {
        chatId: "group@g.us",
        eventType: EVENT_TYPES.PRE_ALERT,
      }),
      buildDeliveryKey(alert, ["תל אביב - יפו"], {
        chatId: "group@g.us",
        eventType: EVENT_TYPES.ACTIVE_ALERT,
      }),
    );
  });

  it("ignores source-specific ids and timestamp skew for the same semantic alert", () => {
    const baseAlert = {
      cat: "13",
      title: "האירוע הסתיים",
      desc: "",
    };

    assert.equal(
      buildDeliveryKey(
        {
          ...baseAlert,
          id: "oref_history:1",
          source: "oref_history",
          alertDate: "2026-03-10 17:27:00",
        },
        ["תל אביב - יפו"],
      ),
      buildDeliveryKey(
        {
          ...baseAlert,
          id: "oref_history2:438867",
          source: "oref_history2",
          alertDate: "2026-03-10 17:27:07",
        },
        ["תל אביב - יפו"],
      ),
    );
  });

  it("dedupes all-clear alerts across current and history payload variants", () => {
    assert.equal(
      buildDeliveryKey(
        {
          id: "134176212030000000",
          source: "oref_alerts",
          cat: "10",
          alertDate: "2026-03-10 15:00:03",
          title: "האירוע הסתיים",
          desc: "השוהים במרחב המוגן יכולים לצאת.",
        },
        ["תל אביב - יפו"],
      ),
      buildDeliveryKey(
        {
          id: "oref_history:1",
          source: "oref_history",
          cat: "13",
          alertDate: "2026-03-10 15:00:10",
          title: "הארוע הסתיים",
          desc: "",
        },
        ["תל אביב - יפו"],
      ),
    );
  });

  it("keeps the same key when identical alerts drift within two minutes", () => {
    assert.equal(
      buildDeliveryKey(
        {
          id: "oref_history:1",
          source: "oref_history",
          cat: "13",
          alertDate: "2026-03-11 01:26:00",
          title: "האירוע הסתיים",
        },
        ["תל אביב - יפו"],
      ),
      buildDeliveryKey(
        {
          id: "oref_alerts:1",
          source: "oref_alerts",
          cat: "10",
          alertDate: "2026-03-11 01:27:04",
          title: "האירוע הסתיים",
        },
        ["תל אביב - יפו"],
      ),
    );
  });

  it("keeps the same key when the same semantic event crosses the old bucket boundary", () => {
    assert.equal(
      buildDeliveryKey(
        {
          id: "oref_history:1",
          source: "oref_history",
          cat: "10",
          alertDate: "2026-03-11 22:55:31",
          title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
        },
        ["תל אביב - יפו"],
      ),
      buildDeliveryKey(
        {
          id: "oref_alerts:1",
          source: "oref_alerts",
          cat: "10",
          alertDate: "2026-03-11 22:56:02",
          title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
        },
        ["תל אביב - יפו"],
      ),
    );
  });

  it("dedupes active alerts with timestamp skew across sources", () => {
    assert.equal(
      buildDeliveryKey(
        {
          id: "tzevaadom:1",
          source: "tzevaadom",
          cat: "1",
          alertDate: "2026-03-11 01:08:55",
          title: "ירי רקטות וטילים",
        },
        ["תל אביב - יפו"],
        {
          chatId: "972500000000",
          eventType: EVENT_TYPES.ACTIVE_ALERT,
        },
      ),
      buildDeliveryKey(
        {
          id: "oref_alerts:1",
          source: "oref_alerts",
          cat: "1",
          alertDate: "2026-03-11 01:09:00",
          title: "ירי רקטות וטילים",
        },
        ["תל אביב - יפו"],
        {
          chatId: "972500000000",
          eventType: EVENT_TYPES.ACTIVE_ALERT,
        },
      ),
    );
  });

  it("keeps distinct pre-alert subtypes as separate keys", () => {
    assert.notEqual(
      buildDeliveryKey(
        {
          id: "oref_alerts:upcoming",
          cat: "14",
          alertDate: "2026-03-11 22:55:31",
          title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        },
        ["תל אביב - יפו"],
      ),
      buildDeliveryKey(
        {
          id: "oref_alerts:nearby",
          cat: "14",
          alertDate: "2026-03-11 22:55:32",
          title: "יש לשהות בסמיכות למרחב המוגן",
        },
        ["תל אביב - יפו"],
      ),
    );
  });
});

describe("hashDeliveryKey", () => {
  it("returns the same hash for equivalent semantic keys", () => {
    const key = buildDeliveryKey(
      {
        id: "oref_alerts:1",
        source: "oref_alerts",
        cat: "10",
        alertDate: "2026-03-11 01:27:04",
        title: "האירוע הסתיים",
      },
      ["תל אביב - יפו"],
      {
        chatId: "972500000000",
        eventType: EVENT_TYPES.ALL_CLEAR,
      },
    );

    assert.equal(hashDeliveryKey(key), hashDeliveryKey(key));
    assert.match(hashDeliveryKey(key), /^[a-f0-9]{64}$/);
  });
});

describe("chooseEvolutionInstance", () => {
  it("prefers primary when primary is open", () => {
    assert.deepEqual(
      chooseEvolutionInstance({
        primaryInstance: "primary",
        primaryState: "open",
        fallbackInstance: "fallback",
        fallbackState: "open",
      }),
      {
        instanceName: "primary",
        usedFallback: false,
        connectionState: "open",
      },
    );
  });

  it("uses fallback when primary is not open and fallback is open", () => {
    assert.deepEqual(
      chooseEvolutionInstance({
        primaryInstance: "primary",
        primaryState: "connecting",
        fallbackInstance: "fallback",
        fallbackState: "open",
      }),
      {
        instanceName: "fallback",
        usedFallback: true,
        connectionState: "open",
      },
    );
  });

  it("returns primary when no open fallback exists", () => {
    assert.deepEqual(
      chooseEvolutionInstance({
        primaryInstance: "primary",
        primaryState: "connecting",
        fallbackInstance: "fallback",
        fallbackState: "close",
      }),
      {
        instanceName: "primary",
        usedFallback: false,
        connectionState: "connecting",
      },
    );
  });
});

describe("shouldSuppressDuplicateDelivery", () => {
  it("suppresses duplicates within 120 seconds", () => {
    const firstDelivery = Date.parse("2026-03-11T20:55:40.724Z");
    const duplicateCheck = Date.parse("2026-03-11T20:56:10.415Z");

    assert.equal(shouldSuppressDuplicateDelivery(firstDelivery, duplicateCheck), true);
  });

  it("allows the same semantic alert again after 120 seconds", () => {
    const firstDelivery = Date.parse("2026-03-11T20:55:40.724Z");
    const nextAllowed = Date.parse("2026-03-11T20:57:40.724Z");

    assert.equal(shouldSuppressDuplicateDelivery(firstDelivery, nextAllowed), false);
  });
});

describe("buildEvolutionHeaders", () => {
  it("uses apikey when api key exists", () => {
    assert.deepEqual(buildEvolutionHeaders("secret"), {
      "Content-Type": "application/json",
      apikey: "secret",
    });
  });

  it("omits auth header when api key missing", () => {
    assert.deepEqual(buildEvolutionHeaders(""), {
      "Content-Type": "application/json",
    });
  });
});

describe("shouldFallbackToText", () => {
  it("falls back when media is Plus-only", () => {
    assert.equal(
      shouldFallbackToText(422, "The feature is available only in Plus version"),
      true,
    );
  });

  it("falls back when media route is missing", () => {
    assert.equal(shouldFallbackToText(404, "Not Found"), true);
  });

  it("does not fall back for unrelated failures", () => {
    assert.equal(shouldFallbackToText(500, "boom"), false);
  });
});

describe("resolveEventType", () => {
  it("keeps known event type", () => {
    assert.equal(resolveEventType(EVENT_TYPES.PRE_ALERT), EVENT_TYPES.PRE_ALERT);
  });

  it("returns unknown for invalid event type", () => {
    assert.equal(resolveEventType("weird"), EVENT_TYPES.UNKNOWN);
  });
});

describe("isDeliverableEventType", () => {
  it("allows supported event types only", () => {
    assert.equal(isDeliverableEventType(EVENT_TYPES.PRE_ALERT), true);
    assert.equal(isDeliverableEventType(EVENT_TYPES.ACTIVE_ALERT), true);
    assert.equal(isDeliverableEventType(EVENT_TYPES.EARTHQUAKE_ALERT), true);
    assert.equal(isDeliverableEventType(EVENT_TYPES.GENERAL_ALERT), true);
    assert.equal(isDeliverableEventType(EVENT_TYPES.STAY_NEARBY_UPDATE), true);
    assert.equal(isDeliverableEventType(EVENT_TYPES.ALL_CLEAR), true);
    assert.equal(isDeliverableEventType(EVENT_TYPES.UNKNOWN), false);
  });
});

describe("isExplicitlySupportedAlert", () => {
  it("supports pre-alert payloads", () => {
    assert.equal(
      isExplicitlySupportedAlert({
        title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        cat: "14",
      }),
      true,
    );
  });

  it("supports all-clear payloads", () => {
    assert.equal(
      isExplicitlySupportedAlert({
        title: "האירוע הסתיים",
        cat: "13",
      }),
      true,
    );
  });

  it("supports stay-nearby update payloads", () => {
    assert.equal(
      isExplicitlySupportedAlert({
        title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
        cat: "10",
      }),
      true,
    );
  });

  it("supports rocket active alerts", () => {
    assert.equal(
      isExplicitlySupportedAlert({
        title: "ירי רקטות וטילים",
        cat: "1",
      }),
      true,
    );
  });

  it("supports earthquake alerts", () => {
    assert.equal(
      isExplicitlySupportedAlert({
        title: "רעידת אדמה",
        cat: "3",
      }),
      true,
    );
  });

  it("supports general non-rocket alert payloads", () => {
    assert.equal(
      isExplicitlySupportedAlert({
        title: "חדירת מחבלים",
        cat: "10",
      }),
      true,
    );
    assert.equal(
      isExplicitlySupportedAlert({
        title: "חדירת כלי טיס עוין",
        cat: "2",
      }),
      true,
    );
  });
});

describe("resolveChatId", () => {
  it("uses the first parsed target from WHATSAPP_TARGETS", () => {
    assert.equal(
      resolveChatId({ targets: "972500000000,120363000000000000@g.us" }),
      "972500000000",
    );
  });

  it("uses full chat id as-is", () => {
    assert.equal(
      resolveChatId({ chatId: "120363000000000000@g.us" }),
      "120363000000000000@g.us",
    );
  });

  it("keeps direct number without suffix", () => {
    assert.equal(resolveChatId({ number: "972500000000" }), "972500000000");
  });

  it("prefers chat id over number", () => {
    assert.equal(
      resolveChatId({
        chatId: "120363000000000000@g.us",
        number: "972500000000",
      }),
      "120363000000000000@g.us",
    );
  });

  it("returns undefined when no target exists", () => {
    assert.equal(resolveChatId({}), undefined);
  });
});

describe("parseChatTargets", () => {
  it("parses comma-separated targets", () => {
    assert.deepEqual(parseChatTargets("972500000000,120363000000000000@g.us"), [
      "972500000000",
      "120363000000000000@g.us",
    ]);
  });
});

describe("resolveChatIds", () => {
  it("returns all configured targets once", () => {
    assert.deepEqual(
      resolveChatIds({
        targets: "972500000000,120363000000000000@g.us,972500000000",
      }),
      ["972500000000", "120363000000000000@g.us"],
    );
  });

  it("returns empty array when no targets are configured", () => {
    assert.deepEqual(resolveChatIds({}), []);
  });
});

describe("resolveTargetChatId", () => {
  it("uses fallback chat id when payload omits target", () => {
    assert.equal(resolveTargetChatId({}, "fallback@c.us"), "fallback");
  });

  it("uses payload chat id as-is", () => {
    assert.equal(
      resolveTargetChatId({ chatId: "120363000000000000@g.us" }, "fallback@c.us"),
      "120363000000000000@g.us",
    );
  });

  it("uses payload target as direct number when it has no suffix", () => {
    assert.equal(
      resolveTargetChatId({ target: "972500000000" }, "fallback@c.us"),
      "972500000000",
    );
  });

  it("uses payload number as direct number", () => {
    assert.equal(
      resolveTargetChatId({ number: "972500000000" }, "fallback@c.us"),
      "972500000000",
    );
  });
});

describe("resolveTargetChatIds", () => {
  it("uses fallback chat ids when payload omits targets", () => {
    assert.deepEqual(resolveTargetChatIds({}, ["one@g.us", "two"]), ["one@g.us", "two"]);
  });

  it("parses payload targets", () => {
    assert.deepEqual(
      resolveTargetChatIds({ targets: "972500000000,120363000000000000@g.us" }, ["fallback"]),
      ["972500000000", "120363000000000000@g.us"],
    );
  });
});

describe("resolveSimulationTargets", () => {
  it("uses explicit targets before test mode", () => {
    assert.deepEqual(
      resolveSimulationTargets(
        { number: "972500000000", useTestTarget: true },
        ["default@g.us"],
        ["test-number"],
      ),
      { chatIds: ["972500000000"], targetMode: "explicit" },
    );
  });

  it("uses the configured test target when requested", () => {
    assert.deepEqual(
      resolveSimulationTargets(
        { useTestTarget: true },
        ["default@g.us"],
        ["972500000000@c.us"],
      ),
      { chatIds: ["972500000000"], targetMode: "test" },
    );
  });

  it("falls back to default targets", () => {
    assert.deepEqual(
      resolveSimulationTargets({}, ["one@g.us", "two"], ["test-number"]),
      { chatIds: ["one@g.us", "two"], targetMode: "default" },
    );
  });

  it("requires a test number when test mode is requested", () => {
    assert.throws(
      () => resolveSimulationTargets({ testTarget: true }, ["default@g.us"], []),
      /WHATSAPP_NUMBER is required/,
    );
  });
});

describe("normalizeChatTarget", () => {
  it("strips direct chat suffix", () => {
    assert.equal(normalizeChatTarget("972500000000@c.us"), "972500000000");
  });

  it("keeps group chat ids untouched", () => {
    assert.equal(
      normalizeChatTarget("120363000000000000@g.us"),
      "120363000000000000@g.us",
    );
  });
});

describe("getConnectionState", () => {
  it("returns nested connection state", () => {
    assert.equal(
      getConnectionState({
        instance: { state: "open" },
      }),
      "open",
    );
  });

  it("returns top-level state fallback", () => {
    assert.equal(getConnectionState({ state: "connecting" }), "connecting");
  });

  it("returns null when state does not exist", () => {
    assert.equal(getConnectionState({}), null);
  });
});

describe("resolveMediaAssetFilename", () => {
  it("prefers jpeg over png", () => {
    assert.equal(
      resolveMediaAssetFilename("general", [
        "general.png",
        "general.jpeg",
      ]),
      "general.jpeg",
    );
  });

  it("falls back to png when jpeg is missing", () => {
    assert.equal(
      resolveMediaAssetFilename("general", ["general.png"]),
      "general.png",
    );
  });
});

describe("getMediaAssetMimeType", () => {
  it("returns jpeg mime type", () => {
    assert.equal(getMediaAssetMimeType("general.jpeg"), "image/jpeg");
  });

  it("returns png mime type", () => {
    assert.equal(getMediaAssetMimeType("general.png"), "image/png");
  });
});

describe("getConfiguredMediaBaseNames", () => {
  it("collects unique configured basenames", () => {
    assert.deepEqual(
      getConfiguredMediaBaseNames({
        preAlert: { mediaBaseName: "general" },
        activeAlert: { mediaBaseName: "rocket" },
        allClear: { mediaBaseName: "general" },
        generalAlert: { mediaBaseName: "fallback" },
        ignored: {},
      }),
      ["general", "rocket", "fallback"],
    );
  });
});

describe("resolveMessageMediaBaseName", () => {
  it("uses event-specific media for supported event types", () => {
    assert.equal(
      resolveMessageMediaBaseName({ title: "ירי רקטות וטילים", cat: "1" }, EVENT_TYPES.ACTIVE_ALERT),
      "active-alert",
    );
    assert.equal(
      resolveMessageMediaBaseName({ title: "חדירת כלי טיס עוין", cat: "2" }, EVENT_TYPES.DRONE_ALERT),
      "drone",
    );
    assert.equal(
      resolveMessageMediaBaseName({ title: "רעידת אדמה", cat: "3" }, EVENT_TYPES.EARTHQUAKE_ALERT),
      "earthquake",
    );
    assert.equal(
      resolveMessageMediaBaseName(
        { title: "בדקות הקרובות צפויות להתקבל התרעות באזורך", cat: "14" },
        EVENT_TYPES.PRE_ALERT,
      ),
      "pre-alert",
    );
    assert.equal(
      resolveMessageMediaBaseName({ title: "האירוע הסתיים", cat: "13" }, EVENT_TYPES.ALL_CLEAR),
      "all-clear",
    );
    assert.equal(
      resolveMessageMediaBaseName(
        { title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו", cat: "10" },
        EVENT_TYPES.STAY_NEARBY_UPDATE,
      ),
      "stay_nearby",
    );
  });

  it("uses general media for general alerts", () => {
    assert.equal(
      resolveMessageMediaBaseName({ title: "חדירת כלי טיס עוין", cat: "2" }, EVENT_TYPES.GENERAL_ALERT),
      "general",
    );
  });
});

describe("detectEventType", () => {
  it("detects all clear from title", () => {
    assert.equal(
      detectEventType({ title: "האירוע הסתיים", cat: "10" }),
      EVENT_TYPES.ALL_CLEAR,
    );
  });

  it("detects stay-nearby updates from title", () => {
    assert.equal(
      detectEventType({
        title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
        cat: "10",
      }),
      EVENT_TYPES.STAY_NEARBY_UPDATE,
    );
  });

  it("detects oref_alerts pre-alert payloads even when cat is 10", () => {
    assert.equal(
      detectEventType({
        title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
        desc: "על תושבי האזורים הבאים לשפר את המיקום למיגון המיטבי בקרבתך.",
        cat: "10",
      }),
      EVENT_TYPES.PRE_ALERT,
    );
  });

  it("does not treat cat 10 threat alerts as all-clear", () => {
    assert.equal(
      detectEventType({ title: "חדירת מחבלים", cat: "10" }),
      EVENT_TYPES.GENERAL_ALERT,
    );
  });

  it("does not treat end-of-nearby-stay updates as pre-alerts", () => {
    assert.equal(
      detectEventType({
        title: "סיום שהייה בסמיכות למרחב המוגן",
        desc: "תושבי האזורים הבאים אינם צריכים לשהות יותר בסמיכות למרחב המוגן.",
        cat: "10",
      }),
      EVENT_TYPES.ALL_CLEAR,
    );
  });

  it("detects rocket alerts as active_alert", () => {
    assert.equal(
      detectEventType({ title: "ירי רקטות וטילים" }),
      EVENT_TYPES.ACTIVE_ALERT,
    );
  });

  it("detects drone alerts explicitly", () => {
    assert.equal(
      detectEventType({ title: "חדירת כלי טיס עוין" }),
      EVENT_TYPES.DRONE_ALERT,
    );
  });

  it("detects earthquake alerts explicitly", () => {
    assert.equal(
      detectEventType({ title: "רעידת אדמה" }),
      EVENT_TYPES.EARTHQUAKE_ALERT,
    );
  });

  it("detects all other non-empty titles as general_alert", () => {
    assert.equal(
      detectEventType({ title: "חדירת מחבלים" }),
      EVENT_TYPES.GENERAL_ALERT,
    );
  });

  it("falls back to general_alert for unmatched titles", () => {
    assert.equal(
      detectEventType({ title: "אירוע חומרים מסוכנים", cat: "4" }),
      EVENT_TYPES.GENERAL_ALERT,
    );
    assert.equal(
      detectEventType({ title: "סיום שהייה בסמיכות למרחב המוגן", cat: "10" }),
      EVENT_TYPES.ALL_CLEAR,
    );
  });

  it("returns unknown for unknown payloads", () => {
    assert.equal(detectEventType({}), EVENT_TYPES.UNKNOWN);
  });
});

describe("matchLocations", () => {
  const alert = {
    id: "1",
    cat: "1",
    title: "ירי רקטות וטילים",
    data: ["תל אביב - יפו", "חיפה", "נתניה"],
  };

  it("returns matched locations", () => {
    assert.deepEqual(matchLocations(alert, ["תל אביב - יפו"]), ["תל אביב - יפו"]);
  });

  it("returns multiple matches", () => {
    assert.deepEqual(matchLocations(alert, ["תל אביב - יפו", "חיפה"]), [
      "תל אביב - יפו",
      "חיפה",
    ]);
  });

  it("returns empty when no match", () => {
    assert.deepEqual(matchLocations(alert, ["תל אביב"]), []);
  });

  it("returns empty for null alert", () => {
    assert.deepEqual(matchLocations(null, ["תל אביב - יפו"]), []);
  });

  it("supports single-location string payloads", () => {
    assert.deepEqual(matchLocations({ data: "תל אביב - יפו" }, ["תל אביב - יפו"]), [
      "תל אביב - יפו",
    ]);
  });
});

describe("formatMessage", () => {
  it("formats pre-alert message", () => {
    const alert = {
      title: "התרעה מקדימה",
    };
    const msg = formatMessage(alert, ["תל אביב - יפו"], {
      eventType: EVENT_TYPES.PRE_ALERT,
      timestamp: "2026-03-10T14:41:00+02:00",
    });
    assert.equal(
      msg,
      "שלישי | 10.3.2026 | שעה 14:41\n\n*הודעת עדכון מצח\"י תל אביב - יפו:*\n\n*התקבלה הנחיה מקדימה - יש לשהות בסמוך למרחב מוגן*",
    );
  });

  it("formats upcoming pre-alert message", () => {
    const alert = {
      title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      cat: "14",
    };
    const msg = formatMessage(alert, ["תל אביב - יפו"], {
      eventType: EVENT_TYPES.PRE_ALERT,
      timestamp: "2026-03-10T14:42:00+02:00",
    });
    assert.equal(
      msg,
      "שלישי | 10.3.2026 | שעה 14:42\n\n*הודעת עדכון מצח\"י תל אביב - יפו:*\n\n*בדקות הקרובות צפויות להתקבל התרעות באזורך עקב ירי טילים ורקטות.*\n\n*יש לשהות בסמוך למרחב מוגן ולהמשיך לעקוב אחר ההנחיות.*",
    );
  });

  it("formats active alert message", () => {
    const alert = { title: "ירי רקטות וטילים" };
    const msg = formatMessage(alert, ["תל אביב - יפו"], {
      eventType: EVENT_TYPES.ACTIVE_ALERT,
      timestamp: "2026-03-10T14:46:00+02:00",
    });
    assert.equal(
      msg,
      "שלישי | 10.3.2026 | שעה 14:46\n\n*הודעת עדכון מצח\"י תל אביב - יפו:*\n\n*ירי טילים ורקטות באזורך.*\n\n*יש להכנס למרחב המוגן ולשהות בו עד לקבלת הודעת שחרור.*",
    );
  });

  it("formats drone alert message using the title", () => {
    const alert = { title: "חדירת כלי טיס עוין", cat: "2" };
    const msg = formatMessage(alert, ["תל אביב - יפו"], {
      eventType: EVENT_TYPES.DRONE_ALERT,
      timestamp: "2026-03-10T14:47:00+02:00",
    });
    assert.equal(
      msg,
      "שלישי | 10.3.2026 | שעה 14:47\n\n*הודעת עדכון מצח\"י תל אביב - יפו:*\n\n*עקב חדירת כלי טיס עוין הופעלה התרעה באזורך.*\n\n*יש להיכנס למרחב המוגן ולשהות בו עד קבלת הודעת שחרור.*",
    );
  });

  it("formats earthquake alert message using the dedicated template", () => {
    const alert = { title: "רעידת אדמה", cat: "3" };
    const msg = formatMessage(alert, ["תל אביב - יפו"], {
      eventType: EVENT_TYPES.EARTHQUAKE_ALERT,
      timestamp: "2026-03-10T14:47:00+02:00",
    });
    assert.equal(
      msg,
      "שלישי | 10.3.2026 | שעה 14:47\n\n*הודעת עדכון מצח\"י תל אביב - יפו:*\n\n*הופעלה התרעה בשל רעידת אדמה באזורך.*\n\n*צאו מיד לשטח פתוח.*\n\n*אם לא ניתן - הכנסו לממ\"ד והשאירו את הדלת והחלון פתוחים.*",
    );
  });

  it("formats general alert message using the raw title", () => {
    const alert = { title: "חדירת מחבלים", cat: "10" };
    const msg = formatMessage(alert, ["תל אביב - יפו"], {
      eventType: EVENT_TYPES.GENERAL_ALERT,
      timestamp: "2026-03-10T14:47:00+02:00",
    });
    assert.equal(
      msg,
      "שלישי | 10.3.2026 | שעה 14:47\n\n*הודעת עדכון מצח\"י תל אביב - יפו:*\n\n*חדירת מחבלים*",
    );
  });

  it("formats all-clear message", () => {
    const alert = { title: "האירוע הסתיים", cat: "10" };
    const msg = formatMessage(alert, ["תל אביב - יפו"], {
      eventType: EVENT_TYPES.ALL_CLEAR,
      timestamp: "2026-03-10T14:56:00+02:00",
    });
    assert.equal(
      msg,
      "שלישי | 10.3.2026 | שעה 14:56\n\n*הודעת עדכון מצח\"י תל אביב - יפו:*\n\n*האירוע הסתיים - ניתן לצאת מהמרחב המוגן.*\n\n*אין צורך לשהות בסמוך למרחב מוגן.*",
    );
  });

  it("formats the optional version tag when configured", () => {
    const previous = MESSAGE_TEMPLATES.whatsapp.versionTag;
    MESSAGE_TEMPLATES.whatsapp.versionTag = "Ver 2.0";

    try {
      const alert = { title: "ירי רקטות וטילים", cat: "1" };
      const msg = formatMessage(alert, ["תל אביב - יפו"], {
        eventType: EVENT_TYPES.ACTIVE_ALERT,
        timestamp: "2026-03-10T14:46:00+02:00",
      });

      assert.equal(
        msg,
        "שלישי | 10.3.2026 | שעה 14:46\n\n*Ver 2.0*\n\n*הודעת עדכון מצח\"י תל אביב - יפו:*\n\n*ירי טילים ורקטות באזורך.*\n\n*יש להכנס למרחב המוגן ולשהות בו עד לקבלת הודעת שחרור.*",
      );
    } finally {
      MESSAGE_TEMPLATES.whatsapp.versionTag = previous;
    }
  });

  it("formats stay-nearby update message", () => {
    const alert = { title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו", cat: "10" };
    const msg = formatMessage(alert, ["תל אביב - יפו"], {
      eventType: EVENT_TYPES.STAY_NEARBY_UPDATE,
      timestamp: "2026-03-10T14:58:00+02:00",
    });
    assert.equal(
      msg,
      "שלישי | 10.3.2026 | שעה 14:58\n\n*הודעת עדכון מצח\"י תל אביב - יפו:*\n\n*ניתן לצאת מהמרחב המוגן, אך יש להישאר בקרבתו ולהמשיך לעקוב אחר ההנחיות.*",
    );
  });

  it("joins multiple matched locations in the update line", () => {
    const alert = { title: "ירי רקטות וטילים" };
    const msg = formatMessage(alert, ["תל אביב - יפו", "חיפה"], {
      eventType: EVENT_TYPES.ACTIVE_ALERT,
      timestamp: "2026-03-10T14:46:00+02:00",
    });
    assert.match(msg, /\*הודעת עדכון מצח"י תל אביב - יפו, חיפה:\*/);
  });

  it("throws for unknown event type", () => {
    assert.throws(
      () => formatMessage({ title: "משהו לא מוכר" }, ["תל אביב - יפו"], { eventType: "weird" }),
      /Unknown event type/,
    );
  });
});

describe("parseAlertBody", () => {
  it("parses valid JSON", () => {
    const body = '{"id":"1","cat":"1","title":"test","data":["a"]}';
    assert.deepEqual(parseAlertBody(body), {
      id: "1",
      cat: "1",
      title: "test",
      data: ["a"],
    });
  });

  it("returns null for empty string", () => {
    assert.equal(parseAlertBody(""), null);
  });

  it("returns null for whitespace", () => {
    assert.equal(parseAlertBody("  \n  "), null);
  });

  it("returns null for null/undefined", () => {
    assert.equal(parseAlertBody(null), null);
    assert.equal(parseAlertBody(undefined), null);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseAlertBody("{bad}"), SyntaxError);
  });
});

describe("parseJsonObject", () => {
  it("returns empty object for empty body", () => {
    assert.deepEqual(parseJsonObject(""), {});
  });

  it("parses valid object JSON", () => {
    assert.deepEqual(parseJsonObject('{"target":"972500000000"}'), {
      target: "972500000000",
    });
  });

  it("throws for non-object JSON", () => {
    assert.throws(() => parseJsonObject("[]"), /JSON body must be an object/);
  });
});

describe("formatEventTimestamp", () => {
  it("formats event timestamp in Hebrew", () => {
    assert.equal(
      formatEventTimestamp("2026-03-10T14:41:00+02:00"),
      "שלישי | 10.3.2026 | שעה 14:41",
    );
  });

  it("formats UTC timestamps in Jerusalem timezone", () => {
    assert.equal(
      formatEventTimestamp("2026-03-10T12:41:00Z"),
      "שלישי | 10.3.2026 | שעה 14:41",
    );
  });

  it("treats naive timestamps as Jerusalem local time", () => {
    assert.equal(
      formatEventTimestamp("2026-03-10 14:41:00"),
      "שלישי | 10.3.2026 | שעה 14:41",
    );
  });
});

describe("parseEventDate", () => {
  it("treats naive timestamps as Jerusalem local time", () => {
    assert.equal(
      parseEventDate("2026-03-11 01:09:00").toISOString(),
      "2026-03-10T23:09:00.000Z",
    );
  });
});
