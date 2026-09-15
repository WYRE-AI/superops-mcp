/**
 * Tickets Domain Tests
 *
 * Tests for service ticket management tools.
 *
 * The GraphQL documents themselves are validated against the vendored schema
 * by graphql-schema.test.ts; these tests cover the request shapes the handlers
 * build — page/pageSize pagination, the filter conditions, the JSON-scalar
 * identifier inputs, and the note/worklog mutations that replaced the invented
 * addTicketNote/addTicketTimeEntry pair.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the client module
vi.mock("../client.js", () => ({
  getClient: vi.fn(() => ({
    query: vi.fn(),
    mutate: vi.fn(),
  })),
}));

import { getClient } from "../client.js";
import { getTicketsTools } from "./tickets.js";

describe("Tickets Domain", () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      mutate: vi.fn(),
    };
    vi.mocked(getClient).mockReturnValue(mockClient as unknown as ReturnType<typeof getClient>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getTicketsTools", () => {
    it("returns tools array with expected tools", () => {
      const domain = getTicketsTools();
      expect(domain.tools).toHaveLength(6);
      expect(domain.tools.map((t) => t.name)).toEqual([
        "superops_tickets_list",
        "superops_tickets_get",
        "superops_tickets_create",
        "superops_tickets_update",
        "superops_tickets_add_note",
        "superops_tickets_log_time",
      ]);
    });

    it("returns handleCall function", () => {
      const domain = getTicketsTools();
      expect(typeof domain.handleCall).toBe("function");
    });
  });

  describe("superops_tickets_list tool", () => {
    const emptyList = {
      getTicketList: {
        tickets: [],
        listInfo: { page: 1, pageSize: 50, totalCount: 0, hasMore: false },
      },
    };

    it("has correct definition", () => {
      const domain = getTicketsTools();
      const tool = domain.tools.find((t) => t.name === "superops_tickets_list");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("List tickets");
      expect(tool?.inputSchema.properties).toHaveProperty("status");
      expect(tool?.inputSchema.properties).toHaveProperty("priority");
      expect(tool?.inputSchema.properties).toHaveProperty("clientId");
      expect(tool?.inputSchema.properties).toHaveProperty("technicianId");
      expect(tool?.inputSchema.properties).toHaveProperty("page");
      expect(tool?.inputSchema.properties).toHaveProperty("pageSize");
    });

    it("does not advertise the removed Relay/assignee parameters", () => {
      const domain = getTicketsTools();
      const tool = domain.tools.find((t) => t.name === "superops_tickets_list");

      expect(tool?.inputSchema.properties).not.toHaveProperty("max");
      expect(tool?.inputSchema.properties).not.toHaveProperty("cursor");
      expect(tool?.inputSchema.properties).not.toHaveProperty("assigneeId");
      expect(tool?.inputSchema.properties).not.toHaveProperty("unassigned");
    });

    it("calls query with page/pageSize defaults and a sort clause", async () => {
      mockClient.query.mockResolvedValue({
        getTicketList: {
          tickets: [{ ticketId: "1", displayId: "#1", subject: "Test Ticket" }],
          listInfo: { page: 1, pageSize: 50, totalCount: 1, hasMore: false },
        },
      });

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_list", {});

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("getTicketList"),
        expect.objectContaining({
          input: {
            page: 1,
            pageSize: 50,
            sort: [{ attribute: "createdTime", order: "DESC" }],
          },
        })
      );
      expect(result.content[0].text).toContain("Test Ticket");
    });

    it("selects only fields the schema defines on Ticket", async () => {
      mockClient.query.mockResolvedValue(emptyList);

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_list", {});

      const [document] = mockClient.query.mock.calls[0] as [string];
      expect(document).toContain("displayId");
      expect(document).toContain("updatedTime");
      expect(document).toContain("technician");
      expect(document).not.toContain("ticketNumber");
      expect(document).not.toContain("lastUpdatedTime");
      expect(document).not.toContain("assignee");
      // page/pageSize offsets, not Relay cursors
      expect(document).toContain("hasMore");
      expect(document).not.toContain("hasNextPage");
      expect(document).not.toContain("endCursor");
    });

    /**
     * Live behaviour: getTicketList returns an EMPTY `tickets` array — with a
     * correct, filter-aware totalCount and no error — whenever `ticketId` is
     * missing from the selection set. Dropping it would silently break every
     * list call, and schema validation would not notice.
     */
    it("selects ticketId, without which the API returns no rows", async () => {
      mockClient.query.mockResolvedValue(emptyList);

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_list", {});

      const [document] = mockClient.query.mock.calls[0] as [string];
      expect(document).toMatch(/\bticketId\b/);
    });

    it("applies status as an includes condition", async () => {
      mockClient.query.mockResolvedValue(emptyList);

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_list", {
        status: ["Open", "On Hold"],
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: {
              attribute: "status",
              operator: "includes",
              value: ["Open", "On Hold"],
            },
          }),
        })
      );
    });

    it("applies priority as an includes condition", async () => {
      mockClient.query.mockResolvedValue(emptyList);

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_list", {
        priority: ["High", "Critical"],
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: {
              attribute: "priority",
              operator: "includes",
              value: ["High", "Critical"],
            },
          }),
        })
      );
    });

    it("applies clientId as an includes condition", async () => {
      mockClient.query.mockResolvedValue(emptyList);

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_list", { clientId: "client-123" });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: {
              attribute: "client",
              operator: "includes",
              value: ["client-123"],
            },
          }),
        })
      );
    });

    it("applies technicianId as an includes condition", async () => {
      mockClient.query.mockResolvedValue(emptyList);

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_list", { technicianId: "tech-456" });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: {
              attribute: "technician",
              operator: "includes",
              value: ["tech-456"],
            },
          }),
        })
      );
    });

    /**
     * RuleConditionInput is recursive, so every filter is applied rather than
     * one winning by precedence and the rest being silently discarded.
     */
    it("combines every supplied filter under a single AND", async () => {
      mockClient.query.mockResolvedValue(emptyList);

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_list", {
        status: ["Open"],
        priority: ["High"],
        clientId: "client-123",
        technicianId: "tech-456",
      });

      const [, variables] = mockClient.query.mock.calls[0] as [
        string,
        { input: { condition?: unknown } },
      ];
      expect(variables.input.condition).toEqual({
        joinOperator: "AND",
        operands: [
          { attribute: "status", operator: "includes", value: ["Open"] },
          { attribute: "priority", operator: "includes", value: ["High"] },
          { attribute: "client", operator: "includes", value: ["client-123"] },
          { attribute: "technician", operator: "includes", value: ["tech-456"] },
        ],
      });
    });

    it("sends a bare leaf condition, not a join, for a single filter", async () => {
      mockClient.query.mockResolvedValue(emptyList);

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_list", { status: ["Open"] });

      const [, variables] = mockClient.query.mock.calls[0] as [
        string,
        { input: { condition?: Record<string, unknown> } },
      ];
      expect(variables.input.condition).toEqual({
        attribute: "status",
        operator: "includes",
        value: ["Open"],
      });
      expect(variables.input.condition).not.toHaveProperty("joinOperator");
      expect(variables.input.condition).not.toHaveProperty("operands");
    });

    it("clamps pageSize to the documented maximum", async () => {
      mockClient.query.mockResolvedValue(emptyList);

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_list", { page: 3, pageSize: 5000 });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({ page: 3, pageSize: 100 }),
        })
      );
    });
  });

  describe("superops_tickets_get tool", () => {
    it("has correct definition", () => {
      const domain = getTicketsTools();
      const tool = domain.tools.find((t) => t.name === "superops_tickets_get");

      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).toHaveProperty("ticketId");
      expect(tool?.inputSchema.required).toContain("ticketId");
    });

    it("calls query with ticketId", async () => {
      mockClient.query.mockResolvedValue({
        getTicket: {
          ticketId: "ticket-123",
          displayId: "#123",
          subject: "Test Issue",
          status: "Open",
        },
      });

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_get", {
        ticketId: "ticket-123",
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("getTicket"),
        expect.objectContaining({
          input: { ticketId: "ticket-123" },
        })
      );
      expect(result.content[0].text).toContain("Test Issue");
    });

    it("selects the fields the ticket card maps from", async () => {
      mockClient.query.mockResolvedValue({ getTicket: { ticketId: "t1" } });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_get", { ticketId: "t1" });

      const [document] = mockClient.query.mock.calls[0] as [string];
      for (const field of [
        "ticketId",
        "displayId",
        "subject",
        "status",
        "priority",
        "category",
        "createdTime",
        "updatedTime",
        "client",
        "site",
        "requester",
        "techGroup",
        "technician",
      ]) {
        expect(document).toContain(field);
      }
      // `description` is write-only on CreateTicketInput; Ticket has no such field.
      expect(document).not.toContain("description");
    });

    it("selects JSON scalars bare, with no subselection", async () => {
      mockClient.query.mockResolvedValue({ getTicket: { ticketId: "t1" } });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_get", { ticketId: "t1" });

      const [document] = mockClient.query.mock.calls[0] as [string];
      for (const scalar of [
        "client",
        "site",
        "requester",
        "techGroup",
        "technician",
        "sla",
        "customFields",
      ]) {
        expect(document).not.toMatch(new RegExp(`${scalar}\\s*\\{`));
      }
    });

    it("attaches an MCP Apps card payload", async () => {
      mockClient.query.mockResolvedValue({
        getTicket: {
          ticketId: "ticket-123",
          displayId: "#123",
          subject: "Printer offline",
          status: "Open",
        },
      });

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_get", {
        ticketId: "ticket-123",
      });

      const payload = result.structuredContent as {
        _card?: { ticketId?: string };
      };
      expect(payload._card?.ticketId).toBe("ticket-123");
    });
  });

  describe("superops_tickets_create tool", () => {
    it("has correct definition", () => {
      const domain = getTicketsTools();
      const tool = domain.tools.find((t) => t.name === "superops_tickets_create");

      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).toHaveProperty("subject");
      expect(tool?.inputSchema.properties).toHaveProperty("description");
      expect(tool?.inputSchema.properties).toHaveProperty("clientId");
      expect(tool?.inputSchema.properties).toHaveProperty("priority");
      expect(tool?.inputSchema.properties).toHaveProperty("source");
      expect(tool?.inputSchema.properties).toHaveProperty("requesterId");
      expect(tool?.inputSchema.properties).toHaveProperty("techGroupId");
      expect(tool?.inputSchema.properties).toHaveProperty("technicianId");
      expect(tool?.inputSchema.required).toContain("subject");
      expect(tool?.inputSchema.required).toContain("clientId");
    });

    /**
     * The advertised enum must match the live TicketSource enum exactly. It
     * previously stopped at INTEGRATION, which made the last four values
     * unreachable through this tool even though the API accepts them.
     */
    it("advertises every TicketSource value the API accepts", () => {
      const domain = getTicketsTools();
      const tool = domain.tools.find((t) => t.name === "superops_tickets_create");
      const source = tool?.inputSchema.properties?.source as { enum?: string[] };

      expect(source.enum).toEqual([
        "FORM",
        "AGENT",
        "EMAIL",
        "AI",
        "PHONE",
        "INTEGRATION",
        "SCHEDULE",
        "CONTRACT_REMINDER",
        "CONTRACT",
        "INSTANT_MESSAGING",
      ]);
    });

    it("calls mutate with required fields and a default source", async () => {
      mockClient.mutate.mockResolvedValue({
        createTicket: {
          ticketId: "new-ticket",
          displayId: "#001",
          subject: "New Issue",
        },
      });

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_create", {
        subject: "New Issue",
        clientId: "client-123",
      });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.stringContaining("createTicket"),
        expect.objectContaining({
          input: {
            subject: "New Issue",
            client: { accountId: "client-123" },
            source: "INTEGRATION",
          },
        })
      );
      expect(result.content[0].text).toContain("new-ticket");
    });

    it("honours an explicit source", async () => {
      mockClient.mutate.mockResolvedValue({ createTicket: { ticketId: "new-ticket" } });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_create", {
        subject: "Phoned in",
        clientId: "client-123",
        source: "PHONE",
      });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({ source: "PHONE" }),
        })
      );
    });

    it("maps optional fields to their identifier inputs", async () => {
      mockClient.mutate.mockResolvedValue({
        createTicket: { ticketId: "new-ticket", subject: "Issue" },
      });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_create", {
        subject: "Issue",
        clientId: "client-123",
        description: "Detailed description",
        priority: "High",
        siteId: "site-9",
        requesterId: "user-7",
        techGroupId: "group-4",
        technicianId: "tech-2",
        category: "Hardware",
        subcategory: "Printer",
      });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            description: "Detailed description",
            priority: "High",
            site: { id: "site-9" },
            requester: { userId: "user-7" },
            techGroup: { groupId: "group-4" },
            technician: { userId: "tech-2" },
            category: "Hardware",
            subcategory: "Printer",
          }),
        })
      );
    });

    it("passes priority through verbatim (it is a String, not an enum)", async () => {
      mockClient.mutate.mockResolvedValue({ createTicket: { ticketId: "new-ticket" } });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_create", {
        subject: "Issue",
        clientId: "client-123",
        priority: "Critical",
      });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({ priority: "Critical" }),
        })
      );
    });
  });

  describe("superops_tickets_update tool", () => {
    it("has correct definition", () => {
      const domain = getTicketsTools();
      const tool = domain.tools.find((t) => t.name === "superops_tickets_update");

      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).toHaveProperty("ticketId");
      expect(tool?.inputSchema.properties).toHaveProperty("status");
      expect(tool?.inputSchema.properties).toHaveProperty("priority");
      expect(tool?.inputSchema.properties).toHaveProperty("technicianId");
      expect(tool?.inputSchema.properties).toHaveProperty("techGroupId");
      expect(tool?.inputSchema.properties).toHaveProperty("resolutionCode");
      expect(tool?.inputSchema.properties).not.toHaveProperty("assigneeId");
      expect(tool?.inputSchema.required).toContain("ticketId");
    });

    it("calls mutate with ticketId only", async () => {
      mockClient.mutate.mockResolvedValue({
        updateTicket: { ticketId: "ticket-123", status: "Open" },
      });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_update", { ticketId: "ticket-123" });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.stringContaining("updateTicket"),
        expect.objectContaining({
          input: { ticketId: "ticket-123" },
        })
      );
    });

    it("includes update fields when provided", async () => {
      mockClient.mutate.mockResolvedValue({ updateTicket: { ticketId: "ticket-123" } });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_update", {
        ticketId: "ticket-123",
        status: "Resolved",
        priority: "Low",
        technicianId: "tech-456",
        techGroupId: "group-1",
        resolutionCode: "Fixed",
      });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: {
            ticketId: "ticket-123",
            status: "Resolved",
            priority: "Low",
            technician: { userId: "tech-456" },
            techGroup: { groupId: "group-1" },
            resolutionCode: "Fixed",
          },
        })
      );
    });
  });

  describe("superops_tickets_add_note tool", () => {
    it("has correct definition", () => {
      const domain = getTicketsTools();
      const tool = domain.tools.find((t) => t.name === "superops_tickets_add_note");

      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).toHaveProperty("ticketId");
      expect(tool?.inputSchema.properties).toHaveProperty("content");
      expect(tool?.inputSchema.properties).toHaveProperty("isPublic");
      expect(tool?.inputSchema.required).toContain("ticketId");
      expect(tool?.inputSchema.required).toContain("content");
    });

    it("adds a PRIVATE note by default", async () => {
      mockClient.mutate.mockResolvedValue({
        createNote: {
          noteId: "note-123",
          content: "Test note",
          addedOn: "2026-01-01T00:00:00Z",
          privacyType: "PRIVATE",
        },
      });

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_add_note", {
        ticketId: "ticket-123",
        content: "Test note",
      });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.stringContaining("createNote"),
        expect.objectContaining({
          input: {
            workItem: { workId: "ticket-123", module: "TICKET" },
            content: "Test note",
            privacyType: "PRIVATE",
          },
        })
      );
      expect(result.content[0].text).toContain("note-123");
    });

    /**
     * `createTicketNote` still exists on the live API, but it is deprecated
     * with `reason: "Use createNote"` — plain introspection hides it, and only
     * `fields(includeDeprecated: true)` reports it. Pin the supported mutation
     * this tool issues so it cannot drift back onto the deprecated one.
     */
    it("uses createNote, not the deprecated createTicketNote", async () => {
      mockClient.mutate.mockResolvedValue({ createNote: { noteId: "note-123" } });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_add_note", {
        ticketId: "ticket-123",
        content: "Test note",
      });

      const [document] = mockClient.mutate.mock.calls[0] as [string];
      expect(document).not.toContain("createTicketNote");
      expect(document).not.toContain("CreateTicketNoteInput");
      expect(document).toContain("CreateNoteInput!");
    });

    it("maps isPublic to the PUBLIC privacy type", async () => {
      mockClient.mutate.mockResolvedValue({
        createNote: { noteId: "note-123", privacyType: "PUBLIC" },
      });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_add_note", {
        ticketId: "ticket-123",
        content: "Public note",
        isPublic: true,
      });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({ privacyType: "PUBLIC" }),
        })
      );
    });

    it("never sends the invented isPublic field to the API", async () => {
      mockClient.mutate.mockResolvedValue({ createNote: { noteId: "note-123" } });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_add_note", {
        ticketId: "ticket-123",
        content: "Test note",
        isPublic: true,
      });

      const [, variables] = mockClient.mutate.mock.calls[0] as [
        string,
        { input: Record<string, unknown> },
      ];
      expect(variables.input).not.toHaveProperty("isPublic");
      expect(variables.input).not.toHaveProperty("ticketId");
    });
  });

  describe("superops_tickets_log_time tool", () => {
    it("has correct definition", () => {
      const domain = getTicketsTools();
      const tool = domain.tools.find((t) => t.name === "superops_tickets_log_time");

      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).toHaveProperty("ticketId");
      expect(tool?.inputSchema.properties).toHaveProperty("qty");
      expect(tool?.inputSchema.properties).toHaveProperty("billDateTime");
      expect(tool?.inputSchema.properties).toHaveProperty("notes");
      expect(tool?.inputSchema.properties).toHaveProperty("billable");
      expect(tool?.inputSchema.properties).toHaveProperty("afterHours");
      expect(tool?.inputSchema.properties).toHaveProperty("technicianId");
      expect(tool?.inputSchema.properties).not.toHaveProperty("duration");
      expect(tool?.inputSchema.properties).not.toHaveProperty("workType");
      expect(tool?.inputSchema.required).toContain("ticketId");
      expect(tool?.inputSchema.required).toContain("qty");
    });

    it("sends a list containing one worklog entry for the ticket", async () => {
      mockClient.mutate.mockResolvedValue({
        createWorklogEntries: [{ itemId: "time-123", qty: "0.5" }],
      });

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_log_time", {
        ticketId: "ticket-123",
        qty: "0.5",
      });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.stringContaining("createWorklogEntries"),
        expect.objectContaining({
          input: [
            expect.objectContaining({
              workItem: { workId: "ticket-123", module: "TICKET" },
              qty: "0.5",
              billable: true,
              afterHours: false,
            }),
          ],
        })
      );
      expect(result.content[0].text).toContain("time-123");
    });

    it("defaults billDateTime to now", async () => {
      mockClient.mutate.mockResolvedValue({ createWorklogEntries: [{ itemId: "time-123" }] });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_log_time", {
        ticketId: "ticket-123",
        qty: "1",
      });

      const [, variables] = mockClient.mutate.mock.calls[0] as [
        string,
        { input: { billDateTime: string }[] },
      ];
      expect(Number.isNaN(Date.parse(variables.input[0].billDateTime))).toBe(false);
    });

    it("includes optional fields when provided", async () => {
      mockClient.mutate.mockResolvedValue({ createWorklogEntries: [{ itemId: "time-123" }] });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_log_time", {
        ticketId: "ticket-123",
        qty: "1.5",
        billDateTime: "2026-01-02T10:00:00Z",
        notes: "Troubleshooting network issue",
        billable: false,
        afterHours: true,
        technicianId: "tech-456",
        serviceItemId: "item-9",
        unitPrice: "120",
      });

      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: [
            {
              workItem: { workId: "ticket-123", module: "TICKET" },
              qty: "1.5",
              billDateTime: "2026-01-02T10:00:00Z",
              billable: false,
              afterHours: true,
              notes: "Troubleshooting network issue",
              technician: { userId: "tech-456" },
              serviceItem: { itemId: "item-9" },
              unitPrice: "120",
            },
          ],
        })
      );
    });

    it("coerces a numeric qty to the String the schema requires", async () => {
      mockClient.mutate.mockResolvedValue({ createWorklogEntries: [{ itemId: "time-123" }] });

      const domain = getTicketsTools();
      await domain.handleCall("superops_tickets_log_time", {
        ticketId: "ticket-123",
        qty: 2,
      });

      const [, variables] = mockClient.mutate.mock.calls[0] as [
        string,
        { input: { qty: unknown }[] },
      ];
      expect(variables.input[0].qty).toBe("2");
    });
  });

  describe("Error handling", () => {
    it("returns error for unknown tool", async () => {
      const domain = getTicketsTools();
      const result = await domain.handleCall("unknown_tool", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tickets tool");
    });

    it("handles API errors gracefully", async () => {
      mockClient.query.mockRejectedValue(new Error("API rate limit exceeded"));

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_list", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error: API rate limit exceeded");
    });

    it("handles mutation errors gracefully", async () => {
      mockClient.mutate.mockRejectedValue(new Error("Validation failed"));

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_create", {
        subject: "Test",
        clientId: "123",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error: Validation failed");
    });
  });
});
