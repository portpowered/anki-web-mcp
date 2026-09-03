"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export const STUDY_RATING_ORDER = [
  "again",
  "hard",
  "good",
  "easy",
] as const;

export type StudyRating = (typeof STUDY_RATING_ORDER)[number];

export type RatingOption = {
  /** The intent emitted when this preview is selected. */
  readonly rating: StudyRating;
  /** Already-formatted interval text supplied by the caller. */
  readonly interval: string;
};

export type RatingGridProps = {
  /** One preview for each rating. Options are rendered in Anki's standard order. */
  readonly ratings: readonly RatingOption[];
  readonly onRate: (rating: StudyRating) => void;
  /** Requests a controlled card-side change. */
  readonly onToggle: () => void;
  readonly onSuspend?: () => void;
  /** Requests leaving the current study scope. */
  readonly onReturnToDecks: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
};

export const STUDY_RATING_LABELS: Record<StudyRating, string> = {
  again: "Again",
  hard: "Hard",
  good: "Good",
  easy: "Easy",
};

const ratingClasses: Record<StudyRating, string> = {
  again:
    "border-rating-again-border bg-rating-again-background text-rating-again-foreground hover:border-rating-again-foreground hover:bg-rating-again-background/80",
  hard:
    "border-rating-hard-border bg-rating-hard-background text-rating-hard-foreground hover:border-rating-hard-foreground hover:bg-rating-hard-background/80",
  good:
    "border-rating-good-border bg-rating-good-background text-rating-good-foreground hover:border-rating-good-foreground hover:bg-rating-good-background/80",
  easy:
    "border-rating-easy-border bg-rating-easy-background text-rating-easy-foreground hover:border-rating-easy-foreground hover:bg-rating-easy-background/80",
};

const shortcutRatings: Record<string, StudyRating> = {
  "1": "again",
  "2": "hard",
  "3": "good",
  "4": "easy",
};

const interactiveSelector =
  "a,button,input,textarea,select,option,label,summary,video,audio,iframe,[role='button'],[role='link'],[role='checkbox'],[role='switch'],[contenteditable='true']";

type ClosestTarget = {
  closest?: (selectors: string) => unknown;
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!target || (typeof target !== "object" && typeof target !== "function")) {
    return false;
  }

  const closest = (target as ClosestTarget).closest;
  return typeof closest === "function" && Boolean(closest.call(target, interactiveSelector));
}

function isModifiedKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

function isSpaceKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.key === " " || event.code === "Space";
}

function orderRatingOptions(
  ratings: readonly RatingOption[],
): readonly RatingOption[] {
  return STUDY_RATING_ORDER.flatMap((rating) => {
    const option = ratings.find((candidate) => candidate.rating === rating);
    return option ? [option] : [];
  });
}

function SuspendMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.25"
      viewBox="0 0 32 32"
    >
      <circle cx="16" cy="16" r="11" />
      <path d="m9 9 14 14" />
    </svg>
  );
}

export type SuspendButtonProps = {
  readonly onSuspend: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
};

export function SuspendButton({ onSuspend, disabled = false, className }: SuspendButtonProps) {
  return (
    <Button
      aria-label="Suspend card"
      className={cn("text-base text-muted hover:text-navy sm:text-lg", className)}
      data-study-action="suspend"
      disabled={disabled}
      onClick={onSuspend}
      variant="ghost"
    >
      <SuspendMark />
      Suspend
    </Button>
  );
}

/**
 * Controlled study ratings and keyboard scope.
 *
 * The section itself is the shortcut scope. Focusing it enables Space to
 * request a flip and Escape to request return navigation. Interactive
 * descendants are deliberately excluded so their own keyboard behavior is
 * never intercepted. This component only emits caller-owned intents.
 */
export function RatingGrid({
  ratings,
  onRate,
  onToggle,
  onReturnToDecks,
  disabled = false,
  className,
}: RatingGridProps) {
  const orderedRatings = orderRatingOptions(ratings);
  const availableRatings = new Set(orderedRatings.map((option) => option.rating));

  function handleRate(rating: StudyRating) {
    if (disabled || !availableRatings.has(rating)) {
      return;
    }

    onRate(rating);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (
      event.defaultPrevented ||
      disabled ||
      event.nativeEvent?.isComposing ||
      isModifiedKey(event) ||
      isInteractiveTarget(event.target)
    ) {
      return;
    }

    if (event.repeat) {
      if (isSpaceKey(event)) {
        event.preventDefault();
      }
      return;
    }

    const rating = shortcutRatings[event.key];
    if (rating) {
      if (availableRatings.has(rating)) {
        event.preventDefault();
        handleRate(rating);
      }
      return;
    }

    if (isSpaceKey(event)) {
      event.preventDefault();
      onToggle();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      onReturnToDecks();
    }
  }

  return (
    <section
      aria-keyshortcuts="Space 1 2 3 4 Escape"
      aria-label="Study card controls"
      className={cn("space-y-5", className)}
      data-rating-grid
      data-study-shortcut-scope
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div
        aria-label="Rate card"
        className="grid grid-cols-4 gap-1.5 sm:gap-4"
        data-rating-group
        role="group"
      >
        {orderedRatings.map((option) => {
          const label = STUDY_RATING_LABELS[option.rating];
          const previewId = `study-rating-preview-${option.rating}`;

          return (
            <Button
              className={cn(
                "min-h-20 min-w-0 flex-col justify-center gap-1 rounded-xl px-1 py-2 text-center shadow-none sm:gap-1 sm:px-3 sm:py-2",
                ratingClasses[option.rating],
              )}
              data-study-action="rate"
              data-study-rating={option.rating}
              disabled={disabled}
              key={option.rating}
              onClick={() => handleRate(option.rating)}
              variant="secondary"
            >
              <span
                className="text-xs font-semibold sm:text-base"
                data-rating-label
              >
                {label}
              </span>
              <span
                className="max-w-full break-words text-[0.6875rem] font-medium leading-4 sm:text-sm"
                data-rating-preview
                id={previewId}
              >
                {option.interval}
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

/** A concise alias for callers that describe the controls as a rating group. */
export const RatingGroup = RatingGrid;
export type RatingGroupProps = RatingGridProps;
