# TP-Link Tapo / SMART transport — plan

How Squid would talk to TP-Link's newer **SMART** protocol (Tapo-branded devices, and
newer Kasa firmware) over the cloud — the prerequisite that unblocks **TRV setpoints**
(KE100/KH100) and brings **Tapo plugs/bulbs/strips** into the same rate automation.

Status: **Phase 0 (research) done — see findings below.** The Tier-3 rule model (`invert` +
setpoint, inverted `cheaper_than_gas`, the evaluate setpoint pass, `hubOf`) is already
built and **gated** on this transport (`kasaSetTargetTemp` throws). See
[DEVICE_SUPPORT.md](DEVICE_SUPPORT.md) Tier 3.

> **⛔ Headline result: a hard TLS blocker, not the crypto we feared.** The cloud control
> protocol turned out *simpler* than expected (a second login + request signing + a
> plaintext passthrough — **no device-level RSA/KLAP/AES**). But Tapo cloud control only
> runs on TP-Link's **V2 cloud hosts (`n-*.tplinkcloud.com`), which present certs from a
> private TP-Link CA** that isn't in any public trust store. Cloudflare Workers `fetch()`
> trusts only public CAs and can't add one — so a pure Worker likely **can't reach the
> Tapo cloud at all**. This is the "cert problem," resurfaced on the cloud gateway.
> Feasibility now hinges on one test (the TLS spike, below), not on protocol work.

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
| **`node:tls` + `connect()`** | Raw TLS socket with the TP-Link CA as `ca`, speak HTTP/1.1 manually | **The one to test.** Needs Workers' `node:tls` to honour a custom `ca` — unverified, and means hand-rolling HTTP |
| **External relay** | A tiny non-Worker service / Container / Tunnel origin that holds the CA and forwards | Works, but abandons "no extra infra" |
| **Local agent** | Control Tapo locally via a home box (HA, etc.) Squid calls | Biggest change; see the Matter discussion |

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

0. **✅ Research** — done (above).
1. **🔬 TLS spike (gates everything):** from a Worker, `fetch` `n-wap.i.tplinkcloud.com`
   (expect TLS failure), then try `node:tls`/`connect()` with the TP-Link CA chain. If
   neither reaches the host, the pure-Worker approach is dead → decide relay vs. local.
2. **Login + device list** — `tapoToken`, signed V2 `getDeviceListByPage`.
3. **One Tapo plug end-to-end** — read + on/off via signed `passthrough`. Validates auth +
   signing + transport before hubs.
4. **Hub children** — `control_child` for KE100; un-gate `kasaSetTargetTemp`.
5. **Integrate** — `proto` routing; Tapo plugs/bulbs join the existing on/off + colour rules.

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

**Do the Phase-1 TLS spike first — it's a ~20-line test and it decides feasibility.** The
protocol work is now small and well-understood; the only thing that can sink a pure-Worker
implementation is the private-CA TLS trust. If `node:tls` can't supply a custom CA, the
realistic answer is a **small relay** (or local control), which is a product decision worth
taking before investing further.

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
