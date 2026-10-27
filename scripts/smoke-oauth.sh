#!/usr/bin/env bash
# Walks the whole OAuth flow against a running server with curl, the way a
# connector would: discovery → dynamic client registration → consent page →
# wrong passphrase (must be refused) → right passphrase → code exchange with
# PKCE → tools/list with the token → refresh. Registers one throwaway client.
# Read-only towards kaloricketabulky.cz (it only lists tools).
#
#   MCP_AUTH_PASSWORD=… ./scripts/smoke-oauth.sh http://localhost:8787
set -euo pipefail

B="${1:?usage: $0 <base-url>}"; B="${B%/}"
: "${MCP_AUTH_PASSWORD:?set MCP_AUTH_PASSWORD to the server's consent passphrase}"
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
REDIRECT='http://localhost:9/cb'
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(process.argv[1].split(".").reduce((a,k)=>a?.[k],o)??"")})' "$1"; }

echo "## discovery"
curl -fsS "$B/.well-known/oauth-authorization-server" | json authorization_endpoint
curl -fsS "$B/.well-known/oauth-protected-resource/mcp" | json resource

echo "## register a throwaway public client"
CID=$(curl -fsS "$B/register" -H 'Content-Type: application/json' \
  -d "{\"client_name\":\"kt-mcp smoke test\",\"redirect_uris\":[\"$REDIRECT\"],\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"],\"token_endpoint_auth_method\":\"none\"}" | json client_id)
echo "client_id=${CID:0:12}…"

read -r VERIFIER CHALLENGE < <(node -e 'const c=require("node:crypto");const v=c.randomBytes(32).toString("base64url");console.log(v,c.createHash("sha256").update(v).digest("base64url"))')
AUTH="$B/authorize?response_type=code&client_id=$CID&redirect_uri=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$REDIRECT")&code_challenge=$CHALLENGE&code_challenge_method=S256&scope=kt%3Adiary&state=s123&resource=$(node -e 'console.log(encodeURIComponent(process.argv[1]+"/mcp"))' "$B")"

echo "## consent page"
PAGE=$(curl -fsS -c "$JAR" "$AUTH")
HANDLE=$(sed -n 's/.*name="handle" value="\([^"]*\)".*/\1/p' <<<"$PAGE" | head -1)
[[ -n "$HANDLE" ]] && echo "handle issued" || { echo "no handle in consent page"; exit 1; }
grep -q 'kt-mcp smoke test' <<<"$PAGE" && echo "client name shown" || { echo "client name missing"; exit 1; }

echo "## wrong passphrase"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X POST "$B/authorize" \
  --data-urlencode "handle=$HANDLE" --data-urlencode "password=${MCP_AUTH_PASSWORD}x" --data-urlencode "decision=approve")
[[ "$code" == "401" ]] && echo "refused with 401" || { echo "expected 401, got $code"; exit 1; }

echo "## right passphrase (same handle, same browser)"
LOC=$(curl -s -D - -o /dev/null -b "$JAR" -c "$JAR" -X POST "$B/authorize" \
  --data-urlencode "handle=$HANDLE" --data-urlencode "password=$MCP_AUTH_PASSWORD" --data-urlencode "decision=approve" \
  | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
CODE=$(node -e 'const u=new URL(process.argv[1]);if(u.searchParams.get("state")!=="s123")throw new Error("state mismatch");console.log(u.searchParams.get("code"))' "$LOC")
echo "redirected to ${LOC%%\?*} with a code"

echo "## exchange the code (PKCE)"
TOK=$(curl -fsS "$B/token" -d "grant_type=authorization_code&code=$CODE&code_verifier=$VERIFIER&client_id=$CID&redirect_uri=$REDIRECT")
AT=$(json access_token <<<"$TOK"); RT=$(json refresh_token <<<"$TOK")
[[ -n "$AT" && -n "$RT" ]] && echo "access + refresh token issued, expires_in=$(json expires_in <<<"$TOK")" || { echo "$TOK"; exit 1; }

echo "## tools/list with the OAuth token"
curl -fsS -X POST "$B/mcp" "${H[@]}" -H "Authorization: Bearer $AT" -d "$LIST" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.result)throw new Error(s);console.log(r.result.tools.map(t=>t.name).join(", "))})'

echo "## a forged token"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/mcp" "${H[@]}" -H "Authorization: Bearer ${AT}x" -d "$LIST")
[[ "$code" == "401" ]] && echo "refused with 401" || { echo "expected 401, got $code"; exit 1; }

echo "## refresh"
NEW=$(curl -fsS "$B/token" -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID")
[[ -n "$(json access_token <<<"$NEW")" ]] && echo "refreshed" || { echo "$NEW"; exit 1; }

echo; echo "OAuth flow OK"
