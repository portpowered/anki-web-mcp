import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import type {
  AppliedSchedule,
  SchedulerAdapter,
  SchedulerLog,
} from "../../lib/domain/scheduler";
import { createDeterministicSchedulerAdapter } from "../../lib/domain/scheduler";
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
  openIndexedDbStudyDatabase,
  seedStudyDatabase,
  type StudyDatabase,
  type StudyStoreName,
  type StudyTransaction,
} from "../../lib/persistence";
import {
  ReviewService,
  RatingPreviewSnapshotStore,
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
  test("rolls back a late rating after its route commit lease expires", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const before = database.snapshot();

    await expect(makeService(database).rate({
      sessionId: SESSION_ID,
      expectedCardId: CARD_ID,
      rating: "good",
      commandId: "expired-route",
      canCommit: () => false,
    })).rejects.toMatchObject({ code: "cancelled" });

    expect(database.snapshot()).toEqual(before);
  });

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

  test("commits, reloads, and deduplicates a rating through production IndexedDB", async () => {
    const factory = new IDBFactory();
    const databaseName = "review-service-native-commit";
    const database = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    await seedStudyDatabase(database, makeSeed());

    const rated = await makeService(database).rate(
      SESSION_ID,
      CARD_ID,
      "good",
      "native-commit",
    );
    expect(rated.status).toBe("rated");
    if (rated.status === "duplicate") throw new Error("expected a committed rating");
    database.close();

    const reopened = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    const retry = await makeService(reopened).rate(
      SESSION_ID,
      CARD_ID,
      "good",
      "native-commit",
    );
    expect(retry).toMatchObject({
      status: "duplicate",
      changed: false,
      idempotent: true,
      reviewLog: { commandId: "native-commit" },
    });
    const persisted = await readStudyState(reopened);
    expect(persisted.reviewLogs).toHaveLength(1);
    expect(persisted.sessions[0]?.completedPresentationCount).toBe(1);
    expect(persisted.schedules.find((item) => item.cardId === CARD_ID))
      .toEqual(rated.schedule);
    expect(persisted.decks[0]?.lastStudiedAt).toBe(NOW);
    reopened.close();
  });

  test("serializes distinct native rating commands so only one presentation commits", async () => {
    const factory = new IDBFactory();
    const database = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: "review-service-native-concurrency",
    });
    await seedStudyDatabase(database, makeSeed());
    const service = makeService(database);

    const outcomes = await Promise.allSettled([
      service.rate(SESSION_ID, CARD_ID, "good", "native-concurrent-1"),
      service.rate(SESSION_ID, CARD_ID, "easy", "native-concurrent-2"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult)
      .reason).toMatchObject({ code: "stale-card" });
    const persisted = await readStudyState(database);
    expect(persisted.reviewLogs).toHaveLength(1);
    expect(persisted.sessions[0]?.completedPresentationCount).toBe(1);
    database.close();
  });

  test("rejects native front-side and completed sessions without mutation", async () => {
    const cases = [
      ["front", makeSession({ currentSide: "front" }), "front-side"],
      [
        "completed",
        makeSession({ activeCardId: null, completedAt: NOW - 1 }),
        "completed-session",
      ],
    ] as const;

    for (const [name, session, code] of cases) {
      const factory = new IDBFactory();
      const database = await openIndexedDbStudyDatabase({
        indexedDB: factory,
        name: `review-service-native-${name}-guard`,
      });
      await seedStudyDatabase(database, makeSeed({ session }));
      const before = await readStudyState(database);
      await expect(makeService(database).rate(
        SESSION_ID,
        CARD_ID,
        "good",
        `native-${name}-guard`,
      )).rejects.toMatchObject({ code });
      expect(await readStudyState(database)).toEqual(before);
      database.close();
    }
  });

  test("rejects malformed complete preview material without any durable write", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const clock = new FixedClock(NOW);
    const scheduler = createDeterministicSchedulerAdapter(clock);
    const snapshot = structuredClone(new RatingPreviewSnapshotStore(scheduler).getOrCreate({
      deckId: DECK_ID,
      sessionId: SESSION_ID,
      cardId: CARD_ID,
      schedule: makeSchedule(CARD_ID, NOW),
      schedulerPolicyId: "deterministic",
      capturedAt: NOW,
    })) as any;
    delete snapshot.outcomes.easy;
    const before = database.snapshot();
    const service = new ReviewService({
      database,
      clock,
      scheduler,
      requirePreviewSnapshot: true,
    });

    await expect(service.rate({
      sessionId: SESSION_ID,
      expectedCardId: CARD_ID,
      rating: "good",
      commandId: "malformed-preview",
      previewSnapshot: snapshot,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(database.snapshot()).toEqual(before);
  });

  test("requeues every rating before the cutoff and immediately continues the session", async () => {
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
        status: "rated",
        kind: "rated",
        changed: true,
        idempotent: false,
        rating,
        nextCardId: CARD_ID,
        nextPresentationDueAt: delayedAt,
        session: {
          activeCardId: CARD_ID,
          currentSide: "front",
          plannedPresentationCount: 2,
          completedPresentationCount: 1,
          completedAt: null,
          queueEntries: [{ cardId: CARD_ID, dueAt: delayedAt, ordinal: 2 }],
        },
      });
      expect(database.snapshot().sessions?.[0]).toMatchObject({
        activeCardId: CARD_ID,
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

  test("reconciles the whole current-session queue at tomorrow and orders retained work by due time then ordinal", async () => {
    const sameDueAt = NEXT_DAY - 1;
    const cards = [
      makeCard(CARD_ID),
      makeCard("card-same-due-late-ordinal"),
      makeCard("card-same-due-early-ordinal"),
      makeCard("card-same-due-early-ordinal-z"),
      makeCard("card-at-tomorrow"),
      makeCard("card-after-tomorrow"),
    ];
    const database = new MemoryStudyDatabase(makeSeed({
      cards,
      schedules: cards.map((item) => makeSchedule(item.id, NOW)),
      session: makeSession({
        activeCardId: CARD_ID,
        plannedPresentationCount: 6,
        queueEntries: [
          { cardId: "card-at-tomorrow", dueAt: NEXT_DAY, ordinal: 2 },
          { cardId: "card-same-due-late-ordinal", dueAt: sameDueAt, ordinal: 9 },
          { cardId: CARD_ID, dueAt: NOW, ordinal: 1 },
          { cardId: "card-after-tomorrow", dueAt: NEXT_DAY + 1, ordinal: 3 },
          { cardId: "card-same-due-early-ordinal-z", dueAt: sameDueAt, ordinal: 4 },
          { cardId: "card-same-due-early-ordinal", dueAt: sameDueAt, ordinal: 4 },
        ],
      }),
    }));

    const result = await makeService(
      database,
      new PredictableScheduler(NEXT_DAY),
    ).rate(SESSION_ID, CARD_ID, "good", "reconcile-session-cutoff");

    expect(result.session).toMatchObject({
      activeCardId: "card-same-due-early-ordinal",
      completedPresentationCount: 1,
      plannedPresentationCount: 4,
      completedAt: null,
      queueEntries: [
        { cardId: "card-same-due-early-ordinal", dueAt: sameDueAt, ordinal: 4 },
        { cardId: "card-same-due-early-ordinal-z", dueAt: sameDueAt, ordinal: 4 },
        { cardId: "card-same-due-late-ordinal", dueAt: sameDueAt, ordinal: 9 },
      ],
    });
    expect(database.snapshot().sessions?.[0]).toEqual(result.session);
  });

  test("uses local midnight rather than a rolling 24-hour window for session membership", async () => {
    const localMidnight = Date.parse("2026-09-02T00:00:00.000Z");
    const cases = [
      {
        now: Date.parse("2026-09-01T23:40:00.000Z"),
        expectedStatus: "rated",
        expectedRemaining: 1,
      },
      {
        now: Date.parse("2026-09-01T23:55:00.000Z"),
        expectedStatus: "rated",
        expectedRemaining: 0,
      },
    ] as const;

    for (const testCase of cases) {
      const dueAt = testCase.now + 10 * 60_000;
      const database = new MemoryStudyDatabase(makeSeed({
        cards: [makeCard(CARD_ID)],
        schedules: [makeSchedule(CARD_ID, testCase.now)],
        session: makeSession({
          nextDayAt: localMidnight,
          queueEntries: [{ cardId: CARD_ID, dueAt: testCase.now, ordinal: 1 }],
          activeCardId: CARD_ID,
          plannedPresentationCount: 1,
          completedPresentationCount: 0,
          startedAt: testCase.now - 500,
          updatedAt: testCase.now - 500,
        }),
      }));

      const result = await makeService(
        database,
        new PredictableScheduler(dueAt),
        new FixedClock(testCase.now),
      ).rate(SESSION_ID, CARD_ID, "good", `calendar-day-${testCase.now}`);

      expect(result.status).toBe(testCase.expectedStatus);
      expect(result.session.queueEntries).toHaveLength(testCase.expectedRemaining);
      expect(result.session.completedAt === null).toBe(testCase.expectedRemaining > 0);
    }
  });

  test("persists every rating's delayed and cutoff outcome through production IndexedDB", async () => {
    for (const dueAt of [NOW + 60_000, NEXT_DAY, NEXT_DAY + 1]) {
      for (const rating of ["again", "hard", "good", "easy"] as const) {
        const factory = new IDBFactory();
        const databaseName = `review-service-native-cutoff-${dueAt}-${rating}`;
        const database = await openIndexedDbStudyDatabase({
          indexedDB: factory,
          name: databaseName,
        });
        await seedStudyDatabase(database, makeSeed({
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
        ).rate(SESSION_ID, CARD_ID, rating, `native-cutoff-${dueAt}-${rating}`);
        database.close();

        const reopened = await openIndexedDbStudyDatabase({
          indexedDB: factory,
          name: databaseName,
        });
        const persisted = await readStudyState(reopened);
        expect(persisted.reviewLogs).toHaveLength(1);
        expect(persisted.reviewLogs[0]).toMatchObject({ rating, after: { dueAt } });

        if (dueAt < NEXT_DAY) {
          expect(result.status).toBe("rated");
          expect(persisted.sessions[0]).toMatchObject({
            activeCardId: CARD_ID,
            queueEntries: [{ cardId: CARD_ID, dueAt, ordinal: 2 }],
            plannedPresentationCount: 2,
            completedPresentationCount: 1,
            completedAt: null,
          });
        } else {
          expect(result.status).toBe("rated");
          expect(persisted.sessions[0]).toMatchObject({
            activeCardId: null,
            queueEntries: [],
            plannedPresentationCount: 1,
            completedPresentationCount: 1,
            completedAt: NOW,
          });
        }
        reopened.close();
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

  test("persists native completion and creates exactly one later numbered session", async () => {
    const factory = new IDBFactory();
    const databaseName = "review-service-native-completion-later-intake";
    const database = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    await seedStudyDatabase(database, makeSeed({
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

    const rated = await makeService(
      database,
      new PredictableScheduler(NEXT_DAY),
    ).rate(SESSION_ID, CARD_ID, "good", "native-complete-1");
    expect(rated).toMatchObject({
      status: "rated",
      session: {
        sequence: 1,
        activeCardId: null,
        queueEntries: [],
        plannedPresentationCount: 1,
        completedPresentationCount: 1,
        completedAt: NOW,
      },
    });
    if (rated.status !== "rated") throw new Error("expected native completion");
    const completedHistory = structuredClone(rated.session);
    database.close();

    const reopened = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    const sessionService = new SessionService({
      database: reopened,
      clock: new FixedClock(NOW),
      timeZone: "UTC",
      idGenerator: new SequentialIdGenerator(),
    });
    await expect(sessionService.reveal(SESSION_ID, CARD_ID))
      .rejects.toMatchObject({ code: "completed-session" });
    await expect(makeService(reopened).rate(
      SESSION_ID,
      CARD_ID,
      "good",
      "native-completed-retry",
    )).rejects.toMatchObject({ code: "completed-session" });

    const starts = await Promise.all([
      sessionService.startSession(DECK_ID),
      sessionService.startSession(DECK_ID),
    ]);
    expect(starts.map((result) => result.status).sort()).toEqual(["created", "resumed"]);
    expect(starts.find((result) => result.status === "created")).toMatchObject({
      session: {
        sequence: 2,
        activeCardId: NEXT_CARD_ID,
        queueEntries: [{ cardId: NEXT_CARD_ID, ordinal: 1 }],
        plannedPresentationCount: 1,
        completedPresentationCount: 0,
        completedAt: null,
      },
    });
    const sessions = await reopened.transaction(
      "readonly",
      ["sessions"],
      (transaction) => transaction.listSessions(DECK_ID),
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual(completedHistory);
    expect(sessions[1]).toMatchObject({ sequence: 2, activeCardId: NEXT_CARD_ID });
    reopened.close();

    const reloaded = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    const durableSessions = await reloaded.transaction(
      "readonly",
      ["sessions"],
      (transaction) => transaction.listSessions(DECK_ID),
    );
    expect(durableSessions).toEqual(sessions);
    reloaded.close();
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

  test("keeps delayed same-day work active before and at its due time after reload", async () => {
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
    expect(result.status).toBe("rated");

    const reopened = new MemoryStudyDatabase(database.snapshot());
    const beforeDue = new SessionService({
      database: reopened,
      clock: new FixedClock(delayedAt - 1),
      timeZone: "UTC",
    });
    const activeBeforeDue = await beforeDue.startSession(DECK_ID);
    expect(activeBeforeDue).toMatchObject({
      status: "resumed",
      session: {
        activeCardId: CARD_ID,
        queueEntries: [{ cardId: CARD_ID, dueAt: delayedAt, ordinal: 2 }],
        completedAt: null,
      },
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

  test("keeps native delayed same-day work active across reopen", async () => {
    const delayedAt = NOW + 60_000;
    const factory = new IDBFactory();
    const databaseName = "review-service-native-waiting-resume";
    const database = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    await seedStudyDatabase(database, makeSeed({
      cards: [makeCard(CARD_ID)],
      schedules: [makeSchedule(CARD_ID, NOW)],
      session: makeSession({
        queueEntries: [{ cardId: CARD_ID, dueAt: NOW, ordinal: 1 }],
        activeCardId: CARD_ID,
        plannedPresentationCount: 1,
      }),
    }));
    const rated = await makeService(
      database,
      new PredictableScheduler(delayedAt),
    ).rate(SESSION_ID, CARD_ID, "good", "native-waiting-resume");
    expect(rated.status).toBe("rated");
    database.close();

    const beforeDueDatabase = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    const beforeDue = await new SessionService({
      database: beforeDueDatabase,
      clock: new FixedClock(delayedAt - 1),
      timeZone: "UTC",
    }).startSession(DECK_ID);
    expect(beforeDue).toMatchObject({
      status: "resumed",
      session: {
        activeCardId: CARD_ID,
        queueEntries: [{ cardId: CARD_ID, dueAt: delayedAt, ordinal: 2 }],
        plannedPresentationCount: 2,
        completedPresentationCount: 1,
        completedAt: null,
      },
    });
    beforeDueDatabase.close();

    const atDueDatabase = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    const atDue = await new SessionService({
      database: atDueDatabase,
      clock: new FixedClock(delayedAt),
      timeZone: "UTC",
    }).startSession(DECK_ID);
    expect(atDue).toMatchObject({
      status: "resumed",
      session: {
        activeCardId: CARD_ID,
        currentSide: "front",
        queueEntries: [{ cardId: CARD_ID, dueAt: delayedAt, ordinal: 2 }],
        plannedPresentationCount: 2,
        completedPresentationCount: 1,
        completedAt: null,
      },
    });
    if (atDue.status !== "resumed") throw new Error("expected delayed session resume");
    expect((await readStudyState(atDueDatabase)).sessions[0]).toEqual(atDue.session);
    atDueDatabase.close();
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

  test("rejects every malformed scheduler field before persistence", async () => {
    const malformedOutputs: readonly [string, (result: AppliedSchedule) => void][] = [
      ["missing schedule", (result) => {
        (result as { schedule: ScheduleRecord | null }).schedule = null;
      }],
      ["missing log", (result) => {
        (result as { log: SchedulerLog | null }).log = null;
      }],
      ["dueAt NaN", (result) => { result.schedule.dueAt = Number.NaN; }],
      ["stability infinity", (result) => { result.schedule.stability = Number.POSITIVE_INFINITY; }],
      ["negative difficulty", (result) => { result.schedule.difficulty = -1; }],
      ["fractional elapsed days", (result) => { result.schedule.elapsedDays = 0.5; }],
      ["negative scheduled days", (result) => { result.schedule.scheduledDays = -1; }],
      ["fractional reps", (result) => { result.schedule.reps = 1.5; }],
      ["negative lapses", (result) => { result.schedule.lapses = -1; }],
      ["unknown state", (result) => {
        result.schedule.state = "graduated" as ScheduleRecord["state"];
      }],
      ["invalid last review", (result) => {
        result.schedule.lastReviewAt = Number.NEGATIVE_INFINITY;
      }],
      ["invalid suspended marker", (result) => {
        result.schedule.suspended = "no" as unknown as boolean;
      }],
      ["negative learning step", (result) => { result.schedule.learningSteps = -1; }],
      ["invalid legacy ease", (result) => {
        result.schedule.legacyEaseFactor = Number.NaN;
      }],
      ["wrong log rating", (result) => {
        (result.log as { rating: Rating }).rating = "again";
      }],
      ["non-finite log field", (result) => {
        (result.log as { stability: number }).stability = Number.NaN;
      }],
      ["mismatched log due", (result) => {
        (result.log as { dueAt: number }).dueAt += 1;
      }],
      ["wrong review instant", (result) => {
        (result.log as { reviewedAt: number }).reviewedAt += 1;
      }],
    ];

    for (const [name, mutate] of malformedOutputs) {
      const database = new MemoryStudyDatabase(makeSeed());
      const before = database.snapshot();
      await expect(makeService(
        database,
        new MalformedScheduler(NOW + 5 * 60_000, mutate),
      ).rate(SESSION_ID, CARD_ID, "good", `malformed-${name}`))
        .rejects.toMatchObject({ code: "invalid-schedule" });
      expect(database.snapshot()).toEqual(before);
    }
  });

  test("maps a native command uniqueness failure to the typed conflict result", async () => {
    const factory = new IDBFactory();
    const database = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: "review-service-native-constraint",
    });
    await seedStudyDatabase(database, makeSeed());
    const existing = makeReviewLog({
      id: "existing-native-log",
      commandId: "native-conflict",
    });
    await database.transaction(
      "readwrite",
      ["reviewLogs"],
      async (transaction) => transaction.putReviewLog?.(existing),
    );
    const before = await readStudyState(database);

    await expect(makeService(
      new HideCommandLookupDatabase(database),
    ).rate(SESSION_ID, CARD_ID, "good", "native-conflict"))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await readStudyState(database)).toEqual(before);
    database.close();
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

  test("rolls back every native write boundary and permits a safe retry", async () => {
    for (const failurePoint of ["schedule", "reviewLog", "session", "deck"] as const) {
      const factory = new IDBFactory();
      const databaseName = `review-service-native-rollback-${failurePoint}`;
      const database = await openIndexedDbStudyDatabase({
        indexedDB: factory,
        name: databaseName,
      });
      await seedStudyDatabase(database, makeSeed());

      await expect(makeService(
        new FailAtWriteDatabase(database, failurePoint),
      ).rate(SESSION_ID, CARD_ID, "good", `native-failure-${failurePoint}`))
        .rejects.toMatchObject({ code: "persistence" });
      database.close();

      const reopened = await openIndexedDbStudyDatabase({
        indexedDB: factory,
        name: databaseName,
      });
      const original = makeSeed();
      expect(await readStudyState(reopened)).toEqual({
        decks: [...original.decks],
        schedules: [...original.schedules],
        sessions: [...original.sessions],
        reviewLogs: [],
      });
      const retry = await makeService(reopened).rate(
        SESSION_ID,
        CARD_ID,
        "good",
        `native-failure-${failurePoint}`,
      );
      expect(retry.status).toBe("rated");
      expect((await readStudyState(reopened)).reviewLogs).toHaveLength(1);
      reopened.close();
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
    frontText: id,
    backText: `${id} answer`,
    css: "",
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

class MalformedScheduler extends PredictableScheduler {
  constructor(
    dueAt: number,
    private readonly mutate: (result: AppliedSchedule) => void,
  ) {
    super(dueAt);
  }

  override apply(schedule: ScheduleRecord, rating: Rating, now: Date): AppliedSchedule {
    const result = structuredClone(super.apply(schedule, rating, now));
    this.mutate(result);
    return result;
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

class HideCommandLookupDatabase implements StudyDatabase {
  constructor(private readonly inner: StudyDatabase) {}

  transaction<T>(
    mode: "readonly" | "readwrite",
    stores: readonly StudyStoreName[],
    work: (transaction: StudyTransaction) => Promise<T> | T,
  ): Promise<T> {
    return this.inner.transaction(mode, stores, (transaction) => work({
      ...transaction,
      getDeck: transaction.getDeck.bind(transaction),
      getCard: transaction.getCard.bind(transaction),
      getSchedule: transaction.getSchedule.bind(transaction),
      getSession: transaction.getSession.bind(transaction),
      getReviewLog: transaction.getReviewLog?.bind(transaction),
      getReviewLogByCommandId: async () => undefined,
      getMeta: transaction.getMeta?.bind(transaction),
      listCards: transaction.listCards.bind(transaction),
      listSchedules: transaction.listSchedules.bind(transaction),
      listSessions: transaction.listSessions.bind(transaction),
      putDeck: transaction.putDeck.bind(transaction),
      putCard: transaction.putCard.bind(transaction),
      putSchedule: transaction.putSchedule.bind(transaction),
      putSession: transaction.putSession.bind(transaction),
      putReviewLog: transaction.putReviewLog?.bind(transaction),
      putMeta: transaction.putMeta?.bind(transaction),
    }));
  }

  close(): void {
    this.inner.close();
  }
}

async function readStudyState(database: StudyDatabase): Promise<{
  decks: DeckRecord[];
  schedules: ScheduleRecord[];
  sessions: SessionRecord[];
  reviewLogs: ReviewLogRecord[];
}> {
  return database.transaction(
    "readonly",
    ["decks", "schedules", "sessions", "reviewLogs"],
    async (transaction) => ({
      decks: [await transaction.getDeck(DECK_ID)].filter(
        (deck): deck is DeckRecord => deck !== undefined,
      ),
      schedules: await transaction.listSchedules(DECK_ID),
      sessions: await transaction.listSessions(DECK_ID),
      reviewLogs: await Promise.all(
        ["review-log-1", "existing-native-log"]
          .map(async (id) => transaction.getReviewLog?.(id)),
      ).then((logs) => logs.filter(
        (log): log is ReviewLogRecord => log !== undefined,
      )),
    }),
  );
}
