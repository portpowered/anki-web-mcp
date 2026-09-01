"use client";

import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Flashcard, type FlashcardSide } from "./flashcard";
import { RatingGrid, type RatingOption, type StudyRating } from "./rating-grid";
import { StudyHeader, type StudyDeckIdentity, type StudyProgress } from "./study-header";
import {
  StudyCaughtUpState,
  StudyCompletionState,
  StudyErrorState,
  StudyWaitingState,
  type StudyCaughtUpPageState,
  type StudyCompletionPageState,
  type StudyErrorPageState,
  type StudyEmptyPageState,
  type StudyWaitingPageState,
} from "./study-states";

export type StudyActivePageState = {
  readonly kind: "active";
  readonly side: FlashcardSide;
  readonly frontContent: ReactNode;
  readonly backContent: ReactNode;
  readonly ratings: readonly RatingOption[];
};

export type StudyPageState =
  | StudyActivePageState
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
  readonly onSuspend: () => void;
  readonly onRetry?: () => void;
  readonly className?: string;
};

function renderStudyState(
  state: StudyPageState,
  props: Pick<
    StudyPageProps,
    "onRate" | "onReturnToDecks" | "onRetry" | "onSuspend" | "onToggle"
  >,
): ReactNode {
  switch (state.kind) {
    case "active":
      return (
        <section
          aria-label="Active study card"
          className="space-y-6"
          data-study-state="active"
        >
          <Flashcard
            backContent={state.backContent}
            frontContent={state.frontContent}
            onToggle={props.onToggle}
            side={state.side}
          />
          <RatingGrid
            onRate={props.onRate}
            onReturnToDecks={props.onReturnToDecks}
            onSuspend={props.onSuspend}
            onToggle={props.onToggle}
            ratings={state.ratings}
            side={state.side}
          />
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
export function StudyPage({ state, className, ...props }: StudyPageProps) {
  return (
    <div className={cn("space-y-6", className)} data-study-page>
      <StudyHeader
        deck={props.deck}
        onReturnToDecks={props.onReturnToDecks}
        progress={props.progress}
      />
      <div
        aria-busy={state.kind === "waiting"}
        aria-label="Study content"
        data-study-content
      >
        {renderStudyState(state, props)}
      </div>
    </div>
  );
}
