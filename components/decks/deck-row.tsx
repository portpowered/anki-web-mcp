"use client";

import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "../../lib/cn";

export type DeckCount = number | string;

export type DeckIconName =
  | "leaf"
  | "speech"
  | "torii"
  | "column"
  | "flask"
  | "quote";

export type DeckSummary = {
  readonly id: string;
  readonly name: string;
  readonly cardCount: DeckCount;
  readonly newCount: DeckCount;
  readonly dueCount?: DeckCount;
  /** A caller-supplied count of suspended cards. */
  readonly suspendedCount?: DeckCount;
  /** Override the deterministic icon selected from the deck identity. */
  readonly icon?: DeckIconName;
};

export type DeckStudyAction = "start" | "resume";

export type DeckRowProps = {
  readonly deck: DeckSummary;
  readonly onSelect: (deckId: string) => void;
  readonly onRemove: (deckId: string) => void;
  readonly onRestoreSuspended?: (deckId: string) => void;
  readonly studyAction?: DeckStudyAction;
  readonly className?: string;
  readonly removeDisabled?: boolean;
};

const iconNames: readonly DeckIconName[] = [
  "leaf",
  "speech",
  "torii",
  "column",
  "flask",
  "quote",
];

const iconTreatment: Record<DeckIconName, string> = {
  leaf: "bg-success-background text-success-foreground",
  speech: "bg-error-background text-error-foreground",
  torii: "bg-primary/10 text-primary",
  column: "bg-warning-background text-warning-foreground",
  flask: "bg-rating-easy-background text-rating-easy-foreground",
  quote: "bg-surface-muted text-primary",
};

/**
 * Select a stable decorative icon without using randomness or mutable state.
 * The same deck identity therefore looks the same after a reload.
 */
export function getDeckIconName(
  deck: Pick<DeckSummary, "id" | "name">,
): DeckIconName {
  let hash = 0;
  const identity = `${deck.id}:${deck.name}`;

  for (let index = 0; index < identity.length; index += 1) {
    hash = (hash * 31 + identity.charCodeAt(index)) | 0;
  }

  return iconNames[Math.abs(hash) % iconNames.length];
}

export function formatDeckCount(value: DeckCount): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "0";
    }

    return new Intl.NumberFormat("en-US").format(Math.max(0, Math.trunc(value)));
  }

  return value.trim() || "0";
}

export function hasNonZeroDeckCount(value: DeckCount | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }

  const text = value.trim();

  if (!text) {
    return false;
  }

  const numericText = text.replace(/[^\d.-]/g, "");
  const numericValue = Number(numericText);

  return Number.isFinite(numericValue) ? numericValue > 0 : true;
}

function DeckIcon({
  icon,
  className,
}: {
  readonly icon: DeckIconName;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-12 shrink-0 items-center justify-center rounded-xl",
        iconTreatment[icon],
        className,
      )}
    >
      <svg
        className="size-7"
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon === "leaf" ? (
          <>
            <path d="M25.5 5.5C16 5.7 8.6 9 7.4 17.1c-.7 4.5 2.1 7.5 6.4 7.1 8.2-.8 10.4-8.2 11.7-18.7Z" />
            <path d="M5.5 27c4-7.2 8.9-10.8 15.4-14.2" />
          </>
        ) : null}
        {icon === "speech" ? (
          <path d="M5.5 14.5c0-5 4.8-8.5 10.5-8.5s10.5 3.5 10.5 8.5-4.8 8.5-10.5 8.5c-1.3 0-2.5-.2-3.6-.6L7 26l1.1-5.1c-1.6-1.6-2.6-3.8-2.6-6.4Z" />
        ) : null}
        {icon === "torii" ? (
          <>
            <path d="M5 8h22" />
            <path d="M7.5 5h17" />
            <path d="M9 8v18M23 8v18" />
            <path d="M5 13h22M12 13v13M20 13v13" />
            <path d="M8 26h16" />
          </>
        ) : null}
        {icon === "column" ? (
          <>
            <path d="M5 8h22M7 5h18" />
            <path d="M8 8v16M24 8v16" />
            <path d="M10 8v16M22 8v16" />
            <path d="M5 27h22" />
          </>
        ) : null}
        {icon === "flask" ? (
          <>
            <path d="M12 5h8M14 5v7l-6.7 11.2A2 2 0 0 0 9 26h14a2 2 0 0 0 1.7-2.8L18 12V5" />
            <path d="M10.5 20h11" />
            <path d="m12.5 17 2 1.5 2-2 2.5 1.5" />
          </>
        ) : null}
        {icon === "quote" ? (
          <>
            <path d="M13 11H8.5A3.5 3.5 0 0 0 5 14.5V17a3.5 3.5 0 0 0 3.5 3.5H11V17H8.5" />
            <path d="M27 11h-4.5a3.5 3.5 0 0 0-3.5 3.5V17a3.5 3.5 0 0 0 3.5 3.5H25V17h-2.5" />
          </>
        ) : null}
      </svg>
    </span>
  );
}

function displayDeckName(name: string): string {
  return name.trim() || "Untitled deck";
}

function TrashMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
    </svg>
  );
}

export function DeckRow({
  deck,
  onSelect,
  onRemove,
  onRestoreSuspended,
  studyAction = "start",
  className,
  removeDisabled = false,
}: DeckRowProps) {
  const name = displayDeckName(deck.name);
  const icon = deck.icon ?? getDeckIconName(deck);
  const studyLabel =
    studyAction === "resume" ? "Resume studying" : "Start studying";

  return (
    <Card
      className={cn(
        "overflow-hidden transition-shadow duration-150 hover:shadow-surface motion-reduce:transition-none",
        className,
      )}
      data-deck-id={deck.id}
      data-deck-row
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-stretch">
        <Button
          aria-label={`${studyLabel} ${name}`}
          className="min-w-0 justify-start rounded-none px-4 py-4 text-left hover:bg-surface-muted/60 sm:px-6 sm:py-5"
          data-deck-action="study"
          onClick={() => onSelect(deck.id)}
          variant="ghost"
        >
          <DeckIcon icon={icon} />
          <span className="min-w-0 flex-1">
            <span className="block break-words text-base font-semibold leading-6 text-navy sm:text-lg">
              {name}
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm leading-5 text-muted">
              <span className="break-words" data-deck-count="new">
                {formatDeckCount(deck.newCount)} new
              </span>
              {deck.dueCount !== undefined ? (
                <>
              <span aria-hidden="true">•</span>
              <span className="break-words" data-deck-count="due">
                {formatDeckCount(deck.dueCount as DeckCount)} due
              </span>
            </>
          ) : null}
              <span aria-hidden="true">•</span>
              <span className="break-words" data-deck-count="total">
                {formatDeckCount(deck.cardCount)} total
              </span>
            </span>
          </span>
          <span
            aria-hidden="true"
            className="ml-1 shrink-0 text-2xl font-light leading-none text-muted sm:ml-3"
          >
            ›
          </span>
        </Button>

        <div className="flex items-center px-2 sm:px-3">
          <Button
            aria-label={`Remove ${name}`}
            className="size-11 shrink-0 p-0 text-muted hover:text-error-foreground"
            data-deck-action="remove"
            disabled={removeDisabled}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(deck.id);
            }}
            title={`Remove ${name}`}
            variant="ghost"
          >
            <TrashMark />
          </Button>
        </div>
      </div>
      {hasNonZeroDeckCount(deck.suspendedCount) && onRestoreSuspended ? (
        <div className="flex justify-end border-t border-border bg-surface-muted/50 px-4 py-3 sm:px-6">
          <Button
            aria-label={`Restore suspended cards in ${name}`}
            className="px-2 text-left text-xs text-primary hover:text-primary/80 sm:px-3 sm:text-sm"
            data-deck-action="restore-suspended"
            onClick={(event) => {
              event.stopPropagation();
              onRestoreSuspended(deck.id);
            }}
            variant="ghost"
          >
            Restore suspended cards in {name}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
