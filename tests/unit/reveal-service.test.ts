import { describe, expect, test } from "bun:test";

import type {
  CardRecord,
  DeckRecord,
  SessionRecord,
} from "../../lib/domain/entities";
import {
  MemoryStudyDatabase,
  type StudyDatabase,
  type StudyStoreName,
  type StudyTransaction,
} from "../../lib/persistence";
import {
  RevealService,
  SessionService,
} from "../../lib/application";
import { FixedClock } from "../../lib/platform/clock";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const DECK_ID = "deck-spanish";
const CARD_ID = "card-one";
const OTHER_CARD_ID = "card-two";
const SESSION_ID = "session-one";

describe("RevealService", () => {
  test("persists a front-to-back reveal without changing study progress", async () => {
    const original = makeSession();
    const database = new MemoryStudyDatabase(makeSeed({ session: original }));
    const before = database.snapshot();
    const service = makeService(database);

    const result = await service.revealAnswer(SESSION_ID, CARD_ID);

    expect(result).toMatchObject({
      status: "revealed",
      kind: "revealed",
      changed: true,
      idempotent: false,
      card: { id: CARD_ID },
      session: { id: SESSION_ID, activeCardId: CARD_ID, currentSide: "back" },
    });
    expect(result.session.updatedAt).toBe(NOW);
    expect(result.session.queueEntries).toEqual(original.queueEntries);
    expect(result.session.plannedPresentationCount).toBe(original.plannedPresentationCount);
    expect(result.session.completedPresentationCount).toBe(original.completedPresentationCount);
    expect(result.session.ratingCounts).toEqual(original.ratingCounts);
    expect(database.snapshot().schedules).toEqual(before.schedules);
    expect(database.snapshot().sessions).toEqual([result.session]);
  });

  test("repeating reveal is an idempotent success and leaves the committed record byte-for-byte equivalent", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const service = makeService(database);

    await service.reveal(SESSION_ID, CARD_ID);
    const afterFirstReveal = database.snapshot();

    const retry = await service.reveal({ sessionId: SESSION_ID, cardId: CARD_ID });

    expect(retry).toMatchObject({
      status: "already-revealed",
      kind: "already-revealed",
      changed: false,
      idempotent: true,
      session: { currentSide: "back" },
    });
    expect(database.snapshot()).toEqual(afterFirstReveal);
  });

  test("SessionService exposes the same guarded reveal operation", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const service = new SessionService({
      database,
      clock: new FixedClock(NOW),
      timeZone: "UTC",
    });

    const result = await service.revealAnswer(SESSION_ID, CARD_ID);

    expect(result.status).toBe("revealed");
    expect(database.snapshot().sessions?.[0]?.currentSide).toBe("back");
  });

  test("rejects missing, completed, stale, and missing-card state without mutation", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    const service = makeService(database);

    const beforeMissingSession = database.snapshot();
    await expect(service.reveal("missing-session", CARD_ID)).rejects.toMatchObject({
      name: "RevealServiceError",
      code: "session-not-found",
    });
    expect(database.snapshot()).toEqual(beforeMissingSession);

    const beforeStale = database.snapshot();
    await expect(service.reveal(SESSION_ID, OTHER_CARD_ID)).rejects.toMatchObject({
      code: "stale-card",
    });
    expect(database.snapshot()).toEqual(beforeStale);

    const completedDatabase = new MemoryStudyDatabase(makeSeed({
      session: makeSession({ completedAt: NOW - 1, activeCardId: null, currentSide: "front" }),
    }));
    const beforeCompleted = completedDatabase.snapshot();
    await expect(makeService(completedDatabase).reveal(SESSION_ID, CARD_ID)).rejects.toMatchObject({
      code: "completed-session",
    });
    expect(completedDatabase.snapshot()).toEqual(beforeCompleted);

    const missingCardSession = makeSession({ activeCardId: "removed-card" });
    const missingCardDatabase = new MemoryStudyDatabase(makeSeed({
      session: missingCardSession,
      cards: [card(OTHER_CARD_ID)],
    }));
    const beforeMissingCard = missingCardDatabase.snapshot();
    await expect(makeService(missingCardDatabase).reveal(SESSION_ID, "removed-card"))
      .rejects.toMatchObject({ code: "card-not-found" });
    expect(missingCardDatabase.snapshot()).toEqual(beforeMissingCard);
  });

  test("persists the back side across a repository reopen", async () => {
    const database = new MemoryStudyDatabase(makeSeed());
    await makeService(database).reveal(SESSION_ID, CARD_ID);

    const reopened = new MemoryStudyDatabase(database.snapshot());
    const result = await makeService(reopened).reveal(SESSION_ID, CARD_ID);

    expect(result.status).toBe("already-revealed");
    expect(reopened.snapshot().sessions).toEqual(database.snapshot().sessions);
    expect(reopened.snapshot().sessions?.[0]).toMatchObject({
      activeCardId: CARD_ID,
      currentSide: "back",
      queueEntries: [{ cardId: CARD_ID, ordinal: 7 }],
      plannedPresentationCount: 4,
      completedPresentationCount: 2,
      ratingCounts: { again: 1, hard: 2, good: 3, easy: 4 },
    });
  });

  test("rolls back a failed session write", async () => {
    const inner = new MemoryStudyDatabase(makeSeed());
    const database = new FailAfterSessionPutDatabase(inner);

    await expect(makeService(database).reveal(SESSION_ID, CARD_ID)).rejects.toMatchObject({
      name: "RevealServiceError",
      code: "persistence",
    });
    expect(inner.snapshot().sessions?.[0]?.currentSide).toBe("front");
    expect(inner.snapshot().sessions).toEqual(makeSeed().sessions);
  });
});

function makeService(database: StudyDatabase): RevealService {
  return new RevealService({
    database,
    clock: new FixedClock(NOW),
  });
}

function makeSeed(options: {
  session?: SessionRecord;
  cards?: readonly CardRecord[];
} = {}): {
  decks: readonly DeckRecord[];
  cards: readonly CardRecord[];
  sessions: readonly SessionRecord[];
} {
  return {
    decks: [makeDeck()],
    cards: options.cards ?? [card(CARD_ID), card(OTHER_CARD_ID)],
    sessions: [options.session ?? makeSession()],
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

function card(id: string): CardRecord {
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

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    deckId: DECK_ID,
    dayKey: "2026-09-01",
    sequence: 1,
    intakeLimit: 20,
    nextDayAt: Date.parse("2026-09-02T00:00:00.000Z"),
    queueEntries: [{ cardId: CARD_ID, dueAt: NOW - 1, ordinal: 7 }],
    activeCardId: CARD_ID,
    plannedPresentationCount: 4,
    completedPresentationCount: 2,
    currentSide: "front",
    ratingCounts: { again: 1, hard: 2, good: 3, easy: 4 },
    startedAt: NOW - 500,
    updatedAt: NOW - 500,
    completedAt: null,
    lastCommandIds: ["existing-command"],
    ...overrides,
  };
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
