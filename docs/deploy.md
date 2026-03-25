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

## GCP canary beside a legacy stack

Use this when you want to run `red-alerts-notifier` in parallel with an older `red-alerts` stack on the same VM, while reusing the existing Evolution API and PostgreSQL containers.

Files:

- `docker-compose.gcp-canary.yml`
- `.env.gcp-canary.example`

Recommended flow:

1. Copy `.env.gcp-canary.example` to a real env file on the VM
2. Fill in the existing Evolution API key and PostgreSQL URL
3. Set `POLLER_DATABASE_SCHEMA=poller_canary`
4. Set the canary delivery targets, for example:
   - `WHATSAPP_TARGETS=972500000001,telegram:123456789`
   - `NOTIFIER_ACTIVE_TRANSPORTS=whatsapp,telegram`
5. If you want to reuse the same Telegram bot token from another host such as `tmm`, stop the other host's `telegram-bot` process first so only one process polls `getUpdates`
6. Start the canary:

```bash
cp .env.gcp-canary.example .env.gcp-canary
# edit .env.gcp-canary
docker compose --env-file .env.gcp-canary -f docker-compose.gcp-canary.yml up -d --build
docker compose --env-file .env.gcp-canary -f docker-compose.gcp-canary.yml ps
```

Notes:

- The canary joins the existing Docker network `red-alerts_default` by default
- It does not start its own `evolution-api`, `postgres`, or `redis`
- `poller_canary` is an isolated schema for outbox + source-event ledger data
- After bake, cut prod over by stopping the old sender stack and starting the new stack with `POLLER_DATABASE_SCHEMA=poller`

## Verify

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS "http://127.0.0.1:3000/debug/captures?limit=5"
```

Expected:

- `ok: true`
- full stack: `outbox.pending` present and `notifier.whatsappConnectionState` present
- poller-only: `database` and `outbox` may be `null`

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
- `ALERT_SINKS` — `notification_outbox`, `log`, or both
- `NOTIFIER_ACTIVE_TRANSPORTS` — `telegram`, `whatsapp`, or both
- `ALERT_LOCATIONS` — comma-separated location names to monitor
- `DELIVERY_ENABLED` — `true` or `false`
- `LOG_LEVEL` — `info`, `debug`, `warn`, `error`

## Notes

- Poller and Evolution ports are bound to `127.0.0.1` by default.
- Named Docker volumes preserve WhatsApp session, database, and Redis state across rebuilds.
- Do not run `docker compose down -v` unless you intentionally want to wipe state.
- PagerDuty stays fully disabled until `PAGERDUTY_ROUTING_KEY` is set.
