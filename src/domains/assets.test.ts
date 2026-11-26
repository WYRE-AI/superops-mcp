/**
 * Assets Domain Tests
 *
 * Tests for asset (endpoint) management tools.
 *
 * These assert the *shape* of what we send SuperOps: page/pageSize offsets, the
 * `RuleConditionInput` filters built by utils/conditions, and JSON-scalar fields
 * selected bare. graphql-schema.test.ts separately validates the documents
 * against the real schema.
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
import { getAssetsTools } from "./assets.js";

const LIST_INFO = { page: 1, pageSize: 50, totalCount: 1, hasMore: false };

describe("Assets Domain", () => {
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

  describe("getAssetsTools", () => {
    it("returns tools array with expected tools", () => {
      const domain = getAssetsTools();
      expect(domain.tools).toHaveLength(4);
      expect(domain.tools.map((t) => t.name)).toEqual([
        "superops_assets_list",
        "superops_assets_get",
        "superops_assets_software",
        "superops_assets_patches",
      ]);
    });

    it("returns handleCall function", () => {
      const domain = getAssetsTools();
      expect(typeof domain.handleCall).toBe("function");
    });

    it("paginates every list tool with page/pageSize, never Relay cursors", () => {
      const domain = getAssetsTools();
      for (const name of [
        "superops_assets_list",
        "superops_assets_software",
        "superops_assets_patches",
      ]) {
        const props = domain.tools.find((t) => t.name === name)?.inputSchema.properties;
        expect(props, name).toHaveProperty("page");
        expect(props, name).toHaveProperty("pageSize");
        expect(props, name).not.toHaveProperty("max");
        expect(props, name).not.toHaveProperty("cursor");
      }
    });
  });

  describe("superops_assets_list tool", () => {
    it("has correct definition", () => {
      const domain = getAssetsTools();
      const tool = domain.tools.find((t) => t.name === "superops_assets_list");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("List assets");
      expect(tool?.inputSchema.properties).toHaveProperty("status");
      expect(tool?.inputSchema.properties).toHaveProperty("platform");
      expect(tool?.inputSchema.properties).toHaveProperty("clientId");
    });

    it("documents that several filters combine with AND", () => {
      const domain = getAssetsTools();
      const tool = domain.tools.find((t) => t.name === "superops_assets_list");

      expect(tool?.description).toContain("AND");
      expect(tool?.description).not.toContain("single filter condition");
      expect(tool?.description).not.toContain("at most one");
    });

    it("calls query with default pagination and sort", async () => {
      const mockResponse = {
        getAssetList: {
          assets: [{ assetId: "1", name: "DESKTOP-001", status: "ONLINE" }],
          listInfo: LIST_INFO,
        },
      };
      mockClient.query.mockResolvedValue(mockResponse);

      const domain = getAssetsTools();
      const result = await domain.handleCall("superops_assets_list", {});

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("getAssetList"),
        expect.objectContaining({
          input: {
            page: 1,
            pageSize: 50,
            sort: [{ attribute: "name", order: "ASC" }],
          },
        })
      );
      expect(result.content[0].text).toContain("DESKTOP-001");
    });

    it("applies status filter as a single includes condition", async () => {
      mockClient.query.mockResolvedValue({
        getAssetList: { assets: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      await domain.handleCall("superops_assets_list", { status: "ONLINE" });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: { attribute: "status", operator: "includes", value: ["ONLINE"] },
          }),
        })
      );
    });

    it("applies platform filter as a contains condition over a bare string", async () => {
      // SuperOps stores the whole OS name ("Microsoft Windows 10 Pro"), so `includes`
      // — which matches a value whole — finds nothing for a fragment like "Windows".
      mockClient.query.mockResolvedValue({
        getAssetList: { assets: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      await domain.handleCall("superops_assets_list", { platform: "Windows" });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: { attribute: "platform", operator: "contains", value: "Windows" },
          }),
        })
      );
    });

    it("applies clientId filter as a single includes condition", async () => {
      mockClient.query.mockResolvedValue({
        getAssetList: { assets: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      await domain.handleCall("superops_assets_list", { clientId: "client-123" });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: { attribute: "client", operator: "includes", value: ["client-123"] },
          }),
        })
      );
    });

    it("passes through an explicit page and caps pageSize at 100", async () => {
      mockClient.query.mockResolvedValue({
        getAssetList: { assets: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      await domain.handleCall("superops_assets_list", { page: 3, pageSize: 1000 });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({ page: 3, pageSize: 100 }),
        })
      );
    });

    it("combines several filters into one AND compound", async () => {
      mockClient.query.mockResolvedValue({
        getAssetList: { assets: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      const result = await domain.handleCall("superops_assets_list", {
        status: "ONLINE",
        platform: "Windows",
        clientId: "client-123",
      });

      expect(result.isError).toBeUndefined();
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            condition: {
              joinOperator: "AND",
              operands: [
                { attribute: "status", operator: "includes", value: ["ONLINE"] },
                { attribute: "platform", operator: "contains", value: "Windows" },
                { attribute: "client", operator: "includes", value: ["client-123"] },
              ],
            },
          }),
        })
      );
    });

    it("sends a lone filter bare, not wrapped in a one-operand compound", async () => {
      mockClient.query.mockResolvedValue({
        getAssetList: { assets: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      await domain.handleCall("superops_assets_list", { status: "ONLINE" });

      const condition = (
        mockClient.query.mock.calls[0][1] as { input: { condition: Record<string, unknown> } }
      ).input.condition;

      expect(condition).not.toHaveProperty("joinOperator");
      expect(condition).not.toHaveProperty("operands");
      expect(condition).toEqual({
        attribute: "status",
        operator: "includes",
        value: ["ONLINE"],
      });
    });
  });

  describe("superops_assets_get tool", () => {
    it("has correct definition", () => {
      const domain = getAssetsTools();
      const tool = domain.tools.find((t) => t.name === "superops_assets_get");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("detailed information");
      expect(tool?.inputSchema.properties).toHaveProperty("assetId");
      expect(tool?.inputSchema.required).toContain("assetId");
    });

    it("is honest that CPU/memory/disk are not on the asset record", () => {
      const domain = getAssetsTools();
      const tool = domain.tools.find((t) => t.name === "superops_assets_get");

      expect(tool?.description).toContain("does not expose CPU, memory or disk");
      expect(tool?.description).toContain("getAssetSummary");
    });

    it("calls query with assetId", async () => {
      const mockResponse = {
        getAsset: {
          assetId: "asset-123",
          name: "WORKSTATION-001",
          status: "ONLINE",
          platform: "Microsoft Windows 10 Pro",
          platformVersion: "10.0.19043 Build 19043",
        },
      };
      mockClient.query.mockResolvedValue(mockResponse);

      const domain = getAssetsTools();
      const result = await domain.handleCall("superops_assets_get", {
        assetId: "asset-123",
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("getAsset"),
        expect.objectContaining({
          input: { assetId: "asset-123" },
        })
      );
      expect(result.content[0].text).toContain("WORKSTATION-001");
      expect(result.content[0].text).toContain("10.0.19043 Build 19043");
    });
  });

  describe("superops_assets_software tool", () => {
    it("has correct definition", () => {
      const domain = getAssetsTools();
      const tool = domain.tools.find((t) => t.name === "superops_assets_software");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("software inventory");
      expect(tool?.inputSchema.properties).toHaveProperty("assetId");
      expect(tool?.inputSchema.properties).toHaveProperty("search");
      expect(tool?.inputSchema.required).toContain("assetId");
    });

    it("nests pagination under input.listInfo alongside assetId", async () => {
      const mockResponse = {
        getAssetSoftwareList: {
          assetSoftwares: [
            { id: "sw-1", software: { name: "Microsoft Office" }, version: "365" },
          ],
          listInfo: LIST_INFO,
        },
      };
      mockClient.query.mockResolvedValue(mockResponse);

      const domain = getAssetsTools();
      const result = await domain.handleCall("superops_assets_software", {
        assetId: "asset-123",
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("getAssetSoftwareList"),
        {
          input: {
            assetId: "asset-123",
            listInfo: { page: 1, pageSize: 50 },
          },
        }
      );
      expect(result.content[0].text).toContain("Microsoft Office");
    });

    it("searches the software.name path, not the bare JSON column", async () => {
      // `software` is a JSON object. Filtering the bare column matches nothing and
      // returns an empty list rather than an error, so the wrong path fails silently.
      mockClient.query.mockResolvedValue({
        getAssetSoftwareList: { assetSoftwares: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      await domain.handleCall("superops_assets_software", {
        assetId: "asset-123",
        search: "chrome",
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            assetId: "asset-123",
            listInfo: expect.objectContaining({
              condition: { attribute: "software.name", operator: "contains", value: "chrome" },
            }),
          }),
        })
      );
    });

    it("caps pageSize at 100", async () => {
      mockClient.query.mockResolvedValue({
        getAssetSoftwareList: { assetSoftwares: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      await domain.handleCall("superops_assets_software", {
        assetId: "asset-123",
        pageSize: 1000,
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            listInfo: expect.objectContaining({ pageSize: 100 }),
          }),
        })
      );
    });
  });

  describe("superops_assets_patches tool", () => {
    it("has correct definition", () => {
      const domain = getAssetsTools();
      const tool = domain.tools.find((t) => t.name === "superops_assets_patches");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("patch status");
      expect(tool?.inputSchema.properties).toHaveProperty("assetId");
      expect(tool?.inputSchema.properties).toHaveProperty("installationStatus");
      expect(tool?.inputSchema.properties).toHaveProperty("severity");
      expect(tool?.inputSchema.required).toContain("assetId");
    });

    it("nests pagination under input.listInfo alongside assetId", async () => {
      const mockResponse = {
        getAssetPatchDetails: {
          assetPatches: [
            {
              patchDetail: { patchId: "patch-1", title: "Security Update", severity: "Others" },
              installationStatus: "NewOrMissing",
            },
          ],
          listInfo: LIST_INFO,
        },
      };
      mockClient.query.mockResolvedValue(mockResponse);

      const domain = getAssetsTools();
      const result = await domain.handleCall("superops_assets_patches", {
        assetId: "asset-123",
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("getAssetPatchDetails"),
        {
          input: {
            assetId: "asset-123",
            listInfo: { page: 1, pageSize: 50 },
          },
        }
      );
      expect(result.content[0].text).toContain("Security Update");
    });

    it("applies installationStatus as a single includes condition", async () => {
      mockClient.query.mockResolvedValue({
        getAssetPatchDetails: { assetPatches: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      await domain.handleCall("superops_assets_patches", {
        assetId: "asset-123",
        installationStatus: "NewOrMissing",
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            listInfo: expect.objectContaining({
              condition: {
                attribute: "installationStatus",
                operator: "includes",
                value: ["NewOrMissing"],
              },
            }),
          }),
        })
      );
    });

    it("applies severity as a single includes condition over the array", async () => {
      mockClient.query.mockResolvedValue({
        getAssetPatchDetails: { assetPatches: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      await domain.handleCall("superops_assets_patches", {
        assetId: "asset-123",
        severity: ["Others", "Recommended"],
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            listInfo: expect.objectContaining({
              condition: {
                attribute: "severity",
                operator: "includes",
                value: ["Others", "Recommended"],
              },
            }),
          }),
        })
      );
    });

    it("combines installationStatus and severity into one AND compound", async () => {
      mockClient.query.mockResolvedValue({
        getAssetPatchDetails: { assetPatches: [], listInfo: LIST_INFO },
      });

      const domain = getAssetsTools();
      const result = await domain.handleCall("superops_assets_patches", {
        assetId: "asset-123",
        installationStatus: "Installed",
        severity: ["Others"],
      });

      expect(result.isError).toBeUndefined();
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            listInfo: expect.objectContaining({
              condition: {
                joinOperator: "AND",
                operands: [
                  {
                    attribute: "installationStatus",
                    operator: "includes",
                    value: ["Installed"],
                  },
                  { attribute: "severity", operator: "includes", value: ["Others"] },
                ],
              },
            }),
          }),
        })
      );
    });
  });

  describe("Error handling", () => {
    it.each([
      "superops_assets_list",
      "superops_assets_get",
      "superops_assets_software",
      "superops_assets_patches",
    ])("returns a readable tool error when the result field is missing for %s", async (tool) => {
      mockClient.query.mockResolvedValue({ unrelated: "fixture-body-marker" });
      const result = await getAssetsTools().handleCall(tool, { assetId: "fixture-id" });
      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "SuperOps omitted the requested asset result." }],
      });
    });

    it("preserves an explicit null asset lookup", async () => {
      mockClient.query.mockResolvedValue({ getAsset: null });
      const result = await getAssetsTools().handleCall("superops_assets_get", { assetId: "fixture-id" });
      expect(result).toEqual({ content: [{ type: "text", text: "null" }] });
    });

    it("returns error for unknown tool", async () => {
      const domain = getAssetsTools();
      const result = await domain.handleCall("unknown_tool", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown assets tool");
    });

    it("handles API errors gracefully", async () => {
      mockClient.query.mockRejectedValue(new Error("Asset not found"));

      const domain = getAssetsTools();
      const result = await domain.handleCall("superops_assets_get", {
        assetId: "nonexistent",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error: Asset not found");
    });

    it("handles non-Error exceptions", async () => {
      mockClient.query.mockRejectedValue({ message: "Unknown error" });

      const domain = getAssetsTools();
      const result = await domain.handleCall("superops_assets_list", {});

      expect(result.isError).toBe(true);
    });
  });

  describe("GraphQL query structure", () => {
    async function queryFor(tool: string, args: Record<string, unknown>): Promise<string> {
      mockClient.query.mockResolvedValue({});
      await getAssetsTools().handleCall(tool, args);
      return mockClient.query.mock.calls[0][0] as string;
    }

    it("LIST_ASSETS_QUERY selects real Asset fields and offset listInfo", async () => {
      const query = await queryFor("superops_assets_list", {});

      expect(query).toContain("assetId");
      expect(query).toContain("hostName");
      expect(query).toContain("platform");
      expect(query).toContain("primaryMac");
      expect(query).toContain("publicIp");
      expect(query).toContain("lastCommunicatedTime");
      expect(query).toMatch(/listInfo\s*\{\s*page\s+pageSize\s+totalCount\s+hasMore\s*\}/);
    });

    it("LIST_ASSETS_QUERY selects patchStatus bare — it is a String, not an object", async () => {
      const query = await queryFor("superops_assets_list", {});

      expect(query).toContain("patchStatus");
      expect(query).not.toMatch(/patchStatus\s*\{/);
    });

    it("LIST_ASSETS_QUERY selects JSON scalars bare", async () => {
      const query = await queryFor("superops_assets_list", {});

      expect(query).toContain("client");
      expect(query).toContain("site");
      expect(query).not.toMatch(/client\s*\{/);
      expect(query).not.toMatch(/site\s*\{/);
    });

    it("GET_ASSET_QUERY selects hardware and platform fields SuperOps actually has", async () => {
      const query = await queryFor("superops_assets_get", { assetId: "1" });

      expect(query).toContain("manufacturer");
      expect(query).toContain("model");
      expect(query).toContain("serialNumber");
      expect(query).toContain("platformFamily");
      expect(query).toContain("platformVersion");
      expect(query).toContain("sysUptime");
      expect(query).toContain("agentVersion");
    });

    it("GET_ASSET_QUERY drops the fields SuperOps does not define", async () => {
      const query = await queryFor("superops_assets_get", { assetId: "1" });

      for (const invented of [
        "lastSeen",
        "ipAddress",
        "macAddress",
        "osName",
        "osVersion",
        "osBuild",
        "architecture",
        "processorName",
        "processorCores",
        "totalMemory",
        "totalDiskSpace",
        "freeDiskSpace",
        "tags",
        "hostname",
      ]) {
        expect(query, `${invented} is not a SuperOps Asset field`).not.toContain(invented);
      }
    });

    it("GET_ASSET_QUERY selects JSON scalars bare", async () => {
      const query = await queryFor("superops_assets_get", { assetId: "1" });

      for (const scalar of [
        "client",
        "site",
        "requester",
        "assetClass",
        "deviceCategory",
        "customFields",
      ]) {
        expect(query).toContain(scalar);
        expect(query).not.toMatch(new RegExp(`${scalar}\\s*\\{`));
      }
    });

    it("GET_ASSET_SOFTWARE_QUERY selects assetSoftwares with a bare software scalar", async () => {
      const query = await queryFor("superops_assets_software", { assetId: "1" });

      expect(query).toContain("assetSoftwares");
      expect(query).toContain("installedDate");
      expect(query).toContain("installedPath");
      expect(query).not.toMatch(/software\s*\{/);
      expect(query).toContain("$input: AssetDetailsListInput!");
    });

    it("GET_ASSET_PATCHES_QUERY selects assetPatches with a patchDetail subselection", async () => {
      const query = await queryFor("superops_assets_patches", { assetId: "1" });

      expect(query).toContain("assetPatches");
      expect(query).toMatch(/patchDetail\s*\{/);
      expect(query).toContain("kbNumbers");
      expect(query).toContain("approvalStatus");
      expect(query).toContain("installationStatus");
      expect(query).not.toContain("summary");
      expect(query).toContain("$input: AssetDetailsListInput!");
    });

    it("no query uses Relay-style cursor pagination", async () => {
      const cases: [string, Record<string, unknown>][] = [
        ["superops_assets_list", {}],
        ["superops_assets_get", { assetId: "1" }],
        ["superops_assets_software", { assetId: "1" }],
        ["superops_assets_patches", { assetId: "1" }],
      ];

      for (const [tool, args] of cases) {
        const query = await queryFor(tool, args);
        expect(query, tool).not.toContain("hasNextPage");
        expect(query, tool).not.toContain("endCursor");
        vi.clearAllMocks();
      }
    });
  });

  describe("Advertised filter values", () => {
    /**
     * The schema types every one of these as `String`, not an enum, so the
     * allowed values are tenant data. Advertising a guessed `enum` would make
     * the MCP client reject values SuperOps accepts — the exact failure the
     * clients domain shipped when it claimed a Lead/Prospect/Customer/Churned
     * stage against a tenant using Active/Inactive/Prospect.
     */
    // Tool, field, and the values seen on a live tenant — recorded so a caller
    // has something to go on without the schema pretending the set is closed.
    const VALUE_FIELDS: [string, string, string[]][] = [
      ["superops_assets_list", "status", ["ONLINE", "OFFLINE"]],
      ["superops_assets_list", "platform", ["Microsoft Windows 10 Pro", "darwin"]],
      ["superops_assets_patches", "installationStatus", ["Installed", "NewOrMissing"]],
      ["superops_assets_patches", "severity", ["Others", "Recommended"]],
    ];

    it.each(VALUE_FIELDS)("%s.%s advertises no enum", (toolName, field) => {
      const tool = getAssetsTools().tools.find((t) => t.name === toolName);
      const prop = (tool?.inputSchema.properties as Record<string, Record<string, unknown>>)[
        field
      ];

      expect(prop, `${toolName}.${field}`).toBeDefined();
      expect(prop, `${toolName}.${field}`).not.toHaveProperty("enum");
      expect(prop.items ?? {}, `${toolName}.${field} items`).not.toHaveProperty("enum");
    });

    it.each(VALUE_FIELDS)(
      "%s.%s documents the values observed live",
      (toolName, field, observed) => {
        const tool = getAssetsTools().tools.find((t) => t.name === toolName);
        const prop = (tool?.inputSchema.properties as Record<string, { description?: string }>)[
          field
        ];

        for (const value of observed) {
          expect(prop.description, `${toolName}.${field}`).toContain(value);
        }
      }
    );

    it("does not describe patch severity in Windows CVSS terms it never returns", () => {
      const tool = getAssetsTools().tools.find((t) => t.name === "superops_assets_patches");
      const severity = (
        tool?.inputSchema.properties as Record<string, { description?: string }>
      ).severity;

      for (const invented of ["Critical", "Important", "Moderate", "Low"]) {
        expect(severity.description, invented).not.toContain(invented);
      }
    });

    it("warns that hasMore is null rather than false at the end of a list", () => {
      // Live: hasMore is true with a further page and null without one — a caller
      // testing `hasMore === false` would loop forever.
      const tool = getAssetsTools().tools.find((t) => t.name === "superops_assets_list");
      expect(tool?.description).toContain("hasMore");
      expect(tool?.description).toContain("null");
      expect(tool?.description).toContain("totalCount");
    });
  });
});
