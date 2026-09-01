import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

import {
  RatingGrid,
  STUDY_RATING_ORDER,
  SuspendButton,
  type RatingOption,
  type StudyRating,
} from "./rating-grid";

type TestElement = ReactElement<Record<string, unknown>>;

const previews: readonly RatingOption[] = [
  { interval: "< 1 min", rating: "again" },
  { interval: "6 min", rating: "hard" },
  { interval: "10 min", rating: "good" },
  { interval: "4 d", rating: "easy" },
];

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

  const children = node.props.children as ReactNode;
  if (Array.isArray(children)) {
    for (const child of children) {
      const result = findByAttribute(child, attribute, value);
      if (result) {
        return result;
      }
    }
  } else if (children) {
    return findByAttribute(children, attribute, value);
  }

  return undefined;
}

function findAllByAttribute(
  node: ReactNode,
  attribute: string,
  value: string,
): TestElement[] {
  if (!isElement(node)) {
    if (Array.isArray(node)) {
      return node.flatMap((child) => findAllByAttribute(child, attribute, value));
    }
    return [];
  }

  const matches = node.props[attribute] === value ? [node] : [];
  const children = node.props.children as ReactNode;
  if (Array.isArray(children)) {
    return matches.concat(
      children.flatMap((child) => findAllByAttribute(child, attribute, value)),
    );
  }

  return matches.concat(findAllByAttribute(children, attribute, value));
}

function createKeyboardEvent(
  key: string,
  overrides: Partial<{
    code: string;
    target: EventTarget | null;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
  }> = {},
) {
  let prevented = false;

  return {
    code: overrides.code ?? "",
    defaultPrevented: false,
    key,
    repeat: overrides.repeat ?? false,
    target: overrides.target ?? null,
    altKey: overrides.altKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    preventDefault: () => {
      prevented = true;
    },
    wasPrevented: () => prevented,
  };
}

function createGrid(
  side: "front" | "back",
  events: StudyRating[],
  callbacks: { toggles: number[]; returns: number[]; suspends: number[] },
) {
  return RatingGrid({
    onRate: (rating) => events.push(rating),
    onReturnToDecks: () => callbacks.returns.push(1),
    onSuspend: () => callbacks.suspends.push(1),
    onToggle: () => callbacks.toggles.push(1),
    ratings: previews,
    side,
  });
}

describe("controlled rating and suspend presentation", () => {
  test("renders the four supplied previews in semantic order and responsive layout", () => {
    const markup = renderToStaticMarkup(
      <RatingGrid
        onRate={() => undefined}
        onReturnToDecks={() => undefined}
        onSuspend={() => undefined}
        onToggle={() => undefined}
        ratings={previews}
        side="front"
      />,
    );

    expect(STUDY_RATING_ORDER).toEqual(["again", "hard", "good", "easy"]);
    expect(markup.indexOf(">Again<")).toBeLessThan(markup.indexOf(">Hard<"));
    expect(markup.indexOf(">Hard<")).toBeLessThan(markup.indexOf(">Good<"));
    expect(markup.indexOf(">Good<")).toBeLessThan(markup.indexOf(">Easy<"));
    expect(markup).toContain("&lt; 1 min");
    expect(markup).toContain(">6 min<");
    expect(markup).toContain(">10 min<");
    expect(markup).toContain(">4 d<");
    expect(markup).toContain('aria-label="Again"');
    expect(markup).toContain('aria-label="Suspend card"');
    expect(markup).toContain("grid-cols-2");
    expect(markup).toContain("sm:grid-cols-4");
    expect(markup).toContain("border-rating-again-border");
    expect(markup).toContain("border-rating-hard-border");
    expect(markup).toContain("border-rating-good-border");
    expect(markup).toContain("border-rating-easy-border");
  });

  test("keeps every rating natively disabled and callback-free before reveal", () => {
    const events: StudyRating[] = [];
    const callbacks = { returns: [], suspends: [], toggles: [] };
    const tree = createGrid("front", events, callbacks);
    const buttons = findAllByAttribute(tree, "data-study-action", "rate");

    expect(buttons).toHaveLength(4);
    expect(buttons.every((button) => button.props.disabled === true)).toBe(true);

    for (const button of buttons) {
      const onClick = button.props.onClick as (() => void) | undefined;
      onClick?.();
    }

    const root = tree as TestElement;
    const onKeyDown = root.props.onKeyDown as ((event: ReturnType<typeof createKeyboardEvent>) => void) | undefined;
    for (const key of ["1", "2", "3", "4"]) {
      onKeyDown?.(createKeyboardEvent(key));
    }

    expect(events).toEqual([]);
  });

  test("rates once from each enabled pointer and keyboard intent", () => {
    const events: StudyRating[] = [];
    const callbacks = { returns: [], suspends: [], toggles: [] };
    const tree = createGrid("back", events, callbacks);
    const firstButton = findByAttribute(tree, "data-study-rating", "again");
    const onClick = firstButton?.props.onClick as (() => void) | undefined;
    onClick?.();

    const root = tree as TestElement;
    const onKeyDown = root.props.onKeyDown as ((event: ReturnType<typeof createKeyboardEvent>) => void) | undefined;
    for (const key of ["2", "3", "4"]) {
      const event = createKeyboardEvent(key);
      onKeyDown?.(event);
      expect(event.wasPrevented()).toBe(true);
    }

    expect(events).toEqual(["again", "hard", "good", "easy"]);
  });

  test("ignores modified, repeated, and interactive-descendant shortcuts", () => {
    const events: StudyRating[] = [];
    const callbacks = { returns: [], suspends: [], toggles: [] };
    const tree = createGrid("back", events, callbacks);
    const root = tree as TestElement;
    const onKeyDown = root.props.onKeyDown as ((event: ReturnType<typeof createKeyboardEvent>) => void) | undefined;
    const interactiveTarget = {
      closest: () => ({ tagName: "BUTTON" }),
    } as unknown as EventTarget;

    onKeyDown?.(createKeyboardEvent("1", { ctrlKey: true }));
    onKeyDown?.(createKeyboardEvent("2", { repeat: true }));
    onKeyDown?.(createKeyboardEvent("3", { target: interactiveTarget }));

    expect(events).toEqual([]);
  });

  test("keeps flip and return shortcuts separate from ratings and descendants", () => {
    const events: StudyRating[] = [];
    const callbacks = { returns: [], suspends: [], toggles: [] };
    const tree = createGrid("front", events, callbacks);
    const root = tree as TestElement;
    const onKeyDown = root.props.onKeyDown as ((event: ReturnType<typeof createKeyboardEvent>) => void) | undefined;

    const space = createKeyboardEvent(" ", { code: "Space" });
    const escape = createKeyboardEvent("Escape");
    onKeyDown?.(space);
    onKeyDown?.(escape);

    expect(callbacks.toggles).toHaveLength(1);
    expect(callbacks.returns).toHaveLength(1);
    expect(space.wasPrevented()).toBe(true);
    expect(escape.wasPrevented()).toBe(true);

    const interactiveSpace = createKeyboardEvent(" ", {
      code: "Space",
      target: { closest: () => ({ tagName: "INPUT" }) } as unknown as EventTarget,
    });
    onKeyDown?.(interactiveSpace);
    expect(callbacks.toggles).toHaveLength(1);
    expect(callbacks.returns).toHaveLength(1);
  });

  test("keeps suspend callback independent and available on either side", () => {
    const events: string[] = [];
    for (const side of ["front", "back"] as const) {
      const suspend = SuspendButton({
        onSuspend: () => events.push(`suspend:${side}`),
      });
      const onClick = suspend?.props.onClick as (() => void) | undefined;
      onClick?.();
    }

    const standalone = SuspendButton({ onSuspend: () => events.push("standalone") });
    const standaloneClick = standalone.props.onClick as (() => void) | undefined;
    standaloneClick?.();

    expect(events).toEqual(["suspend:front", "suspend:back", "standalone"]);
  });
});
