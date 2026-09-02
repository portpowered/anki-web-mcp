import { describe, expect, test } from "bun:test";

import type { ScheduleState } from "../../lib/domain/entities";
import {
  DEFAULT_SESSION_INTAKE_LIMIT,
  type IntakeCandidate,
  selectEligibleIntake,
} from "../../lib/domain/queue-policy";

const NOW = 1_000_000;

describe("selectEligibleIntake", () => {
  test("orders due learning, relearning, and review before new cards", () => {
    const candidates = [
      candidate("new-late", "new", NOW - 1, 30),
      candidate("review-old", "review", NOW - 30, 1),
      candidate("learning-new", "learning", NOW - 1, 2),
      candidate("new-early", "new", NOW - 1, 10),
      candidate("relearning-old", "relearning", NOW - 40, 3),
      candidate("learning-old", "learning", NOW - 50, 4),
      candidate("review-new", "review", NOW - 2, 5),
    ];

    const result = selectEligibleIntake({
      candidates,
      now: NOW,
      intakeLimit: 20,
    });

    expect(result.status).toBe("selected");
    if (result.status !== "selected") return;
    expect(result.cardIds).toEqual([
      "learning-old",
      "learning-new",
      "relearning-old",
      "review-old",
      "review-new",
      "new-early",
      "new-late",
    ]);
  });

  test("uses card ID as the stable tie-breaker and ignores input order", () => {
    const candidates = [
      candidate("review-z", "review", NOW, 1),
      candidate("review-a", "review", NOW, 2),
      candidate("new-z", "new", NOW, 5),
      candidate("new-a", "new", NOW, 5),
    ];

    const forward = selectEligibleIntake({
      candidates,
      now: NOW,
    });
    const reversed = selectEligibleIntake({
      candidates: [...candidates].reverse(),
      now: NOW,
    });

    expect(forward).toEqual(reversed);
    expect(forward.cardIds).toEqual([
      "review-a",
      "review-z",
      "new-a",
      "new-z",
    ]);
  });

  test("includes cards exactly due at now, excludes future scheduled cards, and admits new cards", () => {
    const result = selectEligibleIntake({
      candidates: [
        candidate("future", "review", NOW + 1, 1),
        candidate("exactly-due", "review", NOW, 2),
        candidate("past-due", "review", NOW - 1, 3),
        candidate("new-card", "new", NOW + 1, 4),
      ],
      now: NOW,
    });

    expect(result.status).toBe("selected");
    if (result.status !== "selected") return;
    expect(result.cardIds).toEqual(["past-due", "exactly-due", "new-card"]);
  });

  test("excludes suspended cards and cards pending in incomplete sessions", () => {
    const result = selectEligibleIntake({
      candidates: [
        candidate("suspended", "review", NOW - 1, 1, true),
        candidate("pending", "review", NOW - 2, 2),
        candidate("historical", "review", NOW - 3, 3),
        candidate("available", "review", NOW - 4, 4),
      ],
      now: NOW,
      incompleteSessions: [
        {
          completedAt: null,
          queueEntries: [{ cardId: "pending" }],
        },
        {
          completedAt: NOW,
          queueEntries: [{ cardId: "historical" }],
        },
      ],
    });

    expect(result.status).toBe("selected");
    if (result.status !== "selected") return;
    expect(result.cardIds).toEqual(["available", "historical"]);
  });

  test("deduplicates IDs, is independent of enumeration order, and defaults to 20", () => {
    const candidates = Array.from({ length: 25 }, (_, index) => {
      const number = index + 1;
      return candidate(`card-${String(number).padStart(2, "0")}`, "new", NOW, number);
    });
    candidates.push(candidates[4], candidates[4]);

    const forward = selectEligibleIntake({ candidates, now: NOW });
    const reversed = selectEligibleIntake({
      candidates: [...candidates].reverse(),
      now: NOW,
    });

    expect(forward.status).toBe("selected");
    expect(reversed.status).toBe("selected");
    if (forward.status !== "selected" || reversed.status !== "selected") return;
    expect(forward.intakeLimit).toBe(DEFAULT_SESSION_INTAKE_LIMIT);
    expect(forward.cardIds).toHaveLength(DEFAULT_SESSION_INTAKE_LIMIT);
    expect(new Set(forward.cardIds).size).toBe(DEFAULT_SESSION_INTAKE_LIMIT);
    expect(forward.cardIds).toEqual(reversed.cardIds);
    expect(forward.cardIds).toEqual(
      candidates
        .slice(0, 20)
        .map((item) => item.card.id),
    );
  });

  test("returns explicit no-eligible outcomes for empty, suspended, and caught-up decks", () => {
    expect(selectEligibleIntake({ candidates: [], now: NOW })).toMatchObject({
      status: "no-eligible-cards",
      kind: "no-eligible-cards",
      reason: "empty",
    });

    expect(selectEligibleIntake({
      candidates: [
        candidate("suspended-a", "review", NOW, 1, true),
        candidate("suspended-b", "new", NOW, 2, true),
      ],
      now: NOW,
    })).toMatchObject({
      status: "no-eligible-cards",
      reason: "all-suspended",
    });

    expect(selectEligibleIntake({
      candidates: [candidate("future", "review", NOW + 1, 1)],
      now: NOW,
    })).toMatchObject({
      status: "no-eligible-cards",
      reason: "caught-up",
    });
  });

  test("returns fewer than the limit without creating filler entries", () => {
    const result = selectEligibleIntake({
      candidates: [
        candidate("one", "new", NOW, 1),
        candidate("two", "new", NOW, 2),
      ],
      now: NOW,
      intakeLimit: 20,
    });

    expect(result.status).toBe("selected");
    if (result.status !== "selected") return;
    expect(result.cardIds).toEqual(["one", "two"]);
    expect(result.candidates).toHaveLength(2);
  });
});

function candidate(
  cardId: string,
  state: ScheduleState,
  dueAt: number,
  creationOrder: number,
  suspended = false,
): IntakeCandidate {
  return {
    card: {
      id: cardId,
      creationOrder,
    },
    schedule: {
      cardId,
      dueAt,
      state,
      suspended,
    },
  };
}
