import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNotifierTarget, summarizeNotifierTargets } from "./notifier-target.js";

describe("parseNotifierTarget", () => {
  it("parses telegram targets", () => {
    assert.deepEqual(parseNotifierTarget("telegram:123456789"), {
      transport: "telegram",
      chatId: "123456789",
      normalized: "telegram:123456789",
    });
  });

  it("normalizes whatsapp targets", () => {
    assert.deepEqual(parseNotifierTarget("972500000000@c.us"), {
      transport: "whatsapp",
      chatId: "972500000000",
      normalized: "972500000000",
    });
  });

  it("summarizes normalized target labels by transport", () => {
    assert.deepEqual(
      summarizeNotifierTargets(["telegram:123456789", "972500000000@c.us", "telegram:123456789"]),
      {
        total: 2,
        labels: ["telegram:123456789", "972500000000"],
        byTransport: {
          telegram: 1,
          whatsapp: 1,
        },
      },
    );
  });
});
