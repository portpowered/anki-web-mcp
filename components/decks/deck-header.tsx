"use client";

import { Button } from "../ui/button";
import { cn } from "../../lib/cn";

export type DeckHeaderProps = {
  readonly onImport: () => void;
  readonly className?: string;
};

function UploadIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 20h14a2 2 0 0 0 2-2v-3" />
      <path d="M3 15v3a2 2 0 0 0 2 2" />
    </svg>
  );
}

export function DeckHeader({ onImport, className }: DeckHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
      data-deck-header
    >
      <div className="min-w-0">
        <h1 className="m-0 break-words text-4xl font-bold leading-tight tracking-tight text-navy sm:text-5xl">
          Your Decks
        </h1>
        <p className="mt-2 max-w-prose text-base leading-7 text-muted sm:text-lg">
          Manage and study your flashcard decks.
        </p>
      </div>

      <Button
        aria-label="Import Deck"
        className="w-full shrink-0 sm:w-auto"
        data-deck-action="import"
        onClick={onImport}
        variant="primary"
      >
        <UploadIcon />
        <span>Import Deck</span>
      </Button>
    </header>
  );
}
