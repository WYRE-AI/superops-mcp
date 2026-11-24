import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";
import { runWithCredentials } from "./client.js";

describe("tool failure stdout logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["superops_custom_query", "superops_test_connection"])("logs one safe JSON line for %s", async (tool) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(
      "Vendor unavailable fictional-credential fictional-tenant Bearer fictional-bearer apiKey=fictional-secret"
    )));
    const server = createMcpServer();
    const client = new Client({ name: "fictional-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await runWithCredentials({ apiToken: "fictional-credential", subdomain: "fictional-tenant" }, () =>
        client.callTool({ name: tool, arguments: { query: "query { example }", privateData: "fictional-argument" } })
      );
      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0][0] as string;
      expect(JSON.parse(line)).toMatchObject({
        level: "error", message: "Tool execution failed", tool,
        error: expect.stringContaining("Vendor unavailable"),
      });
      for (const secret of ["fictional-credential", "fictional-tenant", "fictional-bearer", "fictional-secret", "fictional-argument"]) {
        expect(line).not.toContain(secret);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
