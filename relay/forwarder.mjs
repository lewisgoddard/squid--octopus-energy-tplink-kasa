// Minimal, stateless, credential-free HTTPS forwarder for the TP-Link V2 cloud.
//
// It exists for exactly one reason: the V2 cloud hosts present certs from TP-Link's
// PRIVATE CAs, which a Cloudflare Worker's fetch can't trust. This process runs in a
// container with a normal TLS stack and the TP-Link CA bundle, so it can reach those
// hosts and forward verbatim. It holds NO credentials and NO state — the Worker signs
// and builds every request; this only adds CA trust + a host allowlist.
//
// Protocol: the Worker sends the request it wants made, with the absolute target URL in
// `X-Forward-To`. We validate the host, strip hop-by-hop headers, forward (method, the
// remaining headers incl. the signed X-Authorization/Content-MD5, and body), and stream
// the upstream status/headers/body straight back.
import http from "node:http"
import https from "node:https"
import { readFileSync } from "node:fs"

const PORT = Number(process.env.PORT) || 8080
// Suffix allowlist (leading dot = subdomains). NBU added so the same relay covers it if
// a read ever proves NBU-only; both are private-CA and in the bundle either way.
const ALLOW = (process.env.ALLOW_HOSTS || ".tplinkcloud.com,.tplinknbu.com")
  .split(",").map(s => s.trim()).filter(Boolean)

const ca = readFileSync(new URL("./tplink-roots.pem", import.meta.url))
const agent = new https.Agent({ ca, keepAlive: true })

const hostAllowed = (host) => ALLOW.some(s => s.startsWith(".") ? host.endsWith(s) : host === s)

// Hop-by-hop / control headers we must not forward (the signed headers pass through).
const STRIP = new Set(["host", "x-forward-to", "connection", "keep-alive", "proxy-connection",
  "transfer-encoding", "upgrade", "te", "trailer"])

const server = http.createServer((req, res) => {
  const target = req.headers["x-forward-to"]
  if (!target) return end(res, 400, "missing X-Forward-To")
  let url
  try { url = new URL(target) } catch { return end(res, 400, "bad X-Forward-To URL") }
  if (url.protocol !== "https:") return end(res, 400, "https targets only")
  if (!hostAllowed(url.hostname)) return end(res, 403, `host not allowed: ${url.hostname}`)

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) if (!STRIP.has(k.toLowerCase())) headers[k] = v
  headers.host = url.host

  const upstream = https.request(url, { method: req.method, headers, agent }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers)
    up.pipe(res)
  })
  upstream.on("error", (e) => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end("relay error: " + e.message) })
  req.pipe(upstream)
})

function end(res, code, msg) { res.writeHead(code, { "content-type": "text/plain" }); res.end(msg) }

server.listen(PORT, () => console.log(`tapo relay listening on :${PORT} (allow: ${ALLOW.join(", ")})`))
