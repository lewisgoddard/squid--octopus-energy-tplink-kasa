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
npx wrangler secret put SQUID_API_KEY
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

`SQUID_API_KEY` is the bearer token that gates every `/api/*` endpoint (see [Endpoints](#endpoints)). `OCTOPUS_API_KEY` is the upstream Octopus Energy credential used server-side to call the Octopus API — it is **not** the app's auth key. `TPLINK_USERNAME` / `TPLINK_PASSWORD` are your TP-Link Kasa **cloud account** credentials, used to control Kasa smart plugs based on the energy rates (see [Kasa device control](#kasa-device-control)).

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
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [gas_rates] (noduplicates text PRIMARY KEY, user_id text, time_start text, time_end text, price text)"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [tariffs] (user_id text PRIMARY KEY, tariff_code text, gas_tariff_code text, gas_price_p real)"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [rules] (rule_id text PRIMARY KEY, user_id text, name text, strategy text, threshold_p real, hours real, efficiency real DEFAULT 1, enabled integer DEFAULT 1, color_config text, invert integer DEFAULT 0, comfort_c real, setback_c real)"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [rule_devices] (rule_id text, device_id text, user_id text, PRIMARY KEY (rule_id, device_id))"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [device_log] (id integer PRIMARY KEY AUTOINCREMENT, device_id text, user_id text, ts text, action text, price real, reason text)"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [tplink_tokens] (user_id text PRIMARY KEY, token text, updated_at text)"
   npx wrangler d1 execute kraken-db --remote --command "CREATE TABLE IF NOT EXISTS [device_cache] (user_id text PRIMARY KEY, json text, updated_at text)"
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

-- gas_rates mirrors rates and backs the 'cheaper_than_gas' strategy.
CREATE TABLE IF NOT EXISTS [gas_rates] (
  "noduplicates" text PRIMARY KEY,
  "user_id"      text,
  "time_start"   text,
  "time_end"     text,
  "price"        text
);

CREATE TABLE IF NOT EXISTS [tariffs] (
    user_id text PRIMARY KEY,
    tariff_code text,
    gas_tariff_code text,          -- auto-discovered gas tariff (for 'cheaper_than_gas')
    gas_price_p real               -- manual gas unit-rate override (pence/kWh); NULL = use fetched gas rate
);

-- A rule is the automation definition; rule_devices tags devices onto it.
-- Many devices per rule, and many rules per device (a device is ON if ANY of
-- its rules wants it on).
CREATE TABLE IF NOT EXISTS [rules] (
    rule_id      text PRIMARY KEY,  -- generated UUID (migrated rules reuse the old device_id)
    user_id      text,
    name         text,              -- display label for the rule
    strategy     text,              -- 'threshold' | 'cheapest_hours' | 'cheaper_than_gas' | 'price_color'
    threshold_p  real,              -- for 'threshold': switch on at/below this price (pence)
    hours        real,              -- for 'cheapest_hours': keep on during the cheapest N hours of the day
    efficiency   real DEFAULT 1,    -- for 'cheaper_than_gas': on when elec price <= gas price x efficiency
    enabled      integer DEFAULT 1,
    color_config text,              -- for 'price_color': JSON { bands:[{up_to_p,hue}…], saturation, brightness }
    invert       integer DEFAULT 0, -- flip the strategy's boolean (e.g. on when NOT cheap)
    comfort_c    real,              -- setpoint mode (TRV): target °C when the rule is active
    setback_c    real               -- setpoint mode (TRV): target °C otherwise
);

CREATE TABLE IF NOT EXISTS [rule_devices] (
    rule_id   text,
    device_id text,                -- TP-Link cloud deviceId
    user_id   text,
    PRIMARY KEY (rule_id, device_id)
);

CREATE TABLE IF NOT EXISTS [device_log] (
    id          integer PRIMARY KEY AUTOINCREMENT,
    device_id   text,
    user_id     text,
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

-- Cron-refreshed snapshot of the TP-Link device list (ids/names/online), served
-- to the metadata-only endpoints so they don't call the cloud per request.
CREATE TABLE IF NOT EXISTS [device_cache] (
    user_id    text PRIMARY KEY,
    json       text,            -- the getDeviceList array; enriched from get_sysinfo with a
                                -- strip's `children` (outlets) and a bulb's `caps` (colour etc.)
    updated_at text
);
```

### Scheduled Job

The worker runs on two cron triggers, configured in `wrangler.toml`:

| Cron | Action |
|------|--------|
| `32 * * * *` | Refresh rates into D1 (same as `POST /api/octopus/rates/refresh`). Runs hourly, but `updateRates` skips the Octopus API pull when today + tomorrow are already cached (and before the ~4pm publish if tomorrow isn't out yet), so most runs are cheap no-ops. |
| `0,30 * * * *` | Evaluate the Squid device rules against the current rate and switch as needed (same as `POST /api/squid/evaluate`). |

The `scheduled()` handler dispatches on `event.cron`. Adjust the schedules as needed before deploying.

## Local development

### Secrets

Create a `.dev.vars` file in the project root (already gitignored) with your real values:

```ini
SQUID_API_KEY=...
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

`SQUID_API_KEY` is the bearer token for all `/api/*` endpoints. `OCTOPUS_API_KEY` is the upstream Octopus Energy credential — it is only used server-side to call the Octopus API, not as the app's auth key.

Wrangler reads this file automatically when running locally — no changes to `wrangler.toml` are needed.

### Local D1 database

Create the table in the local D1 database (stored in `.wrangler/`):

```bash
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [rates] (noduplicates text PRIMARY KEY, user_id text, time_start text, time_end text, price text)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [gas_rates] (noduplicates text PRIMARY KEY, user_id text, time_start text, time_end text, price text)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [tariffs] (user_id text PRIMARY KEY, tariff_code text, gas_tariff_code text, gas_price_p real)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [rules] (rule_id text PRIMARY KEY, user_id text, name text, strategy text, threshold_p real, hours real, efficiency real DEFAULT 1, enabled integer DEFAULT 1, color_config text, invert integer DEFAULT 0, comfort_c real, setback_c real)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [rule_devices] (rule_id text, device_id text, user_id text, PRIMARY KEY (rule_id, device_id))"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [device_log] (id integer PRIMARY KEY AUTOINCREMENT, device_id text, user_id text, ts text, action text, price real, reason text)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [tplink_tokens] (user_id text PRIMARY KEY, token text, updated_at text)"
npx wrangler d1 execute kraken-db --local --command "CREATE TABLE IF NOT EXISTS [device_cache] (user_id text PRIMARY KEY, json text, updated_at text)"
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

All `/api/*` endpoints require `Authorization: Bearer <SQUID_API_KEY>`.

#### `octopus/` — Octopus Energy data

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/octopus/rates` | Returns rate entries from the D1 cache, ordered by most recent first. Supports query parameters (see below). |
| `GET` | `/api/octopus/rates/live` | Fetches and returns the current unit rates directly from the Octopus Energy API without reading from or writing to the database. |
| `POST` | `/api/octopus/rates/refresh` | Refreshes the latest Agile tariff half-hourly unit rates (and gas) from Octopus into D1. Skips the API pull when today + tomorrow are already cached, returning `{"refreshed":false,"reason":...}`; otherwise returns `{"refreshed":true,"inserted":N}`. |
| `GET` | `/api/octopus/tariff` | Returns the configured tariff: `account` (Octopus account id), `tariff_code`, `gas_tariff_code`, `gas_rate_p` (the auto-fetched flat gas unit rate), `gas_price_override_p` (manual override, if set), and `gas_price_effective_p` (override ?? fetched — what `cheaper_than_gas` actually uses). |
| `PUT` | `/api/octopus/tariff` | Sets the electricity tariff and/or the gas price override. Body: `{"tariff_code": "E-1R-AGILE-FLEX-22-11-25-A"}` and/or `{"gas_price_override_p": 6.5}` (pass `gas_price_override_p: null` to clear the override and fall back to the auto-fetched gas rate). |
| `GET` | `/api/octopus/meters/:fuel` | Fetches consumption data from the Octopus Energy API. `:fuel` is `electricity` or `gas`. |

#### `kasa/` — TP-Link hardware proxy

`GET /api/kasa/devices` and `GET /api/kasa/devices/:id` go to the TP-Link cloud **live** for current relay (on/off) state. Everywhere else that needs device ids/names — resolving a `:id`, overlaying display names on rules/log — reads a **snapshot** of the device list (`device_cache`) instead of calling the cloud, sparing the API and the account-lockout risk. The snapshot is refreshed by the half-hourly evaluate cron **and by every live `kasa/devices`/`kasa/devices/:id` read** (they persist the list they fetch), so it's typically very fresh. A renamed/added/removed device shows up in the metadata endpoints after the next snapshot refresh; the two live endpoints reflect it immediately.

A `:id` may be a `device_id`, an **outlet id** (see [Power strips](#power-strips-per-outlet)), or a (unique) device/outlet **name**.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/kasa/devices` | Lists real devices from your TP-Link Kasa cloud account (**live**), including each device's `status` (online) and `on` (relay state: `true`/`false`, or `null` when offline or unreadable). A power strip is listed as a container (`on: null`, `outlets: N`) followed by one row per outlet (each with `parent_id`, `parent_alias`, and its own `on`). |
| `GET` | `/api/kasa/devices/:id` | Returns the **live** state of a single device or outlet. A strip parent returns the container with an `outlets` array; an outlet id/name returns just that outlet. |
| `POST` | `/api/kasa/devices/:id/state` | Manually switch a device or outlet on or off. Body: `{"on": true}`. Works for plugs, switches, strip outlets **and bulbs** (bulbs switch via the lighting service). Logs a `manual` entry. A strip *parent* is rejected (409) unless the strip has a master relay — otherwise target a specific outlet. |
| `POST` | `/api/kasa/devices/:id/light` | Sets a **bulb's** colour / brightness / on-off. Body: any of `on` (bool), `hue` (0–360), `saturation` (0–100), `brightness` (0–100), `color_temp` (K; `0`/omitted = colour mode). Bulbs only (else 409). |
| `GET` | `/api/kasa/devices/:id/usage` | Reads raw energy data from a device's (or outlet's) emeter. Query: `kind` (`realtime`, `day` or `month`; default `realtime`), `year`, `month` (default current UTC). |
| `GET` | `/api/kasa/devices/:id/energy` | Live **energy use** (Kasa app's Energy Use view). Returns `realtime` (`power_w`, `voltage_v`, `current_a`), `today` (`total_wh`), `last_7_days` and `last_30_days` (each `total_wh` + `daily_avg_wh`). From the emeter module. On a strip, address a specific outlet (per-outlet emeter, e.g. HS300); bulbs have no emeter (409). |
| `GET` | `/api/kasa/devices/:id/runtime` | Live **runtime** (Kasa app's Runtime view). Returns `realtime` (`current_runtime_s` = current on-session), `today` (`total_min`), `last_7_days` and `last_30_days` (each `total_min` + `daily_avg_min`). From `get_sysinfo.on_time` + the `schedule` module's per-day minutes. On a strip, address a specific outlet. |
| `GET` | `/api/kasa/devices/:id/rules` | Reads the on-device firmware rules for a device or outlet (`schedule`, `count_down`, `anti_theft`). Note: this only surfaces device-level rules set in the Kasa app's "Device" section — cloud Smart Actions (geofencing, device triggers) are **not** retrievable via this API. |

#### `squid/` — rate-based automation

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/squid/rules` | Lists all rate-based automation rules, each with its tagged `devices`. |
| `POST` | `/api/squid/rules` | Creates a rule. Body: `{"name?","strategy","threshold_p"\|"hours"\|"efficiency","enabled?","device_ids?":[...]}`. Optional `invert` (flip the decision) and `comfort_c`+`setback_c` (setpoint mode → drives a TRV; see [Heating](#heating-trv-setpoints)). For `price_color`: `bands` or `cheap_p`/`expensive_p` (+ optional `saturation`, `brightness`) — see [Price-status colour indicator](#price-status-colour-indicator). Returns the generated `rule_id`. `device_ids` accept a deviceId, outlet id or unique name (resolved + validated like the tag endpoint); an id unsuitable for the strategy is rejected (409). |
| `GET` | `/api/squid/rules/:ruleId` | Returns one rule with its tagged devices. |
| `PUT` | `/api/squid/rules/:ruleId` | Updates a rule's definition (not its device tags). |
| `DELETE` | `/api/squid/rules/:ruleId` | Deletes a rule and all its device tags. |
| `POST` | `/api/squid/rules/:ruleId/devices/:id` | **Tags** a device/outlet onto the rule (`:id` = deviceId, outlet id or name). Rejected (409) if unsuitable for the rule's strategy — a strip *parent* without a master relay (any strategy), or a non-colour device on a `price_color` rule. |
| `DELETE` | `/api/squid/rules/:ruleId/devices/:id` | **Untags** a device from the rule, leaving the rule intact. |
| `GET` | `/api/squid/forecast` | Read-only preview of which half-hour slots each enabled rule would fire, plus the `devices` it is tagged to, computed from cached rates (no Kasa calls, no switching). Defaults to today + tomorrow (UTC); pass `?date=YYYY-MM-DD` for a single day. On/off rules include `on_slots`, `on_hours` and the qualifying `slots`; `price_color` rules instead include `bands` (`hue`, `up_to_p`, `slots`, `hours` per colour band). |
| `POST` | `/api/squid/evaluate` | Evaluates all enabled rules against the current rate and switches devices as needed. Returns the actions taken. |
| `GET` | `/api/squid/log` | Returns recent switching history from `device_log` (newest first). Supports `?limit=` (max 200). |

#### `/api/octopus/rates` query parameters

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
  "next": "https://example.workers.dev/api/octopus/rates?page=2&limit=96",
  "previous": null,
  "results": []
}
```

#### Rate object (`/api/octopus/rates`)

```json
{
  "time_start": "2026-06-16T00:00:00Z",
  "time_end":   "2026-06-16T00:30:00Z",
  "price":      "14.3325"
}
```

#### Rate object (`/api/octopus/rates/live` and `/api/octopus/rates/refresh`)

```json
{
  "value_exc_vat": 13.65,
  "value_inc_vat": 14.3325,
  "valid_from":    "2026-06-16T00:00:00Z",
  "valid_to":      "2026-06-16T00:30:00Z",
  "payment_method": null
}
```

#### Consumption object (`/api/octopus/meters/electricity` and `/api/octopus/meters/gas`)

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

The API is split into two domains: `kasa/` proxies the TP-Link hardware
(listing devices, reading state, manual switching, energy monitoring, and
on-device firmware rules), while `squid/` holds the rate-based automation
(rules, forecast, evaluate, and switching log).

Automation is defined by **rules** (the `rules` table). Devices are **tagged**
onto a rule (`rule_devices`) — a rule can drive **many devices**, and a device
can belong to **many rules**. When a device is tagged to several rules it is
switched **on if _any_ of them wants it on** (any-on). The strategies are:

| Strategy | Fields | Behaviour |
|----------|--------|-----------|
| `threshold` | `threshold_p` | On when the current half-hourly price is at or below `threshold_p` pence, off otherwise. |
| `cheapest_hours` | `hours` | On during the cheapest `hours` hours of the current (UTC) day, off otherwise. Good for charging-type loads. |
| `cheaper_than_gas` | `efficiency` | On when the current electricity price is at or below `gas_price × efficiency` pence, off otherwise. `efficiency` (default `1`) is the device's output-per-unit advantage over gas — e.g. `~3.3` for a heat pump (COP 3) vs a 90% boiler, `~1.1` for a resistive heater. The gas price is the `gas_price_override_p` if set, else the flat gas unit rate auto-fetched from your Octopus gas tariff (see `GET /api/octopus/tariff`). |
| `price_color` | `bands` / `cheap_p`+`expensive_p` | Not an on/off rule: drives a tagged **bulb's colour** from the current price, as a glanceable "is now a good time?" indicator. See [Price-status colour indicator](#price-status-colour-indicator). |

The first three switch a load **on/off**. `price_color` instead colours a bulb; its bulbs are held on showing the band colour and are not part of the any-on on/off logic.

Two modifiers apply on top of the on/off strategies:

- **`invert`** (`true`/`false`) flips the strategy's decision — e.g. `cheaper_than_gas` + `invert` is on (or "comfort", below) when electricity is *dearer* than gas, not cheaper.
- **Setpoint mode** (`comfort_c` + `setback_c`, °C) makes the rule drive a **thermostat / TRV** instead of a relay: when the (possibly inverted) strategy is active the TRV targets `comfort_c`, otherwise `setback_c`. See [Heating (TRV setpoints)](#heating-trv-setpoints).

#### Setup

1. Find your devices (the response shows each device's `device_id`, online
   `status` and current `on` relay state):
   ```bash
   curl -H "Authorization: Bearer $SQUID_API_KEY" \
     https://<worker>/api/kasa/devices
   # {"results":[{"device_id":"80...","alias":"Smart Plug","model":"KP115(UK)","status":1,"on":true}]}
   ```
2. Create a rule (returns a generated `rule_id`). You can tag devices up front
   with `device_ids`, or leave it empty and tag them later:
   ```bash
   # On whenever the price is 15p or cheaper, applied to one plug
   curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
     -d '{"name":"Cheap power","strategy":"threshold","threshold_p":15,"device_ids":["80..."]}' \
     https://<worker>/api/squid/rules
   # -> {"rule_id":"f2b4edd5-...", ...}

   # Run heat pumps (COP 3 vs a 90% boiler) only when electricity beats gas
   curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
     -d '{"name":"Heat pumps","strategy":"cheaper_than_gas","efficiency":3.3}' \
     https://<worker>/api/squid/rules
   ```
   The gas price comes from your Octopus gas tariff automatically. If you're not
   on an Octopus gas tariff, set a manual rate: `PUT /api/octopus/tariff` with
   `{"gas_price_override_p": 6.5}`.
3. Tag or untag devices on a rule at any time (without deleting the rule).
   `:id` may be a `device_id` or a (unique) alias:
   ```bash
   # Tag a device onto the rule
   curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
     https://<worker>/api/squid/rules/f2b4edd5-.../devices/82...
   # Untag it again (rule stays)
   curl -X DELETE -H "Authorization: Bearer $SQUID_API_KEY" \
     https://<worker>/api/squid/rules/f2b4edd5-.../devices/82...
   ```
4. The `0,30 * * * *` cron evaluates every enabled rule each half hour. You can
   also trigger it manually:
   ```bash
   curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
     https://<worker>/api/squid/evaluate
   ```
5. Preview which slots each rule will fire (read-only, from cached rates):
   ```bash
   curl -H "Authorization: Bearer $SQUID_API_KEY" \
     https://<worker>/api/squid/forecast            # today + tomorrow (UTC)
   curl -H "Authorization: Bearer $SQUID_API_KEY" \
     "https://<worker>/api/squid/forecast?date=2026-06-25"   # a single day
   ```

A device's relay state is read before each switch, so the worker only sends a
command (and writes a `device_log` row) when the state actually needs to change.
Set `"enabled": false` on a rule to pause it without deleting it. To remove a
rule entirely: `DELETE /api/squid/rules/:ruleId` (its device tags are removed
too; the devices themselves are untouched).

#### Manual device control

You can also switch a device on or off directly, outside of any rule:

```bash
curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
  -d '{"on": true}' \
  https://<worker>/api/kasa/devices/80.../state
```

#### Power strips (per-outlet)

A multi-outlet power strip (HS300, KP303, EP40, …) is a single TP-Link device
whose outlets are **children** of one `deviceId`. The strip itself has no single
relay — each outlet switches independently — so Squid treats **each outlet as
its own switchable load**.

- **Outlet id.** An outlet's id is the strip's `deviceId` followed by a 2-digit
  index, e.g. `<deviceId>00`, `<deviceId>01`. It is shown in the device list and
  is used everywhere a `device_id` is accepted (state, rules, energy, runtime) —
  so per-outlet support needs no special syntax. A unique outlet **name** also
  works; duplicate names (strips often ship outlets named "Plug 1"…) are reported
  as ambiguous, so use the id.
- **Listing.** `GET /api/kasa/devices` shows the strip as a container row
  (`on: null`, `outlets: N`) followed by one row per outlet (each with
  `parent_id`, `parent_alias` and its own `on`):
  ```bash
  curl -H "Authorization: Bearer $SQUID_API_KEY" https://<worker>/api/kasa/devices
  # {"results":[
  #   {"device_id":"8006…","alias":"Office Strip","model":"HS300(UK)","status":1,"on":null,"outlets":6},
  #   {"device_id":"8006…00","parent_id":"8006…","parent_alias":"Office Strip","alias":"Monitor","status":1,"on":true},
  #   {"device_id":"8006…01","parent_id":"8006…","parent_alias":"Office Strip","alias":"Desk Lamp","status":1,"on":false}, …
  # ]}
  ```
- **Switching / rules.** Address the outlet, not the strip:
  ```bash
  curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" -d '{"on":true}' \
    https://<worker>/api/kasa/devices/8006…01/state          # one outlet
  curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
    https://<worker>/api/squid/rules/<ruleId>/devices/8006…01  # tag that outlet
  ```
  Switching or tagging the strip *parent* is rejected (409) on the usual Kasa
  strips (HS300/KP303/EP40…): they have no top-level relay, and switching every
  outlet individually would lose each outlet's own state. The **only** exception is
  a strip that exposes a real **master relay** (`get_sysinfo.relay_state`) — there
  the parent switches the whole strip losslessly and may be tagged like any device.
  Squid caches whether a strip has a master (`master` flag) so it knows which is which.
- **Energy / runtime.** Read per outlet too (the HS300 has a per-outlet emeter);
  `energy`/`runtime`/`usage` on a strip parent return a 409 asking for an outlet.

#### Bulbs & lights

Smart bulbs and light strips (`IOT.SMARTBULB`, e.g. KL130, KL430) are supported
as on/off loads just like plugs — tag them to any on/off rule and they switch on
the lighting service instead of a relay. They generally have no energy meter, so
`/energy` returns a 409. Their capability flags (`caps`: `color`, `dimmable`,
`variable_color_temp`) are read from `get_sysinfo` once and cached in the snapshot
(they don't change) and reported on the device endpoints; a colour request to a
non-colour bulb (here or via a `price_color` rule) is rejected/skipped. You can
also drive a bulb's colour, brightness and on/off directly:

```bash
# Turn on, full-brightness green
curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
  -d '{"on":true,"hue":120,"saturation":100,"brightness":100}' \
  https://<worker>/api/kasa/devices/Lamp/light

# Warm white at 40%
curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
  -d '{"color_temp":2700,"brightness":40}' \
  https://<worker>/api/kasa/devices/Lamp/light
```

#### Price-status colour indicator

A `price_color` rule turns a colour bulb into a glanceable price gauge — green
when power is cheap, red when it's dear — so you can tell at a glance whether now
is a good time to run the dishwasher, washing machine or other flexible load.

Bands are **absolute pence cutoffs** (ascending; the last band is the catch-all).
The quickest way is the `cheap_p` / `expensive_p` shorthand, which expands to the
green / amber / red traffic light:

```bash
# Green ≤ 10p, amber ≤ 20p, red above — applied to a colour bulb
curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
  -d '{"name":"Price light","strategy":"price_color","cheap_p":10,"expensive_p":20,"device_ids":["<bulb deviceId>"]}' \
  https://<worker>/api/squid/rules
```

For full control, give explicit `bands` (each `up_to_p` + `hue` 0–360; omit
`up_to_p` on the last for the catch-all) plus optional `saturation` / `brightness`
(0–100, applied to every band):

```bash
curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
  -d '{"name":"Price light","strategy":"price_color",
       "bands":[{"up_to_p":5,"hue":120},{"up_to_p":15,"hue":40},{"hue":0}],
       "saturation":100,"brightness":70,"device_ids":["<bulb deviceId>"]}' \
  https://<worker>/api/squid/rules
```

The half-hourly evaluate cron re-colours the bulb as the price moves (only
sending a command when the band actually changes), and holds it on. A bulb driven
by a `price_color` rule is excluded from on/off switching, so don't also tag it to
a load-switching rule. `GET /api/squid/forecast` shows how many hours fall in each
band over today + tomorrow.

Tagging only accepts a colour-capable bulb: a non-bulb (plug/switch/outlet) is
rejected (409), as is a bulb whose cached `caps.color` is `false`. A bulb whose
capabilities aren't cached yet is accepted, and the evaluate pass skips it
(`no colour support`) if it turns out not to support colour.

#### Heating (TRV setpoints)

A rule with `comfort_c` + `setback_c` (and an on/off strategy to gate them) is a
**setpoint rule** that drives a thermostatic radiator valve's target temperature
instead of switching a relay. Combined with `invert`, it complements a heat pump:
the *same* price condition that turns the heat pump on sets the gas radiator down,
and vice-versa.

```bash
# Heat pump: run when electricity beats gas (COP ~3 vs a 90% boiler)
curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
  -d '{"name":"Heat pump","strategy":"cheaper_than_gas","efficiency":3.3,"device_ids":["<heat-pump plug>"]}' \
  https://<worker>/api/squid/rules

# Gas TRV: the inverse — comfort (21°) when electricity is DEARER than gas, setback
# (16°) when electricity is cheaper (let the heat pump do the work).
curl -X POST -H "Authorization: Bearer $SQUID_API_KEY" \
  -d '{"name":"Gas radiator","strategy":"cheaper_than_gas","efficiency":3.3,"invert":true,"comfort_c":21,"setback_c":16,"device_ids":["<TRV>"]}' \
  https://<worker>/api/squid/rules
```

A setpoint rule may only be tagged to a thermostat; on/off and colour rules may
not target one. The evaluate pass computes the target temperature each half hour
and logs it.

> **⚠️ Not yet operational.** KE100-class TRVs (via a KH100 hub) speak the
> **SMART/Tapo** protocol — `set_device_info {"target_temp": …}` over an encrypted
> `securePassthrough` after a Tapo login — which is a different transport from the
> Kasa IOT passthrough Squid uses for plugs/strips/bulbs. The rule model, the
> inverted-`cheaper_than_gas` logic and the setpoint computation are all in place
> and tested, but the actual TRV write is **gated** (`kasaSetTargetTemp` throws and
> the evaluate pass reports the intended temperature without sending) until a Tapo
> cloud transport is added. That transport — a separate `appType` login +
> `securePassthrough` + `control_child` — also unlocks Tapo plugs/bulbs, and is the
> recommended next step.

#### On-device firmware rules

`GET /api/kasa/devices/:id/rules` reads the schedule, countdown, and
anti-theft rules stored on the device's firmware. These are the rules
visible in the Kasa app's "Device" section. Cloud Smart Actions (geofencing,
device triggers) are managed entirely by TP-Link's servers and are **not**
retrievable via this API.

#### Energy monitoring

For devices with energy monitoring (an emeter), `/api/kasa/devices/:id/usage`
reads consumption directly from the plug. `:id` accepts a `device_id`, an outlet
id, or a (unique) name:

```bash
# Live readings (voltage / current / power / total)
curl -H "Authorization: Bearer $SQUID_API_KEY" \
  "https://<worker>/api/kasa/devices/Dehumidifier/usage"

# Per-day totals for a given month
curl -H "Authorization: Bearer $SQUID_API_KEY" \
  "https://<worker>/api/kasa/devices/Dehumidifier/usage?kind=day&year=2026&month=6"

# Per-month totals for a given year
curl -H "Authorization: Bearer $SQUID_API_KEY" \
  "https://<worker>/api/kasa/devices/Dehumidifier/usage?kind=month&year=2026"
```

