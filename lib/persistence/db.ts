import type {
  CardRecord,
  DeckRecord,
  MetaRecord,
  ReviewLogRecord,
  ScheduleRecord,
  SessionRecord,
} from "../domain/entities";
import {
  configureStudySchema,
  STUDY_DATABASE_NAME,
  STUDY_DATABASE_VERSION,
  type StudyStoreName,
} from "./schema";

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
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (factory === undefined) {
    return Promise.reject(new StudyPersistenceError(
      "unavailable",
      "IndexedDB is not available in this environment.",
    ));
  }

  const name = options.name ?? STUDY_DATABASE_NAME;
  const version = options.version ?? STUDY_DATABASE_VERSION;

  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, version);
    } catch (error) {
      reject(new StudyPersistenceError(
        "open",
        "Unable to open the study database.",
        { cause: error },
      ));
      return;
    }

    request.onupgradeneeded = () => {
      try {
        if (request.transaction === null) {
          throw new Error("IndexedDB did not provide an upgrade transaction.");
        }
        configureStudySchema(request.result, request.transaction);
      } catch (error) {
        try {
          request.transaction?.abort();
        } catch {
          // The open request reports the original upgrade failure.
        }
        reject(new StudyPersistenceError(
          "open",
          "Unable to migrate the study database schema.",
          { cause: error },
        ));
      }
    };
    request.onsuccess = () => resolve(new IndexedDbStudyDatabase(request.result));
    request.onerror = () => reject(new StudyPersistenceError(
      "open",
      "Unable to open the study database.",
      { cause: request.error ?? undefined },
    ));
    request.onblocked = () => reject(new StudyPersistenceError(
      "open",
      "The study database upgrade is blocked by another open connection.",
    ));
  });
}

/** Short alias used by application composition roots. */
export const openStudyDatabase = openIndexedDbStudyDatabase;

export class IndexedDbStudyDatabase implements StudyDatabase {
  constructor(readonly db: IDBDatabase) {}

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
      const result = await work(new IndexedDbTransaction(nativeTransaction));
      await completion;
      return result;
    } catch (error) {
      try {
        nativeTransaction.abort();
      } catch {
        // It may already have aborted or completed; preserve the useful error.
      }
      await completion.catch(() => undefined);
      throw error;
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

class IndexedDbTransaction implements StudyTransaction {
  constructor(private readonly transaction: IDBTransaction) {}

  getDeck(deckId: string): Promise<DeckRecord | undefined> {
    return this.get("decks", deckId);
  }

  getCard(cardId: string): Promise<CardRecord | undefined> {
    return this.get("cards", cardId);
  }

  getSchedule(cardId: string): Promise<ScheduleRecord | undefined> {
    return this.get("schedules", cardId);
  }

  getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.get("sessions", sessionId);
  }

  getMeta(key: string): Promise<MetaRecord | undefined> {
    return this.get("meta", key);
  }

  getReviewLog(reviewLogId: string): Promise<ReviewLogRecord | undefined> {
    return this.get("reviewLogs", reviewLogId);
  }

  async getReviewLogByCommandId(commandId: string): Promise<ReviewLogRecord | undefined> {
    const logs = await this.getByIndex<ReviewLogRecord>(
      "reviewLogs",
      "byCommandId",
      commandId,
      (value) => value.commandId === commandId,
    );
    return logs[0];
  }

  listCards(deckId: string): Promise<CardRecord[]> {
    return this.getByIndex("cards", "byDeckId", deckId, (value) => value.deckId === deckId);
  }

  listSchedules(deckId: string): Promise<ScheduleRecord[]> {
    return this.getByIndex(
      "schedules",
      "byDeckId",
      deckId,
      (value) => value.deckId === deckId,
    );
  }

  listSessions(deckId: string): Promise<SessionRecord[]> {
    return this.getByIndex(
      "sessions",
      "byDeckId",
      deckId,
      (value) => value.deckId === deckId,
    );
  }

  putDeck(deck: DeckRecord): Promise<void> {
    return this.put("decks", deck);
  }

  putCard(card: CardRecord): Promise<void> {
    return this.put("cards", card);
  }

  putSchedule(schedule: ScheduleRecord): Promise<void> {
    return this.put("schedules", schedule);
  }

  putSession(session: SessionRecord): Promise<void> {
    return this.put("sessions", session);
  }

  putMeta(record: MetaRecord): Promise<void> {
    return this.put("meta", record);
  }

  putReviewLog(reviewLog: ReviewLogRecord): Promise<void> {
    return this.put("reviewLogs", reviewLog);
  }

  private get<T>(storeName: StudyStoreName, key: IDBValidKey): Promise<T | undefined> {
    return requestToPromise<T | undefined>(this.transaction.objectStore(storeName).get(key));
  }

  private async getByIndex<T>(
    storeName: StudyStoreName,
    indexName: string,
    key: IDBValidKey,
    fallback: (value: T) => boolean,
  ): Promise<T[]> {
    const store = this.transaction.objectStore(storeName);
    if (store.indexNames.contains(indexName)) {
      return requestToPromise<T[]>(store.index(indexName).getAll(key));
    }
    return (await requestToPromise<T[]>(store.getAll())).filter(fallback);
  }

  private put<T>(storeName: StudyStoreName, value: T): Promise<void> {
    return requestToPromise(this.transaction.objectStore(storeName).put(value)).then(
      () => undefined,
    );
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

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
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
