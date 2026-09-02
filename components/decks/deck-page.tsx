"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";
import {
  APKG_ACCEPT,
  formatImportProgress,
  submitImportIntake,
  type ImportProgressPresentation,
} from "../../lib/application/import-intake-controller";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Status, type StatusTone } from "../ui/status";
import { DeckHeader } from "./deck-header";
import { DeckList } from "./deck-list";
import type { DeckRowProps, DeckSummary } from "./deck-row";

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
  readonly onRetry: () => void;
  readonly onSelect: DeckRowProps["onSelect"];
  readonly onRemove: DeckRowProps["onRemove"];
  readonly onRestoreSuspended: NonNullable<DeckRowProps["onRestoreSuspended"]>;
  readonly studyAction?: DeckRowProps["studyAction"];
  readonly className?: string;
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
  const [dragState, setDragState] = useState<ImportDragState>({ depth: 0, visible: false });
  const [intakeMessage, setIntakeMessage] = useState<string | null>(null);

  const openPicker = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    openImportPicker(input);
  }, []);

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
        {renderDeckState(state, { ...props, onImport: openPicker, importInputId: inputId })}
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
};

export function ImportProgressPanel({
  presentation,
  onCancel,
}: ImportProgressPanelProps) {
  if (presentation.kind === "terminal") {
    const cancelled = presentation.outcome.status === "cancelled";
    const successful = presentation.outcome.status === "success"
      || presentation.outcome.status === "success-with-warnings";
    return (
      <section
        aria-labelledby="import-result-heading"
        className="rounded-surface border border-border bg-surface-muted p-4 sm:p-6"
        data-import-result={presentation.outcome.status}
      >
        <h2 id="import-result-heading" className="m-0 text-lg font-semibold text-navy">
          {cancelled ? "Import cancelled" : successful ? "Import complete" : "Import stopped"}
        </h2>
        <Status className="mb-0 mt-3" tone={successful ? "success" : cancelled ? "info" : "error"}>
          {presentation.announcement}
        </Status>
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
