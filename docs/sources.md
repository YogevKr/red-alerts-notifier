# Alert sources

The poller ingests multiple alert channels. OREF MQTT is the primary realtime source; Tzevaadom and OREF HTTP endpoints provide confirmation, redundancy, and backfill.

- `oref_mqtt`: official mobile-app push backend over MQTT — subscribed via the observed upstream topic `com.alert.meserhadash`
- `tzevaadom`: `wss://ws.tzevaadom.co.il/socket?platform=WEB` — long-lived WebSocket, push-based mirror
- `oref_alerts`: `https://www.oref.org.il/WarningMessages/alert/alerts.json` — HTTP poll
- `oref_history`: `https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json` — HTTP poll
- `history2`: `https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1` — currently disabled

Runtime behavior:

- active sources are selected by `ACTIVE_SOURCES` as a comma-separated list
- the default source set is `oref_mqtt,tzevaadom,oref_alerts,oref_history`
- `oref_mqtt` is the main realtime source and subscribes only to `com.alert.meserhadash`
- `tzevaadom` is a long-lived WebSocket with automatic reconnect and acts as a secondary realtime path
- `oref_alerts` is polled every `OREF_ALERTS_POLL_INTERVAL_MS` when set, otherwise `POLL_INTERVAL_MS`
- `oref_history` is polled every `OREF_HISTORY_POLL_INTERVAL_MS` when set, otherwise `POLL_INTERVAL_MS`
- `history2` is currently disabled
- alerts are normalized into one internal shape before location filtering and delivery
- delivery dedupe is source-neutral, so the same alert from different channels is sent once

Operational notes:

- `ACTIVE_SOURCES` can enable multiple sources at once, for example `oref_mqtt,tzevaadom,oref_alerts,oref_history`
- `oref_mqtt` area filtering happens from `citiesIds` in the payload after receipt
- `oref_alerts`, `oref_history`, and `history2` may still be geo-restricted outside Israel
- `tzevaadom` and the HTTP sources provide coverage when the main MQTT path degrades
- `/health` includes realtime counters for `oref_mqtt` and `tzevaadom`: `receivedCount`, `parsedCount`, `alertCount`, `parseErrorCount`, and last-seen timestamps
- `/debug/captures` can filter by `kind` and `source`
- debug capture kinds:
  - `mqtt_raw`: raw MQTT payloads before parse
  - `mqtt_parse_error`: raw MQTT payloads that failed JSON/normalize
  - `ws_raw`: raw websocket frames before parse
  - `ws_parse_error`: raw websocket frames that failed JSON/normalize
  - `upstream_alert`: normalized alerts before location matching
  - `matched_alert`: alerts that matched configured locations
