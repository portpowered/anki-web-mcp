import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export type StudyDeckIdentity = {
  readonly name: string;
  readonly sessionSequence?: number | null;
  readonly currentCardId?: string | null;
  /** An optional decorative icon supplied by the route composition. */
  readonly icon?: ReactNode;
};

export type StudyProgress = {
  /** The number of presentations completed by the caller. */
  readonly current: number;
  /** The caller's planned presentation count. */
  readonly total: number;
};

export type NormalizedStudyProgress = {
  readonly current: number;
  readonly total: number;
  readonly percentage: number;
};

export type StudyHeaderProps = {
  readonly deck: StudyDeckIdentity;
  readonly progress: StudyProgress;
  readonly onReturnToDecks: () => void;
  readonly className?: string;
};

/**
 * Keep progress values valid for both visible text and the ARIA progressbar.
 * A progressbar needs a positive maximum, so an empty/invalid plan is shown
 * as 0 / 1 until the caller supplies a real planned count.
 */
export function normalizeStudyProgress(
  progress: StudyProgress,
): NormalizedStudyProgress {
  const normalizedTotal = normalizeNonNegativeInteger(progress.total);
  const hasUsableTotal = normalizedTotal > 0;
  const safeTotal = Math.max(1, normalizedTotal);
  const current = Math.min(
    safeTotal,
    hasUsableTotal ? normalizeNonNegativeInteger(progress.current) : 0,
  );

  return {
    current,
    total: safeTotal,
    percentage: Math.round((current / safeTotal) * 100),
  };
}

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function StudyDeckMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-7"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 32 32"
    >
      <path d="M5.5 14.5c0-5 4.8-8.5 10.5-8.5s10.5 3.5 10.5 8.5-4.8 8.5-10.5 8.5c-1.3 0-2.5-.2-3.6-.6L7 26l1.1-5.1c-1.6-1.6-2.6-3.8-2.6-6.4Z" />
    </svg>
  );
}

function CloseMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-7"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2.5"
      viewBox="0 0 32 32"
    >
      <path d="m8 8 16 16M24 8 8 24" />
    </svg>
  );
}

export function StudyHeader({
  deck,
  progress,
  onReturnToDecks,
  className,
}: StudyHeaderProps) {
  const normalizedProgress = normalizeStudyProgress(progress);
  const deckName = deck.name.trim() || "Untitled deck";
  const progressLabel = `${normalizedProgress.current} of ${normalizedProgress.total}`;

  return (
    <header
      aria-label={`Study ${deckName}`}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-4 sm:gap-6",
        className,
      )}
      data-study-header
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-rating-again-background text-rating-again-foreground sm:size-14"
        >
          {deck.icon ?? <StudyDeckMark />}
        </span>
        <div className="min-w-0">
          <h1 className="m-0 break-words text-xl font-semibold leading-tight tracking-tight text-navy sm:text-2xl">
            {deckName}
          </h1>
          {deck.sessionSequence ? (
            <p
              className="m-0 mt-1 break-words text-sm text-muted"
              data-study-session
              data-study-session-sequence={deck.sessionSequence}
            >
              Session {deck.sessionSequence}
              {deck.currentCardId ? (
                <> · Card <span data-study-card-id>{deck.currentCardId}</span></>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-3 sm:flex-none sm:gap-4">
        <span
          className="shrink-0 whitespace-nowrap text-lg font-semibold tabular-nums text-muted sm:text-xl"
          data-study-progress-text
        >
          {normalizedProgress.current} / {normalizedProgress.total}
        </span>
        <div
          aria-label={`Study progress: ${progressLabel}`}
          aria-valuemax={normalizedProgress.total}
          aria-valuemin={0}
          aria-valuenow={normalizedProgress.current}
          aria-valuetext={`${progressLabel} presentations complete`}
          className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-border sm:w-56 sm:flex-none"
          data-study-progress
          role="progressbar"
        >
          <span
            aria-hidden="true"
            className="block h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
            data-study-progress-fill
            style={{ width: `${normalizedProgress.percentage}%` }}
          />
        </div>
      </div>

      <Button
        aria-label="Return to decks"
        className="shrink-0"
        data-study-action="return"
        onClick={onReturnToDecks}
        variant="icon"
      >
        <CloseMark />
      </Button>
    </header>
  );
}
