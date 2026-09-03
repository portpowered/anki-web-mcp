"use client";

import { Button } from "../ui/button";
import { cn } from "../../lib/cn";

export type DeckHeaderProps = {
  readonly onImport: () => void;
  readonly importInputId?: string;
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

export function DeckHeader({ onImport, importInputId, className }: DeckHeaderProps) {
  return (
    <header
      className={cn(
        "relative sm:flex sm:items-start sm:justify-between sm:gap-6",
        className,
      )}
      data-deck-header
    >
      <div className="min-w-0 pr-14 sm:pr-0">
        <h1 className="m-0 break-words text-4xl font-bold leading-tight tracking-tight text-navy sm:text-5xl">
          Anki Decks
        </h1>
        <p className="mt-2 max-w-prose text-base leading-7 text-muted sm:text-lg">
          visit{" "}
          <a
            className="font-medium text-navy underline decoration-border underline-offset-4 transition-colors hover:text-primary"
            href="https://ankiweb.net/decks"
            rel="noreferrer"
            target="_blank"
          >
            https://ankiweb.net/decks
          </a>{" "}
          to get more decks
        </p>
      </div>

      <Button
        aria-label="Import Deck"
        aria-controls={importInputId}
        className="absolute right-0 top-0 shrink-0 sm:static sm:px-4"
        data-deck-action="import"
        onClick={onImport}
        variant="primary-icon"
      >
        <UploadIcon />
        <span className="hidden sm:inline">Import Deck</span>
      </Button>
    </header>
  );
}
