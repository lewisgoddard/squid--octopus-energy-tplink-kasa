import { test } from "node:test"
import assert from "node:assert/strict"
import { computeSquidForecast } from "../index.js"

// Routing D1 stub: routes = [{ when: substring | RegExp, first?, all? }]; first match wins.
function stubDb(routes = []) {
  const pick = (sql) => routes.find((r) => (typeof r.when === "string" ? sql.includes(r.when) : r.when.test(sql)))
  return {
    prepare: (sql) => ({
      bind: () => ({
        first: async () => pick(sql)?.first ?? null,
        all: async () => ({ results: pick(sql)?.all ?? [] }),
      }),
    }),
  }
}
const req = (date) => new Request(`https://x/api/squid/forecast?date=${date}`)
const slot = (t, p) => ({ time_start: t, time_end: t, price: p })
// No device tags, empty snapshot — keeps the forecast focused on the rate logic.
const NO_DEVICES = [{ when: "FROM rule_devices", all: [] }, { when: "device_cache", first: null }]
const envWith = (routes) => ({ DATABASE: stubDb([...routes, ...NO_DEVICES]), USER_ID: "u" })

test("forecast threshold: counts the half-hours at/under the threshold", async () => {
  const env = envWith([
    { when: "FROM rules", all: [{ rule_id: "r1", name: "Heater", strategy: "threshold", threshold_p: 15, hours: null, efficiency: null, color_config: null }] },
    { when: "ORDER BY time_start ASC", all: [slot("t1", "10"), slot("t2", "20"), slot("t3", "12")] },
  ])
  const body = await (await computeSquidForecast(req("2026-06-27"), env)).json()
  assert.deepEqual(body.days, ["2026-06-27"])
  const r = body.results[0]
  assert.equal(r.on_slots, 2) // 10 and 12 are <= 15
  assert.equal(r.on_hours, 1)
  assert.equal(r.slots.length, 2)
})

test("forecast price_color: counts half-hours per colour band", async () => {
  const config = { bands: [{ hue: 120, up_to_p: 10 }, { hue: 40, up_to_p: 20 }, { hue: 0, up_to_p: null }] }
  const env = envWith([
    { when: "FROM rules", all: [{ rule_id: "r2", name: "Lamp", strategy: "price_color", color_config: JSON.stringify(config) }] },
    { when: "ORDER BY time_start ASC", all: [slot("t1", "5"), slot("t2", "15"), slot("t3", "25"), slot("t4", "8")] },
  ])
  const body = await (await computeSquidForecast(req("2026-06-27"), env)).json()
  const r = body.results[0]
  // 5 & 8 → green band(0); 15 → amber(1); 25 → red catch-all(2)
  assert.deepEqual(r.bands.map((b) => b.slots), [2, 1, 1])
  assert.deepEqual(r.bands.map((b) => b.hours), [1, 0.5, 0.5])
})

test("forecast cheapest_hours: only the cheapest slots qualify", async () => {
  const env = envWith([
    { when: "FROM rules", all: [{ rule_id: "r3", name: "EV", strategy: "cheapest_hours", hours: 1 }] },
    { when: "ORDER BY CAST(price AS REAL)", all: [{ time_start: "t2" }, { time_start: "t4" }] }, // the 2 cheapest half-hours
    { when: "ORDER BY time_start ASC", all: [slot("t1", "30"), slot("t2", "10"), slot("t3", "28"), slot("t4", "12")] },
  ])
  const body = await (await computeSquidForecast(req("2026-06-27"), env)).json()
  const r = body.results[0]
  assert.equal(r.on_slots, 2)
  assert.deepEqual(r.slots.map((s) => s.time_start), ["t2", "t4"])
})
