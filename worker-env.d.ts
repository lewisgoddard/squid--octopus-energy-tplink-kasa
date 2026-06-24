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
}
