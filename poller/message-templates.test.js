import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_MESSAGE_TEMPLATES } from "./message-templates.defaults.js";
import { loadMessageTemplates } from "./message-templates.js";

describe("message template overrides", () => {
  it("deep merges sparse overrides onto the public defaults", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "message-templates-"));
    const overrideFilePath = join(dirPath, "message-templates.override.json");
    writeFileSync(
      overrideFilePath,
      JSON.stringify({
        whatsapp: {
          activeAlert: {
            rocketTemplate: "override rocket text",
          },
          generalAlert: {
            mediaBaseName: "local-general",
          },
        },
      }),
      "utf8",
    );

    const templates = loadMessageTemplates({
      defaultTemplates: DEFAULT_MESSAGE_TEMPLATES,
      overrideFilePath,
    });

    assert.equal(templates.whatsapp.activeAlert.rocketTemplate, "override rocket text");
    assert.equal(templates.whatsapp.generalAlert.mediaBaseName, "local-general");
    assert.equal(
      templates.whatsapp.preAlert.upcomingAlertsTemplate,
      DEFAULT_MESSAGE_TEMPLATES.whatsapp.preAlert.upcomingAlertsTemplate,
    );
    assert.deepEqual(
      templates.classifier.allClear.rawTitles,
      DEFAULT_MESSAGE_TEMPLATES.classifier.allClear.rawTitles,
    );
  });

  it("returns the public defaults when the override file does not exist", () => {
    const templates = loadMessageTemplates({
      defaultTemplates: DEFAULT_MESSAGE_TEMPLATES,
      overrideFilePath: join(tmpdir(), "missing-message-templates.override.json"),
    });

    assert.deepEqual(templates, DEFAULT_MESSAGE_TEMPLATES);
  });

  it("overrides the optional version tag", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "message-templates-version-"));
    const overrideFilePath = join(dirPath, "message-templates.override.json");
    writeFileSync(
      overrideFilePath,
      JSON.stringify({
        whatsapp: {
          versionTag: "Ver 2.0",
        },
      }),
      "utf8",
    );

    const templates = loadMessageTemplates({
      defaultTemplates: DEFAULT_MESSAGE_TEMPLATES,
      overrideFilePath,
    });

    assert.equal(templates.whatsapp.versionTag, "Ver 2.0");
  });
});
