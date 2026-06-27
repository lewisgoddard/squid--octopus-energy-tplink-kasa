import { test } from "node:test"
import assert from "node:assert/strict"
import { signV2 } from "../index.js"

// Cross-check vector computed *independently* with openssl (not the JS impl):
//   body  = {"method":"set_device_info","params":{"target_temp":21}}
//   path  = /api/v2/common/passthrough,  nonce = 1111…,  Tapo app keys
//   md5   = printf '%s' "$body" | openssl dgst -md5 -binary | openssl base64
//   sig   = printf '%s\n9999999999\n%s\n%s' "$md5" "$nonce" "$path" | openssl dgst -sha1 -hmac "$secret"
const BODY = '{"method":"set_device_info","params":{"target_temp":21}}'
const PATH = "/api/v2/common/passthrough"
const NONCE = "11111111-2222-3333-4444-555555555555"
const APP = { accessKey: "4d11b6b9d5ea4d19a829adbb9714b057", secretKey: "6ed7d97f3e73467f8a5bab90b577ba4c", nonce: NONCE }

test("signV2 matches the independent openssl computation", () => {
  const h = signV2(BODY, PATH, APP)
  assert.equal(h["Content-MD5"], "ejoGq7azFxn/PukF5saj+g==")
  assert.equal(
    h["X-Authorization"],
    "Timestamp=9999999999, Nonce=11111111-2222-3333-4444-555555555555, " +
      "AccessKey=4d11b6b9d5ea4d19a829adbb9714b057, Signature=9de7f4fee4e58d7ab174d436e5f3927ac0822089",
  )
})

test("a different body changes both Content-MD5 and the signature", () => {
  const a = signV2(BODY, PATH, APP)
  const b = signV2('{"method":"get_device_info"}', PATH, APP)
  assert.notEqual(a["Content-MD5"], b["Content-MD5"])
  assert.notEqual(a["X-Authorization"], b["X-Authorization"])
})

test("a different path changes the signature but not Content-MD5", () => {
  const a = signV2(BODY, PATH, APP)
  const b = signV2(BODY, "/api/v2/common/getDeviceListByPage", APP)
  assert.equal(a["Content-MD5"], b["Content-MD5"]) // md5 is of the body only
  assert.notEqual(a["X-Authorization"], b["X-Authorization"]) // path is in the sig string
})

test("nonce defaults to a fresh UUID per call when not supplied", () => {
  const { accessKey, secretKey } = APP
  const nonceOf = (h) => h["X-Authorization"].match(/Nonce=([0-9a-f-]+),/)[1]
  const na = nonceOf(signV2(BODY, PATH, { accessKey, secretKey }))
  const nb = nonceOf(signV2(BODY, PATH, { accessKey, secretKey }))
  assert.match(na, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(na, nb)
})
