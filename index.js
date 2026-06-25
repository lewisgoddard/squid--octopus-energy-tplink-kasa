/**
 * A device as returned by the TP-Link Kasa cloud `getDeviceList` call.
 * @typedef {Object} KasaDevice
 * @property {string} deviceId
 * @property {string} [alias]
 * @property {string} appServerUrl
 * @property {string} [deviceModel]
 * @property {number} status - 1 when the device is online.
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
 * Fetches the live device list and persists it as the metadata snapshot.
 * Called by the cron (reusing its existing getDeviceList) and on cold start.
 * @param {Env} env
 * @returns {Promise<KasaDevice[]>}
 */
async function refreshDeviceSnapshot(env) {
  const devices = await kasaDeviceList(env)
  await env.DATABASE.prepare(
    "INSERT INTO device_cache (user_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at"
  ).bind(env.USER_ID, JSON.stringify(devices), new Date().toISOString()).run()
  return devices
}

/**
 * The persisted device-metadata snapshot. Lazily populates from the cloud the
 * first time, before the cron has run.
 * @param {Env} env
 * @returns {Promise<KasaDevice[]>}
 */
async function snapshotDeviceList(env) {
  /** @type {{ json: string } | null} */
  const row = await env.DATABASE.prepare(
    "SELECT json FROM device_cache WHERE user_id = ?"
  ).bind(env.USER_ID).first()
  if (row && row.json) return JSON.parse(row.json)
  return refreshDeviceSnapshot(env)
}

/**
 * Map of deviceId -> alias from the snapshot, for overlaying display names onto
 * stored rows. Resilient: empty map on failure so reads fall back to the stored
 * alias rather than failing.
 * @param {Env} env
 * @returns {Promise<Map<string, string | undefined>>}
 */
async function aliasMap(env) {
  const devices = await snapshotDeviceList(env).catch(() => /** @type {KasaDevice[]} */ ([]))
  return new Map(devices.map(d => [d.deviceId, d.alias]))
}

/**
 * @param {Env} env
 * @param {KasaDevice} dev
 * @param {any} command
 * @returns {Promise<any>}
 */
async function kasaPassthrough(env, dev, command) {
  const result = await tplinkCall(
    env,
    token => `${dev.appServerUrl}/?token=${token}`,
    { method: "passthrough", params: { deviceId: dev.deviceId, requestData: JSON.stringify(command) } }
  )
  return JSON.parse(result.responseData)
}

/**
 * @param {Env} env
 * @param {KasaDevice} dev
 * @returns {Promise<number>} 0 (off) or 1 (on)
 */
async function kasaReadState(env, dev) {
  const data = await kasaPassthrough(env, dev, { system: { get_sysinfo: {} } })
  return data.system.get_sysinfo.relay_state // 0 (off) or 1 (on)
}

/**
 * @param {Env} env
 * @param {KasaDevice} dev
 * @param {boolean} on
 */
async function kasaSetState(env, dev, on) {
  await kasaPassthrough(env, dev, { system: { set_relay_state: { state: on ? 1 : 0 } } })
}

/**
 * Resolves a device by its deviceId or (case-insensitive) alias. deviceId always
 * wins (it is unique). An alias matching more than one device is reported as
 * ambiguous rather than silently guessed, since TP-Link does not enforce unique
 * aliases. Defaults to the persisted snapshot; pass `devices` to resolve against
 * a live list (used by the live kasa/devices/:id endpoint).
 * @param {Env} env
 * @param {string} identifier
 * @param {KasaDevice[]} [devices]
 * @returns {Promise<{ device: KasaDevice | null, ambiguous: boolean }>}
 */
async function resolveDevice(env, identifier, devices) {
  devices ??= await snapshotDeviceList(env)
  const byId = devices.find(d => d.deviceId === identifier)
  if (byId) return { device: byId, ambiguous: false }
  const name = identifier.toLowerCase()
  const matches = devices.filter(d => (d.alias || "").toLowerCase() === name)
  if (matches.length === 1) return { device: matches[0], ambiguous: false }
  return { device: null, ambiguous: matches.length > 1 }
}

/**
 * Reads energy data from a device's emeter.
 * @param {Env} env
 * @param {KasaDevice} dev
 * @param {"realtime" | "day" | "month"} kind
 * @param {number} year
 * @param {number} month
 * @returns {Promise<any>}
 */
async function kasaUsage(env, dev, kind, year, month) {
  if (kind === "day") {
    const data = await kasaPassthrough(env, dev, { emeter: { get_daystat: { year, month } } })
    return data.emeter.get_daystat.day_list
  }
  if (kind === "month") {
    const data = await kasaPassthrough(env, dev, { emeter: { get_monthstat: { year } } })
    return data.emeter.get_monthstat.month_list
  }
  const data = await kasaPassthrough(env, dev, { emeter: { get_realtime: {} } })
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
 * Whether a rule wants its tagged devices ON at the given moment. Returns null
 * when the rule can't be evaluated (e.g. cheaper_than_gas with no gas price).
 * @param {Env} env
 * @param {any} rule
 * @param {{ time_start: string, price: string }} rate
 * @param {string} nowISO
 * @returns {Promise<{ on: boolean, reason: string } | null>}
 */
async function ruleDesired(env, rule, rate, nowISO) {
  const label = rule.name || rule.rule_id
  const price = parseFloat(rate.price)
  if (rule.strategy === "cheapest_hours") {
    const set = await cheapestStarts(env, nowISO.slice(0, 10), Math.max(1, Math.round(rule.hours * 2)))
    const on = set.has(rate.time_start)
    return { on, reason: `${label}: cheapest ${rule.hours}h${on ? "" : " (not now)"}` }
  }
  if (rule.strategy === "cheaper_than_gas") {
    const gasPrice = await gasPriceAt(env, nowISO)
    if (gasPrice == null) return null
    const eff = rule.efficiency ?? 1
    const ceiling = gasPrice * eff
    const on = price <= ceiling
    return { on, reason: `${label}: ${price}p ${on ? "<=" : ">"} gas ${gasPrice}p×${eff} (${ceiling.toFixed(2)}p)` }
  }
  const on = price <= rule.threshold_p
  return { on, reason: `${label}: ${price}p ${on ? "<=" : ">"} ${rule.threshold_p}p` }
}

/**
 * Evaluates enabled rules against the current rate and switches each tagged
 * device. A device may be tagged to multiple rules; it is switched ON if ANY of
 * its rules wants it on (any-on / OR).
 * @param {Env} env
 */
async function evaluateDevices(env) {
  /** @type {{ results: any[] }} */
  const { results: pairs } = await env.DATABASE.prepare(
    `SELECT r.rule_id, r.name, r.strategy, r.threshold_p, r.hours, r.efficiency, rd.device_id
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

  // Group the rules that apply to each device.
  /** @type {Map<string, any[]>} */
  const rulesByDevice = new Map()
  for (const p of pairs) {
    let list = rulesByDevice.get(p.device_id)
    if (!list) { list = []; rulesByDevice.set(p.device_id, list) }
    list.push(p)
  }

  const actions = []
  for (const [deviceId, deviceRules] of rulesByDevice) {
    const dev = byId.get(deviceId)
    if (!dev) { actions.push({ device_id: deviceId, skipped: "not found" }); continue }
    if (dev.status !== 1) { actions.push({ device_id: deviceId, alias: dev.alias, skipped: "offline" }); continue }
    if (!rate) { actions.push({ device_id: deviceId, alias: dev.alias, skipped: "no rate data" }); continue }

    // any-on: ON if any applicable rule wants it on.
    let desired = false
    const reasons = []
    for (const rule of deviceRules) {
      const d = await ruleDesired(env, rule, rate, nowISO)
      if (d == null) continue
      if (d.on) desired = true
      reasons.push(d.reason)
    }
    if (!reasons.length) { actions.push({ device_id: deviceId, alias: dev.alias, skipped: "no evaluable rules" }); continue }
    const reason = `${desired ? "ON" : "OFF"} [any-on] ${reasons.join("; ")}`

    if ((await kasaReadState(env, dev) === 1) !== desired) {
      await kasaSetState(env, dev, desired)
      await env.DATABASE.prepare(
        "INSERT INTO device_log (device_id, user_id, ts, action, price, reason) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(deviceId, env.USER_ID, nowISO, desired ? "on" : "off", parseFloat(rate.price), reason).run()
      actions.push({ device_id: deviceId, alias: dev.alias, action: desired ? "on" : "off", reason })
    } else {
      actions.push({ device_id: deviceId, alias: dev.alias, action: "unchanged", reason })
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
 * GET /api/kasa/devices — live device list from TP-Link cloud.
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
  const results = await Promise.all(devices.map(async d => ({
    device_id: d.deviceId,
    alias: d.alias,
    model: d.deviceModel,
    status: d.status,
    // Relay state requires a per-device passthrough; only reachable when online.
    // null = unknown (offline or read failed).
    on: d.status === 1
      ? await kasaReadState(env, d).then(s => s === 1).catch(() => null)
      : null,
  })))
  return Response.json({ results })
}

/**
 * GET /api/kasa/devices/:id — single live device by deviceId or alias.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleKasaDevice(_request, env, _ctx, params) {
  // Live endpoint: resolve against the live list (not the snapshot) and read
  // relay state fresh from the cloud; persist the snapshot from this fetch too.
  const { device: dev, ambiguous } = await resolveDevice(env, params.id, await refreshDeviceSnapshot(env))
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!dev) return new Response("Not Found", { status: 404 })
  return Response.json({
    device_id: dev.deviceId,
    alias: dev.alias,
    model: dev.deviceModel,
    status: dev.status,
    on: dev.status === 1
      ? await kasaReadState(env, dev).then(s => s === 1).catch(() => null)
      : null,
  })
}

/**
 * POST /api/kasa/devices/:id/state — turn a device on or off.
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
  const { device: dev, ambiguous } = await resolveDevice(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!dev) return new Response("Not Found", { status: 404 })
  if (dev.status !== 1) return new Response("Device offline", { status: 409 })
  await kasaSetState(env, dev, body.on)
  const nowISO = new Date().toISOString()
  await env.DATABASE.prepare(
    "INSERT INTO device_log (device_id, user_id, ts, action, price, reason) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(dev.deviceId, env.USER_ID, nowISO, body.on ? "on" : "off", null, "manual").run()
  return Response.json({ device_id: dev.deviceId, alias: dev.alias, on: body.on })
}

/**
 * GET /api/kasa/devices/:id/usage — emeter energy data for a device.
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
  const { device: dev, ambiguous } = await resolveDevice(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!dev) return new Response("Not Found", { status: 404 })
  if (dev.status !== 1) return new Response("Device offline", { status: 409 })
  return Response.json({
    device_id: dev.deviceId,
    alias: dev.alias,
    kind,
    ...(kind === "day" ? { year, month } : kind === "month" ? { year } : {}),
    results: await kasaUsage(env, dev, kind, year, month),
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
  const { device: dev, ambiguous } = await resolveDevice(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!dev) return new Response("Not Found", { status: 404 })
  if (dev.status !== 1) return new Response("Device offline", { status: 409 })
  const [scheduleData, countDownData, antiTheftData] = await Promise.all([
    kasaPassthrough(env, dev, { schedule: { get_rules: {} } }),
    kasaPassthrough(env, dev, { count_down: { get_rules: {} } }),
    kasaPassthrough(env, dev, { anti_theft: { get_rules: {} } }),
  ])
  return Response.json({
    device_id: dev.deviceId,
    alias: dev.alias,
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
 * @returns {Promise<any[]>}
 */
async function recentDayStat(env, dev, module, now) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1
  const get = async (/** @type {number} */ yy, /** @type {number} */ mm) => {
    const data = await kasaPassthrough(env, dev, { [module]: { get_daystat: { year: yy, month: mm } } })
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
  const { device: dev, ambiguous } = await resolveDevice(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!dev) return new Response("Not Found", { status: 404 })
  if (dev.status !== 1) return new Response("Device offline", { status: 409 })

  const now = new Date()
  const [realtimeData, days] = await Promise.all([
    kasaPassthrough(env, dev, { emeter: { get_realtime: {} } }),
    recentDayStat(env, dev, "emeter", now),
  ])
  const rt = realtimeData.emeter.get_realtime
  // energy_wh (newer fw) or energy in kWh (older).
  const agg = aggregateDays(days, (/** @type {any} */ d) => d.energy_wh ?? (d.energy != null ? d.energy * 1000 : 0), now)
  return Response.json({
    device_id: dev.deviceId,
    alias: dev.alias,
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
  const { device: dev, ambiguous } = await resolveDevice(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!dev) return new Response("Not Found", { status: 404 })
  if (dev.status !== 1) return new Response("Device offline", { status: 409 })

  const now = new Date()
  const [sysData, days] = await Promise.all([
    kasaPassthrough(env, dev, { system: { get_sysinfo: {} } }),
    recentDayStat(env, dev, "schedule", now),
  ])
  const sysinfo = sysData.system.get_sysinfo
  // schedule 'time' is minutes per day.
  const agg = aggregateDays(days, (/** @type {any} */ d) => d.time ?? 0, now)
  return Response.json({
    device_id: dev.deviceId,
    alias: dev.alias,
    realtime: { current_runtime_s: sysinfo.on_time ?? 0 },
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
  if (!["threshold", "cheapest_hours", "cheaper_than_gas"].includes(body.strategy)) {
    return "strategy must be 'threshold', 'cheapest_hours' or 'cheaper_than_gas'"
  }
  if (body.strategy === "threshold" && body.threshold_p == null) return "Missing threshold_p"
  if (body.strategy === "cheapest_hours" && body.hours == null) return "Missing hours"
  if (body.efficiency != null && !(body.efficiency > 0)) return "efficiency must be a positive number"
  return null
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
 * GET /api/squid/rules — list rules, each with its tagged devices.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} _params
 * @returns {Promise<Response>}
 */
async function handleSquidRulesList(_request, env, _ctx, _params) {
  const { results: rules } = await env.DATABASE.prepare(
    "SELECT rule_id, name, strategy, threshold_p, hours, efficiency, enabled FROM rules WHERE user_id = ?"
  ).bind(env.USER_ID).all()
  const devicesByRule = await ruleDeviceMap(env)
  const enriched = /** @type {any[]} */ (rules).map(r => ({ ...r, devices: devicesByRule.get(r.rule_id) ?? [] }))
  return Response.json({ results: enriched })
}

/**
 * POST /api/squid/rules — create a rule. Body: { name?, strategy,
 * threshold_p|hours|efficiency, enabled?, device_ids?: string[] }. device_ids
 * must be canonical deviceIds; use the tag endpoint to add by alias.
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
  const rule_id = crypto.randomUUID()
  const efficiency = body.efficiency ?? 1
  const enabled = body.enabled === false ? 0 : 1
  await env.DATABASE.prepare(
    "INSERT INTO rules (rule_id, user_id, name, strategy, threshold_p, hours, efficiency, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(rule_id, env.USER_ID, body.name ?? null, body.strategy, body.threshold_p ?? null, body.hours ?? null, efficiency, enabled).run()
  const deviceIds = Array.isArray(body.device_ids) ? body.device_ids : []
  for (const deviceId of deviceIds) {
    await env.DATABASE.prepare(
      "INSERT OR IGNORE INTO rule_devices (rule_id, device_id, user_id) VALUES (?, ?, ?)"
    ).bind(rule_id, deviceId, env.USER_ID).run()
  }
  return Response.json({
    rule_id, user_id: env.USER_ID, name: body.name ?? null, strategy: body.strategy,
    threshold_p: body.threshold_p ?? null, hours: body.hours ?? null, efficiency, enabled, device_ids: deviceIds,
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
    "SELECT rule_id, name, strategy, threshold_p, hours, efficiency, enabled FROM rules WHERE user_id = ? AND rule_id = ?"
  ).bind(env.USER_ID, params.ruleId).first()
  if (!rule) return new Response("Not Found", { status: 404 })
  const devicesByRule = await ruleDeviceMap(env)
  return Response.json({ ...rule, devices: devicesByRule.get(params.ruleId) ?? [] })
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
  await env.DATABASE.prepare(
    `UPDATE rules SET name = ?, strategy = ?, threshold_p = ?, hours = ?, efficiency = ?, enabled = ?
     WHERE user_id = ? AND rule_id = ?`
  ).bind(body.name ?? null, body.strategy, body.threshold_p ?? null, body.hours ?? null, efficiency, enabled, env.USER_ID, params.ruleId).run()
  return Response.json({
    rule_id: params.ruleId, user_id: env.USER_ID, name: body.name ?? null, strategy: body.strategy,
    threshold_p: body.threshold_p ?? null, hours: body.hours ?? null, efficiency, enabled,
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
 * POST /api/squid/rules/:ruleId/devices/:id — tag a device onto a rule.
 * :id may be a deviceId or alias; resolved to the canonical deviceId.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleSquidRuleTagDevice(_request, env, _ctx, params) {
  const rule = await env.DATABASE.prepare(
    "SELECT 1 FROM rules WHERE user_id = ? AND rule_id = ?"
  ).bind(env.USER_ID, params.ruleId).first()
  if (!rule) return new Response("Rule not found", { status: 404 })
  const { device: dev, ambiguous } = await resolveDevice(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  if (!dev) return new Response("Unknown device; not found on your TP-Link account", { status: 404 })
  await env.DATABASE.prepare(
    "INSERT OR IGNORE INTO rule_devices (rule_id, device_id, user_id) VALUES (?, ?, ?)"
  ).bind(params.ruleId, dev.deviceId, env.USER_ID).run()
  return Response.json({ rule_id: params.ruleId, device_id: dev.deviceId, alias: dev.alias ?? null, tagged: true })
}

/**
 * DELETE /api/squid/rules/:ruleId/devices/:id — untag a device from a rule
 * (the rule itself is preserved). :id may be a deviceId or alias; falls back to
 * the raw :id so an already-removed device can still be untagged by deviceId.
 * @param {Request} _request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @param {Record<string, string>} params
 * @returns {Promise<Response>}
 */
async function handleSquidRuleUntagDevice(_request, env, _ctx, params) {
  const { device: dev, ambiguous } = await resolveDevice(env, params.id)
  if (ambiguous) return new Response("Ambiguous device name; use the deviceId", { status: 409 })
  const deviceId = dev ? dev.deviceId : params.id
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
    "SELECT rule_id, name, strategy, threshold_p, hours, efficiency FROM rules WHERE user_id = ? AND enabled = 1"
  ).bind(env.USER_ID).all()
  const devicesByRule = await ruleDeviceMap(env)
  const results = []
  for (const rule of rules) {
    const slots = []
    for (const day of days) {
      /** @type {{ results: { time_start: string, time_end: string, price: string }[] }} */
      const { results: dayRates } = await env.DATABASE.prepare(
        "SELECT time_start, time_end, price FROM rates WHERE user_id = ? AND time_start >= ? AND time_start < ? ORDER BY time_start ASC"
      ).bind(env.USER_ID, `${day}T00:00:00Z`, `${day}T24:00:00Z`).all()
      let qualifies
      if (rule.strategy === "cheapest_hours") {
        const set = await cheapestStarts(env, day, Math.max(1, Math.round(rule.hours * 2)))
        qualifies = (/** @type {{ time_start: string }} */ r) => set.has(r.time_start)
      } else if (rule.strategy === "cheaper_than_gas") {
        // Gas is typically a flat daily rate; take one price for the day (noon).
        const gasPrice = await gasPriceAt(env, `${day}T12:00:00Z`)
        const ceiling = gasPrice == null ? -Infinity : gasPrice * (rule.efficiency ?? 1)
        qualifies = (/** @type {{ price: string }} */ r) => parseFloat(r.price) <= ceiling
      } else {
        qualifies = (/** @type {{ price: string }} */ r) => parseFloat(r.price) <= rule.threshold_p
      }
      for (const r of dayRates) if (qualifies(r)) slots.push(r)
    }
    results.push({
      rule_id: rule.rule_id,
      name: rule.name,
      strategy: rule.strategy,
      threshold_p: rule.threshold_p,
      hours: rule.hours,
      efficiency: rule.efficiency,
      devices: devicesByRule.get(rule.rule_id) ?? [],
      on_slots: slots.length,
      on_hours: slots.length / 2,
      slots,
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
