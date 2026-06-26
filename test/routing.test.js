import { test } from "node:test"
import assert from "node:assert/strict"
import { matchRoute } from "../index.js"

test("matchRoute captures named params", () => {
  assert.deepEqual(matchRoute("/api/kasa/devices/:id", "/api/kasa/devices/abc"), { id: "abc" })
})

test("matchRoute percent-decodes a param (alias with a space)", () => {
  assert.deepEqual(matchRoute("/api/kasa/devices/:id/state", "/api/kasa/devices/Smart%20Plug/state"), { id: "Smart Plug" })
})

test("matchRoute returns {} for an exact, param-less match", () => {
  assert.deepEqual(matchRoute("/api/kasa/devices", "/api/kasa/devices"), {})
})

test("matchRoute returns null when segment counts differ", () => {
  assert.equal(matchRoute("/api/kasa/devices", "/api/kasa/devices/abc"), null)
  assert.equal(matchRoute("/api/kasa/devices/:id", "/api/kasa/devices"), null)
})
