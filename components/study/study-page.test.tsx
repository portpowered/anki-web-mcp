import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

import {
  StudyCaughtUpState,
  StudyCompletionState,
  StudyErrorState,
  StudyPage,
  StudyReturnButton,
  type StudyPageProps,
} from "./index";

type TestElement = ReactElement<Record<string, unknown>>;

function isElement(node: ReactNode): node is TestElement {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function findByAttribute(
  node: ReactNode,
  attribute: string,
  value: string,
): TestElement | undefined {
  if (!isElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const result = findByAttribute(child, attribute, value);
        if (result) {
          return result;
        }
      }
    }
    return undefined;
  }

  if (node.props[attribute] === value) {
    return node;
  }

  const nested = [
    node.props.children as ReactNode,
    node.props.actions as ReactNode,
    node.props.details as ReactNode,
  ];
  for (const child of nested) {
    const result = findByAttribute(child, attribute, value);
    if (result) {
      return result;
    }
  }

  return undefined;
}

const ratingCounts = {
  again: 2,
  hard: 3,
  good: 9,
  easy: 6,
} as const;

function createPageProps(
  state: StudyPageProps["state"],
  callbacks: {
    returns?: number[];
    retries?: number[];
    toggles?: number[];
    suspends?: number[];
  } = {},
): StudyPageProps {
  return {
    deck: { name: "Spanish Vocabulary" },
    onRate: () => undefined,
    onRetry: () => callbacks.retries?.push(1),
    onReturnToDecks: () => callbacks.returns?.push(1),
    onSuspend: () => callbacks.suspends?.push(1),
    onToggle: () => callbacks.toggles?.push(1),
    progress: { current: 15, total: 20 },
    state,
  };
}

describe("study non-card state presentations", () => {
  test("renders a waiting state with supplied timing and a return action", () => {
    const markup = renderToStaticMarkup(
      <StudyPage
        {...createPageProps({ kind: "waiting", nextCardIn: "30 seconds" })}
      />,
    );

    expect(markup).toContain('data-study-state="waiting"');
    expect(markup).toContain("Waiting for the next card");
    expect(markup).toContain("Next card in 30 seconds");
    expect(markup).toContain("not complete");
    expect(markup).toContain('aria-label="Return to decks"');
    expect(markup).not.toContain('data-study-state="completion"');
  });

  test("renders completion summaries without deriving or requiring next-due text", () => {
    const withNextDue = renderToStaticMarkup(
      <StudyCompletionState
        elapsed="4 minutes"
        nextDue="Tomorrow at 9:00"
        onReturnToDecks={() => undefined}
        ratingCounts={ratingCounts}
        reviewCount={20}
      />,
    );
    const withoutNextDue = renderToStaticMarkup(
      <StudyCompletionState
        elapsed="under a minute"
        nextDue={null}
        onReturnToDecks={() => undefined}
        ratingCounts={{ again: "0", hard: "1", good: "2", easy: "3" }}
        reviewCount="6 reviews"
      />,
    );

    expect(withNextDue).toContain('data-study-state="completion"');
    expect(withNextDue).toContain("Study session complete");
    expect(withNextDue).toContain("Reviews completed");
    expect(withNextDue).toContain(">20<");
    expect(withNextDue).toContain(">Tomorrow at 9:00<");
    expect(withNextDue).toContain('data-study-rating-count="again"');
    expect(withNextDue).toContain(">2<");
    expect(withNextDue).toContain("Return to decks");
    expect(withoutNextDue).toContain(">6 reviews<");
    expect(withoutNextDue).not.toContain("Next due");
  });

  test("renders caught-up content and keeps the return callback isolated", () => {
    const events: string[] = [];
    const tree = StudyCaughtUpState({
      onReturnToDecks: () => events.push("return"),
    });
    const returnButton = StudyReturnButton({
      onReturnToDecks: () => events.push("return"),
    });

    (returnButton.props.onClick as (() => void) | undefined)?.();

    expect(renderToStaticMarkup(tree)).toContain("You are caught up");
    expect(renderToStaticMarkup(tree)).toContain("no eligible cards");
    expect(events).toEqual(["return"]);
  });

  test("renders missing-deck and generic recoverable errors as escaped text", () => {
    const events: string[] = [];
    const message = '<img src=x onerror="alert(1)">';
    const missingDeck = renderToStaticMarkup(
      <StudyErrorState
        message={message}
        onRetry={() => events.push("retry")}
        onReturnToDecks={() => events.push("return")}
        reason="missing-deck"
      />,
    );
    const retryButton = findByAttribute(
      StudyErrorState({
        message,
        onRetry: () => events.push("retry"),
        onReturnToDecks: () => events.push("return"),
      }),
      "data-study-action",
      "retry",
    );
    const generic = renderToStaticMarkup(
      <StudyErrorState onReturnToDecks={() => undefined} />,
    );

    (retryButton?.props.onClick as (() => void) | undefined)?.();

    expect(missingDeck).toContain('data-study-state="error"');
    expect(missingDeck).toContain("Deck unavailable");
    expect(missingDeck).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(missingDeck).not.toContain("<img src=x");
    expect(missingDeck).toContain('aria-label="Try again loading study"');
    expect(missingDeck).toContain('aria-label="Return to decks"');
    expect(generic).toContain("Study could not be loaded");
    expect(generic).toContain("We couldn&#x27;t load this study.");
    expect(events).toEqual(["retry"]);
  });
});

describe("controlled StudyPage state selection", () => {
  test("renders loading without stale deck, card, progress, or rating controls", () => {
    const markup = renderToStaticMarkup(
      <StudyPage {...createPageProps({ kind: "loading" })} />,
    );

    expect(markup).toContain('data-study-state="loading"');
    expect(markup).toContain("Restoring your saved session");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("Spanish Vocabulary");
    expect(markup).not.toContain("Study progress");
    expect(markup).not.toContain('data-study-action="rate"');
  });

  test("retains the study header and renders exactly one selected state", () => {
    const states: StudyPageProps["state"][] = [
      {
        backContent: "house",
        frontContent: "casa",
        kind: "active",
        ratings: [
          { interval: "1 min", rating: "again" },
          { interval: "6 min", rating: "hard" },
          { interval: "10 min", rating: "good" },
          { interval: "4 d", rating: "easy" },
        ],
        side: "front",
      },
      { kind: "waiting", nextCardIn: "a minute" },
      { elapsed: "2 minutes", kind: "completion", ratingCounts, reviewCount: 4 },
      { kind: "caught-up" },
      { kind: "empty" },
      { kind: "error", message: "Temporary study failure" },
    ];

    for (const state of states) {
      const markup = renderToStaticMarkup(
        <StudyPage {...createPageProps(state)} />,
      );
      const stateMatches = markup.match(/data-study-state="[^"]+"/g) ?? [];

      expect(stateMatches).toHaveLength(1);
      expect(markup).toContain("Spanish Vocabulary");
      expect(markup).toContain('aria-label="Study progress: 15 of 20"');
      expect(markup).toContain('aria-label="Return to decks"');
    }
  });
});
