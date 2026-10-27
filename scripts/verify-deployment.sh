#!/usr/bin/env bash
# Verifies a deployed kt-mcp is reachable and correctly configured, before you
# add it as a connector in Claude. Read-only: logs in to nothing, writes nothing.
#
#   ./scripts/verify-deployment.sh https://kt-mcp.<you>.workers.dev
#
# With MCP_AUTH_TOKEN set in the environment it also calls tools/list through
# token mode. With WAIT=1 it retries the first request until the server is up
# (handy against `wrangler dev`).
set -uo pipefail

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
  echo "usage: $0 https://<your-worker-host>" >&2
  exit 2
fi
BASE="${BASE%/}"

fails=0
pass() { printf '  \033[32mok\033[0m    %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fails=$((fails + 1)); }
retry=()
[[ "${WAIT:-0}" == "1" ]] && retry=(--retry 30 --retry-delay 1 --retry-connrefused --retry-all-errors)

echo "Verifying $BASE"

# 1. Reachable, and PUBLIC_URL-free: the Worker derives its endpoint from the request.
healthfile=$(mktemp); trap 'rm -f "$healthfile"' EXIT
code=$(curl -sS --max-time 15 ${retry[@]+"${retry[@]}"} -o "$healthfile" -w '%{http_code}' "$BASE/healthz" 2>/dev/null || echo 000)
health=$(cat "$healthfile")
if [[ "$code" == "500" ]]; then
  fail "GET /healthz → 500: the Worker is deployed but misconfigured. Run 'npx wrangler tail' and request /healthz again to see which secret or binding is missing"
  echo; echo "$fails check(s) failed."; exit 1
elif [[ "$code" != "200" ]]; then
  fail "GET /healthz → $code. Check 'npx wrangler deployments list' and that the route or workers.dev subdomain is enabled"
  echo; echo "$fails check(s) failed."; exit 1
fi
pass "GET /healthz reachable"
advertised=$(printf '%s' "$health" | sed -n 's/.*"endpoint":"\([^"]*\)".*/\1/p')
[[ "$advertised" == "$BASE/mcp" ]] && pass "endpoint matches ($advertised)" || fail "endpoint mismatch: server says '$advertised', you reached '$BASE'"

# 2. The MCP endpoint must challenge unauthenticated callers.
headers=$(curl -s -D - -o /dev/null --max-time 15 -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
grep -qi '^HTTP/[0-9.]* 401' <<<"$headers" && pass "POST /mcp without a token → 401" || fail "POST /mcp without a token did not return 401 — the endpoint may be unprotected"

# 3. OAuth mode advertises its authorization server; token-only mode does not.
if grep -qi 'www-authenticate:.*resource_metadata=' <<<"$headers"; then
  pass "OAuth mode: 401 carries a resource_metadata challenge"
  for path in "/.well-known/oauth-protected-resource/mcp" "/.well-known/oauth-authorization-server"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE$path")
    [[ "$code" == "200" ]] && pass "GET $path → 200" || fail "GET $path → $code (expected 200)"
  done
else
  pass "token-only mode: no authorization server advertised (set MCP_AUTH_PASSWORD to enable OAuth)"
fi

# 4. Stateless transport: nothing to GET or DELETE.
for m in GET DELETE; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X "$m" "$BASE/mcp" -H 'Accept: application/json, text/event-stream')
  case "$code" in 401|405) pass "$m /mcp → $code";; *) fail "$m /mcp → $code (expected 401 or 405)";; esac
done

# 5. Optional: token mode end to end.
if [[ -n "${MCP_AUTH_TOKEN:-}" ]]; then
  body=$(curl -s --max-time 30 -X POST "$BASE/mcp" -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  if grep -q '"name":"search_food"' <<<"$body"; then
    pass "tools/list with MCP_AUTH_TOKEN lists the tools"
  else
    fail "tools/list with MCP_AUTH_TOKEN failed: ${body:0:200}"
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/mcp" -H "Authorization: Bearer ${MCP_AUTH_TOKEN}x" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  [[ "$code" == "401" ]] && pass "a near-miss token → 401" || fail "a near-miss token → $code"
fi

echo
if (( fails == 0 )); then
  echo "All checks passed. Add this as a custom connector in Claude:"
  echo "  $BASE/mcp"
else
  echo "$fails check(s) failed."
  exit 1
fi
