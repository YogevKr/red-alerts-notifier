import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isNodeTestRuntime() {
  return process.execArgv.includes("--test");
}

export const appDir = dirname(fileURLToPath(import.meta.url));
export const defaultAssetsDir = join(appDir, "assets");
export const overridesDir = isNodeTestRuntime() ? "" : join(appDir, "overrides");
export const overrideAssetsDir = overridesDir ? join(overridesDir, "assets") : "";
export const messageTemplatesOverridePath = overridesDir
  ? join(overridesDir, "message-templates.override.json")
  : "";
