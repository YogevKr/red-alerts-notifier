import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectStaleNotifierTransports,
  getOutboxBacklogAgeMs,
  hasNotifierTransport,
  hasOutboxBacklogExceededThreshold,
  normalizeNotifierTransports,
  PagerDutyIncidentManager,
  parsePositiveIntEnv,
  hasExceededThreshold,
  PAGERDUTY_EVENTS_URL,
} from "./pagerduty.js";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempFile(name) {
  const dir = mkdtempSync(join(tmpdir(), "red-alerts-pagerduty-"));
  tempDirs.push(dir);
  return join(dir, name);
}

describe("parsePositiveIntEnv", () => {
  it("uses fallback for invalid values", () => {
    assert.equal(parsePositiveIntEnv("", 42), 42);
    assert.equal(parsePositiveIntEnv("0", 42), 42);
    assert.equal(parsePositiveIntEnv("-5", 42), 42);
  });

  it("parses positive integers", () => {
    assert.equal(parsePositiveIntEnv("15", 42), 15);
  });
});

describe("hasExceededThreshold", () => {
  it("returns true only after threshold passes", () => {
    assert.equal(hasExceededThreshold(1000, 500, 1499), false);
    assert.equal(hasExceededThreshold(1000, 500, 1500), true);
  });
});

describe("getOutboxBacklogAgeMs", () => {
  it("returns null when no oldest available timestamp exists", () => {
    assert.equal(getOutboxBacklogAgeMs({}, 2000), null);
  });

  it("computes backlog age from the oldest available row", () => {
    assert.equal(
      getOutboxBacklogAgeMs({ oldestAvailableAt: "2026-03-18T16:00:00.000Z" }, Date.parse("2026-03-18T16:01:30.000Z")),
      90_000,
    );
  });
});

describe("hasOutboxBacklogExceededThreshold", () => {
  it("requires pending or failed work", () => {
    assert.equal(
      hasOutboxBacklogExceededThreshold(
        { pending: 0, failed: 0, oldestAvailableAt: "2026-03-18T16:00:00.000Z" },
        60_000,
        Date.parse("2026-03-18T16:02:00.000Z"),
      ),
      false,
    );
  });

  it("returns true once queued work is older than the threshold", () => {
    assert.equal(
      hasOutboxBacklogExceededThreshold(
        { pending: 1, failed: 0, oldestAvailableAt: "2026-03-18T16:00:00.000Z" },
        60_000,
        Date.parse("2026-03-18T16:02:00.000Z"),
      ),
      true,
    );
  });
});

describe("collectStaleNotifierTransports", () => {
  it("returns transports whose last check is stale or missing", () => {
    const stale = collectStaleNotifierTransports(
      {
        whatsappLastCheckedAt: "2026-03-18T16:00:40.000Z",
        telegramLastCheckedAt: null,
        telegramLastError: "fetch failed",
      },
      ["whatsapp", "telegram"],
      30_000,
      Date.parse("2026-03-18T16:01:20.000Z"),
    );

    assert.deepEqual(stale, [
      {
        transport: "whatsapp",
        lastCheckedAt: "2026-03-18T16:00:40.000Z",
        lastError: null,
        ageMs: 40_000,
      },
      {
        transport: "telegram",
        lastCheckedAt: null,
        lastError: "fetch failed",
        ageMs: null,
      },
    ]);
  });

  it("skips healthy transports under the threshold", () => {
    assert.deepEqual(
      collectStaleNotifierTransports(
        {
          whatsappLastCheckedAt: "2026-03-18T16:00:50.000Z",
        },
        ["whatsapp"],
        30_000,
        Date.parse("2026-03-18T16:01:00.000Z"),
      ),
      [],
    );
  });
});

describe("normalizeNotifierTransports", () => {
  it("normalizes, dedupes, and lowercases transports", () => {
    assert.deepEqual(
      normalizeNotifierTransports([" Telegram ", "whatsapp", "telegram", "", null]),
      ["telegram", "whatsapp"],
    );
  });
});

describe("hasNotifierTransport", () => {
  it("returns true only for configured transports", () => {
    assert.equal(hasNotifierTransport(["telegram"], "telegram"), true);
    assert.equal(hasNotifierTransport(["telegram"], "whatsapp"), false);
  });
});

describe("PagerDutyIncidentManager", () => {
  it("triggers and persists incidents", async () => {
    const requests = [];
    const manager = new PagerDutyIncidentManager({
      routingKey: "routing-key",
      filePath: makeTempFile("pagerduty.json"),
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: true,
          text: async () => "",
        };
      },
      logger: { log() {}, warn() {} },
    });

    const result = await manager.triggerIncident({
      dedupKey: "whatsapp-disconnected",
      summary: "WhatsApp session is not open",
      severity: "critical",
      customDetails: { state: "close" },
    });

    assert.equal(result.skipped, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, PAGERDUTY_EVENTS_URL);
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.event_action, "trigger");
    assert.equal(body.dedup_key, "whatsapp-disconnected");
    assert.equal(body.payload.summary, "WhatsApp session is not open");
    assert.equal(body.payload.severity, "critical");
    assert.deepEqual(body.payload.custom_details, { state: "close" });

    const persisted = JSON.parse(readFileSync(manager.filePath, "utf8"));
    assert.deepEqual(persisted[0].dedupKey, "whatsapp-disconnected");
    assert.equal(manager.status().openIncidents, 1);
  });

  it("resolves triggered incidents without a payload body", async () => {
    const requests = [];
    const manager = new PagerDutyIncidentManager({
      routingKey: "routing-key",
      filePath: makeTempFile("pagerduty.json"),
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: true,
          text: async () => "",
        };
      },
      logger: { log() {}, warn() {} },
    });

    await manager.triggerIncident({
      dedupKey: "tzevaadom-disconnected",
      summary: "Tzevaadom websocket is disconnected",
      severity: "warning",
    });
    await manager.resolveIncident({
      dedupKey: "tzevaadom-disconnected",
    });

    assert.equal(requests.length, 2);
    const resolveBody = JSON.parse(requests[1].options.body);
    assert.equal(resolveBody.event_action, "resolve");
    assert.equal(resolveBody.dedup_key, "tzevaadom-disconnected");
    assert.equal("payload" in resolveBody, false);
    assert.equal(manager.status().openIncidents, 0);
  });

  it("skips unchanged state", async () => {
    let calls = 0;
    const manager = new PagerDutyIncidentManager({
      routingKey: "routing-key",
      filePath: makeTempFile("pagerduty.json"),
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: true,
          text: async () => "",
        };
      },
      logger: { log() {}, warn() {} },
    });

    await manager.triggerIncident({
      dedupKey: "oref-sources-unavailable",
      summary: "All OREF polling sources are failing",
    });
    const second = await manager.triggerIncident({
      dedupKey: "oref-sources-unavailable",
      summary: "All OREF polling sources are failing",
    });

    assert.equal(calls, 1);
    assert.deepEqual(second, {
      skipped: true,
      reason: "unchanged",
      dedupKey: "oref-sources-unavailable",
      status: "triggered",
    });
  });

  it("stays disabled without a routing key", async () => {
    let called = false;
    const manager = new PagerDutyIncidentManager({
      filePath: makeTempFile("pagerduty.json"),
      fetchImpl: async () => {
        called = true;
        return {
          ok: true,
          text: async () => "",
        };
      },
      logger: { log() {}, warn() {} },
    });

    const result = await manager.triggerIncident({
      dedupKey: "poll-loop-error",
      summary: "Poll loop failing",
    });

    assert.equal(called, false);
    assert.deepEqual(result, {
      skipped: true,
      reason: "disabled",
      dedupKey: "poll-loop-error",
      status: "triggered",
    });
  });
});
