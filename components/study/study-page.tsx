"use client";

import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Flashcard, FlashcardToggleButton, type FlashcardSide } from "./flashcard";
import { RatingGrid, type RatingOption, type StudyRating } from "./rating-grid";
import { StudyHeader, type StudyDeckIdentity, type StudyProgress } from "./study-header";
import {
  StudyCaughtUpState,
  StudyCompletionState,
  StudyErrorState,
  StudyLoadingState,
  StudyWaitingState,
  type StudyCaughtUpPageState,
  type StudyCompletionPageState,
  type StudyErrorPageState,
  type StudyEmptyPageState,
  type StudyWaitingPageState,
  type StudyLoadingPageState,
} from "./study-states";

export type StudyActivePageState = {
  readonly kind: "active";
  readonly side: FlashcardSide;
  /** True after the answer has been durably revealed for this presentation. */
  readonly revealed: boolean;
  readonly frontContent: ReactNode;
  readonly backContent: ReactNode;
  readonly css?: string;
  readonly ratings: readonly RatingOption[];
};

export type StudyPageState =
  | StudyActivePageState
  | StudyLoadingPageState
  | StudyWaitingPageState
  | StudyCompletionPageState
  | StudyCaughtUpPageState
  | StudyEmptyPageState
  | StudyErrorPageState;

export type StudyPageProps = {
  readonly state: StudyPageState;
  readonly deck: StudyDeckIdentity;
  readonly progress: StudyProgress;
  readonly onReturnToDecks: () => void;
  readonly onToggle: () => void;
  readonly onRate: (rating: StudyRating) => void;
  readonly onRetry?: () => void;
  readonly busy?: boolean;
  readonly actionError?: string | null;
  readonly className?: string;
};

function renderStudyState(
  state: StudyPageState,
  props: Pick<
    StudyPageProps,
    "busy" | "onRate" | "onReturnToDecks" | "onRetry" | "onToggle"
  >,
): ReactNode {
  switch (state.kind) {
    case "loading":
      return <StudyLoadingState />;
    case "active":
      return (
        <section
          aria-label="Active study card"
          className="flex min-h-0 flex-1 flex-col gap-2"
          data-study-state="active"
        >
          <Flashcard
            backContent={state.backContent}
            frontContent={state.frontContent}
            onToggle={props.onToggle}
            side={state.side}
            disabled={props.busy}
          />
          <footer className="flex flex-none flex-col gap-2" data-study-controls>
            <div className="flex items-center justify-center text-center" data-flashcard-toggle-control>
              <FlashcardToggleButton
                disabled={props.busy}
                onToggle={props.onToggle}
                side={state.side}
              />
            </div>
            <RatingGrid
              onRate={props.onRate}
              onReturnToDecks={props.onReturnToDecks}
              onToggle={props.onToggle}
              ratings={state.ratings}
              disabled={props.busy}
            />
          </footer>
        </section>
      );
    case "waiting":
      return (
        <StudyWaitingState
          nextCardIn={state.nextCardIn}
          onReturnToDecks={props.onReturnToDecks}
        />
      );
    case "completion":
      return (
        <StudyCompletionState
          elapsed={state.elapsed}
          nextDue={state.nextDue}
          onReturnToDecks={props.onReturnToDecks}
          ratingCounts={state.ratingCounts}
          reviewCount={state.reviewCount}
        />
      );
    case "caught-up":
    case "empty":
      return <StudyCaughtUpState onReturnToDecks={props.onReturnToDecks} />;
    case "error":
      return (
        <StudyErrorState
          message={state.message}
          onRetry={props.onRetry}
          onReturnToDecks={props.onReturnToDecks}
          reason={state.reason}
        />
      );
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported study state: ${String(value)}`);
}

/**
 * Controlled study presentation states. All data and side effects belong to
 * the caller; this component only chooses the matching visual state and emits
 * the supplied intent callbacks.
 */
export function StudyPage({ state, className, actionError, busy = false, ...props }: StudyPageProps) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-6", className)} data-study-page>
      {state.kind === "loading" ? null : (
        <StudyHeader
          deck={props.deck}
          onReturnToDecks={props.onReturnToDecks}
          progress={props.progress}
        />
      )}
      <div
        aria-busy={state.kind === "loading" || state.kind === "waiting" || busy}
        aria-label="Study content"
        className="flex min-h-0 flex-1 flex-col"
        data-study-content
      >
        {renderStudyState(state, props)}
      </div>
      {actionError ? (
        <p
          className="m-0 rounded-lg border border-error-border bg-error-background px-4 py-3 text-error-foreground"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
