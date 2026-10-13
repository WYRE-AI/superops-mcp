/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup refuses to listen when CONDUIT_S2S_SECRET is empty or a known
 * placeholder, unless MCP_ALLOW_INSECURE_DEV=1. That bypass binds 127.0.0.1
 * only. Gateway-mode /mcp requests without vendor credential headers are 401
 * and must not use SUPEROPS_* from process.env.
 */
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startHttpTransport } from "./index.js";

const S2S_SECRET = "test-s2s-fail-closed-secret-do-not-use-in-prod";
const ENV_TOKEN = "env-token-must-not-be-used";
const ENV_SUBDOMAIN = "env-subdomain-must-not-be-used";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "SUPEROPS_API_TOKEN",
  "SUPEROPS_SUBDOMAIN",
  "SUPEROPS_REGION",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  body: string;
}

async function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  return { status: response.status, body: await response.text() };
}

async function listen(): Promise<{ port: number; address: string; close: () => Promise<void> }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return {
    port: bound.port,
    address: bound.address,
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const statusCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "superops_status", arguments: {} },
});

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

function resetHttpEnv(): void {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.SUPEROPS_API_TOKEN;
  delete process.env.SUPEROPS_SUBDOMAIN;
  delete process.env.SUPEROPS_REGION;
}

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    resetHttpEnv();
    const logs = captureStderr();
    const exit = exitSpy();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    resetHttpEnv();
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const logs = captureStderr();
    const exit = exitSpy();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("Refusing to start HTTP transport");
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1", async () => {
    resetHttpEnv();
    delete process.env.MCP_HTTP_HOST;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    const exit = exitSpy();
    let close: (() => Promise<void>) | undefined;
    try {
      const server = await listen();
      close = server.close;
      expect(exit).not.toHaveBeenCalled();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).toContain("127.0.0.1");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
      await close?.();
    }
  });

  it.each(["replace-with-a-real-secret", "CHANGE-ME", "  Your-S2S-Secret  "])(
    "refuses known placeholder %j and does not log it",
    async (placeholder) => {
      resetHttpEnv();
      process.env.CONDUIT_S2S_SECRET = placeholder;
      const logs = captureStderr();
      const exit = exitSpy();
      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(exit).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain("known placeholder");
        expect(text).toContain("openssl rand -hex 32");
        expect(text).not.toContain(placeholder.trim());
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        exit.mockRestore();
        logs.restore();
      }
    }
  );

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1", async () => {
    resetHttpEnv();
    process.env.CONDUIT_S2S_SECRET = "placeholder";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const text = logs.text();
      expect(text).toContain("known placeholder");
      expect(text).not.toContain("SECURITY WARNING");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it.each(["0.0.0.0", "10.1.2.3"])(
    "refuses the dev bypass when MCP_HTTP_HOST is %s",
    async (host) => {
      resetHttpEnv();
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      const exit = exitSpy();

      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(exit).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain("Refusing to start HTTP transport");
        expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
        expect(text).toContain("only binds 127.0.0.1");
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        exit.mockRestore();
        logs.restore();
      }
    }
  );

  it("forces 127.0.0.1 when the dev bypass host is localhost", async () => {
    resetHttpEnv();
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;
    try {
      const server = await listen();
      close = server.close;
      expect(server.address).toBe("127.0.0.1");
      expect(logs.text()).toContain("SECURITY WARNING");
      expect(logs.text()).toContain("127.0.0.1");
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    resetHttpEnv();
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    const server = await listen();
    try {
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain("SECURITY WARNING");
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it("binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is set", async () => {
    resetHttpEnv();
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    try {
      expect(server.address).toBe("127.0.0.1");
    } finally {
      await server.close();
    }
  });
});

describe("HTTP /mcp authentication", () => {
  async function startGateway(): Promise<{ port: number; close: () => Promise<void> }> {
    resetHttpEnv();
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.SUPEROPS_API_TOKEN = ENV_TOKEN;
    process.env.SUPEROPS_SUBDOMAIN = ENV_SUBDOMAIN;
    process.env.SUPEROPS_REGION = "eu";
    const server = await listen();
    return server;
  }

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    const server = await startGateway();
    try {
      const missing = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-superops-api-token": "header-token",
          "x-superops-subdomain": "header-subdomain",
        }),
        body: statusCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader("wrong-secret"),
          "x-superops-api-token": "header-token",
          "x-superops-subdomain": "header-subdomain",
        }),
        body: statusCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain("X-Gateway-S2S");
      expect(invalid.body).toContain("X-Gateway-S2S");
      expect(missing.body).not.toContain(S2S_SECRET);
      expect(invalid.body).not.toContain(S2S_SECRET);
      expect(missing.body).not.toContain(ENV_TOKEN);
      expect(missing.body).not.toContain(ENV_SUBDOMAIN);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_TOKEN);
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await startGateway();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
        body: statusCall,
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain("Missing credentials");
      expect(response.body).toContain("X-SuperOps-API-Token");
      expect(response.body).toContain("X-SuperOps-Subdomain");
      expect(response.body).not.toContain(ENV_TOKEN);
      expect(response.body).not.toContain(ENV_SUBDOMAIN);
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain("eu");

      const partial = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-superops-api-token": "header-token",
        }),
        body: statusCall,
      });
      expect(partial.status).toBe(401);
      expect(partial.body).not.toContain(ENV_SUBDOMAIN);
    } finally {
      await server.close();
    }
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    const server = await startGateway();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-superops-api-token": "header-token",
          "x-superops-subdomain": "header-subdomain",
        }),
        body: statusCall,
      });

      expect(response.status).toBe(200);
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_TOKEN);
      expect(response.body).not.toContain(ENV_SUBDOMAIN);
      const payload = JSON.parse(response.body) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = payload.result?.content?.[0]?.text ?? "";
      expect(text).toContain("header-subdomain");
      expect(text).toContain("region: us");
      expect(text).not.toContain(ENV_SUBDOMAIN);
      expect(text).not.toContain("eu");
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_TOKEN);
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const server = await startGateway();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "GET",
        path: "/health",
      });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as {
        status?: string;
        authMode?: string;
        credentials?: unknown;
      };
      expect(body.status).toBe("ok");
      expect(body.authMode).toBe("gateway");
      expect(body.credentials).toBeUndefined();
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_TOKEN);
      expect(response.body).not.toContain(ENV_SUBDOMAIN);
    } finally {
      await server.close();
    }
  });
});
