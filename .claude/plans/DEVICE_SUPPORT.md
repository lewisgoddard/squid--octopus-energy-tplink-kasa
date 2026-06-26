# Device Support — Kasa / Tapo range and how Squid would implement it

Research notes + implementation plan for supporting more TP-Link device types beyond
the single-relay smart plug we control today.

## Guiding principle

Device **category** matters less than its **control model**. Squid is a rate-driven
**load switcher** (turn loads on/off — and log energy — based on Octopus rates), so a
device is valuable to Squid only if it has a controllable *electrical load worth
time-shifting*, and feasible only if we can *address* it through the cloud passthrough.

Everything below rides the same transport we already use: TP-Link cloud
`login → getDeviceList → passthrough`. None of these APIs are officially documented;
all are community reverse-engineering.

## Capability matrix (mapped to Squid)

| Category | Examples | Control model | Energy data | Addressing | Squid fit |
|---|---|---|---|---|---|
| **Plugs** | KP115, HS110, EP25 | relay on/off | emeter (KP/EP series) | direct | ★★★ already done |
| **Power strips** | HS300, KP303, EP40 | **per-outlet** relay | per-outlet emeter (HS300) | direct + child outlets | ★★★ (needs per-outlet) |
| **Wall switches** | HS200, KS200 | relay on/off | usually none | direct | ★★★ identical to plugs |
| **Dimmers** | HS220, KS225 | relay + brightness | none | direct | ★★ on/off fits; dim optional |
| **Bulbs** | KL130, KL125 | on/off + brightness/colour/temp | small/none | direct | ★★ on/off fits |
| **Light strips** | KL430, KL420 | on/off + colour + effects | small | direct | ★★ on/off fits |
| **TRVs / thermostats** | **KE100**, T310 | **target-temperature setpoint** | none (heat is usually gas) | **hub child** | ★ new model, weak elec-rate value |
| **Sensors** | T100/T110/T315 | read-only state (input) | n/a | hub child | ✗ an input, not a load |
| **Buttons** | S200B/S200D | event source — **presses not exposed via API** | n/a | hub child | ✗ can't see the press |
| **Vacuums** | RV30, RV20 | start/pause/dock (**task**) | n/a | direct, device-specific | ★ niche: run in a cheap slot |
| **Cameras / doorbells** | C210, D230 | AV config (privacy/detection) | n/a | direct, device-specific | ✗ not a controllable load |

## Tier-by-tier implementation notes

### Tier 1 — drop-in (relay): plugs, switches, strips
Same `system.set_relay_state` / `get_sysinfo.relay_state` passthrough we already use.
The one addition is **power strips**: each outlet is a *child* on the same device,
addressed with `context.child_ids` in the passthrough; `get_sysinfo` returns a
`children[]` array with per-outlet `relay_state`. So a strip = "N switchable loads
under one deviceId" — a modest device-model extension. HS300 also exposes per-outlet
emeter, so the energy/runtime endpoints extend naturally.

### Tier 2 — lights (bulbs, dimmers, light strips)
On/off works exactly like Tier 1, so they fit today if treated as relays. Their extra
dimension (brightness/colour via `smartlife.iot.smartbulb.lightingservice` →
`transition_light_state`) is a *different command path*, so "dim when expensive" means
branching on `deviceType`. Low priority — lights are tiny loads; rate-shifting saves pennies.

### Tier 3 — heating (TRVs / thermostats)
Most energy-significant category, but the **worst fit for Squid's lever**:
1. Control is a **setpoint, not on/off** — needs a new rule type ("comfort temp when
   cheap, setback when expensive"), not the desired-on/off model.
2. A radiator TRV controls **gas** heat, and gas isn't time-of-use priced — so the
   electricity-rate arbitrage Squid is built on doesn't apply. The electric heating
   loads that *do* benefit (heat pumps, immersion, storage heaters, EV chargers) are
   almost always **plugs/switches** (Tier 1).
3. KE100 is a **hub child** (KH100/H100 → `getChildDeviceList` / `controlChild`) — an
   addressing layer we don't have yet.

### Tier 4 — inputs (sensors, buttons): not loads
These would *drive* automation ("if cold AND cheap, heat"), not be switched. But the
API barely cooperates: **S200B/S200D button presses are not exposed** (only battery),
and sensors are hub children with limited event access. Enrichment idea blocked by API
reality — skip.

### Tier 5 — appliances / AV
**Vacuums** are the one curiosity: a *task* ("start cleaning"), cloud-controllable, so
"run a clean during the cheapest half-hour" is a legitimate (if niche) rate-automation —
but it's a start-task verb, not on/off, with a device-specific command set.
**Cameras/doorbells** are AV config, not loads — out of scope.

## Cross-cutting work this implies

1. **Branch on `deviceType`** (`getDeviceList` already returns it, e.g.
   `IOT.SMARTPLUGSWITCH`, `IOT.SMARTBULB`). Today we assume relay plugs; supporting
   bulbs/strips means picking the command path per type.
2. **A child-device layer** for strips (outlets) and hub-connected gear (TRVs/sensors):
   different addressing (`child_ids` / `controlChild`). The biggest structural addition.
3. **Generalise "desired state"** beyond on/off if we ever want setpoint (TRV) or task
   (vacuum) rules — they don't fit the boolean model.
4. **Tapo vs Kasa auth.** All rides the same cloud passthrough, but Tapo devices log in
   under a different `appType` (`TP-Link_Tapo_Android`) and "require authentication" —
   reaching Tapo gear may need a second login flow alongside the Kasa one.

## Recommendation / suggested order

1. ~~**Power-strip per-outlet**~~ — ✅ **done.** Outlets are first-class loads keyed
   by their native child id (`<deviceId>NN`), scoped via `context.child_ids`; this
   slots into `rule_devices`/`device_log`/URLs with no schema change. A strip is
   listed as a container + per-outlet rows; on/off + rule-tagging of the bare strip
   parent are rejected **unless** the strip exposes a top-level master relay
   (cached `master` flag) — looping outlets would lose each outlet's state, so a
   master-less strip is per-outlet only. Per-outlet emeter/runtime supported
   (HS300). Outlet names + caps + master are learned from `get_sysinfo` and cached.
2. ~~**Bulbs/dimmers as relays**~~ — ✅ **done.** `kasaSetState` branches on
   `deviceType`: `IOT.SMARTBULB` switches via `transition_light_state` (lighting
   service), others keep the relay; reads fall back to `light_state.on_off`.
   Went beyond on/off: a `price_color` rule strategy colours a bulb by the current
   price (absolute pence bands → hue; green/amber/red default, configurable),
   evaluated in a separate indicator pass (those bulbs are excluded from on/off and
   held on). Plus a manual `POST /api/kasa/devices/:id/light` (hue/sat/brightness/
   on). Bulbs have no emeter → `/energy` returns 409. Dimmer *brightness* still
   deferred (dimmers switch on/off fine via the relay path already).
3. **Child-device layer** — ✅ done for strips (`context.child_ids`), and a `hubOf`
   resolver exists for hub children (exact child-id match). Hub *enumeration* of
   TRVs still needs the SMART transport (below).
4. **TRV setpoint rules** — ⏳ rule model done, write gated. `invert` flag (flips any
   strategy) + setpoint mode (`comfort_c`/`setback_c`) drive a thermostat; inverted
   `cheaper_than_gas` is the headline (gas radiator comforts when elec is dearer).
   `ruleTargetError` pairs setpoint↔thermostat. **Blocked:** KE100 is SMART/Tapo
   protocol (`set_device_info{target_temp}` over `securePassthrough`), not Kasa IOT —
   `kasaSetTargetTemp` throws until a Tapo transport lands. That transport is the
   real prerequisite and also unlocks Tapo plugs/bulbs (cross-cutting #4). Vacuum
   "clean in cheap slot" still later.
5. **Out of scope:** sensors, buttons (API can't see events), cameras/doorbells (not loads).

Keep the core focus on the **relay tier** — that's where the electricity-rate value lives
(heat pump / immersion / EV charger / dehumidifier), and it's our existing model.

## Open questions / caveats

- Does the account expose Tapo devices via the same Kasa login, or do we need a separate
  Tapo `appType` login? (Affects whether Tapo support is "free" or a parallel auth flow.)
- Newer devices "require authentication" (KLAP) — cloud passthrough abstracts this, but
  confirm per device type.
- Hub-child polling cost: child state may need `getChildDeviceList` per hub (extra calls);
  fold into the device snapshot model.

## Sources

- python-kasa supported devices & modules — https://python-kasa.readthedocs.io/en/stable/SUPPORTED.html
- S200B button press not exposed (HA issue) — https://github.com/petretiandrea/home-assistant-tapo-p100/issues/770
- Tapo RV30 local control integration — https://github.com/epg-pers/tapo-rv30-ha
- pytapo / Tapo camera control — https://pypi.org/project/pytapo/
- KE100 TRV (hub-connected, Kasa/Tapo) — https://www.tapo.com/uk/faq/377/
- Reference cloud libraries — https://github.com/python-kasa/python-kasa · https://github.com/piekstra/tplink-cloud-api · https://github.com/TA2k/ioBroker.tapo
