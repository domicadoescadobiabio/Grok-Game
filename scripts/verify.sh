#!/usr/bin/env sh
# Verify a running arcade, local or deployed.
#
#   ./scripts/verify.sh                                  # localhost
#   ./scripts/verify.sh https://your-host.example.com    # a deployment
#
# Checks the health endpoint, that every game is registered, that the screen is
# served, and that no web endpoint can affect a game -- then runs the full
# end-to-end suite against the MCP endpoint.
set -eu

BASE="${1:-http://localhost:4900}"
FAIL=0

say() { printf '%s\n' "$*"; }
check() {
  if [ "$2" = "$3" ]; then
    say "  ok   $1"
  else
    say "  FAIL $1 (expected $3, got $2)"
    FAIL=$((FAIL + 1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

say "verifying $BASE"

check "health" "$(code "$BASE/healthz")" "200"
check "screen" "$(code "$BASE/play")" "200"
check "stylesheet" "$(code "$BASE/arcade.css")" "200"
check "client script" "$(code "$BASE/arcade.js")" "200"

GAMES=$(curl -s "$BASE/api/games" | tr ',' '\n' | grep -c '"key"' || true)
check "all seven games registered" "$GAMES" "7"

# The web surface must not be able to play. Every one of these should be gone.
for route in action deal table bots join leave rebuy account; do
  check "POST /api/$route is not exposed" \
    "$(code -X POST "$BASE/api/$route" -H 'Content-Type: application/json' -d '{}')" "404"
done

say ""
say "end-to-end over MCP:"
node "$(dirname "$0")/mcp-play.js" "$BASE/mcp"

if [ "$FAIL" -ne 0 ]; then
  say ""
  say "$FAIL check(s) failed"
  exit 1
fi
