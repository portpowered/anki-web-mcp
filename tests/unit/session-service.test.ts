import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import type {
  CardRecord,
  DeckRecord,
  ScheduleRecord,
  SessionRecord,
} from "../../lib/domain/entities";
import type { IdGenerator } from "../../lib/domain/ports";
import {
  MemoryStudyDatabase,
  openIndexedDbStudyDatabase,
  seedStudyDatabase,
  type StudyDatabase,
  type StudyStoreName,
  type StudyTransaction,
} from "../../lib/persistence";
import { SessionService } from "../../lib/application";
import { FixedClock } from "../../lib/platform/clock";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const DAY_KEY = "2026-09-01";
const NEXT_DAY = Date.parse("2026-09-02T00:00:00.000Z");
const DECK_ID = "deck-spanish";

describe("SessionService", () => {
  test("selects intake atomically through the production IndexedDB repositories and resumes after reopen", async () => {
    const factory = new IDBFactory();
    const databaseName = "session-service-native-intake";
    const database = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    await seedStudyDatabase(database, makeDeckSeed([
      card("new-late", 30),
      card("review-old", 1),
      card("learning", 2),
      card("new-early", 10),
      card("review-new", 5),
    ].reverse(), [
      schedule("new-late", "new", NOW + 10_000),
      schedule("review-old", "review", NOW - 30),
      schedule("learning", "learning", NOW - 20),
      schedule("new-early", "new", NOW),
      schedule("review-new", "review", NOW - 10),
    ].reverse()));

    const ids = new IncrementingIdGenerator();
    const results = await Promise.all([
      makeService(database, ids).startSession(DECK_ID),
      makeService(database, ids).startSession(DECK_ID),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["created", "resumed"]);
    const created = results.find((result) => result.status === "created");
    expect(created?.session?.queueEntries).toEqual([
      { cardId: "learning", dueAt: NOW - 20, ordinal: 1 },
      { cardId: "review-old", dueAt: NOW - 30, ordinal: 2 },
      { cardId: "review-new", dueAt: NOW - 10, ordinal: 3 },
    ]);
    database.close();

    const reopened = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    const resumed = await makeService(
      reopened,
      new IncrementingIdGenerator(),
    ).startSession(DECK_ID);
    expect(resumed).toMatchObject({
      status: "resumed",
      session: {
        id: created?.session?.id,
        plannedPresentationCount: 3,
        queueEntries: created?.session?.queueEntries,
      },
    });
    const sessions = await reopened.transaction(
      "readonly",
      ["sessions"],
      (transaction) => transaction.listSessions(DECK_ID),
    );
    expect(sessions).toHaveLength(1);
    reopened.close();
  });

  test("rolls back native creation and then allocates one later sequence concurrently", async () => {
    const factory = new IDBFactory();
    const databaseName = "session-service-native-sequence-rollback";
    const completedOne = makeSession("completed-1", 1, {
      activeCardId: null,
      completedPresentationCount: 1,
      completedAt: NOW - 2,
    });
    const completedFour = makeSession("completed-4", 4, {
      activeCardId: null,
      completedPresentationCount: 1,
      completedAt: NOW - 1,
    });
    const database = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    await seedStudyDatabase(database, makeDeckSeed(
      [card("later-card", 1)],
      [schedule("later-card", "new", NOW)],
      [completedOne, completedFour],
    ));

    await expect(makeService(
      new FailAfterSessionPutDatabase(database),
      new IncrementingIdGenerator(),
    ).startSession(DECK_ID)).rejects.toMatchObject({ code: "persistence" });
    database.close();

    const reopened = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    const afterRollback = await reopened.transaction(
      "readonly",
      ["sessions"],
      (transaction) => transaction.listSessions(DECK_ID),
    );
    expect(afterRollback).toEqual([completedOne, completedFour]);

    const ids = new IncrementingIdGenerator();
    const results = await Promise.all([
      makeService(reopened, ids).startSession(DECK_ID),
      makeService(reopened, ids).startSession(DECK_ID),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["created", "resumed"]);
    expect(results.find((result) => result.status === "created")).toMatchObject({
      session: {
        sequence: 5,
        queueEntries: [{ cardId: "later-card", ordinal: 1 }],
      },
    });
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
    expect(durableSessions).toHaveLength(3);
    expect(durableSessions.slice(0, 2)).toEqual([completedOne, completedFour]);
    expect(durableSessions[2]).toMatchObject({ sequence: 5, activeCardId: "later-card" });
    reloaded.close();
  });

  test("admits omitted cards into one durable native later sequence", async () => {
    const factory = new IDBFactory();
    const databaseName = "session-service-native-omitted-later-intake";
    const admittedCards = Array.from({ length: 20 }, (_, index) => (
      card(`admitted-${String(index + 1).padStart(2, "0")}`, index + 1)
    ));
    const omittedCards = [card("omitted-21", 21), card("omitted-22", 22)];
    const completed = makeSession("completed", 1, {
      intakeLimit: 20,
      queueEntries: admittedCards.map((admittedCard, index) => ({
        cardId: admittedCard.id,
        dueAt: NOW - 1,
        ordinal: index + 1,
      })),
      activeCardId: null,
      plannedPresentationCount: 20,
      completedPresentationCount: 20,
      completedAt: NOW - 1,
    });
    const database = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    await seedStudyDatabase(database, {
      decks: [{ ...makeDeck(22), sessionIntakeLimit: 20 }],
      cards: [...admittedCards, ...omittedCards],
      schedules: [
        ...admittedCards.map((admittedCard) => (
          schedule(admittedCard.id, "review", NOW + 60_000)
        )),
        ...omittedCards.map((omittedCard) => schedule(omittedCard.id, "new", NOW)),
      ],
      sessions: [completed],
    });

    const ids = new IncrementingIdGenerator();
    const results = await Promise.all([
      makeService(database, ids).startSession(DECK_ID),
      makeService(database, ids).startSession(DECK_ID),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["created", "resumed"]);
    expect(results.find((result) => result.status === "created")).toMatchObject({
      session: {
        sequence: 2,
        intakeLimit: 20,
        activeCardId: "omitted-21",
        plannedPresentationCount: 2,
        completedPresentationCount: 0,
        queueEntries: [
          { cardId: "omitted-21", ordinal: 1 },
          { cardId: "omitted-22", ordinal: 2 },
        ],
      },
    });
    database.close();

    const reopened = await openIndexedDbStudyDatabase({
      indexedDB: factory,
      name: databaseName,
    });
    const sessions = await reopened.transaction(
      "readonly",
      ["sessions"],
      (transaction) => transaction.listSessions(DECK_ID),
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual(completed);
    expect(sessions[1]).toMatchObject({
      sequence: 2,
      queueEntries: [
        { cardId: "omitted-21", ordinal: 1 },
        { cardId: "omitted-22", ordinal: 2 },
      ],
    });
    reopened.close();
  });

  test("returns durable native caught-up and all-suspended outcomes without empty sessions", async () => {
    const cases = [
      ["caught-up", schedule("future", "review", NOW + 1), "caught-up"],
      ["all-suspended", schedule("suspended", "review", NOW, true), "all-suspended"],
    ] as const;

    for (const [name, cardSchedule, reason] of cases) {
      const factory = new IDBFactory();
      const databaseName = `session-service-native-${name}-completed-history`;
      const completed = makeSession("completed", 1, {
        activeCardId: null,
        completedPresentationCount: 1,
        completedAt: NOW - 1,
      });
      const database = await openIndexedDbStudyDatabase({
        indexedDB: factory,
        name: databaseName,
      });
      await seedStudyDatabase(database, makeDeckSeed(
        [card(cardSchedule.cardId, 1)],
        [cardSchedule],
        [completed],
      ));

      const result = await makeService(
        database,
        new IncrementingIdGenerator(),
      ).startSession(DECK_ID);
      expect(result).toMatchObject({ status: "no-session", reason });
      database.close();

      const reopened = await openIndexedDbStudyDatabase({
        indexedDB: factory,
        name: databaseName,
      });
      const sessions = await reopened.transaction(
        "readonly",
        ["sessions"],
        (transaction) => transaction.listSessions(DECK_ID),
      );
      expect(sessions).toEqual([completed]);
      reopened.close();
    }
  });

  test("creates a bounded deterministic session with consistent initial state", async () => {
    const database = new MemoryStudyDatabase(makeDeckSeed([
      card("new-late", 30),
      card("review-old", 1),
      card("learning", 2),
      card("new-early", 10),
      card("review-new", 5),
    ], [
      schedule("new-late", "new", NOW + 10_000),
      schedule("review-old", "review", NOW - 30),
      schedule("learning", "learning", NOW - 20),
      schedule("new-early", "new", NOW),
      schedule("review-new", "review", NOW - 10),
    ]));
    const service = makeService(database, new IncrementingIdGenerator());

    const result = await service.startSession(DECK_ID);

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.dayKey).toBe(DAY_KEY);
    expect(result.nextDayAt).toBe(NEXT_DAY);
    expect(result.session).toMatchObject({
      id: "session-1",
      deckId: DECK_ID,
      dayKey: DAY_KEY,
      sequence: 1,
      intakeLimit: 3,
      nextDayAt: NEXT_DAY,
      activeCardId: "learning",
      plannedPresentationCount: 3,
      completedPresentationCount: 0,
      currentSide: "front",
      ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
      startedAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      lastCommandIds: [],
    });
    expect(result.session.queueEntries).toEqual([
      { cardId: "learning", dueAt: NOW - 20, ordinal: 1 },
      { cardId: "review-old", dueAt: NOW - 30, ordinal: 2 },
      { cardId: "review-new", dueAt: NOW - 10, ordinal: 3 },
    ]);
    expect(database.snapshot().schedules).toEqual([
      schedule("new-late", "new", NOW + 10_000),
      schedule("review-old", "review", NOW - 30),
      schedule("learning", "learning", NOW - 20),
      schedule("new-early", "new", NOW),
      schedule("review-new", "review", NOW - 10),
    ]);
  });

  test("excludes cards pending in any incomplete session and returns no-session explicitly", async () => {
    const pending = makeSession("old-pending", 1, {
      dayKey: "2026-08-31",
      queueEntries: [{ cardId: "pending-card", dueAt: NOW - 1, ordinal: 1 }],
    });
    const database = new MemoryStudyDatabase(makeDeckSeed(
      [card("pending-card", 1), card("future-card", 2)],
      [
        schedule("pending-card", "review", NOW - 1),
        schedule("future-card", "review", NOW + 1),
      ],
      [pending],
    ));
    const service = makeService(database, new IncrementingIdGenerator());

    const result = await service.startSession(DECK_ID);

    expect(result).toMatchObject({
      status: "no-session",
      reason: "caught-up",
      dayKey: DAY_KEY,
      nextDayAt: NEXT_DAY,
    });
    expect(database.snapshot().sessions).toHaveLength(1);
  });

  test("resumes the latest incomplete session without rebuilding its durable state", async () => {
    const olderIncomplete = makeSession("older", 1, {
      queueEntries: [{ cardId: "older-card", dueAt: NOW - 2, ordinal: 3 }],
      activeCardId: "older-card",
    });
    const existing = makeSession("existing", 2, {
      queueEntries: [
        { cardId: "kept-card", dueAt: NOW - 1, ordinal: 7 },
        { cardId: "later-card", dueAt: NOW + 1, ordinal: 12 },
      ],
      activeCardId: "later-card",
      currentSide: "back",
      plannedPresentationCount: 9,
      completedPresentationCount: 4,
      updatedAt: NOW - 100,
      ratingCounts: { again: 1, hard: 1, good: 1, easy: 1 },
      lastCommandIds: ["command-1"],
    });
    const database = new MemoryStudyDatabase(makeDeckSeed(
      [card("new-card", 1)],
      [schedule("new-card", "new", NOW)],
      [olderIncomplete, existing],
    ));
    const service = new SessionService({
      database,
      clock: new FixedClock(NOW),
      // Deliberately change the configured timezone after the records exist.
      timeZone: "America/Los_Angeles",
      idGenerator: new IncrementingIdGenerator(),
    });

    const result = await service.startSession(DECK_ID);

    expect(result).toEqual({
      status: "resumed",
      kind: "resumed",
      session: existing,
      dayKey: DAY_KEY,
      nextDayAt: existing.nextDayAt,
      timeZone: "America/Los_Angeles",
    });
    expect(database.snapshot().sessions).toEqual([olderIncomplete, existing]);
  });

  test("allocates sequence one after completed historical sessions", async () => {
    const completed = makeSession("completed", 1, {
      completedAt: NOW - 1,
      queueEntries: [{ cardId: "old-card", dueAt: NOW - 1, ordinal: 1 }],
      activeCardId: null,
      completedPresentationCount: 1,
    });
    const laterCompleted = makeSession("later-completed", 4, {
      completedAt: NOW - 2,
      queueEntries: [{ cardId: "later-old-card", dueAt: NOW - 2, ordinal: 1 }],
      activeCardId: null,
      completedPresentationCount: 1,
    });
    const database = new MemoryStudyDatabase(makeDeckSeed(
      [card("new-card", 1)],
      [schedule("new-card", "new", NOW)],
      [completed, laterCompleted],
    ));
    const service = makeService(database, new IncrementingIdGenerator());

    const result = await service.startSession(DECK_ID);

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.session.sequence).toBe(5);
    expect(result.session.id).toBe("session-1");
    expect(database.snapshot().sessions).toEqual([completed, laterCompleted, result.session]);
  });

  test("creates a later sequence from omitted eligible cards without mutating completed history", async () => {
    const admittedCards = Array.from({ length: 20 }, (_, index) => (
      card(`admitted-${String(index + 1).padStart(2, "0")}`, index + 1)
    ));
    const omittedCards = [card("omitted-21", 21), card("omitted-22", 22)];
    const completed = makeSession("completed", 1, {
      intakeLimit: 20,
      queueEntries: admittedCards.map((admittedCard, index) => ({
        cardId: admittedCard.id,
        dueAt: NOW - 1,
        ordinal: index + 1,
      })),
      activeCardId: null,
      plannedPresentationCount: 20,
      completedPresentationCount: 20,
      completedAt: NOW - 1,
    });
    const database = new MemoryStudyDatabase({
      decks: [{ ...makeDeck(22), sessionIntakeLimit: 20 }],
      cards: [...admittedCards, ...omittedCards],
      schedules: [
        ...admittedCards.map((admittedCard) => (
          schedule(admittedCard.id, "review", NOW + 60_000)
        )),
        ...omittedCards.map((omittedCard) => (
          schedule(omittedCard.id, "new", NOW)
        )),
      ],
      sessions: [completed],
    });
    const service = makeService(database, new IncrementingIdGenerator());
    const beforeHistory = structuredClone(completed);

    const result = await service.startSession(DECK_ID);

    expect(result).toMatchObject({
      status: "created",
      kind: "created",
      session: {
        sequence: 2,
        intakeLimit: 20,
        plannedPresentationCount: 2,
        completedPresentationCount: 0,
        activeCardId: "omitted-21",
        queueEntries: [
          { cardId: "omitted-21", ordinal: 1 },
          { cardId: "omitted-22", ordinal: 2 },
        ],
      },
    });
    expect(database.snapshot().sessions?.[0]).toEqual(beforeHistory);
    expect(database.snapshot().sessions).toHaveLength(2);
  });

  test("serializes later starts into one new sequence and one resume", async () => {
    const completed = makeSession("completed", 1, {
      queueEntries: [{ cardId: "old-card", dueAt: NOW - 1, ordinal: 1 }],
      activeCardId: null,
      completedPresentationCount: 1,
      completedAt: NOW - 1,
    });
    const database = new MemoryStudyDatabase({
      decks: [{ ...makeDeck(2), sessionIntakeLimit: 20 }],
      cards: [card("old-card", 1), card("later-card", 2)],
      schedules: [
        schedule("old-card", "review", NOW + 60_000),
        schedule("later-card", "new", NOW),
      ],
      sessions: [completed],
    });
    const service = makeService(database, new IncrementingIdGenerator());

    const results = await Promise.all([
      service.startSession(DECK_ID),
      service.startSession(DECK_ID),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["created", "resumed"]);
    expect(results.find((result) => result.status === "created")).toMatchObject({
      session: { sequence: 2, queueEntries: [{ cardId: "later-card" }] },
    });
    expect(database.snapshot().sessions).toHaveLength(2);
    expect(database.snapshot().sessions?.[0]).toEqual(completed);
    expect(database.snapshot().sessions?.[1]?.sequence).toBe(2);
  });

  test("returns no-session after completed history when the remaining deck is caught up", async () => {
    const completed = makeSession("completed", 1, {
      queueEntries: [{ cardId: "old-card", dueAt: NOW - 1, ordinal: 1 }],
      activeCardId: null,
      completedPresentationCount: 1,
      completedAt: NOW - 1,
    });
    const database = new MemoryStudyDatabase({
      decks: [makeDeck(1)],
      cards: [card("old-card", 1)],
      schedules: [schedule("old-card", "review", NOW + 60_000)],
      sessions: [completed],
    });
    const service = makeService(database, new IncrementingIdGenerator());
    const before = database.snapshot();

    const result = await service.startSession(DECK_ID);

    expect(result).toMatchObject({
      status: "no-session",
      kind: "no-session",
      reason: "caught-up",
    });
    expect(database.snapshot()).toEqual(before);
  });

  test("serializes concurrent starts into one created session and one resume", async () => {
    const database = new MemoryStudyDatabase(makeDeckSeed(
      [card("new-card", 1)],
      [schedule("new-card", "new", NOW)],
    ));
    const service = makeService(database, new IncrementingIdGenerator());

    const results = await Promise.all([
      service.startSession(DECK_ID),
      service.startSession(DECK_ID),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["created", "resumed"]);
    expect(results[0].session?.id ?? results[1].session?.id).toBe("session-1");
    expect(database.snapshot().sessions).toHaveLength(1);
    expect(database.snapshot().sessions?.[0]?.sequence).toBe(1);
  });

  test("returns all-suspended and caught-up outcomes without empty sessions", async () => {
    const allSuspended = new MemoryStudyDatabase(makeDeckSeed(
      [card("suspended", 1)],
      [schedule("suspended", "review", NOW, true)],
    ));
    const suspendedResult = await makeService(
      allSuspended,
      new IncrementingIdGenerator(),
    ).startSession(DECK_ID);
    expect(suspendedResult).toMatchObject({ status: "no-session", reason: "all-suspended" });
    expect(allSuspended.snapshot().sessions).toHaveLength(0);

    const caughtUp = new MemoryStudyDatabase(makeDeckSeed(
      [card("future", 1)],
      [schedule("future", "review", NOW + 1)],
    ));
    const caughtUpResult = await makeService(
      caughtUp,
      new IncrementingIdGenerator(),
    ).startSession(DECK_ID);
    expect(caughtUpResult).toMatchObject({ status: "no-session", reason: "caught-up" });
    expect(caughtUp.snapshot().sessions).toHaveLength(0);
  });

  test("rolls back a failed session write without leaving a partial session", async () => {
    const inner = new MemoryStudyDatabase(makeDeckSeed(
      [card("new-card", 1)],
      [schedule("new-card", "new", NOW)],
    ));
    const database = new FailAfterSessionPutDatabase(inner);
    const service = makeService(database, new IncrementingIdGenerator());

    await expect(service.startSession(DECK_ID)).rejects.toMatchObject({
      code: "persistence",
    });
    expect(inner.snapshot().sessions).toHaveLength(0);
  });

  test("rolls back a failed later sequence without changing completed history", async () => {
    const completed = makeSession("completed", 1, {
      queueEntries: [{ cardId: "old-card", dueAt: NOW - 1, ordinal: 1 }],
      activeCardId: null,
      completedPresentationCount: 1,
      completedAt: NOW - 1,
    });
    const inner = new MemoryStudyDatabase({
      decks: [makeDeck(2)],
      cards: [card("old-card", 1), card("later-card", 2)],
      schedules: [
        schedule("old-card", "review", NOW + 60_000),
        schedule("later-card", "new", NOW),
      ],
      sessions: [completed],
    });
    const database = new FailAfterSessionPutDatabase(inner);
    const service = makeService(database, new IncrementingIdGenerator());
    const before = inner.snapshot();

    await expect(service.startSession(DECK_ID)).rejects.toMatchObject({
      code: "persistence",
    });
    expect(inner.snapshot()).toEqual(before);
  });
});

function makeService(database: StudyDatabase, idGenerator: IdGenerator): SessionService {
  return new SessionService({
    database,
    clock: new FixedClock(NOW),
    timeZone: "UTC",
    idGenerator,
  });
}

function makeDeckSeed(
  cards: readonly CardRecord[],
  schedules: readonly ScheduleRecord[],
  sessions: readonly SessionRecord[] = [],
): {
  decks: readonly DeckRecord[];
  cards: readonly CardRecord[];
  schedules: readonly ScheduleRecord[];
  sessions: readonly SessionRecord[];
} {
  return {
    decks: [makeDeck(cards.length)],
    cards,
    schedules,
    sessions,
  };
}

function makeDeck(cardCount: number): DeckRecord {
  return {
    id: DECK_ID,
    importId: "seed",
    sourceDeckId: null,
    name: "Spanish",
    cardCount,
    createdAt: NOW - 1_000,
    lastStudiedAt: null,
    sessionIntakeLimit: 3,
    schedulerConfigId: "deterministic",
  };
}

function card(id: string, creationOrder: number): CardRecord {
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
    creationOrder,
    contentWarnings: [],
  };
}

function schedule(
  cardId: string,
  state: ScheduleRecord["state"],
  dueAt: number,
  suspended = false,
): ScheduleRecord {
  return {
    cardId,
    deckId: DECK_ID,
    dueAt,
    stability: state === "new" ? 0 : 4,
    difficulty: state === "new" ? 0 : 5,
    elapsedDays: state === "new" ? 0 : 1,
    scheduledDays: state === "new" ? 0 : 4,
    reps: state === "new" ? 0 : 3,
    lapses: 0,
    state,
    lastReviewAt: state === "new" ? null : NOW - 1_000,
    suspended,
    learningSteps: state === "learning" || state === "relearning" ? 0 : undefined,
    legacyEaseFactor: null,
  };
}

function makeSession(
  id: string,
  sequence: number,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    deckId: DECK_ID,
    dayKey: DAY_KEY,
    sequence,
    intakeLimit: 3,
    nextDayAt: NEXT_DAY,
    queueEntries: [{ cardId: "existing-card", dueAt: NOW - 1, ordinal: 1 }],
    activeCardId: "existing-card",
    plannedPresentationCount: 1,
    completedPresentationCount: 0,
    currentSide: "front",
    ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
    startedAt: NOW - 500,
    updatedAt: NOW - 500,
    completedAt: null,
    lastCommandIds: [],
    ...overrides,
  };
}

class IncrementingIdGenerator implements IdGenerator {
  private nextId = 1;

  next(namespace = "id"): string {
    const value = `${namespace}-${this.nextId}`;
    this.nextId += 1;
    return value;
  }
}

class FailAfterSessionPutDatabase implements StudyDatabase {
  constructor(private readonly inner: StudyDatabase) {}

  transaction<T>(
    mode: "readonly" | "readwrite",
    stores: readonly StudyStoreName[],
    work: (transaction: StudyTransaction) => Promise<T> | T,
  ): Promise<T> {
    return this.inner.transaction(mode, stores, async (transaction) => {
      const failingTransaction: StudyTransaction = {
        getDeck: transaction.getDeck.bind(transaction),
        getCard: transaction.getCard.bind(transaction),
        getSchedule: transaction.getSchedule.bind(transaction),
        getSession: transaction.getSession.bind(transaction),
        listCards: transaction.listCards.bind(transaction),
        listSchedules: transaction.listSchedules.bind(transaction),
        listSessions: transaction.listSessions.bind(transaction),
        putDeck: transaction.putDeck.bind(transaction),
        putCard: transaction.putCard.bind(transaction),
        putSchedule: transaction.putSchedule.bind(transaction),
        putSession: async (session) => {
          await transaction.putSession(session);
          throw new Error("injected write failure");
        },
      };
      return work(failingTransaction);
    });
  }

  close(): void {
    this.inner.close();
  }
}
