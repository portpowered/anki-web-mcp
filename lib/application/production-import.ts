import type { ImportReport, NormalizedImportGraph } from "../import/contracts";
import { populatedImportDecks } from "../import/graph";
import type { ImportLimitsInput } from "../import/limits";
import { BrowserImportWorkerFactory } from "../import/worker/browser-worker";
import {
  createIndexedDbImportCommitter,
  type IndexedDbImportCommitterOptions,
} from "../persistence/import-commit";
import { createImportService } from "./import-service";

export interface ProductionImportServiceOptions
extends IndexedDbImportCommitterOptions {
  defaultLimits?: ImportLimitsInput;
}

/** Wire the production dedicated Worker to the atomic IndexedDB committer. */
export function createProductionImportService(
  database: IDBDatabase,
  options: ProductionImportServiceOptions = {},
) {
  const { defaultLimits, ...committerOptions } = options;
  return createImportService<NormalizedImportGraph>({
    workerFactory: new BrowserImportWorkerFactory<NormalizedImportGraph>(),
    committer: createIndexedDbImportCommitter(database, committerOptions),
    defaultLimits,
    createReport: createNormalizedImportReport,
  });
}

export function createNormalizedImportReport(graph: NormalizedImportGraph): ImportReport {
  const decks = populatedImportDecks(graph);
  const cardCounts = new Map<string, number>();
  for (const card of graph.cards) {
    cardCounts.set(card.deckId, (cardCounts.get(card.deckId) ?? 0) + 1);
  }

  return Object.freeze({
    decks: Object.freeze(decks.map((deck) => Object.freeze({
      id: deck.id,
      name: deck.name,
      cardCount: cardCounts.get(deck.id) ?? 0,
    }))),
    deckCount: decks.length,
    noteCount: graph.notes.length,
    cardCount: graph.cards.length,
    mediaCount: graph.media.length,
  });
}
