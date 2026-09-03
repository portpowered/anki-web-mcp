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
  failureDetail: string | null;
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

function normalizedText(value: unknown): string | null {
  return typeof value === "string" ? value.normalize("NFC").replace(/\s+/gu, " ").trim() : null;
}

function validAnswerSemantic(value: unknown): boolean {
  const semantic = record(value);
  if (!semantic || typeof semantic.text !== "string" || !Array.isArray(semantic.media)) return false;
  if (normalizedText(semantic.text) !== semantic.text) return false;
  const validMedia = semantic.media.every((value) => {
    const item = record(value);
    return item !== null && (item.kind === "image" || item.kind === "audio") &&
      typeof item.label === "string" && normalizedText(item.label) === item.label && item.label.length > 0;
  });
  return validMedia && (semantic.text.length > 0 || semantic.media.length > 0);
}

function fail(failureCode: string, failureDetail: string): StudyJourneyAssessment {
  return { status: "failed", failureCode, failureDetail };
}

function legalFirstRevealMutation(before: StudyJourneySnapshot, after: StudyJourneySnapshot): boolean {
  const beforeRecords = snapshotRecords(before);
  const afterRecords = snapshotRecords(after);
  if (!beforeRecords.session || !afterRecords.session) return false;
  const beforeSession = beforeRecords.session;
  const afterSession = afterRecords.session;
  const beforeStable = { ...beforeSession, currentSide: undefined, updatedAt: undefined };
  const afterStable = { ...afterSession, currentSide: undefined, updatedAt: undefined };
  const stableStores = (durable: Record<string, unknown>, sessionId: unknown) => {
    const stores = record(durable.stores);
    if (!stores || !Array.isArray(stores.sessions)) return null;
    return {
      ...stores,
      sessions: stores.sessions.map((value) => {
        const session = record(value);
        return session?.id === sessionId
          ? { ...session, currentSide: undefined, updatedAt: undefined }
          : value;
      }),
    };
  };
  const beforeStores = beforeRecords.durable && stableStores(beforeRecords.durable, beforeSession.id);
  const afterStores = afterRecords.durable && stableStores(afterRecords.durable, afterSession.id);
  return beforeSession.currentSide === "front" && afterSession.currentSide === "back" &&
    typeof afterSession.updatedAt === "number" &&
    (typeof beforeSession.updatedAt !== "number" || afterSession.updatedAt >= beforeSession.updatedAt) &&
    equal(beforeStable, afterStable) && equal(beforeRecords.card, afterRecords.card) &&
    beforeStores !== null && afterStores !== null && equal(beforeStores, afterStores) &&
    equal(beforeRecords.durable?.schedule, afterRecords.durable?.schedule) &&
    equal(beforeRecords.durable?.schedules, afterRecords.durable?.schedules) &&
    equal(beforeRecords.durable?.reviewLogs, afterRecords.durable?.reviewLogs);
}

function stateMatchesSnapshot(
  state: Record<string, unknown> | null,
  snapshot: StudyJourneySnapshot,
  deckId: string,
  cardId: string | null,
  side: "front" | "back" | null,
): boolean {
  const { durable, visible, session, card } = snapshotRecords(snapshot);
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
    visible.sessionSequence === session.sequence &&
    card?.id === cardId && currentCard.front_text === card.frontText &&
    (side === "front"
      ? visible.answerState === "withheld" && visible.answerSemantic === null &&
        normalizedText(visible.content) === normalizedText(card.frontText)
      : visible.answerState === "exposed" && visible.answerSemantic !== null &&
        validAnswerSemantic(visible.answerSemantic) && validAnswerSemantic(durable?.answerSemantic) &&
        equal(visible.answerSemantic, durable?.answerSemantic)) &&
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
    return fail(`study-${inventory.failureCode}`, "tool-inventory");
  }
  if (!toolContractsMatch(evidence)) {
    return fail("study-tool-contract-mismatch", "tool-contract");
  }
  if (!evidence.deckId || !evidence.cardId || !evidence.url.includes(`deck=${encodeURIComponent(evidence.deckId)}`)) {
    return fail("study-entry-mismatch", "entry-identity");
  }
  const front = stateFrom(evidence.getStateCall);
  const repeatedFront = stateFrom(evidence.repeatedGetStateCall);
  if (!stateMatchesSnapshot(front, evidence.afterRead, evidence.deckId, evidence.cardId, "front") ||
      !stateMatchesSnapshot(repeatedFront, evidence.afterRepeatedRead, evidence.deckId, evidence.cardId, "front") ||
      !equal(evidence.before.durable, evidence.afterRead.durable) ||
      !equal(evidence.afterRead.durable, evidence.afterRepeatedRead.durable)) {
    const visible = record(evidence.afterRead.visible);
    return fail("get-state-parity-or-mutation", typeof visible?.sideDetail === "string"
      ? `visible:${visible.sideDetail}`
      : "front-tool-visible-durable-parity");
  }
  if (errorCode(evidence.prematureRatingCall) !== "ANSWER_NOT_REVEALED" ||
      !equal(evidence.afterRepeatedRead, evidence.afterPrematureRating)) {
    return fail("premature-rating-contract-failed", "premature-rating-result-or-mutation");
  }
  const flip = decode(evidence.flipCall);
  const flipData = record(flip?.data);
  const reveal = record(flipData?.reveal);
  if (flip?.ok !== true) return fail("flip-transition-mismatch", "tool:flip-result");
  if (reveal?.changed !== true || reveal.idempotent !== false) {
    return fail("flip-transition-mismatch", "tool:first-reveal-flags");
  }
  const afterFlipVisible = record(evidence.afterFlip.visible);
  if (typeof afterFlipVisible?.sideDetail === "string") {
    return fail("flip-transition-mismatch", `visible:${afterFlipVisible.sideDetail}`);
  }
  if (!stateMatchesSnapshot(
    record(flipData?.state), evidence.afterFlip, evidence.deckId, evidence.cardId, "back",
  )) {
    return fail("flip-transition-mismatch", "flip-tool-visible-durable-parity");
  }
  if (!legalFirstRevealMutation(evidence.afterPrematureRating, evidence.afterFlip)) {
    return fail("flip-transition-mismatch", "durable:illegal-first-reveal-mutation");
  }
  const retry = decode(evidence.flipRetryCall);
  const retryData = record(retry?.data);
  const retryReveal = record(retryData?.reveal);
  if (retry?.ok !== true || retryReveal?.changed !== false || retryReveal.idempotent !== true ||
      !equal(evidence.afterFlip.durable, evidence.afterFlipRetry.durable) ||
      !stateMatchesSnapshot(record(retryData?.state), evidence.afterFlipRetry, evidence.deckId, evidence.cardId, "back")) {
    return fail("flip-idempotency-failed", "retry-result-parity-or-mutation");
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
  const nextCardId = typeof nextCard?.id === "string" ? nextCard.id : null;
  if (rated?.ok !== true || transition?.rating !== evidence.rating ||
      transition.reviewed_card_id !== evidence.cardId || transition.idempotent !== false ||
      nextCardId === null || nextCardId === evidence.cardId ||
      transition.next_card_id !== nextCardId ||
      afterRating.visible?.side !== "front" || afterRating.visible.sideDetail !== null ||
      matchingLogs.length !== 1 || afterRating.session?.completedPresentationCount !== 1 ||
      !reviewedSchedule || !scheduleAfter ||
      transition.next_due_at !== new Date(Number(reviewedSchedule.dueAt)).toISOString() ||
      scheduleAfter.dueAt !== reviewedSchedule.dueAt || scheduleAfter.reps !== reviewedSchedule.reps ||
      scheduleAfter.state !== reviewedSchedule.state ||
      !stateMatchesSnapshot(
        ratedState,
        evidence.afterRating,
        evidence.deckId,
        nextCardId,
        "front",
      )) {
    return fail("rating-transition-mismatch", "rating-result-parity-or-mutation");
  }
  if (evidence.browserErrors.length > 0) {
    return fail("study-journey-browser-errors", "browser-errors");
  }
  return { status: "passed", failureCode: null, failureDetail: null };
}
