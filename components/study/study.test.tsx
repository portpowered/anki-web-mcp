import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

import { Flashcard } from "./flashcard";
import { normalizeStudyProgress, StudyHeader } from "./study-header";

type TestElement = ReactElement<Record<string, unknown>>;

function findAction(node: ReactNode, action: string): TestElement | undefined {
  if (!isElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const result = findAction(child, action);
        if (result) {
          return result;
        }
      }
    }
    return undefined;
  }

  if (node.props["data-study-action"] === action) {
    return node;
  }

  const children = node.props.children as ReactNode;
  if (Array.isArray(children)) {
    for (const child of children) {
      const result = findAction(child, action);
      if (result) {
        return result;
      }
    }
  } else if (children) {
    return findAction(children, action);
  }

  return undefined;
}

function isElement(node: ReactNode): node is TestElement {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

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
  test("keeps the prompt visible with the answer and supports both directions", () => {
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

    expect(front).toContain("FRONT");
    expect(front).toContain("casa");
    expect(front).not.toContain("house");
    expect(front).toContain('aria-label="Show Answer"');
    expect(back).toContain("BACK");
    expect(back).toContain("house");
    expect(back).toContain("casa");
    expect(back).toContain("Prompt");
    expect(back).toContain('data-flashcard-front-context="true"');
    expect(back).toContain('aria-label="Show Front"');
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
    const toggle = findAction(tree, "toggle");
    const stopCalls: string[] = [];

    const surfaceClick = root.props.onClick as
      | ((event: { defaultPrevented: boolean; target: null }) => void)
      | undefined;
    surfaceClick?.({ defaultPrevented: false, target: null });

    const buttonClick = toggle?.props.onClick as
      | ((event: { stopPropagation: () => void }) => void)
      | undefined;
    buttonClick?.({ stopPropagation: () => stopCalls.push("stopped") });

    expect(events).toEqual(["toggle", "toggle"]);
    expect(stopCalls).toEqual(["stopped"]);
  });
});
