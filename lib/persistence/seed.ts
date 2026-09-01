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
  MetaRecord,
  NoteRecord,
  ScheduleRecord,
} from "../domain/entities";
import type { Clock } from "../domain/ports";
import type { ScheduleInitializer } from "../domain/scheduler";
import type {
  RepositorySet,
} from "../domain/repositories";
import { NeutralScheduleInitializer } from "../domain/scheduler";
import { systemClock } from "../platform/clock";
import {
  openDatabaseWithInfo,
  type OpenDatabaseOptions,
} from "./database";
import {
  createRepositories,
  createRepositoryTransactionContext,
} from "./repositories";
import {
  DATABASE_NAME,
  SEED_ELIGIBLE_META_KEY,
} from "./schema";
import {
  SPANISH_BASICS_FIXTURE,
  SPANISH_BASICS_FIXTURE_VERSION,
  type SpanishBasicsFixtureEntry,
} from "./spanish-basics-fixture";

export const SEED_IMPORT_ID = "seed";
export const SPANISH_BASICS_DECK_ID = "seed-spanish-basics";
export const SPANISH_BASICS_DECK_NAME = "Spanish Basics";
export const SPANISH_BASICS_SEED_VERSION = SPANISH_BASICS_FIXTURE_VERSION;
export const SEED_INSTALLED_META_KEY = "seedInstalled";
export const SEED_VERSION_META_KEY = "seedVersion";

export const SEED_TRANSACTION_STORES = [
  "meta",
  "decks",
  "notes",
  "cards",
  "schedules",
] as const;

export const SEED_WRITE_POSITIONS = [
  "deck",
  "note",
  "card",
  "schedule",
  "seedInstalled",
  "seedVersion",
] as const;

export type SeedWritePosition = (typeof SEED_WRITE_POSITIONS)[number];

export interface SeedInstallation {
  readonly deck: DeckRecord;
  readonly notes: readonly NoteRecord[];
  readonly cards: readonly CardRecord[];
  readonly schedules: readonly ScheduleRecord[];
}

export interface SeedInitialization {
  /** True only for the call that wrote the seed graph and markers. */
  readonly installed: boolean;
  readonly seedVersion: number;
  /** Null when the durable marker made installation unnecessary. */
  readonly installation: SeedInstallation | null;
}

export interface SeedTransactionHooks {
  beforeWrite?: (
    position: SeedWritePosition,
    index: number | undefined,
    installation: SeedInstallation,
  ) => void;
  afterWrite?: (
    position: SeedWritePosition,
    index: number | undefined,
    installation: SeedInstallation,
  ) => void;
}

export interface SeedDatabaseOptions {
  clock?: Clock;
  scheduleInitializer?: ScheduleInitializer;
  repositories?: RepositorySet;
  hooks?: SeedTransactionHooks;
  /** Convenience fault injection for deterministic rollback tests. */
  failureAt?: SeedWritePosition;
  /** The seeded open wrapper sets this false for an existing database. */
  allowInstallation?: boolean;
}

export interface SeededDatabase {
  readonly database: IDBDatabase;
  readonly seed: SeedInitialization;
}

export interface OpenDatabaseWithSeedOptions extends OpenDatabaseOptions {
  seed?: SeedDatabaseOptions;
}

export type OpenDatabaseWithSeedResult = DomainResult<SeededDatabase>;

/**
 * Install the bundled graph through one transaction. Callers that already
 * own an opened database may use this function directly; the seeded open
 * wrapper below supplies the new-database eligibility information.
 */
export function initializeSpanishBasicsSeed(
  database: IDBDatabase,
  options: SeedDatabaseOptions = {},
): Promise<DomainResult<SeedInitialization>> {
  return withSeedLock(database.name || DATABASE_NAME, () =>
    executeSeedInstallation(database, options));
}

export const installSpanishBasicsSeed = initializeSpanishBasicsSeed;
export const seedDatabase = initializeSpanishBasicsSeed;

/**
 * Application-facing open boundary: schema creation/upgrades happen first,
 * and only a genuinely new database is eligible for automatic installation.
 * Reopens still inspect the durable marker so a removed seed never returns.
 */
export async function openDatabaseWithSeed(
  options: OpenDatabaseWithSeedOptions = {},
): Promise<OpenDatabaseWithSeedResult> {
  const opened = await openDatabaseWithInfo(options);
  if (!opened.ok) {
    return opened;
  }

  const database = opened.value.database;
  const eligibility = opened.value.created
    ? success(true)
    : await readSeedEligibility(database, options.seed?.repositories);
  if (!eligibility.ok) {
    database.close();
    return eligibility;
  }

  const seed = await initializeSpanishBasicsSeed(database, {
    ...options.seed,
    allowInstallation: eligibility.value,
  });

  if (!seed.ok) {
    database.close();
    return seed;
  }

  return success({ database, seed: seed.value });
}

export const openPersistenceDatabaseWithSeed = openDatabaseWithSeed;
export const openAndSeedDatabase = openDatabaseWithSeed;
export const openDatabaseAndSeed = openDatabaseWithSeed;

/**
 * Validate the fixture at the domain boundary as a defense against future
 * accidental unsafe additions. The current fixture is deliberately plain
 * text, but this keeps the seed contract caller-handleable if it changes.
 */
export function validateSpanishBasicsFixture(
  fixture: readonly SpanishBasicsFixtureEntry[] = SPANISH_BASICS_FIXTURE,
): DomainResult<readonly SpanishBasicsFixtureEntry[]> {
  if (fixture.length < 20) {
    return failure(domainError(
      "validation",
      "The Spanish Basics seed must contain at least 20 cards.",
      { resource: "seed" },
    ));
  }

  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const entry of fixture) {
    if (
      entry.id.length === 0
      || entry.front.length === 0
      || entry.back.length === 0
      || ids.has(entry.id)
      || pairs.has(`${entry.front}\u0000${entry.back}`)
      || !isSafeSeedText(entry.front)
      || !isSafeSeedText(entry.back)
    ) {
      return failure(domainError(
        "validation",
        "The Spanish Basics seed contains an invalid or unsafe card.",
        { resource: "seed", key: entry.id },
      ));
    }

    ids.add(entry.id);
    pairs.add(`${entry.front}\u0000${entry.back}`);
  }

  return success(fixture);
}

export function buildSpanishBasicsInstallation(
  clock: Clock = systemClock,
  scheduleInitializer: ScheduleInitializer = new NeutralScheduleInitializer(clock),
  fixture: readonly SpanishBasicsFixtureEntry[] = SPANISH_BASICS_FIXTURE,
): DomainResult<SeedInstallation> {
  const validFixture = validateSpanishBasicsFixture(fixture);
  if (!validFixture.ok) {
    return validFixture;
  }

  let createdAt: number;
  try {
    createdAt = clock.now();
  } catch (cause) {
    return failure(mapDatabaseError(cause, "validation", { resource: "seed" }));
  }

  const notes = validFixture.value.map((entry) => createNote(entry));
  const cards = validFixture.value.map((entry, index) =>
    createCard(entry, notes[index]!, index));
  const schedules = cards.map((card) =>
    scheduleInitializer.initializeNewCard({
      cardId: card.id,
      deckId: SPANISH_BASICS_DECK_ID,
      createdAt,
    }));

  return success({
    deck: {
      id: SPANISH_BASICS_DECK_ID,
      importId: SEED_IMPORT_ID,
      sourceDeckId: null,
      name: SPANISH_BASICS_DECK_NAME,
      cardCount: cards.length,
      createdAt,
      lastStudiedAt: null,
      sessionIntakeLimit: 20,
      schedulerConfigId: "neutral-v1",
    },
    notes,
    cards,
    schedules,
  });
}

async function executeSeedInstallation(
  database: IDBDatabase,
  options: SeedDatabaseOptions,
): Promise<DomainResult<SeedInitialization>> {
  const repositories = options.repositories ?? createRepositories(database);
  let transaction: IDBTransaction;

  try {
    transaction = database.transaction([...SEED_TRANSACTION_STORES], "readwrite");
  } catch (cause) {
    return transactionFailure(cause);
  }

  const completion = waitForTransaction(transaction);
  const context = createRepositoryTransactionContext(
    transaction,
    [...SEED_TRANSACTION_STORES],
  );

  try {
    const marker = await repositories.meta.get(SEED_INSTALLED_META_KEY, context);
    if (!marker.ok && marker.error.code !== "not-found") {
      await abortAndSettle(transaction, completion);
      return marker;
    }

    if (marker.ok && marker.value.value === true) {
      await completion;
      return success({
        installed: false,
        seedVersion: SPANISH_BASICS_SEED_VERSION,
        installation: null,
      });
    }

    if (options.allowInstallation === false) {
      await completion;
      return success({
        installed: false,
        seedVersion: SPANISH_BASICS_SEED_VERSION,
        installation: null,
      });
    }

    const installation = buildSpanishBasicsInstallation(
      options.clock,
      options.scheduleInitializer,
    );
    if (!installation.ok) {
      await abortAndSettle(transaction, completion);
      return installation;
    }

    const graph = installation.value;

    const deckWrite = await writeRecord(
      "deck",
      undefined,
      graph,
      options,
      () => repositories.decks.add(graph.deck, context),
    );
    if (!deckWrite.ok) {
      await abortAndSettle(transaction, completion);
      return deckWrite;
    }

    for (const [index, note] of graph.notes.entries()) {
      const noteWrite = await writeRecord(
        "note",
        index,
        graph,
        options,
        () => repositories.notes.add(note, context),
      );
      if (!noteWrite.ok) {
        await abortAndSettle(transaction, completion);
        return noteWrite;
      }
    }

    for (const [index, card] of graph.cards.entries()) {
      const cardWrite = await writeRecord(
        "card",
        index,
        graph,
        options,
        () => repositories.cards.add(card, context),
      );
      if (!cardWrite.ok) {
        await abortAndSettle(transaction, completion);
        return cardWrite;
      }
    }

    for (const [index, schedule] of graph.schedules.entries()) {
      const scheduleWrite = await writeRecord(
        "schedule",
        index,
        graph,
        options,
        () => repositories.schedules.add(schedule, context),
      );
      if (!scheduleWrite.ok) {
        await abortAndSettle(transaction, completion);
        return scheduleWrite;
      }
    }

    const installedMarkerWrite = await writeRecord(
      "seedInstalled",
      undefined,
      graph,
      options,
      () => repositories.meta.put(seedInstalledRecord(), context),
    );
    if (!installedMarkerWrite.ok) {
      await abortAndSettle(transaction, completion);
      return installedMarkerWrite;
    }

    const versionMarkerWrite = await writeRecord(
      "seedVersion",
      undefined,
      graph,
      options,
      () => repositories.meta.put(seedVersionRecord(), context),
    );
    if (!versionMarkerWrite.ok) {
      await abortAndSettle(transaction, completion);
      return versionMarkerWrite;
    }

    await completion;
    return success({
      installed: true,
      seedVersion: SPANISH_BASICS_SEED_VERSION,
      installation: graph,
    });
  } catch (cause) {
    await abortAndSettle(transaction, completion);
    return transactionFailure(cause);
  }
}

async function readSeedEligibility(
  database: IDBDatabase,
  repositories = createRepositories(database),
): Promise<DomainResult<boolean>> {
  const marker = await repositories.meta.get(SEED_ELIGIBLE_META_KEY);
  if (!marker.ok) {
    return marker.error.code === "not-found" ? success(false) : marker;
  }

  if (marker.value.value !== true) {
    return success(false);
  }

  // A profile that received records before the seeded application boundary was
  // called is not genuinely new. This also makes a failed seed retryable only
  // while its rollback left the non-meta stores empty.
  const records = await Promise.all([
    repositories.imports.list(),
    repositories.decks.list(),
    repositories.notes.list(),
    repositories.cards.list(),
    repositories.schedules.list(),
    repositories.sessions.list(),
    repositories.reviewLogs.list(),
    repositories.media.list(),
  ]);
  const readFailure = records.find((result) => !result.ok);
  if (readFailure && !readFailure.ok) {
    return readFailure;
  }

  return success(records.every((result) => result.ok && result.value.length === 0));
}

async function writeRecord<Result>(
  position: SeedWritePosition,
  index: number | undefined,
  installation: SeedInstallation,
  options: SeedDatabaseOptions,
  write: () => Promise<DomainResult<Result>>,
): Promise<DomainResult<Result>> {
  options.hooks?.beforeWrite?.(position, index, installation);
  if (options.failureAt === position) {
    throw new Error(`Injected failure before ${position} write.`);
  }

  const result = await write();
  if (!result.ok) {
    return result;
  }

  options.hooks?.afterWrite?.(position, index, installation);
  return result;
}

function createNote(entry: SpanishBasicsFixtureEntry): NoteRecord {
  return {
    id: `seed-spanish-basics-note-${entry.id}`,
    importId: SEED_IMPORT_ID,
    sourceNoteId: null,
    guid: null,
    modelId: "spanish-basics-v1",
    fields: { Front: entry.front, Back: entry.back },
    tags: ["spanish", "basics"],
  };
}

function createCard(
  entry: SpanishBasicsFixtureEntry,
  note: NoteRecord,
  creationOrder: number,
): CardRecord {
  return {
    id: `seed-spanish-basics-card-${entry.id}`,
    deckId: SPANISH_BASICS_DECK_ID,
    noteId: note.id,
    sourceCardId: null,
    templateOrdinal: 0,
    frontHtml: entry.front,
    backHtml: entry.back,
    mediaRefs: [],
    creationOrder,
    contentWarnings: [],
  };
}

function seedInstalledRecord(): MetaRecord {
  return { key: SEED_INSTALLED_META_KEY, value: true };
}

function seedVersionRecord(): MetaRecord {
  return { key: SEED_VERSION_META_KEY, value: SPANISH_BASICS_SEED_VERSION };
}

function isSafeSeedText(value: string): boolean {
  return !/[<>]/.test(value)
    && !/(?:https?:\/\/|javascript:|data:|vbscript:)/i.test(value)
    && !/\bon[a-z]+\s*=/i.test(value)
    && !/<\s*(?:script|iframe|object|embed|form)\b/i.test(value);
}

function transactionFailure(cause: unknown): DomainResult<never> {
  return failure(mapDatabaseError(cause, "transaction", { resource: "seed" }));
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
      transaction.error ?? new DOMException(
        "IndexedDB transaction aborted.",
        "AbortError",
      ),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new DOMException(
        "IndexedDB transaction failed.",
        "UnknownError",
      ),
    );
  });
}

const seedLocks = new Map<string, Promise<void>>();

function withSeedLock<Result>(
  key: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = seedLocks.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(operation);
  const tail = current.then(() => undefined, () => undefined);
  seedLocks.set(key, tail);

  return current.finally(() => {
    if (seedLocks.get(key) === tail) {
      seedLocks.delete(key);
    }
  });
}
