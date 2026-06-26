# TP-Link Tapo / SMART transport — plan

How Squid would talk to TP-Link's newer **SMART** protocol (Tapo-branded devices, and
newer Kasa firmware) over the cloud — the prerequisite that unblocks **TRV setpoints**
(KE100/KH100) and brings **Tapo plugs/bulbs/strips** into the same rate automation.

Status: **not started.** The Tier-3 rule model (`invert` + setpoint, inverted
`cheaper_than_gas`, the evaluate setpoint pass, `hubOf`) is already built and **gated**
on this transport — `kasaSetTargetTemp` throws until it exists. See
[DEVICE_SUPPORT.md](DEVICE_SUPPORT.md) Tier 3.

## Why this, and what it unblocks

- **KE100 TRV setpoints** — KE100 speaks SMART (`set_device_info {"target_temp"}`), not
  Kasa IOT, so it can't ride our current `passthrough`. The setpoint logic is done; only
  the write is missing.
- **Tapo plugs/bulbs/strips** (P100/P110/P300, L530, …) — same SMART protocol; today
  they're invisible to Squid. Same rate rules would apply (P110 even has energy data).
- **Newer Kasa "v2" firmware** that moved to KLAP auth.

## Guiding principle

Stay **cloud-only** (no LAN footprint — Squid is a Worker). Add a **second transport**
beside the existing Kasa IOT one, selected per device, reusing the rule/evaluate/snapshot
machinery unchanged. Don't rewrite the Kasa path; devices that work today keep working.

## Background: two protocols, two crypto layers

| | Kasa IOT (today) | SMART (this plan) |
|---|---|---|
| Login appType | `Kasa_Android` @ `wap.tplinkcloud.com` | `TP-Link_Tapo_Android` (Tapo/NBU cloud — endpoint **TBC**) |
| Cloud call | `passthrough { deviceId, requestData }`, **plaintext** JSON | encrypted session inside a cloud relay |
| Command shape | `{"system":{"set_relay_state":…}}` | `{"method":"set_device_info","params":{…}}` |
| Children | strip outlets via `context.child_ids` | hub children via `control_child` / `get_child_device_list` |
| Session crypto | none | **securePassthrough** *or* **KLAP** (below) |

### The crypto — and the Workers angle (the crux)

- **securePassthrough (older Tapo fw):** client RSA keypair → device returns an AES key
  **RSA-encrypted with PKCS#1 v1.5**, then AES-CBC bodies. ⚠️ **WebCrypto can't do RSA
  PKCS1v1.5 encryption** (only RSA-OAEP) — this path needs a JS RSA shim.
- **KLAP (newer fw, preferred):** handshake derives the session key from **SHA-256 of
  credential hashes + client/server seeds** (no RSA), then **AES-CBC + per-request
  sequence/signature**. All primitives (SHA-256, HMAC, AES-CBC) are **native to Workers'
  SubtleCrypto** → KLAP is the Worker-friendly route and avoids the RSA gap.

This is *not* the "v2 cert problem" — that (self-signed device TLS certs / skip-verify) is
a **local-control** issue. Cloud-only sidesteps it; the cost here is the session crypto.

## Architecture / fit

Today's layer: `tplinkToken` → `tplinkCall` → `kasaPassthrough(dev, cmd, childId?)`.
Mirror it:

- `tapoToken(env)` — SMART login (separate appType/endpoint, cached like `tplink_tokens`,
  new `tapo_tokens` row or a `proto` column).
- `smartSession(env, dev)` — KLAP handshake → cached session keys (short-lived).
- `smartCall(env, dev, method, params, childId?)` — encrypt `{method,params}` (wrapping in
  `control_child` for a hub child), POST to the cloud relay, decrypt the response.
- `kasaSetTargetTemp` (currently throws) → calls `smartCall("set_device_info",{target_temp})`.
- **Transport selection:** tag each snapshot device with `proto: "iot" | "smart"` (from
  which login/list it came from, or deviceType), and route reads/writes accordingly. The
  rule engine, `resolveTarget`/`hubOf`, snapshot and endpoints stay protocol-agnostic.

## Phased implementation (each phase independently verifiable where possible)

0. **Spike + verify (no code commitment):** confirm against python-kasa `klaptransport.py`
   / `aestransport.py` + TA2k/ioBroker.tapo (cloud flow): exact KLAP handshake bytes, the
   Tapo cloud login endpoint, whether one login surfaces both Kasa+Tapo or two are needed,
   and that Workers SubtleCrypto covers every primitive. **Gate the rest on this.**
1. **Tapo cloud login + device list** — get a token, enumerate SMART devices.
2. **KLAP session** — handshake + encrypt/decrypt helpers (unit-test vectors offline).
3. **One Tapo plug end-to-end** — read state + on/off. Validates the whole stack on a
   simple device before touching hubs.
4. **Hub children** — `get_child_device_list` on KH100, `control_child` for KE100; wire
   `kasaSetTargetTemp`; un-gate the setpoint pass.
5. **Integrate** — `proto` routing in the snapshot + device endpoints; Tapo plugs/bulbs
   join the existing on/off + colour rules.

## Risks & constraints

- **No hardware** — validate against references + offline crypto test vectors; treat live
  behaviour as unverified (same constraint as the rest of the device work).
- **Workers limits** — CPU time for crypto (fine for AES/SHA), subrequest count per
  request (handshake + call = multiple round-trips), no raw TCP needed (cloud is HTTPS).
- **No RSA PKCS1v1.5 in WebCrypto** — pushes us to KLAP; only fall back to a JS RSA shim if
  a target device is securePassthrough-only.
- **Account lockout** — extra login/handshake traffic; reuse cached tokens/sessions, back
  off on errors (as the Kasa path already does).
- **KLAP variance** — v1 vs v2 hash ordering differs by firmware; may need both.

## Open questions to resolve in Phase 0

1. Does the existing Kasa login/`getDeviceList` already return Tapo/SMART devices (with a
   different `deviceType`), or is a wholly separate Tapo login + endpoint required?
2. What is the cloud relay path for an encrypted SMART command (host, method, how the
   KLAP blob is carried)? — TA2k/ioBroker.tapo is the closest cloud reference.
3. KLAP vs securePassthrough per target device (KE100/KH100 specifically)?
4. Confirm SubtleCrypto covers the exact KLAP primitives (AES-CBC, SHA-256, HMAC).

## Recommendation

KLAP-first, cloud-only, phased — and **do Phase 0 before committing**, because the cloud
relay path (Q2) is the single biggest unknown and determines whether this is feasible
within Squid's architecture at all. Skip securePassthrough/RSA unless a needed device
demands it.

## Sources

- python-kasa SMART transports — `kasa/transports/klaptransport.py`, `aestransport.py`
- Tapo **cloud** control (closest to our model) — https://github.com/TA2k/ioBroker.tapo
- KLAP reverse-engineering — python-kasa device fixtures / protocol docs
- Tapo local protocol refs — https://github.com/python-kasa/python-kasa · pytapo
