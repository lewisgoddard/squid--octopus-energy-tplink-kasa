import { test } from "node:test"
import assert from "node:assert/strict"
import { relayFetch } from "../index.js"

const URL_ = "https://n-wap.i.tplinkcloud.com/api/v2/common/passthrough"

test("forwards target via X-Forward-To, passes method/headers/body, returns the response", async () => {
  let seen
  const relay = {
    async fetch(req) {
      seen = { fwd: req.headers.get("X-Forward-To"), auth: req.headers.get("X-Authorization"), method: req.method, body: await req.text() }
      return new Response("ok", { status: 200 })
    },
  }
  const res = await relayFetch(relay, URL_, { method: "POST", headers: { "X-Authorization": "sig123" }, body: '{"a":1}' })
  assert.equal(res.status, 200)
  assert.equal(seen.fwd, URL_)        // target rides in the header, not the request URL
  assert.equal(seen.auth, "sig123")   // signed headers pass through verbatim
  assert.equal(seen.method, "POST")
  assert.equal(seen.body, '{"a":1}')
})

test("an upstream HTTP error (5xx) is returned, not retried", async () => {
  let calls = 0
  const relay = { async fetch() { calls++; return new Response("nope", { status: 500 }) } }
  const res = await relayFetch(relay, URL_, {}, { retries: 1 })
  assert.equal(res.status, 500)
  assert.equal(calls, 1)
})

test("retries once on a thrown error (cold start), then succeeds", async () => {
  let calls = 0
  const relay = { async fetch() { calls++; if (calls === 1) throw new Error("container booting"); return new Response("ok", { status: 200 }) } }
  const res = await relayFetch(relay, URL_, {}, { retries: 1 })
  assert.equal(res.status, 200)
  assert.equal(calls, 2)
})

test("throws after exhausting retries", async () => {
  let calls = 0
  const relay = { async fetch() { calls++; throw new Error("cold") } }
  await assert.rejects(() => relayFetch(relay, URL_, {}, { retries: 1 }), /failed after 2 attempt/)
  assert.equal(calls, 2)
})

test("times out a hung call, retries, then throws", async () => {
  let calls = 0
  // A call that never settles — relayFetch's timeout must win the race and move on.
  const relay = { fetch() { calls++; return new Promise(() => {}) } }
  await assert.rejects(() => relayFetch(relay, URL_, {}, { timeoutMs: 20, retries: 1 }), /failed after 2 attempt/)
  assert.equal(calls, 2)
})
