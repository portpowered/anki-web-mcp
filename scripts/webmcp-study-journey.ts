import {
  activeStudyToolContracts,
  activeStudyToolNames,
  assessProductionInventory,
} from "./webmcp-production-contract";
import {
  DurableStudyProgressError,
  projectDurableVisibleStudyProgress,
} from "./webmcp-study-progress";

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
  flipCommandId: string;
  ratingCommandId: string;
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

function visibleProgressFailure(snapshot: StudyJourneySnapshot, deckId: string): string | null {
  const { durable, visible, session } = snapshotRecords(snapshot);
  const stores = record(durable?.stores);
  if (!durable || !visible || !session || !stores) return "durable:snapshot";
  try {
    const projected = projectDurableVisibleStudyProgress({
      capturedAt: durable.capturedAt,
      deckId,
      sessionId: session.id,
      decks: stores.decks,
      cards: stores.cards,
      schedules: stores.schedules,
      sessions: stores.sessions,
    });
    return visible.progressCurrent === projected.completedTodayCount &&
        visible.progressTotal === projected.todayCardCount
      ? null
      : "visible:progress";
  } catch (error) {
    return error instanceof DurableStudyProgressError ? error.detail : "durable:snapshot";
  }
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

function legalRatingMutation(
  before: StudyJourneySnapshot,
  after: StudyJourneySnapshot,
  reviewedCardId: string,
  commandId: string,
): boolean {
  const beforeRecords = snapshotRecords(before);
  const afterRecords = snapshotRecords(after);
  const beforeStores = record(beforeRecords.durable?.stores);
  const afterStores = record(afterRecords.durable?.stores);
  if (!beforeStores || !afterStores || !beforeRecords.session || !afterRecords.session) return false;

  const stableStores = (stores: Record<string, unknown>) => ({
    ...stores,
    schedules: undefined,
    sessions: undefined,
    reviewLogs: undefined,
  });
  if (!equal(stableStores(beforeStores), stableStores(afterStores))) return false;

  const beforeSchedules = Array.isArray(beforeStores.schedules) ? beforeStores.schedules : [];
  const afterSchedules = Array.isArray(afterStores.schedules) ? afterStores.schedules : [];
  const beforeSchedule = beforeSchedules.find((value) => record(value)?.cardId === reviewedCardId);
  const afterSchedule = afterSchedules.find((value) => record(value)?.cardId === reviewedCardId);
  const afterLogs = Array.isArray(afterStores.reviewLogs) ? afterStores.reviewLogs : [];
  const beforeLogs = Array.isArray(beforeStores.reviewLogs) ? beforeStores.reviewLogs : [];
  const committedLog = afterLogs.find((value) => record(value)?.commandId === commandId);
  const scheduleSnapshot = (value: unknown) => {
    const schedule = record(value);
    return schedule ? { ...schedule, cardId: undefined, deckId: undefined } : null;
  };
  if (!beforeSchedule || !afterSchedule || !committedLog ||
      !equal(record(committedLog)?.before, scheduleSnapshot(beforeSchedule)) ||
      !equal(record(committedLog)?.after, scheduleSnapshot(afterSchedule)) ||
      !equal(
        beforeSchedules.filter((value) => record(value)?.cardId !== reviewedCardId),
        afterSchedules.filter((value) => record(value)?.cardId !== reviewedCardId),
      ) || afterLogs.length !== beforeLogs.length + 1 ||
      !equal(beforeLogs, afterLogs.filter((value) => record(value)?.commandId !== commandId))) {
    return false;
  }

  const stableSession = (value: Record<string, unknown>) => ({
    ...value,
    queueEntries: undefined,
    activeCardId: undefined,
    currentSide: undefined,
    completedPresentationCount: undefined,
    plannedPresentationCount: undefined,
    ratingCounts: undefined,
    lastCommandIds: undefined,
    updatedAt: undefined,
    completedAt: undefined,
  });
  const beforeSessions = Array.isArray(beforeStores.sessions) ? beforeStores.sessions : [];
  const afterSessions = Array.isArray(afterStores.sessions) ? afterStores.sessions : [];
  const beforeSession = beforeSessions.find((value) => record(value)?.id === beforeRecords.session?.id);
  const afterSession = afterSessions.find((value) => record(value)?.id === beforeRecords.session?.id);
  return !!beforeSession && !!afterSession &&
    equal(stableSession(record(beforeSession)!), stableSession(record(afterSession)!)) &&
    equal(
      beforeSessions.filter((value) => record(value)?.id !== beforeRecords.session?.id),
      afterSessions.filter((value) => record(value)?.id !== beforeRecords.session?.id),
    );
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
      visibleProgressFailure(evidence.afterRead, evidence.deckId) !== null ||
      visibleProgressFailure(evidence.afterRepeatedRead, evidence.deckId) !== null ||
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
  if (!evidence.flipCommandId || flipData?.command_id !== evidence.flipCommandId) {
    return fail("flip-transition-mismatch", "tool:first-reveal-command-id");
  }
  if (reveal?.changed !== true || reveal.idempotent !== false) {
    return fail("flip-transition-mismatch", "tool:first-reveal-flags");
  }
  const afterFlipVisible = record(evidence.afterFlip.visible);
  if (typeof afterFlipVisible?.sideDetail === "string") {
    return fail("flip-transition-mismatch", `visible:${afterFlipVisible.sideDetail}`);
  }
  if (!stateMatchesSnapshot(
    record(flipData?.state), evidence.afterFlip, evidence.deckId, evidence.cardId, "back",
  ) || visibleProgressFailure(evidence.afterFlip, evidence.deckId) !== null) {
    return fail("flip-transition-mismatch", "flip-tool-visible-durable-parity");
  }
  if (!legalFirstRevealMutation(evidence.afterPrematureRating, evidence.afterFlip)) {
    return fail("flip-transition-mismatch", "durable:illegal-first-reveal-mutation");
  }
  const retry = decode(evidence.flipRetryCall);
  const retryData = record(retry?.data);
  const retryReveal = record(retryData?.reveal);
  if (retry?.ok !== true) return fail("flip-idempotency-failed", "tool:retry-result");
  if (retryData?.command_id !== evidence.flipCommandId) {
    return fail("flip-idempotency-failed", "tool:retry-command-id");
  }
  if (retryReveal?.changed !== false || retryReveal.idempotent !== true) {
    return fail("flip-idempotency-failed", "tool:retry-flags");
  }
  const afterRetryVisible = record(evidence.afterFlipRetry.visible);
  if (typeof afterRetryVisible?.sideDetail === "string") {
    return fail("flip-idempotency-failed", `visible:${afterRetryVisible.sideDetail}`);
  }
  if (!stateMatchesSnapshot(
    record(retryData?.state), evidence.afterFlipRetry, evidence.deckId, evidence.cardId, "back",
  ) || visibleProgressFailure(evidence.afterFlipRetry, evidence.deckId) !== null) {
    return fail("flip-idempotency-failed", "retry-tool-visible-durable-parity");
  }
  if (!equal(evidence.afterFlip.durable, evidence.afterFlipRetry.durable)) {
    return fail("flip-idempotency-failed", "durable:retry-mutation");
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
  if (rated?.ok !== true || !transition) {
    return fail("rating-transition-mismatch", "tool:rating-result");
  }
  if (ratedData?.command_id !== evidence.ratingCommandId ||
      transition.rating !== evidence.rating || transition.reviewed_card_id !== evidence.cardId ||
      transition.idempotent !== false || transition.next_card_id !== nextCardId) {
    return fail("rating-transition-mismatch", "tool:rating-transition");
  }
  if (matchingLogs.length !== 1 || committedLog?.sessionId !== afterRating.session?.id ||
      committedLog?.commandId !== evidence.ratingCommandId) {
    return fail("rating-transition-mismatch", "durable:review-log");
  }
  if (!reviewedSchedule || !scheduleAfter ||
      transition.next_due_at !== new Date(Number(reviewedSchedule.dueAt)).toISOString() ||
      scheduleAfter.dueAt !== reviewedSchedule.dueAt || scheduleAfter.reps !== reviewedSchedule.reps ||
      scheduleAfter.state !== reviewedSchedule.state) {
    return fail("rating-transition-mismatch", "durable:schedule");
  }
  if (afterRating.session?.completedPresentationCount !== 1 ||
      record(ratedState?.session)?.completed_presentations !==
        afterRating.session?.completedPresentationCount ||
      record(ratedState?.session)?.planned_presentations !==
        afterRating.session?.plannedPresentationCount) {
    return fail("rating-transition-mismatch", "durable:session");
  }
  const progressFailure = visibleProgressFailure(evidence.afterRating, evidence.deckId);
  if (progressFailure !== null) {
    return fail("rating-transition-mismatch", progressFailure);
  }
  if (nextCardId === null || nextCardId === evidence.cardId ||
      afterRating.visible?.cardId !== nextCardId) {
    return fail("rating-transition-mismatch", "visible:card");
  }
  if (afterRating.visible?.side !== "front" || afterRating.visible.sideDetail !== null) {
    return fail("rating-transition-mismatch", "visible:side");
  }
  if (!stateMatchesSnapshot(
    ratedState, evidence.afterRating, evidence.deckId, nextCardId, "front",
  )) {
    return fail("rating-transition-mismatch", "tool:serialized-state");
  }
  if (!legalRatingMutation(
    evidence.afterFlipRetry, evidence.afterRating, evidence.cardId, evidence.ratingCommandId,
  )) {
    return fail("rating-transition-mismatch", "durable:illegal-rating-mutation");
  }
  if (evidence.browserErrors.length > 0) {
    return fail("study-journey-browser-errors", "browser-errors");
  }
  return { status: "passed", failureCode: null, failureDetail: null };
}
