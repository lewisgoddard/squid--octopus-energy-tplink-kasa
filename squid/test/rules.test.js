import { test } from "node:test"
import assert from "node:assert/strict"
import { anyOn, ruleDesired, aggregateDays } from "../index.js"

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
const envWith = (routes) => ({ DATABASE: stubDb(routes), USER_ID: "u" })

// --- anyOn ------------------------------------------------------------------

test("anyOn: ON if any rule wants on; collects every reason", () => {
  assert.deepEqual(anyOn([{ on: false, reason: "a" }, { on: true, reason: "b" }]), { desired: true, reasons: ["a", "b"] })
})

test("anyOn: all-off stays off but still carries reasons", () => {
  assert.deepEqual(anyOn([{ on: false, reason: "a" }, { on: false, reason: "b" }]), { desired: false, reasons: ["a", "b"] })
})

test("anyOn: null (unevaluable) results are dropped", () => {
  assert.deepEqual(anyOn([null, { on: true, reason: "b" }, null]), { desired: true, reasons: ["b"] })
})

test("anyOn: empty / all-null → no reasons (caller then skips the load)", () => {
  assert.deepEqual(anyOn([]), { desired: false, reasons: [] })
  assert.deepEqual(anyOn([null, null]), { desired: false, reasons: [] })
})

// --- ruleDesired: cheapest_hours -------------------------------------------

const CHEAP = "ORDER BY CAST(price AS REAL)"

test("ruleDesired cheapest_hours: on when this slot is in the cheapest set", async () => {
  const env = envWith([{ when: CHEAP, all: [{ time_start: "2026-06-27T01:00:00Z" }, { time_start: "2026-06-27T01:30:00Z" }] }])
  const rule = { rule_id: "r", name: "EV", strategy: "cheapest_hours", hours: 1 }
  const out = await ruleDesired(env, rule, { time_start: "2026-06-27T01:00:00Z", price: "20" }, "2026-06-27T01:00:00Z")
  assert.equal(out.on, true)
  assert.match(out.reason, /cheapest 1h$/)
})

test("ruleDesired cheapest_hours: off (not now) when this slot isn't cheapest", async () => {
  const env = envWith([{ when: CHEAP, all: [{ time_start: "2026-06-27T01:00:00Z" }] }])
  const rule = { rule_id: "r", strategy: "cheapest_hours", hours: 1 }
  const out = await ruleDesired(env, rule, { time_start: "2026-06-27T13:00:00Z", price: "20" }, "2026-06-27T13:00:00Z")
  assert.equal(out.on, false)
  assert.match(out.reason, /not now/)
})

// --- ruleDesired: cheaper_than_gas -----------------------------------------

const TARIFF = "FROM tariffs"
const GASRATE = "FROM gas_rates"

test("cheaper_than_gas: on when price <= the tariff gas override", async () => {
  const env = envWith([{ when: TARIFF, first: { gas_price_p: 7 } }])
  const out = await ruleDesired(env, { rule_id: "r", strategy: "cheaper_than_gas" }, { time_start: "x", price: "6" }, "2026-06-27T12:00:00Z")
  assert.equal(out.on, true)
})

test("cheaper_than_gas: efficiency scales the ceiling (6p > 7p×0.5 → off)", async () => {
  const env = envWith([{ when: TARIFF, first: { gas_price_p: 7 } }])
  const out = await ruleDesired(env, { rule_id: "r", strategy: "cheaper_than_gas", efficiency: 0.5 }, { time_start: "x", price: "6" }, "2026-06-27T12:00:00Z")
  assert.equal(out.on, false)
})

test("cheaper_than_gas: falls back to the fetched gas rate when no override", async () => {
  const env = envWith([
    { when: TARIFF, first: { gas_price_p: null } },
    { when: GASRATE, first: { time_start: "x", time_end: "y", price: "8" } },
  ])
  const out = await ruleDesired(env, { rule_id: "r", strategy: "cheaper_than_gas" }, { time_start: "x", price: "8" }, "2026-06-27T12:00:00Z")
  assert.equal(out.on, true) // 8 <= 8
})

test("cheaper_than_gas: null (not evaluable) when no gas price anywhere", async () => {
  const env = envWith([{ when: TARIFF, first: { gas_price_p: null } }]) // gas_rates → null
  const out = await ruleDesired(env, { rule_id: "r", strategy: "cheaper_than_gas" }, { time_start: "x", price: "8" }, "2026-06-27T12:00:00Z")
  assert.equal(out, null)
})

test("cheaper_than_gas + invert: comfort the gas TRV when electricity is dearer", async () => {
  const env = envWith([{ when: TARIFF, first: { gas_price_p: 7 } }])
  const out = await ruleDesired(env, { rule_id: "r", strategy: "cheaper_than_gas", invert: 1 }, { time_start: "x", price: "9" }, "2026-06-27T12:00:00Z")
  assert.equal(out.on, true) // 9 > 7 → base off → inverted on
  assert.match(out.reason, /inverted/)
})

// --- aggregateDays ----------------------------------------------------------

const mk = (iso, wh) => { const d = new Date(iso); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), wh } }

test("aggregateDays: today, 7- and 30-day windows with inclusive boundaries", () => {
  const now = new Date("2026-06-27T10:00:00Z")
  const list = [
    mk("2026-06-28", 500), // future → excluded everywhere
    mk("2026-06-27", 100), // today
    mk("2026-06-26", 50),  // within last_7
    mk("2026-06-21", 10),  // 7th day back (last_7 boundary, inclusive)
    mk("2026-06-20", 999), // 8th day back → out of last_7, in last_30
    mk("2026-05-29", 7),   // 30th day back (last_30 boundary, inclusive)
    mk("2026-05-28", 5),   // 31st day back → out of last_30
  ]
  const agg = aggregateDays(list, (d) => d.wh, now)
  assert.equal(agg.today, 100)
  assert.equal(agg.last_7.total, 160)   // 100 + 50 + 10
  assert.equal(agg.last_7.daily_avg, 22.86) // 160/7, 2dp
  assert.equal(agg.last_30.total, 1166) // 100 + 50 + 10 + 999 + 7
  assert.equal(agg.last_30.daily_avg, 38.87) // 1166/30, 2dp
})

test("aggregateDays: empty list → all zeros", () => {
  assert.deepEqual(aggregateDays([], (d) => d.wh, new Date("2026-06-27T10:00:00Z")), {
    today: 0, last_7: { total: 0, daily_avg: 0 }, last_30: { total: 0, daily_avg: 0 },
  })
})
