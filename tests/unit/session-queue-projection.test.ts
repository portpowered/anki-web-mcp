import { describe, expect, test } from "bun:test";
import {
  firstSessionOccurrenceForCard,
  projectSessionQueue,
} from "../../lib/application/session-queue-projection";

describe("session queue projection", () => {
  test("keeps future same-day occurrences active and preserves their due time", () => {
    const projection = projectSessionQueue([
      { cardId: "later", dueAt: 200, ordinal: 1 },
      { cardId: "next", dueAt: 100, ordinal: 2 },
    ]);

    expect(projection).toEqual({
      entries: [
        { cardId: "next", dueAt: 100, ordinal: 2 },
        { cardId: "later", dueAt: 200, ordinal: 1 },
      ],
      nextEntry: { cardId: "next", dueAt: 100, ordinal: 2 },
      nextCardId: "next",
      nextPresentationDueAt: 100,
      state: "active",
    });
  });

  test("completes only when no session occurrence remains", () => {
    expect(projectSessionQueue([])).toMatchObject({
      nextCardId: null,
      nextPresentationDueAt: null,
      state: "completed",
    });
  });

  test("selects the same ordered occurrence used by the projection", () => {
    expect(firstSessionOccurrenceForCard([
      { cardId: "card", dueAt: 200, ordinal: 1 },
      { cardId: "card", dueAt: 100, ordinal: 2 },
    ], "card")).toEqual({ cardId: "card", dueAt: 100, ordinal: 2 });
  });
});
