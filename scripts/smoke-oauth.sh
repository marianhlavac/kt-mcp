#!/usr/bin/env bash
# Walks the whole OAuth flow against a running server with curl, the way a
# connector would: discovery → dynamic client registration → consent page →
# wrong passphrase (must be refused) → right passphrase → code exchange with
# PKCE → tools/list with the token → forged token → refresh. Registers one
# throwaway client. Read-only towards kaloricketabulky.cz (it only lists tools).
#
#   MCP_AUTH_PASSWORD=… ./scripts/smoke-oauth.sh http://localhost:8787
set -euo pipefail

B="${1:?usage: $0 <base-url>}"; B="${B%/}"
: "${MCP_AUTH_PASSWORD:?set MCP_AUTH_PASSWORD to the consent passphrase of the server}"
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
REDIRECT='http://localhost:9/cb'

# Small helpers, each a single node one-liner so the shell quoting stays simple.
jsonget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];console.log(v===undefined?"":v)})' -- "$1"; }
urlenc() { node -e 'console.log(encodeURIComponent(process.argv[1]))' -- "$1"; }
toolnames() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.result){console.error(s);process.exit(1)}console.log(r.result.tools.map(t=>t.name).join(", "))})'; }
codefrom() { node -e 'const u=new URL(process.argv[1]);if(u.searchParams.get("state")!=="s123"){console.error("state mismatch");process.exit(1)}console.log(u.searchParams.get("code"))' -- "$1"; }
handlefrom() { node -e 'const m=/name="handle" value="([^"]*)"/.exec(require("node:fs").readFileSync(0,"utf8"));console.log(m?m[1]:"")'; }
mcp() { curl -s -o /dev/null -w '%{http_code}' -X POST "$B/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $1" -d "$LIST"; }

echo "## discovery"
curl -fsS "$B/.well-known/oauth-authorization-server" | jsonget authorization_endpoint
curl -fsS "$B/.well-known/oauth-protected-resource/mcp" | jsonget resource

echo "## register a throwaway public client"
REG="{\"client_name\":\"kt-mcp smoke test\",\"redirect_uris\":[\"$REDIRECT\"],\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"],\"token_endpoint_auth_method\":\"none\"}"
CID=$(curl -fsS "$B/register" -H 'Content-Type: application/json' -d "$REG" | jsonget client_id)
echo "client_id=${CID:0:12}…"

VERIFIER=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')
CHALLENGE=$(node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("base64url"))' -- "$VERIFIER")
ENC_REDIRECT=$(urlenc "$REDIRECT")
ENC_RESOURCE=$(urlenc "$B/mcp")
AUTH="$B/authorize?response_type=code&client_id=$CID&redirect_uri=$ENC_REDIRECT&code_challenge=$CHALLENGE&code_challenge_method=S256&scope=kt%3Adiary&state=s123&resource=$ENC_RESOURCE"

echo "## consent page"
PAGE=$(curl -fsS -c "$JAR" "$AUTH")
HANDLE=$(printf '%s' "$PAGE" | handlefrom)
if [[ -z "$HANDLE" ]]; then echo "no handle in consent page"; exit 1; fi
echo "handle issued"
if ! grep -q 'kt-mcp smoke test' <<<"$PAGE"; then echo "client name missing from page"; exit 1; fi
echo "client name shown"

echo "## wrong passphrase"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X POST "$B/authorize" \
  --data-urlencode "handle=$HANDLE" --data-urlencode "password=${MCP_AUTH_PASSWORD}x" --data-urlencode "decision=approve")
if [[ "$code" != "401" ]]; then echo "expected 401, got $code"; exit 1; fi
echo "refused with 401"

echo "## right passphrase, same handle, same browser"
LOC=$(curl -s -D - -o /dev/null -b "$JAR" -c "$JAR" -X POST "$B/authorize" \
  --data-urlencode "handle=$HANDLE" --data-urlencode "password=$MCP_AUTH_PASSWORD" --data-urlencode "decision=approve" \
  | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
CODE=$(codefrom "$LOC")
echo "redirected back to the client with a code"

echo "## exchange the code with PKCE"
TOK=$(curl -fsS "$B/token" -d "grant_type=authorization_code&code=$CODE&code_verifier=$VERIFIER&client_id=$CID&redirect_uri=$REDIRECT")
AT=$(jsonget access_token <<<"$TOK")
RT=$(jsonget refresh_token <<<"$TOK")
if [[ -z "$AT" || -z "$RT" ]]; then echo "$TOK"; exit 1; fi
echo "access and refresh token issued, expires_in=$(jsonget expires_in <<<"$TOK")"

echo "## tools/list with the OAuth token"
curl -fsS -X POST "$B/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $AT" -d "$LIST" | toolnames

echo "## a forged token"
code=$(mcp "${AT}x")
if [[ "$code" != "401" ]]; then echo "expected 401, got $code"; exit 1; fi
echo "refused with 401"

echo "## refresh"
NEW=$(curl -fsS "$B/token" -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID")
if [[ -z "$(jsonget access_token <<<"$NEW")" ]]; then echo "$NEW"; exit 1; fi
echo "refreshed"

echo "## after the refresh: new access token works, old one too until it expires"
code=$(mcp "$(jsonget access_token <<<"$NEW")")
if [[ "$code" != "200" ]]; then echo "new token: expected 200, got $code"; exit 1; fi
code=$(mcp "$AT")
if [[ "$code" != "200" ]]; then echo "old token: expected 200, got $code"; exit 1; fi
echo "ok"

echo; echo "OAuth flow OK"
