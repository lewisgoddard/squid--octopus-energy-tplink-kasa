import { test } from "node:test"
import assert from "node:assert/strict"
import { colorConfigFromBody, colorBandFor, bandIndexFor } from "../index.js"

test("cheap_p/expensive_p shorthand expands to green/amber/red with a catch-all", () => {
  const cfg = colorConfigFromBody({ cheap_p: 10, expensive_p: 20 })
  assert.deepEqual(cfg.bands, [
    { up_to_p: 10, hue: 120 }, { up_to_p: 20, hue: 40 }, { up_to_p: null, hue: 0 },
  ])
  assert.equal(cfg.saturation, 100)
  assert.equal(cfg.brightness, 70)
})

test("colorBandFor maps absolute prices to the right band (boundaries inclusive)", () => {
  const cfg = colorConfigFromBody({ cheap_p: 10, expensive_p: 20 })
  assert.equal(colorBandFor(5, cfg).hue, 120)
  assert.equal(colorBandFor(10, cfg).hue, 120)      // == cutoff -> still green
  assert.equal(colorBandFor(10.01, cfg).hue, 40)    // just over -> amber
  assert.equal(colorBandFor(20, cfg).hue, 40)
  assert.equal(colorBandFor(35, cfg).hue, 0)        // catch-all -> red
  assert.equal(colorBandFor(-3, cfg).hue, 120)      // plunge price -> green
})

test("explicit bands keep custom hue/sat/bri; the last band becomes the catch-all", () => {
  const cfg = colorConfigFromBody({ bands: [{ up_to_p: 5, hue: 200 }, { up_to_p: 999, hue: 300 }], saturation: 80, brightness: 50 })
  assert.equal(cfg.bands.at(-1).up_to_p, null)
  assert.deepEqual(colorBandFor(3, cfg), { hue: 200, saturation: 80, brightness: 50 })
  assert.equal(colorBandFor(500, cfg).hue, 300)
})

test("a band missing its hue falls back to the palette by index", () => {
  const cfg = colorConfigFromBody({ bands: [{ up_to_p: 8 }, {}] })
  assert.equal(cfg.bands[0].hue, 120)
  assert.equal(cfg.bands[1].hue, 40)
})

test("bandIndexFor returns the matching band index", () => {
  const { bands } = colorConfigFromBody({ cheap_p: 10, expensive_p: 20 })
  assert.equal(bandIndexFor(5, bands), 0)
  assert.equal(bandIndexFor(15, bands), 1)
  assert.equal(bandIndexFor(99, bands), 2)
})
