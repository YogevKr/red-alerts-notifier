import { EVENT_TYPES } from "./lib.js";

export const PRESET_ALERTS = [
  { eventType: EVENT_TYPES.PRE_ALERT, label: "Pre-alert" },
  { eventType: EVENT_TYPES.ACTIVE_ALERT, label: "Rocket alert" },
  { eventType: EVENT_TYPES.DRONE_ALERT, label: "Drone alert" },
  { eventType: EVENT_TYPES.EARTHQUAKE_ALERT, label: "Earthquake alert" },
  { eventType: EVENT_TYPES.GENERAL_ALERT, label: "General alert" },
  { eventType: EVENT_TYPES.STAY_NEARBY_UPDATE, label: "Stay-nearby update" },
  { eventType: EVENT_TYPES.ALL_CLEAR, label: "All-clear" },
];

export const PRESET_ALERT_BY_TYPE = new Map(
  PRESET_ALERTS.map((preset) => [preset.eventType, preset]),
);

export function getPresetAlertLabel(eventType = "") {
  return PRESET_ALERT_BY_TYPE.get(eventType)?.label || eventType || "alert";
}

export function buildPresetAlert(
  eventType,
  locations = [],
  {
    idPrefix = "preset-alert",
    source = "manual_preset",
    desc = "זוהי הודעת בדיקה בלבד",
  } = {},
) {
  const id = `${idPrefix}-${eventType}-${Date.now()}`;

  if (eventType === EVENT_TYPES.PRE_ALERT) {
    return {
      id,
      cat: "14",
      title: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
      data: locations,
      desc,
      source,
    };
  }

  if (eventType === EVENT_TYPES.ACTIVE_ALERT) {
    return {
      id,
      cat: "1",
      title: "ירי רקטות וטילים",
      data: locations,
      desc,
      source,
    };
  }

  if (eventType === EVENT_TYPES.DRONE_ALERT) {
    return {
      id,
      cat: "2",
      title: "חדירת כלי טיס עוין",
      data: locations,
      desc,
      source,
    };
  }

  if (eventType === EVENT_TYPES.EARTHQUAKE_ALERT) {
    return {
      id,
      cat: "3",
      title: "רעידת אדמה",
      data: locations,
      desc,
      source,
    };
  }

  if (eventType === EVENT_TYPES.STAY_NEARBY_UPDATE) {
    return {
      id,
      cat: "13",
      title: "ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו",
      data: locations,
      desc,
      source,
    };
  }

  if (eventType === EVENT_TYPES.ALL_CLEAR) {
    return {
      id,
      cat: "13",
      title: "האירוע הסתיים",
      data: locations,
      desc,
      source,
    };
  }

  return {
    id,
    cat: "11",
    title: "אירוע חומרים מסוכנים",
    data: locations,
    desc,
    source,
  };
}
