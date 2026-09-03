"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";
import {
  APKG_ACCEPT,
  formatImportProgress,
  importFailurePresentation,
  importWarningMessage,
  submitImportIntake,
  type ImportProgressPresentation,
} from "../../lib/application/import-intake-controller";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Status, type StatusTone } from "../ui/status";
import { DeckHeader } from "./deck-header";
import { DeckList } from "./deck-list";
import type { DeckRowProps, DeckSummary } from "./deck-row";
import {
  DeckRemovalDialog,
  type DeckRemovalDialogState,
} from "./deck-removal-dialog";

export type DeckLoadingPageState = {
  readonly kind: "loading";
};

export type DeckPopulatedPageState = {
  readonly kind: "populated";
  readonly decks: readonly DeckSummary[];
};

export type DeckEmptyPageState = {
  readonly kind: "empty";
};

export type DeckErrorPageState = {
  readonly kind: "error";
  /** A safe, caller-owned message describing why the deck list is unavailable. */
  readonly message?: string | null;
};

export type DeckPageState =
  | DeckLoadingPageState
  | DeckPopulatedPageState
  | DeckEmptyPageState
  | DeckErrorPageState;

export type DeckPageProps = {
  readonly state: DeckPageState;
  readonly onImport: (file: File) => void;
  readonly importProgress?: ImportProgressPresentation;
  readonly onCancelImport?: () => void;
  readonly onCancelDuplicate?: () => void;
  readonly onReplaceDuplicate?: () => void;
  readonly onRetryReplacement?: () => void;
  readonly onRetryImport?: () => void;
  readonly onDismissImport?: () => void;
  readonly onRetry: () => void;
  readonly onSelect: DeckRowProps["onSelect"];
  readonly onRemove: DeckRowProps["onRemove"];
  readonly onRestoreSuspended: NonNullable<DeckRowProps["onRestoreSuspended"]>;
  readonly studyAction?: DeckRowProps["studyAction"];
  readonly className?: string;
  readonly removalState?: DeckRemovalDialogState | null;
  readonly onCancelRemoval?: () => void;
  readonly onConfirmRemoval?: () => void;
  readonly onRetryRemovalPreview?: () => void;
};

type DeckStatePanelProps = {
  readonly title: string;
  readonly tone?: StatusTone;
  readonly children: ReactNode;
  readonly action?: ReactNode;
};

function DeckStatePanel({
  title,
  tone,
  children,
  action,
}: DeckStatePanelProps) {
  const titleId = `deck-state-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <Card aria-labelledby={titleId} data-deck-state-panel>
      <CardHeader>
        <h2 id={titleId} className="m-0 text-xl font-semibold text-navy">
          {title}
        </h2>
      </CardHeader>
      <CardContent>
        {tone ? (
          <Status tone={tone}>{children}</Status>
        ) : (
          <p className="m-0 leading-7 text-muted">{children}</p>
        )}
        {action ? (
          <div className="mt-5 flex flex-wrap gap-3">{action}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function DeckLoadingState() {
  return (
    <DeckStatePanel title="Loading your decks" tone="info">
      Loading decks…
    </DeckStatePanel>
  );
}

export type DeckEmptyStateProps = {
  readonly onImport: () => void;
  readonly importInputId?: string;
};

export function DeckEmptyState({ onImport, importInputId }: DeckEmptyStateProps) {
  return (
    <DeckStatePanel
      title="No decks yet"
      action={
        <Button
          aria-label="Import Deck"
          aria-controls={importInputId}
          data-deck-action="import-empty"
          onClick={onImport}
          variant="primary"
        >
          Import Deck
        </Button>
      }
    >
      No decks are available yet. Import a deck to start studying.
    </DeckStatePanel>
  );
}

export type DeckErrorStateProps = {
  readonly message?: string | null;
  readonly onRetry: () => void;
};

export function DeckErrorState({ message, onRetry }: DeckErrorStateProps) {
  const safeMessage = message?.trim() || "We couldn't load your decks.";

  return (
    <DeckStatePanel
      title="Decks could not be loaded"
      tone="error"
      action={
        <Button
          aria-label="Try again loading decks"
          data-deck-action="retry"
          onClick={onRetry}
          variant="secondary"
        >
          Try again
        </Button>
      }
    >
      {safeMessage} Please try again.
    </DeckStatePanel>
  );
}

function renderDeckState(
  state: DeckPageState,
  props: Omit<DeckPageProps, "state" | "className" | "onImport"> & {
    readonly onImport: () => void;
    readonly importInputId: string;
  },
): ReactNode {
  switch (state.kind) {
    case "loading":
      return <DeckLoadingState />;
    case "populated":
      return (
        <DeckList
          decks={state.decks}
          onRemove={props.onRemove}
          onRestoreSuspended={props.onRestoreSuspended}
          onSelect={props.onSelect}
          studyAction={props.studyAction}
          removeDisabled={props.removalState?.kind === "committing"}
        />
      );
    case "empty":
      return (
        <DeckEmptyState
          importInputId={props.importInputId}
          onImport={props.onImport}
        />
      );
    case "error":
      return <DeckErrorState message={state.message} onRetry={props.onRetry} />;
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported deck state: ${String(value)}`);
}

export type ImportDragState = { readonly depth: number; readonly visible: boolean };

export function updateImportDragState(
  state: ImportDragState,
  action: "enter" | "leave" | "dismiss" | "drop",
): ImportDragState {
  if (action === "dismiss" || action === "drop") return { depth: 0, visible: false };
  if (action === "enter") return { depth: state.depth + 1, visible: true };
  const depth = Math.max(0, state.depth - 1);
  return { depth, visible: depth > 0 };
}

export function isFileDrag(types: readonly string[] | DOMStringList): boolean {
  return Array.from(types).includes("Files");
}

export function openImportPicker(input: Pick<HTMLInputElement, "click" | "value">): void {
  input.value = "";
  input.click();
}

export function DeckPage({ state, className, onImport, ...props }: DeckPageProps) {
  const generatedId = useId();
  const inputId = `deck-import-${generatedId.replace(/:/g, "")}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const importTriggerRef = useRef<HTMLElement | null>(null);
  const removalTriggerRef = useRef<HTMLElement | null>(null);
  const [dragState, setDragState] = useState<ImportDragState>({ depth: 0, visible: false });
  const [intakeMessage, setIntakeMessage] = useState<string | null>(null);
  const { onCancelRemoval, onDismissImport, onRemove, onRetryImport } = props;

  const requestRemoval = useCallback((deckId: string) => {
    removalTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    onRemove(deckId);
  }, [onRemove]);

  const dismissRemoval = useCallback(() => {
    onCancelRemoval?.();
    queueMicrotask(() => removalTriggerRef.current?.focus());
  }, [onCancelRemoval]);

  const openPicker = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    importTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    openImportPicker(input);
  }, []);

  const restoreImportFocus = useCallback(() => {
    importTriggerRef.current?.focus();
  }, []);

  const chooseAnotherFile = useCallback(() => {
    onDismissImport?.();
    restoreImportFocus();
    const input = inputRef.current;
    if (input) openImportPicker(input);
  }, [onDismissImport, restoreImportFocus]);

  const dismissReport = useCallback(() => {
    onDismissImport?.();
    restoreImportFocus();
  }, [onDismissImport, restoreImportFocus]);

  const submitFiles = useCallback((files: ArrayLike<File> | readonly File[]) => {
    const result = submitImportIntake(files, onImport);
    setIntakeMessage(result.accepted ? null : result.message);
  }, [onImport]);

  useEffect(() => {
    if (!dragState.visible) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDragState((current) => updateImportDragState(current, "dismiss"));
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [dragState.visible]);

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    setDragState((current) => updateImportDragState(current, "enter"));
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    setDragState((current) => updateImportDragState(current, "leave"));
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    setDragState((current) => updateImportDragState(current, "drop"));
    submitFiles(event.dataTransfer.files);
  };

  return (
    <div
      className={cn("relative space-y-8", className)}
      data-deck-page
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={APKG_ACCEPT}
        className="hidden"
        data-deck-import-input
        onChange={(event) => {
          submitFiles(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
        }}
      />
      <DeckHeader importInputId={inputId} onImport={openPicker} />
      <section
        aria-busy={state.kind === "loading"}
        aria-label="Deck content"
        data-deck-page-state={state.kind}
      >
        {renderDeckState(state, {
          ...props,
          onRemove: requestRemoval,
          onImport: openPicker,
          importInputId: inputId,
        })}
      </section>
      {intakeMessage ? (
        <Status data-import-intake-message role="alert" tone="error">
          {intakeMessage}
        </Status>
      ) : null}
      {props.importProgress && props.importProgress.kind !== "idle" ? (
        <ImportProgressPanel
          presentation={props.importProgress}
          onCancel={props.onCancelImport ?? (() => undefined)}
          onCancelDuplicate={() => {
            props.onCancelDuplicate?.();
            importTriggerRef.current?.focus();
          }}
          onReplaceDuplicate={props.onReplaceDuplicate ?? (() => undefined)}
          onRetryReplacement={props.onRetryReplacement ?? (() => undefined)}
          onRetryImport={() => {
            restoreImportFocus();
            onRetryImport?.();
          }}
          onChooseAnother={chooseAnotherFile}
          onDismiss={dismissReport}
        />
      ) : null}
      {props.removalState ? (
        <DeckRemovalDialog
          state={props.removalState}
          onCancel={dismissRemoval}
          onConfirm={props.onConfirmRemoval ?? (() => undefined)}
          onRetryPreview={props.onRetryRemovalPreview ?? (() => undefined)}
        />
      ) : null}
      {dragState.visible ? (
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-navy/80 p-4 text-center text-white"
          data-import-drop-overlay
          role="status"
        >
          <p className="m-0 max-w-md rounded-surface border-2 border-dashed border-white bg-navy p-8 text-xl font-semibold">
            Drop one .apkg file to import your deck. Press Escape to cancel.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export type ImportProgressPanelProps = {
  readonly presentation: Exclude<ImportProgressPresentation, { readonly kind: "idle" }>;
  readonly onCancel: () => void;
  readonly onCancelDuplicate?: () => void;
  readonly onReplaceDuplicate?: () => void;
  readonly onRetryReplacement?: () => void;
  readonly onRetryImport?: () => void;
  readonly onChooseAnother?: () => void;
  readonly onDismiss?: () => void;
};

export function ImportProgressPanel({
  presentation,
  onCancel,
  onCancelDuplicate = () => undefined,
  onReplaceDuplicate = () => undefined,
  onRetryReplacement = () => undefined,
  onRetryImport = () => undefined,
  onChooseAnother = () => undefined,
  onDismiss = () => undefined,
}: ImportProgressPanelProps) {
  const cancelDuplicateRef = useRef<HTMLButtonElement>(null);
  const duplicateDialogRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (presentation.kind === "duplicate") cancelDuplicateRef.current?.focus();
    if (presentation.kind === "terminal" || presentation.kind === "duplicate-cancelled") {
      resultHeadingRef.current?.focus();
    }
  }, [presentation.kind]);

  if (presentation.kind === "duplicate") {
    const dismiss = () => onCancelDuplicate();
    return (
      <div
        aria-describedby="duplicate-import-description duplicate-import-context"
        aria-labelledby="duplicate-import-heading"
        aria-modal="true"
        className="fixed inset-0 z-50 flex items-center justify-center bg-navy/80 p-4"
        data-import-duplicate-dialog
        onKeyDown={(event) => trapDuplicateDialogFocus(event, duplicateDialogRef.current, dismiss)}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) dismiss();
        }}
        ref={duplicateDialogRef}
        role="dialog"
      >
        <div className="w-full max-w-lg rounded-surface border border-border bg-surface p-5 shadow-surface sm:p-6">
          <h2 id="duplicate-import-heading" className="m-0 text-xl font-semibold text-navy">
            This deck package is already imported
          </h2>
          <p id="duplicate-import-description" className="mb-0 mt-3 leading-7 text-muted">
            Cancel keeps your existing saved decks unchanged. Replace removes the existing
            imported graph and saves this package atomically.
          </p>
          <p id="duplicate-import-context" className="mb-0 mt-3 break-all text-sm text-muted">
            Existing import: {presentation.existingImportId}
          </p>
          <span aria-live="polite" className="sr-only">{presentation.announcement}</span>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button
              data-deck-action="cancel-duplicate"
              onClick={dismiss}
              ref={cancelDuplicateRef}
              variant="primary"
            >
              Cancel import
            </Button>
            <Button
              data-deck-action="replace-duplicate"
              onClick={onReplaceDuplicate}
              variant="secondary"
            >
              Replace existing decks
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (presentation.kind === "duplicate-cancelled") {
    return (
      <section
        aria-labelledby="import-result-heading"
        className="rounded-surface border border-border bg-surface-muted p-4 sm:p-6"
        data-import-result="duplicate-cancelled"
      >
        <h2
          ref={resultHeadingRef}
          id="import-result-heading"
          className="m-0 text-lg font-semibold text-navy"
          tabIndex={-1}
        >
          Duplicate import cancelled
        </h2>
        <Status className="mb-0 mt-3" tone="info">{presentation.announcement}</Status>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button data-deck-action="choose-another-import" onClick={onChooseAnother}>
            Choose another file
          </Button>
          <Button data-deck-action="dismiss-import-report" onClick={onDismiss} variant="secondary">
            Dismiss report
          </Button>
        </div>
      </section>
    );
  }

  if (presentation.kind === "terminal") {
    const cancelled = presentation.outcome.status === "cancelled";
    const successful = presentation.outcome.status === "success"
      || presentation.outcome.status === "success-with-warnings";
    const hasWarnings = presentation.outcome.status === "success-with-warnings";
    const failure = presentation.outcome.status === "failed"
      ? importFailurePresentation(
          presentation.outcome.error.code,
          presentation.outcome.error.retryable,
        )
      : null;
    const heading = cancelled
      ? "Import cancelled"
      : hasWarnings
        ? "Import saved with warnings"
        : successful
          ? "Import complete"
          : failure!.heading;
    return (
      <section
        aria-labelledby="import-result-heading"
        className="rounded-surface border border-border bg-surface-muted p-4 sm:p-6"
        data-import-result={presentation.outcome.status}
      >
        <h2
          ref={resultHeadingRef}
          id="import-result-heading"
          className="m-0 text-lg font-semibold text-navy"
          tabIndex={-1}
        >
          {heading}
        </h2>
        <Status
          className="mb-0 mt-3"
          tone={hasWarnings ? "warning" : successful ? "success" : cancelled ? "info" : "error"}
        >
          {failure?.message ?? presentation.announcement}
        </Status>
        {successful && presentation.outcome.report ? (
          <div className="mt-4" data-import-success-report>
            <p className="m-0 font-medium text-navy">
              {presentation.outcome.report.deckCount === 1 ? "Imported deck" : "Imported decks"}
            </p>
            <ul className="mb-0 mt-2 space-y-2 pl-5">
              {presentation.outcome.report.decks.map((deck) => (
                <li key={deck.id} className="break-words">
                  <span className="font-medium text-navy">{deck.name}</span>
                  {` — ${formatCount(deck.cardCount, "card")}`}
                </li>
              ))}
            </ul>
            <p className="mb-0 mt-3 text-sm leading-6 text-muted" data-import-counts>
              {formatImportCounts(presentation.outcome.report)}
            </p>
          </div>
        ) : null}
        {successful && presentation.outcome.warnings.length > 0 ? (
          <section aria-labelledby="import-warning-heading" className="mt-4">
            <h3 id="import-warning-heading" className="m-0 text-base font-semibold text-navy">
              Import warnings
            </h3>
            <ul className="mb-0 mt-2 space-y-2 pl-5" data-import-warnings>
              {presentation.outcome.warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`} className="break-words">
                  <code>{warning.code}</code>: {importWarningMessage(warning.code)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {presentation.canRetryReplacement ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button data-deck-action="retry-replacement" onClick={onRetryReplacement}>
              Retry replacement
            </Button>
            <Button data-deck-action="cancel-replacement" onClick={onCancelDuplicate} variant="secondary">
              Keep existing decks
            </Button>
            <p className="m-0 text-sm leading-6 text-muted">
              The replacement failed safely. Your existing decks were not changed.
            </p>
          </div>
        ) : null}
        {!presentation.canRetryReplacement ? (
          <div className="mt-4 flex flex-wrap gap-3">
            {presentation.canRetryImport && failure?.action === "retry" ? (
              <Button data-deck-action="retry-import" onClick={onRetryImport}>
                Retry import
              </Button>
            ) : null}
            {!successful ? (
              <Button data-deck-action="choose-another-import" onClick={onChooseAnother}>
                Choose another file
              </Button>
            ) : null}
            <Button data-deck-action="dismiss-import-report" onClick={onDismiss} variant="secondary">
              Dismiss report
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  const progressText = formatImportProgress(presentation.stage, presentation.progress);
  const progress = presentation.progress;
  const usableTotal = progress?.total !== null && progress !== null && progress.total > 0;
  return (
    <section
      aria-labelledby="import-progress-heading"
      aria-busy="true"
      className="rounded-surface border border-border bg-surface-muted p-4 sm:p-6"
      data-import-progress={presentation.stage}
    >
      <h2 id="import-progress-heading" className="m-0 text-lg font-semibold text-navy">
        Importing deck
      </h2>
      <p className="mb-0 mt-3 font-medium text-navy" data-import-progress-text>
        {progressText}
      </p>
      <progress
        aria-label={progressText}
        className="mt-3 block h-2 w-full max-w-xl accent-primary"
        {...(usableTotal ? { max: progress.total!, value: progress.completed } : {})}
      />
      <span aria-live="polite" className="sr-only" data-import-announcement>
        {presentation.announcement}
      </span>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          data-deck-action="cancel-import"
          disabled={!presentation.canCancel}
          onClick={onCancel}
          variant="secondary"
        >
          {presentation.cancelRequested ? "Cancelling…" : "Cancel import"}
        </Button>
        {!presentation.canCancel ? (
          <p className="m-0 text-sm leading-6 text-muted" data-import-cancel-boundary>
            {presentation.stage === "committing"
              ? "Your decks are being saved and can no longer be cancelled."
              : presentation.cancelRequested
                ? "Cancellation requested. Your saved decks will not change."
                : "Cancellation becomes available when package checking starts."}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function formatCount(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function formatImportCounts(report: {
  readonly deckCount: number;
  readonly noteCount: number;
  readonly cardCount: number;
  readonly mediaCount: number;
}): string {
  return `${formatCount(report.deckCount, "deck")}, ${formatCount(report.noteCount, "note")}, ${formatCount(report.cardCount, "card")}, and ${formatCount(report.mediaCount, "media file")}`;
}

export function trapDuplicateDialogFocus(
  event: Pick<ReactKeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  dialog: Pick<HTMLElement, "querySelectorAll"> | null,
  dismiss: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    dismiss();
    return;
  }
  if (event.key !== "Tab" || !dialog) return;
  const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
  if (controls.length === 0) return;
  const active = document.activeElement;
  const first = controls[0]!;
  const last = controls[controls.length - 1]!;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
