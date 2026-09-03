import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  DeckRemovalService,
  DECK_REMOVAL_TRANSACTION_BOUNDARIES,
  createDeckRemovalService,
  deriveDeckRemovalPreview,
  type DeckRemovalGraphSnapshot,
} from "../../lib/application/deck-removal-service";
import type {
  CardRecord,
  DeckRecord,
  ImportRecord,
  MediaRecord,
  NoteRecord,
  ReviewLogRecord,
  ScheduleRecord,
  SessionRecord,
} from "../../lib/domain/entities";
import { domainError, failure, success } from "../../lib/domain/errors";
import { openDatabase } from "../../lib/persistence/database";
import { createRepositories } from "../../lib/persistence/repositories";
import {
  openDatabaseWithSeed,
  SEED_INSTALLED_META_KEY,
  SPANISH_BASICS_DECK_ID,
} from "../../lib/persistence/seed";

const factory = new IDBFactory();
const databaseNames: string[] = [];

afterEach(async () => {
  for (const name of databaseNames.splice(0)) {
    await deleteDatabase(name);
  }
});

describe("DeckRemovalService", () => {
  test("derives selected-card and true orphan-media counts without trusting cached totals", async () => {
    const importId = "shared-import";
    const graph = emptyGraph({
      imports: [makeImport(importId)],
      decks: [
        makeDeck("first", importId, "Languages", 999),
        makeDeck("second", importId, "Languages::Audio", 999),
      ],
      notes: [
        makeNote("shared-note", importId),
        makeNote("first-note", importId),
        makeNote("second-note", importId),
      ],
      cards: [
        makeCard("first-card", "first", "shared-note", [
          mediaId(importId, "shared.mp3"),
          mediaId(importId, "first only.mp3"),
        ]),
        makeCard("first-card-2", "first", "first-note"),
        makeCard("second-card", "second", "shared-note", [
          mediaId(importId, "shared.mp3"),
          mediaId(importId, "second.mp3"),
        ]),
      ],
      media: [
        makeMedia(importId, "shared.mp3"),
        makeMedia(importId, "first only.mp3"),
        makeMedia(importId, "second.mp3"),
        makeMedia(importId, "unused.mp3"),
      ],
    });

    const preview = await deriveDeckRemovalPreview(graph, "first");

    expect(preview).toMatchObject({
      deckId: "first",
      deckName: "Languages",
      cardCount: 2,
      mediaCount: 2,
    });
    expect(preview?.revision).toMatch(/^deck-removal-v1:[0-9a-f]{64}$/);
    expect(await deriveDeckRemovalPreview(graph, "missing")).toBeNull();
  });

  test("returns stable application-owned not-found and failure outcomes", async () => {
    const missing = new DeckRemovalService({
      readGraph: async () => success(emptyGraph()),
    });
    const failed = new DeckRemovalService({
      readGraph: async () => failure(domainError(
        "storage",
        "raw implementation detail",
      )),
    });

    expect(await missing.previewRemoval("absent")).toEqual({
      status: "not-found",
      deckId: "absent",
    });
    expect(await failed.previewRemoval("deck")).toEqual({ status: "failed" });
  });

  test("previews the seed without mutating its graph or installed marker", async () => {
    const name = nextDatabaseName("seed");
    const opened = await openDatabaseWithSeed({
      factory,
      name,
      seed: { clock: { now: () => 1_900_000_000_000 } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const repositories = createRepositories(opened.value.database);
    const before = await Promise.all([
      repositories.decks.list(),
      repositories.cards.list(),
      repositories.schedules.list(),
      repositories.meta.get(SEED_INSTALLED_META_KEY),
    ]);

    const result = await createDeckRemovalService(
      opened.value.database,
    ).previewRemoval(SPANISH_BASICS_DECK_ID);

    expect(result).toMatchObject({
      status: "ready",
      preview: {
        deckId: SPANISH_BASICS_DECK_ID,
        deckName: "Spanish Basics",
        cardCount: 24,
        mediaCount: 0,
      },
    });
    expect(await Promise.all([
      repositories.decks.list(),
      repositories.cards.list(),
      repositories.schedules.list(),
      repositories.meta.get(SEED_INSTALLED_META_KEY),
    ])).toEqual(before);
    opened.value.database.close();
  });

  test("counts all package media for a single imported deck, including unreferenced media", async () => {
    const { database } = await openFixture("single", {
      decks: [makeDeck("only", "single-import", "Only")],
      notes: [makeNote("note", "single-import")],
      cards: [makeCard("card", "only", "note", [mediaId("single-import", "used.png")])],
      media: [
        makeMedia("single-import", "used.png"),
        makeMedia("single-import", "package-extra.png"),
      ],
    });

    expect(await createDeckRemovalService(database).previewRemoval("only")).toMatchObject({
      status: "ready",
      preview: { cardCount: 1, mediaCount: 2 },
    });
    expect(await createDeckRemovalService(database).previewRemoval("missing")).toEqual({
      status: "not-found",
      deckId: "missing",
    });
    database.close();
  });

  test("preserves sibling-referenced media and counts unique plus already-unreferenced media", async () => {
    const importId = "multi-import";
    const fixture = await openFixture("siblings", {
      decks: [
        makeDeck("first", importId, "First"),
        makeDeck("second", importId, "Second"),
      ],
      notes: [makeNote("shared", importId), makeNote("unique", importId)],
      cards: [
        makeCard("first-card", "first", "shared", [
          mediaId(importId, "shared.png"),
          mediaId(importId, "first.png"),
        ]),
        makeCard("second-card", "second", "shared", [
          mediaId(importId, "shared.png"),
          mediaId(importId, "second.png"),
        ]),
      ],
      media: [
        makeMedia(importId, "shared.png"),
        makeMedia(importId, "first.png"),
        makeMedia(importId, "second.png"),
        makeMedia(importId, "unused.png"),
      ],
    });
    const service = createDeckRemovalService(fixture.database);

    expect(await service.previewRemoval("first")).toMatchObject({
      status: "ready",
      preview: { cardCount: 1, mediaCount: 2 },
    });

    expect((await fixture.repositories.cards.delete("first-card")).ok).toBe(true);
    expect((await fixture.repositories.decks.delete("first")).ok).toBe(true);
    expect(await service.previewRemoval("second")).toMatchObject({
      status: "ready",
      preview: { cardCount: 1, mediaCount: 4 },
    });
    fixture.database.close();
  });

  test("accepts an unchanged revision and rejects changed relevant graphs as stale with no write", async () => {
    const importId = "stale-import";
    const fixture = await openFixture("stale", {
      decks: [makeDeck("deck", importId, "Original")],
      notes: [makeNote("note", importId)],
      cards: [makeCard("card", "deck", "note")],
      media: [makeMedia(importId, "unused.png")],
    });
    const service = createDeckRemovalService(fixture.database);
    const initial = await service.previewRemoval("deck");
    expect(initial.status).toBe("ready");
    if (initial.status !== "ready") return;

    expect(await service.revalidateRemoval(initial.preview)).toEqual({
      status: "valid",
      preview: initial.preview,
    });
    expect((await fixture.repositories.cards.add(
      makeCard("new-card", "deck", "note"),
    )).ok).toBe(true);

    expect(await service.revalidateRemoval(initial.preview)).toEqual({
      status: "stale",
      deckId: "deck",
    });
    expect(await fixture.repositories.decks.get("deck")).toMatchObject({ ok: true });
    expect(await fixture.repositories.cards.listByDeckId("deck")).toMatchObject({
      ok: true,
      value: [{ id: "card" }, { id: "new-card" }],
    });
    fixture.database.close();
  });

  test("commits the complete cascade while preserving sibling-shared records", async () => {
    const importId = "shared-commit";
    const fixture = await openFixture("commit-sibling", {
      decks: [
        makeDeck("first", importId, "First"),
        makeDeck("second", importId, "Second"),
      ],
      notes: [
        makeNote("shared", importId), makeNote("first-only", importId),
        makeNote("already-orphaned", importId),
      ],
      cards: [
        makeCard("first-card", "first", "shared", [
          mediaId(importId, "shared.png"), mediaId(importId, "first.png"),
        ]),
        makeCard("first-card-2", "first", "first-only"),
        makeCard("second-card", "second", "shared", [
          mediaId(importId, "shared.png"), mediaId(importId, "second.png"),
        ]),
      ],
      schedules: [
        makeSchedule("first-card", "first"),
        makeSchedule("first-card-2", "first"),
        makeSchedule("second-card", "second"),
      ],
      sessions: [
        makeSession("first-session", "first", ["first-card"]),
        makeSession("second-session", "second", ["second-card"]),
      ],
      reviewLogs: [
        makeReviewLog("by-deck", "first-session", "first", "other-card"),
        makeReviewLog("by-card", "other-session", "other-deck", "first-card"),
        makeReviewLog("by-session", "first-session", "other-deck", "other-card"),
        makeReviewLog("keep-log", "second-session", "second", "second-card"),
      ],
      media: [
        makeMedia(importId, "shared.png"), makeMedia(importId, "first.png"),
        makeMedia(importId, "second.png"), makeMedia(importId, "unused.png"),
      ],
    });
    const service = createDeckRemovalService(fixture.database);
    const preview = await service.previewRemoval("first");
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;

    expect(await service.confirmRemoval(preview.preview)).toEqual({
      status: "committed",
      result: {
        deckId: "first", cardCount: 2, mediaCount: 2,
        deletedSessionIds: ["first-session"],
      },
    });
    expect(await readGraph(fixture.database)).toMatchObject({
      imports: [{ id: importId }],
      decks: [{ id: "second" }],
      notes: [{ id: "shared" }],
      cards: [{ id: "second-card" }],
      schedules: [{ cardId: "second-card" }],
      sessions: [{ id: "second-session" }],
      reviewLogs: [{ id: "keep-log" }],
      media: [
        { name: "second.png" },
        { name: "shared.png" },
      ],
    });
    fixture.database.close();
  });

  test("removes the final import graph and leaves the seed-installed marker unchanged", async () => {
    const opened = await openDatabaseWithSeed({
      factory,
      name: nextDatabaseName("commit-seed"),
      seed: { clock: { now: () => 1_900_000_000_000 } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const repositories = createRepositories(opened.value.database);
    const marker = await repositories.meta.get(SEED_INSTALLED_META_KEY);
    const service = createDeckRemovalService(opened.value.database);
    const preview = await service.previewRemoval(SPANISH_BASICS_DECK_ID);
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;

    expect(await service.confirmRemoval(preview.preview)).toMatchObject({
      status: "committed",
      result: { cardCount: 24, mediaCount: 0 },
    });
    expect(await readGraph(opened.value.database)).toEqual(emptyGraph());
    expect(await repositories.meta.get(SEED_INSTALLED_META_KEY)).toEqual(marker);
    opened.value.database.close();
  });

  test("returns stable missing and stale outcomes without a partial cascade", async () => {
    const fixture = await openFixture("commit-stale", {
      decks: [makeDeck("deck", "import", "Deck")],
      notes: [makeNote("note", "import")],
      cards: [makeCard("card", "deck", "note")],
      media: [],
    });
    const service = createDeckRemovalService(fixture.database);
    const ready = await service.previewRemoval("deck");
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;
    const before = await readGraph(fixture.database);

    expect(await service.confirmRemoval({ ...ready.preview, deckId: "missing" })).toEqual({
      status: "not-found", deckId: "missing",
    });
    expect((await fixture.repositories.cards.add(makeCard("new", "deck", "note"))).ok).toBe(true);
    const changed = await readGraph(fixture.database);
    expect(await service.confirmRemoval(ready.preview)).toEqual({
      status: "stale", deckId: "deck",
    });
    expect(await readGraph(fixture.database)).toEqual(changed);
    expect(before.cards).toHaveLength(1);
    fixture.database.close();
  });

  test("rolls back byte-equivalent durable state at every store boundary and transaction abort", async () => {
    for (const failureAt of [
      ...DECK_REMOVAL_TRANSACTION_BOUNDARIES,
      "transaction-abort" as const,
    ]) {
      const importId = `rollback-${failureAt}`;
      const fixture = await openFixture(`rollback-${failureAt}`, {
        decks: [makeDeck("deck", importId, "Deck")],
        notes: [makeNote("note", importId)],
        cards: [makeCard("card", "deck", "note", [mediaId(importId, "one.png")])],
        schedules: [makeSchedule("card", "deck")],
        sessions: [makeSession("session", "deck", ["card"])],
        reviewLogs: [makeReviewLog("log", "session", "deck", "card")],
        media: [makeMedia(importId, "one.png")],
      });
      const service = createDeckRemovalService(fixture.database);
      const preview = await service.previewRemoval("deck");
      expect(preview.status).toBe("ready");
      if (preview.status !== "ready") throw new Error("preview failed");
      const before = await readGraph(fixture.database);

      expect(await service.confirmRemoval(preview.preview, { failureAt })).toEqual({
        status: "failed",
      });
      expect(await readGraph(fixture.database)).toEqual(before);
      fixture.database.close();
    }
  });
});

async function openFixture(
  label: string,
  records: {
    decks: DeckRecord[];
    notes: NoteRecord[];
    cards: CardRecord[];
    media: MediaRecord[];
    schedules?: ScheduleRecord[];
    sessions?: SessionRecord[];
    reviewLogs?: ReviewLogRecord[];
  },
) {
  const name = nextDatabaseName(label);
  const opened = await openDatabase({ factory, name });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("fixture database did not open");
  const repositories = createRepositories(opened.value);
  const importIds = [...new Set(records.decks.map((deck) => deck.importId))];
  for (const item of importIds.map(makeImport)) expect((await repositories.imports.add(item)).ok).toBe(true);
  for (const deck of records.decks) expect((await repositories.decks.add(deck)).ok).toBe(true);
  for (const note of records.notes) expect((await repositories.notes.add(note)).ok).toBe(true);
  for (const card of records.cards) expect((await repositories.cards.add(card)).ok).toBe(true);
  for (const media of records.media) expect((await repositories.media.add(media)).ok).toBe(true);
  for (const schedule of records.schedules ?? []) expect((await repositories.schedules.add(schedule)).ok).toBe(true);
  for (const session of records.sessions ?? []) expect((await repositories.sessions.add(session)).ok).toBe(true);
  for (const log of records.reviewLogs ?? []) expect((await repositories.reviewLogs.add(log)).ok).toBe(true);
  return { database: opened.value, repositories };
}

async function readGraph(database: IDBDatabase): Promise<DeckRemovalGraphSnapshot> {
  const repositories = createRepositories(database);
  const [imports, decks, notes, cards, schedules, sessions, reviewLogs, media] =
    await Promise.all([
      repositories.imports.list(), repositories.decks.list(), repositories.notes.list(),
      repositories.cards.list(), repositories.schedules.list(), repositories.sessions.list(),
      repositories.reviewLogs.list(), repositories.media.list(),
    ]);
  if (!imports.ok || !decks.ok || !notes.ok || !cards.ok || !schedules.ok
    || !sessions.ok || !reviewLogs.ok || !media.ok) throw new Error("graph read failed");
  return {
    imports: imports.value, decks: decks.value, notes: notes.value,
    cards: cards.value, schedules: schedules.value, sessions: sessions.value,
    reviewLogs: reviewLogs.value, media: media.value,
  };
}

function emptyGraph(
  overrides: Partial<DeckRemovalGraphSnapshot> = {},
): DeckRemovalGraphSnapshot {
  return {
    imports: [], decks: [], notes: [], cards: [], schedules: [],
    sessions: [], reviewLogs: [], media: [], ...overrides,
  };
}

function makeImport(id: string): ImportRecord {
  return {
    id, sha256: id.padEnd(64, "0").slice(0, 64), fileName: `${id}.apkg`,
    fileSize: 1, packageVersion: "test", importedAt: 1, warnings: [],
  };
}

function makeDeck(id: string, importId: string, name: string, cardCount = 0): DeckRecord {
  return {
    id, importId, sourceDeckId: id, name, cardCount, createdAt: 1,
    lastStudiedAt: null, sessionIntakeLimit: 20, schedulerConfigId: "neutral-v1",
  };
}

function makeNote(id: string, importId: string): NoteRecord {
  return {
    id, importId, sourceNoteId: id, guid: id, modelId: "basic",
    fields: { Front: id, Back: id }, tags: [],
  };
}

function makeCard(
  id: string,
  deckId: string,
  noteId: string,
  mediaRefs: string[] = [],
): CardRecord {
  return {
    id, deckId, noteId, sourceCardId: id, templateOrdinal: 0,
    frontText: id, backText: id, css: "", frontHtml: id, backHtml: id,
    mediaRefs, creationOrder: 0, contentWarnings: [],
  };
}

function makeMedia(importId: string, name: string): MediaRecord {
  return {
    importId, name, blob: new Blob([name]), mimeType: "image/png",
    byteLength: name.length, sha256: name.padEnd(64, "a").slice(0, 64),
  };
}

function makeSchedule(cardId: string, deckId: string): ScheduleRecord {
  return {
    cardId, deckId, dueAt: 1, stability: 1, difficulty: 1, elapsedDays: 0,
    scheduledDays: 0, reps: 0, lapses: 0, state: "new", lastReviewAt: null,
    suspended: false,
  };
}

function makeSession(id: string, deckId: string, cardIds: string[]): SessionRecord {
  return {
    id, deckId, dayKey: "2026-09-02", sequence: 1, intakeLimit: 20,
    nextDayAt: 2, queueEntries: cardIds.map((cardId, ordinal) => ({
      cardId, dueAt: 1, ordinal,
    })), activeCardId: cardIds[0] ?? null, plannedPresentationCount: cardIds.length,
    completedPresentationCount: 0, currentSide: "front",
    ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
    startedAt: 1, updatedAt: 1, completedAt: null, lastCommandIds: [],
  };
}

function makeReviewLog(
  id: string,
  sessionId: string,
  deckId: string,
  cardId: string,
): ReviewLogRecord {
  const snapshot = {
    dueAt: 1, stability: 1, difficulty: 1, elapsedDays: 0, scheduledDays: 0,
    reps: 0, lapses: 0, state: "new" as const, lastReviewAt: null,
    suspended: false,
  };
  return {
    id, sessionId, deckId, cardId, rating: "good", reviewedAt: 1,
    durationMs: null, before: snapshot, after: snapshot,
  };
}

function mediaId(importId: string, name: string): string {
  return `${importId}/media/${encodeURIComponent(name)}`;
}

function nextDatabaseName(label: string): string {
  const name = `deck-removal-${label}-${crypto.randomUUID()}`;
  databaseNames.push(name);
  return name;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}
