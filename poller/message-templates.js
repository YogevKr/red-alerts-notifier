import { existsSync, readFileSync } from "node:fs";
import { messageTemplatesOverridePath } from "./customization-paths.js";
import { DEFAULT_MESSAGE_TEMPLATES } from "./message-templates.defaults.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeMessageTemplates(base = {}, override = {}) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? [...override] : [...base];
  }

  if (!isPlainObject(base)) {
    return override === undefined ? base : override;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(base[key]) && isPlainObject(value)) {
      merged[key] = mergeMessageTemplates(base[key], value);
      continue;
    }

    if (Array.isArray(value)) {
      merged[key] = [...value];
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

export function loadMessageTemplates({
  defaultTemplates = DEFAULT_MESSAGE_TEMPLATES,
  overrideFilePath = messageTemplatesOverridePath,
} = {}) {
  if (!overrideFilePath || !existsSync(overrideFilePath)) {
    return defaultTemplates;
  }

  try {
    const overrideTemplates = JSON.parse(readFileSync(overrideFilePath, "utf8"));
    return mergeMessageTemplates(defaultTemplates, overrideTemplates);
  } catch (err) {
    throw new Error(
      `Failed to load message template override from ${overrideFilePath}: ${err.message}`,
    );
  }
}

export const MESSAGE_TEMPLATES = loadMessageTemplates();
