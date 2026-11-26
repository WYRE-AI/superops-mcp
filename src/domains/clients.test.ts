/**
 * Clients Domain Tests
 *
 * Tests for client (account) management tools.
 *
 * These assert the exact `ListInfoInput` shape SuperOps expects — page/pageSize
 * offsets and the recursive `RuleConditionInput` tree — plus the field
 * selections, so an invented field or a subselection on a JSON scalar cannot
 * creep back in.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the client module
vi.mock("../client.js", () => ({
  getClient: vi.fn(() => ({
    query: vi.fn(),
    mutate: vi.fn(),
  })),
}));

// Mock elicitation: null (client declined / unsupported) unless a test opts in.
vi.mock("../utils/elicitation.js", () => ({
  elicitText: vi.fn(async () => null),
}));

import { getClient } from "../client.js";
import { elicitText } from "../utils/elicitation.js";
import { getClientsTools } from "./clients.js";

/** Fields the real SuperOps `Client` type does not define. */
const INVENTED_CLIENT_FIELDS = [
  "phone",
  "website",
  "industry",
  "employeeCount",
  "annualRevenue",
  "address",
  "sites",
  "lastUpdatedTime",
];

/**
 * Real `Client` fields we deliberately do not select: the live tenant returns
 * null for both, so they cost bytes and buy nothing.
 */
const UNSELECTED_CLIENT_FIELDS = ["createdTime", "updatedTime"];

/**
 * Stage and status values published by `getAllFields(input: "CLIENT")` on the
 * live API. Filtering on anything outside these silently matches zero clients,
 * so a wrong enum here is a silent data-loss bug, not a loud one.
 */
const CLIENT_STAGES = ["Active", "Inactive", "Prospect"];
const CLIENT_STATUSES = ["Paid", "Unpaid", "New", "Negotiation", "Won", "Lost"];

/** JSON scalars — selecting a subfield on any of these is rejected by the API. */
const JSON_SCALAR_FIELDS = [
  "accountManager",
  "primaryContact",
  "secondaryContact",
  "hqSite",
  "technicianGroups",
  "customFields",
];

describe("Clients Domain", () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      mutate: vi.fn(),
    };
    vi.mocked(getClient).mockReturnValue(mockClient as unknown as ReturnType<typeof getClient>);
    vi.mocked(elicitText).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // `hasMore` is null rather than false on the last page — that is what the live
  // API returns, and the handlers pass listInfo through verbatim.
  const listResponse = (clients: unknown[] = []) => ({
    getClientList: {
      clients,
      listInfo: { page: 1, pageSize: 50, totalCount: clients.length, hasMore: null },
    },
  });

  describe("getClientsTools", () => {
    it("returns tools array with expected tools", () => {
      const domain = getClientsTools();
      expect(domain.tools).toHaveLength(8);
      expect(domain.tools.map((t) => t.name)).toEqual([
        "superops_clients_list",
        "superops_clients_get",
        "superops_clients_search",
        "superops_clients_list_users",
        "superops_clients_create_user",
        "superops_clients_update_user",
        "superops_clients_list_invoices",
        "superops_clients_get_invoice",
      ]);
    });

    it("returns handleCall function", () => {
      const domain = getClientsTools();
      expect(typeof domain.handleCall).toBe("function");
    });
  });

  describe("superops_clients_list tool", () => {
    it("has correct definition", () => {
      const domain = getClientsTools();
      const tool = domain.tools.find((t) => t.name === "superops_clients_list");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("List clients");
      expect(tool?.inputSchema.properties).toHaveProperty("status");
      expect(tool?.inputSchema.properties).toHaveProperty("stage");
      expect(tool?.inputSchema.properties).toHaveProperty("page");
      expect(tool?.inputSchema.properties).toHaveProperty("pageSize");
      // Relay-style pagination is gone for good.
      expect(tool?.inputSchema.properties).not.toHaveProperty("max");
      expect(tool?.inputSchema.properties).not.toHaveProperty("cursor");
      expect(tool?.inputSchema.properties.page).toMatchObject({ default: 1 });
      expect(tool?.inputSchema.properties.pageSize).toMatchObject({ default: 50 });
    });

    /** One property of the `superops_clients_list` input schema. */
    const listProperty = (property: string): Record<string, unknown> =>
      getClientsTools().tools.find((t) => t.name === "superops_clients_list")?.inputSchema
        .properties[property] as Record<string, unknown>;

    const describedFor = (property: string): string =>
      String(listProperty(property).description ?? "");

    it("documents stage and status without pinning them to a JSON Schema enum", () => {
      // Both are per-tenant lookup lists typed as plain String. An `enum` would
      // reject at the MCP boundary a value the tenant configured and the API
      // would have accepted; a wrong value only costs an empty result.
      expect(listProperty("stage")).not.toHaveProperty("enum");
      expect(listProperty("status")).not.toHaveProperty("enum");
    });

    it("documents the stage values the live API actually accepts", () => {
      for (const stage of CLIENT_STAGES) {
        expect(describedFor("stage")).toContain(stage);
      }
    });

    it("documents the status values the live API actually accepts", () => {
      for (const status of CLIENT_STATUSES) {
        expect(describedFor("status")).toContain(status);
      }
    });

    it("documents no stage value that belongs to no SuperOps stage", () => {
      // The pre-live guesses. Each silently matched zero clients.
      for (const bogus of ["Lead", "Customer", "Churned"]) {
        expect(describedFor("stage")).not.toContain(bogus);
      }
      // `Archived` was guessed for status; SuperOps has no such value.
      expect(describedFor("status")).not.toContain("Archived");
    });

    it("keeps stage and status vocabularies disjoint", () => {
      // `Active`/`Inactive` are stages. Offering one as a status was the
      // original bug and would filter nothing. The status description may name
      // a stage, but only as a status's parent ("... belong to stage Active").
      for (const stage of CLIENT_STAGES) {
        expect(describedFor("status")).not.toMatch(new RegExp(`(?<!stage )\\b${stage}\\b`, "i"));
      }
      for (const status of CLIENT_STATUSES) {
        expect(describedFor("stage")).not.toContain(status);
      }
    });

    it("records that a status is scoped to its parent stage", () => {
      expect(describedFor("status")).toContain("sub-state of stage");
      expect(describedFor("status")).toContain("matches nothing");
    });

    it("calls query with default page/pageSize and name sort", async () => {
      mockClient.query.mockResolvedValue(listResponse([{ accountId: "1", name: "Test Client" }]));

      const domain = getClientsTools();
      const result = await domain.handleCall("superops_clients_list", {});

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("getClientList"),
        {
          input: {
            page: 1,
            pageSize: 50,
            sort: [{ attribute: "name", order: "ASC" }],
          },
        }
      );
      expect(result.content[0].text).toContain("Test Client");
    });

    it("applies status filter as a single includes condition", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_list", { status: "Paid" });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: { attribute: "status", operator: "includes", value: ["Paid"] },
          }),
        })
      );
    });

    it("applies stage filter as a single includes condition", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_list", { stage: "Prospect" });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: { attribute: "stage", operator: "includes", value: ["Prospect"] },
          }),
        })
      );
    });

    it("combines stage and status under an AND when both are given", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_list", {
        status: "Paid",
        stage: "Active",
      });

      const input = mockClient.query.mock.calls[0][1].input;
      expect(input.condition).toEqual({
        joinOperator: "AND",
        operands: [
          { attribute: "stage", operator: "includes", value: ["Active"] },
          { attribute: "status", operator: "includes", value: ["Paid"] },
        ],
      });
    });

    it("does not wrap a lone clause in a pointless compound", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_list", { stage: "Active" });

      const condition = mockClient.query.mock.calls[0][1].input.condition;
      expect(condition).not.toHaveProperty("joinOperator");
      expect(condition).not.toHaveProperty("operands");
    });

    it("omits condition entirely when no filter is given", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_list", { page: 2 });

      expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("condition");
    });

    it("caps pageSize at 100 and floors it at 1", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_list", { pageSize: 1000 });
      expect(mockClient.query.mock.calls[0][1].input.pageSize).toBe(100);

      await domain.handleCall("superops_clients_list", { pageSize: 0 });
      expect(mockClient.query.mock.calls[1][1].input.pageSize).toBe(1);
    });

    it("passes the requested page through", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_list", { page: 3, pageSize: 25 });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({ page: 3, pageSize: 25 }),
        })
      );
    });

    it("elicits a search term when no filters are given and searches by name", async () => {
      vi.mocked(elicitText).mockResolvedValue("acme");
      mockClient.query.mockResolvedValue(listResponse([{ accountId: "1", name: "Acme Corp" }]));

      const domain = getClientsTools();
      const result = await domain.handleCall("superops_clients_list", {});

      expect(elicitText).toHaveBeenCalledOnce();
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("searchClients"),
        {
          input: {
            page: 1,
            pageSize: 50,
            condition: {
              joinOperator: "OR",
              operands: [
                { attribute: "name", operator: "contains", value: "acme" },
                { attribute: "emailDomains", operator: "contains", value: "acme" },
              ],
            },
            sort: [{ attribute: "name", order: "ASC" }],
          },
        }
      );
      expect(result.content[0].text).toContain("Acme Corp");
    });

    it("does not elicit when a filter is supplied", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_list", { status: "Paid" });

      expect(elicitText).not.toHaveBeenCalled();
    });

    it("does not elicit when paging beyond the first page", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_list", { page: 2 });

      expect(elicitText).not.toHaveBeenCalled();
    });
  });

  describe("superops_clients_get tool", () => {
    it("has correct definition", () => {
      const domain = getClientsTools();
      const tool = domain.tools.find((t) => t.name === "superops_clients_get");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("Get detailed information");
      expect(tool?.inputSchema.properties).toHaveProperty("accountId");
      expect(tool?.inputSchema.required).toContain("accountId");
    });

    it("calls query with accountId", async () => {
      const mockResponse = {
        getClient: {
          accountId: "acc-123",
          name: "Test Company",
          status: "Paid",
        },
      };
      mockClient.query.mockResolvedValue(mockResponse);

      const domain = getClientsTools();
      const result = await domain.handleCall("superops_clients_get", {
        accountId: "acc-123",
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("getClient"),
        expect.objectContaining({
          input: { accountId: "acc-123" },
        })
      );
      expect(result.content[0].text).toContain("Test Company");
    });
  });

  describe("superops_clients_search tool", () => {
    it("has correct definition", () => {
      const domain = getClientsTools();
      const tool = domain.tools.find((t) => t.name === "superops_clients_search");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("Search for clients");
      expect(tool?.inputSchema.properties).toHaveProperty("query");
      expect(tool?.inputSchema.properties).toHaveProperty("page");
      expect(tool?.inputSchema.properties).toHaveProperty("pageSize");
      expect(tool?.inputSchema.required).toContain("query");
    });

    it.each([{}, { query: "" }, { query: "   " }, { query: 42 }])(
      "rejects an unusable search term before querying SuperOps: %j",
      async (args) => {
        mockClient.query.mockResolvedValue(listResponse());
        const result = await getClientsTools().handleCall("superops_clients_search", args);
        expect(mockClient.query).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("query");
      }
    );

    it("matches the supplied term against the client name and email domains", async () => {
      mockClient.query.mockResolvedValue(listResponse([{ accountId: "1", name: "Acme Corp" }]));

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_search", { query: "acme" });

      expect(mockClient.query).toHaveBeenCalledWith(expect.any(String), {
        input: {
          page: 1,
          pageSize: 50,
          condition: {
            joinOperator: "OR",
            operands: [
              { attribute: "name", operator: "contains", value: "acme" },
              { attribute: "emailDomains", operator: "contains", value: "acme" },
            ],
          },
          sort: [{ attribute: "name", order: "ASC" }],
        },
      });
    });

    it("caps pageSize at 100", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_search", { query: "test", pageSize: 200 });

      expect(mockClient.query.mock.calls[0][1].input.pageSize).toBe(100);
    });

    it("passes the requested page through", async () => {
      mockClient.query.mockResolvedValue(listResponse());

      const domain = getClientsTools();
      await domain.handleCall("superops_clients_search", { query: "test", page: 4 });

      expect(mockClient.query.mock.calls[0][1].input.page).toBe(4);
    });
  });

  describe("Error handling", () => {
    it("returns error for unknown tool", async () => {
      const domain = getClientsTools();
      const result = await domain.handleCall("unknown_tool", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown clients tool");
    });

    it("handles API errors gracefully", async () => {
      mockClient.query.mockRejectedValue(new Error("API connection failed"));

      const domain = getClientsTools();
      const result = await domain.handleCall("superops_clients_list", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error: API connection failed");
    });

    it("handles non-Error exceptions", async () => {
      mockClient.query.mockRejectedValue("String error");

      const domain = getClientsTools();
      const result = await domain.handleCall("superops_clients_list", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error: String error");
    });
  });

  describe("GraphQL query structure", () => {
    const queryFor = async (tool: string, args: Record<string, unknown>): Promise<string> => {
      mockClient.query.mockResolvedValue(
        tool === "superops_clients_get" ? { getClient: {} } : listResponse()
      );
      await getClientsTools().handleCall(tool, args);
      return mockClient.query.mock.calls[0][0] as string;
    };

    it("LIST_CLIENTS_QUERY selects real Client fields and offset listInfo", async () => {
      const query = await queryFor("superops_clients_list", { status: "Paid" });

      for (const field of ["accountId", "name", "stage", "status", "emailDomains"]) {
        expect(query).toContain(field);
      }
      expect(query).toContain("page");
      expect(query).toContain("pageSize");
      expect(query).toContain("totalCount");
      expect(query).toContain("hasMore");
      expect(query).not.toContain("hasNextPage");
      expect(query).not.toContain("endCursor");
      expect(query).toContain("$input: ListInfoInput!");
    });

    it("GET_CLIENT_QUERY selects the full real Client field set", async () => {
      const query = await queryFor("superops_clients_get", { accountId: "1" });

      for (const field of [
        "accountId",
        "name",
        "stage",
        "status",
        "emailDomains",
        ...JSON_SCALAR_FIELDS,
      ]) {
        expect(query).toContain(field);
      }
      expect(query).toContain("$input: ClientIdentifierInput!");
    });

    const allTools: [string, Record<string, unknown>][] = [
      ["superops_clients_list", { status: "Paid" }],
      ["superops_clients_get", { accountId: "1" }],
      ["superops_clients_search", { query: "acme" }],
    ];

    it.each(allTools)("%s selects no field SuperOps does not define", async (tool, args) => {
      const query = await queryFor(tool, args);

      for (const field of INVENTED_CLIENT_FIELDS) {
        expect(query, `${tool} must not select ${field}`).not.toContain(field);
      }
    });

    it.each(allTools)("%s selects no always-null timestamp field", async (tool, args) => {
      const query = await queryFor(tool, args);

      for (const field of UNSELECTED_CLIENT_FIELDS) {
        expect(query, `${tool} must not select ${field}`).not.toContain(field);
      }
    });

    const jsonScalarTools: [string, Record<string, unknown>][] = [
      ["superops_clients_list", { status: "Paid" }],
      ["superops_clients_get", { accountId: "1" }],
    ];

    it.each(jsonScalarTools)("%s never subselects on a JSON scalar", async (tool, args) => {
      const query = await queryFor(tool, args);

      for (const field of JSON_SCALAR_FIELDS) {
        expect(query, `${tool} must select ${field} bare`).not.toMatch(
          new RegExp(`${field}\\s*\\{`)
        );
      }
    });
  });

  describe("job-depth tools (WYREAI-702)", () => {
    const text = (r: { content: { text: string }[] }) => r.content[0].text;

    it("lists client users with clientId and paging", async () => {
      mockClient.query.mockResolvedValue({
        getClientUserList: { userList: [], listInfo: { page: 2 } },
      });
      const result = await getClientsTools().handleCall("superops_clients_list_users", {
        clientId: "c1",
        page: 2,
      });
      expect(result.isError).toBeUndefined();
      const vars = mockClient.query.mock.calls[0][1] as {
        input: { clientId: string; listInfo: { page: number; pageSize: number } };
      };
      expect(vars.input.clientId).toBe("c1");
      expect(vars.input.listInfo).toEqual({ page: 2, pageSize: 50 });
    });

    it("creates a client user with identifier objects", async () => {
      mockClient.mutate.mockResolvedValue({ createClientUser: { userId: "u1" } });
      const result = await getClientsTools().handleCall("superops_clients_create_user", {
        firstName: "New",
        email: "new.user@example.com",
        roleId: "r1",
        clientId: "c1",
        siteId: "s1",
      });
      expect(result.isError).toBeUndefined();
      expect(text(result)).toContain("u1");
      expect(mockClient.mutate.mock.calls[0][1]).toEqual({
        input: {
          firstName: "New",
          email: "new.user@example.com",
          role: { roleId: "r1" },
          client: { accountId: "c1" },
          site: { id: "s1" },
        },
      });
    });

    it("rejects create_user without required fields", async () => {
      const result = await getClientsTools().handleCall("superops_clients_create_user", {
        firstName: "New",
      });
      expect(result.isError).toBe(true);
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });

    it("updates only the fields passed", async () => {
      mockClient.mutate.mockResolvedValue({ updateClientUser: { userId: "u1" } });
      await getClientsTools().handleCall("superops_clients_update_user", {
        userId: "u1",
        contactNumber: "555-0100",
      });
      expect(mockClient.mutate.mock.calls[0][1]).toEqual({
        input: { userId: "u1", contactNumber: "555-0100" },
      });
    });

    it("rejects update_user with no changes or no id", async () => {
      const a = await getClientsTools().handleCall("superops_clients_update_user", {
        userId: "u1",
      });
      const b = await getClientsTools().handleCall("superops_clients_update_user", {});
      expect(a.isError).toBe(true);
      expect(b.isError).toBe(true);
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });

    it("lists invoices with normalised paging", async () => {
      mockClient.query.mockResolvedValue({
        getInvoiceList: { invoices: [{ invoiceId: "i1" }], listInfo: { page: 1 } },
      });
      const result = await getClientsTools().handleCall("superops_clients_list_invoices", {
        pageSize: 500,
      });
      expect(text(result)).toContain("i1");
      expect(mockClient.query.mock.calls[0][1]).toEqual({
        input: { page: 1, pageSize: 100 },
      });
    });

    it("gets an invoice by id and requires the id", async () => {
      mockClient.query.mockResolvedValue({ getInvoice: { invoiceId: "i1" } });
      const ok = await getClientsTools().handleCall("superops_clients_get_invoice", {
        invoiceId: "i1",
      });
      expect(ok.isError).toBeUndefined();
      expect(mockClient.query.mock.calls[0][1]).toEqual({ input: { invoiceId: "i1" } });
      const bad = await getClientsTools().handleCall("superops_clients_get_invoice", {});
      expect(bad.isError).toBe(true);
    });
  });
});
