/**
 * SuperOps Client Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cleanCredential,
  getCredentials,
  resetClient,
  SuperOpsClient,
} from "./client.js";

describe("getCredentials", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetClient();
  });

  it("returns null when SUPEROPS_API_TOKEN is not set", () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "testcompany");

    const creds = getCredentials();
    expect(creds).toBeNull();
  });

  it("returns null when SUPEROPS_SUBDOMAIN is not set", () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "test-token");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "");

    const creds = getCredentials();
    expect(creds).toBeNull();
  });

  it("returns credentials when both are set", () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "test-token");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "testcompany");

    const creds = getCredentials();
    expect(creds).toEqual({
      apiToken: "test-token",
      subdomain: "testcompany",
      region: undefined,
    });
  });

  it("includes region when SUPEROPS_REGION is set", () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "test-token");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "testcompany");
    vi.stubEnv("SUPEROPS_REGION", "eu");

    const creds = getCredentials();
    expect(creds).toEqual({
      apiToken: "test-token",
      subdomain: "testcompany",
      region: "eu",
    });
  });
});

// Regression tests for issue #73: MCPB/DXT desktop bundles map env vars to
// ${user_config.X}. When the optional SUPEROPS_REGION field is left blank the
// host injects the literal, unresolved string "${user_config.superops_region}".
// That truthy value defeated the constructor's `?? "us"` default, so
// API_ENDPOINTS[region] returned undefined and every fetch(this.endpoint, ...)
// threw "Failed to parse URL" — breaking all tools out of the box. Sanitise the
// placeholder at ingress so the "us" default applies.
describe("issue #73: unresolved MCPB config placeholders", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetClient();
  });

  it("cleanCredential drops empty, whitespace, and ${...} placeholder values", () => {
    expect(cleanCredential(undefined)).toBeUndefined();
    expect(cleanCredential("")).toBeUndefined();
    expect(cleanCredential("   ")).toBeUndefined();
    expect(cleanCredential("${user_config.superops_region}")).toBeUndefined();
    expect(cleanCredential("  ${user_config.superops_region}  ")).toBeUndefined();
  });

  it("cleanCredential preserves and trims real values", () => {
    expect(cleanCredential("eu")).toBe("eu");
    expect(cleanCredential("  real-token  ")).toBe("real-token");
  });

  it("coerces a placeholder SUPEROPS_REGION to undefined so 'us' can default", () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "test-token");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "testcompany");
    vi.stubEnv("SUPEROPS_REGION", "${user_config.superops_region}");

    const creds = getCredentials();
    expect(creds).toEqual({
      apiToken: "test-token",
      subdomain: "testcompany",
      region: undefined,
    });
  });

  it("builds a client with the valid US endpoint (not undefined) from a placeholder region", async () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "test-token");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "testcompany");
    vi.stubEnv("SUPEROPS_REGION", "${user_config.superops_region}");

    const creds = getCredentials();
    expect(creds).not.toBeNull();

    let requestedUrl: string | undefined;
    const fetchMock = vi.fn(async (url: string | URL) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SuperOpsClient(creds!);
    // Before the fix this rejected with "Failed to parse URL" (endpoint undefined).
    await expect(client.query("{ __typename }")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrl).toBe("https://api.superops.ai/msp");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe("HTTP error details", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = new SuperOpsClient({ apiToken: "fictional-credential", subdomain: "fictional-tenant" });

  it("includes GraphQL reasons and caps long details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message: "some vendor reason" }, { message: "x".repeat(3000) }],
    }), { status: 400, statusText: "Bad Request" })));
    const error = await client.query<never>("query { example }").catch((error: Error) => error);
    expect(error.message).toContain("HTTP error: 400 Bad Request");
    expect(error.message).toContain("some vendor reason");
    expect(error.message.length).toBeLessThan(1100);
  });

  it("caps a long plain-text body at 500 characters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("vendor reason " + "x".repeat(3000), {
      status: 400, statusText: "Bad Request",
    })));
    const error = await client.query<never>("query { example }").catch((error: Error) => error);
    expect(error.message).toContain("Body: vendor reason");
    expect(error.message).toMatch(/\.\.\.$/);
    expect(error.message.length).toBeLessThan(550);
  });

  it("scrubs GraphQL messages, body fields and echoed credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message: "Denied Bearer fictional-bearer-value" }],
      apiKey: "super-secret-value",
      echo: "fictional-credential fictional-tenant",
    }), { status: 400 })));
    const error = await client.mutate<never>("mutation { example }").catch((error: Error) => error);
    for (const value of ["fictional-bearer-value", "super-secret-value", "fictional-credential", "fictional-tenant"]) {
      expect(error.message).not.toContain(value);
    }
  });

  it("preserves the status when reading the body fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400, statusText: "Bad Request",
      text: vi.fn().mockRejectedValue(new Error("stream unavailable")),
    }));
    await expect(client.query("query { example }")).rejects.toThrow("HTTP error: 400 Bad Request");
  });
});
