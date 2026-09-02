import {
  PERSISTENCE_STORE_NAMES,
  type PersistenceStoreName,
} from "../domain/repositories";

/**
 * The durable database contract for the application.
 *
 * Keep this name stable: changing it would create a second database instead
 * of upgrading the user's existing data. Schema changes must increase
 * `CURRENT_SCHEMA_VERSION` and add an ordered migration for that version.
 */
export const DATABASE_NAME = "anki-web-mcp";
export const CURRENT_SCHEMA_VERSION = 2;
export const SCHEMA_VERSION_META_KEY = "schemaVersion";
/** Set only when the schema transaction creates a genuinely new database. */
export const SEED_ELIGIBLE_META_KEY = "seedEligible";

export const DATABASE_STORE_NAMES = PERSISTENCE_STORE_NAMES;

export interface SchemaIndexDefinition {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly options?: IDBIndexParameters;
}

export interface SchemaStoreDefinition {
  readonly name: PersistenceStoreName;
  readonly keyPath: string | readonly string[];
  readonly options?: IDBObjectStoreParameters;
  readonly indexes: readonly SchemaIndexDefinition[];
}

export const SCHEMA_INDEX_NAMES = {
  importsBySha256: "bySha256",
  decksByImportId: "byImportId",
  decksByName: "byName",
  decksByLastStudiedAt: "byLastStudiedAt",
  cardsByDeckId: "byDeckId",
  cardsByDeckCreationOrder: "byDeckCreationOrder",
  schedulesByDeckDueAt: "byDeckDueAt",
  schedulesByDeckStateDueAt: "byDeckStateDueAt",
  sessionsByDeckDaySequence: "byDeckDaySequence",
  sessionsByDeckDayCompletedAt: "byDeckDayCompletedAt",
  reviewLogsByCardId: "byCardId",
  reviewLogsByDeckId: "byDeckId",
  reviewLogsBySessionId: "bySessionId",
  reviewLogsByReviewedAt: "byReviewedAt",
  reviewLogsByCommandId: "byCommandId",
} as const;

const compound = (...keyPath: string[]): readonly string[] => keyPath;

/**
 * The complete current shape. Index names are implementation details; key
 * paths and uniqueness are the durable behavior that callers may rely on.
 */
export const SCHEMA_STORE_DEFINITIONS: readonly SchemaStoreDefinition[] = [
  {
    name: "meta",
    keyPath: "key",
    indexes: [],
  },
  {
    name: "imports",
    keyPath: "id",
    indexes: [
      {
        name: SCHEMA_INDEX_NAMES.importsBySha256,
        keyPath: "sha256",
        options: { unique: true },
      },
    ],
  },
  {
    name: "decks",
    keyPath: "id",
    indexes: [
      { name: SCHEMA_INDEX_NAMES.decksByImportId, keyPath: "importId" },
      { name: SCHEMA_INDEX_NAMES.decksByName, keyPath: "name" },
      {
        name: SCHEMA_INDEX_NAMES.decksByLastStudiedAt,
        keyPath: "lastStudiedAt",
      },
    ],
  },
  {
    name: "notes",
    keyPath: "id",
    indexes: [],
  },
  {
    name: "cards",
    keyPath: "id",
    indexes: [
      { name: SCHEMA_INDEX_NAMES.cardsByDeckId, keyPath: "deckId" },
      {
        name: SCHEMA_INDEX_NAMES.cardsByDeckCreationOrder,
        keyPath: compound("deckId", "creationOrder"),
      },
    ],
  },
  {
    name: "schedules",
    keyPath: "cardId",
    indexes: [
      {
        name: SCHEMA_INDEX_NAMES.schedulesByDeckDueAt,
        keyPath: compound("deckId", "dueAt"),
      },
      {
        name: SCHEMA_INDEX_NAMES.schedulesByDeckStateDueAt,
        keyPath: compound("deckId", "state", "dueAt"),
      },
    ],
  },
  {
    name: "sessions",
    keyPath: "id",
    indexes: [
      {
        name: SCHEMA_INDEX_NAMES.sessionsByDeckDaySequence,
        keyPath: compound("deckId", "dayKey", "sequence"),
        options: { unique: true },
      },
      {
        name: SCHEMA_INDEX_NAMES.sessionsByDeckDayCompletedAt,
        keyPath: compound("deckId", "dayKey", "completedAt"),
      },
    ],
  },
  {
    name: "reviewLogs",
    keyPath: "id",
    indexes: [
      { name: SCHEMA_INDEX_NAMES.reviewLogsByCardId, keyPath: "cardId" },
      { name: SCHEMA_INDEX_NAMES.reviewLogsByDeckId, keyPath: "deckId" },
      {
        name: SCHEMA_INDEX_NAMES.reviewLogsBySessionId,
        keyPath: "sessionId",
      },
      {
        name: SCHEMA_INDEX_NAMES.reviewLogsByReviewedAt,
        keyPath: "reviewedAt",
      },
      {
        name: SCHEMA_INDEX_NAMES.reviewLogsByCommandId,
        keyPath: "commandId",
        options: { unique: true },
      },
    ],
  },
  {
    name: "media",
    keyPath: compound("importId", "name"),
    indexes: [],
  },
] as const;

export interface SchemaMigrationContext {
  database: IDBDatabase;
  transaction: IDBTransaction;
  version: number;
}

export type SchemaMigration = (context: SchemaMigrationContext) => void;

/**
 * Synchronous hooks are intentionally small and test-friendly. They let a
 * caller inject a deterministic failure at a known migration boundary while
 * the native version-change transaction is still the rollback boundary.
 */
export interface SchemaMigrationHooks {
  beforeMigration?: (
    version: number,
    context: SchemaMigrationContext,
  ) => void;
  afterMigration?: (
    version: number,
    context: SchemaMigrationContext,
  ) => void;
}

export interface ApplySchemaMigrationsOptions {
  hooks?: SchemaMigrationHooks;
}

/**
 * Version 1 is the first supported shape. Version 2 reconciles indexes that
 * were added after the initial release. Keeping migrations as functions
 * indexed by version makes the upgrade order explicit and lets a fresh open
 * use the same path as a returning profile.
 */
export const SCHEMA_MIGRATIONS: ReadonlyMap<number, SchemaMigration> =
  new Map([
    [1, createVersionOneSchema],
    [2, reconcileVersionTwoSchema],
  ]);

export function applySchemaMigrations(
  database: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
  newVersion: number,
  options: ApplySchemaMigrationsOptions = {},
): void {
  for (let version = Math.max(1, oldVersion + 1); version <= newVersion; version += 1) {
    const migration = SCHEMA_MIGRATIONS.get(version);
    if (!migration) {
      throw new Error(`No persistence migration is registered for version ${version}.`);
    }

    const context = { database, transaction, version };
    options.hooks?.beforeMigration?.(version, context);
    migration(context);
    options.hooks?.afterMigration?.(version, context);
  }

  const meta = transaction.objectStore("meta");
  if (oldVersion === 0) {
    meta.put({ key: SEED_ELIGIBLE_META_KEY, value: true });
  }
  meta.put({ key: SCHEMA_VERSION_META_KEY, value: newVersion });
}

function createVersionOneSchema(context: SchemaMigrationContext): void {
  // These indexes were introduced by v2. Keeping the v1 shape explicit gives
  // the migration tests a realistic older fixture while remaining compatible
  // with databases that already contain the indexes.
  ensureSchema(context, new Set([
    SCHEMA_INDEX_NAMES.sessionsByDeckDayCompletedAt,
    SCHEMA_INDEX_NAMES.reviewLogsByCommandId,
  ]));
}

function reconcileVersionTwoSchema(context: SchemaMigrationContext): void {
  ensureSchema(context);
}

function ensureSchema(
  { database, transaction }: SchemaMigrationContext,
  omittedIndexes: ReadonlySet<string> = new Set(),
): void {
  for (const definition of SCHEMA_STORE_DEFINITIONS) {
    const store = database.objectStoreNames.contains(definition.name)
      ? transaction.objectStore(definition.name)
      : database.createObjectStore(definition.name, {
          ...definition.options,
          keyPath: toKeyPath(definition.keyPath),
        });

    for (const index of definition.indexes) {
      if (omittedIndexes.has(index.name)) {
        continue;
      }

      if (!store.indexNames.contains(index.name)) {
        store.createIndex(
          index.name,
          toKeyPath(index.keyPath),
          index.options,
        );
      }
    }
  }
}

function toKeyPath(keyPath: string | readonly string[]): string | string[] {
  return typeof keyPath === "string" ? keyPath : [...keyPath];
}

/**
 * Compatibility aliases for the session-engine transaction adapter. The
 * IndexedDB/seed foundation owns the same database and version.
 */
export const STUDY_DATABASE_NAME = DATABASE_NAME;
export const STUDY_DATABASE_VERSION = CURRENT_SCHEMA_VERSION;
export const STUDY_STORE_NAMES = PERSISTENCE_STORE_NAMES;
export type StudyStoreName = PersistenceStoreName;

export function configureStudySchema(
  database: IDBDatabase,
  transaction: IDBTransaction,
): void {
  applySchemaMigrations(
    database,
    transaction,
    0,
    CURRENT_SCHEMA_VERSION,
  );
}
