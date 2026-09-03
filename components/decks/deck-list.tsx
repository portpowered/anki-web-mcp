"use client";

import { DeckRow, type DeckRowProps, type DeckSummary } from "./deck-row";
import { cn } from "../../lib/cn";

export type DeckListProps = {
  readonly decks: readonly DeckSummary[];
  readonly onSelect: DeckRowProps["onSelect"];
  readonly onRemove: DeckRowProps["onRemove"];
  readonly onRestoreSuspended?: DeckRowProps["onRestoreSuspended"];
  readonly studyAction?: DeckRowProps["studyAction"];
  readonly className?: string;
  readonly removeDisabled?: boolean;
};

export function DeckList({
  decks,
  onSelect,
  onRemove,
  onRestoreSuspended,
  studyAction = "start",
  className,
  removeDisabled = false,
}: DeckListProps) {
  return (
    <ul
      aria-label="Available decks"
      className={cn("m-0 list-none space-y-3 p-0", className)}
      data-deck-list
    >
      {decks.map((deck) => (
        <li key={deck.id}>
          <DeckRow
            deck={deck}
            onRemove={onRemove}
            onSelect={onSelect}
            onRestoreSuspended={onRestoreSuspended}
            studyAction={studyAction}
            removeDisabled={removeDisabled}
          />
        </li>
      ))}
    </ul>
  );
}
