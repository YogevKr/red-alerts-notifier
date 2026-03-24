import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfiguredEventMedia, resolveMessageAsset } from "./message-assets.js";

describe("message asset overrides", () => {
  it("prefers the override asset when both override and public files exist", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "message-assets-"));
    const overrideDir = join(dirPath, "override");
    const defaultDir = join(dirPath, "default");
    mkdirSync(overrideDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, "general.png"), "public-asset");
    writeFileSync(join(overrideDir, "general.png"), "private-asset");

    const media = loadConfiguredEventMedia({
      messageTemplates: {
        generalAlert: {
          mediaBaseName: "general",
        },
      },
      assetDirs: [overrideDir, defaultDir],
    });

    assert.equal(Buffer.from(media.general.data, "base64").toString("utf8"), "private-asset");
    assert.equal(media.general.filename, "general.png");
    assert.equal(media.general.mimetype, "image/png");
  });

  it("falls back to the public asset when no override exists", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "message-assets-"));
    const defaultDir = join(dirPath, "default");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, "drone.jpeg"), "public-asset");

    const asset = resolveMessageAsset("drone", [defaultDir]);

    assert.equal(asset.filename, "drone.jpeg");
    assert.equal(readFileSync(asset.filePath, "utf8"), "public-asset");
  });
});
