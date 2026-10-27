# kt-mcp

A remote [MCP](https://modelcontextprotocol.io) server that connects an AI agent to your **kaloricketabulky.cz** food diary, packaged as a single **Cloudflare Worker** that runs on the free plan.

You say *"I ate 3 eggs and a banana"*, and the agent searches the Czech food database, picks the right portion unit, and writes the entries into your real diary. The official app stays the source of truth, so premium features keep working.

This is a fork of [stany9g/kt-mcp](https://github.com/stany9g/kt-mcp) (Czech README there). The tools are the same; the hosting is not. See [What changed](#what-changed-from-upstream).

> ## Unofficial, and not affiliated with Dine4Fit
>
> kaloricketabulky.cz is operated by **Dine4Fit, a.s.**, who are not involved in
> this project and do not endorse it. There is no public API; the endpoints used
> here were read out of the site's own frontend JavaScript and may change or
> break without notice.
>
> Dine4Fit's terms grant a **personal, non-commercial** licence. This software is
> published so that you can automate access to **your own account**, which is
> what that licence permits. Running it as a paid or multi-tenant service, or
> redistributing the food data it returns, is a different matter and is on you.
> The database is Dine4Fit's and is protected by EU database rights.
>
> Keep the request rate human. Don't build a competing client on it.

## What changed from upstream

Upstream runs an Express app in Docker behind nginx and a Cloudflare Tunnel on a machine you keep on 24/7, with a hand-written OAuth server storing tokens in a JSON file. This fork keeps the tools and the kaloricketabulky.cz client and replaces everything around them:

| | Upstream | This fork |
|---|---|---|
| Runtime | Node + Express in Docker, nginx, cloudflared | One Cloudflare Worker, no container, no server |
| Always-on machine | Required (see its HOSTING.md) | Not needed; Cloudflare runs it on demand |
| Cost | Your hardware and electricity | $0 on the Workers Free plan at personal volume |
| Session cookie | In process memory | Workers KV, with an in-isolate cache; written only when it changes |
| OAuth | Own implementation, tokens in `/data/oauth-state.json` | [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider): PKCE, dynamic client registration, Client ID Metadata Documents, refresh-token rotation, tokens stored hashed in KV |
| Static token auth | Not available | Optional second mode for clients that send a fixed `Authorization` header |
| Brute-force protection | express-rate-limit behind a trusted proxy hop | Cloudflare Rate Limiting binding on the consent, registration and token endpoints, keyed by the IP Cloudflare observed |
| MCP transport | SDK Express transport, SSE | SDK fetch-standard transport, stateless, plain JSON responses |
| MD5 for the site's login | `node:crypto` | `crypto.subtle.digest('MD5')`, a documented Workers extension |
| State to back up | A Docker volume | None. Lose the KV namespaces and you reconnect the connector once |

The tools, portion handling and site endpoints are upstream's work, with one addition: `get_day_entries`, which lists the day's individual foods (upstream only had totals). The caveats at the end are upstream's too and still apply.

## Tools

| Tool | Purpose |
|---|---|
| `search_food` | Find foods by Czech name or 13-digit EAN barcode. Returns the food id the other tools need. |
| `get_food_portions` | List a food's natural portion units (`kus (55 g)`, `velký kus (60 g)`) so "3 eggs" logs as three pieces rather than an estimated weight. |
| `get_food_nutrition` | Calories and macros for a quantity, scaled by the site itself. Read-only. |
| `log_food` | Write an eating record into the diary. |
| `get_day_summary` | Read back a day's totals. |
| `get_day_entries` | List the individual foods logged that day, grouped by meal, with portion and macros. |
| `create_meal` | Save a recipe built from existing foods. |
| `list_my_meals` | List saved recipes with their ids and total energy. |
| `log_meal` | Log a whole saved recipe into the diary as one entry. |
| `delete_meal` | Delete a saved recipe. |

Quantities: `amount` counts **units**, not grams. Omitting `unit_id` selects the food's base unit, grams for solids and millilitres for liquids. Pass a `unit_id` from `get_food_portions` and the count multiplies it, so 2 of `porce (250 ml)` is 500 ml.

## How it works

```
Agent ──MCP over HTTPS──► Worker ──JSESSIONID──► kaloricketabulky.cz
                            │
                            ├─ KT_SESSION (KV): the site's session cookie
                            └─ OAUTH_KV  (KV): OAuth clients, grants, tokens
```

Every request is self-contained. The Worker checks the caller's credential, logs in to kaloricketabulky.cz only when it has no cookie or the site rejects the one it has, and runs the tool. The cookie is cached in the isolate's memory and in KV: a warm isolate makes no login at all, a cold one reads KV once and logs in only if the stored cookie is missing or rejected. KV is eventually consistent; a stale cookie just costs one redundant login, which the client already handles as "log in again".

Two credentials, doing different jobs:

| Secret | Guards |
|---|---|
| `MCP_AUTH_PASSWORD` or `MCP_AUTH_TOKEN` | Who may connect an agent to this server |
| `KT_EMAIL` / `KT_PASSWORD` | The kaloricketabulky.cz account the tools write to. Never leaves the Worker |

### Two ways to authenticate an agent

**OAuth mode**, enabled by setting `MCP_AUTH_PASSWORD`. This is what claude.ai's custom connectors use by default and it works on every plan. When you add the connector, Claude registers itself with the Worker, opens a consent page in your browser, you type the passphrase once, and the Worker issues Claude an access token plus a refresh token. Tokens are random, stored only as hashes in `OAUTH_KV`, and rotate on refresh.

**Token mode**, enabled by setting `MCP_AUTH_TOKEN`. The agent sends `Authorization: Bearer <token>` on every request and the Worker compares it in constant time. Use it with Claude Code, with any MCP client that can send a fixed header, or with claude.ai's **Request headers** option. That option is in a limited beta at the time of writing, so check whether your account shows it before relying on it; OAuth mode is the safe default.

Set one or both. With both set, a request carrying the static token skips OAuth; anything else goes through OAuth.

## Setup on Cloudflare

You need a Cloudflare account (free), Node.js 22 or newer, and this repository cloned. Everything below runs through `npx wrangler`, so nothing is installed globally. About fifteen minutes.

### 1. Install and sign in

```bash
npm install
npx wrangler login
```

`wrangler login` opens a browser to authorize the CLI against your Cloudflare account.

### 2. Create the two KV namespaces

```bash
npx wrangler kv namespace create KT_SESSION
npx wrangler kv namespace create OAUTH_KV
```

Each command prints a snippet containing an `id`. Put the two ids into `wrangler.jsonc`, replacing the placeholders:

```jsonc
"kv_namespaces": [
  { "binding": "KT_SESSION", "id": "<id from the first command>" },
  { "binding": "OAUTH_KV", "id": "<id from the second command>" }
]
```

Keep the `binding` names exactly as they are; the code looks them up by name.

### 3. Deploy

```bash
npm run deploy
```

Wrangler bundles `src/index.ts`, uploads it, and prints the URL, something like `https://kt-mcp.<your-subdomain>.workers.dev`. On a brand-new account it first asks to enable your `workers.dev` subdomain; say yes.

The Worker answers every request with a generic 500 until the secrets are set, which is the next step. `npx wrangler tail` shows which secret or binding it is missing; nothing else is served in that state.

Everything the config asks for is on the free plan: Workers (100,000 requests a day), KV (100,000 reads and 1,000 writes a day), Workers Logs, and the Rate Limiting binding. OAuth mode refuses to run without the limiter, because the consent page is a public passphrase prompt. If your account cannot create the binding, either use token mode or add `"vars": { "ALLOW_UNLIMITED_CONSENT_ATTEMPTS": "true" }` to `wrangler.jsonc` and accept that the passphrase can then be guessed at Workers speed.

### 4. Set the secrets

```bash
npx wrangler secret put KT_EMAIL
npx wrangler secret put KT_PASSWORD
npx wrangler secret put MCP_AUTH_PASSWORD
```

Each command prompts for the value and stores it encrypted on Cloudflare. `MCP_AUTH_PASSWORD` must be at least 12 characters; make it long and random, since the consent page is reachable from the whole internet.

If you also want token mode:

```bash
openssl rand -base64 32          # generate a token, keep it somewhere safe
npx wrangler secret put MCP_AUTH_TOKEN
```

Secrets apply to the running Worker without another deploy.

### 5. Verify before connecting anything

```bash
./scripts/verify-deployment.sh https://kt-mcp.<your-subdomain>.workers.dev
```

It checks that the Worker is reachable, that `/mcp` refuses unauthenticated calls, that OAuth discovery documents are served, and that the transport rejects what it should. With `MCP_AUTH_TOKEN` exported in your shell it also lists the tools through token mode.

To exercise the complete OAuth flow with curl, the way a connector would:

```bash
MCP_AUTH_PASSWORD=… ./scripts/smoke-oauth.sh https://kt-mcp.<your-subdomain>.workers.dev
```

It registers one throwaway client, loads the consent page, proves a wrong passphrase is refused, exchanges a code with PKCE, lists the tools with the token, and refreshes it. It never touches your diary.

### 6. Connect Claude

In claude.ai, go to **Customize > Connectors**, click **Add custom connector**, and enter:

- **Name**: anything, for example `Kalorické tabulky`
- **MCP server URL**: `https://kt-mcp.<your-subdomain>.workers.dev/mcp`

If the dialog asks for authentication settings, choose **Sign in now** (or **Sign in when needed**) and, under **OAuth client**, **Use Claude's published identity**. **Register automatically** works too. Click **Add**. A browser tab opens the Worker's consent page: check that it says *Requested by Claude*, type your `MCP_AUTH_PASSWORD`, and click **Authorize**. Claude now holds a token and refreshes it on its own; you type the passphrase once.

The connector is then available in the web app, the desktop app, and the mobile apps, and in scheduled tasks.

For token mode in claude.ai (if your account shows the option): choose **No sign-in**, open **Request headers**, pick `authorization`, and enter the value as `Bearer <your token>` including the word `Bearer` and the space.

For Claude Code:

```bash
claude mcp add --transport http kt https://kt-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <your token>"
```

Without `--header`, Claude Code starts the OAuth flow instead, which also works.

### 7. Optional: a custom domain

Any domain on your Cloudflare account can front the Worker. Add to `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "kt.example.com", "custom_domain": true }]
```

and deploy. Nothing in the code is tied to a hostname: the OAuth issuer and resource identifier are derived from the request, so each hostname is its own issuer and both keep working side by side. Tokens issued under one hostname are, correctly, not valid under another, so after moving to a custom domain remove and re-add the connector in Claude. Once the custom domain works, add `"workers_dev": false` so only one hostname is public.

## Local development

```bash
cp .dev.vars.example .dev.vars    # fill in values; this file is git-ignored
npm run dev                       # wrangler dev on http://localhost:8787
```

`wrangler dev` simulates KV and the rate limiter locally; no Cloudflare account is needed for it. The two scripts above accept `http://127.0.0.1:8787`. Tools that only read the public food database (`search_food`, `get_food_portions`, `get_food_nutrition`) work with fake `KT_*` values; the rest need a real login.

```bash
npm run typecheck   # tsc against the Workers types
npm test            # unit tests for parsing, hashing, the session cache
npm run check       # both, plus a dry-run bundle
```

## Operating it

- **Logs**: `npx wrangler tail`, or the Workers Logs page in the dashboard. Tool calls are logged with their arguments (food names, amounts), never credentials or tokens.
- **Rotate the passphrase or token**: `wrangler secret put` again. Existing OAuth tokens stay valid. To cut them all off, empty `OAUTH_KV`: `npx wrangler kv key list --remote --binding OAUTH_KV` shows the keys and `npx wrangler kv key delete --remote --binding OAUTH_KV <key>` removes one; or delete the namespace in the dashboard, create a new one, update its id in `wrangler.jsonc`, deploy, and reconnect the connector. Without `--remote`, wrangler talks to the local dev store.
- **The site changed something**: tool calls fail loudly with the response the site sent, by design. Fix the client in `src/kt/client.ts`, `npm run deploy`.
- **Limits that matter**: a tool call is one Worker request and one to three requests to kaloricketabulky.cz; the free plan allows 100,000 Worker requests a day and 50 outbound requests per invocation. KV is read once per isolate and written when the Worker logs in or the site rotates the session. None of this is close at personal volume.

## Security notes

- `MCP_AUTH_PASSWORD` is the only way to obtain an OAuth token, and `MCP_AUTH_TOKEN` the only other way in. Both are compared in constant time. Anyone holding either has full access to the diary.
- Discovery documents and client registration are public by design; the spec requires them. Registering a client gets an attacker no further.
- `/authorize`, `/register` and `/token` are rate-limited to 10 requests per minute per client IP per Cloudflare location, approximately. That is a speed bump, not a wall: the real defence is a long random passphrase. The same limit bounds how fast an anonymous caller can make the Worker write to KV (every registration and consent page is a record), which on the free plan is a quota of 1,000 writes a day shared by the whole account; a distributed attacker could still exhaust it, after which token refreshes fail until midnight UTC.
- Because registration is open, a phishing link to the consent page could capture the passphrase if you typed it there. The page names the client and, for Claude's published identity, the domain that published it. Authorize only when you just started connecting from Claude.
- Your kaloricketabulky.cz password is stored as a Worker secret on Cloudflare. If you would rather not trust Cloudflare with it, this is not the deployment for you; upstream's self-hosted version is.
- Unlike upstream, the Worker does not check the `Origin` header on `/mcp`. That check defends local servers that rely on ambient credentials against DNS rebinding; this is a public HTTPS host that accepts only a bearer token, so a page on another origin gains nothing from it, and the check would break browser-based MCP clients, which the OAuth provider serves with CORS headers.
- MD5 of the password is what the site's own login form sends, so the hash is password-equivalent. It is computed per login and never stored.

## Caveats

- **Undocumented upstream.** Dine4Fit guarantees nothing here; a frontend refactor could change payload shapes without warning. The client throws on anything unexpected rather than guessing.
- **Egress.** Requests to kaloricketabulky.cz now come from Cloudflare's network. The first deployed `search_food` call tells you whether the site accepts that.
- **One account per Worker.** Two people, two Workers (they can share a Cloudflare account).
- **Personal use.** Automating entry into your own account is a far softer position than bulk scraping, but it is still outside anything Dine4Fit has sanctioned.
- **`get_day_summary`** passes the site's response through unmodified because its shape isn't fully documented. **`get_day_entries`** reads the diary page's own payload and normalises every `foodstuff` list it finds; when it recognises nothing it returns the raw payload instead of guessing.
- **Partial portions of a recipe cannot be logged.** The site ignores the count on the meal-add form and logs the whole recipe. Log the ingredients individually with `log_food` when only part of a recipe was eaten.

## License

[MIT](LICENSE). The food database and the kaloricketabulky.cz service belong to Dine4Fit, a.s.; this licence covers only the code in this repository.
