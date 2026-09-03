import type { StudyJourneyCall, StudyJourneySnapshot } from "./webmcp-study-journey";

export type AdversarialAttempt = {
  label: string;
  call: StudyJourneyCall;
  after: StudyJourneySnapshot;
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
    stale: AdversarialAttempt;
    premature: AdversarialAttempt;
    collision: AdversarialAttempt;
    browserErrors: string[];
  };
  races: AdversarialRace[];
  browserErrors: string[];
};

export type AdversarialJourneyAssessment = {
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

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalid(call: StudyJourneyCall): boolean {
  return code(call) === "INVALID_INPUT" ||
    (call.status === "failed" && /parse input|invalid|schema|argument/i.test(call.error ?? ""));
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
    visible?.progressCurrent === session?.completedPresentationCount &&
    visible?.progressTotal === session?.plannedPresentationCount &&
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

function reviewOutcomeMatches(call: StudyJourneyCall, race: AdversarialRace): boolean {
  const data = dataFrom(call);
  const transition = record(data?.transition);
  const { schedule, reviewLogs } = snapshotParts(race.after);
  const matchingLogs = reviewLogs.filter((value) => {
    const log = record(value);
    return log?.cardId === race.cardId && log.rating === "good";
  });
  const committed = record(matchingLogs[0]);
  const committedAfter = record(committed?.after);
  const dueAt = Number(schedule?.dueAt);
  return data?.command_id === "race-review" || data?.command_id === "race-conflict-review"
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
    return equal(first, decode(race.calls[1]!)) && reviewOutcomeMatches(race.calls[0]!, race) &&
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
  const before = snapshotParts(race.before);
  const after = snapshotParts(race.after);
  const firstReadState = record(dataFrom(race.readCalls[0]!)?.state);
  const secondReadState = record(dataFrom(race.readCalls[1]!)?.state);
  return race.calls.length === 2 && successful(race.calls[0]!) &&
    code(race.calls[1]!) === "STALE_CARD" && race.readCalls.length === 2 &&
    race.readCalls.every(successful) && stateMatchesSnapshot(firstReadState, race.before, race) &&
    stateMatchesSnapshot(secondReadState, race.after, race) &&
    reviewOutcomeMatches(race.calls[0]!, race) &&
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
  if (validation.invalid.length < 4 || validation.invalid.some((attempt) =>
    !invalid(attempt.call) || !equal(validation.before, attempt.after)
  )) return { status: "failed", failureCode: "invalid-input-contract-failed" };
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
