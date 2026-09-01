import { describe, expect, test } from "bun:test";

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
import type {
  StudyStateChanges,
  StudyStateWritePosition,
} from "../domain/repositories";
import { FixedClock } from "../platform/clock";
import {
  createRepositories,
  createRepositoryTransactionContext,
} from "./repositories";
import { deleteDatabase, openDatabase } from "./database";
import {
  createStudyStateTransactionCoordinator,
} from "./study-state";
import {
  CURRENT_SCHEMA_VERSION,
  DATABASE_STORE_NAMES,
  SCHEMA_INDEX_NAMES,
} from "./schema";
import {
  buildSpanishBasicsInstallation,
  initializeSpanishBasicsSeed,
  openDatabaseWithSeed,
  SEED_INSTALLED_META_KEY,
  SEED_VERSION_META_KEY,
  SPANISH_BASICS_DECK_ID,
  SPANISH_BASICS_FIXTURE,
  SPANISH_BASICS_SEED_VERSION,
  SEED_WRITE_POSITIONS,
} from "./index";

describe("versioned IndexedDB schema", () => {
  test("creates every store, key, index, and schema marker through the production API", async () => {
    const factory = new MemoryIndexedDbFactory();
    const result = await openDatabase({ factory: asFactory(factory) });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const database = asDatabase(result.value);
    expect(database.name).toBe("anki-web-mcp");
    expect(database.version).toBe(CURRENT_SCHEMA_VERSION);
    expect([...database.objectStoreNames]).toEqual([...DATABASE_STORE_NAMES]);

    const schemaVersion = await readRecord(
      database,
      "meta",
      "schemaVersion",
    );
    expect(schemaVersion).toEqual({
      key: "schemaVersion",
      value: CURRENT_SCHEMA_VERSION,
    });

    const definitions = [
      ["meta", "key", []],
      ["imports", "id", [SCHEMA_INDEX_NAMES.importsBySha256]],
      [
        "decks",
        "id",
        [
          SCHEMA_INDEX_NAMES.decksByImportId,
          SCHEMA_INDEX_NAMES.decksByName,
          SCHEMA_INDEX_NAMES.decksByLastStudiedAt,
        ],
      ],
      ["notes", "id", []],
      [
        "cards",
        "id",
        [
          SCHEMA_INDEX_NAMES.cardsByDeckId,
          SCHEMA_INDEX_NAMES.cardsByDeckCreationOrder,
        ],
      ],
      [
        "schedules",
        "cardId",
        [
          SCHEMA_INDEX_NAMES.schedulesByDeckDueAt,
          SCHEMA_INDEX_NAMES.schedulesByDeckStateDueAt,
        ],
      ],
      [
        "sessions",
        "id",
        [
          SCHEMA_INDEX_NAMES.sessionsByDeckDaySequence,
          SCHEMA_INDEX_NAMES.sessionsByDeckDayCompletedAt,
        ],
      ],
      [
        "reviewLogs",
        "id",
        [
          SCHEMA_INDEX_NAMES.reviewLogsByCardId,
          SCHEMA_INDEX_NAMES.reviewLogsByDeckId,
          SCHEMA_INDEX_NAMES.reviewLogsBySessionId,
          SCHEMA_INDEX_NAMES.reviewLogsByReviewedAt,
          SCHEMA_INDEX_NAMES.reviewLogsByCommandId,
        ],
      ],
      ["media", ["importId", "name"], []],
    ] as const;

    for (const [name, keyPath, indexes] of definitions) {
      const store = database
        .transaction(name, "readonly")
        .objectStore(name);
      expect(store.keyPath).toEqual(
        typeof keyPath === "string" ? keyPath : [...keyPath] as string[],
      );
      expect([...store.indexNames]).toEqual([...indexes]);
    }

    const imports = database
      .transaction("imports", "readonly")
      .objectStore("imports");
    expect(imports.index(SCHEMA_INDEX_NAMES.importsBySha256).unique).toBe(true);

    const sessions = database
      .transaction("sessions", "readonly")
      .objectStore("sessions");
    expect(
      sessions.index(SCHEMA_INDEX_NAMES.sessionsByDeckDaySequence).unique,
    ).toBe(true);

    const reviewLogs = database
      .transaction("reviewLogs", "readonly")
      .objectStore("reviewLogs");
    expect(
      reviewLogs.index(SCHEMA_INDEX_NAMES.reviewLogsByCommandId).unique,
    ).toBe(true);

    database.close();
  });

  test("round-trips representative records and uses composite indexes", async () => {
    const factory = new MemoryIndexedDbFactory();
    const opened = await openDatabase({ factory: asFactory(factory) });

    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(opened.error.message);
    }

    const database = asDatabase(opened.value);
    const records = representativeRecords();
    const storeNames = [...DATABASE_STORE_NAMES];
    const transaction = database.transaction(storeNames, "readwrite");
    const done = transactionComplete(transaction);

    const requests = [
      transaction.objectStore("meta").put({ key: "seedInstalled", value: false }),
      transaction.objectStore("imports").add(records.importRecord),
      transaction.objectStore("decks").add(records.deckRecord),
      transaction.objectStore("notes").add(records.noteRecord),
      transaction.objectStore("cards").add(records.cardRecord),
      transaction.objectStore("schedules").add(records.scheduleRecord),
      transaction.objectStore("sessions").add(records.sessionRecord),
      transaction.objectStore("reviewLogs").add(records.reviewLogRecord),
      transaction.objectStore("media").add(records.mediaRecord),
    ];

    await Promise.all(requests.map(requestComplete));
    await done;

    expect(
      await readRecord(database, "decks", records.deckRecord.id),
    ).toEqual(records.deckRecord);
    expect(
      await readRecord(database, "media", ["import-1", "welcome.txt"]),
    ).toEqual(records.mediaRecord);

    const readTransaction = database.transaction(
      ["imports", "cards", "schedules"],
      "readonly",
    );
    const readDone = transactionComplete(readTransaction);
    const imported = await requestComplete(
      readTransaction
        .objectStore("imports")
        .index(SCHEMA_INDEX_NAMES.importsBySha256)
        .get("checksum-1"),
    );
    const orderedCards = await requestComplete(
      readTransaction
        .objectStore("cards")
        .index(SCHEMA_INDEX_NAMES.cardsByDeckCreationOrder)
        .getAll(["deck-1", 1]),
    );
    const dueSchedules = await requestComplete(
      readTransaction
        .objectStore("schedules")
        .index(SCHEMA_INDEX_NAMES.schedulesByDeckDueAt)
        .getAll(["deck-1", 1_800_000_000_000]),
    );
    await readDone;

    expect(imported).toEqual(records.importRecord);
    expect(orderedCards).toEqual([records.cardRecord]);
    expect(dueSchedules).toEqual([records.scheduleRecord]);

    database.close();
  });

  test("serializes concurrent first opens onto one compatible schema", async () => {
    const factory = new MemoryIndexedDbFactory();

    const [first, second] = await Promise.all([
      openDatabase({ factory: asFactory(factory) }),
      openDatabase({ factory: asFactory(factory) }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("Expected both concurrent opens to succeed.");
    }

    expect(first.value.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(second.value.version).toBe(CURRENT_SCHEMA_VERSION);
    expect([...asDatabase(first.value).objectStoreNames]).toEqual(
      [...DATABASE_STORE_NAMES],
    );

    first.value.close();
    second.value.close();
  });

  test("upgrades a supported v1 fixture in order and preserves records", async () => {
    const factory = new MemoryIndexedDbFactory();
    const migrationVersions: number[] = [];
    const records = representativeRecords();

    const legacy = await openDatabase({
      factory: asFactory(factory),
      version: 1,
      migrationHooks: {
        beforeMigration: (version) => migrationVersions.push(version),
      },
    });

    expect(legacy.ok).toBe(true);
    if (!legacy.ok) {
      throw new Error(legacy.error.message);
    }

    await writeLegacyFixture(asDatabase(legacy.value), records);
    legacy.value.close();

    const upgraded = await openDatabase({
      factory: asFactory(factory),
      migrationHooks: {
        beforeMigration: (version) => migrationVersions.push(version),
      },
    });

    expect(upgraded.ok).toBe(true);
    if (!upgraded.ok) {
      throw new Error(upgraded.error.message);
    }

    const database = asDatabase(upgraded.value);
    expect(migrationVersions).toEqual([1, 2]);
    expect(database.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(await readRecord(database, "meta", "legacyMarker")).toEqual({
      key: "legacyMarker",
      value: "preserve-me",
    });
    expect(await readRecord(database, "decks", records.deckRecord.id)).toEqual(
      records.deckRecord,
    );
    expect(await readRecord(database, "cards", records.cardRecord.id)).toEqual(
      records.cardRecord,
    );
    expect(
      await readRecord(database, "schedules", records.scheduleRecord.cardId),
    ).toEqual(records.scheduleRecord);

    const reviewLogs = database
      .transaction("reviewLogs", "readonly")
      .objectStore("reviewLogs");
    expect(
      reviewLogs.index(SCHEMA_INDEX_NAMES.reviewLogsByCommandId).unique,
    ).toBe(true);
    expect(asDatabase(legacy.value).closed).toBe(true);

    upgraded.value.close();
  });

  test("rolls back an injected migration failure and retries from the old version", async () => {
    const factory = new MemoryIndexedDbFactory();
    const records = representativeRecords();
    const legacy = await openDatabase({
      factory: asFactory(factory),
      version: 1,
    });

    expect(legacy.ok).toBe(true);
    if (!legacy.ok) {
      throw new Error(legacy.error.message);
    }

    await writeLegacyFixture(asDatabase(legacy.value), records);
    legacy.value.close();

    const failed = await openDatabase({
      factory: asFactory(factory),
      migrationHooks: {
        afterMigration: (version, context) => {
          if (version === 2) {
            // Prove the failure is injected while the migration transaction
            // can see its schema work, before the schema marker is written.
            expect(
              context.transaction
                .objectStore("reviewLogs")
                .index(SCHEMA_INDEX_NAMES.reviewLogsByCommandId).unique,
            ).toBe(true);
            throw new Error("injected migration failure");
          }
        },
      },
    });

    expect(failed).toEqual({
      ok: false,
      error: {
        code: "migration",
        message: "The local database could not be migrated.",
        resource: "anki-web-mcp",
      },
    });

    const stillLegacy = await openDatabase({
      factory: asFactory(factory),
      version: 1,
    });
    expect(stillLegacy.ok).toBe(true);
    if (!stillLegacy.ok) {
      throw new Error(stillLegacy.error.message);
    }

    const legacyDatabase = asDatabase(stillLegacy.value);
    expect(legacyDatabase.version).toBe(1);
    expect(await readRecord(legacyDatabase, "meta", "schemaVersion")).toEqual({
      key: "schemaVersion",
      value: 1,
    });
    expect(await readRecord(legacyDatabase, "decks", records.deckRecord.id)).toEqual(
      records.deckRecord,
    );
    expect(() =>
      legacyDatabase
        .transaction("reviewLogs", "readonly")
        .objectStore("reviewLogs")
        .index(SCHEMA_INDEX_NAMES.reviewLogsByCommandId),
    ).toThrow();

    stillLegacy.value.close();

    const retried = await openDatabase({ factory: asFactory(factory) });
    expect(retried.ok).toBe(true);
    if (!retried.ok) {
      throw new Error(retried.error.message);
    }

    const retriedDatabase = asDatabase(retried.value);
    expect(retriedDatabase.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(await readRecord(retriedDatabase, "meta", "schemaVersion")).toEqual({
      key: "schemaVersion",
      value: CURRENT_SCHEMA_VERSION,
    });
    expect(await readRecord(retriedDatabase, "cards", records.cardRecord.id)).toEqual(
      records.cardRecord,
    );
    expect(
      retriedDatabase
        .transaction("reviewLogs", "readonly")
        .objectStore("reviewLogs")
        .index(SCHEMA_INDEX_NAMES.reviewLogsByCommandId).unique,
    ).toBe(true);

    retried.value.close();
  });

  test("surfaces unavailable IndexedDB as a typed open failure", async () => {
    const result = await openDatabase({ factory: undefined });

    if (typeof indexedDB !== "undefined") {
      expect(result.ok).toBe(true);
    } else {
      expect(result).toEqual({
        ok: false,
        error: {
          code: "open",
          message: "IndexedDB is not available in this environment.",
          resource: "anki-web-mcp",
        },
      });
    }
  });

  test("deletes a test database through the production cleanup API", async () => {
    const factory = new MemoryIndexedDbFactory();
    const opened = await openDatabase({ factory: asFactory(factory) });

    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(opened.error.message);
    }

    opened.value.close();
    const deleted = await deleteDatabase({ factory: asFactory(factory) });
    expect(deleted).toEqual({ ok: true, value: undefined });
  });

  test("round-trips every record family through repository adapters", async () => {
    const factory = new MemoryIndexedDbFactory();
    const opened = await openDatabase({ factory: asFactory(factory) });

    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(opened.error.message);
    }

    const database = asDatabase(opened.value);
    const repositories = createRepositories(database as unknown as IDBDatabase);
    const records = representativeRecords();
    const meta = { key: "seedInstalled", value: false as const };

    expect(await repositories.meta.add(meta)).toEqual({ ok: true, value: meta });
    expect(await repositories.imports.add(records.importRecord)).toEqual({
      ok: true,
      value: records.importRecord,
    });
    expect(await repositories.decks.add(records.deckRecord)).toEqual({
      ok: true,
      value: records.deckRecord,
    });
    expect(await repositories.notes.add(records.noteRecord)).toEqual({
      ok: true,
      value: records.noteRecord,
    });
    expect(await repositories.cards.add(records.cardRecord)).toEqual({
      ok: true,
      value: records.cardRecord,
    });
    expect(await repositories.schedules.add(records.scheduleRecord)).toEqual({
      ok: true,
      value: records.scheduleRecord,
    });
    expect(await repositories.sessions.add(records.sessionRecord)).toEqual({
      ok: true,
      value: records.sessionRecord,
    });
    expect(await repositories.reviewLogs.add(records.reviewLogRecord)).toEqual({
      ok: true,
      value: records.reviewLogRecord,
    });
    expect(await repositories.media.add(records.mediaRecord)).toEqual({
      ok: true,
      value: records.mediaRecord,
    });

    expect(await repositories.meta.get(meta.key)).toEqual({ ok: true, value: meta });
    expect(await repositories.imports.findBySha256(records.importRecord.sha256)).toEqual({
      ok: true,
      value: records.importRecord,
    });
    expect(await repositories.decks.get(records.deckRecord.id)).toEqual({
      ok: true,
      value: records.deckRecord,
    });
    expect(await repositories.notes.get(records.noteRecord.id)).toEqual({
      ok: true,
      value: records.noteRecord,
    });
    expect(await repositories.cards.get(records.cardRecord.id)).toEqual({
      ok: true,
      value: records.cardRecord,
    });
    expect(await repositories.schedules.get(records.scheduleRecord.cardId)).toEqual({
      ok: true,
      value: records.scheduleRecord,
    });
    expect(await repositories.sessions.get(records.sessionRecord.id)).toEqual({
      ok: true,
      value: records.sessionRecord,
    });
    expect(await repositories.reviewLogs.get(records.reviewLogRecord.id)).toEqual({
      ok: true,
      value: records.reviewLogRecord,
    });
    expect(await repositories.media.get(["import-1", "welcome.txt"])).toEqual({
      ok: true,
      value: records.mediaRecord,
    });

    const missing = await repositories.cards.get("does-not-exist");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("not-found");
    }

    database.close();
  });

  test("uses repository indexes for stable card and due-schedule queries", async () => {
    const factory = new MemoryIndexedDbFactory();
    const opened = await openDatabase({ factory: asFactory(factory) });

    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(opened.error.message);
    }

    const database = asDatabase(opened.value);
    const repositories = createRepositories(database as unknown as IDBDatabase);
    const base = representativeRecords();
    await repositories.imports.add(base.importRecord);
    const cards = [
      { ...base.cardRecord, id: "card-z", creationOrder: 2 },
      { ...base.cardRecord, id: "card-a", creationOrder: 2 },
      { ...base.cardRecord, id: "card-first", creationOrder: 1 },
      { ...base.cardRecord, id: "card-other-deck", deckId: "deck-other", creationOrder: 0 },
    ];
    await Promise.all(cards.map((card) => repositories.cards.add(card)));

    const orderedCards = await repositories.cards.listByDeckId("deck-1");
    expect(orderedCards).toEqual({
      ok: true,
      value: [cards[2], cards[1], cards[0]],
    });

    const cutoff = 1_800_000_000_000;
    const schedules = [
      { ...base.scheduleRecord, cardId: "card-z", dueAt: cutoff },
      { ...base.scheduleRecord, cardId: "card-a", dueAt: cutoff },
      { ...base.scheduleRecord, cardId: "card-old", dueAt: cutoff - 1 },
      { ...base.scheduleRecord, cardId: "card-late", dueAt: cutoff + 1 },
      { ...base.scheduleRecord, cardId: "card-other", deckId: "deck-other", dueAt: cutoff - 2 },
    ];
    await Promise.all(schedules.map((schedule) => repositories.schedules.add(schedule)));

    const due = await repositories.schedules.listDue("deck-1", cutoff);
    expect(due).toEqual({
      ok: true,
      value: [schedules[2], schedules[1], schedules[0]],
    });

    const duplicateImport = await repositories.imports.add({
      ...base.importRecord,
      id: "import-duplicate-id",
    });
    expect(duplicateImport).toEqual({
      ok: false,
      error: {
        code: "constraint",
        message: "The requested record conflicts with an existing record.",
        resource: "imports",
      },
    });

    database.close();
  });

  test("participates in a caller-owned transaction context", async () => {
    const factory = new MemoryIndexedDbFactory();
    const opened = await openDatabase({ factory: asFactory(factory) });

    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(opened.error.message);
    }

    const database = asDatabase(opened.value);
    const repositories = createRepositories(database as unknown as IDBDatabase);
    const records = representativeRecords();
    const before = database.transactionCalls;
    const transaction = database.transaction(["decks", "cards"], "readwrite");
    const context = createRepositoryTransactionContext(transaction as unknown as IDBTransaction, [
      "decks",
      "cards",
    ]);
    const done = transactionComplete(transaction);

    const [deckResult, cardResult] = await Promise.all([
      repositories.decks.put(records.deckRecord, context),
      repositories.cards.put(records.cardRecord, context),
    ]);
    await done;

    expect(database.transactionCalls).toBe(before + 1);
    expect(deckResult).toEqual({ ok: true, value: records.deckRecord });
    expect(cardResult).toEqual({ ok: true, value: records.cardRecord });
    expect(await repositories.decks.get(records.deckRecord.id)).toEqual({
      ok: true,
      value: records.deckRecord,
    });
    expect(await repositories.cards.get(records.cardRecord.id)).toEqual({
      ok: true,
      value: records.cardRecord,
    });

    database.close();
  });

  test("commits schedule, review log, session, and deck metadata together", async () => {
    const factory = new MemoryIndexedDbFactory();
    const opened = await openDatabase({ factory: asFactory(factory) });

    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(opened.error.message);
    }

    const database = asDatabase(opened.value);
    const repositories = createRepositories(database as unknown as IDBDatabase);
    const records = representativeRecords();
    await installStudyBaseline(repositories, records);
    const changes = studyStateChanges(records);
    const beforeTransactions = database.transactionCalls;

    const result = await createStudyStateTransactionCoordinator(
      database as unknown as IDBDatabase,
      repositories,
    ).commit(changes);

    expect(result).toEqual({ ok: true, value: changes });
    expect(database.transactionCalls).toBe(beforeTransactions + 1);
    expect(await repositories.schedules.get(changes.schedule.cardId)).toEqual({
      ok: true,
      value: changes.schedule,
    });
    expect(await repositories.reviewLogs.get(changes.reviewLog.id)).toEqual({
      ok: true,
      value: changes.reviewLog,
    });
    expect(await repositories.sessions.get(changes.session.id)).toEqual({
      ok: true,
      value: changes.session,
    });
    expect(await repositories.decks.get(changes.deck.id)).toEqual({
      ok: true,
      value: changes.deck,
    });

    database.close();
  });

  test("rolls back every write position when an injected failure aborts", async () => {
    for (const position of [
      "schedule",
      "reviewLog",
      "session",
      "deck",
    ] as const satisfies readonly StudyStateWritePosition[]) {
      const factory = new MemoryIndexedDbFactory();
      const opened = await openDatabase({ factory: asFactory(factory) });

      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        throw new Error(opened.error.message);
      }

      const database = asDatabase(opened.value);
      const repositories = createRepositories(database as unknown as IDBDatabase);
      const records = representativeRecords();
      await installStudyBaseline(repositories, records);
      const changes = studyStateChanges(records, `command-${position}`);

      const result = await createStudyStateTransactionCoordinator(
        database as unknown as IDBDatabase,
        repositories,
      ).commit(changes, { failureAt: position });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "transaction",
          message: "The database transaction was not committed.",
          resource: "study-state",
        },
      });
      expect(await repositories.schedules.get(records.scheduleRecord.cardId)).toEqual({
        ok: true,
        value: records.scheduleRecord,
      });
      expect(await repositories.sessions.get(records.sessionRecord.id)).toEqual({
        ok: true,
        value: records.sessionRecord,
      });
      expect(await repositories.decks.get(records.deckRecord.id)).toEqual({
        ok: true,
        value: records.deckRecord,
      });
      expect(await repositories.reviewLogs.listBySessionId(records.sessionRecord.id)).toEqual({
        ok: true,
        value: [],
      });

      database.close();
    }
  });

  test("rejects missing records and duplicate command IDs without partial writes", async () => {
    const missingFactory = new MemoryIndexedDbFactory();
    const missingOpened = await openDatabase({ factory: asFactory(missingFactory) });

    expect(missingOpened.ok).toBe(true);
    if (!missingOpened.ok) {
      throw new Error(missingOpened.error.message);
    }

    const missingDatabase = asDatabase(missingOpened.value);
    const missingRepositories = createRepositories(
      missingDatabase as unknown as IDBDatabase,
    );
    const missingRecords = representativeRecords();
    await missingRepositories.schedules.add(missingRecords.scheduleRecord);
    await missingRepositories.sessions.add(missingRecords.sessionRecord);

    const missingResult = await createStudyStateTransactionCoordinator(
      missingDatabase as unknown as IDBDatabase,
      missingRepositories,
    ).commit(studyStateChanges(missingRecords));

    expect(missingResult).toEqual({
      ok: false,
      error: {
        code: "not-found",
        message: "The requested record was not found.",
        resource: "decks",
        key: missingRecords.deckRecord.id,
      },
    });
    expect(await missingRepositories.schedules.get(missingRecords.scheduleRecord.cardId)).toEqual({
      ok: true,
      value: missingRecords.scheduleRecord,
    });
    expect(await missingRepositories.reviewLogs.list()).toEqual({
      ok: true,
      value: [],
    });
    missingDatabase.close();

    const duplicateFactory = new MemoryIndexedDbFactory();
    const duplicateOpened = await openDatabase({ factory: asFactory(duplicateFactory) });

    expect(duplicateOpened.ok).toBe(true);
    if (!duplicateOpened.ok) {
      throw new Error(duplicateOpened.error.message);
    }

    const duplicateDatabase = asDatabase(duplicateOpened.value);
    const duplicateRepositories = createRepositories(
      duplicateDatabase as unknown as IDBDatabase,
    );
    const duplicateRecords = representativeRecords();
    await installStudyBaseline(duplicateRepositories, duplicateRecords);
    const existingReviewLog = {
      ...duplicateRecords.reviewLogRecord,
      id: "review-existing",
      commandId: "duplicate-command",
    };
    await duplicateRepositories.reviewLogs.add(existingReviewLog);

    const duplicateChanges = studyStateChanges(
      duplicateRecords,
      "duplicate-command",
    );
    const duplicateResult = await createStudyStateTransactionCoordinator(
      duplicateDatabase as unknown as IDBDatabase,
      duplicateRepositories,
    ).commit(duplicateChanges);

    expect(duplicateResult).toEqual({
      ok: false,
      error: {
        code: "constraint",
        message: "The requested record conflicts with an existing record.",
        resource: "reviewLogs",
      },
    });
    expect(await duplicateRepositories.schedules.get(duplicateRecords.scheduleRecord.cardId)).toEqual({
      ok: true,
      value: duplicateRecords.scheduleRecord,
    });
    expect(await duplicateRepositories.sessions.get(duplicateRecords.sessionRecord.id)).toEqual({
      ok: true,
      value: duplicateRecords.sessionRecord,
    });
    expect(await duplicateRepositories.decks.get(duplicateRecords.deckRecord.id)).toEqual({
      ok: true,
      value: duplicateRecords.deckRecord,
    });
    expect(await duplicateRepositories.reviewLogs.listBySessionId(
      duplicateRecords.sessionRecord.id,
    )).toEqual({
      ok: true,
      value: [existingReviewLog],
    });

    duplicateDatabase.close();
  });

  test("installs the deterministic Spanish Basics graph with safe text cards", async () => {
    const factory = new MemoryIndexedDbFactory();
    const opened = await openDatabase({ factory: asFactory(factory) });

    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(opened.error.message);
    }

    const database = asDatabase(opened.value);
    const repositories = createRepositories(database as unknown as IDBDatabase);
    const createdAt = 1_800_000_000_000;
    const result = await initializeSpanishBasicsSeed(database as unknown as IDBDatabase, {
      clock: new FixedClock(createdAt),
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.installation) {
      throw new Error(result.ok ? "Expected an installed seed graph." : result.error.message);
    }

    expect(result.value.installed).toBe(true);
    expect(result.value.seedVersion).toBe(SPANISH_BASICS_SEED_VERSION);
    expect(result.value.installation.deck).toMatchObject({
      id: SPANISH_BASICS_DECK_ID,
      importId: "seed",
      name: "Spanish Basics",
      cardCount: SPANISH_BASICS_FIXTURE.length,
      createdAt,
      sessionIntakeLimit: 20,
    });
    expect(result.value.installation.notes).toHaveLength(SPANISH_BASICS_FIXTURE.length);
    expect(result.value.installation.cards).toHaveLength(SPANISH_BASICS_FIXTURE.length);
    expect(result.value.installation.schedules).toHaveLength(SPANISH_BASICS_FIXTURE.length);

    const cards = await repositories.cards.listByDeckId(SPANISH_BASICS_DECK_ID);
    const schedules = await repositories.schedules.listDue(
      SPANISH_BASICS_DECK_ID,
      createdAt,
    );
    const notes = await repositories.notes.list();
    const decks = await repositories.decks.listByImportId("seed");
    if (!cards.ok || !schedules.ok || !notes.ok || !decks.ok) {
      throw new Error("Expected the seeded records to be queryable.");
    }

    expect(decks.value).toHaveLength(1);
    expect(cards.value.map((card) => ({
      id: card.id,
      creationOrder: card.creationOrder,
      front: card.frontHtml,
      back: card.backHtml,
    }))).toEqual(SPANISH_BASICS_FIXTURE.map((entry, index) => ({
      id: `seed-spanish-basics-card-${entry.id}`,
      creationOrder: index,
      front: entry.front,
      back: entry.back,
    })));
    expect(notes.value).toHaveLength(SPANISH_BASICS_FIXTURE.length);
    expect(schedules.value.map((schedule) => schedule.cardId).sort()).toEqual(
      cards.value.map((card) => card.id).sort(),
    );
    expect(schedules.value.every((schedule) =>
      schedule.deckId === SPANISH_BASICS_DECK_ID
      && schedule.dueAt === createdAt
      && schedule.state === "new"
      && schedule.reps === 0
      && schedule.suspended === false,
    )).toBe(true);
    expect(cards.value.every((card) =>
      card.frontHtml.length > 0
      && card.backHtml.length > 0
      && card.frontHtml.includes("<") === false
      && card.backHtml.includes("<") === false
      && card.mediaRefs.length === 0,
    )).toBe(true);
    expect(await repositories.meta.get(SEED_INSTALLED_META_KEY)).toEqual({
      ok: true,
      value: { key: SEED_INSTALLED_META_KEY, value: true },
    });
    expect(await repositories.meta.get(SEED_VERSION_META_KEY)).toEqual({
      ok: true,
      value: { key: SEED_VERSION_META_KEY, value: SPANISH_BASICS_SEED_VERSION },
    });

    database.close();
  });

  test("keeps fixture-derived IDs and order stable while accepting an injected clock", async () => {
    const first = buildSeedProjection(new FixedClock(1_700_000_000_000));
    const second = buildSeedProjection(new FixedClock(1_900_000_000_000));

    expect(first).toEqual(second);
  });

  test("rolls back every seed write position and retries cleanly", async () => {
    for (const position of SEED_WRITE_POSITIONS) {
      const factory = new MemoryIndexedDbFactory();
      const opened = await openDatabase({ factory: asFactory(factory) });

      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        throw new Error(opened.error.message);
      }

      const database = asDatabase(opened.value);
      const repositories = createRepositories(database as unknown as IDBDatabase);
      const failed = await initializeSpanishBasicsSeed(
        database as unknown as IDBDatabase,
        { clock: new FixedClock(1_800_000_000_000), failureAt: position },
      );

      expect(failed).toEqual({
        ok: false,
        error: {
          code: "transaction",
          message: "The database transaction was not committed.",
          resource: "seed",
        },
      });
      expect(await repositories.decks.list()).toEqual({ ok: true, value: [] });
      expect(await repositories.notes.list()).toEqual({ ok: true, value: [] });
      expect(await repositories.cards.list()).toEqual({ ok: true, value: [] });
      expect(await repositories.schedules.list()).toEqual({ ok: true, value: [] });
      expect(await repositories.meta.get(SEED_INSTALLED_META_KEY)).toEqual({
        ok: false,
        error: {
          code: "not-found",
          message: "The requested record was not found.",
          resource: "meta",
          key: SEED_INSTALLED_META_KEY,
        },
      });

      const retried = await initializeSpanishBasicsSeed(
        database as unknown as IDBDatabase,
        { clock: new FixedClock(1_800_000_000_000) },
      );
      expect(retried.ok).toBe(true);
      if (!retried.ok) {
        throw new Error(retried.error.message);
      }
      expect(retried.value.installed).toBe(true);
      expect(await repositories.decks.list()).toMatchObject({
        ok: true,
        value: [{ id: SPANISH_BASICS_DECK_ID }],
      });

      database.close();
    }
  });

  test("retries a failed first-run seeded open on the next open", async () => {
    const factory = new MemoryIndexedDbFactory();
    const failed = await openDatabaseWithSeed({
      factory: asFactory(factory),
      seed: {
        clock: new FixedClock(1_800_000_000_000),
        failureAt: "card",
      },
    });

    expect(failed).toEqual({
      ok: false,
      error: {
        code: "transaction",
        message: "The database transaction was not committed.",
        resource: "seed",
      },
    });

    const retried = await openDatabaseWithSeed({
      factory: asFactory(factory),
      seed: { clock: new FixedClock(1_800_000_000_000) },
    });
    expect(retried.ok).toBe(true);
    if (!retried.ok) {
      throw new Error(retried.error.message);
    }

    expect(retried.value.seed.installed).toBe(true);
    const repositories = createRepositories(retried.value.database);
    expect(await repositories.cards.listByDeckId(SPANISH_BASICS_DECK_ID)).toMatchObject({
      ok: true,
      value: expect.any(Array),
    });
    retried.value.database.close();
  });

  test("seeds concurrently exactly once and never recreates a removed deck", async () => {
    const factory = new MemoryIndexedDbFactory();
    const first = await openDatabase({ factory: asFactory(factory) });

    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.error.message);
    }

    const database = asDatabase(first.value);
    const options = { clock: new FixedClock(1_800_000_000_000) };
    const [one, two] = await Promise.all([
      initializeSpanishBasicsSeed(database as unknown as IDBDatabase, options),
      initializeSpanishBasicsSeed(database as unknown as IDBDatabase, options),
    ]);
    expect([one, two].filter((result) => result.ok && result.value.installed)).toHaveLength(1);
    expect([one, two].filter((result) => result.ok && !result.value.installed)).toHaveLength(1);

    const repositories = createRepositories(database as unknown as IDBDatabase);
    const installed = await repositories.cards.listByDeckId(SPANISH_BASICS_DECK_ID);
    if (!installed.ok) {
      throw new Error(installed.error.message);
    }
    expect(installed.value).toHaveLength(SPANISH_BASICS_FIXTURE.length);

    for (const card of installed.value) {
      expect(await repositories.schedules.delete(card.id)).toEqual({ ok: true, value: undefined });
      expect(await repositories.cards.delete(card.id)).toEqual({ ok: true, value: undefined });
      expect(await repositories.notes.delete(card.noteId)).toEqual({ ok: true, value: undefined });
    }
    expect(await repositories.decks.delete(SPANISH_BASICS_DECK_ID)).toEqual({
      ok: true,
      value: undefined,
    });

    database.close();
    const reopened = await openDatabaseWithSeed({
      factory: asFactory(factory),
      seed: options,
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) {
      throw new Error(reopened.error.message);
    }
    expect(reopened.value.seed.installed).toBe(false);
    const reopenedRepositories = createRepositories(reopened.value.database);
    expect(await reopenedRepositories.decks.listByImportId("seed")).toEqual({
      ok: true,
      value: [],
    });
    expect(await reopenedRepositories.cards.list()).toEqual({ ok: true, value: [] });
    expect(await reopenedRepositories.schedules.list()).toEqual({ ok: true, value: [] });
    expect(await reopenedRepositories.meta.get(SEED_INSTALLED_META_KEY)).toEqual({
      ok: true,
      value: { key: SEED_INSTALLED_META_KEY, value: true },
    });

    reopened.value.database.close();
  });
});

function buildSeedProjection(clock: FixedClock): Array<{
  cardId: string;
  noteId: string;
  creationOrder: number;
  front: string;
  back: string;
}> {
  const result = buildSpanishBasicsInstallation(clock);
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value.cards.map((card, index) => ({
    cardId: card.id,
    noteId: result.value.notes[index]!.id,
    creationOrder: card.creationOrder,
    front: card.frontHtml,
    back: card.backHtml,
  }));
}

function asFactory(factory: MemoryIndexedDbFactory): IDBFactory {
  return factory as unknown as IDBFactory;
}

function asDatabase(database: IDBDatabase | MemoryDatabase): MemoryDatabase {
  return database as unknown as MemoryDatabase;
}

async function readRecord(
  database: IDBDatabase | MemoryDatabase,
  storeName: string,
  key: unknown,
): Promise<unknown> {
  const transaction = asDatabase(database).transaction(storeName, "readonly");
  const done = transactionComplete(transaction);
  const value = await requestComplete(transaction.objectStore(storeName).get(key));
  await done;
  return value;
}

function transactionComplete(transaction: MemoryTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function requestComplete<T>(request: MemoryRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

interface RepresentativeRecords {
  importRecord: ImportRecord;
  deckRecord: DeckRecord;
  noteRecord: NoteRecord;
  cardRecord: CardRecord;
  scheduleRecord: ScheduleRecord;
  sessionRecord: SessionRecord;
  reviewLogRecord: ReviewLogRecord;
  mediaRecord: MediaRecord;
}

function representativeRecords(): RepresentativeRecords {
  const snapshot = {
    dueAt: 1_800_000_000_000,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: "new" as const,
    lastReviewAt: null,
    suspended: false,
  };

  return {
    importRecord: {
      id: "import-1",
      sha256: "checksum-1",
      fileName: "sample.apkg",
      fileSize: 42,
      packageVersion: "synthetic",
      importedAt: 1_800_000_000_000,
      warnings: [],
    },
    deckRecord: {
      id: "deck-1",
      importId: "import-1",
      sourceDeckId: null,
      name: "Sample",
      cardCount: 1,
      createdAt: 1_800_000_000_000,
      lastStudiedAt: null,
      sessionIntakeLimit: 20,
      schedulerConfigId: "neutral-v1",
    },
    noteRecord: {
      id: "note-1",
      importId: "import-1",
      sourceNoteId: null,
      guid: null,
      modelId: null,
      fields: { Front: "hola", Back: "hello" },
      tags: ["sample"],
    },
    cardRecord: {
      id: "card-1",
      deckId: "deck-1",
      noteId: "note-1",
      sourceCardId: null,
      templateOrdinal: 0,
      frontHtml: "hola",
      backHtml: "hello",
      mediaRefs: [],
      creationOrder: 1,
      contentWarnings: [],
    },
    scheduleRecord: {
      cardId: "card-1",
      deckId: "deck-1",
      ...snapshot,
      legacyEaseFactor: null,
    },
    sessionRecord: {
      id: "session-1",
      deckId: "deck-1",
      dayKey: "2026-09-01",
      sequence: 1,
      intakeLimit: 20,
      nextDayAt: 1_800_086_400_000,
      queueEntries: [{ cardId: "card-1", dueAt: snapshot.dueAt, ordinal: 0 }],
      activeCardId: "card-1",
      plannedPresentationCount: 1,
      completedPresentationCount: 0,
      currentSide: "front",
      ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
      startedAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
      completedAt: null,
      lastCommandIds: [],
    },
    reviewLogRecord: {
      id: "review-1",
      sessionId: "session-1",
      deckId: "deck-1",
      cardId: "card-1",
      rating: "good",
      reviewedAt: 1_800_000_000_000,
      durationMs: null,
      before: snapshot,
      after: { ...snapshot, dueAt: 1_800_086_400_000, state: "review" },
      commandId: "command-1",
    },
    mediaRecord: {
      importId: "import-1",
      name: "welcome.txt",
      blob: new Blob(["hello"]),
      mimeType: "text/plain",
      byteLength: 5,
      sha256: "media-checksum-1",
    },
  };
}

async function installStudyBaseline(
  repositories: ReturnType<typeof createRepositories>,
  records: RepresentativeRecords,
): Promise<void> {
  await repositories.decks.add(records.deckRecord);
  await repositories.schedules.add(records.scheduleRecord);
  await repositories.sessions.add(records.sessionRecord);
}

function studyStateChanges(
  records: RepresentativeRecords,
  commandId = "command-2",
): StudyStateChanges {
  const schedule = {
    ...records.scheduleRecord,
    dueAt: records.scheduleRecord.dueAt + 86_400_000,
    state: "review" as const,
    scheduledDays: 1,
    reps: 1,
    lastReviewAt: records.scheduleRecord.dueAt,
  };
  const session = {
    ...records.sessionRecord,
    completedPresentationCount: 1,
    updatedAt: records.sessionRecord.updatedAt + 1_000,
    ratingCounts: { ...records.sessionRecord.ratingCounts, good: 1 },
    lastCommandIds: [commandId],
  };
  const deck = {
    ...records.deckRecord,
    lastStudiedAt: schedule.lastReviewAt,
  };

  return {
    schedule,
    reviewLog: {
      ...records.reviewLogRecord,
      id: `review-${commandId}`,
      sessionId: session.id,
      deckId: deck.id,
      cardId: schedule.cardId,
      reviewedAt: schedule.lastReviewAt ?? schedule.dueAt,
      before: scheduleSnapshot(records.scheduleRecord),
      after: scheduleSnapshot(schedule),
      commandId,
    },
    session,
    deck,
  };
}

function scheduleSnapshot(schedule: ScheduleRecord): Omit<ScheduleRecord, "cardId" | "deckId"> {
  const { cardId, deckId, ...snapshot } = schedule;
  void cardId;
  void deckId;
  return snapshot;
}

async function writeLegacyFixture(
  database: MemoryDatabase,
  records: RepresentativeRecords,
): Promise<void> {
  const transaction = database.transaction(
    ["meta", "decks", "cards", "schedules"],
    "readwrite",
  );
  const done = transactionComplete(transaction);
  const requests = [
    transaction.objectStore("meta").put({
      key: "legacyMarker",
      value: "preserve-me",
    }),
    transaction.objectStore("decks").put(records.deckRecord),
    transaction.objectStore("cards").put(records.cardRecord),
    transaction.objectStore("schedules").put(records.scheduleRecord),
  ];

  await Promise.all(requests.map(requestComplete));
  await done;
}

class MemoryIndexedDbFactory {
  private readonly databases = new Map<string, MemoryDatabaseState>();
  private readonly connections = new Map<string, Set<MemoryDatabase>>();

  open(name: string, version?: number): MemoryOpenRequest {
    const request = new MemoryOpenRequest();
    queueMicrotask(() => {
      const current = this.databases.get(name) ?? {
        version: 0,
        stores: new Map<string, MemoryStoreState>(),
      };
      const requestedVersion = version ?? (current.version || 1);

      if (requestedVersion < current.version) {
        request.error = new DOMException("Version is too old.", "VersionError");
        request.onerror?.();
        return;
      }

      const databaseConnections = this.connections.get(name) ?? new Set();
      this.connections.set(name, databaseConnections);
      if (requestedVersion > current.version) {
        for (const connection of [...databaseConnections]) {
          connection.onversionchange?.();
        }
      }

      const upgradeState = requestedVersion > current.version
        ? cloneDatabaseState(current)
        : current;
      const database = new MemoryDatabase(
        name,
        current.version,
        upgradeState,
        () => databaseConnections.delete(database),
        () => {
          current.stores = (database as unknown as { state: MemoryDatabaseState }).state.stores;
        },
      );
      request.result = database;

      if (requestedVersion > current.version) {
        const transaction = new MemoryTransaction(database, "versionchange");
        request.transaction = transaction;
        request.onupgradeneeded?.({
          oldVersion: current.version,
          newVersion: requestedVersion,
        } as unknown as IDBVersionChangeEvent);
        request.transaction = null;

        queueMicrotask(() => {
          if (transaction.aborted) {
            database.close();
            request.error = new DOMException(
              "The upgrade transaction was aborted.",
              "AbortError",
            );
            request.onerror?.();
            return;
          }

          current.version = requestedVersion;
          current.stores = upgradeState.stores;
          database.version = requestedVersion;
          this.databases.set(name, current);
          databaseConnections.add(database);
          request.onsuccess?.();
        });
        return;
      }

      databaseConnections.add(database);
      request.onsuccess?.();
    });
    return request;
  }

  deleteDatabase(name: string): MemoryOpenRequest {
    const request = new MemoryOpenRequest();
    queueMicrotask(() => {
      for (const connection of this.connections.get(name) ?? []) {
        connection.onversionchange?.();
      }
      this.databases.delete(name);
      this.connections.delete(name);
      request.onsuccess?.();
    });
    return request;
  }
}

interface MemoryDatabaseState {
  version: number;
  stores: Map<string, MemoryStoreState>;
}

interface MemoryStoreState {
  keyPath: string | string[];
  indexes: Map<string, MemoryIndexState>;
  records: Map<string, unknown>;
}

interface MemoryIndexState {
  keyPath: string | string[];
  unique: boolean;
}

class MemoryOpenRequest {
  result!: MemoryDatabase;
  error: DOMException | null = null;
  transaction: MemoryTransaction | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  onblocked: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class MemoryDatabase {
  public version: number;
  public readonly objectStoreNames: MemoryNameList;
  public onversionchange: (() => void) | null = null;
  public closed = false;
  public transactionCalls = 0;

  constructor(
    public readonly name: string,
    version: number,
    private readonly state: MemoryDatabaseState,
    private readonly onClose: () => void = () => {},
    private readonly onRollback: () => void = () => {},
  ) {
    this.version = version;
    this.objectStoreNames = new MemoryNameList(() => [...state.stores.keys()]);
  }

  createObjectStore(
    name: string,
    options: IDBObjectStoreParameters = {},
  ): MemoryObjectStore {
    if (this.state.stores.has(name)) {
      throw new DOMException("Store already exists.", "ConstraintError");
    }

    this.state.stores.set(name, {
      keyPath: Array.isArray(options.keyPath)
        ? [...options.keyPath]
        : options.keyPath ?? "",
      indexes: new Map(),
      records: new Map(),
    });
    return new MemoryObjectStore(this, name, this.state.stores.get(name)!);
  }

  transaction(
    storeNames: string | readonly string[],
    mode: IDBTransactionMode = "readonly",
  ): MemoryTransaction {
    this.transactionCalls += 1;
    const names = typeof storeNames === "string" ? [storeNames] : [...storeNames];
    return new MemoryTransaction(this, mode, names);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose();
  }

  restoreStores(stores: Map<string, MemoryStoreState>): void {
    this.state.stores = stores;
    this.onRollback();
  }
}

class MemoryTransaction {
  public aborted = false;
  public error: DOMException | null = null;
  public oncomplete: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  private pending = 0;
  private completionScheduled = false;
  private readonly initialState: MemoryDatabaseState;

  constructor(
    private readonly database: MemoryDatabase,
    public readonly mode: IDBTransactionMode,
    private readonly names?: readonly string[],
  ) {
    this.initialState = cloneDatabaseState(
      (database as unknown as { state: MemoryDatabaseState }).state,
    );
  }

  objectStore(name: string): MemoryObjectStore {
    if (this.mode !== "versionchange" && !this.names?.includes(name)) {
      throw new DOMException("Store is outside the transaction.", "NotFoundError");
    }

    const state = (this.database as unknown as { state: MemoryDatabaseState }).state;
    const store = state.stores.get(name);
    if (!store) {
      throw new DOMException("Store does not exist.", "NotFoundError");
    }
    return new MemoryObjectStore(this.database, name, store, this);
  }

  abort(): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.database.restoreStores(this.initialState.stores);
    queueMicrotask(() => {
      this.onabort?.();
      this.onerror?.();
    });
  }

  schedule<T>(operation: () => T): MemoryRequest<T> {
    const request = new MemoryRequest<T>();
    this.pending += 1;
    queueMicrotask(() => {
      try {
        if (this.aborted) {
          throw new DOMException("Transaction aborted.", "AbortError");
        }
        request.succeed(operation());
      } catch (cause) {
        this.error = cause instanceof DOMException
          ? cause
          : new DOMException("Request failed.", "UnknownError");
        request.fail(this.error);
      } finally {
        this.pending -= 1;
        this.scheduleCompletionIfIdle();
      }
    });
    return request;
  }

  private scheduleCompletionIfIdle(): void {
    if (this.pending !== 0 || this.completionScheduled || this.aborted) {
      return;
    }

    this.completionScheduled = true;
    queueMicrotask(() => this.oncomplete?.());
  }
}

class MemoryObjectStore {
  public readonly indexNames: MemoryNameList;

  constructor(
    private readonly database: MemoryDatabase,
    public readonly name: string,
    private readonly state: MemoryStoreState,
    private readonly transaction?: MemoryTransaction,
  ) {
    this.indexNames = new MemoryNameList(() => [...state.indexes.keys()]);
  }

  get keyPath(): string | string[] {
    return this.state.keyPath;
  }

  createIndex(
    name: string,
    keyPath: string | string[],
    options: IDBIndexParameters = {},
  ): MemoryIndex {
    if (this.state.indexes.has(name)) {
      throw new DOMException("Index already exists.", "ConstraintError");
    }
    this.state.indexes.set(name, {
      keyPath: Array.isArray(keyPath) ? [...keyPath] : keyPath,
      unique: options.unique ?? false,
    });
    return this.index(name);
  }

  index(name: string): MemoryIndex {
    const index = this.state.indexes.get(name);
    if (!index) {
      throw new DOMException("Index does not exist.", "NotFoundError");
    }
    return new MemoryIndex(this, index);
  }

  add(value: unknown): MemoryRequest<unknown> {
    return this.write(value, false);
  }

  put(value: unknown): MemoryRequest<unknown> {
    return this.write(value, true);
  }

  get(key: unknown): MemoryRequest<unknown> {
    return this.operation(() => cloneValue(this.state.records.get(keyToken(key))));
  }

  getAll(): MemoryRequest<unknown[]> {
    return this.operation(() => [...this.state.records.values()].map(cloneValue));
  }

  delete(key: unknown): MemoryRequest<undefined> {
    return this.operation(() => {
      this.state.records.delete(keyToken(key));
      return undefined;
    });
  }

  private write(value: unknown, replace: boolean): MemoryRequest<unknown> {
    return this.operation(() => {
      const key = valueAtPath(value, this.state.keyPath);
      const token = keyToken(key);
      if (!replace && this.state.records.has(token)) {
        throw new DOMException("Key already exists.", "ConstraintError");
      }
      this.assertUniqueIndexes(value, token);
      this.state.records.set(token, cloneValue(value));
      return cloneValue(value);
    });
  }

  private assertUniqueIndexes(value: unknown, recordToken: string): void {
    for (const index of this.state.indexes.values()) {
      if (!index.unique) {
        continue;
      }
      const indexedKey = valueAtPath(value, index.keyPath);
      if (indexedKey === undefined || indexedKey === null) {
        continue;
      }
      for (const [existingToken, existing] of this.state.records) {
        if (
          existingToken !== recordToken &&
          keyToken(valueAtPath(existing, index.keyPath)) === keyToken(indexedKey)
        ) {
          throw new DOMException("Unique index conflict.", "ConstraintError");
        }
      }
    }
  }

  private operation<T>(operation: () => T): MemoryRequest<T> {
    if (!this.transaction) {
      throw new DOMException("A transaction is required.", "InvalidStateError");
    }
    return this.transaction.schedule(operation);
  }

  allRecords(): unknown[] {
    return [...this.state.records.values()];
  }
}

class MemoryIndex {
  public readonly name: string;
  public readonly keyPath: string | string[];
  public readonly unique: boolean;
  public readonly multiEntry = false;

  constructor(
    private readonly store: MemoryObjectStore,
    state: MemoryIndexState,
  ) {
    this.name = "";
    this.keyPath = state.keyPath;
    this.unique = state.unique;
  }

  get(key: unknown): MemoryRequest<unknown> {
    return this.query(key, false);
  }

  getAll(key?: unknown): MemoryRequest<unknown[]> {
    return this.query(key, true) as MemoryRequest<unknown[]>;
  }

  private query(key: unknown, all: boolean): MemoryRequest<unknown | unknown[]> {
    const transaction = (this.store as unknown as { transaction?: MemoryTransaction })
      .transaction;
    if (!transaction) {
      throw new DOMException("A transaction is required.", "InvalidStateError");
    }

    return transaction.schedule(() => {
      const records = this.store.allRecords();
      const matching = records
        .filter((record) => key === undefined || keyToken(valueAtPath(record, this.keyPath)) === keyToken(key))
        .sort((left, right) => compareKeys(
          valueAtPath(left, this.keyPath),
          valueAtPath(right, this.keyPath),
        ))
        .map(cloneValue);
      return all ? matching : matching[0];
    });
  }
}

class MemoryRequest<T> {
  public result!: T;
  public error: DOMException | null = null;
  public onsuccess: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  succeed(result: T): void {
    this.result = result;
    this.onsuccess?.();
  }

  fail(error: DOMException): void {
    this.error = error;
    this.onerror?.();
  }
}

class MemoryNameList {
  constructor(private readonly values: () => string[]) {}

  get length(): number {
    return this.values().length;
  }

  contains(name: string): boolean {
    return this.values().includes(name);
  }

  item(index: number): string | null {
    return this.values()[index] ?? null;
  }

  [Symbol.iterator](): Iterator<string> {
    return this.values()[Symbol.iterator]();
  }
}

function valueAtPath(value: unknown, keyPath: string | readonly string[]): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (typeof keyPath !== "string") {
    return keyPath.map((path) => valueAtPath(value, path));
  }
  return (value as Record<string, unknown>)[keyPath];
}

function keyToken(key: unknown): string {
  return JSON.stringify(key) ?? "undefined";
}

function compareKeys(left: unknown, right: unknown): number {
  const leftToken = keyToken(left);
  const rightToken = keyToken(right);
  return leftToken < rightToken ? -1 : leftToken > rightToken ? 1 : 0;
}

function cloneValue<T>(value: T): T {
  return typeof structuredClone === "function" ? structuredClone(value) : value;
}

function cloneDatabaseState(state: MemoryDatabaseState): MemoryDatabaseState {
  return {
    version: state.version,
    stores: new Map(
      [...state.stores].map(([name, store]) => [name, {
        keyPath: Array.isArray(store.keyPath)
          ? [...store.keyPath]
          : store.keyPath,
        indexes: new Map(
          [...store.indexes].map(([indexName, index]) => [indexName, {
            keyPath: Array.isArray(index.keyPath)
              ? [...index.keyPath]
              : index.keyPath,
            unique: index.unique,
          }]),
        ),
        records: new Map(
          [...store.records].map(([key, value]) => [key, cloneValue(value)]),
        ),
      }]),
    ),
  };
}
