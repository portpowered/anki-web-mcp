export type DurableStudyProgressSnapshot = {
  capturedAt: number;
  deckId: string;
  sessionId: string;
  decks: Array<{ id: string }>;
  cards: Array<{ id: string; deckId: string }>;
  schedules: Array<{
    cardId: string;
    deckId: string;
    dueAt: number;
    state: "new" | "learning" | "review" | "relearning";
    lastReviewAt: number | null;
    suspended: boolean;
  }>;
  sessions: Array<{
    id: string;
    deckId: string;
    dayKey: string;
    sequence: number;
    nextDayAt: number;
    queueEntries: Array<{ cardId: string; dueAt: number; ordinal: number }>;
    activeCardId: string | null;
    plannedPresentationCount: number;
    completedPresentationCount: number;
    currentSide: "front" | "back";
    ratingCounts: { again: number; hard: number; good: number; easy: number };
    startedAt: number;
    updatedAt: number;
    completedAt: number | null;
  }>;
};

export type DurableVisibleStudyProgress = {
  completedTodayCount: number;
  todayCardCount: number;
  pendingTodayCount: number;
  sessionKind: "active" | "waiting" | "completed";
  activeCardId: string | null;
};

export class DurableStudyProgressError extends Error {
  readonly code = "invalid-durable-study-progress" as const;

  constructor(readonly detail: `durable:${string}`) {
    super(`Invalid durable study progress: ${detail}`);
  }
}

/**
 * Project the visible unique-card/day counters from persisted records only.
 * Presentation occurrences remain confined to session consistency checks and
 * never contribute directly to either visible counter.
 */
export function projectDurableVisibleStudyProgress(
  value: unknown,
): DurableVisibleStudyProgress {
  const snapshot = validateSnapshot(value);
  const session = snapshot.sessions.find((candidate) => candidate.id === snapshot.sessionId)!;
  const daySessions = snapshot.sessions.filter((candidate) =>
    candidate.deckId === snapshot.deckId && candidate.dayKey === session.dayKey
  );
  const dayStartedAt = Math.min(...daySessions.map((candidate) => candidate.startedAt));
  const completedCardIds = new Set(snapshot.schedules.flatMap((schedule) => (
    schedule.deckId === snapshot.deckId
      && schedule.lastReviewAt !== null
      && schedule.lastReviewAt >= dayStartedAt
      && schedule.lastReviewAt < session.nextDayAt
      && schedule.dueAt >= session.nextDayAt
      ? [schedule.cardId]
      : []
  )));
  const pendingCardIds = new Set(session.queueEntries.map((entry) => entry.cardId));
  const todayCardIds = new Set([...completedCardIds, ...pendingCardIds]);

  return {
    completedTodayCount: completedCardIds.size,
    todayCardCount: todayCardIds.size,
    pendingTodayCount: pendingCardIds.size,
    sessionKind: session.completedAt !== null
      ? "completed"
      : session.activeCardId === null ? "waiting" : "active",
    activeCardId: session.activeCardId,
  };
}

function validateSnapshot(value: unknown): DurableStudyProgressSnapshot {
  if (!isRecord(value)) fail("snapshot");
  validEpoch(value.capturedAt, "captured_at");
  nonEmptyString(value.deckId, "deck_id");
  nonEmptyString(value.sessionId, "session_id");
  const capturedAt = value.capturedAt;
  if (!Array.isArray(value.decks)) fail("decks");
  if (!Array.isArray(value.cards)) fail("cards");
  if (!Array.isArray(value.schedules)) fail("schedules");
  if (!Array.isArray(value.sessions)) fail("sessions");

  const deckIds = new Set<string>();
  for (const deck of value.decks) {
    if (!isRecord(deck)) fail("deck");
    nonEmptyString(deck.id, "deck_id");
    if (deckIds.has(deck.id)) fail("duplicate_deck_id");
    deckIds.add(deck.id);
  }
  if (!deckIds.has(value.deckId)) fail("deck_relationship");

  const cardsById = new Map<string, { id: string; deckId: string }>();
  for (const card of value.cards) {
    if (!isRecord(card)) fail("card");
    nonEmptyString(card.id, "card_id");
    nonEmptyString(card.deckId, "card_deck_id");
    if (cardsById.has(card.id)) fail("duplicate_card_id");
    if (!deckIds.has(card.deckId)) fail("card_deck_relationship");
    cardsById.set(card.id, card as { id: string; deckId: string });
  }

  const schedulesByCardId = new Map<string, DurableStudyProgressSnapshot["schedules"][number]>();
  for (const schedule of value.schedules) {
    if (!isRecord(schedule)) fail("schedule");
    nonEmptyString(schedule.cardId, "schedule_card_id");
    nonEmptyString(schedule.deckId, "schedule_deck_id");
    if (schedulesByCardId.has(schedule.cardId)) fail("duplicate_schedule_card_id");
    const card = cardsById.get(schedule.cardId);
    if (!card) fail("schedule_card_relationship");
    if (schedule.deckId !== card.deckId) fail("schedule_deck_relationship");
    validEpoch(schedule.dueAt, "schedule_due_at");
    nullableEpoch(schedule.lastReviewAt, "schedule_last_review_at");
    if (schedule.lastReviewAt !== null && schedule.lastReviewAt > value.capturedAt) {
      fail("schedule_last_review_at");
    }
    if (!isScheduleState(schedule.state)) fail("schedule_state");
    if (typeof schedule.suspended !== "boolean") fail("schedule_suspended");
    schedulesByCardId.set(
      schedule.cardId,
      schedule as DurableStudyProgressSnapshot["schedules"][number],
    );
  }
  for (const card of value.cards) {
    if (card.deckId === value.deckId && !schedulesByCardId.has(card.id)) fail("missing_schedule");
  }

  const sessionsById = new Map<string, DurableStudyProgressSnapshot["sessions"][number]>();
  const sequenceKeys = new Set<string>();
  const incompleteDeckDays = new Set<string>();
  const cutoffByDeckDay = new Map<string, number>();
  for (const candidate of value.sessions) {
    if (!isRecord(candidate)) fail("session");
    nonEmptyString(candidate.id, "session_id");
    nonEmptyString(candidate.deckId, "session_deck_id");
    if (sessionsById.has(candidate.id)) fail("duplicate_session_id");
    if (!deckIds.has(candidate.deckId)) fail("session_deck_relationship");
    if (typeof candidate.dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.dayKey)) {
      fail("session_day_key");
    }
    positiveInteger(candidate.sequence, "session_sequence");
    const sequenceKey = `${candidate.deckId}\0${candidate.dayKey}\0${candidate.sequence}`;
    if (sequenceKeys.has(sequenceKey)) fail("duplicate_session_sequence");
    sequenceKeys.add(sequenceKey);
    validEpoch(candidate.nextDayAt, "session_next_day_at");
    validateDayCutoff(candidate.dayKey, candidate.nextDayAt);
    validEpoch(candidate.startedAt, "session_started_at");
    validEpoch(candidate.updatedAt, "session_updated_at");
    nullableEpoch(candidate.completedAt, "session_completed_at");
    if (candidate.startedAt > candidate.updatedAt || candidate.updatedAt > capturedAt ||
      candidate.startedAt >= candidate.nextDayAt) fail("session_timestamps");
    const cutoffKey = `${candidate.deckId}\0${candidate.dayKey}`;
    const knownCutoff = cutoffByDeckDay.get(cutoffKey);
    if (knownCutoff !== undefined && knownCutoff !== candidate.nextDayAt) {
      fail("session_cutoff_relationship");
    }
    cutoffByDeckDay.set(cutoffKey, candidate.nextDayAt);
    if (!Array.isArray(candidate.queueEntries)) fail("session_queue");
    nonNegativeInteger(candidate.plannedPresentationCount, "session_planned_count");
    nonNegativeInteger(candidate.completedPresentationCount, "session_completed_count");
    if (!isRatingCounts(candidate.ratingCounts)) fail("session_rating_counts");
    const ratingTotal = Object.values(candidate.ratingCounts).reduce((sum, count) => sum + count, 0);
    if (ratingTotal !== candidate.completedPresentationCount ||
      candidate.plannedPresentationCount !==
        candidate.completedPresentationCount + candidate.queueEntries.length) {
      fail("session_progress");
    }
    if (candidate.currentSide !== "front" && candidate.currentSide !== "back") {
      fail("session_current_side");
    }
    if (candidate.activeCardId !== null) {
      nonEmptyString(candidate.activeCardId, "session_active_card_id");
    }
    const queueCards = new Set<string>();
    const queueOrdinals = new Set<number>();
    for (const entry of candidate.queueEntries) {
      if (!isRecord(entry)) fail("session_queue_entry");
      nonEmptyString(entry.cardId, "session_queue_card_id");
      nonNegativeInteger(entry.ordinal, "session_queue_ordinal");
      validEpoch(entry.dueAt, "session_queue_due_at");
      if (queueCards.has(entry.cardId)) fail("duplicate_session_queue_card_id");
      if (queueOrdinals.has(entry.ordinal)) fail("duplicate_session_queue_ordinal");
      queueCards.add(entry.cardId);
      queueOrdinals.add(entry.ordinal);
      const card = cardsById.get(entry.cardId);
      const schedule = schedulesByCardId.get(entry.cardId);
      if (!card || !schedule) fail("session_queue_card_relationship");
      if (card.deckId !== candidate.deckId || schedule.deckId !== candidate.deckId) {
        fail("session_queue_deck_relationship");
      }
      if (schedule.suspended) fail("session_queue_suspended");
      if (entry.dueAt !== schedule.dueAt) fail("session_queue_due_relationship");
      if (entry.dueAt >= candidate.nextDayAt) fail("session_queue_cutoff_relationship");
    }
    if (candidate.completedAt === null) {
      const incompleteKey = `${candidate.deckId}\0${candidate.dayKey}`;
      if (incompleteDeckDays.has(incompleteKey)) fail("ambiguous_active_session");
      incompleteDeckDays.add(incompleteKey);
      if (candidate.queueEntries.length === 0) fail("session_completion");
      if (candidate.activeCardId !== null) {
        if (!queueCards.has(candidate.activeCardId)) fail("session_active_card_relationship");
      }
      if (candidate.currentSide === "back" && candidate.activeCardId === null) {
        fail("session_current_side");
      }
      // Historical incomplete sessions are durable abandoned state. Their
      // ready queue may have become overdue since they were last selected, so
      // only the requested current-day session must agree with capturedAt.
      if (candidate.id === value.sessionId && candidate.activeCardId !== null) {
        const ready = [...candidate.queueEntries]
          .filter((entry) => entry.dueAt <= capturedAt)
          .sort(compareQueueEntries)[0];
        if (ready?.cardId !== candidate.activeCardId) fail("session_active_card_relationship");
      } else if (candidate.id === value.sessionId &&
        candidate.queueEntries.some((entry) => entry.dueAt <= capturedAt)) {
        fail("session_active_card_relationship");
      }
    } else if (candidate.completedAt !== candidate.updatedAt || candidate.queueEntries.length !== 0 ||
      candidate.activeCardId !== null || candidate.currentSide !== "front" ||
      candidate.completedPresentationCount !== candidate.plannedPresentationCount) {
      fail("session_completion");
    }
    sessionsById.set(
      candidate.id,
      candidate as DurableStudyProgressSnapshot["sessions"][number],
    );
  }

  const selected = sessionsById.get(value.sessionId);
  if (!selected || selected.deckId !== value.deckId) fail("session_identity");
  if (value.capturedAt >= selected.nextDayAt) fail("stale_session_identity");
  const latest = [...sessionsById.values()]
    .filter((candidate) => candidate.deckId === selected.deckId && candidate.dayKey === selected.dayKey)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .at(-1);
  if (latest?.id !== selected.id) fail("stale_session_identity");

  return value as unknown as DurableStudyProgressSnapshot;
}

function validateDayCutoff(dayKey: string, nextDayAt: number): void {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const representedDay = new Date(Date.UTC(year, month - 1, day));
  if (representedDay.getUTCFullYear() !== year || representedDay.getUTCMonth() !== month - 1 ||
    representedDay.getUTCDate() !== day) fail("session_day_key");
  const nominalNextDay = Date.UTC(year, month - 1, day + 1);
  if (Math.abs(nextDayAt - nominalNextDay) > 16 * 60 * 60 * 1_000) {
    fail("session_cutoff_relationship");
  }
}

function compareQueueEntries(
  left: DurableStudyProgressSnapshot["sessions"][number]["queueEntries"][number],
  right: DurableStudyProgressSnapshot["sessions"][number]["queueEntries"][number],
): number {
  return left.dueAt - right.dueAt || left.ordinal - right.ordinal || left.cardId.localeCompare(right.cardId);
}

function fail(detail: string): never {
  throw new DurableStudyProgressError(`durable:${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, detail: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) fail(detail);
}

function nonNegativeInteger(value: unknown, detail: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(detail);
}

function positiveInteger(value: unknown, detail: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(detail);
}

function validEpoch(value: unknown, detail: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) ||
    Number.isNaN(new Date(value).getTime())) fail(detail);
}

function nullableEpoch(value: unknown, detail: string): asserts value is number | null {
  if (value !== null) validEpoch(value, detail);
}

function isScheduleState(value: unknown): boolean {
  return value === "new" || value === "learning" || value === "review" || value === "relearning";
}

function isRatingCounts(value: unknown): value is Record<"again" | "hard" | "good" | "easy", number> {
  if (!isRecord(value)) return false;
  return ["again", "hard", "good", "easy"].every((rating) => {
    const count = value[rating];
    return Number.isSafeInteger(count) && (count as number) >= 0;
  });
}
