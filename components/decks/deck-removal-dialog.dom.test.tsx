import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DeckPage } from "./deck-page";
import {
  DeckRemovalDialog,
  type DeckRemovalDialogState,
} from "./deck-removal-dialog";

const preview = {
  deckId: "biology",
  deckName: "Biology — chapters 1 through 100",
  cardCount: 1_234,
  mediaCount: 7,
  revision: "opaque-revision",
};

let browserWindow: Window;
let root: Root | null;

function installDom(): void {
  browserWindow = new Window({ url: "https://example.test/decks" });
  const globals = {
    window: browserWindow,
    document: browserWindow.document,
    navigator: browserWindow.navigator,
    Node: browserWindow.Node,
    Element: browserWindow.Element,
    HTMLElement: browserWindow.HTMLElement,
    Event: browserWindow.Event,
    MouseEvent: browserWindow.MouseEvent,
    KeyboardEvent: browserWindow.KeyboardEvent,
    MutationObserver: browserWindow.MutationObserver,
    getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
    requestAnimationFrame: browserWindow.requestAnimationFrame.bind(browserWindow),
    cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }

  document.body.innerHTML = '<div id="root"></div>';
}

async function render(element: React.ReactNode): Promise<HTMLElement> {
  const container = document.querySelector<HTMLElement>("#root");
  if (!container) throw new Error("DOM test root is missing");
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

beforeEach(() => {
  root = null;
  installDom();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  browserWindow.close();
});

describe("deck removal dialog DOM interactions", () => {
  test("initially focuses Cancel and contains forward and reverse Tab navigation", async () => {
    const container = await render(
      <DeckRemovalDialog
        state={{ kind: "ready", preview }}
        onCancel={() => undefined}
        onConfirm={() => undefined}
        onRetryPreview={() => undefined}
      />,
    );
    const cancel = container.querySelector<HTMLButtonElement>(
      '[data-deck-action="cancel-removal"]',
    );
    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-deck-action="confirm-removal"]',
    );

    expect(document.activeElement).toBe(cancel);

    confirm?.focus();
    const forwardTab = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    confirm?.dispatchEvent(forwardTab);
    expect(forwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);

    const reverseTab = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
      shiftKey: true,
    });
    cancel?.dispatchEvent(reverseTab);
    expect(reverseTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(confirm);
  });

  test("Cancel, Escape, and backdrop dismissal never confirm removal", async () => {
    let cancellations = 0;
    let confirmations = 0;
    const container = await render(
      <DeckRemovalDialog
        state={{ kind: "ready", preview }}
        onCancel={() => { cancellations += 1; }}
        onConfirm={() => { confirmations += 1; }}
        onRetryPreview={() => undefined}
      />,
    );
    const dialog = container.querySelector<HTMLElement>("[data-deck-removal-dialog]");
    const cancel = container.querySelector<HTMLButtonElement>(
      '[data-deck-action="cancel-removal"]',
    );

    await act(async () => cancel?.click());
    await act(async () => dialog?.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));
    await act(async () => dialog?.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    })));

    expect(cancellations).toBe(3);
    expect(confirmations).toBe(0);
  });

  test("returns focus to the originating row control after Cancel", async () => {
    function RemovalHarness() {
      const [state, setState] = useState<DeckRemovalDialogState | undefined>();
      return (
        <DeckPage
          state={{
            kind: "populated",
            decks: [{
              id: "biology",
              name: preview.deckName,
              cardCount: preview.cardCount,
              newCount: 5,
              dueCount: 2,
              icon: "leaf",
            }],
          }}
          onImport={() => undefined}
          onRetry={() => undefined}
          onSelect={() => undefined}
          onRestoreSuspended={() => undefined}
          onRemove={() => setState({ kind: "ready", preview })}
          onCancelRemoval={() => setState(undefined)}
          removalState={state}
        />
      );
    }

    const container = await render(<RemovalHarness />);
    const remove = container.querySelector<HTMLButtonElement>('[data-deck-action="remove"]');
    remove?.focus();
    await act(async () => remove?.click());

    const cancel = container.querySelector<HTMLButtonElement>(
      '[data-deck-action="cancel-removal"]',
    );
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-deck-removal-dialog]")).toBeNull();
    expect(document.activeElement).toBe(remove);
  });
});
