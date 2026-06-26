import { test } from "node:test"
import assert from "node:assert/strict"
import { setpointFor, isThermostat, ruleDesired } from "../index.js"

test("setpointFor picks comfort when active, setback otherwise", () => {
  const rule = { comfort_c: 21, setback_c: 16 }
  assert.equal(setpointFor(rule, true), 21)
  assert.equal(setpointFor(rule, false), 16)
})

test("isThermostat detects TRVs, not plugs/bulbs", () => {
  assert.equal(isThermostat({ deviceType: "IOT.SMARTTHERMOSTAT" }), true)
  assert.equal(isThermostat({ deviceType: "SMART.KASATRV" }), true)
  assert.equal(isThermostat({ deviceType: "IOT.SMARTPLUGSWITCH" }), false)
  assert.equal(isThermostat({ deviceType: "IOT.SMARTBULB" }), false)
  assert.equal(isThermostat({}), false)
})

// threshold doesn't touch env/DB, so ruleDesired is unit-testable for invert.
const at = "2026-01-01T00:00:00Z"
const env = /** @type {any} */ ({})

test("ruleDesired: threshold without invert", async () => {
  const d = await ruleDesired(env, { strategy: "threshold", threshold_p: 15, name: "t" }, { price: "10", time_start: at }, at)
  assert.equal(d.on, true) // 10p <= 15p
  assert.ok(!d.reason.includes("inverted"))
})

test("ruleDesired: invert flips the boolean and notes it", async () => {
  const d = await ruleDesired(env, { strategy: "threshold", threshold_p: 15, invert: 1, name: "t" }, { price: "10", time_start: at }, at)
  assert.equal(d.on, false) // 10p <= 15p, inverted -> false
  assert.ok(d.reason.includes("(inverted)"))

  const d2 = await ruleDesired(env, { strategy: "threshold", threshold_p: 15, invert: 1, name: "t" }, { price: "30", time_start: at }, at)
  assert.equal(d2.on, true) // 30p > 15p, inverted -> true
})

test("setpoint with inverted gas logic: comfort the gas when electricity is dearer", () => {
  // Mirrors a TRV rule: cheaper_than_gas active = electricity cheaper.
  // Inverted, "active" means electricity is DEARER, which should comfort the gas.
  const rule = { comfort_c: 21, setback_c: 16 }
  const elecCheaper = true                 // heat pump would be on
  const activeAfterInvert = !elecCheaper   // invert -> false -> setback the gas
  assert.equal(setpointFor(rule, activeAfterInvert), 16)
  const elecDearer = false
  assert.equal(setpointFor(rule, !elecDearer), 21) // invert -> true -> comfort the gas
})
