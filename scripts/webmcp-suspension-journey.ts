import {
  activeStudyToolNames,
  assessProductionInventory,
  homeToolNames,
  type ProductionToolName,
} from "./webmcp-production-contract";
import type { StudyJourneyCall, StudyJourneySnapshot } from "./webmcp-study-journey";

export type SuspensionJourneyEvidence = {
  deckId: string | null;
  cardId: string | null;
  studyUrl: string;
  homeUrl: string | null;
  deploymentRoute: string | null;
  studyToolNames: string[];
  suspendRetryToolNames: string[];
  suspendRegistrationRotated: boolean;
  suspendRetryAcquisitionAttempts: number;
  suspendCommandId: string;
  collisionToolNames: string[];
  crossToolCollisionToolNames: string[];
  goHomeToolNames: string[];
  homeToolNames: string[];
  restoreRetryToolNames: string[];
  finalStudyToolNames: string[];
  before: StudyJourneySnapshot;
  afterSuspend: StudyJourneySnapshot;
  afterSuspendRetry: StudyJourneySnapshot;
  afterCollision: StudyJourneySnapshot;
  afterCrossToolCollision: StudyJourneySnapshot;
  homeAfterGo: unknown;
  homeAfterRestore: unknown;
  homeAfterRestoreRetry: unknown;
  suspendCall: StudyJourneyCall;
  suspendRetryCall: StudyJourneyCall;
  collisionCall: StudyJourneyCall;
  crossToolCollisionCall: StudyJourneyCall;
  goHomeCall: StudyJourneyCall;
  restoreCall: StudyJourneyCall;
  restoreRetryCall: StudyJourneyCall;
  selectDeckCall: StudyJourneyCall;
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
    deck: record(durable?.deck),
    card: record(durable?.card),
    cards: Array.isArray(durable?.cards) ? durable.cards : [],
    schedule: record(durable?.schedule),
    schedules: Array.isArray(durable?.schedules) ? durable.schedules : [],
    commandEvidence: record(durable?.commandEvidence),
    reviewLogs: Array.isArray(durable?.reviewLogs) ? durable.reviewLogs : [],
  };
}

function sessionWithoutUpdatedAt(session: Record<string, unknown> | null): unknown {
  if (!session) return null;
  const { updatedAt: _updatedAt, ...material } = session;
  void _updatedAt;
  return material;
}

function expectedSessionAfterSuspend(
  before: Record<string, unknown>,
  cardId: string,
  commandId: string,
  nextCardId: string,
  removedOccurrenceCount: number,
): Record<string, unknown> {
  const queueEntries = Array.isArray(before.queueEntries) ? before.queueEntries : [];
  const lastCommandIds = Array.isArray(before.lastCommandIds) ? before.lastCommandIds : [];
  return {
    ...before,
    queueEntries: queueEntries.filter((entry) => record(entry)?.cardId !== cardId),
    activeCardId: nextCardId,
    plannedPresentationCount: Number(before.plannedPresentationCount) - removedOccurrenceCount,
    completedPresentationCount: before.completedPresentationCount,
    currentSide: "front",
    completedAt: null,
    lastCommandIds: [...lastCommandIds.filter((value) => value !== commandId), commandId],
  };
}

function expectedSchedulesAfterSuspend(schedules: unknown[], cardId: string): unknown[] {
  return schedules.map((value) => {
    const schedule = record(value);
    return schedule?.cardId === cardId ? { ...schedule, suspended: true } : value;
  });
}

function suspensionIdentity(result: Record<string, unknown> | null): unknown {
  const data = record(result?.data);
  const state = record(data?.state);
  const stateSession = record(state?.session);
  const stateCard = record(state?.current_card);
  const transition = record(data?.suspension);
  return {
    command_id: data?.command_id,
    session_id: stateSession?.id,
    session_sequence: stateSession?.sequence,
    state_status: state?.status,
    current_card_id: stateCard?.id,
    current_card_side: stateCard?.side,
    suspended_card_id: transition?.suspended_card_id,
    outcome: transition?.outcome,
    next_card_id: transition?.next_card_id,
  };
}

function exactInventory(
  observed: readonly string[],
  expected: readonly ProductionToolName[],
): boolean {
  return assessProductionInventory(observed, expected).failureCode === null;
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

/** Classify one fresh suspend, navigate-home, and restore flow from runtime evidence. */
export function assessSuspensionJourney(
  evidence: SuspensionJourneyEvidence,
  expectedRootUrl: string,
): SuspensionJourneyAssessment {
  const studyInventory = assessProductionInventory(evidence.studyToolNames, activeStudyToolNames);
  if (studyInventory.failureCode) {
    return { status: "failed", failureCode: `suspension-study-${studyInventory.failureCode}` };
  }
  const retryInventory = assessProductionInventory(
    evidence.suspendRetryToolNames,
    activeStudyToolNames,
  );
  if (retryInventory.failureCode || evidence.suspendRegistrationRotated !== true ||
      !Number.isInteger(evidence.suspendRetryAcquisitionAttempts) ||
      evidence.suspendRetryAcquisitionAttempts < 1) {
    return { status: "failed", failureCode: "suspend-retry-acquisition-failed" };
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
  const stateCard = record(state?.current_card);
  const nextCardId = typeof transition?.next_card_id === "string"
    ? transition.next_card_id
    : null;
  const beforeQueueEntries = Array.isArray(before.session?.queueEntries)
    ? before.session.queueEntries
    : [];
  const expectedRemoved = beforeQueueEntries.filter(
    (entry) => record(entry)?.cardId === evidence.cardId,
  ).length;
  const queueEntries = Array.isArray(after.session?.queueEntries) ? after.session.queueEntries : [];
  const expectedSession = before.session && nextCardId
    ? expectedSessionAfterSuspend(
      before.session,
      evidence.cardId,
      evidence.suspendCommandId,
      nextCardId,
      expectedRemoved,
    )
    : null;
  const expectedSchedule = before.schedule ? { ...before.schedule, suspended: true } : null;
  const expectedSchedules = expectedSchedulesAfterSuspend(before.schedules, evidence.cardId);
  const commandEvidence = after.commandEvidence;
  if (suspended?.ok !== true || record(suspended?.data)?.command_id !== evidence.suspendCommandId ||
      transition?.suspended_card_id !== evidence.cardId ||
      transition.idempotent !== false || typeof transition.removed_occurrence_count !== "number" ||
      nextCardId === null || nextCardId === evidence.cardId ||
      expectedRemoved < 1 || transition.removed_occurrence_count !== expectedRemoved ||
      !equal(after.deck, before.deck) || !equal(after.cards, before.cards) ||
      !equal(after.schedule, expectedSchedule) || !equal(after.schedules, expectedSchedules) ||
      before.schedule?.suspended !== false ||
      after.reviewLogs.length !== before.reviewLogs.length ||
      queueEntries.some((entry) => record(entry)?.cardId === evidence.cardId) ||
      !equal(sessionWithoutUpdatedAt(after.session), sessionWithoutUpdatedAt(expectedSession)) ||
      typeof after.session?.updatedAt !== "number" ||
      Number(after.session.updatedAt) < Number(before.session?.updatedAt) ||
      after.session?.activeCardId !== nextCardId || after.session.currentSide !== "front" ||
      after.card?.id !== nextCardId || after.visible?.cardId !== nextCardId ||
      after.visible.side !== "front" || after.visible.sideDetail !== null ||
      before.visible?.progressTotal !== 20 || after.visible.progressTotal !== 19 ||
      after.visible?.progressCurrent !== before.visible?.progressCurrent ||
      commandEvidence?.key !== `study.suspend:${evidence.suspendCommandId}` ||
      !equal(commandEvidence?.value, {
        kind: "suspend",
        sessionId: before.session?.id,
        cardId: evidence.cardId,
      }) ||
      stateSession?.id !== after.session?.id || stateSession?.sequence !== after.session?.sequence ||
      stateCard?.id !== nextCardId || stateCard.side !== "front" ||
      state?.status !== after.visible?.state ||
      stateSession?.planned_presentations !== after.session?.plannedPresentationCount ||
      after.visible?.progressTotal !== after.session?.plannedPresentationCount) {
    return { status: "failed", failureCode: "suspend-transition-mismatch" };
  }

  const retry = decode(evidence.suspendRetryCall);
  const retryTransition = record(record(retry?.data)?.suspension);
  if (retry?.ok !== true || record(retry?.data)?.command_id !== evidence.suspendCommandId ||
      retryTransition?.suspended_card_id !== evidence.cardId ||
      retryTransition.removed_occurrence_count !== 0 ||
      retryTransition.idempotent !== true ||
      !equal(suspensionIdentity(suspended), suspensionIdentity(retry)) ||
      !equal(record(suspended?.data)?.state, record(retry?.data)?.state) ||
      !equal(evidence.afterSuspend, evidence.afterSuspendRetry)) {
    return { status: "failed", failureCode: "suspend-idempotency-failed" };
  }
  if (errorCode(evidence.collisionCall) !== "DUPLICATE_COMMAND" ||
      !equal(evidence.afterSuspendRetry, evidence.afterCollision)) {
    return { status: "failed", failureCode: "suspend-command-collision-failed" };
  }
  if (!exactInventory(evidence.collisionToolNames, activeStudyToolNames) ||
      errorCode(evidence.crossToolCollisionCall) !== "DUPLICATE_COMMAND" ||
      !exactInventory(evidence.crossToolCollisionToolNames, activeStudyToolNames) ||
      !equal(evidence.afterCollision, evidence.afterCrossToolCollision)) {
    return { status: "failed", failureCode: "cross-tool-command-collision-failed" };
  }

  const goHome = decode(evidence.goHomeCall);
  const goHomeData = record(goHome?.data);
  const homeInventory = assessProductionInventory(evidence.homeToolNames, homeToolNames);
  const home = homeSnapshot(evidence.homeAfterGo);
  if (goHome?.ok !== true || goHomeData?.page !== "decks" ||
      evidence.homeUrl !== expectedRootUrl || evidence.deploymentRoute !== "deck-home" ||
      !exactInventory(evidence.goHomeToolNames, activeStudyToolNames) ||
      homeInventory.failureCode || home.schedule?.suspended !== true ||
      home.reviewLogs.length !== before.reviewLogs.length ||
      home.session?.id !== after.session?.id ||
      !equal(home.session, after.session) ||
      home.visible?.deckId !== evidence.deckId ||
      home.visible?.recoveryAvailable !== true) {
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
      afterRestore.visible?.recoveryAvailable !== false) {
    return { status: "failed", failureCode: "restore-transition-mismatch" };
  }
  const restoredRetry = decode(evidence.restoreRetryCall);
  const restoredRetryData = record(restoredRetry?.data);
  if (restoredRetry?.ok !== true || restoredRetryData?.restored_count !== 1 ||
      restoredRetryData?.deck_id !== restoredData?.deck_id ||
      restoredRetryData?.idempotent !== true ||
      !exactInventory(evidence.restoreRetryToolNames, homeToolNames) ||
      !equal(evidence.homeAfterRestore, evidence.homeAfterRestoreRetry)) {
    return { status: "failed", failureCode: "restore-idempotency-failed" };
  }
  const selected = decode(evidence.selectDeckCall);
  if (selected?.ok !== true || record(selected?.data)?.deck_id !== evidence.deckId ||
      !exactInventory(evidence.finalStudyToolNames, activeStudyToolNames)) {
    return { status: "failed", failureCode: "restore-study-return-failed" };
  }
  if (evidence.browserErrors.length > 0) {
    return { status: "failed", failureCode: "suspension-journey-browser-errors" };
  }
  return { status: "passed", failureCode: null };
}
