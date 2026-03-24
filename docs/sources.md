# Alert sources

The poller ingests multiple alert channels. Tzevaadom is the primary realtime source; OREF HTTP endpoints provide confirmation and backfill.

- `tzevaadom`: `wss://ws.tzevaadom.co.il/socket?platform=WEB` — long-lived WebSocket, push-based, fastest source
- `website-current`: `https://www.oref.org.il/WarningMessages/alert/alerts.json` — HTTP poll
- `website-history`: `https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json` — HTTP poll
- `history2`: `https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1` — currently disabled

Runtime behavior:

- active sources are selected by `ACTIVE_SOURCES` as a comma-separated list
- `tzevaadom` is a long-lived WebSocket with automatic reconnect — delivers alerts with the lowest latency
- `website-current` is polled every `OREF_ALERTS_POLL_INTERVAL_MS` when set, otherwise `POLL_INTERVAL_MS`
- `website-history` is polled every `OREF_HISTORY_POLL_INTERVAL_MS` when set, otherwise `POLL_INTERVAL_MS`
- `history2` is currently disabled
- alerts are normalized into one internal shape before location filtering and WhatsApp delivery
- delivery dedupe is source-neutral, so the same alert from different channels is sent once

Operational notes:

- `ACTIVE_SOURCES` can enable multiple sources at once, for example `oref_alerts,oref_history,tzevaadom`
- `oref_mqtt` derives per-area Pushy topics from `ALERT_LOCATIONS` when it can resolve them from `cities_heb.json`; `OREF_MQTT_TOPICS` remains available as a manual override/fallback
- `website-current`, `website-history`, and `history2` may still be geo-restricted outside Israel
- `tzevaadom` can continue to provide coverage when official website endpoints fail
- `/health` includes realtime counters for `tzevaadom`: `receivedCount`, `parsedCount`, `alertCount`, `parseErrorCount`, and last-seen timestamps
- `/debug/captures` can filter by `kind` and `source`
- debug capture kinds:
  - `ws_raw`: raw websocket frames before parse
  - `ws_parse_error`: raw websocket frames that failed JSON/normalize
  - `upstream_alert`: normalized alerts before location matching
  - `matched_alert`: alerts that matched configured locations
