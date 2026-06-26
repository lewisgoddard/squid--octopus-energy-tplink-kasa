# TP-Link Tapo / SMART transport — plan

How Squid would talk to TP-Link's newer **SMART** protocol (Tapo-branded devices, and
newer Kasa firmware) over the cloud — the prerequisite that unblocks **TRV setpoints**
(KE100/KH100) and brings **Tapo plugs/bulbs/strips** into the same rate automation.

Status: **Phase 0 (research) done — see findings below.** The Tier-3 rule model (`invert` +
setpoint, inverted `cheaper_than_gas`, the evaluate setpoint pass, `hubOf`) is already
built and **gated** on this transport (`kasaSetTargetTemp` throws). See
[DEVICE_SUPPORT.md](DEVICE_SUPPORT.md) Tier 3.

> **⛔ Headline result (CONFIRMED on production workerd): a Worker can't reach the Tapo
> cloud.** The protocol is *simpler* than feared (second login + HMAC-SHA1 signing + a
> plaintext passthrough — **no device RSA/KLAP/AES**), but it only runs on TP-Link's **V2
> hosts (`n-*.tplinkcloud.com`), which use a private TP-Link CA**. A deployed spike proved:
> `fetch` → **526 Invalid SSL Certificate** (edge rejects the private CA), and
> `node:tls`/`connect()` → **"consider using fetch instead"** (workerd won't open a raw
> socket to a web service to work around it). So a **pure-Worker Tapo transport is not
> feasible — a relay (or local control) is required.** This is the "cert problem", on the
> cloud gateway. The rest of this plan stands *once* a reachability path exists.

## Why this, and what it unblocks

- **KE100 TRV setpoints** — KE100 speaks SMART, not Kasa IOT. Setpoint logic is done; only
  the write is missing.
- **Tapo plugs/bulbs/strips** (P100/P110/P300, L530, …) — same SMART cloud; today invisible
  to Squid. P110 even exposes energy data.
- **Newer Kasa "v2" firmware** on the V2 cloud.

## Phase 0 findings (the open questions, answered)

Grounded in piekstra/tplink-cloud-api (a **pure-cloud** lib supporting both Kasa and Tapo),
TA2k/ioBroker.tapo, python-kasa, and Cloudflare docs. No hardware — treat as
reference-verified, not live-verified.

**Q1 — Separate login? YES (same credentials).** Tapo uses the **V2 cloud**:
`POST https://n-wap.i.tplinkcloud.com/api/v2/account/login` with `appType/appName =
TP-Link_Tapo_Android`, `cloudUserName`/`cloudPassword`/`terminalUUID` → `result.token`
(+ refresh token). Same TP-Link account as Kasa, but a **separate token + host** (and a
distinct app AccessKey/SecretKey). Devices via `GET /api/v2/common/getDeviceListByPage`.

**Q2 — Cloud relay path? `passthrough`, plaintext, but signed.**
`POST {host}/api/v2/common/passthrough?token=…` with body `{deviceId, requestData}` where
`requestData` is the **plaintext** inner command, e.g. `{"method":"set_device_info",
"params":{"target_temp":21}}`, JSON-stringified. **No per-device encryption** — the cloud
owns the device's secure session. Every V2 request is **HMAC-SHA1 signed**:
- `Content-MD5: base64(md5(body))`
- `X-Authorization: Timestamp=9999999999, Nonce=<uuid>, AccessKey=<app key>, Signature=<hex hmacSHA1(secret, "{md5}\n9999999999\n{nonce}\n{path}")>`
- App keys are hardcoded from the Tapo APK (not user secrets).

**Q3 — KLAP vs securePassthrough? Neither, for cloud.** KLAP / old-RSA-securePassthrough /
TPAP-SPAKE2+ are **local** device handshakes (only when talking to the device on the LAN).
Over the cloud the session is the cloud's job, so the KE100/KH100 is just `control_child` +
`set_device_info` inside the signed V2 passthrough. **This removes the entire crypto
subsystem from the plan.**

**Q4 — Workers crypto? Not a constraint.** The only crypto the cloud path needs is **MD5 +
HMAC-SHA1** for signing — both in `node:crypto` (full API in Workers with `nodejs_compat`;
WebCrypto also does HMAC-SHA1). The earlier RSA-PKCS1v1.5 worry is moot (no RSA needed; and
`node:crypto` has `publicEncrypt` anyway).

**Q5 (new) — TLS / private CA? The blocker.** piekstra ships `tplink-ca-chain.pem` and
builds a custom SSL context because *"the V2 API servers (`n-*.tplinkcloud.com`) use
TP-Link's private CA, which is not in the system trust store"* (root `tp-link-CA` →
`TP-LINK CA P1` → `*.tplinkcloud.com`). Workers `fetch()` validates against the **public**
root store with **no API to add a CA or skip verification** (the mTLS binding presents a
*client* cert; Workers VPC only added *Cloudflare's own* Origin CA). So
`fetch('https://n-wap.i.tplinkcloud.com/…')` from a Worker should fail the TLS handshake.
(Note: Squid's current Kasa path uses the **V1** host `wap.tplinkcloud.com`, which has a
public cert — that's why it works today.)

## Does this break the pure-Worker design?

Probably, for the cloud path — unless one of these works:

| Option | Idea | Verdict |
|---|---|---|
| **`fetch` as-is** | Hope the V2 host chains to a public root | Very unlikely (private CA is explicit) |
| **`node:tls` + `connect()`** | Raw TLS socket with the TP-Link CA as `ca`, speak HTTP/1.1 manually | Skip-verify **ruled out** (see spike); custom-`ca` **unconfirmed** (deploy-only) |
| **External relay** | A tiny non-Worker service / Container / Tunnel origin that holds the CA and forwards | Works, but abandons "no extra infra" |
| **Local agent** | Control Tapo locally via a home box (HA, etc.) Squid calls | Biggest change; see the Matter discussion |

## Phase 1 — TLS spike result

Live probes settled the `fetch` question; a Worker spike (`spike/tapo-tls-spike/`) tested the
`node:tls` escape hatch in `workerd`:

- **`fetch` → blocked (certain).** `openssl`/`curl` reject `n-wap.i.tplinkcloud.com` against
  the public store (`issuer = TP-Link Cloud Server CA`, `verify code 20`); `curl --cacert
  <chain>` passes (HTTP 405) — i.e. the CA *works if trusted*. Workers `fetch` has no way to
  add it.
- **`connect()` → blocked (certain).** `SocketOptions` is only `secureTransport`/`allowHalfOpen`
  — no CA / no `rejectUnauthorized`.
- **`node:tls` skip-verify → ruled out.** `tls.connect({ rejectUnauthorized: false })` throws
  **"The options.rejectUnauthorized option is not implemented"** in workerd.
- **`node:tls` custom `ca` → ruled out (deployed test).** The spike was **deployed to the real
  edge** and hit there. `fetch` returned **526 (Invalid SSL Certificate)** — Cloudflare rejects
  the private-CA origin. Both `node:tls` attempts (default *and* custom `ca`) failed with
  **"proxy request failed … It looks like you might be trying to connect to a HTTP-based
  service — consider using fetch instead"** — i.e. **workerd refuses raw-socket/`node:tls`
  connections to HTTP(S) web services**, full stop. So you can't hand-roll HTTPS to bypass the
  trust store; the custom-`ca` idea is moot because you can't open the socket at all.

**Bottom line: every pure-Worker path is closed, confirmed on production `workerd`.** A
Cloudflare Worker **cannot reach the Tapo V2 cloud** — `fetch` won't trust the private CA, and
`node:tls`/`connect()` won't open a socket to a web service to work around it. **A relay (or
local control) is required.**

## Revised architecture (if the TLS spike passes)

Much smaller than the original crypto-heavy plan:

- `tapoToken(env)` — V2 login to the Tapo host, cache token+refresh (new `tapo_tokens` row).
- `signV2(bodyJson, path)` — Content-MD5 + X-Authorization (md5 + HMAC-SHA1, `node:crypto`).
- `smartCall(env, dev, method, params, childId?)` — signed `POST /api/v2/common/passthrough`
  with `requestData = {method, params}` (wrap a hub child in `control_child`). Reachability
  via whatever the TLS spike proves (`node:tls` socket or relay).
- `kasaSetTargetTemp` (currently throws) → `smartCall("set_device_info", {target_temp})`.
- **Transport selection:** tag each snapshot device `proto: "iot" | "smart"`; route reads/
  writes accordingly. Rule engine, `resolveTarget`/`hubOf`, snapshot, endpoints stay
  protocol-agnostic.

## Phases

0. **✅ Research** — done.
1. **✅ TLS spike** — done & **deployed** to the real edge. Result: pure-Worker is impossible
   (526 on `fetch`; `node:tls` won't socket to a web service). → a **relay** is required.
2. **⛳ Decide + stand up a relay** (now the gating step) — Container/DO sidecar, or external
   box via Tunnel. Everything below runs *on the relay*.
3. **Login + device list** — `tapoToken`, signed V2 `getDeviceListByPage`.
4. **One Tapo plug end-to-end** — read + on/off via signed `passthrough`. Validates auth +
   signing + transport before hubs.
5. **Hub children** — `control_child` for KE100; un-gate `kasaSetTargetTemp`.
6. **Integrate** — `proto` routing; Tapo plugs/bulbs join the existing on/off + colour rules.

## Risks & constraints

- **TLS private CA (Q5)** — the make-or-break; resolve in Phase 1 before any other build.
- **No hardware** — validate against references + the live TLS/login spike only.
- **Request signing brittleness** — exact sig string / hardcoded app keys can change with
  app versions; copy from a current reference and expect to bump `appVer`.
- **Account lockout / MFA** — V2 surfaces MFA + lockout error codes; reuse cached tokens,
  back off, surface clearly.
- **Regional hosts** — saw `n-wap.i…`, `n-euw1-wap-gw…`, `euw1-app-server.iot.i.tplinknbu.com`;
  the login/account-status call likely returns the right regional URL to use.

## Recommendation

The deployed spike settled it: **a pure-Worker Tapo transport is not possible** (the Worker
can't trust the private CA via `fetch`, and can't open a raw socket to work around it). The
protocol itself is small and understood — so the work is now entirely about **reachability**:

1. **Pick a relay** (the realistic options, smallest first):
   - **Cloudflare Container / Durable-Object sidecar** — runs Node with a normal TLS stack
     that can trust the bundled TP-Link CA; the Worker calls it over a binding. Keeps it all
     on Cloudflare.
   - **Tiny always-on box** (VPS / home server / the user's existing infra) running the Tapo
     calls, exposed to the Worker via a Tunnel or signed HTTP.
   - **Local control** (Matter / Home Assistant) — covered in the Matter discussion.
2. **Then** the transport is small: `tapoToken` (V2 login) + HMAC-SHA1 signing + V2
   `passthrough` (plaintext `requestData`) run *on the relay*; the Worker calls the relay and
   un-gates `kasaSetTargetTemp`. No device-level crypto.

Until a relay exists, Tier-3 TRV writes stay gated (the rule model is already done and inert).
This is a **product/infra decision** — confirm the relay shape before building.

## Sources

- **piekstra/tplink-cloud-api** (pure cloud, Kasa+Tapo V2) — `client.py` (hosts/login),
  `device_client.py` (`/api/v2/common/passthrough`, plaintext requestData), `signing.py`
  (MD5 + HMAC-SHA1, app keys), `certs/__init__.py` (**private CA** note)
- TA2k/ioBroker.tapo — `src/main.ts` (Tapo appType, `n-*-wap-gw` hosts, `getChildDevices`)
- "Reverse engineering TP-Link Tapo's REST API" (HmacSHA1 signing) —
  https://dev.to/ad1s0n/reverse-engineering-tp-link-tapos-rest-api-part-1-4g6
- python-kasa `klaptransport.py` (KLAP = symmetric, local-only — not needed for cloud)
- Cloudflare: Workers `fetch` trusts public CAs only / mTLS binding is client-cert only —
  https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/
</content>
