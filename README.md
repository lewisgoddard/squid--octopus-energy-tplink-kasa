# Squid — Octopus Energy × TP-Link Kasa

Make TP-Link Kasa devices rate-aware: Squid reads your Octopus Energy (Agile) rates and
switches loads — and shows price status on bulbs — when electricity is cheap.

## Layout

| Path | What |
|------|------|
| [`squid/`](squid/README.md) | The **Squid Cloudflare Worker** — rate cache, Kasa control, automation rules, D1. **The detailed docs live here.** |
| [`relay/`](relay/README.md) | A CA-trusting passthrough **Container** for TP-Link's V2 (Tapo / Kasa-v2) cloud — the path to Tapo devices & KE100 TRVs (a Worker's `fetch` can't trust TP-Link's private CA). |
| `.claude/plans/` | Design & research notes (device-support tiers; the Tapo/SMART transport). |

## Status

- **Working:** Kasa plugs, switches, power-strip outlets, and bulbs — on/off plus a
  price-colour indicator — driven by rate rules (`threshold` / `cheapest_hours` /
  `cheaper_than_gas`). See [`squid/`](squid/README.md).
- **Designed, not yet shipped:** Tapo / Kasa-v2 plugs & bulbs and KE100 TRV setpoints
  (`invert` + comfort/setback). The rule model is built and gated; it's blocked on the
  [`relay/`](relay/README.md) (Containers must be enabled). See
  [`.claude/plans/TAPO_SMART_TRANSPORT.md`](.claude/plans/TAPO_SMART_TRANSPORT.md).

## Development

Each subproject is self-contained — `cd squid` or `cd relay`, then `npm ci`. CI typechecks
and tests `squid/`, and syntax-checks `relay/`.

## License

[ISC](LICENSE.md).
