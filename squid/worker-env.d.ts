// Secrets supplied at runtime via `.dev.vars` (local) or Wrangler secrets (deployed).
// Declared here so type checking doesn't depend on `.dev.vars`, which is gitignored
// and therefore absent in CI. Merges with the `Env` interface that `wrangler types`
// generates from wrangler.toml bindings (e.g. DATABASE).
interface Env {
  OCTOPUS_API_KEY: string
  OCTOPUS_ACCOUNT: string
  ELECTRICITY_MPAN: string
  ELECTRICITY_SERIAL: string
  GAS_MPRN: string
  GAS_SERIAL: string
  USER_ID: string
  TPLINK_USERNAME: string
  TPLINK_PASSWORD: string
  SQUID_API_KEY: string
  // Service binding to the `tapo-relay` Worker (the V2 cloud passthrough). Declared here so
  // smartCall type-checks now; the actual [[services]] binding is added to wrangler.toml at
  // integration, once tapo-relay is deployed (adding it sooner would break kraken's deploy).
  RELAY: Fetcher
}
