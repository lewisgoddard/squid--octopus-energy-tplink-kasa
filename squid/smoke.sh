#!/usr/bin/env bash
# Local smoke test — boots `wrangler dev` against the LOCAL D1 and checks that the no-device
# endpoints actually boot, route, authenticate and read D1. The unit tests (`npm test`) cover the
# logic; this covers the wiring the unit tests can't: workerd + nodejs_compat/node:crypto loading,
# the route table, the auth gate, and the D1 binding.
#
# Deliberately avoids the TP-Link / Octopus cloud — it never touches kasa/*, /squid/evaluate,
# /octopus/rates/refresh or /octopus/rates/live (those make live calls and risk account lockout).
#
# Run from squid/:  ./smoke.sh    (needs .dev.vars — gitignored — for SQUID_API_KEY + the env)
set -uo pipefail
cd "$(dirname "$0")"

KEY=$(grep -E '^SQUID_API_KEY=' .dev.vars 2>/dev/null | cut -d= -f2- | tr -d '"')
[ -n "${KEY:-}" ] || { echo "smoke: no SQUID_API_KEY in .dev.vars"; exit 1; }

PORT=${PORT:-8787}
BASE="http://127.0.0.1:$PORT"
TMP=$(mktemp -d)
DEV=
trap '[ -n "$DEV" ] && { kill "$DEV" 2>/dev/null; pkill -P "$DEV" 2>/dev/null; }; rm -rf "$TMP"' EXIT

echo "smoke: starting wrangler dev on :$PORT …"
npx wrangler dev --port "$PORT" >"$TMP/dev.log" 2>&1 &
DEV=$!

# Wait for the public root to answer (up to ~60s; bail early if dev crashes).
ready=
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null)" = "200" ] && { ready=1; break; }
  kill -0 "$DEV" 2>/dev/null || { echo "smoke: wrangler dev exited early:"; tail -20 "$TMP/dev.log"; exit 1; }
  sleep 1
done
[ -n "$ready" ] || { echo "smoke: server never became ready:"; tail -20 "$TMP/dev.log"; exit 1; }

pass=0; fail=0
check() { # label expected-status method path auth(yes/no, default yes)
  local label=$1 exp=$2 method=$3 path=$4 auth=${5:-yes}
  local h=(); [ "$auth" = yes ] && h=(-H "Authorization: Bearer $KEY")
  local code; code=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" "${h[@]}" "$BASE$path")
  if [ "$code" = "$exp" ]; then printf '  \033[32m✓\033[0m %-24s %-4s %s → %s\n' "$label" "$method" "$path" "$code"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-24s %-4s %s → %s (want %s)\n' "$label" "$method" "$path" "$code" "$exp"; fail=$((fail+1)); fi
}

echo "smoke: $BASE"
check "root (public)"        200 GET  /
check "forecast"             200 GET  /api/squid/forecast
check "rules list"           200 GET  /api/squid/rules
check "log"                  200 GET  /api/squid/log
check "octopus rates"        200 GET  /api/octopus/rates
check "unauthenticated"      401 GET  /api/squid/rules no
check "unknown route"        404 GET  /api/nope
check "wrong method"         405 POST /api/squid/forecast

echo "smoke: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
