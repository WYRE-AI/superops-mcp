/**
 * Shared MCP server factory for SuperOps.ai.
 *
 * This module is **side-effect free** (importing it never starts a transport),
 * so it can be reused by every entrypoint:
 * - `index.ts`  — stdio + Node HTTP transport
 * - `worker.ts` — Cloudflare Workers (Web Standard) transport
 *
 * All SuperOps.ai tools are exposed upfront (flat architecture) for universal
 * MCP client compatibility.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { Domain, DomainTools, ToolDefinition } from "./types.js";
import { getCredentials, getClient } from "./client.js";
import { registerResourceHandlers } from "./resources.js";

/**
 * Smallest possible authenticated round-trip, used by superops_test_connection.
 *
 * It deliberately does NOT reuse superops_clients_list: that tool elicits a
 * search term when called without filters, and a connectivity check must never
 * prompt the user. One client, one field.
 *
 * `clients` must be selected even though only the count is reported: asking for
 * `listInfo` alone is valid GraphQL but makes SuperOps answer 500 Internal
 * Server Error. Verified against a live tenant — schema validation cannot catch
 * this, so do not "simplify" the selection set.
 */
const PING_QUERY = `
  query getClientList($input: ListInfoInput!) {
    getClientList(input: $input) {
      clients {
        accountId
      }
      listInfo {
        totalCount
      }
    }
  }
`;

// Lazy-loaded domain modules
const domainCache = new Map<Domain, DomainTools>();

// All domain tools, collected once at startup.
//
// The tool set is static and credential-independent, but a fresh server is
// created per request (for credential isolation), so the assembled list is
// memoized at module scope to avoid rebuilding it on every request.
let allDomainTools: ToolDefinition[] | null = null;

export async function loadDomain(domain: Domain): Promise<DomainTools> {
  const cached = domainCache.get(domain);
  if (cached) {
    return cached;
  }

  let tools: DomainTools;
  switch (domain) {
    case "clients": {
      const { getClientsTools } = await import("./domains/clients.js");
      tools = getClientsTools();
      break;
    }
    case "tickets": {
      const { getTicketsTools } = await import("./domains/tickets.js");
      tools = getTicketsTools();
      break;
    }
    case "assets": {
      const { getAssetsTools } = await import("./domains/assets.js");
      tools = getAssetsTools();
      break;
    }
    case "technicians": {
      const { getTechniciansTools } = await import("./domains/technicians.js");
      tools = getTechniciansTools();
      break;
    }
    case "custom": {
      const { getCustomTools } = await import("./domains/custom.js");
      tools = getCustomTools();
      break;
    }
    default:
      throw new Error(`Unknown domain: ${domain}`);
  }

  domainCache.set(domain, tools);
  return tools;
}

/**
 * Domain metadata for navigation
 */
const domainDescriptions: Record<Domain, string> = {
  clients:
    "Client/company management - list, get, search accounts and company information",
  tickets:
    "Ticket management - list, get, create tickets and manage support workflow",
  assets:
    "Asset management - list and get hardware/software assets, endpoint inventory",
  technicians:
    "Technician management - list and get support staff and technician information",
  custom: "Custom queries - execute advanced GraphQL queries with full API access",
};

/**
 * Load all domain tools (lazy-loaded on first access)
 */
async function getAllDomainTools(): Promise<ToolDefinition[]> {
  if (allDomainTools !== null) {
    return allDomainTools;
  }

  const domains: Domain[] = [
    "clients",
    "tickets",
    "assets",
    "technicians",
    "custom",
  ];
  const tools: ToolDefinition[] = [];

  for (const domain of domains) {
    const domainTools = await loadDomain(domain);
    tools.push(...domainTools.tools);
  }

  allDomainTools = tools;
  return tools;
}

// Navigation / discovery tool - helps the LLM find the right tools
const navigationTool: ToolDefinition = {
  name: "superops_navigate",
  description:
    "Discover available SuperOps.ai tools by domain. Returns tool names and descriptions for the selected domain. All tools are callable at any time — this is a help/discovery aid, not a prerequisite.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: `The domain to explore:
- clients: ${domainDescriptions.clients}
- tickets: ${domainDescriptions.tickets}
- assets: ${domainDescriptions.assets}
- technicians: ${domainDescriptions.technicians}
- custom: ${domainDescriptions.custom}`,
        enum: ["clients", "tickets", "assets", "technicians", "custom"],
      },
    },
    required: ["domain"],
  },
};

// Status tool - shows credentials status and available domains
const statusTool: ToolDefinition = {
  name: "superops_status",
  description: "Show credentials status and available domains",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// Connection test tool
const testConnectionTool: ToolDefinition = {
  name: "superops_test_connection",
  description:
    "Test the connection to SuperOps.ai API using configured credentials.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/**
 * Resolve per-request gateway credentials from a header accessor.
 *
 * Works with any transport: pass a getter that returns a (lowercased) header
 * value. Returns `{ creds }` on success, or `{ error }` when required headers
 * are missing.
 */
export function resolveGatewayCredentials(
  getHeader: (lowerName: string) => string | undefined
): {
  creds?: { apiToken: string; subdomain: string };
  error?: string;
} {
  const apiToken = getHeader("x-superops-api-token");
  const subdomain = getHeader("x-superops-subdomain");
  if (!apiToken || !subdomain) {
    return {
      error:
        "Gateway mode requires X-SuperOps-API-Token and X-SuperOps-Subdomain headers",
    };
  }
  return { creds: { apiToken, subdomain } };
}

/**
 * Create and configure an MCP Server instance with all request handlers.
 * Called once for stdio, or per-request for HTTP / Workers transports.
 *
 * The returned server is NOT registered as "the" server anywhere here —
 * callers are responsible for binding it into the per-request `server-ref`
 * AsyncLocalStorage context (via `runWithServerRef` / `bindServerRef`) so
 * elicitation helpers resolve the right server even after await gaps. See
 * `utils/server-ref.ts` for why this matters.
 */
export function createMcpServer(): Server {
  const server = new Server(
    {
      name: "superops-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    }
  );
  registerResourceHandlers(server);

  // List available tools - always returns ALL tools for MCP client compatibility
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const domainTools = await getAllDomainTools();
    return {
      tools: [navigationTool, statusTool, testConnectionTool, ...domainTools],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Handle test connection
    if (name === "superops_test_connection") {
      const creds = getCredentials();
      if (!creds) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No API credentials configured. Please set SUPEROPS_API_TOKEN and SUPEROPS_SUBDOMAIN environment variables.",
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await getClient().query<{
          getClientList?: {
            clients?: { accountId?: string }[];
            listInfo?: { totalCount?: number };
          };
        }>(PING_QUERY, { input: { page: 1, pageSize: 1 } });

        const totalCount = response.getClientList?.listInfo?.totalCount;

        return {
          content: [
            {
              type: "text",
              text:
                `Connection successful!\n\nCredentials configured for:\n` +
                `- Subdomain: ${creds.subdomain}\n- Region: ${creds.region ?? "us"}\n\n` +
                `API is responding correctly` +
                (typeof totalCount === "number" ? ` (${totalCount} clients visible).` : "."),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Connection test failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Handle navigation / discovery helper
    if (name === "superops_navigate") {
      const { domain } = (args ?? {}) as { domain?: string };
      const validDomains: Domain[] = [
        "clients",
        "tickets",
        "assets",
        "technicians",
        "custom",
      ];

      if (!domain || !validDomains.includes(domain as Domain)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid domain. Please choose from: ${validDomains.join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const domainTools = await loadDomain(domain as Domain);
      const toolSummary = domainTools.tools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `${domainDescriptions[domain as Domain]}\n\nAvailable tools:\n${toolSummary}\n\nYou can call any of these tools directly.`,
          },
        ],
      };
    }

    // Handle status
    if (name === "superops_status") {
      const creds = getCredentials();
      const credStatus = creds
        ? `Configured (subdomain: ${creds.subdomain}, region: ${creds.region ?? "us"})`
        : "NOT CONFIGURED - Please set SUPEROPS_API_TOKEN and SUPEROPS_SUBDOMAIN environment variables";

      return {
        content: [
          {
            type: "text",
            text: `SuperOps.ai MCP Server Status\n\nCredentials: ${credStatus}\nAvailable domains: ${Object.keys(domainDescriptions).join(", ")}\n\nAll tools are available at all times. Use superops_navigate to discover tools by domain.`,
          },
        ],
      };
    }

    // Check for credential issues before domain calls
    const creds = getCredentials();
    if (!creds) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No API credentials configured. Please set SUPEROPS_API_TOKEN and SUPEROPS_SUBDOMAIN environment variables.",
          },
        ],
        isError: true,
      };
    }

    // Route to appropriate domain handler based on tool name prefix
    const toolArgs = (args ?? {}) as Record<string, unknown>;

    if (name.startsWith("superops_clients_")) {
      const domainTools = await loadDomain("clients");
      return domainTools.handleCall(name, toolArgs);
    }
    if (name.startsWith("superops_tickets_")) {
      const domainTools = await loadDomain("tickets");
      return domainTools.handleCall(name, toolArgs);
    }
    if (name.startsWith("superops_assets_")) {
      const domainTools = await loadDomain("assets");
      return domainTools.handleCall(name, toolArgs);
    }
    if (name.startsWith("superops_technicians_")) {
      const domainTools = await loadDomain("technicians");
      return domainTools.handleCall(name, toolArgs);
    }
    if (name.startsWith("superops_custom_")) {
      const domainTools = await loadDomain("custom");
      return domainTools.handleCall(name, toolArgs);
    }

    // Unknown tool
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${name}. Use superops_navigate to discover available tools by domain.`,
        },
      ],
      isError: true,
    };
  });

  return server;
}
