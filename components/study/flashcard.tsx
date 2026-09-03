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

export type FlashcardToggleButtonProps = {
  readonly side: FlashcardSide;
  readonly onToggle: () => void;
  readonly disabled?: boolean;
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

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        className,
      )}
      data-flashcard
      data-flashcard-side={side}
      onClick={(event) => {
        if (!disabled) handleSurfaceClick(event, onToggle);
      }}
    >
      <article
        aria-label="Study card"
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-surface"
        data-flashcard-surface
      >
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1 text-center" data-flashcard-content>
          {isFront ? (
            <section
              aria-label="Card prompt"
              className="flex h-full min-h-0 min-w-0 w-full items-center justify-center overflow-x-hidden overflow-y-auto [overflow-wrap:anywhere] text-4xl font-semibold leading-tight text-navy sm:text-6xl"
              data-flashcard-front-context
            >
              {frontContent}
            </section>
          ) : (
            <section
              aria-label="Card answer"
              className="flex h-full min-h-0 min-w-0 w-full items-center justify-center overflow-x-hidden overflow-y-auto text-4xl font-semibold leading-tight text-navy sm:text-6xl"
              data-flashcard-answer
            >
              {backContent}
            </section>
          )}
        </div>
      </article>
    </div>
  );
}

export function FlashcardToggleButton({
  side,
  onToggle,
  disabled = false,
}: FlashcardToggleButtonProps) {
  const toggleLabel = side === "front" ? "Show Answer" : "Show Front";

  return (
    <Button
      aria-label={toggleLabel}
      className="px-2 py-1 text-sm text-muted hover:text-navy sm:text-base"
      data-study-action="toggle"
      disabled={disabled}
      onClick={onToggle}
      variant="ghost"
    >
      <EyeMark />
      {toggleLabel}
    </Button>
  );
}
