# Deploy

## Quick start

```bash
./setup.sh
# edit .env with your settings
docker compose up -d --build
```

## Prerequisites

- Docker and Docker Compose
- A configured `.env` file (see `.env.example`)

## Full deploy

1. Copy `.env.example` to `.env` and fill in your settings
2. Build and start:

```bash
docker compose up -d --build
docker compose ps
```

## Poller-only redeploy

When only `poller/` changed:

```bash
docker compose up -d --build poller notifier-worker
docker compose ps poller notifier-worker
```

## Verify

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS "http://127.0.0.1:3000/debug/captures?limit=5"
```

Expected:

- `ok: true`
- `outbox.pending` present
- `notifier.whatsappConnectionState` present

## WhatsApp pairing

If the WhatsApp session is not open:

- `http://127.0.0.1:3000/qr`
- `http://127.0.0.1:3000/connect`

## Telegram ops

- `/status` shows delivery state, active sender, fallback sender, targets, last delivery
- `/mute` disables WhatsApp delivery without stopping polling/debug capture
- `/unmute` re-enables WhatsApp delivery

## Config

Important env vars (see `.env.example` for full list):

- `EVOLUTION_INSTANCE` — Evolution API instance name
- `EVOLUTION_FALLBACK_INSTANCE` — fallback instance (optional)
- `POLLER_DATABASE_URL` — PostgreSQL connection string
- `WHATSAPP_TARGETS` — comma-separated WhatsApp targets
- `WHATSAPP_NUMBER` — sender WhatsApp number
- `TEST_NOTIFICATION_TARGETS` — test-only targets (e.g. `telegram:123456789`)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token
- `TELEGRAM_ALLOWED_USER_IDS` — comma-separated allowed Telegram user IDs
- `NOTIFIER_ACTIVE_TRANSPORTS` — `telegram`, `whatsapp`, or both
- `ALERT_LOCATIONS` — comma-separated location names to monitor
- `DELIVERY_ENABLED` — `true` or `false`
- `LOG_LEVEL` — `info`, `debug`, `warn`, `error`

## Notes

- Poller and Evolution ports are bound to `127.0.0.1` by default.
- Named Docker volumes preserve WhatsApp session, database, and Redis state across rebuilds.
- Do not run `docker compose down -v` unless you intentionally want to wipe state.
- PagerDuty stays fully disabled until `PAGERDUTY_ROUTING_KEY` is set.
