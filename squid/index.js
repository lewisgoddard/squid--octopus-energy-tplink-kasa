import { createHash, createHmac } from "node:crypto"

/**
 * A device as returned by the TP-Link Kasa cloud `getDeviceList` call.
 * @typedef {Object} KasaDevice
 * @property {string} deviceId
 * @property {string} [alias]
 * @property {string} appServerUrl
 * @property {string} [deviceModel]
 * @property {string} [deviceType] - e.g. "IOT.SMARTPLUGSWITCH" or "IOT.SMARTBULB".
 * @property {number} status - 1 when the device is online.
 * @property {KasaOutlet[]} [children] - persisted outlets for a power strip
 *   (HS300/KP303/EP40…). Not returned by `getDeviceList`; learned from a
 *   `get_sysinfo` and kept in the snapshot so names/ids can be resolved and
 *   overlaid without a live call. See {@link refreshDeviceSnapshot}.
 * @property {KasaCaps} [caps] - bulb capability flags, learned from `get_sysinfo`
 *   and cached (they don't change). Lets colour ops be guarded without a live read.
 * @property {boolean} [master] - for a power strip: whether it exposes a top-level
 *   master relay (`get_sysinfo.relay_state`) that switches the whole strip at once.
 *   Most Kasa strips don't — those are controlled per-outlet only.
 */

/**
 * A smart bulb's (immutable) capability flags, from `get_sysinfo`.
 * @typedef {Object} KasaCaps
 * @property {boolean} color - supports hue/saturation colour.
 * @property {boolean} dimmable - supports brightness.
 * @property {boolean} variable_color_temp - supports white colour temperature.
 */

/**
 * Facts learned from a `get_sysinfo` that are worth caching in the snapshot: a
 * strip's outlets, whether it has a master relay, and a bulb's capability flags.
 * @typedef {Object} DeviceFacts
 * @property {KasaOutlet[]} [children]
 * @property {KasaCaps} [caps]
 * @property {boolean} [master] - strip has a top-level master relay (paired with children).
 */

/**
 * One outlet of a power strip. The `id` is the parent `deviceId` followed by a
 * 2-digit index (e.g. `<deviceId>00`), so it is globally unique and is used
 * directly as the addressable load id everywhere a deviceId is accepted (rules,
 * log, URLs) — per-outlet support needs no schema change.
 * @typedef {Object} KasaOutlet
 * @property {string} id
 * @property {string} [alias]
 * @property {number} [state] - relay state of this outlet: 0 (off) or 1 (on).
 */

/**
 * @param {string} url
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function octopusFetch(url, env) {
  return fetch(url, {
    headers: {
      "content-type": "application/json;charset=UTF-8",
      'Authorization': 'Basic ' + btoa(env.OCTOPUS_API_KEY + ":")
    },
  })
}

/**
 * Fetches the Octopus account JSON (properties, meter points, agreements).
 * @param {Env} env
 * @returns {Promise<any>}
 */
async function fetchOctopusAccount(env) {
  const response = await octopusFetch(
    `https://api.octopus.energy/v1/accounts/${env.OCTOPUS_ACCOUNT}/`,
    env
  )
  if (!response.ok) throw new Error(`Account lookup failed: ${response.status} ${await response.text()}`)
  return response.json()
}

/**
 * @param {Env} env
 * @param {any} [account] pre-fetched account JSON, to avoid a duplicate lookup
 */
async function syncTariff(env, account) {
  account ??= await fetchOctopusAccount(env)
  const now = new Date().toISOString()
  const meterPoint = account.properties
    ?.flatMap((/** @type {any} */ p) => p.electricity_meter_points || [])
    .find((/** @type {any} */ mp) => mp.mpan === env.ELECTRICITY_MPAN)
  if (!meterPoint) throw new Error(`MPAN ${env.ELECTRICITY_MPAN} not found in account ${env.OCTOPUS_ACCOUNT}`)
  const agreement = meterPoint.agreements?.find(
    (/** @type {any} */ a) => a.valid_from <= now && (!a.valid_to || a.valid_to > now)
  )
  if (!agreement) throw new Error(`No active agreement found for MPAN ${env.ELECTRICITY_MPAN}`)
  await env.DATABASE.prepare(
    "INSERT INTO tariffs (user_id, tariff_code) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET tariff_code = excluded.tariff_code"
  ).bind(env.USER_ID, agreement.tariff_code).run()
  return agreement.tariff_code
}

/** @param {Env} env */
async function fetchOctopusRates(env) {
  /** @type {{ tariff_code: string } | null} */
  const row = await env.DATABASE.prepare(
    "SELECT tariff_code FROM tariffs WHERE user_id = ?"
  ).bind(env.USER_ID).first()
  if (!row) throw new Error(`No tariff configured for user ${env.USER_ID}. Set it via PUT /api/octopus/tariff`)
  // Tariff code format: E-1R-{PRODUCT_CODE}-{REGION}
  const productCode = row.tariff_code.split("-").slice(2, -1).join("-")
  const ratesURL = `https://api.octopus.energy/v1/products/${productCode}/electricity-tariffs/${row.tariff_code}/standard-unit-rates/?page_size=96`
  const response = await octopusFetch(ratesURL, env)
  if (!response.ok) throw new Error(`Rates fetch failed: ${response.status} ${await response.text()}`)
  /** @type {Promise<any>} */
  const json = response.json()
  return json
}

/**
 * Resolves and stores the account's active gas tariff code, mirroring syncTariff.
 * @param {Env} env
 * @param {any} [account] pre-fetched account JSON, to avoid a duplicate lookup
 */
async function syncGasTariff(env, account) {
  account ??= await fetchOctopusAccount(env)
  const now = new Date().toISOString()
  const meterPoint = account.properties
    ?.flatMap((/** @type {any} */ p) => p.gas_meter_points || [])
    .find((/** @type {any} */ mp) => mp.mprn === env.GAS_MPRN)
  if (!meterPoint) throw new Error(`MPRN ${env.GAS_MPRN} not found in account ${env.OCTOPUS_ACCOUNT}`)
  const agreement = meterPoint.agreements?.find(
    (/** @type {any} */ a) => a.valid_from <= now && (!a.valid_to || a.valid_to > now)
  )
  if (!agreement) throw new Error(`No active gas agreement found for MPRN ${env.GAS_MPRN}`)
  await env.DATABASE.prepare(
    "INSERT INTO tariffs (user_id, gas_tariff_code) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET gas_tariff_code = excluded.gas_tariff_code"
  ).bind(env.USER_ID, agreement.tariff_code).run()
  return agreement.tariff_code
}

/** @param {Env} env */
async function fetchGasRates(env) {
  /** @type {{ gas_tariff_code: string | null } | null} */
  const row = await env.DATABASE.prepare(
    "SELECT gas_tariff_code FROM tariffs WHERE user_id = ?"
  ).bind(env.USER_ID).first()
  if (!row || !row.gas_tariff_code) throw new Error(`No gas tariff configured for user ${env.USER_ID}`)
  // Tariff code format: G-1R-{PRODUCT_CODE}-{REGION}
  const productCode = row.gas_tariff_code.split("-").slice(2, -1).join("-")
  const ratesURL = `https://api.octopus.energy/v1/products/${productCode}/gas-tariffs/${row.gas_tariff_code}/standard-unit-rates/?page_size=96`
  const response = await octopusFetch(ratesURL, env)
  if (!response.ok) throw new Error(`Gas rates fetch failed: ${response.status} ${await response.text()}`)
  /** @type {Promise<any>} */
  const json = response.json()
  return json
}

/**
 * @param {string} url
 * @param {Env} env
 * @param {string} selfURL
 */
async function fetchOctopusMeter(url, env, selfURL) {
  const response = await octopusFetch(url, env)
  /** @type {any} */
  const data = await response.json()
  const base = new URL(selfURL)
  const next = data.next
    ? (() => { const u = new URL(base); new URL(data.next).searchParams.forEach((v, k) => u.searchParams.set(k, v)); return u.toString() })()
    : null
  const previous = data.previous
    ? (() => { const u = new URL(base); new URL(data.previous).searchParams.forEach((v, k) => u.searchParams.set(k, v)); return u.toString() })()
    : null
  return Response.json({ count: data.count, next, previous, results: data.results })
}

// Next-day Agile rates publish in the afternoon (~4pm UK). 15:00 UTC ≈ 16:00 BST;
// before then there's nothing new to fetch, so we don't pull just to re-confirm
// today. (In winter/GMT this is ~3pm, an hour early — harmless, it just retries.)
const RATES_PUBLISH_HOUR_UTC = 15

/**
 * Refreshes Octopus rates into D1, but skips the API pull when it would be
 * wasteful: when today + tomorrow are already cached, or (before the afternoon
 * publish) when today is cached and tomorrow isn't out yet. Lets the cron run
 * frequently without hammering the Octopus API.
 * @param {Env} env
 */
async function updateRates(env) {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)
  /** @type {{ max: string | null } | null} */
  const row = await env.DATABASE.prepare(
    "SELECT MAX(time_start) AS max FROM rates WHERE user_id = ?"
  ).bind(env.USER_ID).first()
  const latest = row?.max ?? ""
  // The last half-hour slot of a UTC day starts at 23:30Z.
  if (latest >= `${tomorrow}T23:30:00Z`) {
    return { refreshed: false, reason: "today and tomorrow already cached", through: latest }
  }
  if (latest >= `${today}T23:30:00Z` && now.getUTCHours() < RATES_PUBLISH_HOUR_UTC) {
    return { refreshed: false, reason: "today cached; tomorrow not published yet", through: latest }
  }

  // Fetch the account once and reuse it for both tariff lookups.
  const account = await fetchOctopusAccount(env)
  await syncTariff(env, account)
  const { results } = await fetchOctopusRates(env)
  for (const element of results) {
    await env.DATABASE.prepare(
      "insert or ignore into rates (noduplicates, user_id, time_start, time_end, price) values (?, ?, ?, ?, ?)"
    )
      .bind(env.USER_ID + element.valid_from, env.USER_ID, element.valid_from, element.valid_to, element.value_inc_vat)
      .run()
  }
  // Gas rates back the 'cheaper_than_gas' strategy. A missing or non-standard gas
  // tariff must not fail the electricity refresh, so isolate any gas failure.
  try {
    await syncGasTariff(env, account)
    const { results: gasResults } = await fetchGasRates(env)
    for (const element of gasResults) {
      await env.DATABASE.prepare(
        "insert or ignore into gas_rates (noduplicates, user_id, time_start, time_end, price) values (?, ?, ?, ?, ?)"
      )
        // Flat gas tariffs return an open-ended period (valid_to null); store a
        // far-future end so the same time-window lookup as electricity works.
        .bind(env.USER_ID + element.valid_from, env.USER_ID, element.valid_from, element.valid_to ?? "9999-12-31T00:00:00Z", element.value_inc_vat)
        .run()
    }
  } catch (err) {
    console.error("Gas rate refresh failed (cheaper_than_gas rules may be stale):", err)
  }
  // Octopus returns rates newest-first; report the furthest-out coverage.
  const through = results.reduce((/** @type {string} */ m, /** @type {any} */ r) => (r.valid_to > m ? r.valid_to : m), "")
  return { refreshed: true, inserted: results.length, through: through || null }
}

// --- TP-Link Kasa cloud control ---------------------------------------------

/**
 * @param {string} url
 * @param {any} body
 * @returns {Promise<any>}
 */
async function tplinkPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`TP-Link HTTP ${response.status}: ${await response.text()}`)
  return response.json()
}

/**
 * @param {Env} env
 * @param {boolean} forceNew
 * @returns {Promise<string>}
 */
async function tplinkToken(env, forceNew) {
  if (!forceNew) {
    /** @type {{ token: string } | null} */
    const row = await env.DATABASE.prepare(
      "SELECT token FROM tplink_tokens WHERE user_id = ?"
    ).bind(env.USER_ID).first()
    if (row) return row.token
  }
  const data = await tplinkPost("https://wap.tplinkcloud.com", {
    method: "login",
    params: {
      appType: "Kasa_Android",
      cloudUserName: env.TPLINK_USERNAME,
      cloudPassword: env.TPLINK_PASSWORD,
      terminalUUID: crypto.randomUUID(),
    },
  })
  if (data.error_code !== 0) throw new Error(`TP-Link login failed: ${data.error_code} ${data.msg || ""}`)
  await env.DATABASE.prepare(
    "INSERT INTO tplink_tokens (user_id, token, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at"
  ).bind(env.USER_ID, data.result.token, new Date().toISOString()).run()
  return data.result.token
}

/**
 * Calls the cloud with the cached token, re-logging in once if it has expired.
 * @param {Env} env
 * @param {(token: string) => string} makeUrl
 * @param {any} body
 * @returns {Promise<any>}
 */
async function tplinkCall(env, makeUrl, body) {
  let data = await tplinkPost(makeUrl(await tplinkToken(env, false)), body)
  if (data.error_code !== 0) {
    data = await tplinkPost(makeUrl(await tplinkToken(env, true)), body)
  }
  if (data.error_code !== 0) throw new Error(`TP-Link error ${data.error_code}: ${data.msg || JSON.stringify(data)}`)
  return data.result
}

/**
 * @param {Env} env
 * @returns {Promise<KasaDevice[]>}
 */
async function kasaDeviceList(env) {
  const result = await tplinkCall(env, token => `https://wap.tplinkcloud.com/?token=${token}`, { method: "getDeviceList" })
  return result.deviceList || []
}

// Persisted snapshot of the TP-Link device list (ids/names/online/appServerUrl),
// refreshed by the cron. The metadata-only endpoints (id/alias resolution and
// display-name overlay) read this instead of calling the cloud on every request,
// sparing the API and the account-lockout risk. The two live endpoints
// (kasa/devices and kasa/devices/:id) deliberately bypass it for fresh relay state.

/**
 * Persists the device list as the metadata snapshot.
 * @param {Env} env
 * @param {KasaDevice[]} devices
 */
async function persistDeviceSnapshot(env, devices) {
  await env.DATABASE.prepare(
    "INSERT INTO device_cache (user_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at"
  ).bind(env.USER_ID, JSON.stringify(devices), new Date().toISOString()).run()
}

/**
 * Reads the persisted snapshot JSON, or null if not yet populated.
 * @param {Env} env
 * @returns {Promise<KasaDevice[] | null>}
 */
async function readDeviceSnapshot(env) {
  /** @type {{ json: string } | null} */
  const row = await env.DATABASE.prepare(
    "SELECT json FROM device_cache WHERE user_id = ?"
  ).bind(env.USER_ID).first()
  return row && row.json ? JSON.parse(row.json) : null
}

/**
 * Fetches the live device list and persists it as the metadata snapshot.
 * Called by the cron (reusing its existing getDeviceList) and on cold start.
 * `getDeviceList` returns neither a strip's outlets nor a bulb's caps, so any
 * previously-learned `children`/`caps` (from a `get_sysinfo` on a live read or
 * evaluate) are carried over rather than dropped — keeping them resolvable
 * between reads.
 * @param {Env} env
 * @returns {Promise<KasaDevice[]>}
 */
async function refreshDeviceSnapshot(env) {
  const [devices, prev] = await Promise.all([kasaDeviceList(env), readDeviceSnapshot(env).catch(() => null)])
  const prevById = new Map((prev || []).map(d => [d.deviceId, d]))
  const merged = devices.map(d => {
    const p = prevById.get(d.deviceId)
    return p ? { ...d, ...(p.children ? { children: p.children } : {}), ...(p.caps ? { caps: p.caps } : {}), ...(p.master != null ? { master: p.master } : {}) } : d
  })
  await persistDeviceSnapshot(env, merged)
  return merged
}

/**
 * The persisted device-metadata snapshot. Lazily populates from the cloud the
 * first time, before the cron has run.
 * @param {Env} env
 * @returns {Promise<KasaDevice[]>}
 */
async function snapshotDeviceList(env) {
  return (await readDeviceSnapshot(env)) ?? (await refreshDeviceSnapshot(env))
}

/**
 * Map of id -> display name from the snapshot, for overlaying names onto stored
 * rows (rules, log). Includes both whole devices and strip outlets (keyed by
 * their child id), so a tagged outlet shows its own name. Resilient: empty map
 * on failure so reads fall back to the stored alias rather than failing.
 * @param {Env} env
 * @returns {Promise<Map<string, string | undefined>>}
 */
async function aliasMap(env) {
  const devices = await snapshotDeviceList(env).catch(() => /** @type {KasaDevice[]} */ ([]))
  /** @type {Map<string, string | undefined>} */
  const map = new Map()
  for (const d of devices) {
    map.set(d.deviceId, d.alias)
    for (const c of d.children || []) {
      // Outlet name, qualified by the strip so it reads unambiguously in logs.
      map.set(c.id, c.alias ? (d.alias ? `${d.alias} / ${c.alias}` : c.alias) : d.alias)
    }
  }
  return map
}

/**
 * Extracts persistable outlet metadata from a `get_sysinfo`. Empty for a
 * single-relay device (no `children`).
 * @param {any} sysinfo - the `system.get_sysinfo` object.
 * @returns {KasaOutlet[]}
 */
function childrenFromSysinfo(sysinfo) {
  return (sysinfo?.children || []).map((/** @type {any} */ c) => ({ id: c.id, alias: c.alias, state: c.state }))
}

/**
 * Extracts a bulb's capability flags from a `get_sysinfo`, or undefined for a
 * device that doesn't report them (plugs/switches/strips).
 * @param {any} sysinfo - the `system.get_sysinfo` object.
 * @returns {KasaCaps | undefined}
 */
function capsFromSysinfo(sysinfo) {
  if (!sysinfo || (sysinfo.is_color == null && sysinfo.is_dimmable == null && sysinfo.is_variable_color_temp == null)) {
    return undefined
  }
  return { color: !!sysinfo.is_color, dimmable: !!sysinfo.is_dimmable, variable_color_temp: !!sysinfo.is_variable_color_temp }
}

/**
 * The cacheable facts from a `get_sysinfo`: a strip's outlets, whether the strip
 * has a master relay, and a bulb's caps.
 * @param {any} sysinfo - the `system.get_sysinfo` object.
 * @returns {DeviceFacts}
 */
function factsFromSysinfo(sysinfo) {
  const children = childrenFromSysinfo(sysinfo)
  // A strip with a top-level relay_state can be switched as a whole (lossless);
  // most strips lack it and are controlled per-outlet.
  return { children, caps: capsFromSysinfo(sysinfo), master: children.length > 0 && sysinfo?.relay_state != null }
}

/**
 * Folds freshly-read facts (strip outlets, bulb caps) into the snapshot, so they
 * resolve/guard without another live call. A no-op when nothing changed or the
 * snapshot isn't populated yet. Best-effort: never throws.
 * @param {Env} env
 * @param {Map<string, DeviceFacts>} factsByDevice - keyed by deviceId.
 */
async function persistDeviceFacts(env, factsByDevice) {
  if (!factsByDevice.size) return
  const devices = await readDeviceSnapshot(env).catch(() => null)
  if (!devices) return
  let changed = false
  const updated = devices.map(d => {
    const f = factsByDevice.get(d.deviceId)
    if (!f) return d
    let next = d
    // master is a property of a strip, so it's learned/stored together with children.
    if (f.children && f.children.length) { next = { ...next, children: f.children, master: !!f.master }; changed = true }
    if (f.caps) { next = { ...next, caps: f.caps }; changed = true }
    return next
  })
  if (changed) await persistDeviceSnapshot(env, updated).catch(() => {})
}

/**
 * Sends a passthrough command to a device, optionally scoped to a single outlet
 * of a power strip. The strip's `deviceId` stays the addressed device; the outlet
 * is selected by wrapping the payload with `context.child_ids` — the same shape
 * python-kasa uses for HS300/KP303/EP40 children.
 * @param {Env} env
 * @param {KasaDevice} dev
 * @param {any} command
 * @param {string | null} [childId] - outlet id to scope the command to.
 * @returns {Promise<any>}
 */
async function kasaPassthrough(env, dev, command, childId) {
  const payload = childId ? { context: { child_ids: [childId] }, ...command } : command
  const result = await tplinkCall(
    env,
    token => `${dev.appServerUrl}/?token=${token}`,
    { method: "passthrough", params: { deviceId: dev.deviceId, requestData: JSON.stringify(payload) } }
  )
  return JSON.parse(result.responseData)
}

// Smart-bulb lighting service: bulbs (IOT.SMARTBULB) switch and colour via
// `transition_light_state`, a different path from the plug/switch relay.
const LIGHT_SERVICE = "smartlife.iot.smartbulb.lightingservice"

// Defaults for the price_color indicator: a green/amber/red traffic light.
const DEFAULT_TRAFFIC_HUES = [120, 40, 0] // green, amber, red
const DEFAULT_SATURATION = 100
const DEFAULT_BRIGHTNESS = 70

/**
 * @param {KasaDevice} dev
 * @returns {boolean} true for a smart bulb / light strip.
 */
function isBulb(dev) {
  return dev.deviceType === "IOT.SMARTBULB"
}

/**
 * @param {KasaDevice} dev
 * @returns {boolean} true for a hub-connected TRV / thermostat (KE100). These
 *   speak the SMART/Tapo protocol, so they aren't reachable over the Kasa IOT
 *   passthrough yet (see {@link kasaSetTargetTemp}); detection is forward-looking.
 */
function isThermostat(dev) {
  return /thermostat|trv/i.test(dev.deviceType || "")
}

/**
 * The on/off state of a device or one of its outlets, from a `get_sysinfo`. A
 * power strip has no top-level `relay_state` (each outlet carries its own in
 * `children[]`); a bulb has no relay at all and reports `light_state.on_off`.
 * Returns null when unknown.
 * @param {any} sysinfo - the `system.get_sysinfo` object.
 * @param {string | null} [childId]
 * @returns {number | null} 0 (off), 1 (on), or null when unknown.
 */
function relayStateOf(sysinfo, childId) {
  if (childId) {
    const child = (sysinfo.children || []).find((/** @type {any} */ c) => c.id === childId)
    return child ? child.state : null
  }
  return sysinfo.relay_state ?? sysinfo.light_state?.on_off ?? null
}

/**
 * @param {Env} env
 * @param {KasaDevice} dev
 * @param {string | null} [childId]
 * @returns {Promise<number | null>} 0 (off), 1 (on), or null when unknown.
 */
async function kasaReadState(env, dev, childId) {
  const data = await kasaPassthrough(env, dev, { system: { get_sysinfo: {} } })
  return relayStateOf(data.system.get_sysinfo, childId)
}

/**
 * Switches a device or outlet on/off. Bulbs use the lighting service; everything
 * else uses the relay (optionally scoped to a strip outlet).
 * @param {Env} env
 * @param {KasaDevice} dev
 * @param {boolean} on
 * @param {string | null} [childId]
 */
async function kasaSetState(env, dev, on, childId) {
  if (isBulb(dev)) {
    await kasaPassthrough(env, dev, { [LIGHT_SERVICE]: { transition_light_state: { on_off: on ? 1 : 0, transition_period: 0 } } })
  } else {
    await kasaPassthrough(env, dev, { system: { set_relay_state: { state: on ? 1 : 0 } } }, childId)
  }
}

/**
 * Sets a bulb's colour (HSB). Hue 0–360, saturation/brightness 0–100. Forces
 * colour mode (`color_temp: 0`) and turns the bulb on so the colour shows.
 * @param {Env} env
 * @param {KasaDevice} dev
 * @param {{ hue: number, saturation: number, brightness: number }} colour
 */
async function kasaSetColor(env, dev, colour) {
  await kasaPassthrough(env, dev, {
    [LIGHT_SERVICE]: {
      transition_light_state: {
        on_off: 1, color_temp: 0,
        hue: colour.hue, saturation: colour.saturation, brightness: colour.brightness,
        transition_period: 500,
      },
    },
  })
}

// TP-Link's V2 cloud (Tapo / Kasa-v2) signs every request with a hardcoded timestamp; the
// per-request nonce provides uniqueness. (Matches the TP-Link app + piekstra/tplink-cloud-api.)
const V2_SIGNING_TIMESTAMP = "9999999999"

/**
 * V2 cloud profiles — the constants that differ between Tapo and newer "Kasa v2" devices.
 * `accessKey`/`secretKey` are app-identity keys from the TP-Link APKs (NOT user secrets — they
 * sign every V2 request). `host` is the login/passthrough base; at runtime
 * `getAccountStatusAndUrl` returns the account's regional host, so don't hardcode a region.
 * The relay's allowlist covers both. @see {@link signV2}
 * @type {Record<"tapo" | "kasa_v2", { host: string, appType: string, accessKey: string, secretKey: string }>}
 */
const V2_PROFILES = {
  tapo: {
    host: "https://n-wap.i.tplinkcloud.com",
    appType: "TP-Link_Tapo_Android",
    accessKey: "4d11b6b9d5ea4d19a829adbb9714b057",
    secretKey: "6ed7d97f3e73467f8a5bab90b577ba4c",
  },
  kasa_v2: {
    host: "https://n-wap.tplinkcloud.com",
    appType: "Kasa_Android_Mix",
    accessKey: "e37525375f8845999bcc56d5e6faa76d",
    secretKey: "314bc6700b3140ca80bc655e527cb062",
  },
}

const V2_PATHS = { login: "/api/v2/account/login", passthrough: "/api/v2/common/passthrough" }

/**
 * Builds the V2 login request (exact JSON string body, for signing + sending). Same shape for
 * both profiles; the `appType` differs. `refreshTokenNeeded` asks for a refresh token so we
 * never have to re-send the password.
 * @param {{ appType: string }} profile
 * @param {{ username: string, password: string, terminalUUID: string }} creds
 * @returns {{ path: string, body: string }}
 */
function buildV2Login(profile, creds) {
  return {
    path: V2_PATHS.login,
    body: JSON.stringify({
      appType: profile.appType,
      cloudUserName: creds.username,
      cloudPassword: creds.password,
      terminalUUID: creds.terminalUUID,
      refreshTokenNeeded: true,
    }),
  }
}

/**
 * Builds the V2 token-refresh request — the MFA-safe path that swaps a stored refresh token for
 * a fresh access token without re-sending the password (so 2FA can stay on). Reuses the login
 * endpoint with a `refreshToken` instead of credentials.
 * NOTE: the exact body shape is reconstructed from references and awaits live validation against
 * the relay; only the *decision* to take this path (see {@link tapoToken}) is unit-tested.
 * @param {{ appType: string }} profile
 * @param {{ refreshToken: string, terminalUUID: string }} args
 * @returns {{ path: string, body: string }}
 */
function buildV2Refresh(profile, args) {
  return {
    path: V2_PATHS.login,
    body: JSON.stringify({ appType: profile.appType, terminalUUID: args.terminalUUID, refreshToken: args.refreshToken }),
  }
}

/**
 * Builds the V2 `passthrough` request. The cloud body is `{ deviceId, requestData: "<json>" }`
 * where `requestData` is the (stringified) device command. For a whole SMART device that's
 * `{ method, params }`; for a hub child (a KE100 TRV under a KH100), it's wrapped in
 * `control_child` addressed to `childId` — there the inner `requestData` is a nested object,
 * not a string (the SMART hub convention).
 * @param {string} deviceId - the device, or the hub when targeting a child.
 * @param {string} method - e.g. "set_device_info" / "get_device_info".
 * @param {any} params
 * @param {string | null} [childId] - the hub child's device id, when applicable.
 * @returns {{ path: string, body: string }}
 */
function buildV2Passthrough(deviceId, method, params, childId) {
  const inner = childId
    ? { method: "control_child", params: { device_id: childId, requestData: { method, params } } }
    : { method, params }
  return {
    path: V2_PATHS.passthrough,
    body: JSON.stringify({ deviceId, requestData: JSON.stringify(inner) }),
  }
}

/**
 * Signs a TP-Link V2 cloud request (the app's HMAC-SHA1 scheme). Returns the `Content-MD5`
 * and `X-Authorization` headers to send alongside `bodyJson` to `urlPath`.
 *   Content-MD5     = base64(md5(bodyJson))
 *   sigString       = `${Content-MD5}\n${timestamp}\n${nonce}\n${urlPath}`
 *   X-Authorization = `Timestamp=…, Nonce=…, AccessKey=…, Signature=hex(hmacSHA1(secretKey, sigString))`
 * @param {string} bodyJson - the exact JSON string sent as the request body.
 * @param {string} urlPath - the request path WITHOUT query, e.g. "/api/v2/common/passthrough".
 * @param {{ accessKey: string, secretKey: string, nonce?: string }} app - app keys for the
 *   cloud profile; `nonce` is injectable for deterministic tests (defaults to a random UUID).
 * @returns {{ "Content-MD5": string, "X-Authorization": string }}
 */
function signV2(bodyJson, urlPath, app) {
  const contentMd5 = createHash("md5").update(bodyJson).digest("base64")
  const nonce = app.nonce ?? crypto.randomUUID()
  const sigString = `${contentMd5}\n${V2_SIGNING_TIMESTAMP}\n${nonce}\n${urlPath}`
  const signature = createHmac("sha1", app.secretKey).update(sigString).digest("hex")
  return {
    "Content-MD5": contentMd5,
    "X-Authorization": `Timestamp=${V2_SIGNING_TIMESTAMP}, Nonce=${nonce}, AccessKey=${app.accessKey}, Signature=${signature}`,
  }
}

/**
 * Calls the TP-Link V2 cloud relay (the service-bound `tapo-relay` Worker → its CA-trusting
 * container) to make one HTTPS request to `targetUrl` — an absolute https URL on a TP-Link V2
 * host. The relay is the only way to reach those hosts (a Worker's fetch can't trust their
 * private CA). The container scales to zero, so a call after idle cold-starts it (~1–3s; the
 * container helper waits up to ~20s for readiness) — so we apply `timeoutMs` and **one retry**
 * (a retry lands on a now-warm instance) and throw cleanly on exhaustion rather than hanging.
 * An upstream HTTP error (4xx/5xx) is a real response: returned, not retried.
 *
 * The relay reads the target from the `X-Forward-To` header (the request URL is ignored), and
 * forwards the method/headers/body verbatim — so the caller (the future SMART transport) signs
 * and builds the request; this only moves it through the relay.
 * @param {Fetcher} relay - the RELAY service binding (`env.RELAY`).
 * @param {string} targetUrl - absolute https URL on a TP-Link V2 host.
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init]
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 * @returns {Promise<Response>}
 */
async function relayFetch(relay, targetUrl, init = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000 // > the container's ~20s port-ready window + a margin
  const retries = opts.retries ?? 1
  /** @type {unknown} */
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    let timer = 0
    // Race the call against a timeout (which also aborts the underlying fetch), so a stuck
    // cold-start can't hang us regardless of whether the callee observes the signal.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`relay timeout after ${timeoutMs}ms`)) }, timeoutMs)
    })
    try {
      const req = new Request("https://relay/", {
        method: init.method ?? "GET",
        headers: { ...init.headers, "X-Forward-To": targetUrl },
        body: init.body,
        signal: controller.signal,
      })
      return await Promise.race([relay.fetch(req), timeout])
    } catch (err) {
      lastErr = err
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`relay request to ${targetUrl} failed after ${retries + 1} attempt(s): ${lastErr instanceof Error ? lastErr.message : lastErr}`)
}

/**
 * One signed V2 cloud request through the relay: signs `bodyJson` for `path`, POSTs it to the
 * profile host (adding `?token=` when authenticated), and unwraps the `{ error_code, result }`
 * envelope. The token is NOT part of the signed path (it's a query param, like V1).
 * @param {Env} env
 * @param {{ host: string, appType: string, accessKey: string, secretKey: string }} profile
 * @param {string} path
 * @param {string} bodyJson
 * @param {string} [token]
 * @returns {Promise<any>} the `result` object. @throws on a non-zero `error_code`.
 */
async function v2Post(env, profile, path, bodyJson, token) {
  const url = `${profile.host}${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`
  const headers = { "content-type": "application/json", ...signV2(bodyJson, path, profile) }
  const res = await relayFetch(env.RELAY, url, { method: "POST", headers, body: bodyJson })
  const data = /** @type {any} */ (await res.json())
  if (!data || data.error_code !== 0) {
    throw new Error(`TP-Link V2 error ${data?.error_code}: ${data?.msg || JSON.stringify(data)}`)
  }
  return data.result
}

/**
 * Returns a valid V2 access token for `profileName` ("tapo" | "kasa_v2"), minting one when the
 * cached token is missing/expired (or `forceNew`). Prefers the stored refresh token (MFA-safe,
 * no password sent); falls back to a password login, which is the non-MFA bootstrap and also
 * returns a refresh token for next time. Tokens are cached per (user, profile) in `tapo_tokens`.
 * @param {Env} env
 * @param {"tapo" | "kasa_v2"} profileName
 * @param {boolean} forceNew
 * @returns {Promise<string>}
 */
async function tapoToken(env, profileName, forceNew) {
  const profile = V2_PROFILES[profileName]
  /** @type {{ terminal_uuid: string, refresh_token: string | null, access_token: string | null, token_expiry: number | null } | null} */
  const row = await env.DATABASE.prepare(
    "SELECT terminal_uuid, refresh_token, access_token, token_expiry FROM tapo_tokens WHERE user_id = ? AND profile = ?"
  ).bind(env.USER_ID, profileName).first()
  const now = Date.now()
  if (!forceNew && row?.access_token && typeof row.token_expiry === "number" && row.token_expiry > now) {
    return row.access_token
  }
  const terminalUUID = row?.terminal_uuid || crypto.randomUUID()
  const req = row?.refresh_token
    ? buildV2Refresh(profile, { refreshToken: row.refresh_token, terminalUUID })
    : buildV2Login(profile, { username: env.TPLINK_USERNAME, password: env.TPLINK_PASSWORD, terminalUUID })
  const result = await v2Post(env, profile, req.path, req.body)
  // V2 access tokens are short-lived; `expire` (seconds) is returned on login. Refresh a minute
  // early. Keep the existing refresh token if the response doesn't carry a new one.
  const expiry = now + (typeof result.expire === "number" ? result.expire * 1000 : 24 * 3600 * 1000) - 60_000
  await env.DATABASE.prepare(
    "INSERT INTO tapo_tokens (user_id, profile, terminal_uuid, refresh_token, access_token, token_expiry, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, profile) DO UPDATE SET " +
      "terminal_uuid = excluded.terminal_uuid, refresh_token = excluded.refresh_token, " +
      "access_token = excluded.access_token, token_expiry = excluded.token_expiry, updated_at = excluded.updated_at"
  ).bind(
    env.USER_ID, profileName, terminalUUID,
    result.refreshToken || row?.refresh_token || null, result.token, expiry, new Date().toISOString()
  ).run()
  return result.token
}

/**
 * Sends one SMART/Tapo command via the V2 cloud (through the relay) and returns the device's
 * parsed response. Re-authenticates once on failure (the cached token may be stale), mirroring
 * the V1 `tplinkCall` retry. For a hub child (TRV), pass `childId` to wrap it in `control_child`.
 * @param {Env} env
 * @param {"tapo" | "kasa_v2"} profileName
 * @param {string} deviceId - the device, or the hub when targeting a child.
 * @param {string} method
 * @param {any} params
 * @param {string | null} [childId]
 * @returns {Promise<any>}
 */
async function smartCall(env, profileName, deviceId, method, params, childId) {
  const profile = V2_PROFILES[profileName]
  const { path, body } = buildV2Passthrough(deviceId, method, params, childId ?? null)
  let result
  try {
    result = await v2Post(env, profile, path, body, await tapoToken(env, profileName, false))
  } catch {
    result = await v2Post(env, profile, path, body, await tapoToken(env, profileName, true))
  }
  return JSON.parse(result.responseData)
}

/**
 * Sets a hub-connected TRV's target temperature (°C) via the SMART/Tapo cloud transport.
 *
 * KE100/KH100 speak SMART: the target is set with `set_device_info {"target_temp": <c>}`,
 * addressed on the hub with `control_child` when hub-connected (`childId`), else sent to the
 * thermostat directly. Goes through {@link smartCall} → the relay (the V2 cloud uses a private
 * CA a Worker can't reach directly). Until the `tapo-relay` service binding is deployed and
 * added to wrangler.toml, `env.RELAY` is undefined and this throws a clear error; the evaluate
 * setpoint pass then reports the intended temperature and skips the send.
 * @param {Env} env
 * @param {KasaDevice} dev - the hub (or the thermostat itself, if standalone).
 * @param {string | null} childId - the TRV's device id when hub-connected, else null.
 * @param {number} tempC
 * @returns {Promise<void>}
 */
async function kasaSetTargetTemp(env, dev, childId, tempC) {
  if (!env.RELAY) {
    throw new Error("TRV setpoint needs the tapo-relay service binding (deploy the relay + add the binding first)")
  }
  await smartCall(env, "tapo", dev.deviceId, "set_device_info", { target_temp: tempC }, childId)
}

/**
 * The target temperature a setpoint rule wants right now: `comfort_c` when the
 * rule is active, else `setback_c`. ("Active" already includes any `invert`.)
 * @param {{ comfort_c: number, setback_c: number }} rule
 * @param {boolean} active
 * @returns {number}
 */
function setpointFor(rule, active) {
  return active ? rule.comfort_c : rule.setback_c
}

/**
 * A control target: a whole device, or one outlet of a power strip.
 * @typedef {Object} KasaTarget
 * @property {KasaDevice} device - the device, or the strip parent for an outlet.
 * @property {string | null} childId - outlet id when targeting a single outlet.
 * @property {string} [childAlias] - the outlet's name, when known.
 */

/**
 * Finds the strip whose outlet `identifier` is: an outlet id is the parent
 * deviceId followed by a 2-digit index, so it resolves structurally even before
 * the strip's outlets have ever been read.
 * @param {KasaDevice[]} devices
 * @param {string} identifier
 * @returns {KasaDevice | undefined}
 */
function outletParent(devices, identifier) {
  return devices.find(d =>
    identifier.length === d.deviceId.length + 2 &&
    identifier.startsWith(d.deviceId) &&
    /^\d{2}$/.test(identifier.slice(d.deviceId.length)))
}

/**
 * Finds the hub that parents the child whose device id is `identifier`. Unlike a
 * strip outlet (a deviceId+index, resolved structurally), a hub child (e.g. a
 * KE100 TRV under a KH100) has its own independent deviceId, so it can only be
 * found by an exact match against a cached `children[].id`.
 * @param {KasaDevice[]} devices
 * @param {string} identifier
 * @returns {KasaDevice | undefined}
 */
function hubOf(devices, identifier) {
  return devices.find(d => (d.children || []).some(c => c.id === identifier))
}

/**
 * Resolves an identifier to a control target. A unique deviceId or outlet id
 * always wins; otherwise a (case-insensitive) name is matched across whole
 * devices and known outlets, and a name matching more than one is reported as
 * ambiguous rather than silently guessed (TP-Link does not enforce unique
 * aliases). Defaults to the persisted snapshot; pass `devices` to resolve against
 * a live list (used by the live kasa/devices/:id endpoint).
 * @param {Env} env
 * @param {string} identifier
 * @param {KasaDevice[]} [devices]
 * @returns {Promise<{ target: KasaTarget | null, ambiguous: boolean }>}
 */
async function resolveTarget(env, identifier, devices) {
  devices ??= await snapshotDeviceList(env)
  const byId = devices.find(d => d.deviceId === identifier)
  if (byId) return { target: { device: byId, childId: null }, ambiguous: false }
  const parent = outletParent(devices, identifier)
  if (parent) {
    const childAlias = (parent.children || []).find(c => c.id === identifier)?.alias
    return { target: { device: parent, childId: identifier, childAlias }, ambiguous: false }
  }
  const name = identifier.toLowerCase()
  /** @type {KasaTarget[]} */
  const matches = []
  for (const d of devices) {
    if ((d.alias || "").toLowerCase() === name) matches.push({ device: d, childId: null })
    for (const c of d.children || []) {
      if ((c.alias || "").toLowerCase() === name) matches.push({ device: d, childId: c.id, childAlias: c.alias })
    }
  }
  if (matches.length === 1) return { target: matches[0], ambiguous: false }
  return { target: null, ambiguous: matches.length > 1 }
}

/**
 * Reads energy data from a device's emeter.
 * @param {Env} env
 * @param {KasaDevice} dev
 * @param {"realtime" | "day" | "month"} kind
 * @param {number} year
 * @param {number} month
 * @param {string | null} [childId] - read one outlet's emeter (HS300).
 * @returns {Promise<any>}
 */
async function kasaUsage(env, dev, kind, year, month, childId) {
  if (kind === "day") {
    const data = await kasaPassthrough(env, dev, { emeter: { get_daystat: { year, month } } }, childId)
    return data.emeter.get_daystat.day_list
  }
  if (kind === "month") {
    const data = await kasaPassthrough(env, dev, { emeter: { get_monthstat: { year } } }, childId)
    return data.emeter.get_monthstat.month_list
  }
  const data = await kasaPassthrough(env, dev, { emeter: { get_realtime: {} } }, childId)
  return data.emeter.get_realtime
}

// --- Rate lookups used by the controller ------------------------------------

/**
 * @param {Env} env
 * @param {string} atISO
 * @returns {Promise<{ time_start: string, time_end: string, price: string } | null>}
 */
async function currentRate(env, atISO) {
  return env.DATABASE.prepare(
    "SELECT time_start, time_end, price FROM rates WHERE user_id = ? AND time_start <= ? AND time_end > ? ORDER BY time_start DESC LIMIT 1"
  ).bind(env.USER_ID, atISO, atISO).first()
}

/**
 * Set of time_start values for the cheapest `count` half-hour periods of the given UTC day.
 * @param {Env} env
 * @param {string} dayPrefix
 * @param {number} count
 * @returns {Promise<Set<string>>}
 */
async function cheapestStarts(env, dayPrefix, count) {
  const { results } = await env.DATABASE.prepare(
    "SELECT time_start FROM rates WHERE user_id = ? AND time_start >= ? AND time_start < ? ORDER BY CAST(price AS REAL) ASC, time_start ASC LIMIT ?"
  ).bind(env.USER_ID, `${dayPrefix}T00:00:00Z`, `${dayPrefix}T24:00:00Z`, count).all()
  const rows = /** @type {{ time_start: string }[]} */ (results)
  return new Set(rows.map(r => r.time_start))
}

/**
 * @param {Env} env
 * @param {string} atISO
 * @returns {Promise<{ time_start: string, time_end: string, price: string } | null>}
 */
async function currentGasRate(env, atISO) {
  return env.DATABASE.prepare(
    "SELECT time_start, time_end, price FROM gas_rates WHERE user_id = ? AND time_start <= ? AND time_end > ? ORDER BY time_start DESC LIMIT 1"
  ).bind(env.USER_ID, atISO, atISO).first()
}

/**
 * Gas unit price (pence/kWh) to compare against for 'cheaper_than_gas' rules:
 * the per-user manual override if set, otherwise the fetched gas rate at `atISO`.
 * Returns null when neither is available.
 * @param {Env} env
 * @param {string} atISO
 * @returns {Promise<number | null>}
 */
async function gasPriceAt(env, atISO) {
  /** @type {{ gas_price_p: number | null } | null} */
  const cfg = await env.DATABASE.prepare(
    "SELECT gas_price_p FROM tariffs WHERE user_id = ?"
  ).bind(env.USER_ID).first()
  if (cfg && cfg.gas_price_p != null) return cfg.gas_price_p
  const row = await currentGasRate(env, atISO)
  return row ? parseFloat(row.price) : null
}

/**
 * Whether a rule wants its tagged devices "active" at the given moment. For an
 * on/off rule that's ON; for a setpoint rule it selects comfort vs setback. An
 * `invert` flag flips the result (e.g. inverted `cheaper_than_gas`: active when
 * electricity is *dearer* than gas — so a gas TRV comforts and a heat pump idles).
 * Returns null when the rule can't be evaluated (e.g. cheaper_than_gas with no gas price).
 * @param {Env} env
 * @param {any} rule
 * @param {{ time_start: string, price: string }} rate
 * @param {string} nowISO
 * @returns {Promise<{ on: boolean, reason: string } | null>}
 */
async function ruleDesired(env, rule, rate, nowISO) {
  const label = rule.name || rule.rule_id
  const price = parseFloat(rate.price)
  /** @type {{ on: boolean, reason: string } | null} */
  let base
  if (rule.strategy === "cheapest_hours") {
    const set = await cheapestStarts(env, nowISO.slice(0, 10), Math.max(1, Math.round(rule.hours * 2)))
    const on = set.has(rate.time_start)
    base = { on, reason: `${label}: cheapest ${rule.hours}h${on ? "" : " (not now)"}` }
  } else if (rule.strategy === "cheaper_than_gas") {
    const gasPrice = await gasPriceAt(env, nowISO)
    if (gasPrice == null) return null
    const eff = rule.efficiency ?? 1
    const ceiling = gasPrice * eff
    const on = price <= ceiling
    base = { on, reason: `${label}: ${price}p ${on ? "<=" : ">"} gas ${gasPrice}p×${eff} (${ceiling.toFixed(2)}p)` }
  } else {
    const on = price <= rule.threshold_p
    base = { on, reason: `${label}: ${price}p ${on ? "<=" : ">"} ${rule.threshold_p}p` }
  }
  if (rule.invert) return { on: !base.on, reason: `${base.reason} (inverted)` }
  return base
}

/**
 * any-on reducer: a load tagged to several on/off rules is ON if ANY of them wants it on.
 * Drops null results (rules that couldn't be evaluated) and collects the rest's reasons; an
 * empty `reasons` means nothing evaluable applied (the caller then skips the load).
 * @param {({ on: boolean, reason: string } | null)[]} results - one per rule, from {@link ruleDesired}.
 * @returns {{ desired: boolean, reasons: string[] }}
 */
function anyOn(results) {
  let desired = false
  const reasons = []
  for (const d of results) {
    if (d == null) continue
    if (d.on) desired = true
    reasons.push(d.reason)
  }
  return { desired, reasons }
}

/**
 * Evaluates enabled rules against the current rate and switches each tagged
 * load. A "load" is a whole device or a single power-strip outlet (the tagged id
 * is a deviceId or an outlet id); a load may be tagged to multiple rules and is
 * switched ON if ANY of its rules wants it on (any-on / OR). Outlets of the same
 * strip share one `get_sysinfo` read, and a load whose state can't be read is
 * skipped rather than switched blind.
 * @param {Env} env
 */
async function evaluateDevices(env) {
  /** @type {{ results: any[] }} */
  const { results: pairs } = await env.DATABASE.prepare(
    `SELECT r.rule_id, r.name, r.strategy, r.threshold_p, r.hours, r.efficiency, r.invert, r.comfort_c, r.setback_c, r.color_config, rd.device_id
     FROM rules r JOIN rule_devices rd ON rd.rule_id = r.rule_id
     WHERE r.user_id = ? AND r.enabled = 1`
  ).bind(env.USER_ID).all()
  // Refresh the device-metadata snapshot from this fetch (we need live status
  // for switching anyway) so the read endpoints stay off the cloud. Done before
  // the early return so the snapshot stays fresh even with no rules.
  const liveDevices = await refreshDeviceSnapshot(env)
  if (!pairs.length) return []

  const nowISO = new Date().toISOString()
  const rate = await currentRate(env, nowISO)
  const byId = new Map(liveDevices.map(d => [d.deviceId, d]))

  // Three kinds of rule drive different outputs: price_color → a bulb's colour,
  // setpoint (comfort_c/setback_c) → a TRV's target temperature, everything else
  // → on/off. Colour and setpoint devices are handled in their own passes and kept
  // out of the any-on on/off switching below.
  const colorPairs = pairs.filter(p => p.strategy === "price_color")
  const setpointPairs = pairs.filter(p => p.comfort_c != null && p.setback_c != null)
  const handledElsewhere = new Set([...colorPairs, ...setpointPairs].map(p => p.device_id))

  // Group the on/off rules that apply to each tagged load (deviceId or outlet id).
  /** @type {Map<string, any[]>} */
  const rulesByTarget = new Map()
  for (const p of pairs) {
    if (p.strategy === "price_color" || (p.comfort_c != null && p.setback_c != null) || handledElsewhere.has(p.device_id)) continue
    let list = rulesByTarget.get(p.device_id)
    if (!list) { list = []; rulesByTarget.set(p.device_id, list) }
    list.push(p)
  }

  // One get_sysinfo per parent device, reused across its outlets.
  /** @type {Map<string, any | null>} */
  const sysinfoCache = new Map()
  const readSys = async (/** @type {KasaDevice} */ dev) => {
    if (!sysinfoCache.has(dev.deviceId)) {
      const s = await readSysinfo(env, dev)
      sysinfoCache.set(dev.deviceId, s)
      if (s) await persistDeviceFacts(env, new Map([[dev.deviceId, factsFromSysinfo(s)]]))
    }
    return sysinfoCache.get(dev.deviceId)
  }

  const actions = []
  for (const [targetId, deviceRules] of rulesByTarget) {
    // Resolve the tagged id to a device (whole) or a strip outlet.
    const dev = byId.get(targetId) ?? outletParent(liveDevices, targetId)
    if (!dev) { actions.push({ device_id: targetId, skipped: "not found" }); continue }
    const childId = byId.has(targetId) ? null : targetId
    const alias = childId ? ((dev.children || []).find(c => c.id === childId)?.alias ?? null) : dev.alias
    if (dev.status !== 1) { actions.push({ device_id: targetId, alias, skipped: "offline" }); continue }
    if (!rate) { actions.push({ device_id: targetId, alias, skipped: "no rate data" }); continue }

    // any-on: ON if any applicable rule wants it on.
    const desiredList = []
    for (const rule of deviceRules) desiredList.push(await ruleDesired(env, rule, rate, nowISO))
    const { desired, reasons } = anyOn(desiredList)
    if (!reasons.length) { actions.push({ device_id: targetId, alias, skipped: "no evaluable rules" }); continue }
    const reason = `${desired ? "ON" : "OFF"} [any-on] ${reasons.join("; ")}`

    const sysinfo = await readSys(dev)
    const current = sysinfo ? relayStateOf(sysinfo, childId) : null
    if (current == null) { actions.push({ device_id: targetId, alias, skipped: "state unavailable" }); continue }

    if ((current === 1) !== desired) {
      await kasaSetState(env, dev, desired, childId)
      await env.DATABASE.prepare(
        "INSERT INTO device_log (device_id, user_id, ts, action, price, reason) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(targetId, env.USER_ID, nowISO, desired ? "on" : "off", parseFloat(rate.price), reason).run()
      actions.push({ device_id: targetId, alias, action: desired ? "on" : "off", reason })
    } else {
      actions.push({ device_id: targetId, alias, action: "unchanged", reason })
    }
  }

  // Colour-indicator pass: set each tagged bulb's hue from the current price.
  // One colour rule per bulb (first wins if tagged to several).
  /** @type {Map<string, any>} */
  const colorRuleByDevice = new Map()
  for (const p of colorPairs) if (!colorRuleByDevice.has(p.device_id)) colorRuleByDevice.set(p.device_id, p)
  for (const [deviceId, rule] of colorRuleByDevice) {
    const dev = byId.get(deviceId)
    if (!dev) { actions.push({ device_id: deviceId, skipped: "not found" }); continue }
    const alias = dev.alias
    if (!isBulb(dev)) { actions.push({ device_id: deviceId, alias, skipped: "not a bulb" }); continue }
    if (dev.status !== 1) { actions.push({ device_id: deviceId, alias, skipped: "offline" }); continue }
    if (!rate) { actions.push({ device_id: deviceId, alias, skipped: "no rate data" }); continue }
    /** @type {any} */
    let config = null
    try { config = JSON.parse(rule.color_config) } catch { /* malformed */ }
    if (!config) { actions.push({ device_id: deviceId, alias, skipped: "no colour config" }); continue }

    const price = parseFloat(rate.price)
    const target = colorBandFor(price, config)
    const reason = `${rule.name || rule.rule_id}: ${price}p → hue ${target.hue}`
    const sysinfo = await readSys(dev)
    // Capability flags are cached from this read; skip a bulb that can't do colour.
    if (capsFromSysinfo(sysinfo)?.color === false) { actions.push({ device_id: deviceId, alias, skipped: "no colour support" }); continue }
    const ls = sysinfo?.light_state
    if (!ls) { actions.push({ device_id: deviceId, alias, skipped: "state unavailable" }); continue }

    // Set only when off, in white mode, or showing a different hue.
    if (ls.on_off !== 1 || (ls.color_temp ?? 0) !== 0 || ls.hue !== target.hue) {
      await kasaSetColor(env, dev, target)
      await env.DATABASE.prepare(
        "INSERT INTO device_log (device_id, user_id, ts, action, price, reason) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(deviceId, env.USER_ID, nowISO, "color", price, reason).run()
      actions.push({ device_id: deviceId, alias, action: "color", hue: target.hue, reason })
    } else {
      actions.push({ device_id: deviceId, alias, action: "unchanged", reason })
    }
  }

  // Setpoint pass: drive each tagged TRV's target temperature from its rule.
  // One setpoint rule per TRV (first wins). The send is gated on the SMART/Tapo
  // transport (see kasaSetTargetTemp), so for now this reports the intended
  // temperature and skips the write rather than sending over the wrong transport.
  /** @type {Map<string, any>} */
  const setpointRuleByDevice = new Map()
  for (const p of setpointPairs) if (!setpointRuleByDevice.has(p.device_id)) setpointRuleByDevice.set(p.device_id, p)
  for (const [targetId, rule] of setpointRuleByDevice) {
    const dev = byId.get(targetId) ?? hubOf(liveDevices, targetId)
    if (!dev) { actions.push({ device_id: targetId, skipped: "not found" }); continue }
    const childId = byId.has(targetId) ? null : targetId
    const alias = childId ? ((dev.children || []).find(c => c.id === childId)?.alias ?? null) : dev.alias
    if (dev.status !== 1) { actions.push({ device_id: targetId, alias, skipped: "offline" }); continue }
    if (!rate) { actions.push({ device_id: targetId, alias, skipped: "no rate data" }); continue }
    const desired = await ruleDesired(env, rule, rate, nowISO)
    if (!desired) { actions.push({ device_id: targetId, alias, skipped: "no evaluable rule" }); continue }
    const temp = setpointFor(rule, desired.on)
    const reason = `${desired.reason} → ${desired.on ? "comfort" : "setback"} ${temp}°`
    try {
      await kasaSetTargetTemp(env, dev, childId, temp)
      await env.DATABASE.prepare(
        "INSERT INTO device_log (device_id, user_id, ts, action, price, reason) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(targetId, env.USER_ID, nowISO, `setpoint ${temp}`, parseFloat(rate.price), reason).run()
      actions.push({ device_id: targetId, alias, action: "setpoint", target_c: temp, reason })
    } catch (err) {
      // Expected until the SMART/Tapo transport lands — report intent, don't fail.
      actions.push({ device_id: targetId, alias, skipped: `setpoint unsupported: ${err instanceof Error ? err.message : err}`, target_c: temp, reason })
    }
  }
  return actions
}

// --- Auth -------------------------------------------------------------------

/**
 * Returns true iff the request carries the SQUID_API_KEY bearer token.
 * The `permission` parameter is reserved for future RBAC; currently the single
 * key satisfies all permissions.
 * @param {Request} request
 * @param {Env} env
 * @param {string} permission
 * @returns {boolean}
 */
function hasPermission(request, env, permission) {
  return request.headers.get("Authorization") === `Bearer ${env.SQUID_API_KEY}`
}

// Short-TTL edge cache for read-heavy GETs. Rates change only on a refresh and
// forecast is a preview, so a few seconds' staleness is fine; no explicit busting.
const CACHE_TTL_SECONDS = 60

/**
 * Serves a GET from the per-colo Cache API when fresh, else computes and caches
 * it for `ttl` seconds. The cache key is the URL plus the user id, so it stays
 * correct once requests resolve to different users. Auth is enforced by the
 * router before this runs.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @param {number} ttl seconds
 * @param {() => Promise<Response>} compute
 * @returns {Promise<Response>}
 */
async function cachedResponse(request, env, ctx, ttl, compute) {
  const cache = caches.default
  const keyURL = new URL(request.url)
  keyURL.searchParams.set("__uid", env.USER_ID) // user-scope the cache key
  const key = new Request(keyURL.toString(), { method: "GET" })
  const hit = await cache.match(key)
  if (hit) return hit
  const res = await compute()
  if (res.ok) {
    res.headers.set("Cache-Control", `max-age=${ttl}`)
    ctx.waitUntil(cache.put(key, res.clone()))
  }
  return res
}

// --- Route handlers ---------------------------------------------------------

/**
 * GET /api/octopus/rates — paginated cached rates (short-TTL edge cache, per user).
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleOctopusRates(request, env, ctx, _params) {
  return cachedResponse(request, env, ctx, CACHE_TTL_SECONDS, () => computeOctopusRates(request, env))
}

/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function computeOctopusRates(request, env) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(parseInt(searchParams.get("limit") || "96", 10), 96)
  const page = Math.max(parseInt(searchParams.get("page") || "1", 10), 1)
  const offset = (page - 1) * limit
  const from = searchParams.get("from")
  const to = searchParams.get("to")
  let where = "WHERE user_id = ?"
  const filterBindings = [env.USER_ID]
  if (from) { where += " AND time_start >= ?"; filterBindings.push(from) }
  if (to)   { where += " AND time_start <= ?"; filterBindings.push(to) }
  const [countRow, { results }] = await Promise.all([
    env.DATABASE.prepare(`SELECT COUNT(*) as count FROM rates ${where}`).bind(...filterBindings).first(),
    env.DATABASE.prepare(`SELECT time_start, time_end, price FROM rates ${where} ORDER BY time_start DESC LIMIT ? OFFSET ?`).bind(...filterBindings, limit, offset).all()
  ])
  const count = /** @type {number} */ (countRow?.count ?? 0)
  /** @param {number} p */
  const pageURL = (p) => { const u = new URL(request.url); u.searchParams.set("page", String(p)); u.searchParams.set("limit", String(limit)); return u.toString() }
  return Response.json({
    count,
    next: offset + limit < count ? pageURL(page + 1) : null,
    previous: page > 1 ? pageURL(page - 1) : null,
    results
  })
}

/**
 * GET /api/octopus/rates/live — live rates from Octopus API.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleOctopusRatesLive(request, env, _ctx, _params) {
  const data = await fetchOctopusRates(env)
  const base = new URL(request.url)
  /** @param {string} u */
  const rewrite = u => { const r = new URL(base); new URL(u).searchParams.forEach((v, k) => r.searchParams.set(k, v)); return r.toString() }
  return Response.json({
    count: data.count,
    next: data.next ? rewrite(data.next) : null,
    previous: data.previous ? rewrite(data.previous) : null,
    results: data.results
  })
}

/**
 * POST /api/octopus/rates/refresh — pull latest rates from Octopus and store.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleOctopusRatesRefresh(_request, env, _ctx, _params) {
  const rates = await updateRates(env)
  return Response.json(rates)
}

/**
 * GET /api/octopus/tariff — read stored tariff codes.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleOctopusTariffGet(_request, env, _ctx, _params) {
  const row = await env.DATABASE.prepare(
    "SELECT tariff_code, gas_tariff_code, gas_price_p FROM tariffs WHERE user_id = ?"
  ).bind(env.USER_ID).first()
  if (!row) return new Response("Not Found", { status: 404 })
  // The auto-fetched flat gas unit rate (from gas_rates). The manual override,
  // if set, takes precedence over it for cheaper_than_gas.
  const gasRow = await currentGasRate(env, new Date().toISOString())
  const gas_rate_p = gasRow ? parseFloat(gasRow.price) : null
  const gas_price_override_p = /** @type {number | null} */ (row.gas_price_p)
  return Response.json({
    user_id: env.USER_ID,
    account: env.OCTOPUS_ACCOUNT,
    tariff_code: row.tariff_code,
    gas_tariff_code: row.gas_tariff_code,
    gas_rate_p,
    gas_price_override_p,
    gas_price_effective_p: gas_price_override_p ?? gas_rate_p,
  })
}

/**
 * PUT /api/octopus/tariff — set tariff code and/or manual gas price override.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleOctopusTariffPut(request, env, _ctx, _params) {
  const body = await request.json()
  const tariff_code = body.tariff_code
  const gas_price_override_p = body.gas_price_override_p
  if (tariff_code == null && gas_price_override_p === undefined) {
    return new Response("Missing tariff_code or gas_price_override_p", { status: 400 })
  }
  if (tariff_code != null) {
    await env.DATABASE.prepare(
      "INSERT INTO tariffs (user_id, tariff_code) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET tariff_code = excluded.tariff_code"
    ).bind(env.USER_ID, tariff_code).run()
  }
  // The override (stored in the gas_price_p column) wins over the auto-fetched
  // flat gas rate; pass null to clear it and fall back to the fetched rate.
  if (gas_price_override_p !== undefined) {
    await env.DATABASE.prepare(
      "INSERT INTO tariffs (user_id, gas_price_p) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET gas_price_p = excluded.gas_price_p"
    ).bind(env.USER_ID, gas_price_override_p).run()
  }
  return Response.json({
    user_id: env.USER_ID,
    ...(tariff_code != null ? { tariff_code } : {}),
    ...(gas_price_override_p !== undefined ? { gas_price_override_p } : {}),
  })
}

/**
 * GET /api/octopus/meters/:fuel — meter consumption (electricity or gas).
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleOctopusMeters(request, env, _ctx, params) {
  const { fuel } = params
  if (fuel === "electricity") {
    const url = `https://api.octopus.energy/v1/electricity-meter-points/${env.ELECTRICITY_MPAN}/meters/${env.ELECTRICITY_SERIAL}/consumption/`
    return fetchOctopusMeter(url, env, request.url)
  }
  if (fuel === "gas") {
    const url = `https://api.octopus.energy/v1/gas-meter-points/${env.GAS_MPRN}/meters/${env.GAS_SERIAL}/consumption/`
    return fetchOctopusMeter(url, env, request.url)
  }
  return new Response("fuel must be 'electricity' or 'gas'", { status: 400 })
}

/**
 * Reads a device's `get_sysinfo`, returning null on failure.
 * @param {Env} env
 * @param {KasaDevice} dev
 * @returns {Promise<any | null>}
 */
async function readSysinfo(env, dev) {
  return kasaPassthrough(env, dev, { system: { get_sysinfo: {} } })
    .then(r => r.system.get_sysinfo).catch(() => null)
}

/**
 * GET /api/kasa/devices — live device list from TP-Link cloud. A power strip is
 * listed as a container row (`on: null`, `outlets: N`) followed by one row per
 * outlet (each with `parent_id`/`parent_alias` and its own relay `on`).
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleKasaDevices(_request, env, _ctx, _params) {
  // Live read — and persist the snapshot from this fetch so the metadata
  // endpoints stay fresh between cron runs (relay state below is still live).
  const devices = await refreshDeviceSnapshot(env)
  /** @type {Map<string, DeviceFacts>} */
  const learned = new Map()
  const results = (await Promise.all(devices.map(async d => {
    const base = { alias: d.alias, model: d.deviceModel, status: d.status }
    // Offline: can't read live; surface the device (and any known outlets) as unknown.
    if (d.status !== 1) {
      return [
        { device_id: d.deviceId, ...base, ...(d.caps ? { caps: d.caps } : {}), on: null, ...(d.children?.length ? { outlets: d.children.length } : {}) },
        ...(d.children || []).map(c => ({ device_id: c.id, parent_id: d.deviceId, parent_alias: d.alias, alias: c.alias, model: d.deviceModel, status: d.status, on: null })),
      ]
    }
    const sysinfo = await readSysinfo(env, d)
    if (sysinfo) learned.set(d.deviceId, factsFromSysinfo(sysinfo))
    const children = sysinfo && sysinfo.children
    if (children && children.length) {
      // A strip's parent `on` is its master relay state if it has one, else null.
      const master = sysinfo.relay_state == null ? null : sysinfo.relay_state === 1
      return [
        { device_id: d.deviceId, ...base, on: master, outlets: children.length },
        ...children.map((/** @type {any} */ c) => ({ device_id: c.id, parent_id: d.deviceId, parent_alias: d.alias, alias: c.alias, model: d.deviceModel, status: d.status, on: c.state === 1 })),
      ]
    }
    // Single relay or bulb. null = read failed / unknown.
    const caps = capsFromSysinfo(sysinfo)
    const s = sysinfo ? relayStateOf(sysinfo, null) : null
    return [{ device_id: d.deviceId, ...base, ...(caps ? { caps } : {}), on: s == null ? null : s === 1 }]
  }))).flat()
  await persistDeviceFacts(env, learned)
  return Response.json({ results })
}

/**
 * GET /api/kasa/devices/:id — single live device or outlet by id/name. A strip
 * parent returns the container with its `outlets`; an outlet id/name returns
 * that outlet's live relay state.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleKasaDevice(_request, env, _ctx, params) {
  // Live endpoint: resolve against the live list (not the snapshot) and read
  // relay state fresh from the cloud; persist the snapshot from this fetch too.
  const { target, ambiguous } = await resolveTarget(env, params.id, await refreshDeviceSnapshot(env))
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!target) return new Response("Not Found", { status: 404 })
  const { device: dev, childId } = target
  const outletFields = childId ? { parent_id: dev.deviceId, parent_alias: dev.alias } : {}

  if (dev.status !== 1) {
    return Response.json({ device_id: childId ?? dev.deviceId, alias: childId ? target.childAlias : dev.alias, ...outletFields, model: dev.deviceModel, status: dev.status, on: null })
  }
  const sysinfo = await readSysinfo(env, dev)
  if (sysinfo) await persistDeviceFacts(env, new Map([[dev.deviceId, factsFromSysinfo(sysinfo)]]))
  const children = sysinfo && sysinfo.children

  // Strip parent (no specific outlet): return the container and its outlets. `on`
  // is the master relay state when the strip has one, else null.
  if (!childId && children && children.length) {
    return Response.json({
      device_id: dev.deviceId, alias: dev.alias, model: dev.deviceModel, status: dev.status,
      on: sysinfo.relay_state == null ? null : sysinfo.relay_state === 1,
      outlets: children.map((/** @type {any} */ c) => ({ device_id: c.id, alias: c.alias, on: c.state === 1 })),
    })
  }
  const state = sysinfo ? relayStateOf(sysinfo, childId) : null
  const alias = childId
    ? (children?.find((/** @type {any} */ c) => c.id === childId)?.alias ?? target.childAlias)
    : dev.alias
  const caps = capsFromSysinfo(sysinfo)
  return Response.json({
    device_id: childId ?? dev.deviceId, alias, ...outletFields, model: dev.deviceModel, status: dev.status,
    ...(caps ? { caps } : {}),
    on: state == null ? null : state === 1,
  })
}

/**
 * POST /api/kasa/devices/:id/state — turn a device or outlet on or off. A strip
 * parent is rejected (409): switch a specific outlet instead.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleKasaDeviceState(request, env, _ctx, params) {
  const body = await request.json()
  if (typeof body.on !== "boolean") {
    return new Response("Body must include 'on' as a boolean", { status: 400 })
  }
  const { target, ambiguous } = await resolveTarget(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!target) return new Response("Not Found", { status: 404 })
  const { device: dev, childId } = target
  if (dev.status !== 1) return new Response("Device offline", { status: 409 })
  // A strip with no master relay can't be switched as a whole without losing each
  // outlet's state, so refuse it; a strip that has a master relay (relay_state at
  // the top level) switches losslessly via the relay below. Learn outlets/master.
  const sysinfo = await readSysinfo(env, dev)
  if (sysinfo) await persistDeviceFacts(env, new Map([[dev.deviceId, factsFromSysinfo(sysinfo)]]))
  if (!childId && sysinfo?.children?.length && sysinfo.relay_state == null) {
    const ids = sysinfo.children.map((/** @type {any} */ c) => c.id).join(", ")
    return new Response(`This power strip has no master switch; switch a specific outlet instead (${ids})`, { status: 409 })
  }
  await kasaSetState(env, dev, body.on, childId)
  const id = childId ?? dev.deviceId
  const nowISO = new Date().toISOString()
  await env.DATABASE.prepare(
    "INSERT INTO device_log (device_id, user_id, ts, action, price, reason) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, env.USER_ID, nowISO, body.on ? "on" : "off", null, "manual").run()
  return Response.json({ device_id: id, alias: childId ? target.childAlias : dev.alias, on: body.on })
}

/**
 * POST /api/kasa/devices/:id/light — set a bulb's colour / brightness / on-off
 * directly. Body: any of `on` (bool), `hue` (0–360), `saturation` (0–100),
 * `brightness` (0–100), `color_temp` (K, 0 = colour mode). Bulbs only.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleKasaDeviceLight(request, env, _ctx, params) {
  const body = await request.json()
  const t = await resolveForRead(env, params.id)
  if (t instanceof Response) return t
  const { device: dev } = t
  if (!isBulb(dev)) return new Response("Not a bulb; use /state for plugs, switches and outlets", { status: 409 })
  // Cached caps let us reject a colour request on a non-colour bulb up front.
  const wantsColor = body.hue != null || body.saturation != null
  if (wantsColor && dev.caps && !dev.caps.color) {
    return new Response("This bulb doesn't support colour (hue/saturation)", { status: 409 })
  }

  /** @type {Record<string, number>} */
  const state = { transition_period: 500 }
  if (typeof body.on === "boolean") state.on_off = body.on ? 1 : 0
  if (body.hue != null) { state.hue = body.hue; state.color_temp = 0 } // hue implies colour mode
  if (body.saturation != null) state.saturation = body.saturation
  if (body.brightness != null) state.brightness = body.brightness
  if (body.color_temp != null) state.color_temp = body.color_temp
  if (Object.keys(state).length === 1) {
    return new Response("Provide at least one of on, hue, saturation, brightness, color_temp", { status: 400 })
  }
  const data = await kasaPassthrough(env, dev, { [LIGHT_SERVICE]: { transition_light_state: state } })
  const nowISO = new Date().toISOString()
  await env.DATABASE.prepare(
    "INSERT INTO device_log (device_id, user_id, ts, action, price, reason) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(dev.deviceId, env.USER_ID, nowISO, "light", null, "manual").run()
  return Response.json({ device_id: dev.deviceId, alias: dev.alias, light_state: data?.[LIGHT_SERVICE]?.transition_light_state ?? null })
}

/**
 * Resolves `:id` for a single-target read endpoint and applies the standard
 * guards. Returns an error Response, or the resolved target. When `requireOutlet`
 * is set, a *known* power strip addressed without an outlet is rejected (per-outlet
 * data — energy/runtime/usage — has no single-device meaning on a strip).
 * @param {Env} env
 * @param {string} id
 * @param {{ requireOutlet?: boolean }} [opts]
 * @returns {Promise<Response | KasaTarget>}
 */
async function resolveForRead(env, id, opts) {
  const { target, ambiguous } = await resolveTarget(env, id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!target) return new Response("Not Found", { status: 404 })
  if (target.device.status !== 1) return new Response("Device offline", { status: 409 })
  if (opts?.requireOutlet && !target.childId && target.device.children?.length) {
    const ids = target.device.children.map(c => c.id).join(", ")
    return new Response(`This is a power strip; specify an outlet (${ids})`, { status: 409 })
  }
  return target
}

/**
 * GET /api/kasa/devices/:id/usage — emeter energy data for a device or outlet.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleKasaDeviceUsage(request, env, _ctx, params) {
  const { searchParams } = new URL(request.url)
  const kind = /** @type {"realtime" | "day" | "month"} */ (searchParams.get("kind") || "realtime")
  if (!["realtime", "day", "month"].includes(kind)) {
    return new Response("kind must be 'realtime', 'day' or 'month'", { status: 400 })
  }
  const now = new Date()
  const year = parseInt(searchParams.get("year") || String(now.getUTCFullYear()), 10)
  const month = parseInt(searchParams.get("month") || String(now.getUTCMonth() + 1), 10)
  const t = await resolveForRead(env, params.id, { requireOutlet: true })
  if (t instanceof Response) return t
  const { device: dev, childId } = t
  return Response.json({
    device_id: childId ?? dev.deviceId,
    alias: childId ? t.childAlias : dev.alias,
    kind,
    ...(kind === "day" ? { year, month } : kind === "month" ? { year } : {}),
    results: await kasaUsage(env, dev, kind, year, month, childId),
  })
}

/**
 * GET /api/kasa/devices/:id/rules — firmware schedule/countdown/anti-theft rules.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleKasaDeviceRules(_request, env, _ctx, params) {
  const t = await resolveForRead(env, params.id)
  if (t instanceof Response) return t
  const { device: dev, childId } = t
  const [scheduleData, countDownData, antiTheftData] = await Promise.all([
    kasaPassthrough(env, dev, { schedule: { get_rules: {} } }, childId),
    kasaPassthrough(env, dev, { count_down: { get_rules: {} } }, childId),
    kasaPassthrough(env, dev, { anti_theft: { get_rules: {} } }, childId),
  ])
  return Response.json({
    device_id: childId ?? dev.deviceId,
    alias: childId ? t.childAlias : dev.alias,
    schedule: scheduleData?.schedule?.get_rules?.rule_list ?? [],
    count_down: countDownData?.count_down?.get_rules?.rule_list ?? [],
    anti_theft: antiTheftData?.anti_theft?.get_rules?.rule_list ?? [],
  })
}

/**
 * Fetches a module's get_daystat day_list for the current + previous month (in
 * parallel) — enough to cover a rolling 30-day window across a month boundary.
 * @param {Env} env
 * @param {KasaDevice} dev
 * @param {"emeter" | "schedule"} module
 * @param {Date} now
 * @param {string | null} [childId] - scope to one outlet of a strip.
 * @returns {Promise<any[]>}
 */
async function recentDayStat(env, dev, module, now, childId) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1
  const get = async (/** @type {number} */ yy, /** @type {number} */ mm) => {
    const data = await kasaPassthrough(env, dev, { [module]: { get_daystat: { year: yy, month: mm } } }, childId)
    return data[module]?.get_daystat?.day_list || []
  }
  const [cur, prev] = await Promise.all([get(y, m), get(py, pm)])
  return cur.concat(prev)
}

/**
 * Today / last-7-day / last-30-day aggregates from a get_daystat day_list, using
 * `val(entry)` to read each day's quantity.
 * @param {any[]} list
 * @param {(d: any) => number} val
 * @param {Date} now
 * @returns {{ today: number, last_7: { total: number, daily_avg: number }, last_30: { total: number, daily_avg: number } }}
 */
function aggregateDays(list, val, now) {
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const sum = (/** @type {number} */ days) => {
    const startUTC = todayUTC - (days - 1) * 86_400_000 // `days` calendar days incl. today
    let total = 0
    for (const d of list) {
      const t = Date.UTC(d.year, d.month - 1, d.day)
      if (t >= startUTC && t <= todayUTC) total += val(d)
    }
    return { total, daily_avg: Math.round((total / days) * 100) / 100 }
  }
  const today = list.find(d => Date.UTC(d.year, d.month - 1, d.day) === todayUTC)
  return { today: today ? val(today) : 0, last_7: sum(7), last_30: sum(30) }
}

/**
 * GET /api/kasa/devices/:id/energy — live energy use (emeter): realtime power +
 * today / past-7-day / past-30-day consumption (Wh).
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleKasaDeviceEnergy(_request, env, _ctx, params) {
  const t = await resolveForRead(env, params.id, { requireOutlet: true })
  if (t instanceof Response) return t
  const { device: dev, childId } = t
  if (isBulb(dev)) return new Response("No energy monitoring on this device (bulb has no emeter)", { status: 409 })

  const now = new Date()
  const [realtimeData, days] = await Promise.all([
    kasaPassthrough(env, dev, { emeter: { get_realtime: {} } }, childId),
    recentDayStat(env, dev, "emeter", now, childId),
  ])
  const rt = realtimeData.emeter.get_realtime
  // energy_wh (newer fw) or energy in kWh (older).
  const agg = aggregateDays(days, (/** @type {any} */ d) => d.energy_wh ?? (d.energy != null ? d.energy * 1000 : 0), now)
  return Response.json({
    device_id: childId ?? dev.deviceId,
    alias: childId ? t.childAlias : dev.alias,
    realtime: {
      power_w: rt.power_mw != null ? rt.power_mw / 1000 : (rt.power ?? null),
      voltage_v: rt.voltage_mv != null ? rt.voltage_mv / 1000 : (rt.voltage ?? null),
      current_a: rt.current_ma != null ? rt.current_ma / 1000 : (rt.current ?? null),
    },
    today: { total_wh: agg.today },
    last_7_days: { total_wh: agg.last_7.total, daily_avg_wh: agg.last_7.daily_avg },
    last_30_days: { total_wh: agg.last_30.total, daily_avg_wh: agg.last_30.daily_avg },
  })
}

/**
 * GET /api/kasa/devices/:id/runtime — live runtime: current on-session +
 * today / past-7-day / past-30-day on-minutes.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleKasaDeviceRuntime(_request, env, _ctx, params) {
  const t = await resolveForRead(env, params.id, { requireOutlet: true })
  if (t instanceof Response) return t
  const { device: dev, childId } = t

  const now = new Date()
  // The parent get_sysinfo already carries each outlet's on_time, so it isn't
  // child-scoped; the per-day schedule stats are.
  const [sysData, days] = await Promise.all([
    kasaPassthrough(env, dev, { system: { get_sysinfo: {} } }),
    recentDayStat(env, dev, "schedule", now, childId),
  ])
  const sysinfo = sysData.system.get_sysinfo
  if (childId) await persistDeviceFacts(env, new Map([[dev.deviceId, factsFromSysinfo(sysinfo)]]))
  const onTime = childId
    ? (sysinfo.children || []).find((/** @type {any} */ c) => c.id === childId)?.on_time ?? 0
    : sysinfo.on_time ?? 0
  // schedule 'time' is minutes per day.
  const agg = aggregateDays(days, (/** @type {any} */ d) => d.time ?? 0, now)
  return Response.json({
    device_id: childId ?? dev.deviceId,
    alias: childId ? t.childAlias : dev.alias,
    realtime: { current_runtime_s: onTime },
    today: { total_min: agg.today },
    last_7_days: { total_min: agg.last_7.total, daily_avg_min: agg.last_7.daily_avg },
    last_30_days: { total_min: agg.last_30.total, daily_avg_min: agg.last_30.daily_avg },
  })
}

/**
 * Validates a rule definition body. Returns an error string, or null if valid.
 * @param {any} body
 * @returns {string | null}
 */
function validateRuleBody(body) {
  if (!["threshold", "cheapest_hours", "cheaper_than_gas", "price_color"].includes(body.strategy)) {
    return "strategy must be 'threshold', 'cheapest_hours', 'cheaper_than_gas' or 'price_color'"
  }
  if (body.strategy === "threshold" && body.threshold_p == null) return "Missing threshold_p"
  if (body.strategy === "cheapest_hours" && body.hours == null) return "Missing hours"
  if (body.efficiency != null && !(body.efficiency > 0)) return "efficiency must be a positive number"
  if (body.invert != null && typeof body.invert !== "boolean" && body.invert !== 0 && body.invert !== 1) {
    return "invert must be a boolean"
  }
  // Setpoint mode (TRV): both temperatures, and an on/off strategy to gate them.
  const hasComfort = body.comfort_c != null, hasSetback = body.setback_c != null
  if (hasComfort || hasSetback) {
    if (!(hasComfort && hasSetback)) return "setpoint rules need both comfort_c and setback_c"
    if (typeof body.comfort_c !== "number" || typeof body.setback_c !== "number") return "comfort_c and setback_c must be numbers"
    if (body.strategy === "price_color") return "price_color can't be a setpoint rule"
  }
  if (body.strategy === "price_color") return validateColorBody(body)
  return null
}

/**
 * Whether a device/outlet is a valid target for a rule's strategy. Returns an
 * error message to reject the tag with, or null if allowed.
 *
 * - Every strategy: a strip *parent* is rejected unless the strip has a master
 *   relay (`master`); most strips don't, so tag their outlets instead.
 * - A *setpoint* rule (comfort_c/setback_c) drives a thermostat's target temp, so
 *   it needs a thermostat (TRV) and nothing else; conversely an on/off or colour
 *   rule may not target a thermostat.
 * - The on/off strategies (threshold / cheapest_hours / cheaper_than_gas) drive a
 *   relay or a bulb's on/off, so they're valid on any allowed non-thermostat load.
 * - `price_color` drives a bulb's hue, so it needs a colour-capable bulb: a
 *   non-bulb (plug/switch/outlet) is rejected outright, and a bulb with cached
 *   `caps.color === false` is rejected. Unknown caps are allowed (they resolve on
 *   the next live read; evaluate skips a non-colour bulb either way).
 * @param {string} strategy
 * @param {KasaTarget} target
 * @param {boolean} [isSetpoint] - the rule carries comfort_c/setback_c.
 * @returns {string | null}
 */
function ruleTargetError(strategy, target, isSetpoint) {
  const { device: dev, childId } = target
  // A strip parent is only a valid whole-device target when it has a master relay.
  if (!childId && dev.children?.length && !dev.master) {
    return `This is a power strip; tag a specific outlet instead (${dev.children.map(c => c.id).join(", ")})`
  }
  if (isSetpoint) {
    return isThermostat(dev) ? null : "setpoint rules (comfort_c/setback_c) need a thermostat (TRV) target"
  }
  if (isThermostat(dev)) return "a thermostat needs a setpoint rule (comfort_c/setback_c), not on/off or colour"
  if (strategy === "price_color") {
    if (childId || !isBulb(dev)) return "price_color needs a colour bulb; this device has no colour"
    if (dev.caps && !dev.caps.color) return "This bulb doesn't support colour (hue/saturation)"
  }
  return null
}

/**
 * Validates the colour fields of a price_color rule. Either explicit `bands`
 * (ascending price cutoffs, the last band a catch-all) or the `cheap_p` /
 * `expensive_p` shorthand must be supplied.
 * @param {any} body
 * @returns {string | null}
 */
function validateColorBody(body) {
  const inRange = (/** @type {any} */ v, /** @type {number} */ max) => typeof v === "number" && v >= 0 && v <= max
  if (Array.isArray(body.bands)) {
    if (!body.bands.length) return "bands must not be empty"
    for (const b of body.bands) {
      if (b.up_to_p != null && typeof b.up_to_p !== "number") return "each band's up_to_p must be a number"
      if (b.hue != null && !inRange(b.hue, 360)) return "each band's hue must be 0–360"
      if (b.saturation != null && !inRange(b.saturation, 100)) return "saturation must be 0–100"
      if (b.brightness != null && !inRange(b.brightness, 100)) return "brightness must be 0–100"
    }
    return null
  }
  if (body.cheap_p != null || body.expensive_p != null) {
    if (!(typeof body.cheap_p === "number" && typeof body.expensive_p === "number" && body.cheap_p <= body.expensive_p)) {
      return "cheap_p and expensive_p must be numbers with cheap_p <= expensive_p"
    }
    return null
  }
  return "price_color needs 'bands' or both 'cheap_p' and 'expensive_p'"
}

/**
 * Builds the stored colour config (JSON) for a price_color rule from a request
 * body — either explicit `bands` or the `cheap_p`/`expensive_p` traffic-light
 * shorthand. Fills missing hues from the green/amber/red palette by position.
 * @param {any} body
 * @returns {{ bands: { up_to_p: number | null, hue: number }[], saturation: number, brightness: number }}
 */
function colorConfigFromBody(body) {
  const saturation = body.saturation ?? DEFAULT_SATURATION
  const brightness = body.brightness ?? DEFAULT_BRIGHTNESS
  /** @type {{ up_to_p?: number, hue?: number }[]} */
  const raw = Array.isArray(body.bands)
    ? body.bands
    : [{ up_to_p: body.cheap_p }, { up_to_p: body.expensive_p }, {}]
  const last = raw.length - 1
  const bands = raw.map((b, i) => ({
    up_to_p: i === last ? null : (b.up_to_p ?? null), // last band is the catch-all
    hue: b.hue ?? DEFAULT_TRAFFIC_HUES[Math.min(i, DEFAULT_TRAFFIC_HUES.length - 1)],
  }))
  return { bands, saturation, brightness }
}

/**
 * Picks the colour band a price falls into (absolute pence cutoffs, ascending;
 * the catch-all band has `up_to_p: null`). Returns hue + saturation/brightness.
 * @param {number} priceP
 * @param {{ bands: { up_to_p: number | null, hue: number }[], saturation: number, brightness: number }} config
 * @returns {{ hue: number, saturation: number, brightness: number }}
 */
function colorBandFor(priceP, config) {
  const band = config.bands[bandIndexFor(priceP, config.bands)]
  return { hue: band.hue, saturation: config.saturation, brightness: config.brightness }
}

/**
 * Index of the band a price falls into (ascending pence cutoffs; the catch-all
 * band has `up_to_p: null`). Falls back to the last band.
 * @param {number} priceP
 * @param {{ up_to_p: number | null }[]} bands
 * @returns {number}
 */
function bandIndexFor(priceP, bands) {
  const i = bands.findIndex(b => b.up_to_p == null || priceP <= b.up_to_p)
  return i === -1 ? bands.length - 1 : i
}

/**
 * Map of rule_id -> array of { device_id, alias } for the user's tagged devices,
 * with live aliases overlaid.
 * @param {Env} env
 * @returns {Promise<Map<string, { device_id: string, alias: string | undefined }[]>>}
 */
async function ruleDeviceMap(env) {
  const { results } = await env.DATABASE.prepare(
    "SELECT rule_id, device_id FROM rule_devices WHERE user_id = ?"
  ).bind(env.USER_ID).all()
  const aliasById = await aliasMap(env)
  /** @type {Map<string, { device_id: string, alias: string | undefined }[]>} */
  const map = new Map()
  for (const r of /** @type {{ rule_id: string, device_id: string }[]} */ (results)) {
    if (!map.has(r.rule_id)) map.set(r.rule_id, [])
    map.get(r.rule_id)?.push({ device_id: r.device_id, alias: aliasById.get(r.device_id) })
  }
  return map
}

/**
 * Shapes a rule DB row for JSON: parses the stored `color_config` into a `color`
 * object (price_color rules) and drops the raw column.
 * @param {any} row
 * @returns {any}
 */
function ruleForResponse(row) {
  const { color_config, ...rest } = row
  if (color_config) {
    try { rest.color = JSON.parse(color_config) } catch { /* ignore malformed config */ }
  }
  return rest
}

/**
 * GET /api/squid/rules — list rules, each with its tagged devices.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleSquidRulesList(_request, env, _ctx, _params) {
  const { results: rules } = await env.DATABASE.prepare(
    "SELECT rule_id, name, strategy, threshold_p, hours, efficiency, invert, comfort_c, setback_c, enabled, color_config FROM rules WHERE user_id = ?"
  ).bind(env.USER_ID).all()
  const devicesByRule = await ruleDeviceMap(env)
  const enriched = /** @type {any[]} */ (rules).map(r => ({ ...ruleForResponse(r), devices: devicesByRule.get(r.rule_id) ?? [] }))
  return Response.json({ results: enriched })
}

/**
 * POST /api/squid/rules — create a rule. Body: { name?, strategy,
 * threshold_p|hours|efficiency, enabled?, device_ids?: string[] }. For
 * `price_color`: `bands` or `cheap_p`/`expensive_p` (+ optional `saturation`,
 * `brightness`). device_ids must be canonical deviceIds; use the tag endpoint
 * to add by alias.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleSquidRuleCreate(request, env, _ctx, _params) {
  const body = await request.json()
  const err = validateRuleBody(body)
  if (err) return new Response(err, { status: 400 })
  // Resolve + validate device_ids up front, before creating the rule, so an
  // unsuitable device (e.g. a non-colour bulb on a price_color rule) rejects the
  // whole request rather than leaving a half-tagged rule. Unknown ids are kept
  // as-is (caught later at evaluate); known ids are stored canonically.
  const isSetpoint = body.comfort_c != null && body.setback_c != null
  const deviceIds = Array.isArray(body.device_ids) ? body.device_ids : []
  /** @type {string[]} */
  const resolvedIds = []
  for (const id of deviceIds) {
    const { target, ambiguous } = await resolveTarget(env, id)
    if (ambiguous) return new Response(`Ambiguous device name '${id}'; use the deviceId`, { status: 409 })
    if (!target) { resolvedIds.push(id); continue }
    const targetErr = ruleTargetError(body.strategy, target, isSetpoint)
    if (targetErr) return new Response(targetErr, { status: 409 })
    resolvedIds.push(target.childId ?? target.device.deviceId)
  }

  const rule_id = crypto.randomUUID()
  const efficiency = body.efficiency ?? 1
  const enabled = body.enabled === false ? 0 : 1
  const invert = body.invert ? 1 : 0
  const comfort_c = isSetpoint ? body.comfort_c : null
  const setback_c = isSetpoint ? body.setback_c : null
  const color = body.strategy === "price_color" ? colorConfigFromBody(body) : null
  await env.DATABASE.prepare(
    "INSERT INTO rules (rule_id, user_id, name, strategy, threshold_p, hours, efficiency, invert, comfort_c, setback_c, enabled, color_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(rule_id, env.USER_ID, body.name ?? null, body.strategy, body.threshold_p ?? null, body.hours ?? null, efficiency, invert, comfort_c, setback_c, enabled, color ? JSON.stringify(color) : null).run()
  for (const deviceId of resolvedIds) {
    await env.DATABASE.prepare(
      "INSERT OR IGNORE INTO rule_devices (rule_id, device_id, user_id) VALUES (?, ?, ?)"
    ).bind(rule_id, deviceId, env.USER_ID).run()
  }
  return Response.json({
    rule_id, user_id: env.USER_ID, name: body.name ?? null, strategy: body.strategy,
    threshold_p: body.threshold_p ?? null, hours: body.hours ?? null, efficiency, invert, comfort_c, setback_c, enabled,
    ...(color ? { color } : {}), device_ids: resolvedIds,
  }, { status: 201 })
}

/**
 * GET /api/squid/rules/:ruleId — a single rule with its tagged devices.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleSquidRuleGet(_request, env, _ctx, params) {
  const rule = await env.DATABASE.prepare(
    "SELECT rule_id, name, strategy, threshold_p, hours, efficiency, invert, comfort_c, setback_c, enabled, color_config FROM rules WHERE user_id = ? AND rule_id = ?"
  ).bind(env.USER_ID, params.ruleId).first()
  if (!rule) return new Response("Not Found", { status: 404 })
  const devicesByRule = await ruleDeviceMap(env)
  return Response.json({ ...ruleForResponse(rule), devices: devicesByRule.get(params.ruleId) ?? [] })
}

/**
 * PUT /api/squid/rules/:ruleId — update a rule definition (not its device tags).
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleSquidRuleUpdate(request, env, _ctx, params) {
  const body = await request.json()
  const err = validateRuleBody(body)
  if (err) return new Response(err, { status: 400 })
  // UPDATE's change count is 0 when values are unchanged, so check existence first.
  const exists = await env.DATABASE.prepare(
    "SELECT 1 FROM rules WHERE user_id = ? AND rule_id = ?"
  ).bind(env.USER_ID, params.ruleId).first()
  if (!exists) return new Response("Not Found", { status: 404 })
  const efficiency = body.efficiency ?? 1
  const enabled = body.enabled === false ? 0 : 1
  const invert = body.invert ? 1 : 0
  const isSetpoint = body.comfort_c != null && body.setback_c != null
  const comfort_c = isSetpoint ? body.comfort_c : null
  const setback_c = isSetpoint ? body.setback_c : null
  const color = body.strategy === "price_color" ? colorConfigFromBody(body) : null
  await env.DATABASE.prepare(
    `UPDATE rules SET name = ?, strategy = ?, threshold_p = ?, hours = ?, efficiency = ?, invert = ?, comfort_c = ?, setback_c = ?, enabled = ?, color_config = ?
     WHERE user_id = ? AND rule_id = ?`
  ).bind(body.name ?? null, body.strategy, body.threshold_p ?? null, body.hours ?? null, efficiency, invert, comfort_c, setback_c, enabled, color ? JSON.stringify(color) : null, env.USER_ID, params.ruleId).run()
  return Response.json({
    rule_id: params.ruleId, user_id: env.USER_ID, name: body.name ?? null, strategy: body.strategy,
    threshold_p: body.threshold_p ?? null, hours: body.hours ?? null, efficiency, invert, comfort_c, setback_c, enabled,
    ...(color ? { color } : {}),
  })
}

/**
 * DELETE /api/squid/rules/:ruleId — delete a rule and all its device tags.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleSquidRuleDelete(_request, env, _ctx, params) {
  const result = await env.DATABASE.prepare(
    "DELETE FROM rules WHERE user_id = ? AND rule_id = ?"
  ).bind(env.USER_ID, params.ruleId).run()
  if (result.meta.changes === 0) return new Response("Not Found", { status: 404 })
  await env.DATABASE.prepare(
    "DELETE FROM rule_devices WHERE user_id = ? AND rule_id = ?"
  ).bind(env.USER_ID, params.ruleId).run()
  return Response.json({ deleted: true, rule_id: params.ruleId })
}

/**
 * POST /api/squid/rules/:ruleId/devices/:id — tag a device (or strip outlet)
 * onto a rule. :id may be a deviceId, an outlet id, or a (unique) name; it is
 * resolved to the canonical id stored in `rule_devices`.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleSquidRuleTagDevice(_request, env, _ctx, params) {
  /** @type {{ strategy: string, comfort_c: number | null } | null} */
  const rule = await env.DATABASE.prepare(
    "SELECT strategy, comfort_c FROM rules WHERE user_id = ? AND rule_id = ?"
  ).bind(env.USER_ID, params.ruleId).first()
  if (!rule) return new Response("Rule not found", { status: 404 })
  const { target, ambiguous } = await resolveTarget(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!target) return new Response("Unknown device; not found on your TP-Link account", { status: 404 })
  const { device: dev, childId } = target
  const targetErr = ruleTargetError(rule.strategy, target, rule.comfort_c != null)
  if (targetErr) return new Response(targetErr, { status: 409 })
  const taggedId = childId ?? dev.deviceId
  await env.DATABASE.prepare(
    "INSERT OR IGNORE INTO rule_devices (rule_id, device_id, user_id) VALUES (?, ?, ?)"
  ).bind(params.ruleId, taggedId, env.USER_ID).run()
  return Response.json({ rule_id: params.ruleId, device_id: taggedId, alias: (childId ? target.childAlias : dev.alias) ?? null, tagged: true })
}

/**
 * DELETE /api/squid/rules/:ruleId/devices/:id — untag a device/outlet from a
 * rule (the rule itself is preserved). :id may be a deviceId, outlet id, or
 * (unique) name; falls back to the raw :id so an already-removed device can
 * still be untagged by its stored id.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleSquidRuleUntagDevice(_request, env, _ctx, params) {
  const { target, ambiguous } = await resolveTarget(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  const deviceId = target ? (target.childId ?? target.device.deviceId) : params.id
  const result = await env.DATABASE.prepare(
    "DELETE FROM rule_devices WHERE user_id = ? AND rule_id = ? AND device_id = ?"
  ).bind(env.USER_ID, params.ruleId, deviceId).run()
  if (result.meta.changes === 0) return new Response("Not tagged", { status: 404 })
  return Response.json({ rule_id: params.ruleId, device_id: deviceId, untagged: true })
}

/**
 * GET /api/squid/forecast — per-rule preview (short-TTL edge cache, per user).
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleSquidForecast(request, env, ctx, _params) {
  return cachedResponse(request, env, ctx, CACHE_TTL_SECONDS, () => computeSquidForecast(request, env))
}

/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function computeSquidForecast(request, env) {
  const { searchParams } = new URL(request.url)
  const today = new Date().toISOString().slice(0, 10)
  const param = searchParams.get("date")
  const days = param ? [param] : [today, new Date(Date.now() + 86400000).toISOString().slice(0, 10)]
  /** @type {{ results: any[] }} */
  const { results: rules } = await env.DATABASE.prepare(
    "SELECT rule_id, name, strategy, threshold_p, hours, efficiency, color_config FROM rules WHERE user_id = ? AND enabled = 1"
  ).bind(env.USER_ID).all()
  const devicesByRule = await ruleDeviceMap(env)
  const results = []
  for (const rule of rules) {
    // Day rates for the window, fetched once and shared by both rule kinds.
    /** @type {{ time_start: string, time_end: string, price: string }[]} */
    const windowRates = []
    for (const day of days) {
      /** @type {{ results: { time_start: string, time_end: string, price: string }[] }} */
      const { results: dayRates } = await env.DATABASE.prepare(
        "SELECT time_start, time_end, price FROM rates WHERE user_id = ? AND time_start >= ? AND time_start < ? ORDER BY time_start ASC"
      ).bind(env.USER_ID, `${day}T00:00:00Z`, `${day}T24:00:00Z`).all()
      windowRates.push(...dayRates)
    }
    const base = { rule_id: rule.rule_id, name: rule.name, strategy: rule.strategy, devices: devicesByRule.get(rule.rule_id) ?? [] }

    // price_color: report how many half-hours fall in each colour band.
    if (rule.strategy === "price_color") {
      /** @type {any} */
      let config = null
      try { config = JSON.parse(rule.color_config) } catch { /* malformed */ }
      const bands = config?.bands ?? []
      const counts = bands.map(() => 0)
      for (const r of windowRates) counts[bandIndexFor(parseFloat(r.price), bands)]++
      results.push({
        ...base, color: config,
        bands: bands.map((/** @type {any} */ b, /** @type {number} */ i) => ({ hue: b.hue, up_to_p: b.up_to_p, slots: counts[i], hours: counts[i] / 2 })),
      })
      continue
    }

    // on/off strategies: which half-hours the rule would be ON.
    let qualifies
    if (rule.strategy === "cheapest_hours") {
      // cheapest_hours ranks within a single UTC day; evaluate per day.
      /** @type {Set<string>} */
      const cheap = new Set()
      for (const day of days) for (const s of await cheapestStarts(env, day, Math.max(1, Math.round(rule.hours * 2)))) cheap.add(s)
      qualifies = (/** @type {{ time_start: string }} */ r) => cheap.has(r.time_start)
    } else if (rule.strategy === "cheaper_than_gas") {
      // Gas is typically a flat daily rate; take one price for the day (noon).
      const gasPrice = await gasPriceAt(env, `${days[0]}T12:00:00Z`)
      const ceiling = gasPrice == null ? -Infinity : gasPrice * (rule.efficiency ?? 1)
      qualifies = (/** @type {{ price: string }} */ r) => parseFloat(r.price) <= ceiling
    } else {
      qualifies = (/** @type {{ price: string }} */ r) => parseFloat(r.price) <= rule.threshold_p
    }
    const slots = windowRates.filter(qualifies)
    results.push({
      ...base,
      threshold_p: rule.threshold_p, hours: rule.hours, efficiency: rule.efficiency,
      on_slots: slots.length, on_hours: slots.length / 2, slots,
    })
  }
  return Response.json({ days, results })
}

/**
 * POST /api/squid/evaluate — run evaluateDevices now.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleSquidEvaluate(_request, env, _ctx, _params) {
  return Response.json({ results: await evaluateDevices(env) })
}

/**
 * GET /api/squid/log — recent device_log entries.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleSquidLog(request, env, _ctx, _params) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200)
  const { results } = await env.DATABASE.prepare(
    `SELECT device_id, ts, action, price, reason FROM device_log
     WHERE user_id = ? OR user_id IS NULL
     ORDER BY ts DESC LIMIT ?`
  ).bind(env.USER_ID, limit).all()
  const aliasById = await aliasMap(env)
  const enriched = /** @type {any[]} */ (results).map(r => ({ ...r, alias: aliasById.get(r.device_id) ?? null }))
  return Response.json({ results: enriched })
}

// --- Route table ------------------------------------------------------------

/**
 * @typedef {(request: Request, env: Env, ctx: ExecutionContext, params: Record<string, string>) => Promise<Response>} RouteHandler
 */

/**
 * [METHOD, PATTERN, PERMISSION, handler]
 * PATTERN segments starting with ':' are captured as named params.
 * @type {[string, string, string, RouteHandler][]}
 */
const ROUTES = [
  ["GET",    "/api/octopus/rates",              "rates:read",     handleOctopusRates],
  ["GET",    "/api/octopus/rates/live",         "rates:read",     handleOctopusRatesLive],
  ["POST",   "/api/octopus/rates/refresh",      "rates:manage",   handleOctopusRatesRefresh],
  ["GET",    "/api/octopus/tariff",             "rates:read",     handleOctopusTariffGet],
  ["PUT",    "/api/octopus/tariff",             "rates:manage",   handleOctopusTariffPut],
  ["GET",    "/api/octopus/meters/:fuel",       "meters:read",    handleOctopusMeters],
  ["GET",    "/api/kasa/devices",               "devices:read",   handleKasaDevices],
  ["GET",    "/api/kasa/devices/:id",           "devices:read",   handleKasaDevice],
  ["POST",   "/api/kasa/devices/:id/state",     "devices:control",handleKasaDeviceState],
  ["POST",   "/api/kasa/devices/:id/light",     "devices:control",handleKasaDeviceLight],
  ["GET",    "/api/kasa/devices/:id/usage",     "meters:read",    handleKasaDeviceUsage],
  ["GET",    "/api/kasa/devices/:id/energy",    "meters:read",    handleKasaDeviceEnergy],
  ["GET",    "/api/kasa/devices/:id/runtime",   "meters:read",    handleKasaDeviceRuntime],
  ["GET",    "/api/kasa/devices/:id/rules",     "devices:read",   handleKasaDeviceRules],
  ["GET",    "/api/squid/rules",                     "rules:read",     handleSquidRulesList],
  ["POST",   "/api/squid/rules",                     "rules:write",    handleSquidRuleCreate],
  ["GET",    "/api/squid/rules/:ruleId",             "rules:read",     handleSquidRuleGet],
  ["PUT",    "/api/squid/rules/:ruleId",             "rules:write",    handleSquidRuleUpdate],
  ["DELETE", "/api/squid/rules/:ruleId",             "rules:write",    handleSquidRuleDelete],
  ["POST",   "/api/squid/rules/:ruleId/devices/:id", "rules:write",    handleSquidRuleTagDevice],
  ["DELETE", "/api/squid/rules/:ruleId/devices/:id", "rules:write",    handleSquidRuleUntagDevice],
  ["GET",    "/api/squid/forecast",                  "rules:read",     handleSquidForecast],
  ["POST",   "/api/squid/evaluate",             "devices:control",handleSquidEvaluate],
  ["GET",    "/api/squid/log",                  "logs:read",      handleSquidLog],
]

/**
 * Match `pathname` against a route PATTERN.
 * Returns the captured params object on match, or null on mismatch.
 * @param {string} pattern
 * @param {string} pathname
 * @returns {Record<string, string> | null}
 */
function matchRoute(pattern, pathname) {
  const patSegs = pattern.split("/")
  const urlSegs = pathname.split("/")
  if (patSegs.length !== urlSegs.length) return null
  /** @type {Record<string, string>} */
  const params = {}
  for (let i = 0; i < patSegs.length; i++) {
    const p = patSegs[i]
    if (p.startsWith(":")) {
      // Percent-decode so aliases with spaces/special chars (e.g. "Smart Plug")
      // resolve correctly; fall back to the raw segment if malformed.
      let v = urlSegs[i]
      try { v = decodeURIComponent(v) } catch { /* keep raw */ }
      params[p.slice(1)] = v
    } else if (p !== urlSegs[i]) {
      return null
    }
  }
  return params
}

/** @type {ExportedHandler<Env>} */
export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "0,30 * * * *") {
      ctx.waitUntil(evaluateDevices(env).catch(err => console.error("Scheduled evaluateDevices failed:", err)));
    } else {
      ctx.waitUntil(updateRates(env).catch(err => console.error("Scheduled updateRates failed:", err)));
    }
  },

  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url)

    try {
      // Root help text (public, no auth)
      if (pathname === "/") {
        return new Response(
          "Hi! GET /api/octopus/rates for electricity rates, " +
          "/api/kasa/devices for device list."
        )
      }

      // Find matching routes by path
      /** @type {{ route: [string, string, string, RouteHandler], params: Record<string, string> }[]} */
      const pathMatches = []
      for (const route of ROUTES) {
        const params = matchRoute(route[1], pathname)
        if (params !== null) pathMatches.push({ route, params })
      }

      if (pathMatches.length === 0) {
        return new Response("Not Found", { status: 404 })
      }

      // Check method
      const methodMatch = pathMatches.find(m => m.route[0] === request.method)
      if (!methodMatch) {
        return new Response("Method Not Allowed", { status: 405 })
      }

      const { route, params } = methodMatch
      const [, , permission, handler] = route

      // Auth gate
      if (!hasPermission(request, env, permission)) {
        return new Response("Unauthorized", { status: 401 })
      }

      return await handler(request, env, ctx, params)
    } catch (err) {
      console.error(err)
      return new Response("Internal Server Error", { status: 500 })
    }
  },
}

// Pure helpers exported for unit tests (see test/). The Worker runtime uses only
// the default export above; these named exports are inert at runtime.
export {
  isBulb,
  isThermostat,
  relayStateOf,
  childrenFromSysinfo,
  capsFromSysinfo,
  factsFromSysinfo,
  outletParent,
  hubOf,
  colorBandFor,
  bandIndexFor,
  colorConfigFromBody,
  validateRuleBody,
  ruleTargetError,
  ruleDesired,
  anyOn,
  computeSquidForecast,
  setpointFor,
  aggregateDays,
  matchRoute,
  relayFetch,
  signV2,
  V2_PROFILES,
  buildV2Login,
  buildV2Refresh,
  buildV2Passthrough,
  tapoToken,
  smartCall,
}
