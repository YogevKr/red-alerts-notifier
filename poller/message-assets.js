import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultAssetsDir, overrideAssetsDir } from "./customization-paths.js";
import {
  getConfiguredMediaBaseNames,
  getMediaAssetMimeType,
  resolveMediaAssetFilename,
} from "./lib.js";

export function getMessageAssetSearchDirs({
  defaultDir = defaultAssetsDir,
  overrideDir = overrideAssetsDir,
} = {}) {
  return [overrideDir, defaultDir].filter((dir) => dir && existsSync(dir));
}

export function resolveMessageAsset(baseName, assetDirs = getMessageAssetSearchDirs()) {
  for (const assetDir of assetDirs) {
    const assetFiles = readdirSync(assetDir);
    try {
      const filename = resolveMediaAssetFilename(baseName, assetFiles);
      return {
        assetDir,
        filename,
        filePath: join(assetDir, filename),
      };
    } catch {
      continue;
    }
  }

  throw new Error(`No supported media asset found for ${baseName}`);
}

export function loadConfiguredEventMedia({
  messageTemplates,
  assetDirs = getMessageAssetSearchDirs(),
} = {}) {
  const media = {};
  const baseNames = getConfiguredMediaBaseNames(messageTemplates);

  for (const baseName of baseNames) {
    const asset = resolveMessageAsset(baseName, assetDirs);
    media[baseName] = {
      filename: asset.filename,
      mimetype: getMediaAssetMimeType(asset.filename),
      data: readFileSync(asset.filePath).toString("base64"),
    };
  }

  return media;
}
