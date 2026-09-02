import { describe, expect, test } from "bun:test";

import type { ScheduleRecord } from "../../lib/domain/entities";
import {
  DETERMINISTIC_SCHEDULER_CONFIG,
  PRODUCTION_SCHEDULER_CONFIG,
  SchedulerValidationError,
  TsFsrsSchedulerAdapter,
} from "../../lib/domain/scheduler";
import { FixedClock } from "../../lib/platform/clock";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const CARD_ID = "card-spanish-001";
const DECK_ID = "deck-spanish";

describe("TsFsrsSchedulerAdapter", () => {
  test("keeps production and deterministic fuzz policies explicit", () => {
    expect(PRODUCTION_SCHEDULER_CONFIG.requestRetention).toBe(0.9);
    expect(PRODUCTION_SCHEDULER_CONFIG.maximumInterval).toBe(36_500);
    expect(PRODUCTION_SCHEDULER_CONFIG.enableFuzz).toBe(true);
    expect(DETERMINISTIC_SCHEDULER_CONFIG.enableFuzz).toBe(false);
  });

  test("uses the injected clock for the convenience creation path", () => {
    const adapter = new TsFsrsSchedulerAdapter({
      config: DETERMINISTIC_SCHEDULER_CONFIG,
      clock: new FixedClock(NOW.getTime()),
    });

    expect(adapter.createNewCardFor(CARD_ID, DECK_ID)).toMatchObject({
      cardId: CARD_ID,
      deckId: DECK_ID,
      dueAt: NOW.getTime(),
      state: "new",
      lastReviewAt: null,
    });

    expect(adapter.createNewCard(NOW)).toMatchObject({
      dueAt: NOW.getTime(),
      state: "new",
      lastReviewAt: null,
    });
  });

  test("returns serializable previews for all ratings from one configuration", () => {
    const adapter = deterministicAdapter();
    const schedule = adapter.createNewCardFor(CARD_ID, DECK_ID, NOW);
    const previews = adapter.preview(schedule, NOW);

    expect(Object.keys(previews)).toEqual(["again", "hard", "good", "easy"]);
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      const preview = previews[rating];
      expect(preview.rating).toBe(rating);
      expect(Number.isFinite(preview.dueAt)).toBe(true);
      expect(preview.interval.length).toBeGreaterThan(0);
      expect(Number.isFinite(preview.intervalMinutes)).toBe(true);
      expect(preview.state).toMatch(/^(new|learning|review|relearning)$/);
      expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
    }
  });

  test("applies every rating to new, learning, review, and relearning records", () => {
    const adapter = deterministicAdapter();
    const states: ScheduleRecord[] = [
      adapter.createNewCardFor("new-card", DECK_ID, NOW),
      makeSchedule("learning-card", "learning", NOW.getTime() - 120_000),
      makeSchedule("review-card", "review", NOW.getTime() - 86_400_000),
      makeSchedule("relearning-card", "relearning", NOW.getTime() - 120_000),
    ];

    for (const schedule of states) {
      for (const rating of ["again", "hard", "good", "easy"] as const) {
        const result = adapter.apply(schedule, rating, NOW);
        expect(result.schedule.cardId).toBe(schedule.cardId);
        expect(result.schedule.deckId).toBe(schedule.deckId);
        expect(Number.isFinite(result.schedule.dueAt)).toBe(true);
        expect(result.schedule.state).toMatch(/^(new|learning|review|relearning)$/);
        expect(result.log.rating).toBe(rating);
        expect(result.log.reviewedAt).toBe(NOW.getTime());
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      }
    }
  });

  test("is repeatable when fuzz is disabled", () => {
    const adapter = deterministicAdapter();
    const schedule = makeSchedule(
      CARD_ID,
      "review",
      NOW.getTime() - 5 * 86_400_000,
    );

    expect(adapter.preview(schedule, NOW)).toEqual(adapter.preview(schedule, NOW));
    expect(adapter.apply(schedule, "good", NOW)).toEqual(
      adapter.apply(schedule, "good", NOW),
    );
  });

  test("derives retrievability from the same translated schedule", () => {
    const adapter = deterministicAdapter();
    expect(adapter.retrievability(
      makeSchedule(CARD_ID, "review", NOW.getTime() - 86_400_000),
      NOW,
    )).toSatisfy((value) => value !== null && value >= 0 && value <= 1);
    expect(adapter.retrievability(
      adapter.createNewCardFor(CARD_ID, DECK_ID, NOW),
      NOW,
    )).toBeNull();
  });

  test("rejects invalid persisted records and invalid dates with typed errors", () => {
    const adapter = deterministicAdapter();
    const invalid = makeSchedule(CARD_ID, "review", NOW.getTime());
    invalid.stability = Number.NaN;

    expect(() => adapter.preview(invalid, NOW)).toThrow(SchedulerValidationError);
    expect(() => adapter.preview(invalid, NOW)).toThrow(
      /stability must be a finite number/,
    );
    expect(() => adapter.apply(
      makeSchedule(CARD_ID, "review", NOW.getTime()),
      "good",
      new Date("invalid"),
    )).toThrow(/valid Date/);
  });
});

function deterministicAdapter(): TsFsrsSchedulerAdapter {
  return new TsFsrsSchedulerAdapter({
    config: DETERMINISTIC_SCHEDULER_CONFIG,
    clock: new FixedClock(NOW.getTime()),
  });
}

function makeSchedule(
  cardId: string,
  state: ScheduleRecord["state"],
  dueAt: number,
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
    lapses: state === "relearning" ? 1 : 0,
    state,
    lastReviewAt: state === "new" ? null : NOW.getTime() - 86_400_000,
    suspended: false,
    learningSteps: state === "learning" || state === "relearning" ? 0 : undefined,
    legacyEaseFactor: null,
  };
}
