// Worker front for the TP-Link V2 cloud relay container.
//
// The container is the only thing that can reach TP-Link's private-CA V2 hosts. This
// Worker is the entry point: the Squid Worker calls it over a service binding, and it routes
// to the container, which forwards the request (with its CA bundle) and streams the response
// back. It holds no TP-Link credentials — the caller (Squid) signs and builds every request;
// this just passes it through to the CA-trusting forwarder.
import { Container, getContainer } from "@cloudflare/containers"

export class TapoRelay extends Container {
  defaultPort = 8080      // forwarder.mjs listens here
  sleepAfter = "1m"       // scale to zero between uses
  enableInternet = true   // must reach the TP-Link cloud
}

export default {
  // Reachable only via the service binding from the Squid Worker — this Worker has no public
  // URL (`workers_dev = false`, no routes), so the binding itself is the access control and no
  // shared secret is needed. The container additionally host-allowlists to TP-Link.
  async fetch(request, env) {
    return getContainer(env.RELAY, "relay").fetch(request)
  },
}
