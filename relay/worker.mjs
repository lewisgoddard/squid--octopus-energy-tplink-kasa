// Worker front for the TP-Link V2 cloud relay container.
//
// The container is the only thing that can reach TP-Link's private-CA V2 hosts. This
// Worker is the entry point: it gates access (shared secret) and routes to the container,
// which forwards the request (with its CA bundle) and streams the response back. It holds
// no TP-Link credentials — the caller (Squid) signs and builds every request; this just
// passes it through to the CA-trusting forwarder.
import { Container, getContainer } from "@cloudflare/containers"

export class TapoRelay extends Container {
  defaultPort = 8080      // forwarder.mjs listens here
  sleepAfter = "5m"       // scale to zero between uses
  enableInternet = true   // must reach the TP-Link cloud
}

export default {
  async fetch(request, env) {
    // Not an open relay: require the shared secret. (The container also host-allowlists.)
    if (!env.RELAY_SECRET || request.headers.get("x-relay-secret") !== env.RELAY_SECRET) {
      return new Response("unauthorized", { status: 401 })
    }
    return getContainer(env.RELAY, "relay").fetch(request)
  },
}
