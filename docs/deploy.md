# Deploy

## Quick start

```bash
./setup.sh
# edit .env with your settings
docker compose up -d --build
```

## Current prod shape

Single stack only. No sidecar canary.

- compose project: `red-alerts-notifier`
- remote checkout: `/home/yogev/red-alerts-notifier`
- services:
  - `app-db`
  - `evolution-api`
  - `evolution-redis`
  - `poller`
  - `notifier-worker`
  - `telegram-bot`
- active sources:
  - `oref_mqtt`
  - `tzevaadom`
  - `oref_alerts`
  - `oref_history`
- sender model:
  - `EVOLUTION_INSTANCE` = primary sender
  - `EVOLUTION_FALLBACK_INSTANCE` = fallback sender
- target model:
  - `WHATSAPP_TARGETS` is the full destination list
  - entries may be WhatsApp numbers, WhatsApp groups, and `telegram:<chat_id>`

## Prerequisites

- Docker and Docker Compose
- A configured `.env` file (see `.env.example`)

## Required resources

Single-instance baseline:

- CPU: minimum `e2-small` / shared-core (`0.5 vCPU`), recommended `e2-medium` or `1-2 vCPU`
- RAM: minimum `2 GB`, recommended `4 GB`
- Disk: minimum `10 GB SSD`, recommended `20 GB SSD`
- Network: reliable outbound internet from an Israeli region/IP, because OREF endpoints are geo-restricted

What these resources cover:

- `evolution-api`
- `postgres`
- `redis`
- `poller`
- `notifier-worker`
- `telegram-bot`

You also need:

- A host that runs continuously
- Persistent Docker volumes
- A WhatsApp sender number for WhatsApp delivery
- A Telegram bot token for Telegram delivery

Extra headroom is recommended if you increase debug capture retention, keep large Docker image caches, or run both WhatsApp and Telegram continuously over long periods.

Observed low-traffic footprint:

- roughly `300-400 MiB` RAM for the full stack at steady state
- very low CPU usage under idle/light load
- `e2-small` is acceptable for lightweight personal deployments, but `e2-medium` is safer if you expect bursts

## Full deploy

1. Copy `.env.example` to `.env` and fill in your settings
2. Build and start:

```bash
docker compose up -d --build
docker compose ps
```

Recommended startup settings for the full stack:

- `COMPOSE_PROJECT_NAME=red-alerts-notifier`
- `ALERT_SINKS=notification_outbox`
- `ACTIVE_SOURCES=oref_mqtt,tzevaadom,oref_alerts,oref_history`
- `DELIVERY_ENABLED=true` for normal live startup
- `NOTIFIER_ACTIVE_TRANSPORTS=whatsapp,telegram` when both are intended
- `DOCKER_LOG_MAX_SIZE=10m` and `DOCKER_LOG_MAX_FILE=5` keep container logs bounded

## Poller-only redeploy

When only `poller/` changed:

```bash
docker compose up -d --build poller notifier-worker
docker compose ps poller notifier-worker
```

## Poller-only deploy

For source collection without WhatsApp, Telegram, PostgreSQL, or Evolution:

```bash
cp .env.example .env
# set ALERT_LOCATIONS and keep ALERT_SINKS=log
docker compose -f docker-compose.poller-only.yml up -d --build
docker compose -f docker-compose.poller-only.yml ps
```

## Verify

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000/ops/status | jq -r .message
curl -sS "http://127.0.0.1:3000/debug/captures?limit=5"
```

Expected:

- `ok: true`
- full stack: `outbox.pending` present and `notifier.whatsappConnectionState` present
- poller-only: `database` and `outbox` may be `null`
- `/ops/status` should show:
  - `delivery: on`
  - primary/fallback sender states
  - full destination list
  - source health for `oref_alerts`, `oref_history`, `oref_mqtt`, `tzevaadom`

## WhatsApp pairing

If the WhatsApp session is not open:

- `http://127.0.0.1:3000/qr`
- `http://127.0.0.1:3000/connect`
- or open Evolution UI on `http://127.0.0.1:3001/manager/` when the port is locally reachable/tunneled

Pair both configured instances when using a fallback sender.

## Telegram ops

- `/status` shows delivery state, active sender, fallback sender, targets, last delivery
- `/mute` disables WhatsApp delivery without stopping polling/debug capture
- `/unmute` re-enables WhatsApp delivery

## Config

Important env vars (see `.env.example` for full list):

- `COMPOSE_PROJECT_NAME` — Docker compose project name; prod uses `red-alerts-notifier`
- `EVOLUTION_INSTANCE` — Evolution API instance name
- `EVOLUTION_FALLBACK_INSTANCE` — fallback instance (optional)
- `POLLER_DATABASE_URL` — PostgreSQL connection string
- `WHATSAPP_TARGETS` — comma-separated destination list; supports WhatsApp numbers, WhatsApp groups, and `telegram:<chat_id>`
- `WHATSAPP_NUMBER` — sender WhatsApp number
- `TEST_NOTIFICATION_TARGETS` — test-only targets (e.g. `telegram:123456789`)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token
- `TELEGRAM_ALLOWED_USER_IDS` — comma-separated allowed Telegram user IDs
- `ALERT_SINKS` — `notification_outbox`, `log`, or both
- `NOTIFIER_ACTIVE_TRANSPORTS` — `telegram`, `whatsapp`, or both
- `ALERT_LOCATIONS` — comma-separated location names to monitor
- `DELIVERY_ENABLED` — `true` or `false`
- `DOCKER_LOG_MAX_SIZE` / `DOCKER_LOG_MAX_FILE` — Docker json-file rotation limits
- `LOG_LEVEL` — `info`, `debug`, `warn`, `error`

## Notes

- Poller and Evolution ports are bound to `127.0.0.1` by default.
- Named Docker volumes preserve WhatsApp session, database, and Redis state across rebuilds.
- Do not run `docker compose down -v` unless you intentionally want to wipe state.
- If you want delivery enabled after a fresh restart, keep `.env` and runtime aligned with `DELIVERY_ENABLED=true`.
- PagerDuty stays fully disabled until `PAGERDUTY_ROUTING_KEY` is set.
