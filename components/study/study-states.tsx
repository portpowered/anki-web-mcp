"use client";

import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Status, type StatusTone } from "../ui/status";
import {
  STUDY_RATING_LABELS,
  STUDY_RATING_ORDER,
  type StudyRating,
} from "./rating-grid";

export type StudyDisplayValue = string | number;

export type StudyRatingCounts = Readonly<
  Record<StudyRating, StudyDisplayValue>
>;

export type StudyWaitingPageState = {
  readonly kind: "waiting";
  /** Already-formatted text supplied by the caller, such as "30 seconds". */
  readonly nextCardIn: string;
};

export type StudyCompletionPageState = {
  readonly kind: "completion";
  /** Caller-supplied review summary; this component does not calculate it. */
  readonly reviewCount: StudyDisplayValue;
  readonly ratingCounts: StudyRatingCounts;
  /** Already-formatted elapsed time, such as "4 minutes". */
  readonly elapsed: string;
  /** Optional already-formatted next-due text. */
  readonly nextDue?: string | null;
};

export type StudyCaughtUpPageState = {
  readonly kind: "caught-up";
};

/** An empty alias keeps callers from inventing a second visual state. */
export type StudyEmptyPageState = {
  readonly kind: "empty";
};

export type StudyErrorReason = "missing-deck" | "recoverable";

export type StudyErrorPageState = {
  readonly kind: "error";
  /** Safe, caller-owned text; React renders it as text rather than markup. */
  readonly message?: string | null;
  /** Identifies the missing-deck variant without changing the recovery API. */
  readonly reason?: StudyErrorReason;
};

export type StudyStatePanelProps = {
  readonly kind: "waiting" | "completion" | "caught-up" | "error";
  readonly title: string;
  readonly tone?: StatusTone;
  readonly children: ReactNode;
  readonly details?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
};

function StudyStatePanel({
  kind,
  title,
  tone = "info",
  children,
  details,
  actions,
  className,
}: StudyStatePanelProps) {
  const titleId = `study-state-${kind}-title`;

  return (
    <Card
      aria-labelledby={titleId}
      className={cn("overflow-hidden", className)}
      data-study-state={kind}
    >
      <CardHeader>
        <h2 id={titleId} className="m-0 text-xl font-semibold text-navy sm:text-2xl">
          {title}
        </h2>
      </CardHeader>
      <CardContent>
        <Status tone={tone}>{children}</Status>
        {details}
        {actions ? (
          <div className="mt-5 flex flex-wrap gap-3">{actions}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export type StudyReturnButtonProps = {
  readonly onReturnToDecks: () => void;
  readonly className?: string;
};

export function StudyReturnButton({
  onReturnToDecks,
  className,
}: StudyReturnButtonProps) {
  return (
    <Button
      aria-label="Return to decks"
      className={className}
      data-study-action="return"
      onClick={onReturnToDecks}
      variant="primary"
    >
      Return to decks
    </Button>
  );
}

export type StudyWaitingStateProps = {
  readonly nextCardIn: string;
  readonly onReturnToDecks: () => void;
  readonly className?: string;
};

export function StudyWaitingState({
  nextCardIn,
  onReturnToDecks,
  className,
}: StudyWaitingStateProps) {
  const displayNextCardIn = nextCardIn.trim() || "a moment";

  return (
    <StudyStatePanel
      actions={<StudyReturnButton onReturnToDecks={onReturnToDecks} />}
      className={className}
      kind="waiting"
      title="Waiting for the next card"
    >
      <strong data-study-next-card-in>Next card in {displayNextCardIn}</strong>.
      This session is waiting for a delayed card and is not complete.
    </StudyStatePanel>
  );
}

export type StudyCompletionStateProps = Omit<StudyCompletionPageState, "kind"> & {
  readonly onReturnToDecks: () => void;
  readonly className?: string;
};

function StudySummary({
  reviewCount,
  ratingCounts,
  elapsed,
  nextDue,
}: Pick<
  StudyCompletionStateProps,
  "reviewCount" | "ratingCounts" | "elapsed" | "nextDue"
>) {
  const nextDueText = nextDue?.trim();

  return (
    <dl className="mt-5 grid gap-3 sm:grid-cols-2" data-study-summary>
      <div className="rounded-lg border border-border bg-surface-muted px-4 py-3">
        <dt className="text-sm text-muted">Reviews completed</dt>
        <dd className="m-0 mt-1 text-xl font-semibold tabular-nums text-navy" data-study-review-count>
          {reviewCount}
        </dd>
      </div>
      <div className="rounded-lg border border-border bg-surface-muted px-4 py-3">
        <dt className="text-sm text-muted">Elapsed</dt>
        <dd className="m-0 mt-1 text-xl font-semibold text-navy" data-study-elapsed>
          {elapsed}
        </dd>
      </div>
      {STUDY_RATING_ORDER.map((rating) => (
        <div
          className="rounded-lg border border-border bg-surface-muted px-4 py-3"
          key={rating}
        >
          <dt className="text-sm text-muted">{STUDY_RATING_LABELS[rating]}</dt>
          <dd
            className="m-0 mt-1 text-xl font-semibold tabular-nums text-navy"
            data-study-rating-count={rating}
          >
            {ratingCounts[rating]}
          </dd>
        </div>
      ))}
      {nextDueText ? (
        <div className="rounded-lg border border-border bg-surface-muted px-4 py-3 sm:col-span-2">
          <dt className="text-sm text-muted">Next due</dt>
          <dd className="m-0 mt-1 text-xl font-semibold text-navy" data-study-next-due>
            {nextDueText}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

export function StudyCompletionState({
  elapsed,
  nextDue,
  onReturnToDecks,
  ratingCounts,
  reviewCount,
  className,
}: StudyCompletionStateProps) {
  return (
    <StudyStatePanel
      actions={<StudyReturnButton onReturnToDecks={onReturnToDecks} />}
      className={className}
      details={
        <StudySummary
          elapsed={elapsed}
          nextDue={nextDue}
          ratingCounts={ratingCounts}
          reviewCount={reviewCount}
        />
      }
      kind="completion"
      title="Study session complete"
      tone="success"
    >
      You reviewed all of the cards planned for this session.
    </StudyStatePanel>
  );
}

export type StudyCaughtUpStateProps = {
  readonly onReturnToDecks: () => void;
  readonly className?: string;
};

export function StudyCaughtUpState({
  onReturnToDecks,
  className,
}: StudyCaughtUpStateProps) {
  return (
    <StudyStatePanel
      actions={<StudyReturnButton onReturnToDecks={onReturnToDecks} />}
      className={className}
      kind="caught-up"
      title="You are caught up"
      tone="success"
    >
      There are no eligible cards in this deck right now. Return to your decks
      and choose another deck whenever you are ready.
    </StudyStatePanel>
  );
}

export type StudyErrorStateProps = {
  readonly message?: string | null;
  readonly reason?: StudyErrorReason;
  readonly onRetry?: () => void;
  readonly onReturnToDecks: () => void;
  readonly className?: string;
};

export function StudyErrorState({
  message,
  onRetry,
  onReturnToDecks,
  reason = "recoverable",
  className,
}: StudyErrorStateProps) {
  const safeMessage =
    message?.trim() ||
    (reason === "missing-deck"
      ? "This deck is no longer available."
      : "We couldn't load this study.");
  const title = reason === "missing-deck" ? "Deck unavailable" : "Study could not be loaded";

  return (
    <StudyStatePanel
      actions={
        <>
          {onRetry ? (
            <Button
              aria-label="Try again loading study"
              data-study-action="retry"
              onClick={onRetry}
              variant="secondary"
            >
              Try again
            </Button>
          ) : null}
          <StudyReturnButton onReturnToDecks={onReturnToDecks} />
        </>
      }
      className={className}
      kind="error"
      title={title}
      tone="error"
    >
      {safeMessage} Please try again or return to your decks.
    </StudyStatePanel>
  );
}
