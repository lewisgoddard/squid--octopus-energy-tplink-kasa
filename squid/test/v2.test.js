import { test } from "node:test"
import assert from "node:assert/strict"
import { V2_PROFILES, buildV2Login, buildV2Passthrough } from "../index.js"

test("V2_PROFILES has Tapo + Kasa-v2 with distinct hosts/appTypes/keys", () => {
  const t = V2_PROFILES.tapo, k = V2_PROFILES.kasa_v2
  assert.equal(t.host, "https://n-wap.i.tplinkcloud.com")
  assert.equal(t.appType, "TP-Link_Tapo_Android")
  assert.equal(k.host, "https://n-wap.tplinkcloud.com")
  assert.equal(k.appType, "Kasa_Android_Mix")
  assert.notEqual(t.accessKey, k.accessKey)
  assert.notEqual(t.secretKey, k.secretKey)
  for (const p of [t, k]) for (const f of ["host", "appType", "accessKey", "secretKey"]) assert.ok(p[f], `${f} set`)
})

test("buildV2Login: correct path + body fields, refresh token requested", () => {
  const { path, body } = buildV2Login(V2_PROFILES.tapo, { username: "u@x.com", password: "pw", terminalUUID: "tid" })
  assert.equal(path, "/api/v2/account/login")
  assert.deepEqual(JSON.parse(body), {
    appType: "TP-Link_Tapo_Android",
    cloudUserName: "u@x.com",
    cloudPassword: "pw",
    terminalUUID: "tid",
    refreshTokenNeeded: true,
  })
})

test("buildV2Passthrough: whole device → requestData is the stringified {method,params}", () => {
  const { path, body } = buildV2Passthrough("DEV1", "get_device_info", { foo: 1 })
  assert.equal(path, "/api/v2/common/passthrough")
  const outer = JSON.parse(body)
  assert.equal(outer.deviceId, "DEV1")
  assert.equal(typeof outer.requestData, "string") // requestData is a JSON string
  assert.deepEqual(JSON.parse(outer.requestData), { method: "get_device_info", params: { foo: 1 } })
})

test("buildV2Passthrough: hub child → wrapped in control_child (nested object requestData)", () => {
  const { body } = buildV2Passthrough("HUB", "set_device_info", { target_temp: 21 }, "TRV1")
  const outer = JSON.parse(body)
  assert.equal(outer.deviceId, "HUB") // addressed to the hub
  const cmd = JSON.parse(outer.requestData)
  assert.equal(cmd.method, "control_child")
  assert.equal(cmd.params.device_id, "TRV1")
  // inner requestData is a nested object here (not a string) — the SMART hub convention
  assert.deepEqual(cmd.params.requestData, { method: "set_device_info", params: { target_temp: 21 } })
})
