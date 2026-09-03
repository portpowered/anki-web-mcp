const sensitiveKeys = new Set([
  "originTrialToken",
  "front_text",
  "back_text",
  "frontText",
  "backText",
  "frontHtml",
  "backHtml",
  "css",
  "content",
]);

/** Produce JSON-safe runtime evidence without token or reusable card content. */
export function sanitizeWebMcpEvidence(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return [...new Set(secrets.filter((secret) => secret.length > 0))]
      .sort((left, right) => right.length - left.length)
      .reduce(
        (sanitized, secret) => sanitized.split(secret).join("[redacted-secret]"),
        value,
      );
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeWebMcpEvidence(item, secrets));
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    sensitiveKeys.has(key) ? `[redacted-${key}]` : sanitizeWebMcpEvidence(entry, secrets),
  ]));
}
