export const webMcpOracleUrl =
  "https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/";

export const webMcpOracleRepositoryUrl =
  "https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/demos/pizza-maker";

export const webMcpOracleExpectedBrowserVersion = "152.0.7977.65";
export const webMcpOracleExpectedOperatingSystem = "win32 10.0.26200 x64";
export const webMcpOracleExpectedBrowserName = "Google Chrome";
export const webMcpTestingFlag = "enable-webmcp-testing";
export const webMcpFeatureName = "WebMCP";
export const webMcpOracleToolName = "set_pizza_size";
export const webMcpOracleToolInput = { size: "Small" } as const;
export const webMcpOracleExpectedBefore = "Medium";
export const webMcpOracleExpectedAfter = "Small";
export const webMcpOracleExpectedResult = "Set pizza size to Small.";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WebMcpCapabilityKind = "available" | "unavailable" | "error";

export type SanitizedTool = {
  name: string;
  title: string | null;
  description: string | null;
  origin: string | null;
  inputSchema: JsonValue | null;
  annotations: JsonValue | null;
};

export type OracleFailureCode =
  | "browser-launch-failed"
  | "browser-version-mismatch"
  | "browser-os-mismatch"
  | "navigation-failed"
  | "polyfill-not-blocked"
  | "native-unavailable"
  | "capability-probe-failed"
  | "tool-discovery-failed"
  | "expected-tool-missing"
  | "invocation-failed"
  | "structured-result-mismatch"
  | "visible-state-mismatch"
  | "browser-errors";

export type OracleClassification = "oracle-passed" | "oracle-failed";
export type ControlClassification = "native-unavailable" | "control-failed";

export type OracleObservation = {
  actualBrowserVersion: string | null;
  expectedBrowserVersion: string;
  navigationStatus: number | null;
  polyfillBlocked: boolean;
  capability: WebMcpCapabilityKind;
  discovery: {
    status: "passed" | "failed" | "not-run";
    error: string | null;
  };
  discoveredTools: readonly SanitizedTool[];
  expectedToolFound: boolean;
  invocation: {
    status: "passed" | "failed" | "not-run";
    result: JsonValue | null;
    expectedResult: JsonValue;
    error: string | null;
  };
  visibleState: {
    before: string | null;
    after: string | null;
    expectedBefore: string;
    expectedAfter: string;
  };
  browserErrors: readonly string[];
};

export type OracleDecision = {
  classification: OracleClassification;
  failureCode: OracleFailureCode | null;
  downstream: "evaluable" | "not-evaluable";
};

/**
 * Convert a value returned by the browser into bounded JSON evidence. Tool
 * objects contain functions, Window references, and other host objects, so
 * callers must select fields before invoking this helper for a tool snapshot.
 */
export function toJsonValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return `[unserializable bigint]`;
    case "function":
    case "symbol":
      return `[unserializable ${typeof value}]`;
    default:
      break;
  }

  if (depth >= 6) {
    return "[truncated]";
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, depth + 1, seen));
  }

  const objectValue: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value)) {
    try {
      objectValue[key] = toJsonValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    } catch {
      objectValue[key] = "[unreadable]";
    }
  }
  return objectValue;
}

/**
 * Keep only the serializable, agent-visible contract fields from a native
 * WebMCP tool. In particular, never serialize the tool's Window or execute
 * function into an evidence artifact.
 */
export function sanitizeTool(value: unknown): SanitizedTool | null {
  if (value === null || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) {
    return null;
  }

  return {
    name: candidate.name,
    title: typeof candidate.title === "string" ? candidate.title : null,
    description:
      typeof candidate.description === "string" ? candidate.description : null,
    origin: typeof candidate.origin === "string" ? candidate.origin : null,
    inputSchema: toSchemaValue(candidate.inputSchema),
    annotations: toSchemaValue(candidate.annotations),
  };
}

function toSchemaValue(value: unknown): JsonValue {
  if (typeof value === "string") {
    try {
      return toJsonValue(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return toJsonValue(value);
}

export function summarizeError(error: unknown): string {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

export type OriginTrialTokenSummary = {
  present: boolean;
  feature: string | null;
  origin: string | null;
  expiry: number | null;
  parseError: string | null;
};

/**
 * Decode only the public metadata carried by an origin-trial token. The token
 * value itself is deliberately never returned or written to evidence.
 */
export function summarizeOriginTrialToken(
  token: string | null | undefined,
): OriginTrialTokenSummary {
  if (!token) {
    return {
      present: false,
      feature: null,
      origin: null,
      expiry: null,
      parseError: null,
    };
  }

  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const jsonStart = decoded.indexOf("{");
    const jsonEnd = decoded.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < jsonStart) {
      throw new Error("Origin-trial token metadata was not found");
    }
    const payload = JSON.parse(
      decoded.slice(jsonStart, jsonEnd + 1),
    ) as Record<string, unknown>;
    return {
      present: true,
      feature: typeof payload.feature === "string" ? payload.feature : null,
      origin: typeof payload.origin === "string" ? payload.origin : null,
      expiry: typeof payload.expiry === "number" ? payload.expiry : null,
      parseError: null,
    };
  } catch (error) {
    return {
      present: true,
      feature: null,
      origin: null,
      expiry: null,
      parseError: summarizeError(error),
    };
  }
}

export type OriginTrialAssessment =
  | "accepted"
  | "rejected"
  | "expired"
  | "mismatched"
  | "not-required"
  | "unknown";

export function assessOriginTrial(
  token: OriginTrialTokenSummary,
  currentOrigin: string,
  capability: WebMcpCapabilityKind,
  nowMilliseconds: number,
): OriginTrialAssessment {
  if (!token.present) {
    return capability === "available" ? "not-required" : "unknown";
  }

  if (token.parseError || token.feature !== webMcpFeatureName) {
    return "mismatched";
  }

  if (token.expiry !== null && token.expiry * 1000 <= nowMilliseconds) {
    return "expired";
  }

  if (token.origin !== null && !sameOrigin(token.origin, currentOrigin)) {
    return "mismatched";
  }

  return capability === "available" ? "accepted" : "rejected";
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function classifyOracleObservation(
  observation: OracleObservation,
): OracleDecision {
  if (observation.actualBrowserVersion === null) {
    return failed("browser-launch-failed");
  }
  if (observation.actualBrowserVersion !== observation.expectedBrowserVersion) {
    return failed("browser-version-mismatch");
  }
  if (
    observation.navigationStatus !== null &&
    (observation.navigationStatus < 200 || observation.navigationStatus >= 400)
  ) {
    return failed("navigation-failed");
  }
  if (!observation.polyfillBlocked) {
    return failed("polyfill-not-blocked");
  }
  if (observation.capability === "unavailable") {
    return failed("native-unavailable");
  }
  if (observation.capability === "error") {
    return failed("capability-probe-failed");
  }
  if (observation.discovery.status === "failed") {
    return failed("tool-discovery-failed");
  }
  if (!observation.expectedToolFound) {
    return failed("expected-tool-missing");
  }
  if (observation.invocation.status !== "passed") {
    return failed("invocation-failed");
  }
  if (
    JSON.stringify(observation.invocation.result) !==
      JSON.stringify(observation.invocation.expectedResult)
  ) {
    return failed("structured-result-mismatch");
  }
  if (
    observation.visibleState.before !== observation.visibleState.expectedBefore ||
    observation.visibleState.after !== observation.visibleState.expectedAfter
  ) {
    return failed("visible-state-mismatch");
  }
  if (observation.browserErrors.length > 0) {
    return failed("browser-errors");
  }

  return {
    classification: "oracle-passed",
    failureCode: null,
    downstream: "evaluable",
  };
}

export function classifyControlCapability(
  capability: WebMcpCapabilityKind,
): ControlClassification {
  return capability === "unavailable" ? "native-unavailable" : "control-failed";
}

function failed(failureCode: OracleFailureCode): OracleDecision {
  return {
    classification: "oracle-failed",
    failureCode,
    downstream: "not-evaluable",
  };
}
