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
npx wrangler secret put RELAY_SECRET   # replace the wrangler.toml placeholder
npx wrangler deploy
```

Validate end-to-end (expect a real TP-Link JSON error, not a TLS failure):

```bash
curl -H "x-relay-secret: <secret>" \
     -H "X-Forward-To: https://n-wap.i.tplinkcloud.com/api/v2/common/passthrough" \
     https://tapo-relay.<subdomain>.workers.dev/
# -> {"error_code":-10000,"msg":"405 ... Method Not Allowed"}
```

The forwarder logic + CA bundle are validated locally (it forwards to all three V2 hosts
with real responses); only the Cloudflare Container deploy needs the account entitlement.
