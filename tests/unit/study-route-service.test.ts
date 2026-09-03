import { describe, expect, test } from "bun:test";

import { StudyRouteService } from "../../lib/application/study-route-service";
import type {
  CardRecord,
  DeckRecord,
  MediaRecord,
  Rating,
  ScheduleRecord,
  SessionRecord,
} from "../../lib/domain/entities";
import type {
  AppliedSchedule,
  RatingPreviewMap,
  SchedulerAdapter,
  SchedulerLog,
} from "../../lib/domain/scheduler";
import { MemoryStudyDatabase } from "../../lib/persistence/db";
import { FixedClock } from "../../lib/platform/clock";
import {
  studyViewFromSnapshot,
  toggleRevealedSide,
} from "../../components/study-route-preview";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const NEXT_DAY = Date.parse("2026-09-02T00:00:00.000Z");
const DECK_ID = "deck-spanish";
const CARD_ID = "card-casa";

describe("StudyRouteService", () => {
  test("creates and reloads the active durable session with redacted front state", async () => {
    const database = new MemoryStudyDatabase(seed());
    const service = makeService(database);

    const initial = await service.load(DECK_ID);
    expect(initial).toMatchObject({
      kind: "active",
      deckName: "Spanish Basics",
      sequence: 1,
      completedPresentationCount: 0,
      plannedPresentationCount: 1,
      cardId: CARD_ID,
      frontText: "casa",
      side: "front",
      ratingPreviews: {
        again: { intervalLabel: "1 min" },
        hard: { intervalLabel: "6 min" },
        good: { intervalLabel: "10 min" },
        easy: { intervalLabel: "4 d" },
      },
    });
    expect(initial.kind === "active" && "backText" in initial).toBe(false);

    const reloaded = await makeService(database).load(DECK_ID);
    expect(reloaded).toEqual(initial);
    expect(database.snapshot().sessions).toHaveLength(1);
  });

  test("reveals persisted back content only for a back-side session", async () => {
    const database = new MemoryStudyDatabase(seed({
      session: session({ currentSide: "back" }),
    }));

    const snapshot = await makeService(database).load(DECK_ID);
    expect(snapshot).toMatchObject({
      kind: "active",
      side: "back",
      frontText: "casa",
      backText: "house",
    });
    if (snapshot.kind !== "active") throw new Error("expected active snapshot");
    const backView = studyViewFromSnapshot(snapshot);
    expect(backView.state).toMatchObject({
      kind: "active",
      side: "back",
      revealed: true,
      backContent: "house",
    });
    const frontView = toggleRevealedSide(backView);
    expect(frontView.state).toMatchObject({ kind: "active", side: "front", revealed: true });
    expect(toggleRevealedSide(frontView).state).toMatchObject({ kind: "active", side: "back" });
  });

  test("loads verified APKG-style media references without exposing unrelated blobs", async () => {
    const reference = "package-sha/media/photo%20one.png";
    const media: MediaRecord = {
      importId: "package-sha",
      name: "photo one.png",
      blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      mimeType: "image/png",
      byteLength: 4,
      sha256: "a".repeat(64),
    };
    const database = new MemoryStudyDatabase({
      ...seed(),
      cards: [{
        ...card(),
        frontHtml: `<img alt="Example" data-anki-media-ref="${reference}">`,
        mediaRefs: [reference],
      }],
      media: [media],
    });
    const service = makeService(database);

    expect(await service.loadMedia([reference, "other/media/missing.png"])).toEqual([{
      ref: reference,
      blob: media.blob,
      mimeType: "image/png",
    }]);
  });

  test("keeps future delayed work waiting and promotes it exactly when due", async () => {
    const database = new MemoryStudyDatabase(seed({
      session: session({
        activeCardId: null,
        completedPresentationCount: 1,
        plannedPresentationCount: 2,
        queueEntries: [{ cardId: CARD_ID, dueAt: NOW + 30_000, ordinal: 2 }],
      }),
    }));

    expect(await makeService(database).load(DECK_ID)).toMatchObject({
      kind: "waiting",
      nextDueAt: NOW + 30_000,
      completedPresentationCount: 1,
      plannedPresentationCount: 2,
    });
    expect(await makeService(database, NOW + 30_000).load(DECK_ID)).toMatchObject({
      kind: "active",
      cardId: CARD_ID,
      completedPresentationCount: 1,
      plannedPresentationCount: 2,
    });
  });

  test("restores immutable completion statistics instead of starting again", async () => {
    const completed = session({
      activeCardId: null,
      queueEntries: [],
      completedPresentationCount: 4,
      plannedPresentationCount: 4,
      ratingCounts: { again: 1, hard: 1, good: 1, easy: 1 },
      completedAt: NOW - 1_000,
    });
    const database = new MemoryStudyDatabase(seed({
      session: completed,
      schedule: schedule({ dueAt: NOW + 60_000, state: "review" }),
    }));

    const snapshot = await makeService(database).load(DECK_ID);
    expect(snapshot).toMatchObject({
      kind: "completion",
      sequence: 1,
      completedAt: NOW - 1_000,
      startedAt: NOW - 60_000,
      ratingCounts: { again: 1, hard: 1, good: 1, easy: 1 },
      nextDueAt: NOW + 60_000,
    });
    expect(database.snapshot().sessions).toEqual([completed]);
  });

  test("distinguishes caught-up and missing decks without empty sessions", async () => {
    const caughtUp = new MemoryStudyDatabase(seed({
      schedule: schedule({ dueAt: NOW + 60_000, state: "review" }),
    }));

    expect(await makeService(caughtUp).load(DECK_ID)).toMatchObject({
      kind: "caught-up",
      deckName: "Spanish Basics",
      sessionId: null,
    });
    expect(caughtUp.snapshot().sessions).toHaveLength(0);
    expect(await makeService(caughtUp).load("missing-deck")).toMatchObject({
      kind: "missing-deck",
      deckId: "missing-deck",
    });
    expect(await makeService(caughtUp).load("   ")).toMatchObject({
      kind: "missing-deck",
      deckId: "",
    });
  });

  test("commits reveal, rating, and suspension through the route boundary", async () => {
    const ratedDatabase = new MemoryStudyDatabase(seed({
      session: session(),
    }));
    const ratedService = makeService(ratedDatabase);

    await ratedService.reveal("session-1", CARD_ID);
    expect(await ratedService.load(DECK_ID)).toMatchObject({
      kind: "active",
      cardId: CARD_ID,
      side: "back",
      backText: "house",
    });

    await ratedService.rate("session-1", CARD_ID, "good", "ui-rate-good");
    expect(await ratedService.load(DECK_ID)).toMatchObject({
      kind: "waiting",
      completedPresentationCount: 1,
      plannedPresentationCount: 2,
    });
    expect(ratedDatabase.snapshot().reviewLogs ?? []).toHaveLength(1);
    expect(ratedDatabase.snapshot().decks?.[0]?.lastStudiedAt).toBe(NOW);

    const suspendedDatabase = new MemoryStudyDatabase(seed({
      session: session(),
    }));
    const suspendedService = makeService(suspendedDatabase);
    await suspendedService.suspend(
      "session-1",
      CARD_ID,
      "ui-suspend-current",
    );
    expect(await suspendedService.load(DECK_ID)).toMatchObject({
      kind: "completion",
      completedPresentationCount: 0,
      plannedPresentationCount: 0,
    });
    expect(suspendedDatabase.snapshot().schedules?.[0]).toMatchObject({
      cardId: CARD_ID,
      dueAt: NOW,
      stability: 0,
      difficulty: 0,
      suspended: true,
    });
    expect(suspendedDatabase.snapshot().reviewLogs ?? []).toHaveLength(0);
  });
});

function makeService(database: MemoryStudyDatabase, now = NOW) {
  return new StudyRouteService({
    database,
    clock: new FixedClock(now),
    scheduler: new PreviewScheduler(),
    timeZone: "UTC",
  });
}

function seed(options: {
  session?: SessionRecord;
  schedule?: ScheduleRecord;
} = {}) {
  return {
    decks: [deck()],
    cards: [card()],
    schedules: [options.schedule ?? schedule()],
    sessions: options.session ? [options.session] : [],
  };
}

function deck(): DeckRecord {
  return {
    id: DECK_ID,
    importId: "seed",
    sourceDeckId: null,
    name: "Spanish Basics",
    cardCount: 1,
    createdAt: NOW - 100_000,
    lastStudiedAt: null,
    sessionIntakeLimit: 20,
    schedulerConfigId: "deterministic",
  };
}

function card(): CardRecord {
  return {
    id: CARD_ID,
    deckId: DECK_ID,
    noteId: "note-casa",
    sourceCardId: null,
    templateOrdinal: 0,
    frontText: "casa",
    backText: "house",
    css: "",
    frontHtml: "casa",
    backHtml: "house",
    mediaRefs: [],
    creationOrder: 1,
    contentWarnings: [],
  };
}

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    cardId: CARD_ID,
    deckId: DECK_ID,
    dueAt: NOW,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: "new",
    lastReviewAt: null,
    suspended: false,
    learningSteps: 0,
    legacyEaseFactor: null,
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-1",
    deckId: DECK_ID,
    dayKey: "2026-09-01",
    sequence: 1,
    intakeLimit: 20,
    nextDayAt: NEXT_DAY,
    queueEntries: [{ cardId: CARD_ID, dueAt: NOW, ordinal: 1 }],
    activeCardId: CARD_ID,
    plannedPresentationCount: 1,
    completedPresentationCount: 0,
    currentSide: "front",
    ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
    startedAt: NOW - 60_000,
    updatedAt: NOW - 10_000,
    completedAt: null,
    lastCommandIds: [],
    ...overrides,
  };
}

class PreviewScheduler implements SchedulerAdapter {
  createNewCard(): ScheduleRecord {
    return schedule();
  }

  preview(): RatingPreviewMap {
    return Object.fromEntries(
      ([
        ["again", "1 min", 1],
        ["hard", "6 min", 6],
        ["good", "10 min", 10],
        ["easy", "4 d", 5_760],
      ] as const).map(([rating, intervalLabel, intervalMinutes]) => [rating, {
        rating,
        dueAt: NOW + intervalMinutes * 60_000,
        interval: intervalLabel,
        intervalLabel,
        intervalMinutes,
        intervalDays: intervalMinutes / 1_440,
        scheduledDays: rating === "easy" ? 4 : 0,
        state: "learning",
      }]),
    ) as unknown as RatingPreviewMap;
  }

  apply(schedule: ScheduleRecord, rating: Rating, now: Date): AppliedSchedule {
    const reviewedAt = now.getTime();
    const nextSchedule: ScheduleRecord = {
      ...schedule,
      dueAt: reviewedAt + 10 * 60_000,
      stability: schedule.stability + 1,
      reps: schedule.reps + 1,
      state: "learning",
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
