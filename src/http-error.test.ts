import { describe, expect, it } from "vitest";
import { formatHttpError, scrubSecrets, truncate } from "./http-error.js";

describe("error sanitization", () => {
  it.each([
    "authorization", "api_key", "apiKey", "token", "secret", "password",
    "access_token", "X-SuperOps-API-Token", "SUPEROPS_API_TOKEN", "CustomerSubDomain",
  ])("scrubs %s in JSON and headers", (key) => {
    expect(scrubSecrets(JSON.stringify({ [key]: 'fictional secret "with quotes"' })))
      .not.toContain("fictional");
    expect(scrubSecrets(`${key}: fictional secret\nreason: denied`))
      .toBe(`${key}: [REDACTED]\nreason: denied`);
  });

  it("scrubs fields inside escaped GraphQL message strings", () => {
    const body = JSON.stringify({ errors: [{ message: 'Denied apiKey="fictional-nested-secret"' }] });
    expect(formatHttpError(400, "Bad Request", body)).not.toContain("fictional-nested-secret");
  });

  it("scrubs standalone Bearer tokens and JWTs", () => {
    expect(scrubSecrets("Denied Bearer fictional-token and eyJfictional.payload.signature"))
      .toBe("Denied Bearer [REDACTED] and [REDACTED]");
  });

  it("scrubs before cutting through a secret", () => {
    const body = "x".repeat(480) + ' password="' + "s".repeat(1000) + '"';
    expect(formatHttpError(400, "Bad Request", body)).not.toContain("sss");
    expect(truncate("x".repeat(600))).toHaveLength(500);
  });
});
