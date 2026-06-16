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
```

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
```

### Scheduled Job

The worker also runs on a schedule, performing the same task as `/api/octopus/rates/update` — fetching the latest rates and inserting them into the D1 database.

The cron trigger is configured in `wrangler.toml` as `32 */4 * * *` (every 4 hours at :32). Adjust as needed before deploying.

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
```

Wrangler reads this file automatically when running locally — no changes to `wrangler.toml` are needed.

### Local D1 database

Create the table in the local D1 database (stored in `.wrangler/`):

```bash
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [rates] (noduplicates text PRIMARY KEY, user_id text, time_start text, time_end text, price text)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [tariffs] (user_id text PRIMARY KEY, tariff_code text)"
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

