import type {
  CardRecord,
  DeckRecord,
  ImportRecord,
  MediaRecord,
  NoteRecord,
  ScheduleRecord,
} from "../domain/entities";
import type { Clock } from "../domain/ports";
import type { DomainResult } from "../domain/errors";
import type { RepositorySet } from "../domain/repositories";
import {
  NeutralScheduleInitializer,
  type ScheduleInitializer,
} from "../domain/scheduler";
import type {
  ImportCommitInput,
  ImportCommitResult,
  ImportCommitter,
  ExistingImportMatch,
  ImportWarning,
  NormalizedImportGraph,
} from "../import/contracts";
import { importError, isImportError } from "../import/errors";
import { systemClock } from "../platform/clock";
import {
  createRepositories,
  createRepositoryTransactionContext,
} from "./repositories";

export const IMPORT_GRAPH_TRANSACTION_STORES = [
  "imports",
  "decks",
  "notes",
  "cards",
  "schedules",
  "media",
  "sessions",
  "reviewLogs",
] as const;

export const IMPORT_GRAPH_WRITE_POSITIONS = [
  "import",
  "deck",
  "note",
  "card",
  "schedule",
  "media",
] as const;

export type ImportGraphWritePosition =
  (typeof IMPORT_GRAPH_WRITE_POSITIONS)[number];

export const IMPORT_GRAPH_DELETE_POSITIONS = [
  "schedule",
  "card",
  "note",
  "media",
  "deck",
  "import",
] as const;

export type ImportGraphDeletePosition =
  (typeof IMPORT_GRAPH_DELETE_POSITIONS)[number];

export interface ImportGraphTransactionHooks {
  beforeWrite?: (
    position: ImportGraphWritePosition,
    index: number | undefined,
    records: ImportGraphRecords,
  ) => void;
  afterWrite?: (
    position: ImportGraphWritePosition,
    index: number | undefined,
    records: ImportGraphRecords,
  ) => void;
  beforeDelete?: (
    position: ImportGraphDeletePosition,
    index: number | undefined,
    records: ExistingImportGraphRecords,
  ) => void;
  afterDelete?: (
    position: ImportGraphDeletePosition,
    index: number | undefined,
    records: ExistingImportGraphRecords,
  ) => void;
}

export interface IndexedDbImportCommitterOptions {
  clock?: Clock;
  scheduleInitializer?: ScheduleInitializer;
  repositories?: RepositorySet;
  hooks?: ImportGraphTransactionHooks;
  /** Deterministic fault injection used to prove native transaction rollback. */
  failureAt?: ImportGraphWritePosition | `delete-${ImportGraphDeletePosition}`;
}

export interface ImportGraphRecords {
  readonly importRecord: ImportRecord;
  readonly decks: readonly DeckRecord[];
  readonly notes: readonly NoteRecord[];
  readonly cards: readonly CardRecord[];
  readonly schedules: readonly ScheduleRecord[];
  readonly media: readonly MediaRecord[];
}

export type ExistingImportGraphRecords = ImportGraphRecords;

/**
 * Application-owned persistence adapter for a fully validated Worker graph.
 * All records are mapped before a native transaction is opened, and all
 * participating repository writes borrow that one transaction.
 */
export class IndexedDbImportCommitter
implements ImportCommitter<NormalizedImportGraph> {
  private readonly repositories: RepositorySet;
  private readonly clock: Clock;
  private readonly scheduleInitializer: ScheduleInitializer;

  public constructor(
    private readonly database: IDBDatabase,
    private readonly options: IndexedDbImportCommitterOptions = {},
  ) {
    this.repositories = options.repositories ?? createRepositories(database);
    this.clock = options.clock ?? systemClock;
    this.scheduleInitializer = options.scheduleInitializer
      ?? new NeutralScheduleInitializer(this.clock);
  }

  public async commit(
    input: ImportCommitInput<NormalizedImportGraph>,
  ): Promise<ImportCommitResult> {
    const records = buildImportGraphRecords(
      input,
      this.clock,
      this.scheduleInitializer,
    );

    let transaction: IDBTransaction;
    try {
      transaction = this.database.transaction(
        [...IMPORT_GRAPH_TRANSACTION_STORES],
        "readwrite",
      );
    } catch (cause) {
      throw mapCommitFailure(
        cause,
        input.operationId,
        input.duplicatePolicy === "replace" ? "REPLACE_FAILED" : "COMMIT_FAILED",
      );
    }

    const completion = waitForTransaction(transaction);
    const context = createRepositoryTransactionContext(
      transaction,
      [...IMPORT_GRAPH_TRANSACTION_STORES],
    );

    try {
      const existing = await this.findExistingInTransaction(
        input.packageSha256,
        context,
      );
      if (existing) {
        if (input.duplicatePolicy === "cancel") {
          throw importError("DUPLICATE_IMPORT", {
            operationId: input.operationId,
            stage: "committing",
            detail: existing.id,
          });
        }
        const existingRecords = await this.readOwnedGraph(existing, context, input.operationId);
        await this.assertNoExternalReferences(existingRecords, context, input.operationId);
        await this.deleteOwnedGraph(existingRecords, context);
      }

      await this.write("import", undefined, records, () =>
        this.repositories.imports.add(records.importRecord, context));

      for (const [index, deck] of records.decks.entries()) {
        await this.write("deck", index, records, () =>
          this.repositories.decks.add(deck, context));
      }
      for (const [index, note] of records.notes.entries()) {
        await this.write("note", index, records, () =>
          this.repositories.notes.add(note, context));
      }
      for (const [index, card] of records.cards.entries()) {
        await this.write("card", index, records, () =>
          this.repositories.cards.add(card, context));
      }
      for (const [index, schedule] of records.schedules.entries()) {
        await this.write("schedule", index, records, () =>
          this.repositories.schedules.add(schedule, context));
      }
      for (const [index, media] of records.media.entries()) {
        await this.write("media", index, records, () =>
          this.repositories.media.add(media, context));
      }

      await completion;
      return {
        importId: records.importRecord.id,
        deckIds: records.decks.map((deck) => deck.id),
      };
    } catch (cause) {
      await abortAndSettle(transaction, completion);
      throw mapCommitFailure(
        cause,
        input.operationId,
        input.duplicatePolicy === "replace" ? "REPLACE_FAILED" : "COMMIT_FAILED",
      );
    }
  }

  public async findExisting(
    packageSha256: string,
  ): Promise<ExistingImportMatch | null> {
    const result = await this.repositories.imports.findBySha256(packageSha256);
    if (result.ok) {
      return { importId: result.value.id, packageSha256: result.value.sha256 };
    }
    if (result.error.code === "not-found") {
      return null;
    }
    throw importError("COMMIT_FAILED", {
      stage: "preflight",
      detail: "duplicate-check-failed",
    });
  }

  private async findExistingInTransaction(
    packageSha256: string,
    context: ReturnType<typeof createRepositoryTransactionContext>,
  ): Promise<ImportRecord | null> {
    const result = await this.repositories.imports.findBySha256(packageSha256, context);
    if (result.ok) return result.value;
    if (result.error.code === "not-found") return null;
    throw importError("COMMIT_FAILED", { stage: "committing" });
  }

  private async readOwnedGraph(
    importRecord: ImportRecord,
    context: ReturnType<typeof createRepositoryTransactionContext>,
    operationId: string,
  ): Promise<ExistingImportGraphRecords> {
    const decks = await requiredList(
      this.repositories.decks.listByImportId(importRecord.id, context),
      operationId,
    );
    const allNotes = await requiredList(this.repositories.notes.list(context), operationId);
    const notes = allNotes.filter((note) => note.importId === importRecord.id);
    const cards = (await Promise.all(decks.map((deck) =>
      requiredList(this.repositories.cards.listByDeckId(deck.id, context), operationId)
    ))).flat();
    const cardIds = new Set(cards.map((card) => card.id));
    const schedules = (await requiredList(
      this.repositories.schedules.list(context),
      operationId,
    )).filter((schedule) => cardIds.has(schedule.cardId));
    const media = await requiredList(
      this.repositories.media.listByImportId(importRecord.id, context),
      operationId,
    );
    return { importRecord, decks, notes, cards, schedules, media };
  }

  private async assertNoExternalReferences(
    records: ExistingImportGraphRecords,
    context: ReturnType<typeof createRepositoryTransactionContext>,
    operationId: string,
  ): Promise<void> {
    const deckIds = new Set(records.decks.map((deck) => deck.id));
    const noteIds = new Set(records.notes.map((note) => note.id));
    const cardIds = new Set(records.cards.map((card) => card.id));
    const mediaIds = new Set(records.media.map((media) =>
      `${media.importId}/media/${media.name}`
    ));
    const [allCards, sessions, reviewLogs] = await Promise.all([
      requiredList(this.repositories.cards.list(context), operationId),
      requiredList(this.repositories.sessions.list(context), operationId),
      requiredList(this.repositories.reviewLogs.list(context), operationId),
    ]);
    const externalCardReference = allCards.some((card) =>
      !cardIds.has(card.id)
      && (deckIds.has(card.deckId)
        || noteIds.has(card.noteId)
        || card.mediaRefs.some((reference) => mediaIds.has(reference)))
    );
    const externalStudyReference = sessions.some((session) =>
      deckIds.has(session.deckId)
      || (session.activeCardId !== null && cardIds.has(session.activeCardId))
      || session.queueEntries.some((entry) => cardIds.has(entry.cardId))
    ) || reviewLogs.some((log) =>
      deckIds.has(log.deckId) || cardIds.has(log.cardId)
    );
    if (externalCardReference || externalStudyReference) {
      throw importError("REPLACE_FAILED", {
        operationId,
        stage: "committing",
        detail: "external-reference",
      });
    }
  }

  private async deleteOwnedGraph(
    records: ExistingImportGraphRecords,
    context: ReturnType<typeof createRepositoryTransactionContext>,
  ): Promise<void> {
    for (const [index, schedule] of records.schedules.entries()) {
      await this.remove("schedule", index, records, () =>
        this.repositories.schedules.delete(schedule.cardId, context));
    }
    for (const [index, card] of records.cards.entries()) {
      await this.remove("card", index, records, () =>
        this.repositories.cards.delete(card.id, context));
    }
    for (const [index, note] of records.notes.entries()) {
      await this.remove("note", index, records, () =>
        this.repositories.notes.delete(note.id, context));
    }
    for (const [index, media] of records.media.entries()) {
      await this.remove("media", index, records, () =>
        this.repositories.media.delete([media.importId, media.name], context));
    }
    for (const [index, deck] of records.decks.entries()) {
      await this.remove("deck", index, records, () =>
        this.repositories.decks.delete(deck.id, context));
    }
    await this.remove("import", undefined, records, () =>
      this.repositories.imports.delete(records.importRecord.id, context));
  }

  private async remove(
    position: ImportGraphDeletePosition,
    index: number | undefined,
    records: ExistingImportGraphRecords,
    remove: () => Promise<{ ok: true; value: void } | { ok: false; error: { code: string } }>,
  ): Promise<void> {
    this.options.hooks?.beforeDelete?.(position, index, records);
    if (this.options.failureAt === `delete-${position}`) {
      throw new Error(`Injected failure before ${position} delete.`);
    }
    const result = await remove();
    if (!result.ok) throw importError("REPLACE_FAILED", { stage: "committing" });
    this.options.hooks?.afterDelete?.(position, index, records);
  }

  private async write<Result>(
    position: ImportGraphWritePosition,
    index: number | undefined,
    records: ImportGraphRecords,
    write: () => Promise<{ ok: true; value: Result } | { ok: false; error: { code: string } }>,
  ): Promise<Result> {
    this.options.hooks?.beforeWrite?.(position, index, records);
    if (this.options.failureAt === position) {
      throw new Error(`Injected failure before ${position} write.`);
    }

    const result = await write();
    if (!result.ok) {
      if (result.error.code === "quota") {
        throw importError("QUOTA_EXCEEDED", { stage: "committing" });
      }
      throw importError("COMMIT_FAILED", { stage: "committing" });
    }
    this.options.hooks?.afterWrite?.(position, index, records);
    return result.value;
  }
}

export function createIndexedDbImportCommitter(
  database: IDBDatabase,
  options: IndexedDbImportCommitterOptions = {},
): ImportCommitter<NormalizedImportGraph> {
  return new IndexedDbImportCommitter(database, options);
}

export function buildImportGraphRecords(
  input: ImportCommitInput<NormalizedImportGraph>,
  clock: Clock = systemClock,
  scheduleInitializer: ScheduleInitializer = new NeutralScheduleInitializer(clock),
): ImportGraphRecords {
  validateCommitInput(input);
  const createdAt = clock.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw importError("COMMIT_FAILED", {
      operationId: input.operationId,
      stage: "commit-ready",
      detail: "invalid-import-time",
    });
  }

  const importId = input.packageSha256;
  const deckIds = new Map(input.graph.decks.map((deck) => [
    deck.id,
    ownedId(importId, "deck", deck.id),
  ]));
  const noteIds = new Map(input.graph.notes.map((note) => [
    note.id,
    ownedId(importId, "note", note.id),
  ]));
  const notetypes = new Map(input.graph.notetypes.map((item) => [item.id, item]));
  const cardCounts = new Map<string, number>();
  for (const card of input.graph.cards) {
    cardCounts.set(card.deckId, (cardCounts.get(card.deckId) ?? 0) + 1);
  }

  const decks = input.graph.decks.map((deck): DeckRecord => ({
    id: deckIds.get(deck.id)!,
    importId,
    sourceDeckId: deck.id,
    name: deck.name,
    cardCount: cardCounts.get(deck.id) ?? 0,
    createdAt,
    lastStudiedAt: null,
    sessionIntakeLimit: 20,
    schedulerConfigId: "neutral-v1",
  }));

  const notes = input.graph.notes.map((note): NoteRecord => {
    const notetype = notetypes.get(note.notetypeId)!;
    return {
      id: noteIds.get(note.id)!,
      importId,
      sourceNoteId: note.id,
      guid: note.sourceGuid,
      modelId: note.notetypeId,
      fields: Object.fromEntries(
        notetype.fields.map((field, index) => [field, note.fields[index] ?? ""]),
      ),
      tags: [...note.tags],
    };
  });

  const deckCreationOrder = new Map<string, number>();
  const cards = input.graph.cards.map((card): CardRecord => {
    const creationOrder = deckCreationOrder.get(card.deckId) ?? 0;
    deckCreationOrder.set(card.deckId, creationOrder + 1);
    return {
      id: ownedId(importId, "card", card.id),
      deckId: deckIds.get(card.deckId)!,
      noteId: noteIds.get(card.noteId)!,
      sourceCardId: card.id,
      templateOrdinal: card.templateOrdinal,
      frontHtml: card.content.frontHtml,
      backHtml: card.content.backHtml,
      mediaRefs: [...card.content.mediaReferences],
      creationOrder,
      contentWarnings: warningsForCard(input.warnings, card.id),
    };
  });

  const schedules = cards.map((card) =>
    scheduleInitializer.initializeNewCard({
      cardId: card.id,
      deckId: card.deckId,
      createdAt,
    }));

  const media = input.graph.media.map((item): MediaRecord => ({
    importId,
    name: item.name,
    blob: new Blob([item.bytes.slice()], { type: item.mimeType }),
    mimeType: item.mimeType,
    byteLength: item.byteLength,
    sha256: item.sha256,
  }));

  return {
    importRecord: {
      id: importId,
      sha256: input.packageSha256,
      fileName: input.request.fileName ?? "import.apkg",
      fileSize: input.request.packageBytes.byteLength,
      packageVersion: input.graph.layout,
      importedAt: createdAt,
      warnings: input.warnings.map(serializeWarning),
    },
    decks,
    notes,
    cards,
    schedules,
    media,
  };
}

function validateCommitInput(input: ImportCommitInput<NormalizedImportGraph>): void {
  const fail = (detail: string): never => {
    throw importError("COMMIT_FAILED", {
      operationId: input.operationId,
      stage: "commit-ready",
      detail,
    });
  };
  if (input.graph.packageSha256 !== input.packageSha256) fail("checksum-mismatch");
  if (!/^[0-9a-f]{64}$/.test(input.packageSha256)) fail("invalid-checksum");

  const deckIds = uniqueIds(input.graph.decks, "deck", fail);
  const noteIds = uniqueIds(input.graph.notes, "note", fail);
  const cardIds = uniqueIds(input.graph.cards, "card", fail);
  const notetypeIds = uniqueIds(input.graph.notetypes, "notetype", fail);
  if (cardIds.size === 0 || deckIds.size === 0) fail("empty-import-graph");

  for (const note of input.graph.notes) {
    if (!deckIds.has(note.deckId) || !notetypeIds.has(note.notetypeId)) {
      fail("invalid-note-relationship");
    }
  }
  for (const card of input.graph.cards) {
    if (
      card.scheduling !== "fresh"
      || !deckIds.has(card.deckId)
      || !noteIds.has(card.noteId)
    ) {
      fail("invalid-card-relationship");
    }
  }
  const mediaNames = new Set<string>();
  for (const item of input.graph.media) {
    if (
      item.importPackageSha256 !== input.packageSha256
      || item.byteLength !== item.bytes.byteLength
      || mediaNames.has(item.name)
    ) {
      fail("invalid-media-record");
    }
    mediaNames.add(item.name);
  }
}

function uniqueIds(
  records: readonly { readonly id: string }[],
  kind: string,
  fail: (detail: string) => never,
): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.id || ids.has(record.id)) fail(`invalid-${kind}-id`);
    ids.add(record.id);
  }
  return ids;
}

function ownedId(importId: string, kind: string, sourceId: string): string {
  return `${importId}/${kind}/${encodeURIComponent(sourceId)}`;
}

function warningsForCard(
  warnings: readonly ImportWarning[],
  cardId: string,
): string[] {
  return warnings
    .filter((warning) => warning.source?.kind === "card" && warning.source.id === cardId)
    .map(serializeWarning);
}

function serializeWarning(warning: ImportWarning): string {
  const source = warning.source
    ? `${warning.source.kind}:${warning.source.id}`
    : "package";
  return `${warning.code}:${source}`;
}

function mapCommitFailure(
  cause: unknown,
  operationId: string,
  fallbackCode: "COMMIT_FAILED" | "REPLACE_FAILED",
) {
  if (isImportError(cause)) {
    return cause;
  }
  const name = cause && typeof cause === "object" && "name" in cause
    ? (cause as { name?: unknown }).name
    : undefined;
  return importError(name === "QuotaExceededError" ? "QUOTA_EXCEEDED" : fallbackCode, {
    operationId,
    stage: "committing",
  });
}

async function requiredList<Record>(
  resultPromise: Promise<DomainResult<Record[]>>,
  operationId: string,
): Promise<Record[]> {
  const result = await resultPromise;
  if (!result.ok) {
    throw importError("REPLACE_FAILED", {
      operationId,
      stage: "committing",
      detail: "owned-graph-read-failed",
    });
  }
  return result.value;
}

async function abortAndSettle(
  transaction: IDBTransaction,
  completion: Promise<void>,
): Promise<void> {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have aborted or completed.
  }
  await completion.catch(() => undefined);
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new DOMException("IndexedDB transaction aborted.", "AbortError"),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new DOMException("IndexedDB transaction failed.", "UnknownError"),
    );
  });
}
