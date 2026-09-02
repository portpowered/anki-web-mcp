import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

import {
  DeckPage,
  ImportProgressPanel,
  isFileDrag,
  openImportPicker,
  trapDuplicateDialogFocus,
  updateImportDragState,
  type DeckPageProps,
} from "./deck-page";
import { DeckRow } from "./deck-row";

const populatedDeck = {
  id: "biology",
  name: "Biology",
  cardCount: 523,
  newCount: 18,
  dueCount: 12,
  suspendedCount: 3,
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
  test("associates every visible import action with one hidden .apkg input", () => {
    const markup = renderToStaticMarkup(
      <DeckPage {...pageProps({ kind: "empty" })} />,
    );
    const inputId = markup.match(/<input[^>]*id="([^"]+)"/)?.[1];

    expect(inputId).toBeDefined();
    expect(markup.match(/data-deck-import-input/g)?.length).toBe(1);
    expect(markup).toContain('type="file"');
    expect(markup).toContain('accept=".apkg"');
    expect(markup.match(new RegExp(`aria-controls="${inputId}"`, "g"))?.length).toBe(2);
  });

  test("clears the chooser before every activation so the same file can be selected again", () => {
    let clicks = 0;
    const input = { value: "C:/fakepath/deck.apkg", click: () => { clicks += 1; } };

    openImportPicker(input);
    input.value = "C:/fakepath/deck.apkg";
    openImportPicker(input);

    expect(input.value).toBe("");
    expect(clicks).toBe(2);
  });

  test("keeps nested file drags visible until the final leave and dismisses on drop or Escape", () => {
    let state = { depth: 0, visible: false };
    state = updateImportDragState(state, "enter");
    state = updateImportDragState(state, "enter");
    state = updateImportDragState(state, "leave");
    expect(state).toEqual({ depth: 1, visible: true });
    expect(updateImportDragState(state, "dismiss")).toEqual({ depth: 0, visible: false });
    expect(updateImportDragState(state, "drop")).toEqual({ depth: 0, visible: false });
    expect(isFileDrag(["text/plain"])).toBe(false);
    expect(isFileDrag(["Files"])).toBe(true);
  });

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

    expect(withSuspended).not.toContain("3 suspended");
    expect(withSuspended).toContain('data-deck-action="restore-suspended"');
    expect(withSuspended).toContain('aria-label="Restore suspended cards in Biology"');
    expect(withoutSuspended).not.toContain("suspended");
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

describe("deck import progress presentation", () => {
  test("renders readable multi-deck success counts and allowlisted warnings as escaped text", () => {
    const markup = renderToStaticMarkup(
      <ImportProgressPanel
        onCancel={() => undefined}
        presentation={{
          kind: "terminal",
          operationId: "import-success",
          outcome: {
            status: "success-with-warnings",
            operationId: "import-success",
            packageSha256: "a".repeat(64),
            commit: { importId: "saved", deckIds: ["one", "two"] },
            report: {
              decks: [
                { id: "one", name: "Biology <script>alert(1)</script>", cardCount: 2 },
                { id: "two", name: "A very long travel deck name that remains readable", cardCount: 1 },
              ],
              deckCount: 2,
              noteCount: 3,
              cardCount: 3,
              mediaCount: 1,
            },
            warnings: [
              {
                code: "UNSAFE_CONTENT_REMOVED",
                message: "<img src=x onerror=alert(1)>",
                stage: "compiling-content",
              },
              {
                code: "MISSING_MEDIA",
                message: "arbitrary parser copy",
                stage: "importing-media",
              },
            ],
          },
          announcement: "Import saved with warnings.",
        }}
      />,
    );

    expect(markup).toContain('data-import-result="success-with-warnings"');
    expect(markup).toContain("Import saved with warnings");
    expect(markup).toContain("Biology &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain("2 decks, 3 notes, 3 cards, and 1 media file");
    expect(markup).toContain("UNSAFE_CONTENT_REMOVED");
    expect(markup).toContain("Unsafe imported content was removed.");
    expect(markup).toContain("MISSING_MEDIA");
    expect(markup).not.toContain("onerror");
    expect(markup).not.toContain("arbitrary parser copy");
    expect(markup).toContain('data-deck-action="dismiss-import-report"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('role="status"');
  });

  test("renders distinct corrupt, unsupported, quota, Worker, and recoverable reports", () => {
    const cases = [
      ["ARCHIVE_INVALID", "Package could not be read", "The package is invalid or corrupt."],
      ["UNSUPPORTED_PACKAGE", "Package format is not supported", "features this importer cannot read"],
      ["QUOTA_EXCEEDED", "Not enough storage", "Free some browser storage"],
      ["WORKER_FAILED", "Importer stopped responding", "stopped before saving"],
      ["COMMIT_FAILED", "Import could not be completed", "Nothing was saved"],
    ] as const;

    for (const [code, heading, copy] of cases) {
      const retryable = code === "QUOTA_EXCEEDED" || code === "WORKER_FAILED" || code === "COMMIT_FAILED";
      const markup = renderToStaticMarkup(
        <ImportProgressPanel
          onCancel={() => undefined}
          presentation={{
            kind: "terminal",
            operationId: `import-${code}`,
            outcome: {
              status: "failed",
              operationId: `import-${code}`,
              error: {
                code,
                message: "TechnicalException: <secret stack>",
                operationId: `import-${code}`,
                stage: "committing",
                retryable,
              },
            },
            announcement: "Import stopped.",
            canRetryImport: retryable,
          }}
        />,
      );

      expect(markup).toContain(heading);
      expect(markup).toContain(copy);
      expect(markup).toContain('data-deck-action="choose-another-import"');
      expect(markup).not.toContain("TechnicalException");
      if (retryable) expect(markup).toContain('data-deck-action="retry-import"');
    }
  });

  test("renders an accessible duplicate choice with safe cancel first", () => {
    const checksum = "a".repeat(64);
    const markup = renderToStaticMarkup(
      <ImportProgressPanel
        onCancel={() => undefined}
        presentation={{
          kind: "duplicate",
          operationId: "import-duplicate",
          existingImportId: checksum,
          announcement: "Duplicate package found. Cancel import is the safe default.",
        }}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("This deck package is already imported");
    expect(markup).toContain(`Existing import: ${checksum}`);
    expect(markup.indexOf('data-deck-action="cancel-duplicate"'))
      .toBeLessThan(markup.indexOf('data-deck-action="replace-duplicate"'));
    expect(markup).toContain("Replace existing decks");
  });

  test("treats Escape as duplicate cancellation", () => {
    let cancelled = 0;
    let prevented = 0;
    trapDuplicateDialogFocus({
      key: "Escape",
      shiftKey: false,
      preventDefault: () => { prevented += 1; },
    }, null, () => { cancelled += 1; });

    expect(cancelled).toBe(1);
    expect(prevented).toBe(1);
  });

  test("renders replacement failure recovery without claiming success", () => {
    const markup = renderToStaticMarkup(
      <ImportProgressPanel
        onCancel={() => undefined}
        presentation={{
          kind: "terminal",
          operationId: "import-replacement",
          outcome: {
            status: "failed",
            operationId: "import-replacement",
            error: {
              code: "REPLACE_FAILED",
              message: "The existing import could not be replaced.",
              operationId: "import-replacement",
              stage: "committing",
              retryable: true,
            },
          },
          announcement: "Import stopped before it could be completed. Your saved decks were not changed.",
          canRetryReplacement: true,
        }}
      />,
    );

    expect(markup).toContain('data-deck-action="retry-replacement"');
    expect(markup).toContain('data-deck-action="cancel-replacement"');
    expect(markup).toContain("Your existing decks were not changed.");
    expect(markup).not.toContain("Import complete");
  });

  test("renders semantic known progress and an enabled pre-commit cancel action", () => {
    const markup = renderToStaticMarkup(
      <ImportProgressPanel
        onCancel={() => undefined}
        presentation={{
          kind: "active",
          operationId: "import-known",
          stage: "parsing-records",
          progress: {
            operationId: "import-known",
            stage: "parsing-records",
            completed: 12,
            total: 20,
            stageCompleted: 4,
            stageTotal: 8,
          },
          cancelRequested: false,
          canCancel: true,
          announcement: "Reading cards and notes: 4 of 8.",
        }}
      />,
    );

    expect(markup).toContain('data-import-progress="parsing-records"');
    expect(markup).toContain("Reading cards and notes: 4 of 8.");
    expect(markup).toContain('<progress aria-label="Reading cards and notes: 4 of 8."');
    expect(markup).toContain('max="20"');
    expect(markup).toContain('value="12"');
    expect(markup).toContain('data-deck-action="cancel-import"');
    expect(markup).not.toMatch(/<button[^>]* disabled=/);
  });

  test("uses indeterminate progress for unknown and zero totals", () => {
    for (const progress of [
      {
        operationId: "import-unknown",
        stage: "importing-media" as const,
        completed: 2,
        total: null,
        stageCompleted: 2,
        stageTotal: null,
      },
      {
        operationId: "import-zero",
        stage: "preflight" as const,
        completed: 0,
        total: 0,
        stageCompleted: 0,
        stageTotal: 0,
      },
    ]) {
      const markup = renderToStaticMarkup(
        <ImportProgressPanel
          onCancel={() => undefined}
          presentation={{
            kind: "active",
            operationId: progress.operationId,
            stage: progress.stage,
            progress,
            cancelRequested: false,
            canCancel: true,
            announcement: "",
          }}
        />,
      );
      const progressMarkup = markup.match(/<progress[^>]*>/)?.[0] ?? "";
      expect(progressMarkup).not.toContain("max=");
      expect(progressMarkup).not.toContain("value=");
      expect(markup).not.toContain("%");
    }
  });

  test("disables cancellation at commit with an explicit boundary explanation", () => {
    const markup = renderToStaticMarkup(
      <ImportProgressPanel
        onCancel={() => undefined}
        presentation={{
          kind: "active",
          operationId: "import-commit",
          stage: "committing",
          progress: null,
          cancelRequested: false,
          canCancel: false,
          announcement: "Saving your decks…",
        }}
      />,
    );

    expect(markup).toContain('data-import-progress="committing"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-deck-action="cancel-import"/);
    expect(markup).toContain("Your decks are being saved and can no longer be cancelled.");
  });

  test("renders a visible cancelled result with retry guidance", () => {
    const markup = renderToStaticMarkup(
      <ImportProgressPanel
        onCancel={() => undefined}
        presentation={{
          kind: "terminal",
          operationId: "import-cancelled",
          outcome: {
            status: "cancelled",
            operationId: "import-cancelled",
            reason: "caller",
            error: {
              code: "IMPORT_CANCELLED",
              message: "The import was cancelled.",
              operationId: "import-cancelled",
              stage: "parsing-records",
              retryable: true,
            },
          },
          announcement: "Import cancelled. Your saved decks were not changed. Choose a file to try again.",
        }}
      />,
    );

    expect(markup).toContain('data-import-result="cancelled"');
    expect(markup).toContain("Import cancelled");
    expect(markup).toContain("Choose a file to try again.");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-deck-action="choose-another-import"');
    expect(markup).toContain('data-deck-action="dismiss-import-report"');
  });
});
