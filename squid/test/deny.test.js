import { test } from "node:test"
import assert from "node:assert/strict"
import { ruleTargetError } from "../index.js"

const ON_OFF = ["threshold", "cheapest_hours", "cheaper_than_gas"]
const denied = (x) => typeof x === "string"

const plug = { device: { deviceId: "P", deviceType: "IOT.SMARTPLUGSWITCH" }, childId: null }
const stripParent = { device: { deviceId: "S", deviceType: "IOT.SMARTPLUGSWITCH", children: [{ id: "S00" }, { id: "S01" }], master: false }, childId: null }
const masterStrip = { device: { deviceId: "M", deviceType: "IOT.SMARTPLUGSWITCH", children: [{ id: "M00" }], master: true }, childId: null }
const stripOutlet = { device: { deviceId: "S", deviceType: "IOT.SMARTPLUGSWITCH", children: [{ id: "S00" }] }, childId: "S00" }
const colorBulb = { device: { deviceId: "B", deviceType: "IOT.SMARTBULB", caps: { color: true, dimmable: true, variable_color_temp: true } }, childId: null }
const whiteBulb = { device: { deviceId: "W", deviceType: "IOT.SMARTBULB", caps: { color: false, dimmable: true, variable_color_temp: true } }, childId: null }
const unknownBulb = { device: { deviceId: "U", deviceType: "IOT.SMARTBULB" }, childId: null } // caps not cached yet
const trv = { device: { deviceId: "T", deviceType: "IOT.SMARTTHERMOSTAT" }, childId: null }

test("a master-less strip parent is denied for every strategy", () => {
  for (const s of [...ON_OFF, "price_color"]) assert.ok(denied(ruleTargetError(s, stripParent)), s)
})

test("a master strip parent is allowed for on/off but denied for price_color (not a bulb)", () => {
  for (const s of ON_OFF) assert.equal(ruleTargetError(s, masterStrip), null, s)
  assert.ok(denied(ruleTargetError("price_color", masterStrip)))
})

test("on/off strategies are valid on plug, outlet and bulbs", () => {
  for (const s of ON_OFF) {
    assert.equal(ruleTargetError(s, plug), null)
    assert.equal(ruleTargetError(s, stripOutlet), null)
    assert.equal(ruleTargetError(s, colorBulb), null)
    assert.equal(ruleTargetError(s, whiteBulb), null)
  }
})

test("price_color requires a colour bulb (unknown caps allowed; resolved later)", () => {
  assert.ok(denied(ruleTargetError("price_color", plug)))
  assert.ok(denied(ruleTargetError("price_color", stripOutlet)))
  assert.ok(denied(ruleTargetError("price_color", whiteBulb)))
  assert.equal(ruleTargetError("price_color", colorBulb), null)
  assert.equal(ruleTargetError("price_color", unknownBulb), null)
})

test("setpoint rules require a thermostat target", () => {
  // isSetpoint = true
  assert.equal(ruleTargetError("cheaper_than_gas", trv, true), null)      // TRV ok
  assert.ok(denied(ruleTargetError("cheaper_than_gas", plug, true)))      // plug rejected
  assert.ok(denied(ruleTargetError("threshold", colorBulb, true)))       // bulb rejected
})

test("on/off and colour rules may not target a thermostat", () => {
  for (const s of [...ON_OFF, "price_color"]) assert.ok(denied(ruleTargetError(s, trv, false)), s)
})
