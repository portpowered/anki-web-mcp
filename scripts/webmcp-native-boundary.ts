import type {
  WebMcpCapabilityKind,
} from "../lib/webmcp-oracle";
import type { WebMcpOriginTrialStatus } from "../lib/webmcp";

export type NativeBoundaryFailureCode =
  | "browser-product-mismatch"
  | "browser-version-mismatch"
  | "forbidden-browser-influence"
  | "deployment-route-failed"
  | "document-url-mismatch"
  | "document-origin-mismatch"
  | "document-identity-mismatch"
  | "insecure-context"
  | "origin-trial-token-missing"
  | "origin-trial-token-mismatch"
  | "origin-trial-rejected"
  | "origin-trial-expired"
  | "origin-trial-metadata-mismatch"
  | "origin-trial-status-unknown"
  | "permissions-policy-denied"
  | "permissions-policy-unknown"
  | "native-unavailable"
  | "capability-probe-failed"
  | "browser-errors";

export type NativeBoundaryObservation = {
  browserProduct: string | null;
  expectedBrowserProduct: string;
  browserVersion: string | null;
  expectedBrowserVersion: string;
  forbiddenBrowserInfluences: readonly string[];
  navigationStatus: number | null;
  url: string | null;
  expectedUrl: string;
  origin: string | null;
  expectedOrigin: string;
  deploymentRoute: string | null;
  expectedDeploymentRoute: string;
  deploymentRouteCount: number;
  secureContext: boolean | null;
  originTrialMetaCount: number;
  originTrialTokenExact: boolean;
  originTrialStatus: WebMcpOriginTrialStatus | null;
  permissionsPolicy: "allowed" | "denied" | "unknown";
  capability: WebMcpCapabilityKind;
  browserErrors: readonly string[];
};

export type NativeBoundaryDecision = {
  status: "passed" | "failed" | "not-evaluable";
  overall: "supported" | "no-go" | "not-evaluable";
  failureCode: NativeBoundaryFailureCode | null;
};

export function classifyNativeBoundary(
  observation: NativeBoundaryObservation,
): NativeBoundaryDecision {
  if (observation.browserProduct !== observation.expectedBrowserProduct) {
    return failed("browser-product-mismatch");
  }
  if (observation.browserVersion !== observation.expectedBrowserVersion) {
    return failed("browser-version-mismatch");
  }
  if (observation.forbiddenBrowserInfluences.length > 0) {
    return failed("forbidden-browser-influence");
  }
  if (
    observation.navigationStatus === null ||
    observation.navigationStatus < 200 ||
    observation.navigationStatus >= 400
  ) {
    return failed("deployment-route-failed");
  }
  if (observation.url !== observation.expectedUrl) {
    return failed("document-url-mismatch");
  }
  if (observation.origin !== observation.expectedOrigin) {
    return failed("document-origin-mismatch");
  }
  if (
    observation.deploymentRoute !== observation.expectedDeploymentRoute ||
    observation.deploymentRouteCount !== 1
  ) {
    return failed("document-identity-mismatch");
  }
  if (observation.secureContext !== true) {
    return failed("insecure-context");
  }
  if (observation.originTrialMetaCount !== 1) {
    return failed("origin-trial-token-missing");
  }
  if (!observation.originTrialTokenExact) {
    return failed("origin-trial-token-mismatch");
  }
  if (observation.capability === "unavailable") {
    return {
      status: "not-evaluable",
      overall: "not-evaluable",
      failureCode: "native-unavailable",
    };
  }
  if (observation.capability !== "available") {
    return failed("capability-probe-failed");
  }
  switch (observation.originTrialStatus) {
    case "accepted":
      break;
    case "rejected":
      return failed("origin-trial-rejected");
    case "expired":
      return failed("origin-trial-expired");
    case "mismatched":
      return failed("origin-trial-metadata-mismatch");
    default:
      return failed("origin-trial-status-unknown");
  }
  if (observation.permissionsPolicy === "denied") {
    return failed("permissions-policy-denied");
  }
  if (observation.permissionsPolicy !== "allowed") {
    return failed("permissions-policy-unknown");
  }
  if (observation.browserErrors.length > 0) {
    return failed("browser-errors");
  }
  return { status: "passed", overall: "supported", failureCode: null };
}

const forbiddenArgumentPatterns = [
  /^--enable-webmcp-testing(?:=|$)/i,
  /^--load-extension(?:=|$)/i,
  /^--proxy-(?:server|pac-url|bypass-list)(?:=|$)/i,
] as const;

export function findForbiddenBrowserInfluences(
  browserArguments: readonly string[],
): string[] {
  const found: string[] = [];
  for (const argument of browserArguments) {
    if (forbiddenArgumentPatterns.some((pattern) => pattern.test(argument))) {
      found.push(argument.split("=", 1)[0] ?? argument);
      continue;
    }
    const featureMatch = argument.match(/^--enable-features=(.+)$/i);
    if (
      featureMatch?.[1].split(",").some((feature) =>
        feature.trim().toLowerCase() === "webmcp"
      )
    ) {
      found.push("--enable-features=WebMCP");
    }
  }
  return [...new Set(found)];
}

function failed(
  failureCode: NativeBoundaryFailureCode,
): NativeBoundaryDecision {
  return { status: "failed", overall: "no-go", failureCode };
}
