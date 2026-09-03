import { describe, expect, test } from "bun:test";

import { StudyRouteService } from "../../lib/application/study-route-service";
import type {
  CardRecord,
  DeckRecord,
  MediaRecord,
  Rating,
  ReviewLogRecord,
  ScheduleRecord,
  SessionRecord,
} from "../../lib/domain/entities";
import type {
  AppliedSchedule,
  RatingCalculationMap,
  RatingPreviewMap,
  SchedulerAdapter,
  SchedulerLog,
} from "../../lib/domain/scheduler";
import {
  PRODUCTION_SCHEDULER_CONFIG,
  TsFsrsSchedulerAdapter,
} from "../../lib/domain/scheduler";
import { MemoryStudyDatabase } from "../../lib/persistence/db";
import { FixedClock } from "../../lib/platform/clock";
import type { Clock } from "../../lib/domain/ports";
import {
  studyViewFromSnapshot,
  toggleRevealedSide,
} from "../../components/study-route-preview";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const NEXT_DAY = Date.parse("2026-09-02T00:00:00.000Z");
const DECK_ID = "deck-spanish";
const CARD_ID = "card-casa";
const NEXT_CARD_ID = "card-perro";

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

  test("keeps one adversarial production-style sample across honest repeated loads", async () => {
    const database = new MemoryStudyDatabase(seed({ session: session() }));
    const clock = new MutableClock(NOW);
    const scheduler = new PreviewScheduler([8, 7]);
    const service = new StudyRouteService({
      database,
      clock,
      scheduler,
      timeZone: "UTC",
    });

    const first = await service.load(DECK_ID);
    clock.timestamp += 61;
    const repeated = await service.load(DECK_ID);

    expect(first.kind).toBe("active");
    expect(repeated.kind).toBe("active");
    expect(repeated.capturedAt).toBe(first.capturedAt + 61);
    expect(scheduler.calculationCount).toBe(1);
    if (first.kind !== "active" || repeated.kind !== "active") {
      throw new Error("expected active snapshots");
    }
    expect(first.ratingPreviews.easy.scheduledDays).toBe(8);
    expect(repeated.ratingPreviews).toEqual(first.ratingPreviews);
  });

  test("keeps the real production-fuzz 8d sample through public route reloads", async () => {
    const productionSchedule = schedule({
      stability: 0.5,
      difficulty: 3,
      elapsedDays: 1,
      scheduledDays: 1,
      reps: 1,
      state: "review",
      lastReviewAt: NOW - 86_400_000,
    });
    const database = new MemoryStudyDatabase(seed({
      session: session(),
      schedule: productionSchedule,
    }));
    const clock = new MutableClock(NOW);
    const seeds = ["0", "3"];
    let seedCount = 0;
    const service = new StudyRouteService({
      database,
      clock,
      scheduler: new TsFsrsSchedulerAdapter({
        config: PRODUCTION_SCHEDULER_CONFIG,
        fuzzSeed: () => seeds[seedCount++]!,
      }),
      timeZone: "UTC",
    });

    const first = await service.load(DECK_ID);
    clock.timestamp += 61;
    const repeated = await service.load(DECK_ID);

    if (first.kind !== "active" || repeated.kind !== "active") {
      throw new Error("expected active snapshots");
    }
    expect(first.ratingPreviews.easy).toMatchObject({ interval: "8d", scheduledDays: 8 });
    expect(repeated.ratingPreviews).toEqual(first.ratingPreviews);
    expect(repeated.capturedAt).toBe(first.capturedAt + 61);
    expect(seedCount).toBe(1);
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
      backContentOwnsAnswerRegion: true,
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

  test("projects future same-day work as active before and at its due time", async () => {
    const database = new MemoryStudyDatabase(seed({
      session: session({
        activeCardId: null,
        completedPresentationCount: 1,
        plannedPresentationCount: 2,
        queueEntries: [{ cardId: CARD_ID, dueAt: NOW + 30_000, ordinal: 2 }],
      }),
    }));

    expect(await makeService(database).load(DECK_ID)).toMatchObject({
      kind: "active",
      cardId: CARD_ID,
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
    const sameDaySnapshot = await ratedService.load(DECK_ID);
    expect(sameDaySnapshot).toMatchObject({
      kind: "active",
      cardId: CARD_ID,
      completedPresentationCount: 1,
      plannedPresentationCount: 2,
      completedTodayCount: 0,
      todayCardCount: 1,
    });
    expect(studyViewFromSnapshot(sameDaySnapshot).progress).toEqual({ current: 0, total: 1 });
    expect(ratedDatabase.snapshot().schedules?.[0]?.dueAt).toBe(NOW + 10 * 60_000);
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

  test("commits the exact selected retained outcome without resampling", async () => {
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      const nextCard = {
        ...card(),
        id: NEXT_CARD_ID,
        noteId: "note-perro",
        frontText: "perro",
        backText: "dog",
        frontHtml: "perro",
        backHtml: "dog",
        creationOrder: 2,
      };
      const database = new MemoryStudyDatabase(seed({
        cards: [card(), nextCard],
        schedules: [schedule(), schedule({ cardId: NEXT_CARD_ID })],
        session: session({
          queueEntries: [
            { cardId: CARD_ID, dueAt: NOW, ordinal: 1 },
            { cardId: NEXT_CARD_ID, dueAt: NOW, ordinal: 2 },
          ],
          plannedPresentationCount: 2,
        }),
      }));
      const scheduler = new PreviewScheduler([8, 7]);
      const service = new StudyRouteService({
        database,
        clock: new FixedClock(NOW),
        scheduler,
        timeZone: "UTC",
      });

      const shown = await service.load(DECK_ID);
      if (shown.kind !== "active") throw new Error("expected an active presentation");
      await service.reveal("session-1", CARD_ID);
      const result = await service.rate(
        "session-1",
        CARD_ID,
        rating,
        `exact-${rating}`,
      );

      expect(result.schedule?.dueAt).toBe(shown.ratingPreviews[rating].dueAt);
      expect(result.reviewLog?.after.dueAt).toBe(shown.ratingPreviews[rating].dueAt);
      expect(result.reviewLog?.after.scheduledDays)
        .toBe(shown.ratingPreviews[rating].scheduledDays);
      const next = await service.load(DECK_ID);
      if (next.kind !== "active") throw new Error("expected the next presentation");
      expect(next.cardId).toBe(NEXT_CARD_ID);
      expect(next.ratingPreviews).not.toEqual(shown.ratingPreviews);
      expect(scheduler.calculationCount).toBe(2);
      expect(scheduler.applyCount).toBe(0);
    }
  });

  test("rejects a stale retained outcome before any review write", async () => {
    const database = new MemoryStudyDatabase(seed({ session: session() }));
    const scheduler = new PreviewScheduler();
    const service = new StudyRouteService({
      database,
      clock: new FixedClock(NOW),
      scheduler,
      timeZone: "UTC",
    });
    await service.load(DECK_ID);
    await service.reveal("session-1", CARD_ID);
    await database.transaction("readwrite", ["schedules"], async (transaction) => {
      await transaction.putSchedule(schedule({ reps: 2 }));
    });
    const before = database.snapshot();

    await expect(service.rate("session-1", CARD_ID, "good", "stale-preview"))
      .rejects.toMatchObject({ code: "conflict" });

    expect(database.snapshot()).toEqual(before);
    expect(scheduler.applyCount).toBe(0);
  });

  test("counts a card as completed today only when its next due time is beyond today", async () => {
    const completed = session({
      activeCardId: null,
      queueEntries: [],
      completedPresentationCount: 1,
      plannedPresentationCount: 1,
      completedAt: NOW,
    });
    const database = new MemoryStudyDatabase(seed({
      session: completed,
      schedule: schedule({
        dueAt: NEXT_DAY,
        lastReviewAt: NOW,
        reps: 1,
        state: "review",
      }),
      reviewLogs: [reviewLog(completed.id, CARD_ID, NEXT_DAY)],
    }));

    const snapshot = await makeService(database).load(DECK_ID);
    expect(snapshot).toMatchObject({
      kind: "completion",
      completedTodayCount: 1,
      todayCardCount: 1,
    });
    expect(studyViewFromSnapshot(snapshot).progress).toEqual({ current: 1, total: 1 });
  });

  test("starts a later same-day session with independent unique-card progress", async () => {
    const cards = Array.from({ length: 24 }, (_, index): CardRecord => ({
      ...card(),
      id: `card-${index + 1}`,
      noteId: `note-${index + 1}`,
      frontText: `front-${index + 1}`,
      backText: `back-${index + 1}`,
      frontHtml: `front-${index + 1}`,
      backHtml: `back-${index + 1}`,
      creationOrder: index + 1,
    }));
    const completedCards = cards.slice(0, 20);
    const remainingCards = cards.slice(20);
    const firstSession = session({
      activeCardId: null,
      queueEntries: [],
      completedPresentationCount: 20,
      plannedPresentationCount: 20,
      ratingCounts: { again: 0, hard: 0, good: 20, easy: 0 },
      completedAt: NOW - 10,
      updatedAt: NOW - 10,
    });
    const secondSession = session({
      id: "session-2",
      sequence: 2,
      queueEntries: remainingCards.map((value, index) => ({
        cardId: value.id,
        dueAt: NOW,
        ordinal: index + 1,
      })),
      activeCardId: remainingCards[0]!.id,
      plannedPresentationCount: 4,
      startedAt: NOW - 5,
      updatedAt: NOW,
    });
    const database = new MemoryStudyDatabase({
      decks: [{ ...deck(), cardCount: 24 }],
      cards,
      schedules: cards.map((value, index) => schedule({
        cardId: value.id,
        ...(index < 20
          ? { dueAt: NEXT_DAY, lastReviewAt: NOW - 10, reps: 1, state: "review" as const }
          : {}),
      })),
      sessions: [firstSession, secondSession],
      reviewLogs: completedCards.map((value) => (
        reviewLog(firstSession.id, value.id, NEXT_DAY, NOW - 10)
      )),
    });

    const snapshot = await makeService(database).load(DECK_ID);
    expect(snapshot).toMatchObject({
      kind: "active",
      sessionId: secondSession.id,
      sequence: 2,
      cardId: remainingCards[0]!.id,
      completedTodayCount: 0,
      todayCardCount: 4,
    });
    expect(studyViewFromSnapshot(snapshot).progress).toEqual({ current: 0, total: 4 });
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
  cards?: CardRecord[];
  schedules?: ScheduleRecord[];
  reviewLogs?: ReviewLogRecord[];
} = {}) {
  return {
    decks: [deck()],
    cards: options.cards ?? [card()],
    schedules: options.schedules ?? [options.schedule ?? schedule()],
    sessions: options.session ? [options.session] : [],
    reviewLogs: options.reviewLogs ?? [],
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

function reviewLog(
  sessionId: string,
  cardId: string,
  dueAt: number,
  reviewedAt = NOW,
): ReviewLogRecord {
  const before = schedule();
  const after = schedule({ dueAt, lastReviewAt: reviewedAt, reps: 1, state: "review" });
  const snapshotOf = (value: ScheduleRecord): ReviewLogRecord["before"] => ({
    dueAt: value.dueAt,
    stability: value.stability,
    difficulty: value.difficulty,
    elapsedDays: value.elapsedDays,
    scheduledDays: value.scheduledDays,
    reps: value.reps,
    lapses: value.lapses,
    state: value.state,
    lastReviewAt: value.lastReviewAt,
    suspended: value.suspended,
    learningSteps: value.learningSteps,
    legacyEaseFactor: value.legacyEaseFactor,
  });
  return {
    id: `review-${sessionId}-${cardId}`,
    sessionId,
    deckId: DECK_ID,
    cardId,
    rating: "good",
    reviewedAt,
    durationMs: null,
    before: snapshotOf(before),
    after: snapshotOf(after),
    commandId: `command-${sessionId}-${cardId}`,
  };
}

class PreviewScheduler implements SchedulerAdapter {
  calculationCount = 0;
  applyCount = 0;

  constructor(private readonly easyDaysByCalculation: readonly number[] = [4]) {}

  createNewCard(): ScheduleRecord {
    return schedule();
  }

  preview(): RatingPreviewMap {
    const easyDays = this.easyDaysByCalculation[
      Math.max(0, this.calculationCount - 1)
    ] ?? this.easyDaysByCalculation.at(-1) ?? 4;
    return Object.fromEntries(
      ([
        ["again", "1 min", 1],
        ["hard", "6 min", 6],
        ["good", "10 min", 10],
        ["easy", `${easyDays} d`, easyDays * 1_440],
      ] as const).map(([rating, intervalLabel, intervalMinutes]) => [rating, {
        rating,
        dueAt: NOW + intervalMinutes * 60_000,
        interval: intervalLabel,
        intervalLabel,
        intervalMinutes,
        intervalDays: intervalMinutes / 1_440,
        scheduledDays: rating === "easy" ? easyDays : 0,
        state: "learning",
      }]),
    ) as unknown as RatingPreviewMap;
  }

  calculate(scheduleValue: ScheduleRecord, now: Date): RatingCalculationMap {
    this.calculationCount += 1;
    const previews = this.preview();
    return Object.fromEntries(([
      "again",
      "hard",
      "good",
      "easy",
    ] as const).map((rating) => {
      const preview = previews[rating];
      const nextSchedule: ScheduleRecord = {
        ...scheduleValue,
        dueAt: preview.dueAt,
        scheduledDays: preview.scheduledDays,
        state: preview.state,
        lastReviewAt: now.getTime(),
        reps: scheduleValue.reps + 1,
      };
      return [rating, {
        preview,
        schedule: nextSchedule,
        log: {
          rating,
          state: nextSchedule.state,
          dueAt: nextSchedule.dueAt,
          stability: nextSchedule.stability,
          difficulty: nextSchedule.difficulty,
          elapsedDays: nextSchedule.elapsedDays,
          lastElapsedDays: scheduleValue.elapsedDays,
          scheduledDays: nextSchedule.scheduledDays,
          learningSteps: nextSchedule.learningSteps ?? 0,
          reviewedAt: now.getTime(),
        },
      }];
    })) as unknown as RatingCalculationMap;
  }

  apply(schedule: ScheduleRecord, rating: Rating, now: Date): AppliedSchedule {
    this.applyCount += 1;
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

class MutableClock implements Clock {
  constructor(public timestamp: number) {}

  now(): number {
    return this.timestamp;
  }
}
