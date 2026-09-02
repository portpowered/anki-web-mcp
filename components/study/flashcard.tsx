"use client";

import type { MouseEvent, ReactNode } from "react";

import { Button } from "../ui/button";
import { cn } from "../../lib/cn";

export type FlashcardSide = "front" | "back";

export type FlashcardProps = {
  readonly side: FlashcardSide;
  readonly frontContent: ReactNode;
  readonly backContent: ReactNode;
  /** Requests a controlled side change; this component does not own the side. */
  readonly onToggle: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
};

function EyeMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 32 32"
    >
      <path d="M3.5 16s4.2-7 12.5-7 12.5 7 12.5 7-4.2 7-12.5 7S3.5 16 3.5 16Z" />
      <circle cx="16" cy="16" r="3.5" />
    </svg>
  );
}

function isInteractiveDescendant(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(
      "a,button,input,textarea,select,option,label,summary,video,audio,iframe,[role='button'],[role='link'],[role='checkbox'],[role='switch'],[contenteditable='true']",
    ),
  );
}

function handleSurfaceClick(
  event: MouseEvent<HTMLElement>,
  onToggle: () => void,
) {
  if (event.defaultPrevented || isInteractiveDescendant(event.target)) {
    return;
  }

  onToggle();
}

/**
 * Controlled flashcard presentation.
 *
 * Focus policy: the DOM node for the explicit toggle remains in the same
 * position when `side` changes, so the browser preserves logical focus. The
 * component does not auto-focus or animate a side change; keyboard users can
 * always use the visible button.
 */
export function Flashcard({
  side,
  frontContent,
  backContent,
  onToggle,
  disabled = false,
  className,
}: FlashcardProps) {
  const isFront = side === "front";
  const sideLabel = isFront ? "FRONT" : "BACK";
  const toggleLabel = isFront ? "Show Answer" : "Show Front";
  const sideLabelId = `flashcard-side-${side}`;

  return (
    <article
      aria-labelledby={sideLabelId}
      className={cn(
        "overflow-hidden rounded-card border border-border bg-surface shadow-surface",
        className,
      )}
      data-flashcard
      onClick={(event) => {
        if (!disabled) handleSurfaceClick(event, onToggle);
      }}
    >
      <div className="flex min-h-[25rem] flex-col px-5 py-8 sm:min-h-[31rem] sm:px-10 sm:py-12">
        <p
          aria-live="polite"
          className="m-0 text-center text-lg font-semibold tracking-wide text-muted sm:text-xl"
          data-flashcard-side
          id={sideLabelId}
        >
          {sideLabel}
        </p>

        {isFront ? (
          <div
            className="flex min-h-0 flex-1 items-center justify-center [overflow-wrap:anywhere] py-10 text-center text-4xl font-semibold leading-tight text-navy sm:text-6xl"
            data-flashcard-content
          >
            {frontContent}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col justify-center py-8 text-center" data-flashcard-content>
            <section
              aria-label="Card prompt"
              className="border-b border-border pb-7 text-2xl font-semibold leading-tight text-muted sm:text-3xl"
              data-flashcard-front-context
            >
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Prompt</p>
              {frontContent}
            </section>
            <section
              aria-label="Card answer"
              className="pt-7 text-4xl font-semibold leading-tight text-navy sm:text-6xl"
              data-flashcard-answer
            >
              {backContent}
            </section>
          </div>
        )}

        <div className="border-t border-border pt-5 text-center sm:pt-6">
          <Button
            aria-label={toggleLabel}
            className="text-base text-muted hover:text-navy sm:text-lg"
            data-study-action="toggle"
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            variant="ghost"
          >
            <EyeMark />
            {toggleLabel}
          </Button>
        </div>
      </div>
    </article>
  );
}
