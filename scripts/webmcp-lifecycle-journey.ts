import {
  activeStudyToolNames,
  assessProductionInventory,
  emptyStudyToolNames,
  homeToolNames,
  type ProductionToolName,
} from "./webmcp-production-contract";

export type LifecycleCall = {
  status: "passed" | "failed" | "not-run";
  result: unknown;
  error: string | null;
  classification?: "NATIVE_HANDLE_UNREGISTERED";
};

export type LifecycleSnapshot = {
  url: string;
  route: string | null;
  toolNames: string[];
  cardId: string | null;
  side: "front" | "back" | null;
  durable: unknown;
};

export type LifecycleObservation = {
  step: "root-initial" | "study-first" | "root-return" | "study-second" | "study-missing-card";
  snapshot: LifecycleSnapshot;
};

export type LifecycleJourneyEvidence = {
  observations: LifecycleObservation[];
  deckId: string | null;
  firstCardId: string | null;
  replacementCardId: string | null;
  missingCardCall: LifecycleCall;
  oldHomeCall: LifecycleCall;
  oldStudyCall: LifecycleCall;
  staleCardCall: LifecycleCall;
  beforeOldHome: LifecycleSnapshot;
  afterOldHome: LifecycleSnapshot;
  beforeOldStudy: LifecycleSnapshot;
  afterOldStudy: LifecycleSnapshot;
  beforeStaleCard: LifecycleSnapshot;
  afterStaleCard: LifecycleSnapshot;
  cancellation: {
    marker: string | null;
    before: LifecycleSnapshot;
    after: LifecycleSnapshot;
  };
  browserErrors: string[];
};

export type LifecycleJourneyAssessment = {
  status: "passed" | "failed";
  failureCode: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decode(call: LifecycleCall): Record<string, unknown> | null {
  if (call.status !== "passed") return null;
  if (typeof call.result === "string") {
    try {
      return record(JSON.parse(call.result));
    } catch {
      return null;
    }
  }
  return record(call.result);
}

function errorCode(call: LifecycleCall): string | null {
  const error = record(decode(call)?.error);
  return typeof error?.code === "string" ? error.code : null;
}

function wrongPageOrUnregistered(call: LifecycleCall): boolean {
  return errorCode(call) === "WRONG_PAGE" ||
    (call.status === "failed" && call.classification === "NATIVE_HANDLE_UNREGISTERED");
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stateEqual(left: LifecycleSnapshot, right: LifecycleSnapshot): boolean {
  return left.route === right.route && left.cardId === right.cardId && left.side === right.side &&
    equal(left.durable, right.durable);
}

const expectedByStep: Record<LifecycleObservation["step"], readonly ProductionToolName[]> = {
  "root-initial": homeToolNames,
  "study-first": activeStudyToolNames,
  "root-return": homeToolNames,
  "study-second": activeStudyToolNames,
  "study-missing-card": emptyStudyToolNames,
};

/** Classify one live root-to-study lifecycle without accepting reload-only evidence. */
export function assessLifecycleJourney(
  evidence: LifecycleJourneyEvidence,
): LifecycleJourneyAssessment {
  for (const [step, expected] of Object.entries(expectedByStep) as Array<
    [LifecycleObservation["step"], readonly ProductionToolName[]]
  >) {
    const observation = evidence.observations.find((candidate) => candidate.step === step);
    if (!observation) return { status: "failed", failureCode: `lifecycle-${step}-missing` };
    const inventory = assessProductionInventory(observation.snapshot.toolNames, expected);
    if (inventory.failureCode) {
      return { status: "failed", failureCode: `lifecycle-${step}-${inventory.failureCode}` };
    }
  }
  if (!evidence.deckId || !evidence.firstCardId || !evidence.replacementCardId ||
      evidence.firstCardId === evidence.replacementCardId) {
    return { status: "failed", failureCode: "lifecycle-production-session-mismatch" };
  }
  if (errorCode(evidence.missingCardCall) !== null || decode(evidence.missingCardCall)?.ok !== true ||
      record(decode(evidence.missingCardCall)?.data)?.state === undefined ||
      record(record(decode(evidence.missingCardCall)?.data)?.state)?.status !== "missing-deck") {
    return { status: "failed", failureCode: "lifecycle-missing-card-state-mismatch" };
  }
  if (!wrongPageOrUnregistered(evidence.oldHomeCall) ||
      !stateEqual(evidence.beforeOldHome, evidence.afterOldHome)) {
    return { status: "failed", failureCode: "lifecycle-old-home-handle-active" };
  }
  if (!wrongPageOrUnregistered(evidence.oldStudyCall) ||
      !stateEqual(evidence.beforeOldStudy, evidence.afterOldStudy)) {
    return { status: "failed", failureCode: "lifecycle-old-study-handle-active" };
  }
  if (errorCode(evidence.staleCardCall) !== "STALE_CARD" ||
      !stateEqual(evidence.beforeStaleCard, evidence.afterStaleCard)) {
    return { status: "failed", failureCode: "lifecycle-stale-card-mutated" };
  }
  const cancelled = evidence.cancellation;
  if (cancelled.marker !== "pending" ||
      cancelled.before.cardId !== cancelled.after.cardId ||
      cancelled.before.side !== "front" || cancelled.after.side !== "front" ||
      !equal(cancelled.before.durable, cancelled.after.durable)) {
    return { status: "failed", failureCode: "lifecycle-cancellation-late-commit" };
  }
  if (evidence.browserErrors.length > 0) {
    return { status: "failed", failureCode: "lifecycle-browser-errors" };
  }
  return { status: "passed", failureCode: null };
}
