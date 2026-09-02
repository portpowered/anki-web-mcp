import {
  activeStudyToolContracts,
  activeStudyToolNames,
  assessProductionInventory,
} from "./webmcp-production-contract";

export type StudyJourneyCall = {
  status: "passed" | "failed" | "not-run";
  result: unknown;
  error: string | null;
};

export type StudyJourneySnapshot = {
  visible: unknown;
  durable: unknown;
};

export type StudyJourneyEvidence = {
  url: string;
  deckId: string | null;
  cardId: string | null;
  tools: Array<{ name: string | null; inputSchema: unknown; annotations: unknown }>;
  before: StudyJourneySnapshot;
  afterRead: StudyJourneySnapshot;
  afterRepeatedRead: StudyJourneySnapshot;
  afterPrematureRating: StudyJourneySnapshot;
  afterFlip: StudyJourneySnapshot;
  afterFlipRetry: StudyJourneySnapshot;
  afterRating: StudyJourneySnapshot;
  getStateCall: StudyJourneyCall;
  repeatedGetStateCall: StudyJourneyCall;
  prematureRatingCall: StudyJourneyCall;
  flipCall: StudyJourneyCall;
  flipRetryCall: StudyJourneyCall;
  ratingCall: StudyJourneyCall;
  rating: "again" | "hard" | "good" | "easy";
  browserErrors: string[];
};

export type StudyJourneyAssessment = {
  status: "passed" | "failed";
  failureCode: string | null;
};

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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

function decodedSchema(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stateFrom(call: StudyJourneyCall): Record<string, unknown> | null {
  const result = decode(call);
  const data = record(result?.data);
  return record(data?.state);
}

function errorCode(call: StudyJourneyCall): string | null {
  const error = record(decode(call)?.error);
  return typeof error?.code === "string" ? error.code : null;
}

function toolContractsMatch(evidence: StudyJourneyEvidence): boolean {
  return activeStudyToolContracts.every((expected) => {
    const observed = evidence.tools.find((tool) => tool.name === expected.name);
    return observed !== undefined &&
      equal(decodedSchema(observed.inputSchema), expected.inputSchema) &&
      equal(observed.annotations, expected.annotations);
  });
}

function snapshotRecords(snapshot: StudyJourneySnapshot) {
  const durable = record(snapshot.durable);
  const visible = record(snapshot.visible);
  const session = record(durable?.session);
  const card = record(durable?.card);
  return { durable, visible, session, card };
}

function stateMatchesSnapshot(
  state: Record<string, unknown> | null,
  snapshot: StudyJourneySnapshot,
  deckId: string,
  cardId: string | null,
  side: "front" | "back" | null,
): boolean {
  const { visible, session, card } = snapshotRecords(snapshot);
  const currentCard = record(state?.current_card);
  const stateSession = record(state?.session);
  if (!state || !visible || !session || state.page !== "study" || state.deck === null) return false;
  if (record(state.deck)?.id !== deckId || state.status !== visible.state ||
      stateSession?.id !== session.id || stateSession?.sequence !== session.sequence ||
      stateSession?.completed_presentations !== session.completedPresentationCount ||
      stateSession?.planned_presentations !== session.plannedPresentationCount) return false;
  if (cardId === null) {
    return currentCard === null && visible.cardId === null && session.activeCardId === null;
  }
  return currentCard?.id === cardId && currentCard.side === side &&
    visible.cardId === cardId && visible.side === side &&
    visible.progressCurrent === stateSession?.completed_presentations &&
    visible.progressTotal === stateSession?.planned_presentations &&
    session.activeCardId === cardId && session.currentSide === side &&
    card?.id === cardId && currentCard.front_text === card.frontText &&
    visible.content === (side === "front" ? card.frontText : card.backText) &&
    (side === "front"
      ? !Object.hasOwn(currentCard, "back_text")
      : currentCard.back_text === card.backText);
}

/** Classify observable tool, UI, and durable-state evidence from one isolated study flow. */
export function assessStudyJourney(evidence: StudyJourneyEvidence): StudyJourneyAssessment {
  const inventory = assessProductionInventory(
    evidence.tools.map((tool) => tool.name ?? ""),
    activeStudyToolNames,
  );
  if (inventory.failureCode) {
    return { status: "failed", failureCode: `study-${inventory.failureCode}` };
  }
  if (!toolContractsMatch(evidence)) {
    return { status: "failed", failureCode: "study-tool-contract-mismatch" };
  }
  if (!evidence.deckId || !evidence.cardId || !evidence.url.includes(`deck=${encodeURIComponent(evidence.deckId)}`)) {
    return { status: "failed", failureCode: "study-entry-mismatch" };
  }
  const front = stateFrom(evidence.getStateCall);
  const repeatedFront = stateFrom(evidence.repeatedGetStateCall);
  if (!stateMatchesSnapshot(front, evidence.afterRead, evidence.deckId, evidence.cardId, "front") ||
      !stateMatchesSnapshot(repeatedFront, evidence.afterRepeatedRead, evidence.deckId, evidence.cardId, "front") ||
      !equal(evidence.before.durable, evidence.afterRead.durable) ||
      !equal(evidence.afterRead.durable, evidence.afterRepeatedRead.durable)) {
    return { status: "failed", failureCode: "get-state-parity-or-mutation" };
  }
  if (errorCode(evidence.prematureRatingCall) !== "ANSWER_NOT_REVEALED" ||
      !equal(evidence.afterRepeatedRead, evidence.afterPrematureRating)) {
    return { status: "failed", failureCode: "premature-rating-contract-failed" };
  }
  const flip = decode(evidence.flipCall);
  const flipData = record(flip?.data);
  const reveal = record(flipData?.reveal);
  if (flip?.ok !== true || reveal?.changed !== true || reveal.idempotent !== false ||
      !stateMatchesSnapshot(record(flipData?.state), evidence.afterFlip, evidence.deckId, evidence.cardId, "back")) {
    return { status: "failed", failureCode: "flip-transition-mismatch" };
  }
  const retry = decode(evidence.flipRetryCall);
  const retryData = record(retry?.data);
  const retryReveal = record(retryData?.reveal);
  if (retry?.ok !== true || retryReveal?.changed !== false || retryReveal.idempotent !== true ||
      !equal(evidence.afterFlip.durable, evidence.afterFlipRetry.durable) ||
      !stateMatchesSnapshot(record(retryData?.state), evidence.afterFlipRetry, evidence.deckId, evidence.cardId, "back")) {
    return { status: "failed", failureCode: "flip-idempotency-failed" };
  }
  const rated = decode(evidence.ratingCall);
  const ratedData = record(rated?.data);
  const transition = record(ratedData?.transition);
  const afterRating = snapshotRecords(evidence.afterRating);
  const reviewLogs = Array.isArray(afterRating.durable?.reviewLogs)
    ? afterRating.durable.reviewLogs as Array<Record<string, unknown>>
    : [];
  const matchingLogs = reviewLogs.filter((log) =>
    log.cardId === evidence.cardId && log.rating === evidence.rating
  );
  const schedules = Array.isArray(afterRating.durable?.schedules)
    ? afterRating.durable.schedules as Array<Record<string, unknown>>
    : [];
  const reviewedSchedule = schedules.find((schedule) => schedule.cardId === evidence.cardId);
  const committedLog = matchingLogs[0];
  const scheduleAfter = record(committedLog?.after);
  const ratedState = record(ratedData?.state);
  const nextCard = record(ratedState?.current_card);
  if (rated?.ok !== true || transition?.rating !== evidence.rating ||
      transition.reviewed_card_id !== evidence.cardId || transition.idempotent !== false ||
      matchingLogs.length !== 1 || afterRating.session?.completedPresentationCount !== 1 ||
      !reviewedSchedule || !scheduleAfter ||
      transition.next_due_at !== new Date(Number(reviewedSchedule.dueAt)).toISOString() ||
      scheduleAfter.dueAt !== reviewedSchedule.dueAt || scheduleAfter.reps !== reviewedSchedule.reps ||
      scheduleAfter.state !== reviewedSchedule.state ||
      !stateMatchesSnapshot(
        ratedState,
        evidence.afterRating,
        evidence.deckId,
        typeof nextCard?.id === "string" ? nextCard.id : null,
        typeof nextCard?.side === "string" ? nextCard.side as "front" | "back" : null,
      )) {
    return { status: "failed", failureCode: "rating-transition-mismatch" };
  }
  if (evidence.browserErrors.length > 0) {
    return { status: "failed", failureCode: "study-journey-browser-errors" };
  }
  return { status: "passed", failureCode: null };
}
