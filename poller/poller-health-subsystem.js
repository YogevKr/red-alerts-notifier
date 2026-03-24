import { createHealthHelpers } from "./health.js";

export function createPollerHealthSubsystem(options = {}) {
  return createHealthHelpers(options);
}
