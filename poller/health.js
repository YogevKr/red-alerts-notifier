import { createHealthSnapshotBuilders } from "./health-snapshot.js";
import { getPresetAlertLabel } from "./preset-alerts.js";
import { buildTelegramStatusMessage, TELEGRAM_COMMANDS } from "./telegram.js";

export function createHealthHelpers(options = {}) {
  const snapshots = createHealthSnapshotBuilders(options);

  function buildOpsCommandSummary() {
    return `commands: ${TELEGRAM_COMMANDS.map(({ command }) => `/${command}`).join(" ")}`;
  }

  function buildOpsTargetLabel(chatIds = options.targetChatIds) {
    if (!Array.isArray(chatIds) || chatIds.length === 0) return "";
    return chatIds.length === 1 ? "default target" : `default targets (${chatIds.length})`;
  }

  async function buildOpsStatusResponse() {
    const status = await snapshots.collectOpsStatusSnapshot();
    const commandSummary = buildOpsCommandSummary();
    return {
      ok: true,
      message: `${buildTelegramStatusMessage(status)}\n${commandSummary}`,
      telegramMessage: `${buildTelegramStatusMessage({ ...status, format: "html" })}\n${commandSummary}`,
      status,
    };
  }

  function buildOpsDeliveryResponse(enabled) {
    return {
      ok: true,
      enabled,
      message: enabled ? "delivery unmuted" : "delivery muted",
      status: snapshots.buildOpsStatusPayload(),
    };
  }

  function buildOpsSendPresetResponse(result = {}) {
    const label = getPresetAlertLabel(result.eventType);
    const enqueuedTargets = (result.targets || []).filter((target) => !target.skipped);
    const skippedTargets = (result.targets || []).filter((target) => target.skipped);
    const queuedSummary =
      enqueuedTargets.length > 0
        ? `Enqueued ${label} for ${result.targetLabel || buildOpsTargetLabel()}.`
        : `Skipped ${label} for ${result.targetLabel || buildOpsTargetLabel()}.`;
    const skippedSummary =
      skippedTargets.length > 0
        ? ` skipped: ${skippedTargets.map((target) => `${target.chatId} (${target.reason})`).join(", ")}`
        : "";
    return {
      ok: true,
      message: `${queuedSummary}${skippedSummary}`.trim(),
      ...result,
    };
  }

  return {
    ...snapshots,
    buildOpsStatusResponse,
    buildOpsTargetLabel,
    buildOpsDeliveryResponse,
    buildOpsSendPresetResponse,
  };
}
