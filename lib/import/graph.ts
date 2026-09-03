import type { NormalizedDeck, NormalizedImportGraph } from "./contracts";

/**
 * Return only deck definitions that own at least one imported card.
 *
 * Anki packages commonly retain an empty built-in `Default` definition. It is
 * useful parser evidence but is not an importable user deck and must not be
 * presented or persisted as one.
 */
export function populatedImportDecks(
  graph: Pick<NormalizedImportGraph, "cards" | "decks">,
): readonly NormalizedDeck[] {
  const referencedDeckIds = new Set(graph.cards.map((card) => card.deckId));
  return graph.decks.filter((deck) => referencedDeckIds.has(deck.id));
}
