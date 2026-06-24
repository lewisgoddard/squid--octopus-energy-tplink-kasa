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

/** @param {Env} env */
async function syncTariff(env) {
  const response = await octopusFetch(
    `https://api.octopus.energy/v1/accounts/${env.OCTOPUS_ACCOUNT}/`,
    env
  )
  if (!response.ok) throw new Error(`Account lookup failed: ${response.status} ${await response.text()}`)
  /** @type {any} */
  const account = await response.json()
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

/** @param {Env} env */
async function updateRates(env) {
  await syncTariff(env)
  const { results } = await fetchOctopusRates(env)
  for (const element of results) {
    await env.DATABASE.prepare(
      "insert or ignore into rates (noduplicates, user_id, time_start, time_end, price) values (?, ?, ?, ?, ?)"
    )
      .bind(env.USER_ID + element.valid_from, env.USER_ID, element.valid_from, element.valid_to, element.value_inc_vat)
      .run()
  }
  return results
}

/**
 * @param {Request} request
 * @param {Env} env
 */
function authorized(request, env) {
  return request.headers.get("Authorization") === `Bearer ${env.OCTOPUS_API_KEY}`
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
 * Resolves a live device by its deviceId or (case-insensitive) alias.
 * @param {Env} env
 * @param {string} identifier
 * @returns {Promise<KasaDevice | null>}
 */
async function findKasaDevice(env, identifier) {
  const devices = await kasaDeviceList(env)
  const id = identifier.toLowerCase()
  return devices.find(d => d.deviceId === identifier || (d.alias || "").toLowerCase() === id) || null
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
 * Evaluates every enabled device rule against the current rate and switches as needed.
 * @param {Env} env
 */
async function evaluateDevices(env) {
  /** @type {{ results: any[] }} */
  const { results: rules } = await env.DATABASE.prepare(
    "SELECT * FROM devices WHERE user_id = ? AND enabled = 1"
  ).bind(env.USER_ID).all()
  if (!rules.length) return []

  const nowISO = new Date().toISOString()
  const rate = await currentRate(env, nowISO)
  const liveDevices = await kasaDeviceList(env)
  const byId = new Map(liveDevices.map(d => [d.deviceId, d]))

  const actions = []
  for (const rule of rules) {
    const dev = byId.get(rule.device_id)
    if (!dev) { actions.push({ device_id: rule.device_id, skipped: "not found" }); continue }
    if (dev.status !== 1) { actions.push({ device_id: rule.device_id, alias: dev.alias, skipped: "offline" }); continue }
    if (!rate) { actions.push({ device_id: rule.device_id, alias: dev.alias, skipped: "no rate data" }); continue }

    const price = parseFloat(rate.price)
    let desired, reason
    if (rule.strategy === "cheapest_hours") {
      const set = await cheapestStarts(env, nowISO.slice(0, 10), Math.max(1, Math.round(rule.hours * 2)))
      desired = set.has(rate.time_start)
      reason = `cheapest ${rule.hours}h${desired ? "" : " (not now)"}`
    } else { // threshold
      desired = price <= rule.threshold_p
      reason = `${price}p ${desired ? "<=" : ">"} ${rule.threshold_p}p`
    }

    if ((await kasaReadState(env, dev) === 1) !== desired) {
      await kasaSetState(env, dev, desired)
      await env.DATABASE.prepare(
        "INSERT INTO device_log (device_id, ts, action, price, reason) VALUES (?, ?, ?, ?, ?)"
      ).bind(rule.device_id, nowISO, desired ? "on" : "off", price, reason).run()
      actions.push({ device_id: rule.device_id, alias: dev.alias, action: desired ? "on" : "off", reason })
    } else {
      actions.push({ device_id: rule.device_id, alias: dev.alias, action: "unchanged", reason })
    }
  }
  return actions
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
    const { pathname, searchParams } = new URL(request.url)

    try {
      if (pathname === "/api/octopus/rates/update") {
        const auth = request.headers.get("Authorization")
        if (auth !== `Bearer ${env.OCTOPUS_API_KEY}`) {
          return new Response("Unauthorized", { status: 401 })
        }
        const rates = await updateRates(env)
        return Response.json(rates)
      }

      if (pathname === "/api/octopus/tariff" && request.method === "PUT") {
        const auth = request.headers.get("Authorization")
        if (auth !== `Bearer ${env.OCTOPUS_API_KEY}`) {
          return new Response("Unauthorized", { status: 401 })
        }
        const { tariff_code } = await request.json()
        if (!tariff_code) return new Response("Missing tariff_code", { status: 400 })
        await env.DATABASE.prepare(
          "INSERT INTO tariffs (user_id, tariff_code) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET tariff_code = excluded.tariff_code"
        ).bind(env.USER_ID, tariff_code).run()
        return Response.json({ user_id: env.USER_ID, tariff_code })
      }

      if (pathname === "/api/octopus/tariff" && request.method === "GET") {
        const auth = request.headers.get("Authorization")
        if (auth !== `Bearer ${env.OCTOPUS_API_KEY}`) {
          return new Response("Unauthorized", { status: 401 })
        }
        const row = await env.DATABASE.prepare(
          "SELECT tariff_code FROM tariffs WHERE user_id = ?"
        ).bind(env.USER_ID).first()
        if (!row) return new Response("Not Found", { status: 404 })
        return Response.json({ user_id: env.USER_ID, tariff_code: row.tariff_code })
      }

      if (pathname === "/api/octopus/rates/cache") {
        const params = searchParams
        const limit = Math.min(parseInt(params.get("limit") || "96", 10), 96)
        const page = Math.max(parseInt(params.get("page") || "1", 10), 1)
        const offset = (page - 1) * limit
        const from = params.get("from")
        const to = params.get("to")
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
        });
      }

      if ( pathname == "/api/octopus/rates/live" ) {
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

      if ( pathname == "/api/octopus/meters/electricity" ) {
        const url = `https://api.octopus.energy/v1/electricity-meter-points/${env.ELECTRICITY_MPAN}/meters/${env.ELECTRICITY_SERIAL}/consumption/`
        return fetchOctopusMeter(url, env, request.url)
      }

      if ( pathname == "/api/octopus/meters/gas" ) {
        const url = `https://api.octopus.energy/v1/gas-meter-points/${env.GAS_MPRN}/meters/${env.GAS_SERIAL}/consumption/`
        return fetchOctopusMeter(url, env, request.url)
      }

      if (pathname === "/api/kasa/devices" && request.method === "GET") {
        if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 })
        const { results } = await env.DATABASE.prepare(
          "SELECT device_id, alias, strategy, threshold_p, hours, enabled FROM devices WHERE user_id = ?"
        ).bind(env.USER_ID).all()
        return Response.json({ results })
      }

      if (pathname === "/api/kasa/devices" && request.method === "PUT") {
        if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 })
        const body = await request.json()
        if (!body.device_id) return new Response("Missing device_id", { status: 400 })
        if (!["threshold", "cheapest_hours"].includes(body.strategy)) {
          return new Response("strategy must be 'threshold' or 'cheapest_hours'", { status: 400 })
        }
        if (body.strategy === "threshold" && body.threshold_p == null) return new Response("Missing threshold_p", { status: 400 })
        if (body.strategy === "cheapest_hours" && body.hours == null) return new Response("Missing hours", { status: 400 })
        await env.DATABASE.prepare(
          `INSERT INTO devices (device_id, user_id, alias, strategy, threshold_p, hours, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             alias = excluded.alias, strategy = excluded.strategy,
             threshold_p = excluded.threshold_p, hours = excluded.hours, enabled = excluded.enabled`
        ).bind(
          body.device_id, env.USER_ID, body.alias ?? null, body.strategy,
          body.threshold_p ?? null, body.hours ?? null, body.enabled === false ? 0 : 1
        ).run()
        return Response.json({ ...body, user_id: env.USER_ID })
      }

      if (pathname === "/api/kasa/devices/live" && request.method === "GET") {
        if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 })
        const devices = await kasaDeviceList(env)
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

      if (pathname === "/api/kasa/sync" && request.method === "GET") {
        if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 })
        return Response.json({ results: await evaluateDevices(env) })
      }

      if (pathname === "/api/kasa/forecast" && request.method === "GET") {
        if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 })
        // Read-only preview of which slots each enabled rule would switch the device
        // on, from cached rates only. No Kasa calls and no switching.
        const today = new Date().toISOString().slice(0, 10)
        const param = searchParams.get("date")
        const days = param ? [param] : [today, new Date(Date.now() + 86400000).toISOString().slice(0, 10)]
        /** @type {{ results: any[] }} */
        const { results: rules } = await env.DATABASE.prepare(
          "SELECT * FROM devices WHERE user_id = ? AND enabled = 1"
        ).bind(env.USER_ID).all()
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
            } else {
              qualifies = (/** @type {{ price: string }} */ r) => parseFloat(r.price) <= rule.threshold_p
            }
            for (const r of dayRates) if (qualifies(r)) slots.push(r)
          }
          results.push({
            device_id: rule.device_id,
            alias: rule.alias,
            strategy: rule.strategy,
            threshold_p: rule.threshold_p,
            hours: rule.hours,
            on_slots: slots.length,
            on_hours: slots.length / 2,
            slots,
          })
        }
        return Response.json({ days, results })
      }

      if (pathname === "/api/kasa/log" && request.method === "GET") {
        if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 })
        const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200)
        const { results } = await env.DATABASE.prepare(
          `SELECT d.device_id, dev.alias, d.ts, d.action, d.price, d.reason
           FROM device_log d LEFT JOIN devices dev ON dev.device_id = d.device_id
           WHERE dev.user_id = ? OR dev.user_id IS NULL
           ORDER BY d.ts DESC LIMIT ?`
        ).bind(env.USER_ID, limit).all()
        return Response.json({ results })
      }

      if (pathname === "/api/kasa/usage" && request.method === "GET") {
        if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 })
        const identifier = searchParams.get("device")
        if (!identifier) return new Response("Missing device", { status: 400 })
        const kind = /** @type {"realtime" | "day" | "month"} */ (searchParams.get("kind") || "realtime")
        if (!["realtime", "day", "month"].includes(kind)) {
          return new Response("kind must be 'realtime', 'day' or 'month'", { status: 400 })
        }
        const now = new Date()
        const year = parseInt(searchParams.get("year") || String(now.getUTCFullYear()), 10)
        const month = parseInt(searchParams.get("month") || String(now.getUTCMonth() + 1), 10)
        const dev = await findKasaDevice(env, identifier)
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

      return new Response("Hi! Read /api/octopus/rates/cache for the todays rates.");
    } catch (err) {
      console.error(err)
      return new Response("Internal Server Error", { status: 500 })
    }
  },
};