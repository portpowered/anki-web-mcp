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
} from "./entities";
import type { DomainResult } from "./errors";

export const PERSISTENCE_STORE_NAMES = [
  "meta",
  "imports",
  "decks",
  "notes",
  "cards",
  "schedules",
  "sessions",
  "reviewLogs",
  "media",
] as const;

export type PersistenceStoreName = (typeof PERSISTENCE_STORE_NAMES)[number];
export type MediaKey = readonly [importId: string, name: string];

/**
 * Opaque transaction information passed from an infrastructure adapter. The
 * domain contract describes the required scope without importing DOM types.
 */
export interface RepositoryTransactionContext {
  mode: "readonly" | "readwrite";
  stores: readonly PersistenceStoreName[];
  nativeTransaction?: unknown;
}

export interface RecordRepository<Record, Key> {
  get(key: Key, context?: RepositoryTransactionContext): Promise<DomainResult<Record>>;
  list(context?: RepositoryTransactionContext): Promise<DomainResult<Record[]>>;
  add(record: Record, context?: RepositoryTransactionContext): Promise<DomainResult<Record>>;
  put(record: Record, context?: RepositoryTransactionContext): Promise<DomainResult<Record>>;
  delete(key: Key, context?: RepositoryTransactionContext): Promise<DomainResult<void>>;
}

export type MetaRepository = RecordRepository<MetaRecord, string>;
export interface ImportRepository
  extends RecordRepository<ImportRecord, string> {
  findBySha256(
    sha256: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ImportRecord>>;
}

export interface DeckRepository extends RecordRepository<DeckRecord, string> {
  listByImportId(
    importId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<DeckRecord[]>>;
}

export type NoteRepository = RecordRepository<NoteRecord, string>;

export interface CardRepository extends RecordRepository<CardRecord, string> {
  listByDeckId(
    deckId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<CardRecord[]>>;
}

export interface ScheduleRepository
  extends RecordRepository<ScheduleRecord, string> {
  listDue(
    deckId: string,
    dueAt: number,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ScheduleRecord[]>>;
}

export interface SessionRepository
  extends RecordRepository<SessionRecord, string> {
  listByDeckDay(
    deckId: string,
    dayKey: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<SessionRecord[]>>;
  findLatestIncomplete(
    deckId: string,
    dayKey: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<SessionRecord>>;
}

export interface ReviewLogRepository
  extends RecordRepository<ReviewLogRecord, string> {
  listByCardId(
    cardId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ReviewLogRecord[]>>;
  listByDeckId(
    deckId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ReviewLogRecord[]>>;
  listBySessionId(
    sessionId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ReviewLogRecord[]>>;
  listByReviewedAt(
    reviewedAt: number,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<ReviewLogRecord[]>>;
}

export interface MediaRepository
  extends RecordRepository<MediaRecord, MediaKey> {
  listByImportId(
    importId: string,
    context?: RepositoryTransactionContext,
  ): Promise<DomainResult<MediaRecord[]>>;
}

export interface RepositorySet {
  meta: MetaRepository;
  imports: ImportRepository;
  decks: DeckRepository;
  notes: NoteRepository;
  cards: CardRepository;
  schedules: ScheduleRepository;
  sessions: SessionRepository;
  reviewLogs: ReviewLogRepository;
  media: MediaRepository;
}

/**
 * The stores that participate in one committed study-state change.
 *
 * This contract intentionally contains complete records rather than patches.
 * A future study service owns the scheduler and supplies the next values; the
 * persistence boundary only verifies and commits the supplied values.
 */
export const STUDY_STATE_TRANSACTION_STORES = [
  "schedules",
  "reviewLogs",
  "sessions",
  "decks",
] as const;

export type StudyStateTransactionStoreName =
  (typeof STUDY_STATE_TRANSACTION_STORES)[number];

export const STUDY_STATE_WRITE_POSITIONS = [
  "schedule",
  "reviewLog",
  "session",
  "deck",
] as const;

export type StudyStateWritePosition = (typeof STUDY_STATE_WRITE_POSITIONS)[number];

export interface StudyStateChanges {
  schedule: ScheduleRecord;
  reviewLog: ReviewLogRecord;
  session: SessionRecord;
  deck: DeckRecord;
}

/**
 * Testable seams for proving that every write is still inside the same native
 * transaction. Hooks are synchronous on purpose: throwing from one aborts the
 * transaction before the next write is queued.
 */
export interface StudyStateTransactionHooks {
  beforeWrite?: (
    position: StudyStateWritePosition,
    changes: StudyStateChanges,
  ) => void;
  afterWrite?: (
    position: StudyStateWritePosition,
    changes: StudyStateChanges,
  ) => void;
}

export interface StudyStateTransactionOptions {
  hooks?: StudyStateTransactionHooks;
  /** Convenience fault injection for deterministic rollback tests. */
  failureAt?: StudyStateWritePosition;
}

export interface StudyStateTransactionCoordinator {
  commit(
    changes: StudyStateChanges,
    options?: StudyStateTransactionOptions,
  ): Promise<DomainResult<StudyStateChanges>>;
}
