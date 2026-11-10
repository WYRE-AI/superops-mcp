/** Scrub before truncating so a cutoff cannot expose part of a credential. */
export function scrubSecrets(text: string, sensitiveValues: readonly string[] = []): string {
  let safe = text;
  for (const value of sensitiveValues) {
    if (value) safe = safe.split(value).join("[REDACTED]");
  }
  try {
    const parsed: unknown = JSON.parse(safe);
    if (parsed && typeof parsed === "object") {
      safe = JSON.stringify(parsed, (key, value: unknown) => {
        if (/authorization|api[_-]?key|token|secret|password|subdomain|headers/i.test(key)) {
          return "[REDACTED]";
        }
        return typeof value === "string" ? scrubText(value) : value;
      });
    }
  } catch {
    // Header dumps and other plain text are scrubbed below.
  }
  return scrubText(safe);
}

function scrubText(text: string): string {
  // Quoted values may contain spaces or escaped quotes. Unquoted header values
  // extend to the end of the line (including an Authorization scheme).
  const safe = text.replace(
    /((?:["']?)(?:authorization|api[_-]?key|token|secret|password|access_token|x-superops-api-token|superops_api_token|customersubdomain|subdomain|x-superops-subdomain)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}]+)/gi,
    "$1[REDACTED]"
  );
  return safe
    .replace(/\bBearer\s+[^\s"'<> ,;}]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_.-]+/g, "[REDACTED]");
}

export function truncate(text: string, limit = 500): string {
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

export function formatHttpError(
  status: number,
  statusText: string,
  body = "",
  sensitiveValues: readonly string[] = []
): string {
  const prefix = `HTTP error: ${status} ${statusText}`;
  let messages = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "errors" in parsed && Array.isArray(parsed.errors)) {
      messages = parsed.errors
        .filter((error): error is { message: string } =>
          !!error && typeof error === "object" && typeof error.message === "string")
        .map((error) => error.message)
        .join("; ");
    }
  } catch {
    // Plain text and malformed JSON still provide a useful body snippet.
  }
  return [
    scrubSecrets(prefix, sensitiveValues),
    messages && truncate(scrubSecrets(messages, sensitiveValues)),
    body && `Body: ${truncate(scrubSecrets(body, sensitiveValues))}`,
  ].filter(Boolean).join("; ");
}
