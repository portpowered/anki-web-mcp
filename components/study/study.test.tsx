import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import { Flashcard, FlashcardToggleButton } from "./flashcard";
import { normalizeStudyProgress, StudyHeader } from "./study-header";

type TestElement = ReactElement<Record<string, unknown>>;

describe("study header presentation", () => {
  test("renders deck identity, progress semantics, and a stable return action", () => {
    const markup = renderToStaticMarkup(
      <StudyHeader
        deck={{ name: "Spanish Vocabulary" }}
        onReturnToDecks={() => undefined}
        progress={{ current: 15, total: 20 }}
      />,
    );

    expect(markup).toContain("Spanish Vocabulary");
    expect(markup).toContain("15 / 20");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="15"');
    expect(markup).toContain('aria-valuemax="20"');
    expect(markup).toContain('aria-label="Study progress: 15 of 20"');
    expect(markup).toContain('aria-label="Return to decks"');
    expect(markup).toContain('data-study-action="return"');
  });

  test("keeps session and card identifiers out of the visible header", () => {
    const markup = renderToStaticMarkup(
      <StudyHeader
        deck={{ name: "Spanish Vocabulary", sessionSequence: 2, currentCardId: "card-123" }}
        onReturnToDecks={() => undefined}
        progress={{ current: 1, total: 20 }}
      />,
    );

    expect(markup).toMatch(/<p hidden="" data-study-session="true">/);
    expect(markup).toContain('class="sr-only" data-study-card-id="true"');
    expect(markup).not.toContain("· Card");
    expect(markup).toContain("truncate");
    expect(markup).toContain('title="Spanish Vocabulary"');
  });

  test("normalizes invalid progress without an invalid ARIA value", () => {
    expect(normalizeStudyProgress({ current: -4, total: 0 })).toEqual({
      current: 0,
      total: 1,
      percentage: 0,
    });
    expect(normalizeStudyProgress({ current: 99, total: Number.NaN })).toEqual({
      current: 0,
      total: 1,
      percentage: 0,
    });

    const markup = renderToStaticMarkup(
      <StudyHeader
        deck={{ name: "Deck" }}
        onReturnToDecks={() => undefined}
        progress={{ current: Number.POSITIVE_INFINITY, total: -10 }}
      />,
    );

    expect(markup).toContain("0 / 1");
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Infinity");
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('aria-valuemax="1"');
  });
});

describe("controlled flashcard presentation", () => {
  test("renders exactly one side across the full card surface", () => {
    const front = renderToStaticMarkup(
      <Flashcard
        backContent="house"
        frontContent="casa"
        onToggle={() => undefined}
        side="front"
      />,
    );
    const back = renderToStaticMarkup(
      <Flashcard
        backContent="house"
        frontContent="casa"
        onToggle={() => undefined}
        side="back"
      />,
    );

    expect(front).toContain('data-flashcard-side="front"');
    expect(front).toContain("min-h-0");
    expect(front).toContain("flex-1");
    expect(front).toContain("casa");
    expect(front).not.toContain("house");
    expect(front).toContain('data-flashcard-front-context="true"');
    expect(front).toContain("h-full");
    expect(front).toContain("w-full");
    expect(front).toContain("grid-rows-1");
    expect(front).not.toContain('data-flashcard-answer="true"');
    expect(front).toContain('data-flashcard-surface="true"');
    expect(front).not.toContain('data-flashcard-toggle-control="true"');
    expect(back).toContain('data-flashcard-side="back"');
    expect(back).toContain("min-h-0");
    expect(back).toContain("flex-1");
    expect(back).toContain("house");
    expect(back).not.toContain("casa");
    expect(back).not.toContain('data-flashcard-front-context="true"');
    expect(back).toContain("grid-rows-1");
    expect(back).toContain('data-flashcard-surface="true"');
    expect(back).toContain('data-flashcard-answer="true"');

    const showAnswer = renderToStaticMarkup(
      <FlashcardToggleButton onToggle={() => undefined} side="front" />,
    );
    const showFront = renderToStaticMarkup(
      <FlashcardToggleButton onToggle={() => undefined} side="back" />,
    );
    expect(showAnswer).toContain('aria-label="Show Answer"');
    expect(showFront).toContain('aria-label="Show Front"');
  });

  test("keeps the surface request and explicit button as one callback each", () => {
    const events: string[] = [];
    const tree = Flashcard({
      backContent: "house",
      frontContent: "casa",
      onToggle: () => events.push("toggle"),
      side: "front",
    });
    const root = tree as TestElement;
    const toggle = FlashcardToggleButton({
      onToggle: () => events.push("toggle"),
      side: "front",
    }) as TestElement;

    const surfaceClick = root.props.onClick as
      | ((event: { defaultPrevented: boolean; target: null }) => void)
      | undefined;
    surfaceClick?.({ defaultPrevented: false, target: null });

    const buttonClick = toggle.props.onClick as (() => void) | undefined;
    buttonClick?.();

    expect(events).toEqual(["toggle", "toggle"]);
  });
});
