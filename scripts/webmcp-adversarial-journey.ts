import type { StudyJourneyCall, StudyJourneySnapshot } from "./webmcp-study-journey";
import {
  activeStudyToolNames,
  assessProductionInventory,
  type ProductionToolName,
} from "./webmcp-production-contract";
import {
  projectDurableVisibleStudyProgress,
} from "./webmcp-study-progress";
import { assessNativeInputRejection } from "./webmcp-native-input-rejection";

export type AdversarialInvocation = {
  intendedToolName: ProductionToolName;
  acquiredToolName: string | null;
  availableToolNames: string[];
  source: string;
  executeStarted: boolean;
};

export type AdversarialOutcome = {
  label: string;
  call: StudyJourneyCall;
  after: StudyJourneySnapshot;
};

export type AdversarialAttempt = AdversarialOutcome & {
  input: string;
  invocation: AdversarialInvocation;
  before: StudyJourneySnapshot;
};

export type AdversarialControl = {
  input: string;
  invocation: AdversarialInvocation;
  call: StudyJourneyCall;
};

export type AdversarialRace = {
  kind: "review" | "suspend" | "restore" | "conflict";
  deckId: string;
  cardId: string;
  before: StudyJourneySnapshot;
  after: StudyJourneySnapshot;
  calls: StudyJourneyCall[];
  readCalls: StudyJourneyCall[];
};

export type AdversarialJourneyEvidence = {
  validation: {
    before: StudyJourneySnapshot;
    invalid: AdversarialAttempt[];
    control: AdversarialControl;
    stale: AdversarialOutcome;
    premature: AdversarialOutcome;
    collision: AdversarialOutcome;
    browserErrors: string[];
  };
  races: AdversarialRace[];
  browserErrors: string[];
};

export type AdversarialJourneyAssessment = {
  status: "passed" | "failed";
  failureCode: string | null;
  failureDetail?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decode(call: StudyJourneyCall): Record<string, unknown> | null {
  if (call.status !== "passed") return null;
  try {
    return record(typeof call.result === "string" ? JSON.parse(call.result) : call.result);
  } catch {
    return null;
  }
}

function code(call: StudyJourneyCall): string | null {
  const error = record(decode(call)?.error);
  return typeof error?.code === "string" ? error.code : null;
}

function acceptedInvalidInput(call: StudyJourneyCall): boolean {
  const result = decode(call);
  const error = record(result?.error);
  return call.status === "passed" && result?.ok === false && !("data" in (result ?? {})) &&
    error?.code === "INVALID_INPUT" &&
    typeof error.message === "string" && error.message.trim().length > 0 &&
    error.recoverable === true &&
    typeof error.suggested_action === "string" && error.suggested_action.trim().length > 0;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function captureTime(snapshot: StudyJourneySnapshot): number | null {
  const value = durable(snapshot)?.capturedAt;
  return typeof value === "number" && Number.isFinite(value) &&
    !Number.isNaN(new Date(value).getTime())
    ? value
    : null;
}

function materialSnapshot(snapshot: StudyJourneySnapshot): StudyJourneySnapshot {
  const durableState = durable(snapshot);
  if (!durableState) return snapshot;
  const { capturedAt: _capturedAt, ...materialDurable } = durableState;
  void _capturedAt;
  return { ...snapshot, durable: materialDurable };
}

function invalidInputFailure(detail: string): AdversarialJourneyAssessment {
  return {
    status: "failed",
    failureCode: "invalid-input-contract-failed",
    failureDetail: detail,
  };
}

function assessInvalidAttempt(
  attempt: AdversarialAttempt,
): AdversarialJourneyAssessment | null {
  if (attempt.label === "malformed") {
    const native = assessNativeInputRejection({
      label: attempt.label,
      serializedInput: attempt.input,
      expectedToolNames: activeStudyToolNames,
      invocation: attempt.invocation,
      call: attempt.call,
    });
    if (!native.accepted) {
      return invalidInputFailure(`native-${native.failure}:${attempt.label}:${native.detail}`);
    }
  } else {
    if (!currentInvocation(attempt.invocation)) {
      return invalidInputFailure(`intended-invocation:${attempt.label}`);
    }
    if (!acceptedInvalidInput(attempt.call)) {
      return invalidInputFailure(`response-contract:${attempt.label}`);
    }
  }

  const beforeCapturedAt = captureTime(attempt.before);
  if (beforeCapturedAt === null) return invalidInputFailure(`capture-time:${attempt.label}:before-invalid`);
  const afterCapturedAt = captureTime(attempt.after);
  if (afterCapturedAt === null) return invalidInputFailure(`capture-time:${attempt.label}:after-invalid`);
  if (afterCapturedAt < beforeCapturedAt) {
    return invalidInputFailure(`capture-time:${attempt.label}:after-backward`);
  }
  if (!equal(materialSnapshot(attempt.before), materialSnapshot(attempt.after))) {
    return invalidInputFailure(`material-mutation:${attempt.label}`);
  }
  return null;
}

function currentInvocation(invocation: AdversarialInvocation): boolean {
  const inventory = assessProductionInventory(
    invocation.availableToolNames,
    activeStudyToolNames,
  );
  return inventory.status === "passed" && invocation.source === "current-registration" &&
    invocation.intendedToolName === "flip" && invocation.acquiredToolName === "flip" &&
    invocation.executeStarted;
}

function validControl(control: AdversarialControl): boolean {
  if (!currentInvocation(control.invocation) || !validFlipInput(control.input)) return false;
  const result = decode(control.call);
  return control.call.status === "passed" && result?.ok === true && record(result.data) !== null &&
    !("error" in result);
}

const requiredInvalidLabels = ["missing", "malformed", "wrong-type", "extra"] as const;

function parsedInput(input: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(input));
  } catch {
    return null;
  }
}

function validFlipInput(input: string): boolean {
  const value = parsedInput(input);
  return value !== null && Object.keys(value).length === 2 &&
    typeof value.card_id === "string" && value.card_id.length > 0 &&
    typeof value.command_id === "string" && value.command_id.length > 0;
}

function matchesInvalidCase(attempt: AdversarialAttempt): boolean {
  const value = parsedInput(attempt.input);
  if (attempt.label === "malformed") return attempt.input === "null";
  if (!value) return false;
  if (attempt.label === "missing") return Object.keys(value).length === 0;
  if (attempt.label === "wrong-type") {
    return Object.keys(value).length === 2 && typeof value.card_id !== "string" &&
      typeof value.command_id !== "string";
  }
  return attempt.label === "extra" && Object.keys(value).length === 3 &&
    typeof value.card_id === "string" && value.card_id.length > 0 &&
    typeof value.command_id === "string" && value.command_id.length > 0 &&
    Object.hasOwn(value, "extra");
}

function completeInvalidInventory(attempts: AdversarialAttempt[]): boolean {
  if (attempts.length !== requiredInvalidLabels.length) return false;
  const labels = attempts.map((attempt) => attempt.label);
  return requiredInvalidLabels.every((label, index) => labels[index] === label) &&
    attempts.every(matchesInvalidCase);
}

function durable(snapshot: StudyJourneySnapshot): Record<string, unknown> | null {
  return record(snapshot.durable);
}

function successful(call: StudyJourneyCall): boolean {
  return decode(call)?.ok === true;
}

function snapshotParts(snapshot: StudyJourneySnapshot) {
  const durableState = durable(snapshot);
  return {
    visible: record(snapshot.visible),
    durable: durableState,
    session: record(durableState?.session),
    schedule: record(durableState?.schedule),
    schedules: Array.isArray(durableState?.schedules) ? durableState.schedules : [],
    reviewLogs: Array.isArray(durableState?.reviewLogs) ? durableState.reviewLogs : [],
  };
}

function isReadyFront(snapshot: StudyJourneySnapshot, previousCardId: string): boolean {
  const { visible, session } = snapshotParts(snapshot);
  return visible?.state === "active" && typeof visible.cardId === "string" &&
    visible.cardId !== previousCardId && visible.side === "front" &&
    visible.sideDetail === null && session?.activeCardId === visible.cardId &&
    session.currentSide === "front";
}

function projectedVisibleProgressMatches(
  snapshot: StudyJourneySnapshot,
  race: AdversarialRace,
): boolean {
  const { durable: durableState, visible, session, reviewLogs } = snapshotParts(snapshot);
  if (!durableState || !visible || !session || typeof session.id !== "string" ||
      !Array.isArray(durableState.decks) || !Array.isArray(durableState.cards) ||
      !Array.isArray(durableState.sessions)) return false;

  const selectedSession = durableState.sessions
    .map(record)
    .find((candidate) => candidate?.id === session.id);
  if (!selectedSession || !equal(selectedSession, session) ||
      !reviewLogsMatchSession(reviewLogs, durableState, selectedSession, race.deckId)) return false;

  try {
    const projected = projectDurableVisibleStudyProgress({
      capturedAt: durableState.capturedAt,
      deckId: race.deckId,
      sessionId: session.id,
      decks: durableState.decks,
      cards: durableState.cards,
      schedules: durableState.schedules,
      sessions: durableState.sessions,
      reviewLogs,
    });
    return visible.progressCurrent === projected.completedTodayCount &&
      visible.progressTotal === projected.todayCardCount;
  } catch {
    return false;
  }
}

function reviewLogsMatchSession(
  values: unknown[],
  durableState: Record<string, unknown>,
  session: Record<string, unknown>,
  deckId: string,
): boolean {
  const cards = Array.isArray(durableState.cards) ? durableState.cards.map(record) : [];
  const schedules = Array.isArray(durableState.schedules) ? durableState.schedules.map(record) : [];
  const cardIds = new Set(cards.flatMap((card) =>
    card?.deckId === deckId && typeof card.id === "string" ? [card.id] : []
  ));
  const sessionLogs = values.map(record).filter((log) => log?.sessionId === session.id);
  if (sessionLogs.length !== session.completedPresentationCount) return false;

  const observedRatings = { again: 0, hard: 0, good: 0, easy: 0 };
  const seenIds = new Set<string>();
  for (const log of values.map(record)) {
    if (!log || typeof log.id !== "string" || seenIds.has(log.id) ||
        log.deckId !== deckId || typeof log.cardId !== "string" ||
        !cardIds.has(log.cardId) || typeof log.sessionId !== "string" ||
        !["again", "hard", "good", "easy"].includes(String(log.rating)) ||
        typeof log.reviewedAt !== "number" || !Number.isFinite(log.reviewedAt) ||
        log.reviewedAt > Number(durableState.capturedAt) || !record(log.before) || !record(log.after)) {
      return false;
    }
    seenIds.add(log.id);
    if (log.sessionId === session.id) {
      observedRatings[log.rating as keyof typeof observedRatings] += 1;
    }
  }
  if (!equal(observedRatings, session.ratingCounts)) return false;

  const latestByCard = new Map<string, Record<string, unknown>>();
  for (const log of sessionLogs) {
    if (!log || typeof log.cardId !== "string") return false;
    const latest = latestByCard.get(log.cardId);
    if (!latest || Number(log.reviewedAt) > Number(latest.reviewedAt)) {
      latestByCard.set(log.cardId, log);
    }
  }
  return [...latestByCard].every(([cardId, log]) => {
    const schedule = schedules.find((candidate) => candidate?.cardId === cardId);
    const after = record(log.after);
    return schedule !== undefined && schedule !== null && after !== null &&
      ["dueAt", "state", "lastReviewAt", "reps"].every((key) => schedule[key] === after[key]);
  });
}

function stateMatchesSnapshot(
  value: unknown,
  snapshot: StudyJourneySnapshot,
  race: AdversarialRace,
): boolean {
  const state = record(value);
  const stateDeck = record(state?.deck);
  const stateSession = record(state?.session);
  const currentCard = record(state?.current_card);
  const { visible, session } = snapshotParts(snapshot);
  return state?.page === "study" && stateDeck?.id === race.deckId &&
    state?.status === visible?.state && stateSession?.id === session?.id &&
    stateSession?.sequence === session?.sequence &&
    stateSession?.completed_presentations === session?.completedPresentationCount &&
    stateSession?.planned_presentations === session?.plannedPresentationCount &&
    projectedVisibleProgressMatches(snapshot, race) &&
    currentCard?.id === visible?.cardId && currentCard?.side === visible?.side &&
    session?.activeCardId === visible?.cardId && session?.currentSide === visible?.side;
}

function dataFrom(call: StudyJourneyCall): Record<string, unknown> | null {
  return record(decode(call)?.data);
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function recordsById(values: unknown[]): Map<string, Record<string, unknown>> | null {
  const result = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    const item = record(value);
    if (!item || typeof item.id !== "string" || result.has(item.id)) return null;
    result.set(item.id, item);
  }
  return result;
}

function scheduleMatchesLogSnapshot(
  schedule: Record<string, unknown> | null,
  logged: Record<string, unknown> | null,
): boolean {
  if (!schedule || !logged ||
      !["dueAt", "state", "lastReviewAt", "reps"].every((key) => key in logged)) return false;
  return Object.entries(logged).every(([key, value]) => schedule[key] === value);
}

function compareQueueEntries(left: unknown, right: unknown): number {
  const leftEntry = record(left);
  const rightEntry = record(right);
  return Number(leftEntry?.dueAt) - Number(rightEntry?.dueAt) ||
    Number(leftEntry?.ordinal) - Number(rightEntry?.ordinal) ||
    String(leftEntry?.cardId).localeCompare(String(rightEntry?.cardId));
}

function validQueueEntry(value: unknown): boolean {
  const entry = record(value);
  return entry !== null && typeof entry.cardId === "string" &&
    typeof entry.dueAt === "number" && Number.isFinite(entry.dueAt) &&
    typeof entry.ordinal === "number" && Number.isFinite(entry.ordinal);
}

function reviewDurableEffectMatches(race: AdversarialRace, call: StudyJourneyCall): boolean {
  const before = snapshotParts(race.before);
  const after = snapshotParts(race.after);
  if (!before.durable || !after.durable || !before.session || !after.session) return false;

  const data = dataFrom(call);
  const matchingLog = after.reviewLogs.map(record).find((log) =>
    log !== null && log.commandId === data?.command_id &&
      log.cardId === race.cardId && log.rating === "good"
  );
  const loggedBefore = record(matchingLog?.before);
  const loggedAfter = record(matchingLog?.after);
  if (!matchingLog || matchingLog.sessionId !== before.session.id ||
      matchingLog.deckId !== race.deckId ||
      !scheduleMatchesLogSnapshot(before.schedule, loggedBefore) ||
      !scheduleMatchesLogSnapshot(after.schedule, loggedAfter) ||
      matchingLog.reviewedAt !== after.session.updatedAt ||
      loggedAfter?.lastReviewAt !== matchingLog.reviewedAt ||
      typeof loggedBefore?.reps !== "number" ||
      loggedAfter?.reps !== loggedBefore.reps + 1) return false;

  const beforeLogs = recordsById(before.reviewLogs);
  const afterLogs = recordsById(after.reviewLogs);
  if (!beforeLogs || !afterLogs || afterLogs.size !== beforeLogs.size + 1 ||
      [...beforeLogs].some(([id, value]) => !equal(afterLogs.get(id), value))) return false;

  const beforeSchedules = new Map(before.schedules.map((value) => {
    const item = record(value);
    return [item?.cardId, item] as const;
  }));
  const afterSchedules = new Map(after.schedules.map((value) => {
    const item = record(value);
    return [item?.cardId, item] as const;
  }));
  if (beforeSchedules.size !== afterSchedules.size ||
      [...beforeSchedules].some(([id, value]) => id !== race.cardId && !equal(afterSchedules.get(id), value))) {
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
  if (!equal(stableSession(before.session), stableSession(after.session))) return false;
  const beforeRatings = record(before.session.ratingCounts);
  const afterRatings = record(after.session.ratingCounts);
  if (!beforeRatings || !afterRatings || Number(afterRatings.good) !== Number(beforeRatings.good) + 1 ||
      ["again", "hard", "easy"].some((key) => afterRatings[key] !== beforeRatings[key])) return false;

  const beforeQueue = Array.isArray(before.session.queueEntries) ? before.session.queueEntries : null;
  const afterQueue = Array.isArray(after.session.queueEntries) ? after.session.queueEntries : null;
  const beforeCapturedAt = before.durable.capturedAt;
  const nextDayAt = before.session.nextDayAt;
  if (!beforeQueue || !afterQueue || !beforeQueue.every(validQueueEntry) ||
      !afterQueue.every(validQueueEntry) || typeof beforeCapturedAt !== "number" ||
      !Number.isFinite(beforeCapturedAt) || typeof nextDayAt !== "number" ||
      !Number.isFinite(nextDayAt)) return false;
  const currentOccurrence = [...beforeQueue]
    .filter((entry) => record(entry)?.cardId === race.cardId &&
      Number(record(entry)?.dueAt) <= beforeCapturedAt)
    .sort(compareQueueEntries)[0];
  if (!currentOccurrence || before.session.activeCardId !== race.cardId) return false;
  const expectedQueue = beforeQueue.filter((entry) => entry !== currentOccurrence &&
    Number(record(entry)?.dueAt) < nextDayAt);
  if (Number(after.schedule?.dueAt) < nextDayAt) {
    expectedQueue.push({
      cardId: race.cardId,
      dueAt: after.schedule?.dueAt,
      ordinal: Math.max(0, ...beforeQueue.map((entry) => Number(record(entry)?.ordinal))) + 1,
    });
  }
  expectedQueue.sort(compareQueueEntries);
  if (!equal(afterQueue, expectedQueue)) return false;
  const completedCount = Number(before.session.completedPresentationCount) + 1;
  if (after.session.completedPresentationCount !== completedCount ||
      after.session.plannedPresentationCount !== completedCount + expectedQueue.length) return false;
  const nextReady = expectedQueue.find((entry) =>
    Number(record(entry)?.dueAt) <= Number(after.durable?.capturedAt));
  if (after.session.activeCardId !== (record(nextReady)?.cardId ?? null) ||
      after.session.currentSide !== "front") return false;
  const expectedCompletedAt = expectedQueue.length === 0 ? after.session.updatedAt : null;
  if (after.session.completedAt !== expectedCompletedAt) return false;

  const beforeCommandIds = before.session.lastCommandIds;
  const afterCommandIds = after.session.lastCommandIds;
  const commandId = data?.command_id;
  if (!Array.isArray(beforeCommandIds) || !Array.isArray(afterCommandIds) ||
      typeof commandId !== "string" || beforeCommandIds.length > 64 ||
      beforeCommandIds.some((value, index) => typeof value !== "string" || value.trim() === "" ||
        beforeCommandIds.indexOf(value) !== index) || beforeCommandIds.includes(commandId) ||
      !equal(afterCommandIds, [...beforeCommandIds, commandId].slice(-64))) return false;

  const beforeCards = Array.isArray(before.durable.cards) ? before.durable.cards : [];
  const afterCards = Array.isArray(after.durable.cards) ? after.durable.cards : [];
  if (!equal(beforeCards, afterCards)) return false;
  const beforeSessions = recordsById(Array.isArray(before.durable.sessions) ? before.durable.sessions : []);
  const afterSessions = recordsById(Array.isArray(after.durable.sessions) ? after.durable.sessions : []);
  if (!beforeSessions || !afterSessions || beforeSessions.size !== afterSessions.size ||
      [...beforeSessions].some(([id, value]) => id !== before.session?.id && !equal(afterSessions.get(id), value))) {
    return false;
  }
  const beforeDecks = recordsById(Array.isArray(before.durable.decks) ? before.durable.decks : []);
  const afterDecks = recordsById(Array.isArray(after.durable.decks) ? after.durable.decks : []);
  if (!beforeDecks || !afterDecks || beforeDecks.size !== afterDecks.size) return false;
  return [...beforeDecks].every(([id, value]) => {
    const updated = afterDecks.get(id);
    if (!updated) return false;
    return id === race.deckId
      ? equal(withoutKey(value, "lastStudiedAt"), withoutKey(updated, "lastStudiedAt")) &&
        (!("lastStudiedAt" in updated) || updated.lastStudiedAt === matchingLog.reviewedAt)
      : equal(updated, value);
  });
}

function reviewOutcomeMatches(call: StudyJourneyCall, race: AdversarialRace): boolean {
  const data = dataFrom(call);
  const transition = record(data?.transition);
  const { schedule, reviewLogs } = snapshotParts(race.after);
  const matchingLogs = reviewLogs.filter((value) => {
    const log = record(value);
    return log?.cardId === race.cardId && log.rating === "good" &&
      log.commandId === data?.command_id;
  });
  const committed = record(matchingLogs[0]);
  const committedAfter = record(committed?.after);
  const dueAt = Number(schedule?.dueAt);
  const expectedCommandId = race.kind === "conflict" ? "race-conflict-review" : "race-review";
  return data?.command_id === expectedCommandId
    ? transition?.rating === "good" && transition.reviewed_card_id === race.cardId &&
      transition.idempotent === false && matchingLogs.length === 1 &&
      Number.isFinite(dueAt) && transition.next_due_at === new Date(dueAt).toISOString() &&
      committedAfter?.dueAt === schedule?.dueAt && committedAfter?.reps === schedule?.reps &&
      committedAfter?.state === schedule?.state &&
      transition.next_card_id === record(record(data?.state)?.current_card)?.id
    : false;
}

function oneEffectRace(race: AdversarialRace): boolean {
  const before = snapshotParts(race.before);
  const after = snapshotParts(race.after);
  if (!before.durable || !after.durable || race.calls.length !== 2 ||
      race.calls.some((call) => !successful(call)) ||
      race.readCalls.some((call) => !successful(call))) return false;

  if (race.kind === "review") {
    const first = decode(race.calls[0]!);
    const firstState = record(dataFrom(race.calls[0]!)?.state);
    return equal(first, decode(race.calls[1]!)) &&
      projectedVisibleProgressMatches(race.before, race) &&
      isReadyFront(race.after, race.cardId) &&
      reviewOutcomeMatches(race.calls[0]!, race) &&
      reviewDurableEffectMatches(race, race.calls[0]!) &&
      stateMatchesSnapshot(firstState, race.after, race) &&
      after.reviewLogs.length === before.reviewLogs.length + 1 &&
      Number(after.session?.completedPresentationCount) ===
        Number(before.session?.completedPresentationCount) + 1;
  }
  if (race.kind === "suspend") {
    const data = dataFrom(race.calls[0]!);
    const suspension = record(data?.suspension);
    const state = record(data?.state);
    const removed = Number(before.session?.plannedPresentationCount) -
      Number(after.session?.plannedPresentationCount);
    const queue = Array.isArray(after.session?.queueEntries) ? after.session.queueEntries : [];
    return equal(decode(race.calls[0]!), decode(race.calls[1]!)) &&
      isReadyFront(race.after, race.cardId) &&
      data?.command_id === "race-suspend" && suspension?.suspended_card_id === race.cardId &&
      suspension.idempotent === false && suspension.removed_occurrence_count === removed && removed >= 1 &&
      suspension.next_card_id === record(state?.current_card)?.id &&
      stateMatchesSnapshot(state, race.after, race) &&
      before.schedule?.suspended === false && after.schedule?.suspended === true &&
      queue.every((entry) => record(entry)?.cardId !== race.cardId) &&
      after.reviewLogs.length === before.reviewLogs.length;
  }
  if (race.kind === "restore") {
    const data = race.calls.map(dataFrom);
    if (data.some((value) => value === null)) return false;
    const [first, second] = data as [Record<string, unknown>, Record<string, unknown>];
    const deck = (Array.isArray(first.decks) ? first.decks : [])
      .map(record).find((candidate) => candidate?.id === race.deckId);
    const row = typeof after.visible?.row === "string" ? after.visible.row : "";
    const countParity = deck !== undefined && deck !== null && (
      row.includes(`${deck.card_count} cards`) ||
      (row.includes(`${deck.new_count} new`) && row.includes(`${deck.card_count} total`))
    );
    return first.page === "decks" && first.deck_id === race.deckId && first.command_id === "race-restore" &&
      first.restored_count === 1 && second.page === "decks" && second.deck_id === race.deckId &&
      second.command_id === "race-restore" && second.restored_count === 1 &&
      [first.idempotent, second.idempotent].filter((value) => value === false).length === 1 &&
      [first.idempotent, second.idempotent].filter((value) => value === true).length === 1 &&
      equal(withoutKey(first, "idempotent"), withoutKey(second, "idempotent")) &&
      before.schedule?.suspended === true && after.schedule?.suspended === false &&
      equal(withoutKey(before.schedule!, "suspended"), withoutKey(after.schedule!, "suspended")) &&
      equal(before.session, after.session) && after.reviewLogs.length === before.reviewLogs.length &&
      after.visible?.route === "deck-home" && deck !== undefined && deck !== null &&
      countParity && row.includes(String(deck.name)) && row.includes(`${deck.due_count} due`) &&
      after.visible.restoreAvailable === (Number(deck.suspended_count) > 0);
  }
  return false;
}

function conflictIsLegal(race: AdversarialRace): boolean {
  if (race.calls.length !== 2 || race.readCalls.length !== 2) return false;
  const before = snapshotParts(race.before);
  const after = snapshotParts(race.after);
  const firstReadState = record(dataFrom(race.readCalls[0]!)?.state);
  const secondReadState = record(dataFrom(race.readCalls[1]!)?.state);
  return successful(race.calls[0]!) && code(race.calls[1]!) === "STALE_CARD" &&
    projectedVisibleProgressMatches(race.before, race) &&
    isReadyFront(race.after, race.cardId) &&
    race.readCalls.every(successful) && stateMatchesSnapshot(firstReadState, race.before, race) &&
    stateMatchesSnapshot(secondReadState, race.after, race) &&
    reviewOutcomeMatches(race.calls[0]!, race) &&
    reviewDurableEffectMatches(race, race.calls[0]!) &&
    stateMatchesSnapshot(record(dataFrom(race.calls[0]!)?.state), race.after, race) &&
    after.reviewLogs.length === before.reviewLogs.length + 1 &&
    after.schedule?.suspended === false &&
    Number(after.session?.completedPresentationCount) ===
      Number(before.session?.completedPresentationCount) + 1;
}

/** Classify observable invalid-call and independently seeded concurrency evidence. */
export function assessAdversarialJourney(
  evidence: AdversarialJourneyEvidence,
): AdversarialJourneyAssessment {
  const validation = evidence.validation;
  if (!completeInvalidInventory(validation.invalid)) return invalidInputFailure("inventory:incomplete");
  if (!validControl(validation.control)) return invalidInputFailure("control:unusable");
  for (const attempt of validation.invalid) {
    const failure = assessInvalidAttempt(attempt);
    if (failure) return failure;
  }
  if (code(validation.stale.call) !== "STALE_CARD" ||
      !equal(validation.before, validation.stale.after)) {
    return { status: "failed", failureCode: "stale-card-contract-failed" };
  }
  if (code(validation.premature.call) !== "ANSWER_NOT_REVEALED" ||
      !equal(validation.before, validation.premature.after)) {
    return { status: "failed", failureCode: "answer-not-revealed-contract-failed" };
  }
  if (code(validation.collision.call) !== "DUPLICATE_COMMAND" ||
      !equal(validation.before, validation.collision.after)) {
    return { status: "failed", failureCode: "duplicate-command-contract-failed" };
  }
  const expected = ["review", "suspend", "restore", "conflict"] as const;
  for (const kind of expected) {
    const matches = evidence.races.filter((race) => race.kind === kind);
    if (matches.length !== 1) return { status: "failed", failureCode: `${kind}-race-missing` };
    const passed = kind === "conflict" ? conflictIsLegal(matches[0]!) : oneEffectRace(matches[0]!);
    if (!passed) return { status: "failed", failureCode: `${kind}-race-contract-failed` };
  }
  if (validation.browserErrors.length > 0 || evidence.browserErrors.length > 0) {
    return { status: "failed", failureCode: "adversarial-browser-errors" };
  }
  return { status: "passed", failureCode: null };
}
