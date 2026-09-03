import { describe, expect, test } from "bun:test";

import {
  RATING_PREVIEW_LONG_ABSENCE_MS,
  RATING_PREVIEW_MEANINGFUL_TIME_MS,
  RatingPreviewSnapshotError,
  RatingPreviewSnapshotStore,
} from "../../lib/application/rating-preview-snapshot";
import type { Rating, ScheduleRecord } from "../../lib/domain/entities";
import type {
  AppliedSchedule,
  RatingCalculationMap,
  RatingPreviewMap,
  SchedulerAdapter,
} from "../../lib/domain/scheduler";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const DAY = 86_400_000;
const RATINGS = ["again", "hard", "good", "easy"] as const;

describe("RatingPreviewSnapshotStore", () => {
  test("samples one complete map once and preserves an 8d Easy result across ordinary reads", () => {
    const scheduler = new AdversarialScheduler();
    const store = new RatingPreviewSnapshotStore(scheduler);

    const first = store.getOrCreate(input());
    const repeated = store.getOrCreate(input({ capturedAt: NOW + 61 }));

    expect(scheduler.calculationCount).toBe(1);
    expect(repeated).toBe(first);
    expect(repeated.outcomes.easy.schedule.dueAt).toBe(NOW + 8 * DAY);
    expect(repeated.previews).toEqual(first.previews);
    expect(repeated.calculatedAt).toBe(NOW);
  });

  test("recalculates at every durable presentation identity boundary", () => {
    const changes = [
      { deckId: "deck-2", schedule: schedule({ deckId: "deck-2" }) },
      { sessionId: "session-2" },
      { cardId: "card-2", schedule: schedule({ cardId: "card-2" }) },
      { schedule: schedule({ reps: 2 }) },
      { schedulerPolicyId: "policy-2" },
    ] as const;

    for (const change of changes) {
      const scheduler = new AdversarialScheduler();
      const store = new RatingPreviewSnapshotStore(scheduler);
      store.getOrCreate(input());
      const next = store.getOrCreate(input(change));
      expect(scheduler.calculationCount).toBe(2);
      expect(next.outcomes.easy.schedule.dueAt).toBe(NOW + 7 * DAY);
    }
  });

  test("keeps minor time drift but recalculates at meaningful time and long restoration", () => {
    const scheduler = new AdversarialScheduler();
    const store = new RatingPreviewSnapshotStore(scheduler);
    const first = store.getOrCreate(input());

    expect(store.getOrCreate(input({
      capturedAt: NOW + RATING_PREVIEW_MEANINGFUL_TIME_MS - 1,
    }))).toBe(first);
    expect(store.getOrCreate(input({
      capturedAt: NOW + RATING_PREVIEW_MEANINGFUL_TIME_MS,
    }))).not.toBe(first);

    const restoredStore = new RatingPreviewSnapshotStore(new AdversarialScheduler());
    const beforeAbsence = restoredStore.getOrCreate(input());
    restoredStore.notePresentationUnavailable(NOW + 1);
    expect(restoredStore.getOrCreate(input({
      capturedAt: NOW + RATING_PREVIEW_LONG_ABSENCE_MS - 1,
    }))).toBe(beforeAbsence);
    restoredStore.notePresentationUnavailable(NOW + RATING_PREVIEW_LONG_ABSENCE_MS);
    expect(restoredStore.getOrCreate(input({
      capturedAt: NOW + 2 * RATING_PREVIEW_LONG_ABSENCE_MS,
    }))).not.toBe(beforeAbsence);
  });

  test("rejects incomplete, extra, mismatched, and cross-identity scheduler material", () => {
    const invalidMaps = [
      (value: Record<string, unknown>) => { delete value.easy; },
      (value: Record<string, unknown>) => { value.bonus = value.easy; },
      (value: Record<string, any>) => { value.easy.preview.rating = "good"; },
      (value: Record<string, any>) => { value.good.schedule.cardId = "card-other"; },
      (value: Record<string, any>) => { value.hard.log.dueAt += 1; },
    ];

    for (const corrupt of invalidMaps) {
      const scheduler = new AdversarialScheduler(corrupt);
      expect(() => new RatingPreviewSnapshotStore(scheduler).getOrCreate(input()))
        .toThrow(RatingPreviewSnapshotError);
    }
  });
});

class AdversarialScheduler implements SchedulerAdapter {
  calculationCount = 0;

  constructor(
    private readonly corrupt?: (value: Record<string, any>) => void,
  ) {}

  createNewCard(): ScheduleRecord {
    return schedule();
  }

  calculate(source: ScheduleRecord, now: Date): RatingCalculationMap {
    this.calculationCount += 1;
    const easyDays = this.calculationCount === 1 ? 8 : 7;
    const value = Object.fromEntries(RATINGS.map((rating, index) => {
      const scheduledDays = rating === "easy" ? easyDays : index + 1;
      const dueAt = now.getTime() + scheduledDays * DAY;
      const applied = schedule({
        cardId: source.cardId,
        deckId: source.deckId,
        dueAt,
        scheduledDays,
        reps: source.reps + 1,
        state: "review",
        lastReviewAt: now.getTime(),
      });
      return [rating, {
        preview: {
          rating,
          dueAt,
          interval: `${scheduledDays}d`,
          intervalLabel: `${scheduledDays}d`,
          intervalMinutes: scheduledDays * 1_440,
          intervalDays: scheduledDays,
          scheduledDays,
          state: applied.state,
        },
        schedule: applied,
        log: {
          rating,
          state: applied.state,
          dueAt,
          stability: applied.stability,
          difficulty: applied.difficulty,
          elapsedDays: applied.elapsedDays,
          lastElapsedDays: source.elapsedDays,
          scheduledDays,
          learningSteps: applied.learningSteps ?? 0,
          reviewedAt: now.getTime(),
        },
      }];
    })) as RatingCalculationMap;
    this.corrupt?.(value as unknown as Record<string, any>);
    return value;
  }

  preview(source: ScheduleRecord, now: Date): RatingPreviewMap {
    const calculated = this.calculate(source, now);
    return Object.fromEntries(RATINGS.map((rating) => [
      rating,
      calculated[rating].preview,
    ])) as RatingPreviewMap;
  }

  apply(source: ScheduleRecord, rating: Rating, now: Date): AppliedSchedule {
    return this.calculate(source, now)[rating];
  }

  retrievability(): null {
    return null;
  }
}

function input(overrides: Partial<Parameters<RatingPreviewSnapshotStore["getOrCreate"]>[0]> = {}) {
  return {
    deckId: "deck-1",
    sessionId: "session-1",
    cardId: "card-1",
    schedule: schedule(),
    schedulerPolicyId: "production-fuzz-v1",
    capturedAt: NOW,
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    cardId: "card-1",
    deckId: "deck-1",
    dueAt: NOW,
    stability: 4,
    difficulty: 5,
    elapsedDays: 3,
    scheduledDays: 3,
    reps: 1,
    lapses: 0,
    state: "review",
    lastReviewAt: NOW - 3 * DAY,
    suspended: false,
    learningSteps: 0,
    legacyEaseFactor: null,
    ...overrides,
  };
}
