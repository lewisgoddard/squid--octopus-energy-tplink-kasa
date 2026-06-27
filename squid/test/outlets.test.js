import { test } from "node:test"
import assert from "node:assert/strict"
import { outletParent, relayStateOf, isBulb } from "../index.js"

// A real Kasa deviceId is 40 hex chars; an outlet id is that + a 2-digit index.
const PLUG = "8012ABCDEF0123456789ABCDEF012345ABCDEF01"
const STRIP = "8006FEDCBA9876543210FEDCBA9876543210FEDC"
const devices = [
  { deviceId: PLUG, deviceType: "IOT.SMARTPLUGSWITCH" },
  { deviceId: STRIP, deviceType: "IOT.SMARTPLUGSWITCH" },
]

test("outletParent: a child id resolves to its parent strip", () => {
  assert.equal(outletParent(devices, STRIP + "01")?.deviceId, STRIP)
})

test("outletParent: a 2-digit suffix only matches its own parent (length-guarded)", () => {
  // PLUG+"00" must resolve to PLUG, never be mistaken for an outlet of STRIP.
  assert.equal(outletParent(devices, PLUG + "00")?.deviceId, PLUG)
})

test("outletParent: a plain deviceId or unknown id is not an outlet", () => {
  assert.equal(outletParent(devices, STRIP), undefined)
  assert.equal(outletParent(devices, "does-not-exist"), undefined)
})

test("relayStateOf: single relay, strip outlet, bulb, and unknowns", () => {
  assert.equal(relayStateOf({ relay_state: 1 }, null), 1)
  assert.equal(relayStateOf({ children: [{ id: STRIP + "00", state: 1 }, { id: STRIP + "01", state: 0 }] }, STRIP + "01"), 0)
  assert.equal(relayStateOf({ light_state: { on_off: 1 } }, null), 1) // bulb has no relay_state
  assert.equal(relayStateOf({ children: [] }, STRIP + "99"), null) // missing outlet
  assert.equal(relayStateOf({}, null), null)
})

test("isBulb distinguishes bulbs from plugs/switches", () => {
  assert.equal(isBulb({ deviceType: "IOT.SMARTBULB" }), true)
  assert.equal(isBulb({ deviceType: "IOT.SMARTPLUGSWITCH" }), false)
  assert.equal(isBulb({}), false)
})
