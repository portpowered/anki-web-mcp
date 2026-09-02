import { describe, expect, test } from "bun:test";

import type {
  AppliedSchedule,
  SchedulerAdapter,
  SchedulerLog,
} from "../../lib/domain/scheduler";
import type {
  CardRecord,
  DeckRecord,
  Rating,
  ReviewLogRecord,
  ScheduleRecord,
  SessionRecord,
} from "../../lib/domain/entities";
import type { Clock, IdGenerator } from "../../lib/domain/ports";
import {
  MemoryStudyDatabase,
  type StudyDatabase,
  type StudyStoreName,
  type StudyTransaction,
} from "../../lib/persistence";
import {
  ReviewService,
  SessionService,
} from "../../lib/application";
import { FixedClock } from "../../lib/platform/clock";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const NEXT_DAY = Date.parse("2026-09-02T00:00:00.000Z");
const DECK_ID = "deck-spanish";
const CARD_ID = "card-one";
const NEXT_CARD_ID = "card-two";
const SESSION_ID = "session-one";

describe("ReviewService", () => {
  test("applies one rating and atomically persists schedule, log, queue, session, and deck", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const clock = new FixedClock(NOW);
    const scheduler = new PredictableScheduler(NOW + 5 * 60_000);
    const service = makeService(database, scheduler, clock);

    const result = await service.rate({
      sessionId: SESSION_ID,
      cardId: CARD_ID,
      rating: "good",
      commandId: "command-good-1",
    });
    if (result.status !== "rated") throw new Error("expected a committed rating");

    expect(result).toMatchObject({
      status: "rated",
      kind: "rated",
      changed: true,
      idempotent: false,
      rating: "good",
      card: { id: CARD_ID },
      schedule: {
        cardId: CARD_ID,
        dueAt: NOW + 5 * 60_000,
        lastReviewAt: NOW,
      },
      transition: {
        reviewedCardId: CARD_ID,
        rating: "good",
        previousDueAt: NOW,
        nextDueAt: NOW + 5 * 60_000,
        nextCardId: NEXT_CARD_ID,
      },
      session: {
        activeCardId: NEXT_CARD_ID,
        currentSide: "front",
        completedPresentationCount: 1,
        plannedPresentationCount: 3,
        ratingCounts: { again: 0, hard: 0, good: 1, easy: 0 },
        completedAt: null,
        lastCommandIds: ["command-good-1"],
      },
    });
    expect(scheduler.appliedAt).toEqual([NOW]);
    expect(result.reviewLog).toMatchObject({
      id: "review-log-1",
      sessionId: SESSION_ID,
      deckId: DECK_ID,
      cardId: CARD_ID,
      rating: "good",
      reviewedAt: NOW,
      durationMs: null,
      commandId: "command-good-1",
      before: { dueAt: NOW, reps: 3 },
      after: { dueAt: NOW + 5 * 60_000, reps: 4 },
    });

    const snapshot = database.snapshot();
    expect(snapshot.schedules?.find((schedule) => schedule.cardId === CARD_ID))
      .toEqual(result.schedule);
    expect(snapshot.sessions).toEqual([result.session]);
    expect(snapshot.decks?.[0]?.lastStudiedAt).toBe(NOW);
    expect(snapshot.reviewLogs).toEqual([result.reviewLog]);
  });

  test("requeues every rating before the cutoff and reports waiting progress", async () => {
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      const database = new MemoryStudyDatabase(makeSeed({
        cards: [makeCard(CARD_ID)],
        schedules: [makeSchedule(CARD_ID, NOW)],
        session: makeSession({
          queueEntries: [{ cardId: CARD_ID, dueAt: NOW, ordinal: 1 }],
          activeCardId: CARD_ID,
          plannedPresentationCount: 1,
        }),
      }));
      const delayedAt = NOW + 60_000;
      const result = await makeService(
        database,
        new PredictableScheduler(delayedAt),
      ).rate(SESSION_ID, CARD_ID, rating, `delayed-${rating}`);

      expect(result).toMatchObject({
        status: "waiting",
        kind: "waiting",
        changed: true,
        idempotent: false,
        rating,
        nextCardId: null,
        nextPresentationDueAt: delayedAt,
        waitingUntil: delayedAt,
        session: {
          activeCardId: null,
          currentSide: "front",
          plannedPresentationCount: 2,
          completedPresentationCount: 1,
          completedAt: null,
          queueEntries: [{ cardId: CARD_ID, dueAt: delayedAt, ordinal: 2 }],
        },
      });
      expect(database.snapshot().sessions?.[0]).toMatchObject({
        activeCardId: null,
        plannedPresentationCount: 2,
        completedPresentationCount: 1,
        completedAt: null,
      });
      expect(database.snapshot().reviewLogs).toHaveLength(1);
    }
  });

  test("does not requeue ratings at or after the persisted local-day cutoff", async () => {
    for (const dueAt of [NEXT_DAY, NEXT_DAY + 1]) {
      for (const rating of ["again", "hard", "good", "easy"] as const) {
        const database = new MemoryStudyDatabase(makeSeed({
          cards: [makeCard(CARD_ID)],
          schedules: [makeSchedule(CARD_ID, NOW)],
          session: makeSession({
            queueEntries: [{ cardId: CARD_ID, dueAt: NOW, ordinal: 1 }],
            activeCardId: CARD_ID,
            plannedPresentationCount: 1,
          }),
        }));
        const result = await makeService(
          database,
          new PredictableScheduler(dueAt),
        ).rate(SESSION_ID, CARD_ID, rating, `cutoff-${dueAt}-${rating}`);

        expect(result).toMatchObject({
          status: "rated",
          rating,
          nextCardId: null,
          nextPresentationDueAt: null,
          session: {
            activeCardId: null,
            plannedPresentationCount: 1,
            completedPresentationCount: 1,
            completedAt: NOW,
            queueEntries: [],
          },
        });
      }
    }
  });

  test("completes the exhausted session and starts a later numbered intake", async () => {
    const database = new MemoryStudyDatabase(makeSeed({
      schedules: [
        makeSchedule(CARD_ID, NOW),
        makeSchedule(NEXT_CARD_ID, NOW),
      ],
      session: makeSession({
        queueEntries: [{ cardId: CARD_ID, dueAt: NOW, ordinal: 1 }],
        activeCardId: CARD_ID,
        plannedPresentationCount: 1,
        completedPresentationCount: 0,
      }),
    }));
    const clock = new FixedClock(NOW);
    const scheduler = new PredictableScheduler(NEXT_DAY);
    const reviewService = makeService(database, scheduler, clock);

    const rated = await reviewService.rate(SESSION_ID, CARD_ID, "good", "complete-1");
    expect(rated).toMatchObject({
      status: "rated",
      session: {
        sequence: 1,
        activeCardId: null,
        queueEntries: [],
        completedPresentationCount: 1,
        plannedPresentationCount: 1,
        completedAt: NOW,
      },
    });
    if (rated.status !== "rated") return;
    const completedHistory = structuredClone(rated.session);

    const later = new SessionService({
      database,
      clock,
      timeZone: "UTC",
      idGenerator: new SequentialIdGenerator(),
    });
    const result = await later.startSession(DECK_ID);

    expect(result).toMatchObject({
      status: "created",
      kind: "created",
      session: {
        sequence: 2,
        activeCardId: NEXT_CARD_ID,
        queueEntries: [{ cardId: NEXT_CARD_ID, ordinal: 1 }],
        plannedPresentationCount: 1,
        completedPresentationCount: 0,
        completedAt: null,
      },
    });
    expect(database.snapshot().sessions?.[0]).toEqual(completedHistory);
  });

  test("grows same-card progress across repeated ready requeues", async () => {
    const database = new MemoryStudyDatabase(makeSeed({
      cards: [makeCard(CARD_ID)],
      schedules: [makeSchedule(CARD_ID, NOW)],
      session: makeSession({
        queueEntries: [{ cardId: CARD_ID, dueAt: NOW, ordinal: 1 }],
        activeCardId: CARD_ID,
        plannedPresentationCount: 1,
      }),
    }));
    const scheduler = new PredictableScheduler(NOW - 1);
    const clock = new FixedClock(NOW);
    const service = makeService(database, scheduler, clock);
    const sessionService = new SessionService({
      database,
      clock,
      scheduler,
      idGenerator: new SequentialIdGenerator(),
    });

    const first = await service.rate(SESSION_ID, CARD_ID, "again", "repeat-1");
    expect(first.status).toBe("rated");
    await sessionService.reveal(SESSION_ID, CARD_ID);
    const second = await service.rate(SESSION_ID, CARD_ID, "hard", "repeat-2");

    expect(second).toMatchObject({
      status: "rated",
      session: {
        activeCardId: CARD_ID,
        plannedPresentationCount: 3,
        completedPresentationCount: 2,
        completedAt: null,
        queueEntries: [{ cardId: CARD_ID, dueAt: NOW - 1, ordinal: 3 }],
      },
    });
    expect(database.snapshot().reviewLogs).toHaveLength(2);
  });

  test("promotes delayed work exactly at due time after reload", async () => {
    const delayedAt = NOW + 60_000;
    const database = new MemoryStudyDatabase(makeSeed({
      cards: [makeCard(CARD_ID)],
      schedules: [makeSchedule(CARD_ID, NOW)],
      session: makeSession({
        queueEntries: [{ cardId: CARD_ID, dueAt: NOW, ordinal: 1 }],
        activeCardId: CARD_ID,
        plannedPresentationCount: 1,
      }),
    }));
    const result = await makeService(
      database,
      new PredictableScheduler(delayedAt),
    ).rate(SESSION_ID, CARD_ID, "good", "waiting-reload");
    expect(result.status).toBe("waiting");

    const reopened = new MemoryStudyDatabase(database.snapshot());
    const beforeDue = new SessionService({
      database: reopened,
      clock: new FixedClock(delayedAt - 1),
      timeZone: "UTC",
    });
    const stillWaiting = await beforeDue.startSession(DECK_ID);
    expect(stillWaiting).toMatchObject({
      status: "resumed",
      session: { activeCardId: null, completedAt: null },
    });

    const atDue = new SessionService({
      database: reopened,
      clock: new FixedClock(delayedAt),
      timeZone: "UTC",
    });
    const resumed = await atDue.startSession(DECK_ID);
    expect(resumed).toMatchObject({
      status: "resumed",
      session: {
        activeCardId: CARD_ID,
        currentSide: "front",
        plannedPresentationCount: 2,
        completedPresentationCount: 1,
        completedAt: null,
        queueEntries: [{ cardId: CARD_ID, dueAt: delayedAt, ordinal: 2 }],
      },
    });
  });

  test("is idempotent for retries and serializes concurrent commands", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const service = makeService(
      database,
      new PredictableScheduler(NOW + 5 * 60_000),
      new FixedClock(NOW),
    );

    const results = await Promise.all([
      service.rate(SESSION_ID, CARD_ID, "good", "same-command"),
      service.rate(SESSION_ID, CARD_ID, "good", "same-command"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "duplicate",
      "rated",
    ]);
    expect(database.snapshot().reviewLogs).toHaveLength(1);
    expect(database.snapshot().sessions?.[0]?.completedPresentationCount).toBe(1);

    const afterFirstCommit = database.snapshot();
    const retry = await service.rate({
      sessionId: SESSION_ID,
      expectedCardId: CARD_ID,
      rating: "good",
      commandId: "same-command",
    });
    expect(retry).toMatchObject({
      status: "duplicate",
      kind: "duplicate",
      changed: false,
      idempotent: true,
      reviewLog: { commandId: "same-command" },
    });
    expect(database.snapshot()).toEqual(afterFirstCommit);
  });

  test("rejects front, stale, completed, missing, and conflicting state without mutation", async () => {
    const frontDatabase = new MemoryStudyDatabase(makeSeed({
      session: makeSession({ currentSide: "front" }),
    }));
    const frontBefore = frontDatabase.snapshot();
    await expect(makeService(frontDatabase).rate(
      SESSION_ID,
      CARD_ID,
      "good",
      "front-command",
    )).rejects.toMatchObject({ code: "front-side" });
    expect(frontDatabase.snapshot()).toEqual(frontBefore);

    const staleDatabase = new MemoryStudyDatabase(makeSeed({
      session: makeSession({ currentSide: "back" }),
    }));
    const staleBefore = staleDatabase.snapshot();
    await expect(makeService(staleDatabase).rate(
      SESSION_ID,
      NEXT_CARD_ID,
      "good",
      "stale-command",
    )).rejects.toMatchObject({ code: "stale-card" });
    expect(staleDatabase.snapshot()).toEqual(staleBefore);

    const completedDatabase = new MemoryStudyDatabase(makeSeed({
      session: makeSession({ completedAt: NOW - 1, activeCardId: null }),
    }));
    const completedBefore = completedDatabase.snapshot();
    await expect(makeService(completedDatabase).rate(
      SESSION_ID,
      CARD_ID,
      "good",
      "completed-command",
    )).rejects.toMatchObject({ code: "completed-session" });
    expect(completedDatabase.snapshot()).toEqual(completedBefore);

    const missingScheduleDatabase = new MemoryStudyDatabase(makeSeed({ schedules: [] }));
    const missingScheduleBefore = missingScheduleDatabase.snapshot();
    await expect(makeService(missingScheduleDatabase).rate(
      SESSION_ID,
      CARD_ID,
      "good",
      "missing-schedule-command",
    )).rejects.toMatchObject({ code: "schedule-not-found" });
    expect(missingScheduleDatabase.snapshot()).toEqual(missingScheduleBefore);

    const missingDeckDatabase = new MemoryStudyDatabase(makeSeed({ decks: [] }));
    const missingDeckBefore = missingDeckDatabase.snapshot();
    await expect(makeService(missingDeckDatabase).rate(
      SESSION_ID,
      CARD_ID,
      "good",
      "missing-deck-command",
    )).rejects.toMatchObject({ code: "deck-not-found" });
    expect(missingDeckDatabase.snapshot()).toEqual(missingDeckBefore);

    const conflictingCommandDatabase = new MemoryStudyDatabase(makeSeed({
      reviewLogs: [makeReviewLog({ commandId: "used-command", rating: "again" })],
    }));
    const conflictingBefore = conflictingCommandDatabase.snapshot();
    await expect(makeService(conflictingCommandDatabase).rate(
      SESSION_ID,
      CARD_ID,
      "good",
      "used-command",
    )).rejects.toMatchObject({ code: "duplicate-command" });
    expect(conflictingCommandDatabase.snapshot()).toEqual(conflictingBefore);
  });

  test("rolls back every write boundary", async () => {
    for (const failurePoint of ["schedule", "reviewLog", "session", "deck"] as const) {
      const inner = new MemoryStudyDatabase(makeSeed());
      const before = inner.snapshot();
      const database = new FailAtWriteDatabase(inner, failurePoint);

      await expect(makeService(database).rate(
        SESSION_ID,
        CARD_ID,
        "good",
        `failure-${failurePoint}`,
      )).rejects.toMatchObject({ code: "persistence" });
      expect(inner.snapshot()).toEqual(before);
    }
  });

  test("SessionService exposes the guarded rating operation", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const service = new SessionService({
      database,
      clock: new FixedClock(NOW),
      scheduler: new PredictableScheduler(NOW + 5 * 60_000),
      idGenerator: new SequentialIdGenerator(),
    });

    await service.reveal(SESSION_ID, CARD_ID);
    const result = await service.rate(SESSION_ID, CARD_ID, "easy", "session-command");

    expect(result.status).toBe("rated");
    expect(database.snapshot().reviewLogs).toHaveLength(1);
  });
});

function makeService(
  database: StudyDatabase,
  scheduler = new PredictableScheduler(NOW + 5 * 60_000),
  clock: Clock = new FixedClock(NOW),
): ReviewService {
  return new ReviewService({ database, scheduler, clock });
}

function makeSeed(options: {
  decks?: readonly DeckRecord[];
  cards?: readonly CardRecord[];
  schedules?: readonly ScheduleRecord[];
  session?: SessionRecord;
  reviewLogs?: readonly ReviewLogRecord[];
} = {}): {
  decks: readonly DeckRecord[];
  cards: readonly CardRecord[];
  schedules: readonly ScheduleRecord[];
  sessions: readonly SessionRecord[];
  reviewLogs?: readonly ReviewLogRecord[];
} {
  return {
    decks: options.decks ?? [makeDeck()],
    cards: options.cards ?? [makeCard(CARD_ID), makeCard(NEXT_CARD_ID)],
    schedules: options.schedules ?? [
      makeSchedule(CARD_ID, NOW),
      makeSchedule(NEXT_CARD_ID, NOW),
    ],
    sessions: [options.session ?? makeSession()],
    reviewLogs: options.reviewLogs,
  };
}

function makeDeck(): DeckRecord {
  return {
    id: DECK_ID,
    importId: "seed",
    sourceDeckId: null,
    name: "Spanish",
    cardCount: 2,
    createdAt: NOW - 1_000,
    lastStudiedAt: null,
    sessionIntakeLimit: 20,
    schedulerConfigId: "deterministic",
  };
}

function makeCard(id: string): CardRecord {
  return {
    id,
    deckId: DECK_ID,
    noteId: `${id}-note`,
    sourceCardId: null,
    templateOrdinal: 0,
    frontHtml: `<p>${id}</p>`,
    backHtml: `<p>${id} answer</p>`,
    mediaRefs: [],
    creationOrder: id === CARD_ID ? 1 : 2,
    contentWarnings: [],
  };
}

function makeSchedule(cardId: string, dueAt: number): ScheduleRecord {
  return {
    cardId,
    deckId: DECK_ID,
    dueAt,
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
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    deckId: DECK_ID,
    dayKey: "2026-09-01",
    sequence: 1,
    intakeLimit: 20,
    nextDayAt: NEXT_DAY,
    queueEntries: [
      { cardId: CARD_ID, dueAt: NOW, ordinal: 1 },
      { cardId: NEXT_CARD_ID, dueAt: NOW, ordinal: 2 },
    ],
    activeCardId: CARD_ID,
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

function makeReviewLog(overrides: Partial<ReviewLogRecord> = {}): ReviewLogRecord {
  const before = makeSchedule(CARD_ID, NOW);
  const after = { ...before, dueAt: NOW + 5 * 60_000, reps: 1 };
  return {
    id: "review-log-existing",
    sessionId: SESSION_ID,
    deckId: DECK_ID,
    cardId: CARD_ID,
    rating: "good",
    reviewedAt: NOW - 1,
    durationMs: null,
    before,
    after,
    commandId: "existing-command",
    ...overrides,
  };
}

class PredictableScheduler implements SchedulerAdapter {
  readonly appliedAt: number[] = [];

  constructor(private readonly dueAt: number) {}

  createNewCard(now: Date): ScheduleRecord {
    return makeSchedule(CARD_ID, now.getTime());
  }

  preview(): never {
    throw new Error("preview is not used by this test scheduler");
  }

  apply(schedule: ScheduleRecord, rating: Rating, now: Date): AppliedSchedule {
    const reviewedAt = now.getTime();
    this.appliedAt.push(reviewedAt);
    const nextSchedule: ScheduleRecord = {
      ...schedule,
      dueAt: this.dueAt,
      stability: schedule.stability + 1,
      reps: schedule.reps + 1,
      lastReviewAt: reviewedAt,
    };
    const log: SchedulerLog = {
      rating,
      state: nextSchedule.state,
      dueAt: nextSchedule.dueAt,
      stability: nextSchedule.stability,
      difficulty: nextSchedule.difficulty,
      elapsedDays: nextSchedule.elapsedDays,
      lastElapsedDays: schedule.elapsedDays,
      scheduledDays: nextSchedule.scheduledDays,
      learningSteps: nextSchedule.learningSteps ?? 0,
      reviewedAt,
    };
    return { schedule: nextSchedule, log };
  }

  retrievability(): null {
    return null;
  }
}

class SequentialIdGenerator implements IdGenerator {
  private value = 1;

  next(namespace = "id"): string {
    return `${namespace}-${this.value++}`;
  }
}

class FailAtWriteDatabase implements StudyDatabase {
  constructor(
    private readonly inner: StudyDatabase,
    private readonly failurePoint: "schedule" | "reviewLog" | "session" | "deck",
  ) {}

  transaction<T>(
    mode: "readonly" | "readwrite",
    stores: readonly StudyStoreName[],
    work: (transaction: StudyTransaction) => Promise<T> | T,
  ): Promise<T> {
    return this.inner.transaction(mode, stores, async (transaction) => {
      const fail = async (point: typeof this.failurePoint): Promise<void> => {
        if (point === this.failurePoint) throw new Error(`injected ${point} failure`);
      };
      const wrapped: StudyTransaction = {
        getDeck: transaction.getDeck.bind(transaction),
        getCard: transaction.getCard.bind(transaction),
        getSchedule: transaction.getSchedule.bind(transaction),
        getSession: transaction.getSession.bind(transaction),
        getReviewLog: transaction.getReviewLog?.bind(transaction),
        getReviewLogByCommandId: transaction.getReviewLogByCommandId?.bind(transaction),
        listCards: transaction.listCards.bind(transaction),
        listSchedules: transaction.listSchedules.bind(transaction),
        listSessions: transaction.listSessions.bind(transaction),
        putCard: transaction.putCard.bind(transaction),
        putSchedule: async (schedule) => {
          await transaction.putSchedule(schedule);
          await fail("schedule");
        },
        putReviewLog: async (reviewLog) => {
          if (transaction.putReviewLog === undefined) throw new Error("missing log store");
          await transaction.putReviewLog(reviewLog);
          await fail("reviewLog");
        },
        putSession: async (session) => {
          await transaction.putSession(session);
          await fail("session");
        },
        putDeck: async (deck) => {
          await transaction.putDeck(deck);
          await fail("deck");
        },
      };
      return work(wrapped);
    });
  }

  close(): void {
    this.inner.close();
  }
}
