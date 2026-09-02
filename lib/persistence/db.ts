import type {
  CardRecord,
  DeckRecord,
  MetaRecord,
  ReviewLogRecord,
  ScheduleRecord,
  SessionRecord,
} from "../domain/entities";
import type {
  RepositoryTransactionContext,
} from "../domain/repositories";
import type { DomainError, DomainResult } from "../domain/errors";
import {
  type StudyStoreName,
} from "./schema";
import { openDatabase } from "./database";
import {
  createRepositories,
  createRepositoryTransactionContext,
  type IndexedDbRepositorySet,
} from "./repositories";

export type StudyTransactionMode = "readonly" | "readwrite";

export interface StudyTransaction {
  getDeck(deckId: string): Promise<DeckRecord | undefined>;
  getCard(cardId: string): Promise<CardRecord | undefined>;
  getSchedule(cardId: string): Promise<ScheduleRecord | undefined>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  /** Optional for compatibility with pre-review transaction adapters. */
  getReviewLog?(reviewLogId: string): Promise<ReviewLogRecord | undefined>;
  /** Optional for compatibility with pre-review transaction adapters. */
  getReviewLogByCommandId?(
    commandId: string,
  ): Promise<ReviewLogRecord | undefined>;
  /** Optional for compatibility with adapters created before command metadata. */
  getMeta?(key: string): Promise<MetaRecord | undefined>;
  listCards(deckId: string): Promise<CardRecord[]>;
  listSchedules(deckId: string): Promise<ScheduleRecord[]>;
  listSessions(deckId: string): Promise<SessionRecord[]>;
  putDeck(deck: DeckRecord): Promise<void>;
  putCard(card: CardRecord): Promise<void>;
  putSchedule(schedule: ScheduleRecord): Promise<void>;
  putSession(session: SessionRecord): Promise<void>;
  /** Optional for compatibility with pre-review transaction adapters. */
  putReviewLog?(reviewLog: ReviewLogRecord): Promise<void>;
  /** Optional for compatibility with adapters created before command metadata. */
  putMeta?(record: MetaRecord): Promise<void>;
}

export interface StudyDatabase {
  transaction<T>(
    mode: StudyTransactionMode,
    stores: readonly StudyStoreName[],
    work: (transaction: StudyTransaction) => Promise<T> | T,
  ): Promise<T>;
  close(): void;
}

export interface StudyDatabaseSeed {
  readonly decks?: readonly DeckRecord[];
  readonly cards?: readonly CardRecord[];
  readonly meta?: readonly MetaRecord[];
  readonly schedules?: readonly ScheduleRecord[];
  readonly sessions?: readonly SessionRecord[];
  readonly reviewLogs?: readonly ReviewLogRecord[];
}

export type StudyPersistenceErrorCode =
  | "unavailable"
  | "open"
  | "transaction"
  | "conflict";

export class StudyPersistenceError extends Error {
  constructor(
    readonly code: StudyPersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StudyPersistenceError";
  }
}

export interface OpenStudyDatabaseOptions {
  readonly name?: string;
  readonly version?: number;
  /** Injectable for browser tests and alternate IndexedDB implementations. */
  readonly indexedDB?: IDBFactory;
}

/** Open the browser database and install the versioned study schema. */
export function openIndexedDbStudyDatabase(
  options: OpenStudyDatabaseOptions = {},
): Promise<IndexedDbStudyDatabase> {
  return openDatabase({
    ...(options.indexedDB === undefined ? {} : { factory: options.indexedDB }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.version === undefined ? {} : { version: options.version }),
  }).then((result) => {
    if (!result.ok) {
      throw domainFailureToPersistenceError(result.error);
    }
    return new IndexedDbStudyDatabase(result.value);
  });
}

/** Short alias used by application composition roots. */
export const openStudyDatabase = openIndexedDbStudyDatabase;

export class IndexedDbStudyDatabase implements StudyDatabase {
  private readonly repositories: IndexedDbRepositorySet;

  constructor(readonly db: IDBDatabase) {
    this.repositories = createRepositories(db);
  }

  async transaction<T>(
    mode: StudyTransactionMode,
    stores: readonly StudyStoreName[],
    work: (transaction: StudyTransaction) => Promise<T> | T,
  ): Promise<T> {
    if (stores.length === 0) {
      throw new StudyPersistenceError(
        "transaction",
        "An IndexedDB transaction requires at least one store.",
      );
    }

    let nativeTransaction: IDBTransaction;
    try {
      nativeTransaction = this.db.transaction([...stores], mode);
    } catch (error) {
      throw asPersistenceError(error, "Unable to start the study transaction.");
    }

    const completion = waitForTransaction(nativeTransaction);
    try {
      const context = createRepositoryTransactionContext(nativeTransaction, stores);
      const result = await work(new RepositoryStudyTransaction(
        this.repositories,
        context,
      ));
      await completion;
      return result;
    } catch (error) {
      try {
        nativeTransaction.abort();
      } catch {
        // It may already have aborted or completed; preserve the useful error.
      }
      await completion.catch(() => undefined);
      throw asPersistenceError(error, "The study transaction was not committed.");
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * A serializable transaction implementation for deterministic service tests.
 * It mirrors IndexedDB's all-or-nothing write behavior and serializes every
 * transaction, which makes concurrent start calls exercise the same logical
 * conflict boundary without requiring a browser runtime in Bun.
 */
export class MemoryStudyDatabase implements StudyDatabase {
  private state: MemoryStudyState;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(seed: StudyDatabaseSeed = {}) {
    this.state = stateFromSeed(seed);
  }

  async transaction<T>(
    mode: StudyTransactionMode,
    _stores: readonly StudyStoreName[],
    work: (transaction: StudyTransaction) => Promise<T> | T,
  ): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.transactionTail;
    this.transactionTail = previous.then(() => turn);
    await previous;

    const workingState = mode === "readwrite"
      ? cloneState(this.state)
      : this.state;
    try {
      const result = await work(new MemoryStudyTransaction(workingState, mode));
      if (mode === "readwrite") {
        this.state = workingState;
      }
      return result;
    } finally {
      release();
    }
  }

  close(): void {
    // Memory databases have no external resources to release.
  }

  snapshot(): StudyDatabaseSeed {
    const snapshot: {
      decks: DeckRecord[];
      cards: CardRecord[];
      meta?: MetaRecord[];
      schedules: ScheduleRecord[];
      sessions: SessionRecord[];
      reviewLogs?: ReviewLogRecord[];
    } = {
      decks: [...this.state.decks.values()].map(cloneValue),
      cards: [...this.state.cards.values()].map(cloneValue),
      schedules: [...this.state.schedules.values()].map(cloneValue),
      sessions: [...this.state.sessions.values()].map(cloneValue),
    };
    if (this.state.meta.size > 0) {
      snapshot.meta = [...this.state.meta.values()].map(cloneValue);
    }
    // Keep the pre-review snapshot shape stable for callers that only seed
    // foundation records, while exposing logs once the review store is used.
    if (this.state.reviewLogs.size > 0) {
      snapshot.reviewLogs = [...this.state.reviewLogs.values()].map(cloneValue);
    }
    return snapshot;
  }
}

/** Useful as a readable test name and as a migration-safe alias. */
export const InMemoryStudyDatabase = MemoryStudyDatabase;

export async function seedStudyDatabase(
  database: StudyDatabase,
  seed: StudyDatabaseSeed,
): Promise<void> {
  await database.transaction(
    "readwrite",
    ["meta", "decks", "cards", "schedules", "sessions"],
    async (transaction) => {
      for (const deck of seed.decks ?? []) {
        await transaction.putDeck(deck);
      }
      for (const card of seed.cards ?? []) {
        await transaction.putCard(card);
      }
      for (const record of seed.meta ?? []) {
        if (transaction.putMeta === undefined) {
          throw new StudyPersistenceError(
            "transaction",
            "This study transaction cannot store metadata.",
          );
        }
        await transaction.putMeta(record);
      }
      for (const schedule of seed.schedules ?? []) {
        await transaction.putSchedule(schedule);
      }
      for (const session of seed.sessions ?? []) {
        await transaction.putSession(session);
      }
      for (const reviewLog of seed.reviewLogs ?? []) {
        if (transaction.putReviewLog === undefined) {
          throw new StudyPersistenceError(
            "transaction",
            "This study transaction cannot store review logs.",
          );
        }
        await transaction.putReviewLog(reviewLog);
      }
    },
  );
}

/**
 * Application-facing transaction facade over the merged repository contracts.
 * It owns no schema or IndexedDB query logic; every operation borrows the one
 * native transaction context created by IndexedDbStudyDatabase.
 */
class RepositoryStudyTransaction implements StudyTransaction {
  constructor(
    private readonly repositories: IndexedDbRepositorySet,
    private readonly context: RepositoryTransactionContext,
  ) {}

  async getDeck(deckId: string): Promise<DeckRecord | undefined> {
    return optionalResult(await this.repositories.decks.get(deckId, this.context));
  }

  async getCard(cardId: string): Promise<CardRecord | undefined> {
    return optionalResult(await this.repositories.cards.get(cardId, this.context));
  }

  async getSchedule(cardId: string): Promise<ScheduleRecord | undefined> {
    return optionalResult(await this.repositories.schedules.get(cardId, this.context));
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return optionalResult(await this.repositories.sessions.get(sessionId, this.context));
  }

  async getMeta(key: string): Promise<MetaRecord | undefined> {
    return optionalResult(await this.repositories.meta.get(key, this.context));
  }

  async getReviewLog(reviewLogId: string): Promise<ReviewLogRecord | undefined> {
    return optionalResult(await this.repositories.reviewLogs.get(
      reviewLogId,
      this.context,
    ));
  }

  async getReviewLogByCommandId(commandId: string): Promise<ReviewLogRecord | undefined> {
    return optionalResult(await this.repositories.reviewLogs.findByCommandId(
      commandId,
      this.context,
    ));
  }

  async listCards(deckId: string): Promise<CardRecord[]> {
    return requiredResult(await this.repositories.cards.listByDeckId(deckId, this.context));
  }

  async listSchedules(deckId: string): Promise<ScheduleRecord[]> {
    return requiredResult(await this.repositories.schedules.listByDeckId(
      deckId,
      this.context,
    ));
  }

  async listSessions(deckId: string): Promise<SessionRecord[]> {
    return requiredResult(await this.repositories.sessions.listByDeckId(
      deckId,
      this.context,
    ));
  }

  async putDeck(deck: DeckRecord): Promise<void> {
    requiredResult(await this.repositories.decks.put(deck, this.context));
  }

  async putCard(card: CardRecord): Promise<void> {
    requiredResult(await this.repositories.cards.put(card, this.context));
  }

  async putSchedule(schedule: ScheduleRecord): Promise<void> {
    requiredResult(await this.repositories.schedules.put(schedule, this.context));
  }

  async putSession(session: SessionRecord): Promise<void> {
    requiredResult(await this.repositories.sessions.put(session, this.context));
  }

  async putMeta(record: MetaRecord): Promise<void> {
    requiredResult(await this.repositories.meta.put(record, this.context));
  }

  async putReviewLog(reviewLog: ReviewLogRecord): Promise<void> {
    requiredResult(await this.repositories.reviewLogs.put(reviewLog, this.context));
  }
}

interface MemoryStudyState {
  decks: Map<string, DeckRecord>;
  cards: Map<string, CardRecord>;
  meta: Map<string, MetaRecord>;
  schedules: Map<string, ScheduleRecord>;
  sessions: Map<string, SessionRecord>;
  reviewLogs: Map<string, ReviewLogRecord>;
}

class MemoryStudyTransaction implements StudyTransaction {
  constructor(
    private readonly state: MemoryStudyState,
    private readonly mode: StudyTransactionMode,
  ) {}

  async getDeck(deckId: string): Promise<DeckRecord | undefined> {
    return cloneOptional(this.state.decks.get(deckId));
  }

  async getCard(cardId: string): Promise<CardRecord | undefined> {
    return cloneOptional(this.state.cards.get(cardId));
  }

  async getSchedule(cardId: string): Promise<ScheduleRecord | undefined> {
    return cloneOptional(this.state.schedules.get(cardId));
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return cloneOptional(this.state.sessions.get(sessionId));
  }

  async getMeta(key: string): Promise<MetaRecord | undefined> {
    return cloneOptional(this.state.meta.get(key));
  }

  async getReviewLog(reviewLogId: string): Promise<ReviewLogRecord | undefined> {
    return cloneOptional(this.state.reviewLogs.get(reviewLogId));
  }

  async getReviewLogByCommandId(commandId: string): Promise<ReviewLogRecord | undefined> {
    for (const reviewLog of this.state.reviewLogs.values()) {
      if (reviewLog.commandId === commandId) {
        return cloneValue(reviewLog);
      }
    }
    return undefined;
  }

  async listCards(deckId: string): Promise<CardRecord[]> {
    return [...this.state.cards.values()]
      .filter((card) => card.deckId === deckId)
      .map(cloneValue);
  }

  async listSchedules(deckId: string): Promise<ScheduleRecord[]> {
    return [...this.state.schedules.values()]
      .filter((schedule) => schedule.deckId === deckId)
      .map(cloneValue);
  }

  async listSessions(deckId: string): Promise<SessionRecord[]> {
    return [...this.state.sessions.values()]
      .filter((session) => session.deckId === deckId)
      .map(cloneValue);
  }

  async putDeck(deck: DeckRecord): Promise<void> {
    this.assertWritable();
    this.state.decks.set(deck.id, cloneValue(deck));
  }

  async putCard(card: CardRecord): Promise<void> {
    this.assertWritable();
    this.state.cards.set(card.id, cloneValue(card));
  }

  async putSchedule(schedule: ScheduleRecord): Promise<void> {
    this.assertWritable();
    this.state.schedules.set(schedule.cardId, cloneValue(schedule));
  }

  async putSession(session: SessionRecord): Promise<void> {
    this.assertWritable();
    const duplicate = [...this.state.sessions.values()].find((existing) => (
      existing.id !== session.id
      && existing.deckId === session.deckId
      && existing.dayKey === session.dayKey
      && existing.sequence === session.sequence
    ));
    if (duplicate !== undefined) {
      throw new StudyPersistenceError(
        "conflict",
        "A session already exists for this deck, local day, and sequence.",
      );
    }
    this.state.sessions.set(session.id, cloneValue(session));
  }

  async putMeta(record: MetaRecord): Promise<void> {
    this.assertWritable();
    this.state.meta.set(record.key, cloneValue(record));
  }

  async putReviewLog(reviewLog: ReviewLogRecord): Promise<void> {
    this.assertWritable();
    const existingId = this.state.reviewLogs.get(reviewLog.id);
    if (existingId !== undefined && existingId.commandId !== reviewLog.commandId) {
      throw new StudyPersistenceError(
        "conflict",
        "A review log already exists for this ID.",
      );
    }
    const duplicateCommand = [...this.state.reviewLogs.values()].find((existing) => (
      existing.id !== reviewLog.id
      && existing.commandId !== undefined
      && existing.commandId === reviewLog.commandId
    ));
    if (duplicateCommand !== undefined) {
      throw new StudyPersistenceError(
        "conflict",
        "A review log already exists for this command.",
      );
    }
    this.state.reviewLogs.set(reviewLog.id, cloneValue(reviewLog));
  }

  private assertWritable(): void {
    if (this.mode !== "readwrite") {
      throw new StudyPersistenceError(
        "transaction",
        "A readonly study transaction cannot write records.",
      );
    }
  }
}

function stateFromSeed(seed: StudyDatabaseSeed): MemoryStudyState {
  const state: MemoryStudyState = {
    decks: new Map(),
    cards: new Map(),
    meta: new Map(),
    schedules: new Map(),
    sessions: new Map(),
    reviewLogs: new Map(),
  };
  for (const deck of seed.decks ?? []) state.decks.set(deck.id, cloneValue(deck));
  for (const card of seed.cards ?? []) state.cards.set(card.id, cloneValue(card));
  for (const record of seed.meta ?? []) state.meta.set(record.key, cloneValue(record));
  for (const schedule of seed.schedules ?? []) {
    state.schedules.set(schedule.cardId, cloneValue(schedule));
  }
  for (const session of seed.sessions ?? []) {
    state.sessions.set(session.id, cloneValue(session));
  }
  for (const reviewLog of seed.reviewLogs ?? []) {
    state.reviewLogs.set(reviewLog.id, cloneValue(reviewLog));
  }
  return state;
}

function cloneState(state: MemoryStudyState): MemoryStudyState {
  return stateFromSeed({
    decks: [...state.decks.values()],
    cards: [...state.cards.values()],
    meta: [...state.meta.values()],
    schedules: [...state.schedules.values()],
    sessions: [...state.sessions.values()],
    reviewLogs: [...state.reviewLogs.values()],
  });
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : cloneValue(value);
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("IndexedDB transaction failed."),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB transaction aborted."),
    );
  });
}

function asPersistenceError(error: unknown, message: string): StudyPersistenceError {
  if (error instanceof StudyPersistenceError) {
    return error;
  }
  const name = error instanceof DOMException ? error.name : undefined;
  return new StudyPersistenceError(
    name === "ConstraintError" ? "conflict" : "transaction",
    message,
    { cause: error },
  );
}

function requiredResult<T>(result: DomainResult<T>): T {
  if (!result.ok) {
    throw domainFailureToPersistenceError(result.error);
  }
  return result.value;
}

function optionalResult<T>(result: DomainResult<T>): T | undefined {
  if (!result.ok && result.error.code === "not-found") {
    return undefined;
  }
  return requiredResult(result);
}

function domainFailureToPersistenceError(error: DomainError): StudyPersistenceError {
  const code: StudyPersistenceErrorCode = error.code === "constraint"
    ? "conflict"
    : error.code === "open" || error.code === "migration"
      ? "open"
      : "transaction";
  return new StudyPersistenceError(code, error.message);
}
