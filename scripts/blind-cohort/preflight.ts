import { PRODUCTION_URL } from "./contract";
import { REQUIRED_BROWSER_VERSION } from "./runner";

export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export interface BlindCohortPreflightEvidence {
  readonly requestedSha: string;
  readonly repositoryHead: string;
  readonly fetchedMainHead: string;
  readonly protectedCi: { readonly headSha: string; readonly status: "completed"; readonly conclusion: "success" };
  readonly pagesDeployment: { readonly sourceSha: string; readonly status: "success" };
  readonly routes: {
    readonly root: { readonly status: number; readonly marker: "deck-home" };
    readonly study: { readonly status: number; readonly marker: "study" };
  };
  readonly observedDeploymentSha: string;
  readonly unresolvedReleaseCandidatePrs: number;
  readonly ordinaryReleaseChecks: { readonly sha: string; readonly status: "passed" };
  readonly eightToolAggregate: {
    readonly sha: string;
    readonly status: "passed";
    readonly browserVersion: typeof REQUIRED_BROWSER_VERSION;
    readonly completeToolCount: 8;
  };
}

export interface BlindCohortPreflightResult {
  readonly status: "passed" | "failed";
  readonly sha: string | null;
  readonly deployedUrl: typeof PRODUCTION_URL;
  readonly failure: string | null;
}

/** Pure, fail-closed gate used before any model or browser factory is called. */
export function assessBlindCohortPreflight(candidate: unknown): BlindCohortPreflightResult {
  const failed = (failure: string): BlindCohortPreflightResult => ({
    status: "failed", sha: null, deployedUrl: PRODUCTION_URL, failure,
  });
  if (!isRecord(candidate)) return failed("preflight evidence is missing or malformed");
  const evidence = candidate as Partial<BlindCohortPreflightEvidence>;
  const shas = [
    evidence.requestedSha,
    evidence.repositoryHead,
    evidence.fetchedMainHead,
    evidence.protectedCi?.headSha,
    evidence.pagesDeployment?.sourceSha,
    evidence.observedDeploymentSha,
    evidence.ordinaryReleaseChecks?.sha,
    evidence.eightToolAggregate?.sha,
  ];
  if (shas.some((sha) => typeof sha !== "string" || !FULL_SHA_PATTERN.test(sha))) {
    return failed("every revision signal must be an unabbreviated lowercase SHA");
  }
  if (new Set(shas).size !== 1) return failed("revision signals do not identify one exact SHA");
  if (evidence.protectedCi?.status !== "completed" || evidence.protectedCi.conclusion !== "success") {
    return failed("protected-main CI is not terminal and successful");
  }
  if (evidence.pagesDeployment?.status !== "success") return failed("Pages deployment is not successful");
  if (evidence.routes?.root?.status !== 200 || evidence.routes.root.marker !== "deck-home" ||
      evidence.routes?.study?.status !== 200 || evidence.routes.study.marker !== "study") {
    return failed("deployed root or study route marker is unavailable");
  }
  if (evidence.unresolvedReleaseCandidatePrs !== 0) {
    return failed("an unresolved release-candidate PR prevents cohort execution");
  }
  if (evidence.ordinaryReleaseChecks?.status !== "passed") return failed("ordinary release checks did not pass");
  if (evidence.eightToolAggregate?.status !== "passed" ||
      evidence.eightToolAggregate.browserVersion !== REQUIRED_BROWSER_VERSION ||
      evidence.eightToolAggregate.completeToolCount !== 8) {
    return failed("the one fresh eight-tool aggregate is incomplete or used the wrong browser");
  }
  return { status: "passed", sha: evidence.requestedSha!, deployedUrl: PRODUCTION_URL, failure: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
