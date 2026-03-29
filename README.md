# Red Alerts Notifier

Self-hosted notification system for Israeli Home Front Command (Pikud HaOref) rocket and missile alerts. Monitors multiple official and third party alert sources in real time, filters by your configured locations, and delivers instant notifications to WhatsApp and Telegram.

## Disclaimer

This project is provided as-is, without warranties or guarantees of availability, accuracy, timeliness, or fitness for any purpose. It is not an official Home Front Command service, and you are solely responsible for how you deploy and use it. Do not rely on it as your only source for safety-critical alerts. The author is not responsible for missed alerts, delayed alerts, delivery failures, outages, misuse, or any direct or indirect damages.

## Why

During escalations, getting alerts fast and reliably matters. This system:

- Polls multiple sources simultaneously so you get the fastest one
- Deduplicates across sources — same alert is sent once, even if three sources report it
- Delivers to WhatsApp groups and Telegram chats — wherever your family/community is
- Runs on any server with Docker — no app store, no third-party service dependency

> **Note:** The OREF alert APIs are geo-restricted to Israel. Host this on a server located in Israel (e.g. GCP `me-west1`, AWS `il-central-1`) or use an Israeli VPN.

## Supported alert types

| Event | Hebrew title | Description |
|-------|-------------|-------------|
| Rocket/missile alert | ירי רקטות וטילים | Active incoming threat — enter protected space |
| Early warning | התרעה מקדימה | Alerts expected in your area soon |
| Stay nearby | שהייה בסמיכות למרחב מוגן | Can exit but stay close to protected space |
| All clear | האירוע הסתיים | Incident ended, safe to leave protected space |
| Drone alert | חדירת כלי טיס עוין | Hostile UAV intrusion |
| Earthquake | רעידת אדמה | Earthquake alert |

## Alert sources

| Source | Type | Endpoint |
|--------|------|----------|
| OREF MQTT | Push/MQTT | official mobile-app push backend (`com.alert.meserhadash`) |
| Tzevaadom | WebSocket | `ws.tzevaadom.co.il` (community-run mirror) |
| OREF live alerts | HTTP poll | `oref.org.il/.../alerts.json` |
| OREF history | HTTP poll | `oref.org.il/.../AlertsHistory.json` |

OREF MQTT is the main realtime source and is enabled by default. The other sources stay on as confirmation and fallback paths. All sources are normalized into a single internal format, and cross-source deduplication ensures each unique alert is delivered exactly once regardless of how many sources report it.

## How it works

```
  ┌─────────────────┐
  │   OREF MQTT      │──push──┐
  └─────────────────┘         │
  ┌─────────────────┐         │
  │   Tzevaadom WS   │──push──┼──▶ Poller ──▶ Location ──▶ Dedupe ──▶ Outbox (PostgreSQL)
  └─────────────────┘         │      filter                               │
  ┌─────────────────┐         │                                           ▼
  │  OREF Live API   │──poll──┤                                  Notifier Worker
  └─────────────────┘         │                                       │          │
  ┌─────────────────┐         │                                       ▼          ▼
  │ OREF History API │──poll──┘                                  WhatsApp    Telegram
  └─────────────────┘                                            (Evolution)  (Bot API)
```

1. **Poller** listens to OREF MQTT as the main push source, keeps Tzevaadom as a second realtime path, and polls OREF APIs for confirmation/backfill
2. **Location filter** keeps only alerts matching your configured locations (e.g. `תל אביב - יפו`)
3. **Deduplication** prevents the same alert from being sent twice, even from different sources
4. **Alert sinks** receive matched alerts. The default full-stack sink is a PostgreSQL-backed notification outbox, and the lightweight poller-only sink is structured log output
5. **Notifier worker** picks jobs from the notification outbox and delivers via WhatsApp or Telegram
6. **Telegram bot** provides ops commands: `/status`, `/mute`, `/unmute`, `/recent_sent`

## Quick start

```bash
git clone https://github.com/YogevKr/red-alerts-notifier.git
cd red-alerts-notifier

# Install Docker (if needed) and create .env from template
sudo ./setup.sh

# Edit .env — at minimum set:
#   ALERT_LOCATIONS=תל אביב - יפו
#   WHATSAPP_NUMBER=972501234567   (or TELEGRAM_BOT_TOKEN for Telegram-only)

# Start all services
sudo docker compose up -d --build

# Verify
curl http://127.0.0.1:3000/health
```

## Poller-only deploy

If you only want the alert collection layer and plan to wire your own sink later, use the dedicated poller-only compose file:

```bash
cp .env.example .env
# edit ALERT_LOCATIONS and keep ALERT_SINKS=log
docker compose -f docker-compose.poller-only.yml up -d --build
```

That starts only the polling/socket runtime and the local state volume. No PostgreSQL, Redis, Evolution, or notifier worker are required.

## WhatsApp setup

After starting the stack, pair your WhatsApp sender number:

1. Open `http://127.0.0.1:3000/qr` — save or display the QR code
2. Scan with WhatsApp on the sender phone
3. Check `http://127.0.0.1:3000/health` — `whatsappConnectionState` should be `open`

## Required resources

For a typical single-instance self-hosted deployment:

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| CPU | `e2-small` / shared-core (`0.5 vCPU`) | `e2-medium` or `1-2 vCPU` | `e2-small` is acceptable for light personal use; use more CPU headroom if you expect bursts or heavier delivery volume |
| RAM | 2 GB | 4 GB | The stack is fairly light at idle, but Evolution API + PostgreSQL still need some headroom |
| Disk | 10 GB SSD | 20 GB SSD | Includes Docker images, PostgreSQL data, Redis state, WhatsApp session state, and debug captures |
| Network | Stable outbound internet | Stable outbound internet from an Israeli region/IP | OREF endpoints are geo-restricted to Israel |

Required runtime pieces:

- Docker Engine with Docker Compose
- A server or VM that stays online continuously
- Persistent Docker volumes for PostgreSQL, Redis, Evolution instances, poller state, and Telegram bot state
- Outbound access to OREF endpoints, `ws.tzevaadom.co.il`, Telegram Bot API, and WhatsApp/Evolution dependencies

Required accounts/integrations:

- WhatsApp: one phone number you control, if you want WhatsApp delivery
- Telegram: one bot token from @BotFather, if you want Telegram delivery
- PagerDuty: optional, only if you want incident notifications

Operational notes:

- No GPU is required.
- Ports are bound to `127.0.0.1` by default; inbound public exposure is not required unless you choose to add it.
- In a real low-traffic deployment, the full stack was observed using roughly `300-400 MiB` RAM at steady state.
- `e2-small` is a cost-focused option for hobby or family use. If you want extra margin for reconnect storms, alert spikes, or future growth, use `e2-medium` or larger.
- If you keep debug capture enabled or raise retention limits, plan for extra disk headroom.

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `ALERT_LOCATIONS` | Yes | Comma-separated Hebrew location names to monitor |
| `WHATSAPP_TARGETS` | For WA | Comma-separated WhatsApp numbers or group IDs |
| `WHATSAPP_NUMBER` | For WA | Sender phone number (paired via QR) |
| `TELEGRAM_BOT_TOKEN` | For TG | Telegram bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | For TG | Comma-separated user IDs allowed to use the bot |
| `ACTIVE_SOURCES` | No | Sources to enable (default: `oref_mqtt,tzevaadom,oref_alerts`) |
| `OREF_MQTT_LISTENER_COUNT` | No | Parallel MQTT listeners for broker redundancy (default: `2`) |
| `OREF_MQTT_BROKER_URLS` | No | Optional comma-separated MQTT broker URLs; overrides derived listener hosts |
| `ALERT_SINKS` | No | Alert sinks to enable: `notification_outbox`, `log`, or both |
| `DELIVERY_ENABLED` | No | `true`/`false` (default: `false` — enable after setup) |
| `NOTIFIER_ACTIVE_TRANSPORTS` | No | `telegram`, `whatsapp`, or both |

See [`.env.example`](.env.example) for the full list including polling intervals, PagerDuty, and debug options.

## Customization

### Change message text

Public defaults stay in [poller/message-templates.defaults.js](poller/message-templates.defaults.js). Private/local overrides live in `poller/overrides/message-templates.override.json`, which is already ignored by git. Start from [poller/overrides/message-templates.override.example.json](poller/overrides/message-templates.override.example.json).

Start by copying the example:

```bash
cp poller/overrides/message-templates.override.example.json poller/overrides/message-templates.override.json
```

Then edit only the fields you want to override. The WhatsApp message bodies live under `whatsapp`, for example `preAlert.upcomingAlertsTemplate`, `activeAlert.rocketTemplate`, and `allClear.template`.

### Change the default image

Public fallback assets stay in [poller/assets](poller/assets). Private/local assets go in [poller/overrides/assets](poller/overrides/assets), which is also ignored by git. WhatsApp media assets support `.png`, `.jpg`, and `.jpeg`.

### Use different images for different events

1. Add image files under `poller/overrides/assets/`.
2. In `poller/overrides/message-templates.override.json`, set a different `mediaBaseName` for the event you want to customize.
3. Create a matching file in `poller/overrides/assets` using that basename.

Example:

```json
{
  "whatsapp": {
    "activeAlert": {
      "mediaBaseName": "rocket",
      "rocketTemplate": "ירי טילים ורקטות באזורך.\n\nיש להיכנס למרחב המוגן ולשהות בו עד לקבלת הודעת שחרור."
    },
    "allClear": {
      "mediaBaseName": "all-clear",
      "template": "האירוע הסתיים - ניתן לצאת מהמרחב המוגן."
    }
  }
}
```

Then add files like `poller/overrides/assets/rocket.png` and `poller/overrides/assets/all-clear.png`.

Override assets win over public assets with the same basename, so you can keep the public repo clean and carry local/private branding in `poller/overrides/` only.

After changing templates or assets, rebuild the containers:

```bash
sudo docker compose up -d --build
```

Image assets currently apply to WhatsApp delivery. Telegram notifications are sent as text.

## Services

| Service | Description |
|---------|-------------|
| `poller` | Polls alert sources, matches locations, and hands alerts to the configured sinks |
| `notifier-worker` | Processes the outbox queue, delivers to WhatsApp/Telegram |
| `telegram-bot` | Long-poll Telegram bot for ops commands |
| `evolution-api` | WhatsApp Web gateway ([Evolution API](https://github.com/EvolutionAPI/evolution-api)) |
| `app-db` | Shared PostgreSQL — stores Evolution data + notification outbox |
| `evolution-redis` | Redis cache for Evolution API sessions |

## Ops

Health endpoint:
```bash
curl http://127.0.0.1:3000/health
```

Telegram bot commands (for allowed users):
- `/status` — delivery state, connection health, latest alert flow
- `/recent_sent` — last delivered notifications
- `/recent_flow` — cross-source timing for recent alerts
- `/mute` / `/unmute` — toggle delivery without stopping polling
- `/send` — trigger a test notification

## Tests

```bash
cd poller
npm install
npm test
```

## Documentation

- [Alert sources](docs/sources.md) — source channels, polling behavior, debug captures
- [Deployment](docs/deploy.md) — setup, config reference, WhatsApp pairing
- [Alert sinks](docs/sinks.md) — built-in sinks and the extension seam for custom destinations

## License

MIT — see [LICENSE](LICENSE).
