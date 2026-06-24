# Octopus Energy Rates

A [Cloudflare Worker](https://workers.cloudflare.com/) that proxies and caches Octopus Energy API data, backed by a [Cloudflare D1](https://developers.cloudflare.com/d1/) database.

- **Worker name:** `kraken`
- **D1 database name:** `kraken-db`

## Contents

- [Deployment](#deployment)
  - [Database](#database)
  - [Scheduled Job](#scheduled-job)
- [Local development](#local-development)
  - [Secrets](#secrets)
  - [Local D1 database](#local-d1-database)
  - [Running locally](#running-locally)
- [Usage](#usage)
  - [Endpoints](#endpoints)
  - [Response format](#response-format)
  - [Kasa device control](#kasa-device-control)

## Deployment

Deploy and manage this worker using the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/):

```bash
npx wrangler deploy
```

Set the required secrets with Wrangler before deploying:

```bash
npx wrangler secret put OCTOPUS_API_KEY
npx wrangler secret put OCTOPUS_ACCOUNT
npx wrangler secret put ELECTRICITY_MPAN
npx wrangler secret put ELECTRICITY_SERIAL
npx wrangler secret put GAS_MPRN
npx wrangler secret put GAS_SERIAL
npx wrangler secret put USER_ID
npx wrangler secret put TPLINK_USERNAME
npx wrangler secret put TPLINK_PASSWORD
```

`TPLINK_USERNAME` / `TPLINK_PASSWORD` are your TP-Link Kasa **cloud account** credentials, used to control Kasa smart plugs based on the energy rates (see [Kasa device control](#kasa-device-control)).

### Database

Update `wrangler.toml` with your D1 `database_id`:

1. Create the database if it doesn't exist:
   ```bash
   npx wrangler d1 create kraken-db
   ```
2. Copy the `database_id` from the output into `wrangler.toml`.
3. Create the tables:
   ```bash
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [rates] (noduplicates text PRIMARY KEY, user_id text, time_start text, time_end text, price text)"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [tariffs] (user_id text PRIMARY KEY, tariff_code text)"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [devices] (device_id text PRIMARY KEY, user_id text, alias text, strategy text, threshold_p real, hours real, enabled integer DEFAULT 1)"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [device_log] (id integer PRIMARY KEY AUTOINCREMENT, device_id text, ts text, action text, price real, reason text)"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [tplink_tokens] (user_id text PRIMARY KEY, token text, updated_at text)"
   ```

If you prefer to create the table in console, then use the following command:

```sql
CREATE TABLE IF NOT EXISTS [rates] (
  "noduplicates" text PRIMARY KEY,
  "user_id"      text,
  "time_start"   text,
  "time_end"     text,
  "price"        text
);

CREATE TABLE IF NOT EXISTS [tariffs] (
    user_id text PRIMARY KEY,
    tariff_code text
);

CREATE TABLE IF NOT EXISTS [devices] (
    device_id   text PRIMARY KEY,  -- TP-Link cloud deviceId
    user_id     text,
    alias       text,
    strategy    text,              -- 'threshold' | 'cheapest_hours'
    threshold_p real,              -- for 'threshold': switch on at/below this price (pence)
    hours       real,              -- for 'cheapest_hours': keep on during the cheapest N hours of the day
    enabled     integer DEFAULT 1
);

CREATE TABLE IF NOT EXISTS [device_log] (
    id          integer PRIMARY KEY AUTOINCREMENT,
    device_id   text,
    ts          text,
    action      text,              -- 'on' | 'off'
    price       real,
    reason      text
);

CREATE TABLE IF NOT EXISTS [tplink_tokens] (
    user_id    text PRIMARY KEY,
    token      text,
    updated_at text
);
```

### Scheduled Job

The worker runs on two cron triggers, configured in `wrangler.toml`:

| Cron | Action |
|------|--------|
| `32 */4 * * *` | Fetch the latest rates and insert them into D1 (same as `/api/octopus/rates/update`). |
| `0,30 * * * *` | Evaluate the Kasa device rules against the current rate and switch as needed (same as `/api/kasa/sync`). |

The `scheduled()` handler dispatches on `event.cron`. Adjust the schedules as needed before deploying.

## Local development

### Secrets

Create a `.dev.vars` file in the project root (already gitignored) with your real values:

```ini
OCTOPUS_API_KEY=sk_live_...
OCTOPUS_ACCOUNT=A-XXXXXXXX
ELECTRICITY_MPAN=...
ELECTRICITY_SERIAL=...
GAS_MPRN=...
GAS_SERIAL=...
USER_ID=...
TPLINK_USERNAME=you@example.com
TPLINK_PASSWORD=...
```

Wrangler reads this file automatically when running locally — no changes to `wrangler.toml` are needed.

### Local D1 database

Create the table in the local D1 database (stored in `.wrangler/`):

```bash
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [rates] (noduplicates text PRIMARY KEY, user_id text, time_start text, time_end text, price text)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [tariffs] (user_id text PRIMARY KEY, tariff_code text)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [devices] (device_id text PRIMARY KEY, user_id text, alias text, strategy text, threshold_p real, hours real, enabled integer DEFAULT 1)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [device_log] (id integer PRIMARY KEY AUTOINCREMENT, device_id text, ts text, action text, price real, reason text)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [tplink_tokens] (user_id text PRIMARY KEY, token text, updated_at text)"
```

### Running locally

```bash
npm run dev
```

The worker will be available at `http://localhost:8787`. Wrangler will use `.dev.vars` for secrets and `.wrangler/` for the local D1 database. The scheduled job can be triggered manually with:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Usage

### Endpoints

| Path | Description |
|------|-------------|
| `GET /api/octopus/rates/update` | Fetches the latest Agile tariff half-hourly unit rates from the Octopus Energy API and inserts them into the D1 database. Requires `Authorization: Bearer <OCTOPUS_API_KEY>`. Returns the inserted rate data. |
| `GET /api/octopus/rates/cache` | Returns rate entries from the local D1 database cache, ordered by most recent first. Supports query parameters (see below). |
| `GET /api/octopus/rates/live` | Fetches and returns the current unit rates directly from the Octopus Energy API without reading from or writing to the database. |
| `GET /api/octopus/meters/electricity` | Fetches consumption data for the configured electricity meter point from the Octopus Energy API. |
| `GET /api/octopus/meters/gas` | Fetches consumption data for the configured gas meter point from the Octopus Energy API. |
| `GET /api/octopus/tariff` | Returns the currently configured tariff code for the user. Requires `Authorization: Bearer <OCTOPUS_API_KEY>`. |
| `PUT /api/octopus/tariff` | Sets or updates the tariff code for the user. Requires `Authorization: Bearer <OCTOPUS_API_KEY>`. Body: `{"tariff_code": "E-1R-AGILE-FLEX-22-11-25-A"}`. |
| `GET /api/kasa/devices` | Lists the configured device control rules from D1. Requires auth. |
| `PUT /api/kasa/devices` | Creates or updates a device control rule. Requires auth. See [Kasa device control](#kasa-device-control). |
| `GET /api/kasa/devices/live` | Lists the devices on your TP-Link Kasa cloud account (with their `device_id`s). Requires auth. |
| `GET /api/kasa/sync` | Evaluates all enabled rules against the current rate and switches devices as needed. Returns the actions taken. Requires auth. |
| `GET /api/kasa/log` | Returns recent switching history from `device_log` (newest first). Supports `?limit=` (max 200). Requires auth. |

All `/api/kasa/*` endpoints require `Authorization: Bearer <OCTOPUS_API_KEY>`.

#### `/rates/cache` query parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | `96` | Number of results to return. Maximum `96`. |
| `page` | `1` | Page number for pagination. |
| `from` | — | Filter to rates with `time_start` on or after this value (ISO 8601, e.g. `2026-06-16`). |
| `to` | — | Filter to rates with `time_start` on or before this value (ISO 8601). |

### Response format

All paginated endpoints return the same envelope:

```json
{
  "count": 290,
  "next": "https://example.workers.dev/api/octopus/rates/cache?page=2&limit=96",
  "previous": null,
  "results": []
}
```

#### Rate object (`/rates/cache`)

```json
{
  "time_start": "2026-06-16T00:00:00Z",
  "time_end":   "2026-06-16T00:30:00Z",
  "price":      "14.3325"
}
```

#### Rate object (`/rates/live` and `/rates/update`)

```json
{
  "value_exc_vat": 13.65,
  "value_inc_vat": 14.3325,
  "valid_from":    "2026-06-16T00:00:00Z",
  "valid_to":      "2026-06-16T00:30:00Z",
  "payment_method": null
}
```

#### Consumption object (`/meters/electricity` and `/meters/gas`)

```json
{
  "consumption":     0.169,
  "interval_start":  "2026-06-15T00:30:00+01:00",
  "interval_end":    "2026-06-15T01:00:00+01:00"
}
```

### Kasa device control

The worker can switch TP-Link Kasa smart plugs on and off based on the cached
Octopus rates, turning dumb devices into rate-aware ones. It talks to the
TP-Link **cloud** API (the same path the Kasa app uses), so no local network
access to the plugs is required.

Each device is controlled by a rule stored in the `devices` table. Two
strategies are supported:

| Strategy | Fields | Behaviour |
|----------|--------|-----------|
| `threshold` | `threshold_p` | On when the current half-hourly price is at or below `threshold_p` pence, off otherwise. |
| `cheapest_hours` | `hours` | On during the cheapest `hours` hours of the current (UTC) day, off otherwise. Good for charging-type loads. |

#### Setup

1. Find your devices and their `device_id`s:
   ```bash
   curl -H "Authorization: Bearer $OCTOPUS_API_KEY" \
     https://<worker>/api/kasa/devices/live
   ```
2. Create a rule for a device:
   ```bash
   # Turn a plug on whenever the price is 15p or cheaper
   curl -X PUT -H "Authorization: Bearer $OCTOPUS_API_KEY" \
     -d '{"device_id":"80...","alias":"Dehumidifier","strategy":"threshold","threshold_p":15}' \
     https://<worker>/api/kasa/devices

   # Keep a plug on during the cheapest 4 hours of the day
   curl -X PUT -H "Authorization: Bearer $OCTOPUS_API_KEY" \
     -d '{"device_id":"81...","alias":"Battery","strategy":"cheapest_hours","hours":4}' \
     https://<worker>/api/kasa/devices
   ```
3. The `0,30 * * * *` cron evaluates every enabled rule each half hour. You can
   also trigger it manually:
   ```bash
   curl -H "Authorization: Bearer $OCTOPUS_API_KEY" https://<worker>/api/kasa/sync
   ```

A device's relay state is read before each switch, so the worker only sends a
command (and writes a `device_log` row) when the state actually needs to change.
Set `"enabled": false` on a rule to leave a device alone without deleting it.

