# Alert sinks

The poller normalizes alert sources, filters by configured locations, then hands each matched alert to one or more sinks.

## Built-in sinks

- `notification_outbox`
  - Default full-stack sink.
  - Stores alert jobs in PostgreSQL for `notifier-worker`.
  - Requires `POLLER_DATABASE_URL`.
- `log`
  - Zero-dependency sink for poller-only deployments.
  - Writes matched alerts to structured logs.
  - Useful as a lightweight starting point when you want to add your own downstream integration later.

## Configure sinks

Use `ALERT_SINKS` in `.env`:

```dotenv
ALERT_SINKS=notification_outbox
```

Examples:

- Full stack: `ALERT_SINKS=notification_outbox`
- Poller only: `ALERT_SINKS=log`
- Dual fanout during migration: `ALERT_SINKS=notification_outbox,log`

If `ALERT_SINKS` is unset:

- with `POLLER_DATABASE_URL`: defaults to `notification_outbox`
- without `POLLER_DATABASE_URL`: defaults to `log`

## Extension seam

Built-in sinks live in [poller/alert-sinks.js](../poller/alert-sinks.js).

Each sink exposes:

- `name`
- `requiresTargets`
- `ensureReady()`
- `dispatch({ alert, matched, chatIds, eventType, sourceKey })`

`dispatch()` returns a summary object with:

- `sink`
- `acceptedCount`
- `duplicateCount`
- `skipped`
- `reason`
- `targets`

The smallest path for a new sink is:

1. Add a factory in `poller/alert-sinks.js`
2. Register its name in `ALERT_SINK_NAMES`
3. Wire it in `createPollerApp()` inside [poller/poller-app.js](../poller/poller-app.js)
4. Add docs/tests
