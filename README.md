# SuperOps.ai MCP Server

MCP server for Claude that provides tools to interact with the SuperOps.ai PSA/RMM platform using their GraphQL API.

## One-Click Deployment

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/WYRE-AI/superops-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WYRE-AI/superops-mcp)

> **Operator note — GitHub Packages authentication.** This package is published
> to the `@wyre-ai` scope on **GitHub Packages**, which requires an
> authentication token on every install (GitHub Packages has no anonymous reads,
> even for public packages). Create a GitHub **Personal Access Token** with the
> `read:packages` scope and supply it to the cloud builder:
>
> - **Cloudflare Workers** — set a build variable named `NODE_AUTH_TOKEN` to your PAT.
> - **DigitalOcean App Platform** — set a **build-time** secret named `GITHUB_TOKEN` to your PAT.
>
> For local installs, run `export NODE_AUTH_TOKEN=$(gh auth token)` before `npm install`.

## Features

- **Decision Tree Architecture**: Navigate to domains (clients, tickets, assets, technicians) to see relevant tools
- **Lazy Loading**: Domain modules load on-demand for faster startup
- **Full CRUD Operations**: List, get, create, and update entities
- **GraphQL Support**: Use custom queries for advanced operations
- **Interactive Ticket Card (MCP Apps)**: ticket results render as an interactive card in MCP Apps hosts — neutral by default, brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars

### Interactive Ticket Card (MCP Apps)

`superops_tickets_get` renders as an interactive card in MCP Apps hosts
(Claude Desktop/web) with an in-card "Add note" round-trip via
`superops_tickets_add_note` that always posts internal-only notes
(`isPublic: false`); plain-JSON behavior is unchanged in other hosts.
The card is neutral by default and brandable via `window.__BRAND__` injection
or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`,
`MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`,
`MCP_BRAND_TEXT`) — no rebuild needed.

## Installation

```bash
# The @wyre-ai scope lives on GitHub Packages and needs a token to install:
export NODE_AUTH_TOKEN=$(gh auth token)
npm install @wyre-ai/superops-mcp
```

## Configuration

Copy [`.env.example`](.env.example) and set the variables below. Leave `CONDUIT_S2S_SECRET` empty in that example; generate a real value with `openssl rand -hex 32` and do not commit it.

```bash
export SUPEROPS_API_TOKEN="your-api-token"
export SUPEROPS_SUBDOMAIN="yourcompany"
export SUPEROPS_REGION="us"  # or "eu" for EU region
```

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPEROPS_API_TOKEN` | For stdio and `AUTH_MODE=env` | SuperOps.ai API token |
| `SUPEROPS_SUBDOMAIN` | For stdio and `AUTH_MODE=env` | SuperOps.ai subdomain |
| `SUPEROPS_REGION` | No | `us` (default) or `eu` |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `env` (default outside Docker) or `gateway`. The image and Compose default to `gateway`. Gateway mode requires `X-SuperOps-API-Token` and `X-SuperOps-Subdomain` on each `/mcp` request and never falls back to `SUPEROPS_*`. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | HMAC secret for `X-Gateway-S2S`. Empty values and known placeholders (`replace-with-a-real-secret`, `your-s2s-secret`, `changeme`, and similar) log an error and exit non-zero. Compose will not start when it is unset. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. Logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` refuses to start. A known placeholder secret is refused even when this flag is set. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Defaults to `127.0.0.1`. The container image sets `0.0.0.0`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` stays unauthenticated and does not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http`, every `/mcp` request must include `X-Gateway-S2S` once `CONDUIT_S2S_SECRET` is set. The header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

In `AUTH_MODE=gateway`, add `X-SuperOps-API-Token` and `X-SuperOps-Subdomain` as well. Missing credential headers are HTTP 401 and do not fall back to `SUPEROPS_*` in the environment. With `AUTH_MODE=env`, the signed request uses those variables from the process environment.

Standalone local use that cannot sign requests:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

Startup logs a warning, skips the S2S check, and binds `127.0.0.1` only. Do not publish that port off loopback.

### Getting Your API Token

1. Log in to SuperOps.ai
2. Click settings icon > "My Profile"
3. Navigate to "API token" tab
4. Click "Generate token"
5. Copy and securely store the token

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "superops": {
      "command": "npx",
      "args": ["@wyre-ai/superops-mcp"],
      "env": {
        "SUPEROPS_API_TOKEN": "your-api-token",
        "SUPEROPS_SUBDOMAIN": "yourcompany",
        "SUPEROPS_REGION": "us"
      }
    }
  }
}
```

## Available Domains & Tools

### Navigation

- `superops_navigate` - Navigate to a domain
- `superops_back` - Return to main menu
- `superops_test_connection` - Test API connectivity

### Clients Domain

- `superops_clients_list` - List clients with filters
- `superops_clients_get` - Get client details
- `superops_clients_search` - Search clients by name

### Tickets Domain

- `superops_tickets_list` - List tickets with filters
- `superops_tickets_get` - Get ticket details
- `superops_tickets_create` - Create a new ticket
- `superops_tickets_update` - Update ticket status/assignment
- `superops_tickets_add_note` - Add note to ticket
- `superops_tickets_log_time` - Log time on ticket

### Assets Domain

- `superops_assets_list` - List assets/endpoints
- `superops_assets_get` - Get asset details
- `superops_assets_software` - Get software inventory
- `superops_assets_patches` - Get patch status

### Technicians Domain

- `superops_technicians_list` - List technicians
- `superops_technicians_get` - Get technician details
- `superops_technicians_groups` - List technician groups

### Custom Domain

- `superops_custom_query` - Run custom GraphQL query
- `superops_custom_mutation` - Run custom GraphQL mutation

## Example Usage

```
User: What tools are available?
Claude: Use superops_navigate to select a domain...

User: Navigate to tickets
Claude: [calls superops_navigate with domain: "tickets"]
Now in tickets domain. Available tools: superops_tickets_list, superops_tickets_get...

User: Show open high priority tickets
Claude: [calls superops_tickets_list with status: ["Open"], priority: ["High"]]
Here are the open high priority tickets...
```

## Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`), defaults to `AUTH_MODE=gateway`, and refuses to start unless `CONDUIT_S2S_SECRET` is a real secret. Publish the port on loopback. In gateway mode, SuperOps credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build -t superops-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  superops-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, publishes `127.0.0.1:8080:8080`, and does not pass `SUPEROPS_API_TOKEN` or `SUPEROPS_SUBDOMAIN` into the container:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Sign `/mcp` the same way as in [HTTP authentication](#http-authentication). A gateway-mode call also sends the vendor headers:

```bash
curl -sS http://127.0.0.1:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -H "X-SuperOps-API-Token: $SUPEROPS_API_TOKEN" \
  -H "X-SuperOps-Subdomain: $SUPEROPS_SUBDOMAIN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `SUPEROPS_API_TOKEN` and `SUPEROPS_SUBDOMAIN`. The DigitalOcean one-click template is that mode: set `CONDUIT_S2S_SECRET` as a runtime secret.

## Rate Limits

SuperOps.ai API has a rate limit of 800 requests per minute per API token.

## Pagination

SuperOps uses page-based pagination, not cursors. List tools take `page`
(1-indexed, default 1) and `pageSize` (default 50, max 100), and return a
`listInfo` block with `page`, `pageSize`, `totalCount` and `hasMore`.

**`hasMore` is tri-state:** `true` when another page exists, `null` — never
`false` — when it does not. Loop on `hasMore === true`, or page off
`totalCount`; looping until `hasMore === false` never terminates.

## Filtering

Filters are `condition` clauses of `{ attribute, operator, value }`, and they
compose — `{ joinOperator: "and" | "or", operands: [ … ] }` nests recursively.
Operators verified against a live tenant:

| Operator | Value |
|---|---|
| `is`, `isNot`, `contains`, `notContains`, `startsWith`, `endsWith` | string |
| `includes`, `notIncludes` | array |

`equals` and `in` are rejected by the API. `includes` matches a value *whole*
while `contains` matches a substring — filtering an OS platform with
`includes: ["Windows"]` matches nothing, because SuperOps stores
`"Microsoft Windows 10 Pro"`.

Two things to know, because neither reports an error:

- Filtering on a value outside a field's real set returns **zero rows, not an
  error**. An empty result may mean a bad value, not an empty tenant.
- Filtering on a JSON column (`software`) rather than a path into it
  (`software.name`) also returns **zero rows silently**.

Use `superops_custom_query` for filter semantics the standard tools don't
express.

## Schema conformance

`schema/superops.graphql` is a vendored copy of the SuperOps GraphQL schema:

```bash
# Authoritative — generated from live introspection
SUPEROPS_API_TOKEN=... SUPEROPS_SUBDOMAIN=... node scripts/fetch-schema.mjs

# No credentials? Falls back to scraping the published API reference
node scripts/fetch-schema.mjs
```

Prefer introspection, and note the committed schema is already the introspected
one. The published docs declare 276 types / 76 queries / 63 mutations where the
live API reports **404 / 116 / 83**, omit deprecations entirely, and declare two
types that do not exist live (`FieldType`, `TicketType`) — validating against
those would pass documents the API rejects.

`src/domains/graphql-schema.test.ts` validates every GraphQL document in `src/`
against it on each `npm test`, so a query referencing a field SuperOps does not
define fails in CI rather than at runtime. Regenerate the schema after a
SuperOps API change and re-run the tests.

## License

Apache-2.0

## Support

For issues and feature requests, please visit the [GitHub repository](https://github.com/WYRE-AI/superops-mcp/issues).
