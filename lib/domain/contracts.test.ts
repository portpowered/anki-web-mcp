import { describe, expect, test } from "bun:test";

import { FixedClock } from "../platform/clock";
import { SequenceIdGenerator } from "../platform/ids";
import {
  NeutralScheduleInitializer,
} from "./scheduler";
import type { ScheduleState } from "./entities";
import {
  failure,
  mapDatabaseError,
  success,
  type DomainResult,
} from "./errors";

describe("domain contracts", () => {
  test("use injected clock and deterministic ID ports", () => {
    const clock = new FixedClock(1_735_689_600_000);
    const ids = new SequenceIdGenerator(["deck-fixed", "card-fixed"]);

    expect(clock.now()).toBe(1_735_689_600_000);
    expect(ids.next("deck")).toBe("deck-fixed");
    expect(ids.next("card")).toBe("card-fixed");
  });

  test("creates a scheduler-neutral new-card record through its interface", () => {
    const initializer = new NeutralScheduleInitializer(
      new FixedClock(1_735_689_600_000),
    );

    const schedule = initializer.initializeNewCard({
      cardId: "card-fixed",
      deckId: "deck-fixed",
    });

    expect(schedule).toEqual({
      cardId: "card-fixed",
      deckId: "deck-fixed",
      dueAt: 1_735_689_600_000,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: "new",
      lastReviewAt: null,
      suspended: false,
      legacyEaseFactor: null,
    });
  });

  test("lets callers branch on typed success and failure results", () => {
    const result: DomainResult<string> = readReadyResult();
    const failed = failure(
      mapDatabaseError(new DOMException("duplicate", "ConstraintError")),
    );

    if (result.ok) {
      expect(result.value).toBe("ready");
    } else {
      throw new Error(`Unexpected ${result.error.code} result.`);
    }

    if (failed.ok) {
      throw new Error("Expected a failed result.");
    }

    expect(failed.error.code).toBe("constraint");
    expect("cause" in failed.error).toBe(false);
  });

  test("maps expected database failures without exposing DOM exceptions", () => {
    const cases: Array<[string, ScheduleState]> = [
      ["AbortError", "new"],
      ["NotFoundError", "learning"],
    ];

    expect(cases.map(([name]) => mapDatabaseError({ name }).code)).toEqual([
      "transaction",
      "not-found",
    ]);
  });
});

function readReadyResult(): DomainResult<string> {
  return success("ready");
}
