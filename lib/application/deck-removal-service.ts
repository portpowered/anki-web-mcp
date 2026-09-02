import type {
  CardRecord,
  DeckRecord,
  ImportRecord,
  MediaRecord,
  NoteRecord,
  ReviewLogRecord,
  ScheduleRecord,
  SessionRecord,
} from "../domain/entities";
import {
  domainError,
  failure,
  mapDatabaseError,
  success,
  type DomainResult,
} from "../domain/errors";
import type { RepositorySet } from "../domain/repositories";
import {
  createRepositories,
  createRepositoryTransactionContext,
} from "../persistence/repositories";

export const DECK_REMOVAL_GRAPH_STORES = [
  "imports",
  "decks",
  "notes",
  "cards",
  "schedules",
  "sessions",
  "reviewLogs",
  "media",
] as const;

export interface DeckRemovalPreview {
  readonly deckId: string;
  readonly deckName: string;
  readonly cardCount: number;
  readonly mediaCount: number;
  /** Opaque durable-graph fingerprint that must be revalidated before commit. */
  readonly revision: string;
}

export type DeckRemovalPreviewResult =
  | { readonly status: "ready"; readonly preview: DeckRemovalPreview }
  | { readonly status: "not-found"; readonly deckId: string }
  | { readonly status: "failed" };

export type DeckRemovalRevalidationResult =
  | { readonly status: "valid"; readonly preview: DeckRemovalPreview }
  | { readonly status: "stale"; readonly deckId: string }
  | { readonly status: "not-found"; readonly deckId: string }
  | { readonly status: "failed" };

export interface DeckRemovalGraphSnapshot {
  readonly imports: readonly ImportRecord[];
  readonly decks: readonly DeckRecord[];
  readonly notes: readonly NoteRecord[];
  readonly cards: readonly CardRecord[];
  readonly schedules: readonly ScheduleRecord[];
  readonly sessions: readonly SessionRecord[];
  readonly reviewLogs: readonly ReviewLogRecord[];
  readonly media: readonly MediaRecord[];
}

export interface DeckRemovalGraphReader {
  readGraph(): Promise<DomainResult<DeckRemovalGraphSnapshot>>;
}

/**
 * Application-owned removal preview boundary. It never writes durable or
 * presentation state; confirmation code must revalidate the opaque revision
 * inside its eventual write transaction before deleting anything.
 */
export class DeckRemovalService {
  constructor(private readonly graphReader: DeckRemovalGraphReader) {}

  async previewRemoval(deckId: string): Promise<DeckRemovalPreviewResult> {
    if (!deckId) return { status: "not-found", deckId };

    const graph = await this.graphReader.readGraph();
    if (!graph.ok) return { status: "failed" };

    try {
      const preview = await deriveDeckRemovalPreview(graph.value, deckId);
      return preview
        ? { status: "ready", preview }
        : { status: "not-found", deckId };
    } catch {
      return { status: "failed" };
    }
  }

  async revalidateRemoval(
    expected: DeckRemovalPreview,
  ): Promise<DeckRemovalRevalidationResult> {
    const current = await this.previewRemoval(expected.deckId);
    if (current.status !== "ready") return current;
    if (current.preview.revision !== expected.revision) {
      return { status: "stale", deckId: expected.deckId };
    }
    return { status: "valid", preview: current.preview };
  }
}

/** Pure derivation exported for focused unit coverage. */
export async function deriveDeckRemovalPreview(
  graph: DeckRemovalGraphSnapshot,
  deckId: string,
): Promise<DeckRemovalPreview | null> {
  const deck = graph.decks.find((candidate) => candidate.id === deckId);
  if (!deck) return null;

  const selectedCards = graph.cards.filter((card) => card.deckId === deckId);
  const selectedCardIds = new Set(selectedCards.map((card) => card.id));
  const remainingCards = graph.cards.filter((card) => !selectedCardIds.has(card.id));
  const remainingMediaReferences = new Set(
    remainingCards.flatMap((card) => card.mediaRefs),
  );
  const importMedia = graph.media.filter((media) => media.importId === deck.importId);
  const orphanedMedia = importMedia.filter((media) =>
    !remainingMediaReferences.has(mediaReference(media))
  );

  const revisionGraph = relevantRevisionGraph(
    graph,
    deck,
    selectedCards,
    importMedia,
  );
  const revision = await sha256(stableSerialize(revisionGraph));

  return {
    deckId: deck.id,
    deckName: deck.name,
    cardCount: selectedCards.length,
    mediaCount: orphanedMedia.length,
    revision: `deck-removal-v1:${revision}`,
  };
}

class IndexedDbDeckRemovalGraphReader implements DeckRemovalGraphReader {
  private readonly repositories: RepositorySet;

  constructor(private readonly database: IDBDatabase) {
    this.repositories = createRepositories(database);
  }

  async readGraph(): Promise<DomainResult<DeckRemovalGraphSnapshot>> {
    let transaction: IDBTransaction;
    try {
      transaction = this.database.transaction(DECK_REMOVAL_GRAPH_STORES, "readonly");
    } catch (cause) {
      return failure(mapDatabaseError(cause, "storage", {
        resource: "deck-removal-preview",
      }));
    }

    const context = createRepositoryTransactionContext(
      transaction,
      DECK_REMOVAL_GRAPH_STORES,
    );
    const results = await Promise.all([
      this.repositories.imports.list(context),
      this.repositories.decks.list(context),
      this.repositories.notes.list(context),
      this.repositories.cards.list(context),
      this.repositories.schedules.list(context),
      this.repositories.sessions.list(context),
      this.repositories.reviewLogs.list(context),
      this.repositories.media.list(context),
    ]);
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) return failure(failed.error);

    const [imports, decks, notes, cards, schedules, sessions, reviewLogs, media] = results;
    if (
      !imports.ok || !decks.ok || !notes.ok || !cards.ok
      || !schedules.ok || !sessions.ok || !reviewLogs.ok || !media.ok
    ) {
      return failure(domainError(
        "storage",
        "The deck removal preview could not be read.",
        { resource: "deck-removal-preview" },
      ));
    }

    return success({
      imports: imports.value,
      decks: decks.value,
      notes: notes.value,
      cards: cards.value,
      schedules: schedules.value,
      sessions: sessions.value,
      reviewLogs: reviewLogs.value,
      media: media.value,
    });
  }
}

export function createDeckRemovalService(database: IDBDatabase): DeckRemovalService {
  return new DeckRemovalService(new IndexedDbDeckRemovalGraphReader(database));
}

function relevantRevisionGraph(
  graph: DeckRemovalGraphSnapshot,
  deck: DeckRecord,
  selectedCards: readonly CardRecord[],
  importMedia: readonly MediaRecord[],
): unknown {
  const selectedCardIds = new Set(selectedCards.map((card) => card.id));
  const selectedNoteIds = new Set(selectedCards.map((card) => card.noteId));
  const importMediaIds = new Set(importMedia.map(mediaReference));
  const siblingDeckIds = new Set(
    graph.decks
      .filter((candidate) => candidate.importId === deck.importId)
      .map((candidate) => candidate.id),
  );
  const relevantCards = graph.cards.filter((card) =>
    siblingDeckIds.has(card.deckId)
    || selectedNoteIds.has(card.noteId)
    || card.mediaRefs.some((reference) => importMediaIds.has(reference))
  );
  const deletedSessions = graph.sessions.filter((session) =>
    session.deckId === deck.id
    || (session.activeCardId !== null && selectedCardIds.has(session.activeCardId))
    || session.queueEntries.some((entry) => selectedCardIds.has(entry.cardId))
  );
  const deletedSessionIds = new Set(deletedSessions.map((session) => session.id));

  return {
    imports: graph.imports.filter((item) => item.id === deck.importId),
    decks: graph.decks.filter((candidate) => candidate.importId === deck.importId),
    notes: graph.notes.filter((note) =>
      note.importId === deck.importId || selectedNoteIds.has(note.id)
    ),
    cards: relevantCards,
    schedules: graph.schedules.filter((schedule) =>
      schedule.deckId === deck.id || selectedCardIds.has(schedule.cardId)
    ),
    sessions: deletedSessions,
    reviewLogs: graph.reviewLogs.filter((log) =>
      log.deckId === deck.id
      || selectedCardIds.has(log.cardId)
      || deletedSessionIds.has(log.sessionId)
    ),
    media: importMedia.map((record) => ({
      importId: record.importId,
      name: record.name,
      mimeType: record.mimeType,
      byteLength: record.byteLength,
      sha256: record.sha256,
    })),
  };
}

function mediaReference(media: Pick<MediaRecord, "importId" | "name">): string {
  return `${media.importId}/media/${encodeURIComponent(media.name)}`;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize).sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
