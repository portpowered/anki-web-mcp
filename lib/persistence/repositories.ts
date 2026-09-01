import {
  domainError,
  failure,
  mapDatabaseError,
  success,
  type DomainResult,
} from "../domain/errors";
import type {
  CardRecord,
  DeckRecord,
  ImportRecord,
  MediaRecord,
  MetaRecord,
  NoteRecord,
  ReviewLogRecord,
  ScheduleRecord,
  SessionRecord,
} from "../domain/entities";
import type {
  CardRepository,
  DeckRepository,
  ImportRepository,
  MediaKey,
  MediaRepository,
  PersistenceStoreName,
  RecordRepository,
  RepositorySet,
  RepositoryTransactionContext,
  ReviewLogRepository,
  ScheduleRepository,
  SessionRepository,
} from "../domain/repositories";
import { SCHEMA_INDEX_NAMES } from "./schema";

/**
 * The native transaction is deliberately created by the caller for an
 * atomic multi-store operation. Repositories only borrow it and never open a
 * second transaction when a context is supplied.
 */
export function createRepositoryTransactionContext(
  transaction: IDBTransaction,
  stores: readonly PersistenceStoreName[],
): RepositoryTransactionContext {
  return {
    mode: transaction.mode === "readonly" ? "readonly" : "readwrite",
    stores: [...stores],
    nativeTransaction: transaction,
  };
}

export interface IndexedDbRepositorySet extends RepositorySet {
  imports: ImportRepository;
  decks: DeckRepository;
  cards: CardRepository;
  schedules: ScheduleRepository;
  sessions: SessionRepository;
  reviewLogs: ReviewLogRepository;
  media: MediaRepository;
}

/** Create repository adapters over an already-open production database. */
export function createRepositories(
  database: IDBDatabase,
): IndexedDbRepositorySet {
  return {
    meta: new IndexedDbRecordRepository<MetaRecord, string>(database, "meta"),
    imports: new IndexedDbImportRepository(database),
    decks: new IndexedDbDeckRepository(database),
    notes: new IndexedDbRecordRepository<NoteRecord, string>(database, "notes"),
    cards: new IndexedDbCardRepository(database),
    schedules: new IndexedDbScheduleRepository(database),
    sessions: new IndexedDbSessionRepository(database),
    reviewLogs: new IndexedDbReviewLogRepository(database),
    media: new IndexedDbMediaRepository(database),
  };
}

export const createIndexedDbRepositories = createRepositories;

interface RepositoryTransaction {
  transaction: IDBTransaction;
  ownsTransaction: boolean;
}

type RequestFactory = (store: IDBObjectStore) => IDBRequest<unknown>;
type ResultMapper<Result> = (value: unknown) => DomainResult<Result>;

class IndexedDbRecordRepository<Record, Key>
  implements RecordRepository<Record, Key>
{
  constructor(
    protected readonly database: IDBDatabase,
    protected readonly storeName: PersistenceStoreName,
  ) {}

  get(
    key: Key,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<Record>> {
    return this.runRequest(
      context,
      "readonly",
      (store) => store.get(toIndexedDbKey(key)),
      (value) => value === undefined
        ? notFound(this.storeName, key)
        : success(value as Record),
    );
  }

  list(
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<Record[]>> {
    return this.runRequest(
      context,
      "readonly",
      (store) => store.getAll() as unknown as IDBRequest<unknown>,
      (value) => success((value as Record[]) ?? []),
    );
  }

  add(
    record: Record,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<Record>> {
    return this.runRequest(
      context,
      "readwrite",
      (store) => store.add(record) as unknown as IDBRequest<unknown>,
      () => success(record),
    );
  }

  put(
    record: Record,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<Record>> {
    return this.runRequest(
      context,
      "readwrite",
      (store) => store.put(record) as unknown as IDBRequest<unknown>,
      () => success(record),
    );
  }

  delete(
    key: Key,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<void>> {
    const transactionResult = this.acquireTransaction(context, "readwrite");
    if (!transactionResult.ok) {
      return Promise.resolve(transactionResult);
    }

    const { transaction, ownsTransaction } = transactionResult.value;
    let store: IDBObjectStore;
    try {
      store = transaction.objectStore(this.storeName);
    } catch (cause) {
      return Promise.resolve(this.databaseFailure(cause, key));
    }

    const deleteRequest: Promise<boolean> = requestToPromise<unknown>(
      store.get(toIndexedDbKey(key)) as unknown as IDBRequest<unknown>,
    ).then((existing) => {
      if (existing === undefined) {
        return false;
      }

      return requestToPromise<undefined>(
        store.delete(toIndexedDbKey(key)),
      ).then(() => true);
    });

    if (!ownsTransaction) {
      return deleteRequest
        .then<DomainResult<void>>((deleted) => deleted
          ? success<void>(undefined)
          : notFound<void>(this.storeName, key))
        .catch((cause): DomainResult<void> => this.databaseFailure(cause, key));
    }

    return Promise.all([
      deleteRequest,
      transactionToPromise(transaction),
    ])
      .then<DomainResult<void>>(([deleted]) => deleted
        ? success<void>(undefined)
        : notFound<void>(this.storeName, key))
      .catch((cause): DomainResult<void> => this.databaseFailure(cause, key));
  }

  protected runRequest<Result>(
    context: RepositoryTransactionContext | undefined,
    mode: "readonly" | "readwrite",
    requestFactory: RequestFactory,
    mapResult: ResultMapper<Result>,
  ): Promise<DomainResult<Result>> {
    const transactionResult = this.acquireTransaction(context, mode);
    if (!transactionResult.ok) {
      return Promise.resolve(transactionResult);
    }

    const { transaction, ownsTransaction } = transactionResult.value;
    let request: IDBRequest<unknown>;
    try {
      request = requestFactory(transaction.objectStore(this.storeName));
    } catch (cause) {
      return Promise.resolve(this.databaseFailure(cause));
    }

    const requestResult = requestToPromise(request);
    if (!ownsTransaction) {
      return requestResult
        .then(mapResult)
        .catch((cause) => this.databaseFailure(cause));
    }

    return Promise.all([
      requestResult,
      transactionToPromise(transaction),
    ])
      .then(([value]) => mapResult(value))
      .catch((cause) => this.databaseFailure(cause));
  }

  protected listByIndex<RecordValue>(
    indexName: string,
    query: IDBValidKey | IDBKeyRange | undefined,
    context: RepositoryTransactionContext | undefined,
    predicate: (record: RecordValue) => boolean = () => true,
    compare: (left: RecordValue, right: RecordValue) => number = () => 0,
  ): Promise<DomainResult<RecordValue[]>> {
    return this.runRequest(
      context,
      "readonly",
      (store) => {
        const index = store.index(indexName);
        const request = query === undefined ? index.getAll() : index.getAll(query);
        return request as unknown as IDBRequest<unknown>;
      },
      (value) => {
        const records = ((value as RecordValue[]) ?? [])
          .filter(predicate)
          .sort(compare);
        return success(records);
      },
    );
  }

  protected getByIndex<RecordValue>(
    indexName: string,
    query: IDBValidKey | IDBKeyRange,
    context: RepositoryTransactionContext | undefined,
    key: string,
  ): Promise<DomainResult<RecordValue>> {
    return this.runRequest(
      context,
      "readonly",
      (store) => store.index(indexName).get(query),
      (value) => value === undefined
        ? notFound(this.storeName, key)
        : success(value as RecordValue),
    );
  }

  private acquireTransaction(
    context: RepositoryTransactionContext | undefined,
    mode: "readonly" | "readwrite",
  ): DomainResult<RepositoryTransaction> {
    if (context) {
      if (!context.stores.includes(this.storeName)) {
        return failure(domainError(
          "validation",
          "The repository transaction does not include the requested store.",
          { resource: this.storeName },
        ));
      }

      if (mode === "readwrite" && context.mode !== "readwrite") {
        return failure(domainError(
          "validation",
          "A read-write repository operation requires a read-write transaction.",
          { resource: this.storeName },
        ));
      }

      if (!isNativeTransaction(context.nativeTransaction)) {
        return failure(domainError(
          "validation",
          "The repository transaction context has no usable native transaction.",
          { resource: this.storeName },
        ));
      }

      return success({
        transaction: context.nativeTransaction,
        ownsTransaction: false,
      });
    }

    try {
      return success({
        transaction: this.database.transaction(this.storeName, mode),
        ownsTransaction: true,
      });
    } catch (cause) {
      return this.databaseFailure(cause);
    }
  }

  private databaseFailure(
    cause: unknown,
    key?: unknown,
  ): DomainResult<never> {
    return failure(mapDatabaseError(cause, "storage", {
      resource: this.storeName,
      ...(key === undefined ? {} : { key: keyForError(key) }),
    }));
  }
}

class IndexedDbImportRepository
  extends IndexedDbRecordRepository<ImportRecord, string>
  implements ImportRepository
{
  constructor(database: IDBDatabase) {
    super(database, "imports");
  }

  findBySha256(
    sha256: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ImportRecord>> {
    return this.getByIndex<ImportRecord>(
      SCHEMA_INDEX_NAMES.importsBySha256,
      sha256,
      context,
      sha256,
    );
  }
}

class IndexedDbDeckRepository
  extends IndexedDbRecordRepository<DeckRecord, string>
  implements DeckRepository
{
  constructor(database: IDBDatabase) {
    super(database, "decks");
  }

  listByImportId(
    importId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<DeckRecord[]>> {
    return this.listByIndex<DeckRecord>(
      SCHEMA_INDEX_NAMES.decksByImportId,
      importId,
      context,
      (deck) => deck.importId === importId,
      compareById,
    );
  }
}

class IndexedDbCardRepository
  extends IndexedDbRecordRepository<CardRecord, string>
  implements CardRepository
{
  constructor(database: IDBDatabase) {
    super(database, "cards");
  }

  listByDeckId(
    deckId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<CardRecord[]>> {
    return this.listByIndex<CardRecord>(
      SCHEMA_INDEX_NAMES.cardsByDeckCreationOrder,
      compoundRange(deckId),
      context,
      (card) => card.deckId === deckId,
      compareCards,
    );
  }
}

class IndexedDbScheduleRepository
  extends IndexedDbRecordRepository<ScheduleRecord, string>
  implements ScheduleRepository
{
  constructor(database: IDBDatabase) {
    super(database, "schedules");
  }

  listDue(
    deckId: string,
    dueAt: number,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ScheduleRecord[]>> {
    return this.listByIndex<ScheduleRecord>(
      SCHEMA_INDEX_NAMES.schedulesByDeckDueAt,
      compoundRange(deckId, dueAt),
      context,
      (schedule) => schedule.deckId === deckId && schedule.dueAt <= dueAt,
      compareSchedules,
    );
  }
}

class IndexedDbSessionRepository
  extends IndexedDbRecordRepository<SessionRecord, string>
  implements SessionRepository
{
  constructor(database: IDBDatabase) {
    super(database, "sessions");
  }

  listByDeckDay(
    deckId: string,
    dayKey: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<SessionRecord[]>> {
    return this.listByIndex<SessionRecord>(
      SCHEMA_INDEX_NAMES.sessionsByDeckDaySequence,
      compoundRange(deckId, dayKey),
      context,
      (session) => session.deckId === deckId && session.dayKey === dayKey,
      compareSessions,
    );
  }

  findLatestIncomplete(
    deckId: string,
    dayKey: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<SessionRecord>> {
    return this.listByIndex<SessionRecord>(
      SCHEMA_INDEX_NAMES.sessionsByDeckDayCompletedAt,
      compoundOnly(deckId, dayKey, null),
      context,
      (session) => session.deckId === deckId
        && session.dayKey === dayKey
        && session.completedAt === null,
      (left, right) => compareSessions(right, left),
    ).then((result) => {
      if (!result.ok) {
        return result;
      }
      const [latest] = result.value;
      return latest === undefined
        ? notFound("sessions", `${deckId}/${dayKey}/incomplete`)
        : success(latest);
    });
  }
}

class IndexedDbReviewLogRepository
  extends IndexedDbRecordRepository<ReviewLogRecord, string>
  implements ReviewLogRepository
{
  constructor(database: IDBDatabase) {
    super(database, "reviewLogs");
  }

  listByCardId(
    cardId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ReviewLogRecord[]>> {
    return this.listByExactIndex(
      SCHEMA_INDEX_NAMES.reviewLogsByCardId,
      cardId,
      context,
      (left, right) => compareNumbersThenId(left.reviewedAt, right.reviewedAt, left.id, right.id),
    );
  }

  listByDeckId(
    deckId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ReviewLogRecord[]>> {
    return this.listByExactIndex(
      SCHEMA_INDEX_NAMES.reviewLogsByDeckId,
      deckId,
      context,
      (left, right) => compareNumbersThenId(left.reviewedAt, right.reviewedAt, left.id, right.id),
    );
  }

  listBySessionId(
    sessionId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ReviewLogRecord[]>> {
    return this.listByExactIndex(
      SCHEMA_INDEX_NAMES.reviewLogsBySessionId,
      sessionId,
      context,
      (left, right) => compareNumbersThenId(left.reviewedAt, right.reviewedAt, left.id, right.id),
    );
  }

  listByReviewedAt(
    reviewedAt: number,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ReviewLogRecord[]>> {
    return this.listByExactIndex(
      SCHEMA_INDEX_NAMES.reviewLogsByReviewedAt,
      reviewedAt,
      context,
      compareById,
    );
  }

  private listByExactIndex(
    indexName: string,
    key: IDBValidKey,
    context: RepositoryTransactionContext | undefined,
    compare: (left: ReviewLogRecord, right: ReviewLogRecord) => number,
  ): Promise<DomainResult<ReviewLogRecord[]>> {
    return this.listByIndex<ReviewLogRecord>(
      indexName,
      key,
      context,
      () => true,
      compare,
    );
  }
}

class IndexedDbMediaRepository
  extends IndexedDbRecordRepository<MediaRecord, MediaKey>
  implements MediaRepository
{
  constructor(database: IDBDatabase) {
    super(database, "media");
  }

  listByImportId(
    importId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<MediaRecord[]>> {
    return this.list(context).then((result) => {
      if (!result.ok) {
        return result;
      }
      return success(result.value
        .filter((media) => media.importId === importId)
        .sort(compareMedia));
    });
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new DOMException("IndexedDB request failed.", "UnknownError"),
    );
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
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

function isNativeTransaction(value: unknown): value is IDBTransaction {
  return typeof value === "object"
    && value !== null
    && "objectStore" in value
    && typeof (value as { objectStore?: unknown }).objectStore === "function";
}

function toIndexedDbKey(key: unknown): IDBValidKey {
  return key as IDBValidKey;
}

function notFound<Result>(resource: string, key: unknown): DomainResult<Result> {
  return failure(domainError(
    "not-found",
    "The requested record was not found.",
    { resource, key: keyForError(key) },
  ));
}

function keyForError(key: unknown): string {
  return typeof key === "string" ? key : JSON.stringify(key) ?? String(key);
}

function compoundRange(
  deckId: string,
  secondValue?: string | number,
): IDBKeyRange | undefined {
  if (typeof IDBKeyRange === "undefined") {
    return undefined;
  }

  const lower = secondValue === undefined
    ? [deckId, -Number.MAX_VALUE]
    : typeof secondValue === "string"
      ? [deckId, secondValue, -Number.MAX_VALUE]
      : [deckId, -Number.MAX_VALUE];
  const upper = secondValue === undefined
    ? [deckId, Number.MAX_VALUE]
    : typeof secondValue === "string"
      ? [deckId, secondValue, Number.MAX_VALUE]
      : [deckId, secondValue];

  return IDBKeyRange.bound(lower, upper);
}

function compoundOnly(
  deckId: string,
  dayKey: string,
  completedAt: number | null,
): IDBKeyRange | IDBValidKey {
  return typeof IDBKeyRange === "undefined"
    ? [deckId, dayKey, completedAt] as unknown as IDBValidKey
    : IDBKeyRange.only([deckId, dayKey, completedAt]);
}

function compareCards(left: CardRecord, right: CardRecord): number {
  return compareNumbersThenId(
    left.creationOrder,
    right.creationOrder,
    left.id,
    right.id,
  );
}

function compareSchedules(left: ScheduleRecord, right: ScheduleRecord): number {
  return compareNumbersThenId(left.dueAt, right.dueAt, left.cardId, right.cardId);
}

function compareSessions(left: SessionRecord, right: SessionRecord): number {
  return compareNumbersThenId(left.sequence, right.sequence, left.id, right.id);
}

function compareMedia(left: MediaRecord, right: MediaRecord): number {
  return left.importId < right.importId
    ? -1
    : left.importId > right.importId
      ? 1
      : left.name < right.name
        ? -1
        : left.name > right.name
          ? 1
          : 0;
}

function compareById(
  left: { id: string },
  right: { id: string },
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareNumbersThenId(
  leftNumber: number,
  rightNumber: number,
  leftId: string,
  rightId: string,
): number {
  return leftNumber - rightNumber || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
}
