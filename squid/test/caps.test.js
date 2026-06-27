import { test } from "node:test"
import assert from "node:assert/strict"
import { capsFromSysinfo, factsFromSysinfo } from "../index.js"

test("plugs and strips report no caps", () => {
  assert.equal(capsFromSysinfo({ relay_state: 1 }), undefined)
  assert.equal(capsFromSysinfo({ children: [{ id: "x00" }] }), undefined)
  assert.equal(capsFromSysinfo(null), undefined)
})

test("caps reflect colour / tunable-white / dimmable-only bulbs (0/1 ints)", () => {
  assert.deepEqual(capsFromSysinfo({ is_color: 1, is_dimmable: 1, is_variable_color_temp: 1 }),
    { color: true, dimmable: true, variable_color_temp: true })
  assert.deepEqual(capsFromSysinfo({ is_color: 0, is_dimmable: 1, is_variable_color_temp: 1 }),
    { color: false, dimmable: true, variable_color_temp: true })
  assert.deepEqual(capsFromSysinfo({ is_color: 0, is_dimmable: 1, is_variable_color_temp: 0 }),
    { color: false, dimmable: true, variable_color_temp: false })
})

test("factsFromSysinfo bundles children, caps and the strip master flag", () => {
  const bulb = factsFromSysinfo({ is_color: 1, is_dimmable: 1, is_variable_color_temp: 0, light_state: { on_off: 0 } })
  assert.equal(bulb.caps.color, true)
  assert.equal(bulb.children.length, 0)
  assert.equal(bulb.master, false)

  const strip = factsFromSysinfo({ children: [{ id: "a00", alias: "P1", state: 1 }] })
  assert.equal(strip.caps, undefined)
  assert.equal(strip.children.length, 1)
  assert.equal(strip.master, false) // no top-level relay_state

  const masterStrip = factsFromSysinfo({ relay_state: 1, children: [{ id: "m00", state: 1 }] })
  assert.equal(masterStrip.master, true)
})
