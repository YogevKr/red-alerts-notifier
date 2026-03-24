import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryDedupeGate } from "./delivery-dedupe.js";

describe("DeliveryDedupeGate", () => {
  function withTempDir(run) {
    const dirPath = mkdtempSync(join(tmpdir(), "delivery-dedupe-"));
    try {
      run(dirPath);
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  }

  it("suppresses duplicates while the same key is in flight", () => {
    withTempDir((dirPath) => {
      const gate = new DeliveryDedupeGate({
        filePath: join(dirPath, "notifier-deliveries.json"),
      });

      gate.markInFlight("same-key");

      assert.equal(gate.shouldSuppress("same-key"), true);

      gate.clearInFlight("same-key");

      assert.equal(gate.shouldSuppress("same-key"), false);
    });
  });

  it("suppresses duplicates within the configured window after a successful send", () => {
    withTempDir((dirPath) => {
      const gate = new DeliveryDedupeGate({
        filePath: join(dirPath, "notifier-deliveries.json"),
      });
      const firstDeliveredAt = Date.parse("2026-03-17T17:00:00.000Z");
      const duplicateCheckAt = Date.parse("2026-03-17T17:01:59.999Z");
      const nextAllowedAt = Date.parse("2026-03-17T17:02:00.000Z");

      gate.remember("same-key", firstDeliveredAt);

      assert.equal(gate.shouldSuppress("same-key", duplicateCheckAt), true);
      assert.equal(gate.shouldSuppress("same-key", nextAllowedAt), false);
    });
  });

  it("persists remembered deliveries across restarts", () => {
    withTempDir((dirPath) => {
      const filePath = join(dirPath, "notifier-deliveries.json");
      const firstDeliveredAt = Date.parse("2026-03-17T17:00:00.000Z");
      const duplicateCheckAt = Date.parse("2026-03-17T17:01:00.000Z");

      const writer = new DeliveryDedupeGate({ filePath });
      writer.remember("same-key", firstDeliveredAt);

      const reader = new DeliveryDedupeGate({ filePath });

      assert.equal(reader.shouldSuppress("same-key", duplicateCheckAt), true);
      assert.equal(reader.size, 1);
    });
  });
});
