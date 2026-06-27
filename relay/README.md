# Tapo / Kasa-v2 cloud relay

A minimal, **stateless, credential-free** HTTPS passthrough for TP-Link's **V2 cloud**
(Tapo and newer "Kasa v2" devices), packaged as a Cloudflare Container.

## Why it exists

TP-Link's V2 cloud hosts (`n-*.tplinkcloud.com`, `*.iot.i.tplinknbu.com`) present
certificates from TP-Link's **private CAs**, which a Cloudflare Worker's `fetch()` won't
trust — and `node:tls`/`connect()` can't open a raw socket to a web service to work around
it (both verified, see `../.claude/plans/TAPO_SMART_TRANSPORT.md`). A container has a normal
TLS stack, so it can trust the bundled CAs and reach those hosts. This relay does *only*
that: terminate TLS and forward.

## How it works

```
Squid Worker ──(Container binding)──▶ worker.mjs ──▶ TapoRelay container ──▶ TP-Link V2 cloud
  signs every request                 secret gate     forwarder.mjs (CA trust + allowlist)
```

- **`forwarder.mjs`** — reads the target URL from `X-Forward-To`, checks the host allowlist
  (`*.tplinkcloud.com`, `*.tplinknbu.com`), forwards the request verbatim (method, headers
  incl. the caller's signed `X-Authorization`/`Content-MD5`, body) with `tplink-roots.pem`
  trusted, and streams the response back.
- **`worker.mjs`** — entry Worker: gates on a shared secret (`RELAY_SECRET`) and routes to
  the container.
- **`tplink-roots.pem`** — both TP-Link private roots (Tapo "Cloud Root CA"; Kasa/NBU
  "tp-link-CA") + intermediates.

It holds **no TP-Link credentials and no state** — the caller (Squid) does the V2 login,
HMAC-SHA1 signing, and token handling; this just adds CA trust + a host allowlist.

## Deploy

Requires **Containers enabled** on the account (Workers Paid plan). Then:

```bash
cd relay
npm ci
npx wrangler secret put RELAY_SECRET   # required — the Worker 401s until this is set
npx wrangler deploy
```

`RELAY_SECRET` is a **secret**, not a `[vars]` entry — secrets persist across deploys and
aren't clobbered, so an automated (e.g. GitHub Actions) `wrangler deploy` keeps it intact.
Never add it to `wrangler.toml`'s `[vars]`: that committed plaintext would override the
secret on every deploy. (For local dev, put it in `relay/.dev.vars`.)

Validate end-to-end (expect a real TP-Link JSON error, not a TLS failure):

```bash
curl -H "x-relay-secret: <secret>" \
     -H "X-Forward-To: https://n-wap.i.tplinkcloud.com/api/v2/common/passthrough" \
     https://tapo-relay.<subdomain>.workers.dev/
# -> {"error_code":-10000,"msg":"405 ... Method Not Allowed"}
```

The forwarder logic + CA bundle are validated locally (it forwards to all three V2 hosts
with real responses); only the Cloudflare Container deploy needs the account entitlement.

## Scaling & placement

- **One instance today.** `max_instances = 1`, and `worker.mjs` routes to a single named
  instance (`getContainer(env.RELAY, "relay")`). The forwarder is stateless and I/O-bound, so
  one instance handles the half-hourly cron + manual control comfortably, and it scales to
  zero between uses (`sleepAfter`).
- **To scale later** (only if concurrency demands it): raise `max_instances` and load-balance
  across interchangeable instances with `getRandom(env.RELAY, N)` instead of the fixed name —
  no state or affinity to worry about.
- **Placement: EU.** `[containers.constraints] jurisdiction = "eu"` pins the instance to EU
  data centres (a compliance boundary), since it transits per-user TP-Link traffic. Each
  instance runs in a single location regardless (containers are Durable-Object-backed); the
  constraint just bounds *which* region. Swap to `regions = ["WEUR"]` for nearest-to-UK
  geographic placement without the EU-only boundary.
