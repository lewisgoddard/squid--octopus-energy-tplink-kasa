import { test } from "node:test"
import assert from "node:assert/strict"
import { tapoToken, smartCall } from "../index.js"

// Minimal D1 stub: `first()` returns the given cached row; `run()` records its bind args so we
// can assert what got upserted.
function fakeDb(row = null) {
  const runs = []
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => row,
        run: async () => (runs.push({ sql, args }), { success: true }),
      }),
    }),
  }
  return { db, runs }
}

// Relay stub: records each forwarded request (target URL + method + body + headers) and replies
// with the JSON envelope from `responder(callNumber)`.
function fakeRelay(responder) {
  const reqs = []
  const relay = {
    fetch: async (req) => {
      reqs.push({
        url: req.headers.get("X-Forward-To"),
        method: req.method,
        body: await req.text(),
        signed: req.headers.has("X-Authorization") && req.headers.has("Content-MD5"),
      })
      return new Response(JSON.stringify(responder(reqs.length)), { headers: { "content-type": "application/json" } })
    },
  }
  return { relay, reqs }
}

const baseEnv = (db, relay) => ({
  DATABASE: db, RELAY: relay, USER_ID: "u", TPLINK_USERNAME: "user@x", TPLINK_PASSWORD: "pw",
})

test("tapoToken returns the cached token when unexpired — no cloud call, no write", async () => {
  const { db, runs } = fakeDb({ terminal_uuid: "t", refresh_token: null, access_token: "CACHED", token_expiry: Date.now() + 60_000 })
  const { relay, reqs } = fakeRelay(() => ({ error_code: 0, result: {} }))
  const token = await tapoToken(baseEnv(db, relay), "tapo", false)
  assert.equal(token, "CACHED")
  assert.equal(reqs.length, 0)
  assert.equal(runs.length, 0)
})

test("tapoToken does a password login when there's no refresh token, then caches both tokens", async () => {
  const { db, runs } = fakeDb(null)
  const { relay, reqs } = fakeRelay(() => ({ error_code: 0, result: { token: "ACCESS1", refreshToken: "REFRESH1", expire: 3600 } }))
  const token = await tapoToken(baseEnv(db, relay), "tapo", false)
  assert.equal(token, "ACCESS1")
  assert.equal(reqs.length, 1)
  assert.equal(reqs[0].url, "https://n-wap.i.tplinkcloud.com/api/v2/account/login")
  assert.ok(reqs[0].signed, "login request is signed")
  const body = JSON.parse(reqs[0].body)
  assert.equal(body.cloudUserName, "user@x") // password path
  assert.equal(body.cloudPassword, "pw")
  const stored = runs[0].args // [user, profile, terminalUUID, refreshToken, accessToken, expiry, updatedAt]
  assert.equal(stored[3], "REFRESH1")
  assert.equal(stored[4], "ACCESS1")
})

test("tapoToken uses the stored refresh token (no password) when the cached token is expired", async () => {
  const { db } = fakeDb({ terminal_uuid: "t", refresh_token: "REFRESH0", access_token: "OLD", token_expiry: Date.now() - 1000 })
  const { relay, reqs } = fakeRelay(() => ({ error_code: 0, result: { token: "ACCESS2", expire: 3600 } }))
  const token = await tapoToken(baseEnv(db, relay), "tapo", false)
  assert.equal(token, "ACCESS2")
  const body = JSON.parse(reqs[0].body)
  assert.equal(body.refreshToken, "REFRESH0") // refresh path
  assert.equal(body.cloudPassword, undefined) // password never sent
})

test("smartCall signs the passthrough, carries the token in the query, returns parsed responseData", async () => {
  const { db } = fakeDb({ terminal_uuid: "t", refresh_token: "R", access_token: "TOK", token_expiry: Date.now() + 60_000 })
  const { relay, reqs } = fakeRelay(() => ({ error_code: 0, result: { responseData: JSON.stringify({ error_code: 0, result: { foo: "bar" } }) } }))
  const out = await smartCall(baseEnv(db, relay), "tapo", "DEV1", "get_device_info", {})
  assert.deepEqual(out, { error_code: 0, result: { foo: "bar" } })
  assert.equal(reqs.length, 1) // cached token → no login, just the passthrough
  assert.ok(reqs[0].signed)
  assert.match(reqs[0].url, /\/api\/v2\/common\/passthrough\?token=TOK$/)
  assert.equal(JSON.parse(reqs[0].body).deviceId, "DEV1")
})

test("smartCall re-authenticates once on failure and retries with the fresh token", async () => {
  const { db } = fakeDb({ terminal_uuid: "t", refresh_token: "R", access_token: "STALE", token_expiry: Date.now() + 60_000 })
  // 1: passthrough(STALE) → error; 2: refresh login → fresh token; 3: passthrough(FRESH) → ok
  const { relay, reqs } = fakeRelay((n) =>
    n === 1 ? { error_code: -20651, msg: "token expired" }
    : n === 2 ? { error_code: 0, result: { token: "FRESH", expire: 3600 } }
    : { error_code: 0, result: { responseData: JSON.stringify({ ok: true }) } })
  const out = await smartCall(baseEnv(db, relay), "tapo", "HUB", "set_device_info", { target_temp: 21 }, "TRV1")
  assert.deepEqual(out, { ok: true })
  assert.equal(reqs.length, 3)
  assert.match(reqs[2].url, /\?token=FRESH$/) // retry used the re-minted token
  const cmd = JSON.parse(JSON.parse(reqs[0].body).requestData)
  assert.equal(cmd.method, "control_child") // hub child wrapped
  assert.equal(cmd.params.device_id, "TRV1")
})
