import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DeckHeader } from "./deck-header";
import { DeckList } from "./deck-list";
import {
  DeckRow,
  formatDeckCount,
  getDeckIconName,
  hasNonZeroDeckCount,
  type DeckSummary,
} from "./deck-row";

const biology: DeckSummary = {
  id: "biology",
  name: "Biology",
  cardCount: 523,
  lastStudiedLabel: "Studied 2d ago",
  icon: "leaf",
};

describe("deck presentation components", () => {
  test("renders the reference deck heading and an accessible import callback control", () => {
    const markup = renderToStaticMarkup(<DeckHeader onImport={() => undefined} />);

    expect(markup).toContain("Your Decks");
    expect(markup).toContain("Manage and study your flashcard decks.");
    expect(markup).toContain('data-deck-action="import"');
    expect(markup).toContain('aria-label="Import Deck"');
    expect(markup).toContain(">Import Deck</span>");
  });

  test("renders counts, supplied relative study text, and a deterministic icon", () => {
    const markup = renderToStaticMarkup(
      <DeckRow
        deck={{ ...biology, cardCount: 1342, dueCount: 12 }}
        onRemove={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain("1,342 cards");
    expect(markup).toContain("12 due");
    expect(markup).toContain("Studied 2d ago");
    expect(markup).toContain('data-deck-id="biology"');
    expect(markup).toContain('data-deck-action="study"');
    expect(markup).toContain('data-deck-action="remove"');
  });

  test("shows truthful zero counts and supplies the not-studied fallback", () => {
    const markup = renderToStaticMarkup(
      <DeckRow
        deck={{
          ...biology,
          dueCount: 0,
          suspendedCount: 0,
          lastStudiedLabel: null,
        }}
        onRemove={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain("0 due");
    expect(markup).toContain("0 suspended");
    expect(markup).toContain("Not studied yet");
  });

  test("keeps action names separate and keyboard-operable as native buttons", () => {
    const markup = renderToStaticMarkup(
      <DeckRow
        deck={{ ...biology, name: "A very long deck name that can wrap at a narrow viewport" }}
        onRemove={() => undefined}
        onSelect={() => undefined}
        studyAction="resume"
      />,
    );

    expect(markup).toContain('aria-label="Resume studying A very long deck name that can wrap at a narrow viewport"');
    expect(markup).toContain('aria-label="Remove A very long deck name that can wrap at a narrow viewport"');
    expect(markup.match(/<button\b/g)?.length).toBe(2);
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("break-words");
  });

  test("list preserves every deck as a separate semantic list item", () => {
    const markup = renderToStaticMarkup(
      <DeckList
        decks={[biology, { ...biology, id: "spanish", name: "Spanish Vocabulary" }]}
        onRemove={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Available decks"');
    expect(markup.match(/<li>/g)?.length).toBe(2);
    expect(markup).toContain("Spanish Vocabulary");
  });

  test("count and icon helpers remain deterministic for display callers", () => {
    expect(formatDeckCount(2034)).toBe("2,034");
    expect(formatDeckCount("1 105")).toBe("1 105");
    expect(hasNonZeroDeckCount(0)).toBe(false);
    expect(hasNonZeroDeckCount("0")).toBe(false);
    expect(hasNonZeroDeckCount("1,342")).toBe(true);
    expect(getDeckIconName(biology)).toBe(getDeckIconName(biology));
  });
});
