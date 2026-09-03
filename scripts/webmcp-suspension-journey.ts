import {
  activeStudyToolNames,
  assessProductionInventory,
  homeToolNames,
} from "./webmcp-production-contract";
import type { StudyJourneyCall, StudyJourneySnapshot } from "./webmcp-study-journey";

export type SuspensionJourneyEvidence = {
  deckId: string | null;
  cardId: string | null;
  studyUrl: string;
  homeUrl: string | null;
  deploymentRoute: string | null;
  studyToolNames: string[];
  homeToolNames: string[];
  before: StudyJourneySnapshot;
  afterSuspend: StudyJourneySnapshot;
  afterSuspendRetry: StudyJourneySnapshot;
  afterCollision: StudyJourneySnapshot;
  homeAfterGo: unknown;
  homeAfterRestore: unknown;
  homeAfterRestoreRetry: unknown;
  suspendCall: StudyJourneyCall;
  suspendRetryCall: StudyJourneyCall;
  collisionCall: StudyJourneyCall;
  goHomeCall: StudyJourneyCall;
  restoreCall: StudyJourneyCall;
  restoreRetryCall: StudyJourneyCall;
  browserErrors: string[];
};

export type SuspensionJourneyAssessment = {
  status: "passed" | "failed";
  failureCode: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decode(call: StudyJourneyCall): Record<string, unknown> | null {
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

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorCode(call: StudyJourneyCall): string | null {
  return typeof record(decode(call)?.error)?.code === "string"
    ? record(decode(call)?.error)?.code as string
    : null;
}

function snapshot(snapshot: StudyJourneySnapshot) {
  const durable = record(snapshot.durable);
  return {
    durable,
    visible: record(snapshot.visible),
    session: record(durable?.session),
    schedule: record(durable?.schedule),
    reviewLogs: Array.isArray(durable?.reviewLogs) ? durable.reviewLogs : [],
  };
}

function homeSnapshot(value: unknown) {
  const outer = record(value);
  return {
    visible: record(outer?.visible),
    session: record(outer?.session),
    schedule: record(outer?.schedule),
    reviewLogs: Array.isArray(outer?.reviewLogs) ? outer.reviewLogs : [],
  };
}

function withoutSuspended(schedule: Record<string, unknown> | null): unknown {
  if (!schedule) return null;
  const { suspended: _suspended, ...memory } = schedule;
  void _suspended;
  return memory;
}

/** Classify one fresh suspend, navigate-home, and restore flow from runtime evidence. */
export function assessSuspensionJourney(
  evidence: SuspensionJourneyEvidence,
  expectedRootUrl: string,
): SuspensionJourneyAssessment {
  const studyInventory = assessProductionInventory(evidence.studyToolNames, activeStudyToolNames);
  if (studyInventory.failureCode) {
    return { status: "failed", failureCode: `suspension-study-${studyInventory.failureCode}` };
  }
  if (!evidence.deckId || !evidence.cardId ||
      !evidence.studyUrl.includes(`deck=${encodeURIComponent(evidence.deckId)}`)) {
    return { status: "failed", failureCode: "suspension-entry-mismatch" };
  }

  const before = snapshot(evidence.before);
  const after = snapshot(evidence.afterSuspend);
  const suspended = decode(evidence.suspendCall);
  const suspensionData = record(suspended?.data);
  const transition = record(suspensionData?.suspension);
  const state = record(suspensionData?.state);
  const stateSession = record(state?.session);
  const queueEntries = Array.isArray(after.session?.queueEntries) ? after.session.queueEntries : [];
  if (suspended?.ok !== true || transition?.suspended_card_id !== evidence.cardId ||
      transition.idempotent !== false || typeof transition.removed_occurrence_count !== "number" ||
      transition.removed_occurrence_count < 1 || after.schedule?.suspended !== true ||
      before.schedule?.suspended !== false ||
      !equal(withoutSuspended(before.schedule), withoutSuspended(after.schedule)) ||
      after.reviewLogs.length !== before.reviewLogs.length ||
      queueEntries.some((entry) => record(entry)?.cardId === evidence.cardId) ||
      after.session?.completedPresentationCount !== before.session?.completedPresentationCount ||
      after.session?.plannedPresentationCount !==
        Number(before.session?.plannedPresentationCount) - Number(transition.removed_occurrence_count) ||
      stateSession?.id !== after.session?.id || stateSession?.sequence !== after.session?.sequence ||
      state?.status !== after.visible?.state ||
      stateSession?.planned_presentations !== after.session?.plannedPresentationCount ||
      after.visible?.progressTotal !== after.session?.plannedPresentationCount) {
    return { status: "failed", failureCode: "suspend-transition-mismatch" };
  }

  const retry = decode(evidence.suspendRetryCall);
  const retryTransition = record(record(retry?.data)?.suspension);
  if (retry?.ok !== true || retryTransition?.suspended_card_id !== evidence.cardId ||
      retryTransition.idempotent !== true ||
      !equal(evidence.afterSuspend, evidence.afterSuspendRetry)) {
    return { status: "failed", failureCode: "suspend-idempotency-failed" };
  }
  if (errorCode(evidence.collisionCall) !== "DUPLICATE_COMMAND" ||
      !equal(evidence.afterSuspendRetry, evidence.afterCollision)) {
    return { status: "failed", failureCode: "suspend-command-collision-failed" };
  }

  const goHome = decode(evidence.goHomeCall);
  const goHomeData = record(goHome?.data);
  const homeInventory = assessProductionInventory(evidence.homeToolNames, homeToolNames);
  const home = homeSnapshot(evidence.homeAfterGo);
  if (goHome?.ok !== true || goHomeData?.page !== "decks" ||
      evidence.homeUrl !== expectedRootUrl || evidence.deploymentRoute !== "deck-home" ||
      homeInventory.failureCode || home.schedule?.suspended !== true ||
      home.reviewLogs.length !== before.reviewLogs.length ||
      home.session?.id !== after.session?.id ||
      !equal(home.session, after.session) ||
      home.visible?.deckId !== evidence.deckId || home.visible?.suspendedCount !== 1) {
    return { status: "failed", failureCode: "go-home-suspension-parity-mismatch" };
  }

  const restored = decode(evidence.restoreCall);
  const restoredData = record(restored?.data);
  const afterRestore = homeSnapshot(evidence.homeAfterRestore);
  if (restored?.ok !== true || restoredData?.deck_id !== evidence.deckId ||
      restoredData?.restored_count !== 1 || restoredData?.idempotent !== false ||
      afterRestore.schedule?.suspended !== false ||
      !equal(afterRestore.schedule, before.schedule) ||
      !equal(afterRestore.session, home.session) ||
      afterRestore.reviewLogs.length !== before.reviewLogs.length ||
      afterRestore.visible?.deckId !== evidence.deckId ||
      afterRestore.visible?.suspendedCount !== 0) {
    return { status: "failed", failureCode: "restore-transition-mismatch" };
  }
  const restoredRetry = decode(evidence.restoreRetryCall);
  const restoredRetryData = record(restoredRetry?.data);
  if (restoredRetry?.ok !== true || restoredRetryData?.restored_count !== 1 ||
      restoredRetryData?.idempotent !== true ||
      !equal(evidence.homeAfterRestore, evidence.homeAfterRestoreRetry)) {
    return { status: "failed", failureCode: "restore-idempotency-failed" };
  }
  if (evidence.browserErrors.length > 0) {
    return { status: "failed", failureCode: "suspension-journey-browser-errors" };
  }
  return { status: "passed", failureCode: null };
}
