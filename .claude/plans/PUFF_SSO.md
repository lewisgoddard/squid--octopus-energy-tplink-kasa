# Puff SSO — using puff-serverless as Squid's identity provider

Notes from assessing [eustasy/puff-serverless](https://github.com/eustasy/puff-serverless)
as the SSO for a multi-user Squid. Captures what we know; flesh out later.

## What Puff is

A purpose-built **OAuth 2.1 / OpenID Connect provider** ("centralized single sign-on,
access control, and unified billing for multiple orgs across multiple apps"). Same stack
as Squid: **Cloudflare Workers / Pages Functions** + Workers Static Assets, HTMX UI.
Data in **CockroachDB via Hyperdrive** (heavier than Squid's D1).

Built-in: password + **passkeys (WebAuthn)** + **TOTP 2FA**, **federated login**
(GitHub/Google/Microsoft), email verification, password reset, sessions, OAuth key
rotation, orgs/teams/roles, entitlements, Stripe billing.

## Integration surface (what Squid consumes)

Standard OIDC — Squid is a **confidential client** (server-side Worker, can hold a
`client_secret`; PKCE `S256` required regardless):

| Endpoint | Use |
|---|---|
| `/oauth/authorize` | Auth Code + PKCE; renders login + consent; redirects back with `?code=` |
| `/oauth/token` | code → `access_token` + `id_token` (+ `refresh_token` with `offline_access`); also refresh rotation |
| `/oauth/userinfo` | `{ sub, name?, email?, email_verified? }` |
| `/.well-known/openid-configuration` | OIDC discovery |
| `/.well-known/jwks.json` | JWKS (active + retired key during rotation overlap) |

**Scopes:** `openid`, `profile`, `email`, `offline_access`; Puff-specific `puff:memberships`,
`puff:roles`, `puff:entitlements`. `org_uuid` can be passed on `/authorize` to pick the org
context (baked into the access-token JWT).

## Data model (relevant bits)

- `users` — PK `user_uuid` (this becomes Squid's `user_id`, replacing the `USER_ID` env).
- `organisations` (`org_uuid`), `teams` (`team_uuid` → org), `team_members`, memberships, roles.
- `apps` — registered OAuth clients: `client_id` (unique), hashed `client_secret`,
  `redirect_uris[]`. Apps are **global**. Registration is currently a **direct DB insert**
  (operator UI not built yet).
- Per-subject **key-value store** (user/team/org/role/app) and **entitlements** + billing.

## How Squid integrates

1. Register Squid in Puff's `apps` table → `client_id=squid`, `client_secret`,
   `redirect_uri=https://squid…/auth/callback`.
2. Squid `/login` → 302 to Puff `/oauth/authorize?scope=openid email&code_challenge=…`.
3. Puff handles *everything* (password / passkey / TOTP / social / verification) → `?code=`.
4. Squid `/auth/callback` → `POST /oauth/token` (PKCE verifier + `client_secret_basic`) → `id_token`.
5. Squid **verifies the JWT against Puff's cached JWKS at the edge** (no per-request call);
   takes **`sub` = `user_uuid`** as its `user_id`.
6. Squid issues its own **session cookie** for the UI; programmatic access keeps Squid's own
   **`squid_live_…` API tokens** (hashed at rest), keyed to `sub`.

Request only `openid email` to start; ignore orgs/entitlements/billing until needed.

## Roles & permissions (Squid side)

Only meaningful once Squid is a **shared tenancy** (household / property / business);
pure per-user isolation needs no roles.

- **Tenancy:** Puff **org = a Squid "site"**. Resources (connected accounts, devices, rules,
  rates) are owned by `org_uuid`; the acting user's `sub` is the **actor** (written to
  `device_log` for audit). `org_uuid` rides in the access-token JWT; `puff:roles` says what
  the caller may do.
- **Permissions** (`resource:action`): `rates:read`, `rates:manage`, `meters:read`,
  `devices:read`, `devices:control`, `rules:read`, `rules:write`, `logs:read`,
  `accounts:manage` (credentials), `tokens:manage`. (Matches the per-route annotations
  already carried in `index.js` ROUTES, currently all satisfied by the single `SQUID_API_KEY`.)
- **Roles** = bundles: **owner** (all + billing/membership), **admin** (all incl.
  `accounts:manage`/`tokens:manage`, no billing), **operator** (`devices:control`,
  `rules:write`, `rates:read`, `logs:read` — runs the home, can't touch credentials/tokens),
  **viewer** (`*:read`).
- **Split of responsibility:** Puff owns *role assignment* (`puff:roles`); **Squid owns the
  role→permission map** (a small constant, version-controlled in the repo).
- **Entitlements ≠ roles.** Roles = who-can-do-what; entitlements (`puff:entitlements`) =
  plan limits (max devices, feature gates). Keep them separate axes.
- **API tokens inherit ≤ the issuing user's permissions** (scope stored on the token row,
  intersected at request time).
- Deliberately **no `accounts:read` that returns secrets** — secrets are write/rotate-only,
  never read back.

## Secrets storage (multi-user)

- Per-user secrets **encrypted in D1**, never plaintext.
- **Envelope encryption with a server-held master key** (Cloudflare Secrets Store or a
  `wrangler secret`). Required because the **cron runs unattended** — secrets must be
  decryptable with no user present, which rules out purely user-password-derived keys.
- Store the **TP-Link refresh token (not the account password)** — the V2 refresh-token
  flow was verified to work; a refresh token is scoped/revocable, unlike the password.
- Octopus API key encrypted likewise. Squid API tokens stored as **SHA-256 hashes**
  (random high-entropy → fast hash is fine; no bcrypt/argon2 needed).

## Caveats / open questions

- **Infra weight:** Puff needs CockroachDB + Hyperdrive. It's *Puff's* burden (Squid is just
  a client), **but only a win if Puff is already running for eustasy** — standing it up
  solely for Squid is overkill.
- **No built-in rate limiting** in Puff (it explicitly defers this). Front the auth endpoints
  with **Cloudflare WAF / rate-limiting rules**.
- **Manual client registration** (DB insert) until the operator UI lands.
- **Edge cache must be user-keyed.** Already implemented (`__uid` in the cache key for
  `octopus/rates` + `squid/forecast`); swap `USER_ID` → resolved `sub` at multi-user cutover.
- **Maturity:** actively phase-developed; has CI/tests/coverage but still evolving.
- Unrelated to Puff: the TP-Link **V2 / private-CA** problem is a device-layer concern, not
  an SSO one (see device notes); keep separate.

## Decided vs open

- **Decided (direction):** Puff is a strong fit *if it's already deployed*; integrate as a
  confidential OIDC client; `sub` → `user_id`; Squid keeps its own API tokens + role→perm map;
  store TP-Link refresh token (not password), envelope-encrypted in D1.
- **Open:** is Puff actually deployed/available? full role list + per-route permission map
  finalised; session/cookie details; how Squid bootstraps the first user/site; WAF rate-limit
  rules; migration of the current single `USER_ID="lg"` data to a real `sub`/`org_uuid`.

## Reference

- Repo: `../../eustasy/puff-serverless` — see its `docs/Architecture.md`, `docs/Hierarchy.md`,
  `docs/Operations.md` (OAuth endpoints, data model, registering an app).
