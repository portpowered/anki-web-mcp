"use client";

import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
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
  readonly onImport: () => void;
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
};

export function DeckEmptyState({ onImport }: DeckEmptyStateProps) {
  return (
    <DeckStatePanel
      title="No decks yet"
      action={
        <Button
          aria-label="Import Deck"
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
  props: Omit<DeckPageProps, "state" | "className">,
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
      return <DeckEmptyState onImport={props.onImport} />;
    case "error":
      return <DeckErrorState message={state.message} onRetry={props.onRetry} />;
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported deck state: ${String(value)}`);
}

export function DeckPage({ state, className, ...props }: DeckPageProps) {
  return (
    <div className={cn("space-y-8", className)} data-deck-page>
      <DeckHeader onImport={props.onImport} />
      <section
        aria-busy={state.kind === "loading"}
        aria-label="Deck content"
        data-deck-page-state={state.kind}
      >
        {renderDeckState(state, props)}
      </section>
    </div>
  );
}
