/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the ticket card:
 *   1. renderable tools advertise the UI resource via _meta
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. buildTicketCard normalizes a SuperOps ticket into the card payload
 *      the iframe renders from, with a safe internal-only note default
 */

import { describe, it, expect, vi } from "vitest";

// Mock the client module so handleCall tests never hit the network.
vi.mock("./client.js", () => ({
  getClient: vi.fn(),
  getCredentials: vi.fn(),
  resetClient: vi.fn(),
  runWithCredentials: vi.fn(),
}));

import { getClient } from "./client.js";
import {
  getClientsTools,
  getTicketsTools,
  getAssetsTools,
  getTechniciansTools,
  getCustomTools,
} from "./domains/index.js";
import { listResources, readResource } from "./resources.js";
import {
  buildTicketCard,
  applyBrandInjection,
  TICKET_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from "./card.builder.js";
import { TICKET_CARD_HTML } from "./generated/ticket-card-html.js";
import type { ToolDefinition } from "./types.js";

const RENDERABLE_TOOLS = ["superops_tickets_get", "superops_tickets_add_note"];

function getAllTools(): ToolDefinition[] {
  return [
    getClientsTools(),
    getTicketsTools(),
    getAssetsTools(),
    getTechniciansTools(),
    getCustomTools(),
  ].flatMap((domain) => domain.tools);
}

describe("MCP Apps ticket card", () => {
  describe("tool _meta advertisement", () => {
    it.each(RENDERABLE_TOOLS)("%s links the card via _meta", (name) => {
      const tool = getAllTools().find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.["ui/resourceUri"]).toBe(TICKET_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        TICKET_CARD_RESOURCE_URI
      );
    });

    it("no other tools carry UI metadata", () => {
      const others = getAllTools().filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name)
      );
      expect(others).toEqual([]);
    });
  });

  describe("ui:// resource", () => {
    it("is listed with the MCP Apps MIME type", () => {
      const card = listResources().find((r) => r.uri === TICKET_CARD_RESOURCE_URI);
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it("reads back as profile=mcp-app HTML containing the card app", () => {
      const content = readResource(TICKET_CARD_RESOURCE_URI);
      expect(content.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      // No MCP_BRAND_* env set → the embedded HTML is served byte-identical.
      expect(content.text).toBe(TICKET_CARD_HTML);
      expect(content.text).toContain("card__bar");
      expect(content.text).toContain("BRAND_INJECT");
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content.text).not.toContain('src="./ticket-card.ts"');
    });

    it("serves neutral defaults with no vendor identity", () => {
      const { text } = readResource(TICKET_CARD_RESOURCE_URI);
      expect(text).not.toMatch(/WYRE/i);
      expect(text).not.toContain("00c9db"); // WYRE cyan
      expect(text).not.toContain("ede947"); // WYRE yellow
      expect(text).not.toContain("fonts.googleapis.com"); // no external fetches
    });

    it("injects MCP_BRAND_* env vars into the served HTML", () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      vi.stubEnv("MCP_BRAND_PRIMARY_COLOR", "#ff0000");
      try {
        const { text } = readResource(TICKET_CARD_RESOURCE_URI);
        expect(text).toContain(
          '<script>window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}</script>'
        );
        expect(text).not.toContain("BRAND_INJECT");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("rejects unknown resource URIs", () => {
      expect(() => readResource("ui://superops/nope.html")).toThrow(/Unknown resource/);
    });
  });

  describe("applyBrandInjection", () => {
    const html = TICKET_CARD_HTML;

    it("replaces the marker with an inline window.__BRAND__ script", () => {
      const out = applyBrandInjection(html, { name: "Acme", primaryColor: "#123456" });
      expect(out).toContain('window.__BRAND__={"name":"Acme","primaryColor":"#123456"}');
      expect(out).not.toContain("BRAND_INJECT");
    });

    it("escapes < so brand values cannot break out of the script tag", () => {
      const out = applyBrandInjection(html, { name: "</script><script>alert(1)" });
      expect(out).not.toContain("</script><script>alert(1)");
      expect(out).toContain("\\u003c/script>\\u003cscript>alert(1)");
    });

    it("returns the HTML unchanged for an empty brand", () => {
      expect(applyBrandInjection(html, {})).toBe(html);
      expect(applyBrandInjection(html, { name: "" })).toBe(html);
    });
  });

  describe("buildTicketCard", () => {
    // Field names mirror the real SuperOps Ticket type: `displayId` is the
    // human-facing number, the assigned tech is `technician`, the timestamp is
    // `updatedTime`, and `category` is a plain string.
    const ticket = {
      ticketId: "ticket-4821",
      displayId: "TKT-4821",
      subject: "VPN outage — main office",
      description: "<p>Users at the <b>main office</b> cannot connect.</p>",
      status: "Open",
      priority: "High",
      createdTime: "2026-07-17T09:00:00Z",
      updatedTime: "2026-07-17T10:30:00Z",
      client: { accountId: "acct-12", name: "Acme Corp" },
      site: { id: "site-3", name: "Main Office" },
      requester: { userId: "user-9", name: "Pat Lee", email: "pat@acme.example" },
      technician: { userId: "tech-7", name: "Dana Ruiz", email: "dana@msp.example" },
      techGroup: { groupId: "grp-2", name: "Service Desk" },
      category: "Network",
    };

    it("normalizes labels, names, and dates into the card payload", () => {
      const card = buildTicketCard(ticket);
      expect(card).toMatchObject({
        ticketId: "ticket-4821",
        ticketNumber: "TKT-4821",
        subject: "VPN outage — main office",
        status: "Open",
        priority: "High",
        client: "Acme Corp",
        site: "Main Office",
        requester: "Pat Lee",
        assignee: "Dana Ruiz",
        techGroup: "Service Desk",
        category: "Network",
        createdTime: "2026-07-17T09:00:00Z",
        lastUpdatedTime: "2026-07-17T10:30:00Z",
      });
    });

    it("defaults the add-note round-trip to internal-only visibility", () => {
      const card = buildTicketCard(ticket);
      expect(card?.noteDefaults).toEqual({ isPublic: false });
    });

    it("strips markup and truncates the description snippet", () => {
      const card = buildTicketCard(ticket);
      expect(card?.description).toBe("Users at the main office cannot connect.");
      const long = buildTicketCard({ ...ticket, description: "x".repeat(600) });
      expect(long?.description).toHaveLength(500);
    });

    it("falls back to #id labels when the API omits resolved names", () => {
      const bare = {
        ticketId: "t-1",
        subject: "Printer down",
        client: { accountId: "acct-9" },
        technician: { userId: "tech-3" },
      };
      const card = buildTicketCard(bare);
      expect(card?.client).toBe("#acct-9");
      expect(card?.assignee).toBe("#tech-3");
      expect(card?.requester).toBeUndefined();
      expect(card?.status).toBeUndefined();
    });

    it("returns null for payloads that are not a ticket", () => {
      expect(buildTicketCard({ ticketId: "t-1" })).toBeNull();
      expect(buildTicketCard({ subject: "no id" })).toBeNull();
      expect(buildTicketCard({})).toBeNull();
    });
  });

  describe("superops_tickets_get handler", () => {
    function mockTicketsClient(getTicket: unknown) {
      const mockClient = {
        query: vi.fn(async () => ({ getTicket })),
        mutate: vi.fn(),
      };
      vi.mocked(getClient).mockReturnValue(
        mockClient as unknown as ReturnType<typeof getClient>
      );
      return mockClient;
    }

    it("attaches the normalized _card to the ticket payload", async () => {
      mockTicketsClient({
        ticketId: "ticket-1",
        subject: "Server offline",
        status: "Open",
        client: { accountId: "a-1", name: "Acme Corp" },
      });

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_get", {
        ticketId: "ticket-1",
      });

      // content is a human-readable summary, not a JSON dump.
      expect(() => JSON.parse(result.content[0].text)).toThrow();
      expect(result.content[0].text).toContain("Server offline");

      const payload = result.structuredContent as Record<string, unknown>;
      expect(payload.ticketId).toBe("ticket-1"); // model-visible payload unchanged
      expect(payload._card).toMatchObject({
        ticketId: "ticket-1",
        subject: "Server offline",
        status: "Open",
        client: "Acme Corp",
        noteDefaults: { isPublic: false },
      });
    });

    it("serves the tool result without a card when card building fails", async () => {
      // No subject → not a renderable ticket; the card is dropped best-effort.
      mockTicketsClient({ ticketId: "ticket-2", status: "Open" });

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_get", {
        ticketId: "ticket-2",
      });

      expect(result.isError).toBeUndefined();
      const payload = result.structuredContent as Record<string, unknown>;
      expect(payload.ticketId).toBe("ticket-2");
      expect(payload._card).toBeUndefined();
    });
  });

  describe("server capability declaration (SEP-1865)", () => {
    it("declares io.modelcontextprotocol/ui in the server capabilities", async () => {
      const { createMcpServer } = await import("./mcp-server.js");
      const server = createMcpServer();
      const caps = (
        server as unknown as {
          _capabilities: {
            extensions?: Record<string, { mimeTypes?: string[] }>;
          };
        }
      )._capabilities;
      expect(caps.extensions?.["io.modelcontextprotocol/ui"]).toBeDefined();
      expect(
        caps.extensions?.["io.modelcontextprotocol/ui"]?.mimeTypes
      ).toContain(MCP_APP_RESOURCE_MIME);
    });
  });
});
