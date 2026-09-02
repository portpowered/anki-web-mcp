import { describe, expect, test } from "bun:test";

import type {
  CardRecord,
  DeckRecord,
  ScheduleRecord,
  SessionRecord,
} from "../../lib/domain/entities";
import {
  MemoryStudyDatabase,
  type StudyDatabase,
  type StudyStoreName,
  type StudyTransaction,
} from "../../lib/persistence";
import {
  SessionService,
  SuspensionService,
} from "../../lib/application";
import { FixedClock } from "../../lib/platform/clock";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const LATER = NOW + 60_000;
const DECK_ID = "deck-spanish";
const OTHER_DECK_ID = "deck-french";
const CURRENT_CARD_ID = "card-current";
const NEXT_CARD_ID = "card-next";
const OTHER_CARD_ID = "card-other";
const SESSION_ID = "session-one";

describe("SuspensionService", () => {
  test("requires a non-empty command ID before opening a write transaction", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const before = database.snapshot();
    const service = makeService(database);

    await expect(service.suspend(
      SESSION_ID,
      CURRENT_CARD_ID,
      undefined as unknown as string,
    )).rejects.toMatchObject({
      name: "SuspensionServiceError",
      code: "invalid-input",
    });
    await expect(service.suspend(SESSION_ID, CURRENT_CARD_ID, "  "))
      .rejects.toMatchObject({
        name: "SuspensionServiceError",
        code: "invalid-input",
      });
    expect(database.snapshot()).toEqual(before);
  });

  test("suspends every occurrence, advances to the next ready card, and preserves schedule memory", async () => {
    const originalSchedule = schedule(CURRENT_CARD_ID, {
      state: "learning",
      dueAt: NOW,
      stability: 2.5,
      difficulty: 6.2,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 4,
      lapses: 1,
      lastReviewAt: NOW - 10_000,
      learningSteps: 2,
      legacyEaseFactor: 2.1,
    });
    const originalSnapshot = structuredClone(originalSchedule);
    const database = new MemoryStudyDatabase(makeSeed({
      cards: [card(CURRENT_CARD_ID, DECK_ID, 1), card(NEXT_CARD_ID, DECK_ID, 2)],
      schedules: [
        originalSchedule,
        schedule(NEXT_CARD_ID, { dueAt: NOW, state: "review" }),
      ],
      session: makeSession({
        queueEntries: [
          { cardId: CURRENT_CARD_ID, dueAt: NOW, ordinal: 1 },
          { cardId: NEXT_CARD_ID, dueAt: NOW, ordinal: 2 },
          { cardId: CURRENT_CARD_ID, dueAt: LATER, ordinal: 3 },
        ],
        activeCardId: CURRENT_CARD_ID,
        plannedPresentationCount: 3,
        currentSide: "back",
      }),
    }));
    const service = makeService(database);

    const result = await service.suspend({
      sessionId: SESSION_ID,
      expectedCardId: CURRENT_CARD_ID,
      commandId: "suspend-current",
    });

    expect(result).toMatchObject({
      status: "suspended",
      kind: "suspended",
      changed: true,
      idempotent: false,
      suspendedCardId: CURRENT_CARD_ID,
      removedOccurrenceCount: 2,
      nextCardId: NEXT_CARD_ID,
      nextPresentationDueAt: NOW,
      waitingUntil: null,
      sessionState: "active",
      outcome: "active",
      session: {
        activeCardId: NEXT_CARD_ID,
        currentSide: "front",
        plannedPresentationCount: 1,
        completedPresentationCount: 0,
        completedAt: null,
        queueEntries: [{ cardId: NEXT_CARD_ID, dueAt: NOW, ordinal: 2 }],
        lastCommandIds: ["suspend-current"],
      },
      schedule: { ...originalSnapshot, suspended: true },
    });
    expect(database.snapshot().schedules).toEqual([
      { ...originalSnapshot, suspended: true },
      schedule(NEXT_CARD_ID, { dueAt: NOW, state: "review" }),
    ]);
    expect(database.snapshot().reviewLogs).toBeUndefined();
  });

  test("returns waiting when only delayed work remains and completes when the queue is empty", async () => {
    const waitingDatabase = new MemoryStudyDatabase(makeSeed({
      cards: [card(CURRENT_CARD_ID, DECK_ID, 1), card(NEXT_CARD_ID, DECK_ID, 2)],
      schedules: [
        schedule(CURRENT_CARD_ID, { dueAt: NOW, state: "review" }),
        schedule(NEXT_CARD_ID, { dueAt: LATER, state: "review" }),
      ],
      session: makeSession({
        queueEntries: [
          { cardId: CURRENT_CARD_ID, dueAt: NOW, ordinal: 1 },
          { cardId: CURRENT_CARD_ID, dueAt: LATER, ordinal: 3 },
          { cardId: NEXT_CARD_ID, dueAt: LATER + 1, ordinal: 2 },
        ],
        plannedPresentationCount: 3,
      }),
    }));
    const waiting = await makeService(waitingDatabase).suspend(
      SESSION_ID,
      CURRENT_CARD_ID,
      "suspend-waiting",
    );

    expect(waiting).toMatchObject({
      status: "suspended",
      sessionState: "waiting",
      outcome: "waiting",
      nextCardId: null,
      nextPresentationDueAt: LATER + 1,
      waitingUntil: LATER + 1,
      removedOccurrenceCount: 2,
      session: {
        activeCardId: null,
        currentSide: "front",
        plannedPresentationCount: 1,
        completedPresentationCount: 0,
        completedAt: null,
        queueEntries: [{ cardId: NEXT_CARD_ID, dueAt: LATER + 1, ordinal: 2 }],
      },
    });

    const completedDatabase = new MemoryStudyDatabase(makeSeed({
      schedules: [schedule(CURRENT_CARD_ID, { dueAt: NOW, state: "review" })],
      session: makeSession({
        queueEntries: [{ cardId: CURRENT_CARD_ID, dueAt: NOW, ordinal: 1 }],
        plannedPresentationCount: 1,
      }),
    }));
    const completed = await makeService(completedDatabase).suspend(
      SESSION_ID,
      CURRENT_CARD_ID,
      "suspend-complete",
    );

    expect(completed).toMatchObject({
      status: "suspended",
      sessionState: "completed",
      outcome: "completed",
      nextCardId: null,
      nextPresentationDueAt: null,
      waitingUntil: null,
      session: {
        activeCardId: null,
        queueEntries: [],
        plannedPresentationCount: 0,
        completedPresentationCount: 0,
        completedAt: NOW,
      },
    });
  });

  test("is idempotent before stale/completed guards and cannot suspend another card on retry", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const service = makeService(database);

    const first = await service.suspend(SESSION_ID, CURRENT_CARD_ID, "same-suspend");
    const afterFirst = database.snapshot();
    const retry = await service.suspend(SESSION_ID, NEXT_CARD_ID, "same-suspend");

    expect(retry).toMatchObject({
      status: "duplicate",
      kind: "duplicate",
      changed: false,
      idempotent: true,
      suspendedCardId: CURRENT_CARD_ID,
    });
    expect(database.snapshot()).toEqual(afterFirst);
    expect(first.session).toEqual(afterFirst.sessions?.[0] as SessionRecord);

    const beforeStale = database.snapshot();
    await expect(service.suspend(SESSION_ID, CURRENT_CARD_ID, "new-command"))
      .rejects.toMatchObject({
        name: "SuspensionServiceError",
        code: "stale-card",
      });
    expect(database.snapshot()).toEqual(beforeStale);

    const completedDatabase = new MemoryStudyDatabase(makeSeed({
      session: makeSession({ completedAt: NOW - 1, activeCardId: null, queueEntries: [] }),
      schedules: [schedule(CURRENT_CARD_ID, { dueAt: NOW, state: "review" })],
    }));
    const beforeCompleted = completedDatabase.snapshot();
    await expect(makeService(completedDatabase).suspend(
      SESSION_ID,
      CURRENT_CARD_ID,
      "completed-command",
    )).rejects.toMatchObject({ code: "completed-session" });
    expect(completedDatabase.snapshot()).toEqual(beforeCompleted);
  });

  test("rejects missing and invalid current state without mutation", async () => {
    const missingCardDatabase = new MemoryStudyDatabase(makeSeed({
      cards: [card(NEXT_CARD_ID, DECK_ID, 2)],
      schedules: [schedule(NEXT_CARD_ID, { dueAt: NOW, state: "review" })],
    }));
    const beforeMissingCard = missingCardDatabase.snapshot();
    await expect(makeService(missingCardDatabase).suspend(
      SESSION_ID,
      CURRENT_CARD_ID,
      "missing-card",
    )).rejects.toMatchObject({ code: "card-not-found" });
    expect(missingCardDatabase.snapshot()).toEqual(beforeMissingCard);

    const missingScheduleDatabase = new MemoryStudyDatabase(makeSeed({
      schedules: [schedule(NEXT_CARD_ID, { dueAt: NOW, state: "review" })],
    }));
    const beforeMissingSchedule = missingScheduleDatabase.snapshot();
    await expect(makeService(missingScheduleDatabase).suspend(
      SESSION_ID,
      CURRENT_CARD_ID,
      "missing-schedule",
    )).rejects.toMatchObject({ code: "schedule-not-found" });
    expect(missingScheduleDatabase.snapshot()).toEqual(beforeMissingSchedule);

    const invalidSessionDatabase = new MemoryStudyDatabase(makeSeed({
      session: makeSession({ currentSide: "front", activeCardId: null }),
    }));
    const beforeInvalidSession = invalidSessionDatabase.snapshot();
    await expect(makeService(invalidSessionDatabase).suspend(
      SESSION_ID,
      CURRENT_CARD_ID,
      "invalid-session",
    )).rejects.toMatchObject({ code: "stale-card" });
    expect(invalidSessionDatabase.snapshot()).toEqual(beforeInvalidSession);
  });

  test("rolls back schedule and session writes together", async () => {
    for (const failurePoint of ["schedule", "session"] as const) {
      const inner = new MemoryStudyDatabase(makeSeed());
      const before = inner.snapshot();
      const database = new FailAtWriteDatabase(inner, failurePoint);

      await expect(makeService(database).suspend(
        SESSION_ID,
        CURRENT_CARD_ID,
        `failure-${failurePoint}`,
      )).rejects.toMatchObject({
        name: "SuspensionServiceError",
        code: "persistence",
      });
      expect(inner.snapshot()).toEqual(before);
    }
  });

  test("restores only the requested deck, preserves exact schedule fields, and records an idempotent command", async () => {
    const suspendedSchedule = schedule(CURRENT_CARD_ID, {
      state: "relearning",
      dueAt: NOW + 123,
      stability: 1.25,
      difficulty: 8.75,
      elapsedDays: 3,
      scheduledDays: 7,
      reps: 9,
      lapses: 2,
      lastReviewAt: NOW - 99,
      learningSteps: 1,
      legacyEaseFactor: 2.4,
      suspended: true,
    });
    const otherDeckSuspended = schedule(OTHER_CARD_ID, {
      deckId: OTHER_DECK_ID,
      suspended: true,
      dueAt: NOW,
    });
    const database = new MemoryStudyDatabase({
      decks: [makeDeck(DECK_ID, 2), makeDeck(OTHER_DECK_ID, 1)],
      cards: [
        card(CURRENT_CARD_ID, DECK_ID, 1),
        card(NEXT_CARD_ID, DECK_ID, 2),
        card(OTHER_CARD_ID, OTHER_DECK_ID, 1),
      ],
      schedules: [
        suspendedSchedule,
        schedule(NEXT_CARD_ID, { dueAt: LATER, state: "review" }),
        otherDeckSuspended,
      ],
      sessions: [makeSession({ completedAt: NOW - 1, activeCardId: null, queueEntries: [] })],
    });
    const beforeSession = structuredClone(database.snapshot().sessions);
    const service = makeService(database);

    const restored = await service.restoreSuspended(DECK_ID, "restore-deck");

    expect(restored).toEqual({
      status: "restored",
      kind: "restored",
      changed: true,
      idempotent: false,
      deckId: DECK_ID,
      restoredCount: 1,
      restoredCardIds: [CURRENT_CARD_ID],
    });
    expect(database.snapshot().schedules).toEqual([
      { ...suspendedSchedule, suspended: false },
      schedule(NEXT_CARD_ID, { dueAt: LATER, state: "review" }),
      otherDeckSuspended,
    ]);
    expect(database.snapshot().sessions).toEqual(beforeSession);

    // A later suspension must not be affected by reuse of the first command.
    const laterSuspended = schedule("card-later", {
      deckId: DECK_ID,
      suspended: true,
      dueAt: NOW + 456,
    });
    await database.transaction("readwrite", ["schedules"], (transaction) => (
      transaction.putSchedule(laterSuspended)
    ));
    const duplicate = await service.restoreSuspended(DECK_ID, "restore-deck");
    expect(duplicate).toEqual({
      status: "already-restored",
      kind: "already-restored",
      changed: false,
      idempotent: true,
      deckId: DECK_ID,
      restoredCount: 1,
      restoredCardIds: [CURRENT_CARD_ID],
    });
    expect(database.snapshot().schedules?.find((item) => item.cardId === "card-later"))
      .toEqual(laterSuspended);

    const reopened = new MemoryStudyDatabase(database.snapshot());
    const duplicateAfterReload = await makeService(reopened).restoreSuspended(
      DECK_ID,
      "restore-deck",
    );
    expect(duplicateAfterReload).toEqual(duplicate);
    expect(reopened.snapshot().schedules?.find((item) => item.cardId === "card-later"))
      .toEqual(laterSuspended);
    expect(reopened.snapshot().schedules?.find((item) => item.cardId === OTHER_CARD_ID))
      .toEqual(otherDeckSuspended);
  });

  test("returns an idempotent zero-count result for an empty restore", async () => {
    const database = new MemoryStudyDatabase({
      decks: [makeDeck(DECK_ID, 1)],
      cards: [card(CURRENT_CARD_ID, DECK_ID, 1)],
      schedules: [schedule(CURRENT_CARD_ID, { dueAt: NOW, state: "review" })],
    });

    const result = await makeService(database).restoreSuspended(DECK_ID, "empty-restore");

    expect(result).toEqual({
      status: "already-restored",
      kind: "already-restored",
      changed: false,
      idempotent: true,
      deckId: DECK_ID,
      restoredCount: 0,
      restoredCardIds: [],
    });
  });

  test("restored cards enter a later intake without mutating completed history", async () => {
    const completed = makeSession("completed", 1, {
      queueEntries: [],
      activeCardId: null,
      plannedPresentationCount: 0,
      completedPresentationCount: 0,
      completedAt: NOW - 1,
    });
    const database = new MemoryStudyDatabase({
      decks: [makeDeck(DECK_ID, 1)],
      cards: [card(CURRENT_CARD_ID, DECK_ID, 1)],
      schedules: [schedule(CURRENT_CARD_ID, { dueAt: NOW, state: "review", suspended: true })],
      sessions: [completed],
    });
    const beforeCompleted = structuredClone(completed);
    const service = makeService(database);

    await service.restoreSuspended(DECK_ID, "restore-for-intake");
    const later = await new SessionService({
      database,
      clock: new FixedClock(NOW),
      timeZone: "UTC",
    }).startSession(DECK_ID);

    expect(later).toMatchObject({
      status: "created",
      session: {
        sequence: 2,
        activeCardId: CURRENT_CARD_ID,
        queueEntries: [{ cardId: CURRENT_CARD_ID, ordinal: 1 }],
      },
    });
    expect(database.snapshot().sessions?.find((session) => session.id === completed.id))
      .toEqual(beforeCompleted);
  });

  test("rolls back a bulk restore when a schedule write fails", async () => {
    const inner = new MemoryStudyDatabase({
      decks: [makeDeck(DECK_ID, 2)],
      schedules: [
        schedule(CURRENT_CARD_ID, { dueAt: NOW, state: "review", suspended: true }),
        schedule(NEXT_CARD_ID, { dueAt: NOW, state: "review", suspended: true }),
      ],
    });
    const before = inner.snapshot();
    const database = new FailAtWriteDatabase(inner, "schedule");

    await expect(makeService(database).restoreSuspended(DECK_ID, "restore-failure"))
      .rejects.toMatchObject({ code: "persistence" });
    expect(inner.snapshot()).toEqual(before);
  });
});

function makeService(database: StudyDatabase): SuspensionService {
  return new SuspensionService({
    database,
    clock: new FixedClock(NOW),
  });
}

function makeSeed(options: {
  decks?: readonly DeckRecord[];
  cards?: readonly CardRecord[];
  schedules?: readonly ScheduleRecord[];
  session?: SessionRecord;
} = {}): {
  decks: readonly DeckRecord[];
  cards: readonly CardRecord[];
  schedules: readonly ScheduleRecord[];
  sessions: readonly SessionRecord[];
} {
  return {
    decks: options.decks ?? [makeDeck(DECK_ID, 2)],
    cards: options.cards ?? [
      card(CURRENT_CARD_ID, DECK_ID, 1),
      card(NEXT_CARD_ID, DECK_ID, 2),
    ],
    schedules: options.schedules ?? [
      schedule(CURRENT_CARD_ID, { dueAt: NOW, state: "review" }),
      schedule(NEXT_CARD_ID, { dueAt: NOW, state: "review" }),
    ],
    sessions: options.session === undefined ? [makeSession()] : [options.session],
  };
}

function makeDeck(id: string, cardCount: number): DeckRecord {
  return {
    id,
    importId: "seed",
    sourceDeckId: null,
    name: id,
    cardCount,
    createdAt: NOW - 1_000,
    lastStudiedAt: null,
    sessionIntakeLimit: 20,
    schedulerConfigId: "deterministic",
  };
}

function card(id: string, deckId: string, creationOrder: number): CardRecord {
  return {
    id,
    deckId,
    noteId: `${id}-note`,
    sourceCardId: null,
    templateOrdinal: 0,
    frontHtml: `<p>${id}</p>`,
    backHtml: `<p>${id} answer</p>`,
    mediaRefs: [],
    creationOrder,
    contentWarnings: [],
  };
}

function schedule(
  cardId: string,
  overrides: Partial<ScheduleRecord> & { deckId?: string } = {},
): ScheduleRecord {
  const { deckId = DECK_ID, ...rest } = overrides;
  return {
    cardId,
    deckId,
    dueAt: NOW,
    stability: 4,
    difficulty: 5,
    elapsedDays: 1,
    scheduledDays: 4,
    reps: 3,
    lapses: 0,
    state: "review",
    lastReviewAt: NOW - 1_000,
    suspended: false,
    legacyEaseFactor: null,
    ...rest,
  };
}

function makeSession(overrides?: Partial<SessionRecord>): SessionRecord;
function makeSession(
  id: string,
  sequence: number,
  overrides?: Partial<SessionRecord>,
): SessionRecord;
function makeSession(
  idOrOverrides: string | Partial<SessionRecord> = SESSION_ID,
  sequenceOrOverrides: number | Partial<SessionRecord> = 1,
  maybeOverrides: Partial<SessionRecord> = {},
): SessionRecord {
  const id = typeof idOrOverrides === "string" ? idOrOverrides : SESSION_ID;
  const sequence = typeof idOrOverrides === "string"
    && typeof sequenceOrOverrides === "number"
    ? sequenceOrOverrides
    : 1;
  const overrides = typeof idOrOverrides === "string"
    ? typeof sequenceOrOverrides === "object" ? sequenceOrOverrides : maybeOverrides
    : idOrOverrides;
  return {
    id,
    deckId: DECK_ID,
    dayKey: "2026-09-01",
    sequence,
    intakeLimit: 20,
    nextDayAt: Date.parse("2026-09-02T00:00:00.000Z"),
    queueEntries: [
      { cardId: CURRENT_CARD_ID, dueAt: NOW, ordinal: 1 },
      { cardId: NEXT_CARD_ID, dueAt: NOW, ordinal: 2 },
    ],
    activeCardId: CURRENT_CARD_ID,
    plannedPresentationCount: 2,
    completedPresentationCount: 0,
    currentSide: "back",
    ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
    startedAt: NOW - 500,
    updatedAt: NOW - 500,
    completedAt: null,
    lastCommandIds: [],
    ...overrides,
  };
}

class FailAtWriteDatabase implements StudyDatabase {
  constructor(
    private readonly inner: StudyDatabase,
    private readonly failurePoint: "schedule" | "session",
  ) {}

  transaction<T>(
    mode: "readonly" | "readwrite",
    stores: readonly StudyStoreName[],
    work: (transaction: StudyTransaction) => Promise<T> | T,
  ): Promise<T> {
    return this.inner.transaction(mode, stores, async (transaction) => {
      const fail = async (point: typeof this.failurePoint): Promise<void> => {
        if (point === this.failurePoint) {
          throw new Error(`injected ${point} failure`);
        }
      };
      const wrapped: StudyTransaction = {
        getDeck: transaction.getDeck.bind(transaction),
        getCard: transaction.getCard.bind(transaction),
        getSchedule: transaction.getSchedule.bind(transaction),
        getSession: transaction.getSession.bind(transaction),
        getMeta: transaction.getMeta?.bind(transaction),
        listCards: transaction.listCards.bind(transaction),
        listSchedules: transaction.listSchedules.bind(transaction),
        listSessions: transaction.listSessions.bind(transaction),
        putDeck: transaction.putDeck.bind(transaction),
        putCard: transaction.putCard.bind(transaction),
        putSchedule: async (value) => {
          await transaction.putSchedule(value);
          await fail("schedule");
        },
        putSession: async (value) => {
          await transaction.putSession(value);
          await fail("session");
        },
        putReviewLog: transaction.putReviewLog?.bind(transaction),
        putMeta: transaction.putMeta?.bind(transaction),
      };
      return work(wrapped);
    });
  }

  close(): void {
    this.inner.close();
  }
}
