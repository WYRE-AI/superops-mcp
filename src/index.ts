#!/usr/bin/env node
/**
 * SuperOps.ai MCP Server
 *
 * This MCP server provides tools for interacting with SuperOps.ai PSA/RMM API.
 * All tools are listed upfront so they work with every MCP client, including
 * remote connectors (claude.ai, mcp-remote) that do not support dynamic
 * tool-list changes. A helper `superops_navigate` tool provides domain
 * discovery and guidance.
 *
 * The MCP server itself is built by the shared, side-effect-free factory in
 * `mcp-server.ts`, which is reused by the Cloudflare Workers entrypoint
 * (`worker.ts`).
 *
 * Supports both stdio and HTTP transports:
 * - stdio (default): For local Claude Desktop / CLI usage
 * - http: For hosted deployment with optional gateway auth
 *
 * Auth modes:
 * - env (default): Credentials from environment variables
 * - gateway: Credentials injected from request headers by the MCP gateway
 *   - Header: X-SuperOps-API-Token
 *   - Header: X-SuperOps-Subdomain
 *   Gateway mode never falls back to SUPEROPS_* env credentials.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real secret.
 * Empty values and known placeholders exit non-zero. MCP_ALLOW_INSECURE_DEV=1
 * is a local-only escape hatch: it logs a warning, skips X-Gateway-S2S, and
 * binds 127.0.0.1 only. A configured secret honors MCP_HTTP_HOST. When that
 * variable is unset, the listen address defaults to 127.0.0.1. /health stays
 * unauthenticated and does not read credentials. stdio does not use S2S auth.
 *
 * Environment Variables:
 * - SUPEROPS_API_TOKEN: Your SuperOps.ai API token
 * - SUPEROPS_SUBDOMAIN: Your SuperOps.ai subdomain
 * - SUPEROPS_REGION: API region (us or eu, default: us)
 * - MCP_TRANSPORT: Transport mode (stdio or http, default: stdio)
 * - MCP_HTTP_PORT: HTTP port (default: 8080)
 * - MCP_HTTP_HOST: HTTP host. Honored when CONDUIT_S2S_SECRET is set
 *   (default: 127.0.0.1). The insecure-dev bypass ignores a wider bind.
 * - AUTH_MODE: Authentication mode (env or gateway, default: env)
 * - CONDUIT_S2S_SECRET: HMAC secret for X-Gateway-S2S (required for HTTP)
 * - MCP_ALLOW_INSECURE_DEV: Set to 1 to start HTTP without a secret (loopback only)
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { runWithCredentials } from "./client.js";
import { createMcpServer, resolveGatewayCredentials } from "./mcp-server.js";
import { runWithServerRef, bindServerRef } from "./utils/server-ref.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret or count as "S2S configured". Comparison is case-insensitive.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is unset and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

const INSECURE_DEV_NON_LOOPBACK_ERROR =
  "Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET only binds 127.0.0.1. " +
  "Unset MCP_HTTP_HOST or set it to 127.0.0.1.";

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  const bare = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

function refuseHttpStart(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty and known placeholders fail closed. The insecure-dev bypass is
 * exact MCP_ALLOW_INSECURE_DEV=1 and still refuses a placeholder. The
 * secret value is never written to logs.
 */
function resolveHttpS2sSecret(): string {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseHttpStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return raw;
  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    console.error(INSECURE_DEV_WARNING);
    return "";
  }
  refuseHttpStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No real secret (insecure-dev bypass): bind 127.0.0.1 only. A wider
 * MCP_HTTP_HOST is refused. A configured secret honors MCP_HTTP_HOST and
 * defaults to 127.0.0.1 when that variable is unset.
 */
function resolveBindHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) {
    return configured === "" ? LOOPBACK_HOST : configured;
  }
  if (configured === "" || isLoopbackHost(configured)) return LOOPBACK_HOST;
  refuseHttpStart(INSECURE_DEV_NON_LOOPBACK_ERROR);
}

/**
 * Start the server with stdio transport (default).
 */
async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  // stdio is single-session (one process = one caller), so there is no
  // concurrent tenant to isolate from — bind once for the process
  // lifetime rather than per-request. See utils/server-ref.ts.
  bindServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SuperOps.ai MCP server running on stdio (all tools available)");
}

/**
 * Start the server with HTTP Streamable transport.
 *
 * In gateway mode (AUTH_MODE=gateway), credentials are extracted from
 * request headers and isolated per-request via AsyncLocalStorage.
 * Credentials are NEVER stored in process.env or shared state.
 */
export async function startHttpTransport(): Promise<HttpServer> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const s2sSecret = resolveHttpS2sSecret();
  // Loopback unless the operator opts into a wider bind. A wider bind is
  // honored only when CONDUIT_S2S_SECRET is a real secret. The insecure-dev
  // bypass always listens on 127.0.0.1, including when the image sets 0.0.0.0.
  const host = resolveBindHost(s2sSecret);
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`
      );

      // Liveness only. Unauthenticated and must not read vendor credentials:
      // gateway mode has none at process start, and this route is public.
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            transport: "http",
            authMode: isGatewayMode ? "gateway" : "env",
            timestamp: new Date().toISOString(),
          })
        );
        return;
      }

      // MCP endpoint - each request gets a fresh server + transport
      if (url.pathname === "/mcp") {
        // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
        // startup refuses otherwise. A configured secret is always enforced,
        // before any credential extraction.
        if (
          s2sSecret &&
          !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)
        ) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
            })
          );
          return;
        }

        // Gateway mode: extract credentials from headers. Reject when they
        // are missing rather than falling through to SUPEROPS_* in
        // process.env, which is not request-scoped.
        if (isGatewayMode) {
          const resolved = resolveGatewayCredentials((name) =>
            headerValue(req.headers[name])
          );

          if (!resolved.creds) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Missing credentials",
                message: resolved.error,
                required: ["X-SuperOps-API-Token", "X-SuperOps-Subdomain"],
              })
            );
            return;
          }

          const creds = resolved.creds;

          // Run the entire MCP request inside AsyncLocalStorage context
          // so getCredentials()/getClient() pick up per-request creds
          await runWithCredentials(creds, async () => {
            const perRequestServer = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
              enableJsonResponse: true,
            });
            // Bind this request's server into the per-request async context
            // (not a module-level global) so elicitation helpers resolve
            // *this* server/transport even after await gaps, and never a
            // concurrent request's — see utils/server-ref.ts.
            await runWithServerRef(perRequestServer, async () => {
              await perRequestServer.connect(transport);
              await transport.handleRequest(req, res);
              await perRequestServer.close();
            });
          });
          return;
        }

        // Non-gateway mode: single server, env-var credentials. Still one
        // fresh Server per inbound request, so the server ref must still be
        // scoped per request (see utils/server-ref.ts) — otherwise two
        // concurrent requests in this mode could misroute elicitation
        // prompts between each other too.
        const perRequestServer = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await runWithServerRef(perRequestServer, async () => {
          await perRequestServer.connect(transport);
          await transport.handleRequest(req, res);
          await perRequestServer.close();
        });
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Not found",
          endpoints: ["/mcp", "/health"],
        })
      );
    }
  );

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(
        `SuperOps.ai MCP server listening on http://${host}:${port}/mcp`
      );
      console.error(
        `Health check available at http://${host}:${port}/health`
      );
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (X-SuperOps-API-Token + X-SuperOps-Subdomain headers)" : "env (SUPEROPS_API_TOKEN + SUPEROPS_SUBDOMAIN environment variables)"}`
      );
      resolve();
    });
  });

  return httpServer;
}

/**
 * Main entry point - select transport based on MCP_TRANSPORT env var.
 */
async function main() {
  const transport = process.env.MCP_TRANSPORT || "stdio";

  if (transport === "http") {
    const httpServer = await startHttpTransport();
    const shutdown = async () => {
      console.error("Shutting down SuperOps.ai MCP server...");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    console.error("Fatal startup error:", error);
    process.exit(1);
  });
}
