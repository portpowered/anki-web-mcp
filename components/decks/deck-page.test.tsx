import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

import { DeckPage, type DeckPageProps } from "./deck-page";
import { DeckRow } from "./deck-row";

const populatedDeck = {
  id: "biology",
  name: "Biology",
  cardCount: 523,
  dueCount: 12,
  suspendedCount: 3,
  lastStudiedLabel: "Studied 2d ago",
  icon: "leaf" as const,
};

function pageProps(
  state: DeckPageProps["state"],
  overrides: Partial<Omit<DeckPageProps, "state">> = {},
): DeckPageProps {
  return {
    state,
    onImport: () => undefined,
    onRetry: () => undefined,
    onSelect: () => undefined,
    onRemove: () => undefined,
    onRestoreSuspended: () => undefined,
    ...overrides,
  };
}

type TestElement = ReactElement<Record<string, unknown>>;

function expandComponent(node: ReactNode): ReactNode {
  if (!isElement(node)) {
    return node;
  }

  if (typeof node.type === "function") {
    const component = node.type as unknown as (props: Record<string, unknown>) => ReactNode;
    return expandComponent(component(node.props));
  }

  return node;
}

function isElement(node: ReactNode): node is TestElement {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function findAction(
  node: ReactNode,
  action: string,
): TestElement | undefined {
  const expanded = expandComponent(node);

  if (!isElement(expanded)) {
    if (Array.isArray(expanded)) {
      for (const child of expanded) {
        const result = findAction(child, action);
        if (result) {
          return result;
        }
      }
    }
    return undefined;
  }

  if (expanded.props["data-deck-action"] === action) {
    return expanded;
  }

  const children = expanded.props.children as ReactNode;
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

describe("deck page state presentations", () => {
  test("renders one loading state with visible asynchronous status text", () => {
    const markup = renderToStaticMarkup(
      <DeckPage {...pageProps({ kind: "loading" })} />,
    );

    expect(markup).toContain('data-deck-page-state="loading"');
    expect(markup).toContain("Loading your decks");
    expect(markup).toContain("Loading decks…");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("No decks yet");
    expect(markup).not.toContain("Decks could not be loaded");
  });

  test("renders an empty state with a keyboard-operable import action", () => {
    const imports: string[] = [];
    const markup = renderToStaticMarkup(
      <DeckPage
        {...pageProps({ kind: "empty" }, { onImport: () => imports.push("import") })}
      />,
    );

    expect(markup).toContain('data-deck-page-state="empty"');
    expect(markup).toContain("No decks are available yet. Import a deck to start studying.");
    expect(markup).toContain('data-deck-action="import-empty"');
    expect(markup).toContain('aria-label="Import Deck"');
    expect(markup).toContain("min-h-11");
    expect(imports).toEqual([]);
  });

  test("renders a safe recoverable error message and stable retry name", () => {
    const markup = renderToStaticMarkup(
      <DeckPage
        {...pageProps({
          kind: "error",
          message: "Storage <unavailable> & please retry",
        })}
      />,
    );

    expect(markup).toContain('data-deck-page-state="error"');
    expect(markup).toContain("Decks could not be loaded");
    expect(markup).toContain("Storage &lt;unavailable&gt; &amp; please retry");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Try again loading decks"');
    expect(markup).toContain(">Try again</button>");
  });

  test("renders populated rows and only exposes restore for a positive supplied count", () => {
    const withSuspended = renderToStaticMarkup(
      <DeckPage {...pageProps({ kind: "populated", decks: [populatedDeck] })} />,
    );
    const withoutSuspended = renderToStaticMarkup(
      <DeckPage
        {...pageProps({
          kind: "populated",
          decks: [{ ...populatedDeck, suspendedCount: 0 }],
        })}
      />,
    );

    expect(withSuspended).toContain("3 suspended");
    expect(withSuspended).toContain("3 suspended cards");
    expect(withSuspended).toContain('data-deck-action="restore-suspended"');
    expect(withSuspended).toContain('aria-label="Restore suspended cards in Biology"');
    expect(withoutSuspended).toContain("0 suspended");
    expect(withoutSuspended).not.toContain('data-deck-action="restore-suspended"');
    expect(withoutSuspended).not.toContain('data-deck-action="restore-suspended"');
  });

  test("passes restore intent with the deck id and keeps it separate from study", () => {
    const events: string[] = [];
    const tree = DeckRow({
      deck: populatedDeck,
      onSelect: (deckId) => events.push(`select:${deckId}`),
      onRemove: (deckId) => events.push(`remove:${deckId}`),
      onRestoreSuspended: (deckId) => events.push(`restore:${deckId}`),
    });
    const restore = findAction(tree, "restore-suspended");
    const study = findAction(tree, "study");

    expect(restore).toBeDefined();
    expect(study).toBeDefined();
    const restoreClick = restore?.props.onClick as
      | ((event: { stopPropagation: () => void }) => void)
      | undefined;
    const studyClick = study?.props.onClick as
      | ((event: { stopPropagation: () => void }) => void)
      | undefined;
    restoreClick?.({ stopPropagation: () => undefined });
    studyClick?.({ stopPropagation: () => undefined });

    expect(events).toEqual(["restore:biology", "select:biology"]);
  });
});
