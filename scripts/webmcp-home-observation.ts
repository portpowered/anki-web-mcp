export type HomeDeckObservation = {
  id: string;
  name: string;
  card_count: number;
  new_count: number;
  due_count: number;
  suspended_count: number;
  last_studied_at: string | null;
  can_start_session: boolean;
};

export type VisibleHomeDeckObservation = {
  id: string | null;
  name: string | null;
  card_count: number | null;
  new_count: number | null;
  due_count: number | null;
  /** The production row exposes suspension through recovery, not numeric text. */
  suspended_count: number | null;
  recovery_available: boolean;
  study_action: "start" | "resume" | null;
  study_keyboard_operable: boolean;
};

export type VisibleHomePageObservation = {
  state: "loading" | "empty" | "error" | "populated" | null;
  decks: VisibleHomeDeckObservation[];
};

/** Read only the semantic deck-row contract exposed by the production DOM. */
export function observeVisibleHomePage(
  root: ParentNode = document,
): VisibleHomePageObservation {
  const count = (row: ParentNode, field: string, label: string): number | null => {
    const candidates = row.querySelectorAll(`[data-deck-count="${field}"]`);
    if (candidates.length !== 1) return null;
    const text = candidates[0]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const match = new RegExp(
      `^(0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)\\s+${label}$`,
    ).exec(text);
    if (!match) return null;
    const value = Number(match[1]!.replaceAll(",", ""));
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const pageState = root.querySelector("[data-deck-page-state]")
    ?.getAttribute("data-deck-page-state") ?? null;
  return {
    state: pageState === "loading" || pageState === "empty" || pageState === "error" ||
        pageState === "populated"
      ? pageState
      : null,
    decks: Array.from(root.querySelectorAll<HTMLElement>("[data-deck-row]")).map((row) => {
      const study = row.querySelector<HTMLButtonElement>('[data-deck-action="study"]');
      const studyLabel = study?.getAttribute("aria-label") ?? "";
      const action = studyLabel.startsWith("Start studying ")
        ? "start" as const
        : studyLabel.startsWith("Resume studying ")
          ? "resume" as const
          : null;
      const recovery = row.querySelector<HTMLButtonElement>(
        '[data-deck-action="restore-suspended"]',
      );
      return {
        id: row.getAttribute("data-deck-id"),
        name: action === "start"
          ? studyLabel.slice("Start studying ".length)
          : action === "resume"
            ? studyLabel.slice("Resume studying ".length)
            : null,
        card_count: count(row, "total", "total"),
        new_count: count(row, "new", "new"),
        due_count: count(row, "due", "due"),
        // Production exposes only the recovery affordance for nonzero suspension.
        suspended_count: count(row, "suspended", "suspended"),
        recovery_available: recovery !== null && !recovery.disabled,
        study_action: action,
        study_keyboard_operable: study !== null && !study.disabled,
      };
    }),
  };
}

export type DurableHomeSnapshot = {
  capturedAt: number;
  decks: Array<{
    id: string;
    name: string;
    cardCount: number;
    sessionIntakeLimit: number;
    createdAt: number;
    lastStudiedAt: number | null;
  }>;
  cards: Array<{
    id: string;
    deckId: string;
    creationOrder: number;
  }>;
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
    intakeLimit: number;
    nextDayAt: number;
    queueEntries: Array<{
      cardId: string;
      dueAt: number;
      ordinal: number;
    }>;
    activeCardId: string | null;
    plannedPresentationCount: number;
    completedPresentationCount: number;
    currentSide: "front" | "back";
    startedAt: number;
    updatedAt: number;
    completedAt: number | null;
  }>;
};

export type DurableDeckMetadataObservation = {
  id: string;
  last_studied_at: string | null;
};

export class DurableHomeProjectionError extends Error {
  readonly code = "invalid-durable-home-snapshot" as const;

  constructor(readonly detail: `durable:${string}`) {
    super(`Invalid durable home snapshot: ${detail}`);
    this.name = "DurableHomeProjectionError";
  }
}

/**
 * Acquire the production home evidence from one read-only IndexedDB
 * transaction. This function is deliberately self-contained so Playwright can
 * execute it in the deployed page without importing application services.
 */
export async function acquireDurableHomeSnapshot(
  factory: IDBFactory = indexedDB,
  databaseName = "anki-web-mcp",
): Promise<DurableHomeSnapshot> {
  const request = <T>(operation: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
    });
  const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(
        transaction.error ?? new DOMException("Durable snapshot transaction aborted", "AbortError"),
      );
    });

  const database = await request(factory.open(databaseName));
  try {
    const transaction = database.transaction(
      ["decks", "cards", "schedules", "sessions"],
      "readonly",
    );
    const completed = transactionComplete(transaction);
    const [decks, cards, schedules, sessions] = await Promise.all([
      request(transaction.objectStore("decks").getAll()),
      request(transaction.objectStore("cards").getAll()),
      request(transaction.objectStore("schedules").getAll()),
      request(transaction.objectStore("sessions").getAll()),
    ]) as Array<Array<Record<string, unknown>>>;
    await completed;

    // Preserve exact stored values; validation must distinguish absent or
    // malformed fields from legitimate zero/null values.
    return {
      capturedAt: Date.now(),
      decks,
      cards,
      schedules,
      sessions,
    } as unknown as DurableHomeSnapshot;
  } finally {
    database.close();
  }
}

/** Normalize raw deck metadata without consuming either parity adapter. */
export function observeDurableDeckMetadata(
  snapshot: DurableHomeSnapshot,
): DurableDeckMetadataObservation[] {
  return snapshot.decks.map((deck) => ({
    id: deck.id,
    last_studied_at: deck.lastStudiedAt === null
      ? null
      : new Date(deck.lastStudiedAt).toISOString(),
  }));
}

/**
 * Project only durable IndexedDB records into the production home contract.
 * This deliberately does not consume a list_decks result or UI expectation.
 */
export function projectDurableHomeDecks(
  snapshot: DurableHomeSnapshot,
): HomeDeckObservation[] {
  const validated = validateDurableHomeSnapshot(snapshot);

  return [...validated.decks]
    .sort((left, right) => left.createdAt - right.createdAt
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id))
    .map((deck) => {
      const cards = validated.cards.filter((card) => card.deckId === deck.id);
      const schedules = validated.schedules.filter((schedule) => schedule.deckId === deck.id);
      const schedulesByCardId = new Map(schedules.map((schedule) => [schedule.cardId, schedule]));
      const incompleteSessions = validated.sessions.filter((session) =>
        session.deckId === deck.id && session.completedAt === null
      );
      const activeSession = incompleteSessions[0];
      const availableCardIds = activeSession === undefined
        ? selectIndependentIntake(cards, schedulesByCardId, deck.sessionIntakeLimit, validated.capturedAt)
        : activeSession.queueEntries.map((entry) => entry.cardId);
      let newCount = 0;
      let dueCount = 0;
      for (const cardId of availableCardIds) {
        const schedule = schedulesByCardId.get(cardId)!;
        if (schedule.state === "new") newCount += 1;
        else dueCount += 1;
      }

      return {
        id: deck.id,
        name: deck.name,
        card_count: cards.length,
        new_count: newCount,
        due_count: dueCount,
        suspended_count: schedules.filter((schedule) => schedule.suspended).length,
        last_studied_at: deck.lastStudiedAt === null
          ? null
          : new Date(deck.lastStudiedAt).toISOString(),
        can_start_session: activeSession !== undefined || availableCardIds.length > 0,
      };
    });
}

function validateDurableHomeSnapshot(snapshot: DurableHomeSnapshot): DurableHomeSnapshot {
  if (!isRecord(snapshot)) fail("snapshot");
  validEpoch(snapshot.capturedAt, "captured_at");
  if (!Array.isArray(snapshot.decks)) fail("decks");
  if (!Array.isArray(snapshot.cards)) fail("cards");
  if (!Array.isArray(snapshot.schedules)) fail("schedules");
  if (!Array.isArray(snapshot.sessions)) fail("sessions");

  const decksById = new Map<string, DurableHomeSnapshot["decks"][number]>();
  for (const deck of snapshot.decks) {
    if (!isRecord(deck)) fail("deck");
    nonEmptyString(deck.id, "deck_id");
    if (decksById.has(deck.id)) fail("duplicate_deck_id");
    nonEmptyString(deck.name, "deck_name");
    nonNegativeInteger(deck.cardCount, "card_count");
    positiveInteger(deck.sessionIntakeLimit, "session_intake_limit");
    validEpoch(deck.createdAt, "deck_created_at");
    nullableEpoch(deck.lastStudiedAt, "last_studied_at");
    if (deck.createdAt > snapshot.capturedAt) fail("deck_created_at");
    if (deck.lastStudiedAt !== null && deck.lastStudiedAt > snapshot.capturedAt) {
      fail("last_studied_at");
    }
    decksById.set(deck.id, deck);
  }

  const cardsById = new Map<string, DurableHomeSnapshot["cards"][number]>();
  const cardTotals = new Map<string, number>();
  for (const card of snapshot.cards) {
    if (!isRecord(card)) fail("card");
    nonEmptyString(card.id, "card_id");
    if (cardsById.has(card.id)) fail("duplicate_card_id");
    nonEmptyString(card.deckId, "card_deck_id");
    if (!decksById.has(card.deckId)) fail("card_deck_relationship");
    nonNegativeInteger(card.creationOrder, "card_creation_order");
    cardsById.set(card.id, card);
    cardTotals.set(card.deckId, (cardTotals.get(card.deckId) ?? 0) + 1);
  }
  for (const deck of snapshot.decks) {
    if (deck.cardCount !== (cardTotals.get(deck.id) ?? 0)) fail("card_count");
  }

  const schedulesByCardId = new Map<string, DurableHomeSnapshot["schedules"][number]>();
  for (const schedule of snapshot.schedules) {
    if (!isRecord(schedule)) fail("schedule");
    nonEmptyString(schedule.cardId, "schedule_card_id");
    if (schedulesByCardId.has(schedule.cardId)) fail("duplicate_schedule_card_id");
    const card = cardsById.get(schedule.cardId);
    if (card === undefined) fail("schedule_card_relationship");
    if (schedule.deckId !== card.deckId) fail("schedule_deck_relationship");
    validEpoch(schedule.dueAt, "schedule_due_at");
    if (!isScheduleState(schedule.state)) fail("schedule_state");
    nullableEpoch(schedule.lastReviewAt, "schedule_last_review_at");
    if (schedule.lastReviewAt !== null && schedule.lastReviewAt > snapshot.capturedAt) {
      fail("schedule_last_review_at");
    }
    if (typeof schedule.suspended !== "boolean") fail("schedule_suspended");
    schedulesByCardId.set(schedule.cardId, schedule);
  }
  for (const card of snapshot.cards) {
    if (!schedulesByCardId.has(card.id)) fail("missing_schedule");
  }

  const sessionIds = new Set<string>();
  const sessionKeys = new Set<string>();
  const incompleteDecks = new Set<string>();
  const cutoffByDeckDay = new Map<string, number>();
  for (const session of snapshot.sessions) {
    if (!isRecord(session)) fail("session");
    nonEmptyString(session.id, "session_id");
    if (sessionIds.has(session.id)) fail("duplicate_session_id");
    sessionIds.add(session.id);
    if (!decksById.has(session.deckId)) fail("session_deck_relationship");
    if (typeof session.dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(session.dayKey)) {
      fail("session_day_key");
    }
    positiveInteger(session.sequence, "session_sequence");
    const sessionKey = `${session.deckId}\0${session.dayKey}\0${session.sequence}`;
    if (sessionKeys.has(sessionKey)) fail("duplicate_session_sequence");
    sessionKeys.add(sessionKey);
    positiveInteger(session.intakeLimit, "session_intake_limit");
    if (session.intakeLimit !== decksById.get(session.deckId)!.sessionIntakeLimit) {
      fail("session_intake_limit_relationship");
    }
    validEpoch(session.nextDayAt, "session_next_day_at");
    validateSessionDayCutoff(session.dayKey, session.nextDayAt);
    validEpoch(session.startedAt, "session_started_at");
    validEpoch(session.updatedAt, "session_updated_at");
    nullableEpoch(session.completedAt, "session_completed_at");
    if (session.startedAt > session.updatedAt || session.updatedAt > snapshot.capturedAt) {
      fail("session_timestamps");
    }
    if (session.nextDayAt <= session.startedAt) fail("session_next_day_at");
    if (session.completedAt !== null && session.completedAt !== session.updatedAt) {
      fail("session_completion");
    }
    const cutoffKey = `${session.deckId}\0${session.dayKey}`;
    const knownCutoff = cutoffByDeckDay.get(cutoffKey);
    if (knownCutoff !== undefined && knownCutoff !== session.nextDayAt) {
      fail("session_cutoff_relationship");
    }
    cutoffByDeckDay.set(cutoffKey, session.nextDayAt);
    if (!Array.isArray(session.queueEntries)) fail("session_queue");
    nonNegativeInteger(session.plannedPresentationCount, "session_planned_count");
    nonNegativeInteger(session.completedPresentationCount, "session_completed_count");
    if (session.completedPresentationCount > session.plannedPresentationCount) {
      fail("session_progress");
    }
    if (session.plannedPresentationCount !==
      session.completedPresentationCount + session.queueEntries.length) {
      fail("session_progress");
    }
    if (session.currentSide !== "front" && session.currentSide !== "back") {
      fail("session_current_side");
    }
    const queueCards = new Set<string>();
    const queueOrdinals = new Set<number>();
    for (const entry of session.queueEntries) {
      if (!isRecord(entry)) fail("session_queue_entry");
      nonEmptyString(entry.cardId, "session_queue_card_id");
      if (queueCards.has(entry.cardId)) fail("duplicate_session_queue_card_id");
      queueCards.add(entry.cardId);
      nonNegativeInteger(entry.ordinal, "session_queue_ordinal");
      if (queueOrdinals.has(entry.ordinal)) fail("duplicate_session_queue_ordinal");
      queueOrdinals.add(entry.ordinal);
      validEpoch(entry.dueAt, "session_queue_due_at");
      const card = cardsById.get(entry.cardId);
      const schedule = schedulesByCardId.get(entry.cardId);
      if (card === undefined || schedule === undefined) fail("session_queue_card_relationship");
      if (card.deckId !== session.deckId || schedule.deckId !== session.deckId) {
        fail("session_queue_deck_relationship");
      }
      if (schedule.suspended) fail("session_queue_suspended");
      if (entry.dueAt !== schedule.dueAt) fail("session_queue_due_relationship");
      if (entry.dueAt >= session.nextDayAt) fail("session_queue_cutoff_relationship");
    }
    if (session.completedAt === null) {
      if (incompleteDecks.has(session.deckId)) fail("ambiguous_active_session");
      incompleteDecks.add(session.deckId);
      if (session.startedAt > snapshot.capturedAt || snapshot.capturedAt >= session.nextDayAt) {
        fail("stale_active_session");
      }
      if (session.queueEntries.length === 0) fail("session_completion");
      if (session.activeCardId !== null) {
        if (!queueCards.has(session.activeCardId)) fail("session_active_card_relationship");
        const active = session.queueEntries.find((entry) => entry.cardId === session.activeCardId)!;
        if (active.dueAt > snapshot.capturedAt) fail("session_active_card_relationship");
        const firstReady = [...session.queueEntries]
          .filter((entry) => entry.dueAt <= snapshot.capturedAt)
          .sort(compareQueueEntries)[0];
        if (firstReady?.cardId !== session.activeCardId) fail("session_active_card_relationship");
      } else if (session.queueEntries.some((entry) => entry.dueAt <= snapshot.capturedAt)) {
        fail("session_active_card_relationship");
      }
      if (session.currentSide === "back" && session.activeCardId === null) {
        fail("session_current_side");
      }
    } else if (
      session.queueEntries.length !== 0
      || session.activeCardId !== null
      || session.currentSide !== "front"
      || session.completedPresentationCount !== session.plannedPresentationCount
    ) {
      fail("session_completion");
    }
  }

  return snapshot;
}

function selectIndependentIntake(
  cards: DurableHomeSnapshot["cards"],
  schedulesByCardId: Map<string, DurableHomeSnapshot["schedules"][number]>,
  intakeLimit: number,
  capturedAt: number,
): string[] {
  const priorities = { learning: 0, relearning: 1, review: 2, new: 3 } as const;
  return cards
    .map((card) => ({ card, schedule: schedulesByCardId.get(card.id)! }))
    .filter(({ schedule }) => !schedule.suspended
      && (schedule.state === "new" || schedule.dueAt <= capturedAt))
    .sort((left, right) => priorities[left.schedule.state] - priorities[right.schedule.state]
      || (left.schedule.state === "new" && right.schedule.state === "new"
        ? left.card.creationOrder - right.card.creationOrder
        : left.schedule.dueAt - right.schedule.dueAt)
      || compareStrings(left.card.id, right.card.id))
    .slice(0, intakeLimit)
    .map(({ card }) => card.id);
}

function validateSessionDayCutoff(dayKey: string, nextDayAt: number): void {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const representedDay = new Date(Date.UTC(year, month - 1, day));
  if (representedDay.getUTCFullYear() !== year
    || representedDay.getUTCMonth() !== month - 1
    || representedDay.getUTCDate() !== day) {
    fail("session_day_key");
  }
  const nominalNextDay = Date.UTC(year, month - 1, day + 1);
  // Every current IANA civil offset falls within this deliberately generous
  // window. It validates the day/cutoff relationship without borrowing the
  // browser timezone that produced the durable record.
  if (Math.abs(nextDayAt - nominalNextDay) > 16 * 60 * 60 * 1_000) {
    fail("session_cutoff_relationship");
  }
}

function compareQueueEntries(
  left: DurableHomeSnapshot["sessions"][number]["queueEntries"][number],
  right: DurableHomeSnapshot["sessions"][number]["queueEntries"][number],
): number {
  return left.dueAt - right.dueAt
    || left.ordinal - right.ordinal
    || compareStrings(left.cardId, right.cardId);
}

function fail(detail: string): never {
  throw new DurableHomeProjectionError(`durable:${detail}`);
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
  if (typeof value !== "number" || !Number.isFinite(value)
    || Number.isNaN(new Date(value).getTime())) fail(detail);
}

function nullableEpoch(value: unknown, detail: string): asserts value is number | null {
  if (value !== null) validEpoch(value, detail);
}

function isScheduleState(
  value: unknown,
): value is DurableHomeSnapshot["schedules"][number]["state"] {
  return value === "new" || value === "learning" || value === "review" || value === "relearning";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseHomeDeckObservations(value: unknown): HomeDeckObservation[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: HomeDeckObservation[] = [];
  for (const candidate of value) {
    if (!isHomeDeckObservation(candidate)) return null;
    parsed.push(candidate);
  }
  return parsed;
}

function isHomeDeckObservation(value: unknown): value is HomeDeckObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const deck = value as Record<string, unknown>;
  return typeof deck.id === "string"
    && typeof deck.name === "string"
    && isCount(deck.card_count)
    && isCount(deck.new_count)
    && isCount(deck.due_count)
    && isCount(deck.suspended_count)
    && (deck.last_studied_at === null || isIsoDate(deck.last_studied_at))
    && typeof deck.can_start_session === "boolean";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string"
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}
