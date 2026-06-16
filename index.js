async function octopusFetch(url, env) {
  return fetch(url, {
    headers: {
      "content-type": "application/json;charset=UTF-8",
      'Authorization': 'Basic ' + btoa(env.OCTOPUS_API_KEY + ":")
    },
  })
}

async function syncTariff(env) {
  const response = await octopusFetch(
    `https://api.octopus.energy/v1/accounts/${env.OCTOPUS_ACCOUNT}/`,
    env
  )
  if (!response.ok) throw new Error(`Account lookup failed: ${response.status} ${await response.text()}`)
  const account = await response.json()
  const now = new Date().toISOString()
  const meterPoint = account.properties
    ?.flatMap(p => p.electricity_meter_points || [])
    .find(mp => mp.mpan === env.ELECTRICITY_MPAN)
  if (!meterPoint) throw new Error(`MPAN ${env.ELECTRICITY_MPAN} not found in account ${env.OCTOPUS_ACCOUNT}`)
  const agreement = meterPoint.agreements?.find(
    a => a.valid_from <= now && (!a.valid_to || a.valid_to > now)
  )
  if (!agreement) throw new Error(`No active agreement found for MPAN ${env.ELECTRICITY_MPAN}`)
  await env.DATABASE.prepare(
    "INSERT INTO tariffs (user_id, tariff_code) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET tariff_code = excluded.tariff_code"
  ).bind(env.USER_ID, agreement.tariff_code).run()
  return agreement.tariff_code
}

async function fetchOctopusRates(env) {
  const row = await env.DATABASE.prepare(
    "SELECT tariff_code FROM tariffs WHERE user_id = ?"
  ).bind(env.USER_ID).first()
  if (!row) throw new Error(`No tariff configured for user ${env.USER_ID}. Set it via PUT /api/octopus/tariff`)
  // Tariff code format: E-1R-{PRODUCT_CODE}-{REGION}
  const productCode = row.tariff_code.split("-").slice(2, -1).join("-")
  const ratesURL = `https://api.octopus.energy/v1/products/${productCode}/electricity-tariffs/${row.tariff_code}/standard-unit-rates/?page_size=96`
  const response = await octopusFetch(ratesURL, env)
  if (!response.ok) throw new Error(`Rates fetch failed: ${response.status} ${await response.text()}`)
  return response.json()
}

async function fetchOctopusMeter(url, env, selfURL) {
  const response = await octopusFetch(url, env)
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateRates(env).catch(err => console.error("Scheduled updateRates failed:", err)));
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
        const [{ count }, { results }] = await Promise.all([
          env.DATABASE.prepare(`SELECT COUNT(*) as count FROM rates ${where}`).bind(...filterBindings).first(),
          env.DATABASE.prepare(`SELECT time_start, time_end, price FROM rates ${where} ORDER BY time_start DESC LIMIT ? OFFSET ?`).bind(...filterBindings, limit, offset).all()
        ])
        const pageURL = (p) => { const u = new URL(request.url); u.searchParams.set("page", p); u.searchParams.set("limit", limit); return u.toString() }
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

      return new Response("Hi! Read /api/octopus/rates/cache for the todays rates.");
    } catch (err) {
      console.error(err)
      return new Response("Internal Server Error", { status: 500 })
    }
  },
};