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

export interface DeckRemovalCommitResultValue {
  readonly deckId: string;
  readonly cardCount: number;
  readonly mediaCount: number;
  readonly deletedSessionIds: readonly string[];
}

export type DeckRemovalCommitResult =
  | { readonly status: "committed"; readonly result: DeckRemovalCommitResultValue }
  | { readonly status: "stale"; readonly deckId: string }
  | { readonly status: "not-found"; readonly deckId: string }
  | { readonly status: "failed" };

export const DECK_REMOVAL_TRANSACTION_BOUNDARIES = [
  ...DECK_REMOVAL_GRAPH_STORES.map((store) => `read:${store}` as const),
  ...DECK_REMOVAL_GRAPH_STORES.map((store) => `delete:${store}` as const),
] as const;

export type DeckRemovalTransactionBoundary =
  (typeof DECK_REMOVAL_TRANSACTION_BOUNDARIES)[number];

export interface DeckRemovalCommitOptions {
  /** Deterministic fault seam used to prove native transaction rollback. */
  readonly failureAt?: DeckRemovalTransactionBoundary | "transaction-abort";
  readonly beforeBoundary?: (boundary: DeckRemovalTransactionBoundary) => void;
}

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

export interface DeckRemovalGraphCommitter {
  commitRemoval(
    expected: DeckRemovalPreview,
    options?: DeckRemovalCommitOptions,
  ): Promise<DeckRemovalCommitResult>;
}

/**
 * Application-owned removal preview boundary. It never writes durable or
 * presentation state; confirmation code must revalidate the opaque revision
 * inside its eventual write transaction before deleting anything.
 */
export class DeckRemovalService {
  constructor(
    private readonly graphReader: DeckRemovalGraphReader,
    private readonly graphCommitter?: DeckRemovalGraphCommitter,
  ) {}

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

  async confirmRemoval(
    expected: DeckRemovalPreview,
    options?: DeckRemovalCommitOptions,
  ): Promise<DeckRemovalCommitResult> {
    if (!expected.deckId) return { status: "not-found", deckId: expected.deckId };
    if (!this.graphCommitter) return { status: "failed" };
    return this.graphCommitter.commitRemoval(expected, options);
  }
}

/** Pure derivation exported for focused unit coverage. */
export async function deriveDeckRemovalPreview(
  graph: DeckRemovalGraphSnapshot,
  deckId: string,
): Promise<DeckRemovalPreview | null> {
  return deriveDeckRemovalPreviewSynchronously(graph, deckId);
}

function deriveDeckRemovalPreviewSynchronously(
  graph: DeckRemovalGraphSnapshot,
  deckId: string,
): DeckRemovalPreview | null {
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
  const revision = sha256(stableSerialize(revisionGraph));

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

class IndexedDbDeckRemovalGraphCommitter implements DeckRemovalGraphCommitter {
  private readonly repositories: RepositorySet;

  constructor(private readonly database: IDBDatabase) {
    this.repositories = createRepositories(database);
  }

  async commitRemoval(
    expected: DeckRemovalPreview,
    options: DeckRemovalCommitOptions = {},
  ): Promise<DeckRemovalCommitResult> {
    let transaction: IDBTransaction;
    try {
      transaction = this.database.transaction(DECK_REMOVAL_GRAPH_STORES, "readwrite");
    } catch {
      return { status: "failed" };
    }

    const completion = transactionCompletion(transaction);
    const context = createRepositoryTransactionContext(
      transaction,
      DECK_REMOVAL_GRAPH_STORES,
    );

    try {
      const graph = await this.readGraph(context, options);
      if (!graph.ok) return await abortWithFailure(transaction, completion);

      const current = deriveDeckRemovalPreviewSynchronously(graph.value, expected.deckId);
      if (!current) {
        await abortTransaction(transaction, completion);
        return { status: "not-found", deckId: expected.deckId };
      }
      if (current.revision !== expected.revision) {
        await abortTransaction(transaction, completion);
        return { status: "stale", deckId: expected.deckId };
      }

      const plan = createDeletionPlan(graph.value, current);
      const deleted = await this.deletePlan(plan, context, options);
      if (!deleted) return await abortWithFailure(transaction, completion);

      if (options.failureAt === "transaction-abort") transaction.abort();
      await completion;
      return {
        status: "committed",
        result: {
          deckId: current.deckId,
          cardCount: current.cardCount,
          mediaCount: current.mediaCount,
          deletedSessionIds: plan.sessions.map((session) => session.id),
        },
      };
    } catch {
      return await abortWithFailure(transaction, completion);
    }
  }

  private async readGraph(
    context: ReturnType<typeof createRepositoryTransactionContext>,
    options: DeckRemovalCommitOptions,
  ): Promise<DomainResult<DeckRemovalGraphSnapshot>> {
    const read = async <T>(
      store: (typeof DECK_REMOVAL_GRAPH_STORES)[number],
      operation: () => Promise<DomainResult<T[]>>,
    ): Promise<DomainResult<T[]>> => {
      hitBoundary(`read:${store}`, options);
      return operation();
    };
    const imports = await read("imports", () => this.repositories.imports.list(context));
    const decks = await read("decks", () => this.repositories.decks.list(context));
    const notes = await read("notes", () => this.repositories.notes.list(context));
    const cards = await read("cards", () => this.repositories.cards.list(context));
    const schedules = await read("schedules", () => this.repositories.schedules.list(context));
    const sessions = await read("sessions", () => this.repositories.sessions.list(context));
    const reviewLogs = await read("reviewLogs", () => this.repositories.reviewLogs.list(context));
    const media = await read("media", () => this.repositories.media.list(context));
    const results = [imports, decks, notes, cards, schedules, sessions, reviewLogs, media];
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) return failure(failed.error);
    if (!imports.ok || !decks.ok || !notes.ok || !cards.ok || !schedules.ok
      || !sessions.ok || !reviewLogs.ok || !media.ok) {
      return failure(domainError("storage", "The deck removal graph could not be read."));
    }
    return success({
      imports: imports.value, decks: decks.value, notes: notes.value,
      cards: cards.value, schedules: schedules.value, sessions: sessions.value,
      reviewLogs: reviewLogs.value, media: media.value,
    });
  }

  private async deletePlan(
    plan: DeckRemovalDeletionPlan,
    context: ReturnType<typeof createRepositoryTransactionContext>,
    options: DeckRemovalCommitOptions,
  ): Promise<boolean> {
    const remove = async <T>(
      store: (typeof DECK_REMOVAL_GRAPH_STORES)[number],
      records: readonly T[],
      operation: (record: T) => Promise<DomainResult<void>>,
    ): Promise<boolean> => {
      hitBoundary(`delete:${store}`, options);
      for (const record of records) {
        if (!(await operation(record)).ok) return false;
      }
      return true;
    };

    return await remove("reviewLogs", plan.reviewLogs, (record) =>
      this.repositories.reviewLogs.delete(record.id, context))
      && await remove("sessions", plan.sessions, (record) =>
        this.repositories.sessions.delete(record.id, context))
      && await remove("schedules", plan.schedules, (record) =>
        this.repositories.schedules.delete(record.cardId, context))
      && await remove("cards", plan.cards, (record) =>
        this.repositories.cards.delete(record.id, context))
      && await remove("notes", plan.notes, (record) =>
        this.repositories.notes.delete(record.id, context))
      && await remove("media", plan.media, (record) =>
        this.repositories.media.delete([record.importId, record.name], context))
      && await remove("decks", plan.decks, (record) =>
        this.repositories.decks.delete(record.id, context))
      && await remove("imports", plan.imports, (record) =>
        this.repositories.imports.delete(record.id, context));
  }
}

export function createDeckRemovalService(database: IDBDatabase): DeckRemovalService {
  return new DeckRemovalService(
    new IndexedDbDeckRemovalGraphReader(database),
    new IndexedDbDeckRemovalGraphCommitter(database),
  );
}

interface DeckRemovalDeletionPlan {
  imports: ImportRecord[];
  decks: DeckRecord[];
  notes: NoteRecord[];
  cards: CardRecord[];
  schedules: ScheduleRecord[];
  sessions: SessionRecord[];
  reviewLogs: ReviewLogRecord[];
  media: MediaRecord[];
}

function createDeletionPlan(
  graph: DeckRemovalGraphSnapshot,
  preview: DeckRemovalPreview,
): DeckRemovalDeletionPlan {
  const deck = graph.decks.find((candidate) => candidate.id === preview.deckId)!;
  const cards = graph.cards.filter((card) => card.deckId === deck.id);
  const cardIds = new Set(cards.map((card) => card.id));
  const selectedNoteIds = new Set(cards.map((card) => card.noteId));
  const remainingCards = graph.cards.filter((card) => !cardIds.has(card.id));
  const remainingNoteIds = new Set(remainingCards.map((card) => card.noteId));
  const remainingMediaReferences = new Set(remainingCards.flatMap((card) => card.mediaRefs));
  const sessions = graph.sessions.filter((session) =>
    session.deckId === deck.id
    || (session.activeCardId !== null && cardIds.has(session.activeCardId))
    || session.queueEntries.some((entry) => cardIds.has(entry.cardId))
  );
  const sessionIds = new Set(sessions.map((session) => session.id));
  const siblingDeckExists = graph.decks.some((candidate) =>
    candidate.id !== deck.id && candidate.importId === deck.importId
  );

  return {
    imports: siblingDeckExists
      ? []
      : graph.imports.filter((item) => item.id === deck.importId),
    decks: [deck],
    notes: graph.notes.filter((note) =>
      (note.importId === deck.importId || selectedNoteIds.has(note.id))
      && !remainingNoteIds.has(note.id)
    ),
    cards,
    schedules: graph.schedules.filter((schedule) =>
      schedule.deckId === deck.id || cardIds.has(schedule.cardId)
    ),
    sessions,
    reviewLogs: graph.reviewLogs.filter((log) =>
      log.deckId === deck.id || cardIds.has(log.cardId) || sessionIds.has(log.sessionId)
    ),
    media: graph.media.filter((record) =>
      record.importId === deck.importId
      && !remainingMediaReferences.has(mediaReference(record))
    ),
  };
}

function hitBoundary(
  boundary: DeckRemovalTransactionBoundary,
  options: DeckRemovalCommitOptions,
): void {
  options.beforeBoundary?.(boundary);
  if (options.failureAt === boundary) throw new Error("Injected deck removal failure.");
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Transaction failed."));
  });
}

async function abortTransaction(
  transaction: IDBTransaction,
  completion: Promise<void>,
): Promise<void> {
  try { transaction.abort(); } catch { /* already inactive */ }
  try { await completion; } catch { /* expected abort */ }
}

async function abortWithFailure(
  transaction: IDBTransaction,
  completion: Promise<void>,
): Promise<DeckRemovalCommitResult> {
  await abortTransaction(transaction, completion);
  return { status: "failed" };
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

function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const words: number[] = [];
  const bitLength = bytes.length * 8;
  for (const byte of bytes) words.push(byte);
  words.push(0x80);
  while (words.length % 64 !== 56) words.push(0);
  for (let shift = 56; shift >= 0; shift -= 8) {
    words.push(shift >= 32 ? 0 : (bitLength >>> shift) & 0xff);
  }

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const constants = SHA256_CONSTANTS;
  for (let offset = 0; offset < words.length; offset += 64) {
    const schedule = new Array<number>(64);
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      schedule[index] = (
        (words[start]! << 24) | (words[start + 1]! << 16)
        | (words[start + 2]! << 8) | words[start + 3]!
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const a = schedule[index - 15]!;
      const b = schedule[index - 2]!;
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + choice + constants[index]! + schedule[index]!) >>> 0;
      const s0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;
