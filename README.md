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
| Tzevaadom | WebSocket | `ws.tzevaadom.co.il` (community-run mirror) |
| OREF live alerts | HTTP poll | `oref.org.il/.../alerts.json` |
| OREF history | HTTP poll | `oref.org.il/.../AlertsHistory.json` |

All sources are normalized into a single internal format. Cross-source deduplication ensures each unique alert is delivered exactly once, regardless of how many sources report it.

## How it works

```
  ┌─────────────────┐
  │   Tzevaadom WS   │──push──┐
  └─────────────────┘         │
  ┌─────────────────┐         ▼
  │  OREF Live API   │──poll──▶ Poller ──▶ Location ──▶ Dedupe ──▶ Outbox (PostgreSQL)
  └─────────────────┘         ▲  filter                               │
  ┌─────────────────┐         │                                       ▼
  │ OREF History API │──poll──┘                              Notifier Worker
  └─────────────────┘                                          │          │
                                                               ▼          ▼
                                                          WhatsApp    Telegram
                                                        (Evolution)  (Bot API)
```

1. **Poller** listens to Tzevaadom via WebSocket and fetches OREF APIs every few seconds
2. **Location filter** keeps only alerts matching your configured locations (e.g. `תל אביב - יפו`)
3. **Deduplication** prevents the same alert from being sent twice, even from different sources
4. **Outbox** (PostgreSQL) queues one notification job per destination, with retries and dead-letter handling
5. **Notifier worker** picks jobs from the outbox and delivers via WhatsApp or Telegram
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

## WhatsApp setup

After starting the stack, pair your WhatsApp sender number:

1. Open `http://127.0.0.1:3000/qr` — save or display the QR code
2. Scan with WhatsApp on the sender phone
3. Check `http://127.0.0.1:3000/health` — `whatsappConnectionState` should be `open`

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `ALERT_LOCATIONS` | Yes | Comma-separated Hebrew location names to monitor |
| `WHATSAPP_TARGETS` | For WA | Comma-separated WhatsApp numbers or group IDs |
| `WHATSAPP_NUMBER` | For WA | Sender phone number (paired via QR) |
| `TELEGRAM_BOT_TOKEN` | For TG | Telegram bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | For TG | Comma-separated user IDs allowed to use the bot |
| `ACTIVE_SOURCES` | No | Sources to enable (default: `tzevaadom,oref_alerts,oref_history`) |
| `DELIVERY_ENABLED` | No | `true`/`false` (default: `false` — enable after setup) |
| `NOTIFIER_ACTIVE_TRANSPORTS` | No | `telegram`, `whatsapp`, or both |

See [`.env.example`](.env.example) for the full list including polling intervals, PagerDuty, and debug options.

## Services

| Service | Description |
|---------|-------------|
| `poller` | Polls alert sources, matches locations, enqueues notifications |
| `notifier-worker` | Processes the outbox queue, delivers to WhatsApp/Telegram |
| `telegram-bot` | Long-poll Telegram bot for ops commands |
| `evolution-api` | WhatsApp Web gateway ([Evolution API](https://github.com/EvolutionAPI/evolution-api)) |
| `evolution-db` | PostgreSQL — stores Evolution data + notification outbox |
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

## License

MIT — see [LICENSE](LICENSE).
