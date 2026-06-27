- [x] Return octopus account id in /api/octopus/tariff
- [x] Endpoint to return gas rates
- [x] Dedupe the Octopus account fetch in updateRates
- [x] Cache API on octopus/rates + squid/forecast, keyed by user, short TTL.
- [x] persisted device snapshot (ids + names) from cron and endpoints
- [x] Kasa Device lists the following in app:
  - Energy Use
    - Today
      - Current Power
      - Total Power
    - Past 7 Days
      - Daily Average
      - Total Consumption
    - Past 30 days
      - Daily Average
      - Total Consumption
  - Runtime
    - Today
      - Current Runtime
      - Total Runtime
    - Past 7 Days
      - Daily Average
      - Total Runtime
    - Past 30 days
      - Daily Average
      - Total Runtime
- [ ] Kasa + Tapo device support (see plans/DEVICE_SUPPORT.md)
  - [x] Tier 1 — power-strip per-outlet (HS300/KP303/EP40): outlets addressed by
        `<deviceId>NN` via `context.child_ids`; list/state/energy/runtime/rules and
        rule tagging all work per-outlet; strip parent on/off+tag rejected (409)
        UNLESS the strip exposes a master relay (cached `master` flag) — then the
        parent switches the whole strip losslessly via its own relay_state
  - [x] Tier 2 — bulbs/dimmers as relays (deviceType branching: bulbs switch via
        lighting service, read light_state.on_off) + `price_color` indicator rule
        (absolute pence bands → bulb hue; traffic-light default) + manual
        `POST /devices/:id/light`
  - [~] Tier 3 — heating (TRV setpoint): rule model DONE — `invert` flag (flips any
        strategy; usable now on on/off devices) + setpoint mode (`comfort_c`/`setback_c`)
        driving a TRV, gated thru ruleTargetError (setpoint↔thermostat). Evaluate has a
        setpoint pass computing the target temp. Transport now BUILT: kasaSetTargetTemp calls
        smartCall (set_device_info{target_temp} via the V2 cloud + control_child), guarded on
        env.RELAY — the actual write just awaits the relay deploy + service binding (see below).
  - [ ] Tapo/SMART cloud transport — unblocks TRV writes AND Tapo plugs/bulbs (cross-cutting
        #4). Plan: plans/TAPO_SMART_TRANSPORT.md. Phase 0+1 DONE. Protocol is simple (Tapo V2
        login + HMAC-SHA1 signing + plaintext /api/v2/common/passthrough; NO device crypto).
        CONFIRMED via deployed spike: a pure Worker CANNOT reach the Tapo V2 cloud — fetch→526
        (private CA), node:tls won't socket to a web service. ⇒ needs a RELAY. Chosen shape:
        minimal STATELESS passthrough Container (CA-trusting HTTPS forwarder, host-allowlisted,
        binding-only) — Worker keeps ALL per-user auth/HMAC-signing/tokens; container holds no
        creds. Profile-driven: same transport for Tapo AND Kasa v2 (host + app keys differ).
        Auth: refresh-token bootstrap (MFA once → store refresh token per user) so 2FA stays ON,
        no passwords stored.
    - [~] Relay built in relay/ (forwarder.mjs + tplink-roots.pem [both private roots] + Dockerfile
          + worker.mjs Container class + wrangler.toml). LOCALLY VALIDATED: forwards to all 3 V2
          hosts (Tapo/Kasa-v2/NBU) with real responses; allowlist/error cases pass. Image builds
          (amd64), Worker uploads, but `wrangler deploy` blocked at /containers/me → Unauthorized:
          ACCOUNT needs Containers enabled (Workers Paid plan). Topology = option #2: separate
          worker, workers_dev=false (NO public URL), NO secret — Squid reaches it via a service
          binding. Once Containers enabled: cd relay && wrangler deploy.
    - [x] relayFetch built (squid/index.js + test/relay.test.js): boot-tolerant relay client
          (env.RELAY.fetch + X-Forward-To, timeout 30s + 1 retry, returns HTTP errors). The
          kraken-side [[services]] binding is DEFERRED to integration (don't add to live
          squid/wrangler.toml until tapo-relay is deployed, or it breaks kraken's deploy).
    - [x] V2 transport BUILT (squid/index.js + test/{sign,v2,transport}.test.js, all offline):
          signV2 (Content-MD5 + HMAC-SHA1, CROSS-CHECKED vs openssl), V2_PROFILES (Tapo + Kasa-v2
          hosts/appType/app-keys from the APKs — not user secrets), buildV2Login/buildV2Refresh/
          buildV2Passthrough (control_child wrap for hub children), tapoToken (per-(user,profile)
          cache in tapo_tokens; refresh-token-first, password-login fallback), smartCall (sign →
          relayFetch → unwrap responseData, re-auth once on failure). Added nodejs_compat for
          node:crypto + a minimal node-crypto.d.ts shim (avoids @types/node global conflicts).
          kasaSetTargetTemp now calls smartCall, guarded on env.RELAY (RELAY typed in
          worker-env.d.ts; the [[services]] binding stays OUT of wrangler.toml until deploy).
    - [ ] LIVE INTEGRATION (needs Containers enabled): cd relay && wrangler deploy; add the
          [[services]] binding to squid/wrangler.toml; create the tapo_tokens table in D1; then
          live-validate the login/refresh wire shapes (buildV2Refresh body is flagged unverified)
          and the MFA refresh-token bootstrap (the one-time 2FA exchange that seeds refresh_token).