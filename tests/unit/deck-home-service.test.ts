import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import {
  createDeckHomeService,
  clearDeletedActiveSessionPointer,
  DeckHomeService,
  DeckRemovalCommitController,
  DeckHomeSnapshotRefreshController,
  type DeckHomeSnapshot,
  type DeckHomeSnapshotReader,
} from "../../lib/application/deck-home-service";
import type { DomainResult } from "../../lib/domain/errors";
import { success } from "../../lib/domain/errors";
import { openDatabaseWithSeed } from "../../lib/persistence/seed";
import { ACTIVE_SESSION_STORAGE_KEY } from "../../lib/application/persistence";
import { createRepositories } from "../../lib/persistence/repositories";
import {
  confirmDeckRemovalOnce,
  deckPageStateFromSnapshot,
  selectDeckAndNavigate,
} from "../../components/deck-route-preview";

const NOW = 1_800_000_000_000;
const factory = new IDBFactory();
const databaseNames: string[] = [];

afterEach(async () => {
  for (const name of databaseNames.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
});

describe("deck home service", () => {
  test("deduplicates confirmation, selectively clears its session pointer, and refreshes once", async () => {
    const commit = deferred<ReturnType<BrowserRemovalService["confirmRemoval"]> extends Promise<infer T> ? T : never>();
    const pointer = memoryStorage("removed-session");
    let confirmations = 0;
    let reads = 0;
    const published: DeckHomeSnapshot[] = [];
    const service: BrowserRemovalService = {
      confirmRemoval: async () => {
        confirmations += 1;
        return commit.promise;
      },
      readSnapshot: async () => {
        reads += 1;
        return success({ capturedAt: NOW, decks: [] });
      },
    };
    const controller = new DeckRemovalCommitController(
      service,
      new DeckHomeSnapshotRefreshController(),
      pointer,
    );
    const preview = removalPreview();

    const first = controller.confirm(preview, (snapshot) => published.push(snapshot));
    const duplicate = controller.confirm(preview, (snapshot) => published.push(snapshot));
    expect(first).toBe(duplicate);
    expect(confirmations).toBe(1);

    commit.resolve({
      status: "committed",
      result: {
        deckId: preview.deckId,
        cardCount: preview.cardCount,
        mediaCount: preview.mediaCount,
        deletedSessionIds: ["removed-session"],
      },
    });

    expect(await first).toMatchObject({ status: "committed", refresh: "applied" });
    expect(pointer.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBeNull();
    expect(reads).toBe(1);
    expect(published).toEqual([{ capturedAt: NOW, decks: [] }]);
  });

  test("does not refresh or clear a newer pointer when confirmation fails", async () => {
    const pointer = memoryStorage("newer-session");
    let reads = 0;
    const controller = new DeckRemovalCommitController({
      confirmRemoval: async () => ({ status: "stale", deckId: "biology" }),
      readSnapshot: async () => {
        reads += 1;
        return success({ capturedAt: NOW, decks: [] });
      },
    }, new DeckHomeSnapshotRefreshController(), pointer);

    expect(await controller.confirm(removalPreview(), () => undefined)).toEqual({
      status: "stale",
      deckId: "biology",
    });
    expect(pointer.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe("newer-session");
    expect(reads).toBe(0);
    expect(clearDeletedActiveSessionPointer(["older-session"], pointer)).toBe(false);
  });

  test("preserves a newer pointer after commit and contains refresh exceptions", async () => {
    const pointer = memoryStorage("newer-session");
    const controller = new DeckRemovalCommitController({
      confirmRemoval: async () => ({
        status: "committed",
        result: {
          deckId: "biology",
          cardCount: 2,
          mediaCount: 1,
          deletedSessionIds: ["older-session"],
        },
      }),
      readSnapshot: async () => { throw new Error("raw database failure"); },
    }, new DeckHomeSnapshotRefreshController(), pointer);

    expect(await controller.confirm(removalPreview(), () => undefined)).toMatchObject({
      status: "committed",
      refresh: "failed",
    });
    expect(pointer.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe("newer-session");
  });

  test("routes one explicit confirmation to the shared removal service exactly once", async () => {
    let confirmations = 0;
    const preview = {
      deckId: "biology",
      deckName: "Biology",
      cardCount: 2,
      mediaCount: 1,
      revision: "opaque",
    };
    const result = await confirmDeckRemovalOnce({
      confirmRemoval: async (received) => {
        confirmations += 1;
        expect(received).toBe(preview);
        return {
          status: "committed",
          result: { deckId: "biology", cardCount: 2, mediaCount: 1, deletedSessionIds: [] },
        };
      },
    }, preview);

    expect(confirmations).toBe(1);
    expect(result.status).toBe("committed");
  });

  test("publishes only the newest snapshot when reads resolve out of order", async () => {
    const refresh = new DeckHomeSnapshotRefreshController();
    const first = deferred<DomainResult<DeckHomeSnapshot>>();
    const second = deferred<DomainResult<DeckHomeSnapshot>>();
    const reads = [first, second];
    const reader: DeckHomeSnapshotReader = {
      readSnapshot: () => reads.shift()!.promise,
    };
    const published: DeckHomeSnapshot[] = [];

    const initialRefresh = refresh.refresh(reader, (snapshot) => published.push(snapshot));
    const committedRefresh = refresh.refresh(reader, (snapshot) => published.push(snapshot));
    second.resolve(success({ capturedAt: NOW + 1, decks: [] }));
    expect(await committedRefresh).toBe("applied");
    first.resolve(success({ capturedAt: NOW, decks: [] }));
    expect(await initialRefresh).toBe("stale");
    expect(published.map((snapshot) => snapshot.capturedAt)).toEqual([NOW + 1]);
  });

  test("invalidates a pending snapshot when its route unmounts", async () => {
    const refresh = new DeckHomeSnapshotRefreshController();
    const pending = deferred<DomainResult<DeckHomeSnapshot>>();
    const published: DeckHomeSnapshot[] = [];
    const result = refresh.refresh(
      { readSnapshot: () => pending.promise },
      (snapshot) => published.push(snapshot),
    );

    refresh.invalidate();
    pending.resolve(success({ capturedAt: NOW, decks: [] }));

    expect(await result).toBe("stale");
    expect(published).toEqual([]);
  });

  test("installs Spanish Basics once and returns persisted metadata after reload", async () => {
    const name = nextDatabaseName("fresh");
    const first = await createDeckHomeService(
      { factory, name, seed: { clock: { now: () => NOW } } },
      { now: () => NOW },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const initial = await first.value.readSnapshot();
    expect(initial).toEqual(success({
      capturedAt: NOW,
      decks: [{
        id: "seed-spanish-basics",
        name: "Spanish Basics",
        cardCount: 24,
        newCount: 20,
        dueCount: 0,
        suspendedCount: 0,
        lastStudiedAt: null,
        canStartSession: true,
      }],
    }));
    first.value.close();

    const reopened = await createDeckHomeService(
      { factory, name },
      { now: () => NOW },
    );
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(await reopened.value.readSnapshot()).toEqual(initial);
    reopened.value.close();
  });

  test("respects deliberate deletion instead of recreating the seed", async () => {
    const name = nextDatabaseName("deleted");
    const opened = await openDatabaseWithSeed({
      factory,
      name,
      seed: { clock: { now: () => NOW } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const repositories = createRepositories(opened.value.database);
    expect((await repositories.decks.delete("seed-spanish-basics")).ok).toBe(true);
    opened.value.database.close();

    const service = await createDeckHomeService(
      { factory, name },
      { now: () => NOW },
    );
    expect(service.ok).toBe(true);
    if (!service.ok) return;
    expect(await service.value.readSnapshot()).toEqual(success({
      capturedAt: NOW,
      decks: [],
    }));
    service.value.close();
  });

  test("hides a legacy empty package deck from the user projection", async () => {
    const name = nextDatabaseName("legacy-empty-deck");
    const opened = await openDatabaseWithSeed({
      factory,
      name,
      seed: { clock: { now: () => NOW } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const repositories = createRepositories(opened.value.database);
    const seedDeck = await repositories.decks.get("seed-spanish-basics");
    expect(seedDeck.ok && seedDeck.value).toBeTruthy();
    if (!seedDeck.ok || !seedDeck.value) return;
    expect((await repositories.decks.put({
      ...seedDeck.value,
      id: "legacy-empty-default",
      importId: "legacy-import",
      sourceDeckId: "1",
      name: "Default",
      cardCount: 0,
    })).ok).toBe(true);

    const snapshot = await new DeckHomeService(repositories, { now: () => NOW }).readSnapshot();
    expect(snapshot.ok && snapshot.value.decks.map((deck) => deck.name)).toEqual([
      "Spanish Basics",
    ]);
    opened.value.database.close();
  });

  test("derives due and suspended values from the same service snapshot", async () => {
    const name = nextDatabaseName("metadata");
    const opened = await openDatabaseWithSeed({
      factory,
      name,
      seed: { clock: { now: () => NOW } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const repositories = createRepositories(opened.value.database);
    const schedules = await repositories.schedules.listByDeckId("seed-spanish-basics");
    expect(schedules.ok).toBe(true);
    if (!schedules.ok) return;

    expect((await repositories.schedules.put({
      ...schedules.value[0]!,
      suspended: true,
    })).ok).toBe(true);
    expect((await repositories.schedules.put({
      ...schedules.value[1]!,
      dueAt: NOW + 1,
    })).ok).toBe(true);
    const deck = await repositories.decks.get("seed-spanish-basics");
    expect(deck.ok).toBe(true);
    if (!deck.ok) return;
    expect((await repositories.decks.put({
      ...deck.value,
      lastStudiedAt: NOW - 86_400_000,
    })).ok).toBe(true);

    const snapshot = await new DeckHomeService(
      repositories,
      { now: () => NOW },
    ).readSnapshot();
    expect(snapshot.ok && snapshot.value.decks[0]).toMatchObject({
      cardCount: 24,
      newCount: 20,
      dueCount: 0,
      suspendedCount: 1,
      lastStudiedAt: NOW - 86_400_000,
    });
    opened.value.database.close();
  });

  test("refreshes every newly persisted deck with shared metadata and ordering", async () => {
    const name = nextDatabaseName("import-refresh");
    const opened = await openDatabaseWithSeed({
      factory,
      name,
      seed: { clock: { now: () => NOW } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const repositories = createRepositories(opened.value.database);
    const originalDeck = await repositories.decks.get("seed-spanish-basics");
    const originalCards = await repositories.cards.listByDeckId("seed-spanish-basics");
    const originalSchedules = await repositories.schedules.listByDeckId("seed-spanish-basics");
    expect(originalDeck.ok && originalCards.ok && originalSchedules.ok).toBe(true);
    if (!originalDeck.ok || !originalCards.ok || !originalSchedules.ok) return;

    const importedDecks = [
      { id: "imported-second", name: "Imported second", createdAt: NOW + 20 },
      { id: "imported-first", name: "Imported first", createdAt: NOW + 10 },
    ];
    for (const [index, imported] of importedDecks.entries()) {
      expect((await repositories.decks.put({
        ...originalDeck.value,
        ...imported,
        importId: "multi-deck-import",
        cardCount: 1,
        lastStudiedAt: index === 0 ? NOW : null,
      })).ok).toBe(true);
      const cardId = `${imported.id}-card`;
      expect((await repositories.cards.put({
        ...originalCards.value[0]!,
        id: cardId,
        deckId: imported.id,
      })).ok).toBe(true);
      expect((await repositories.schedules.put({
        ...originalSchedules.value[0]!,
        cardId,
        deckId: imported.id,
        suspended: index === 1,
      })).ok).toBe(true);
    }

    const refresh = new DeckHomeSnapshotRefreshController();
    const published: DeckHomeSnapshot[] = [];
    expect(await refresh.refresh(
      new DeckHomeService(repositories, { now: () => NOW }),
      (snapshot) => published.push(snapshot),
    )).toBe("applied");
    expect(published[0]?.decks.slice(1)).toEqual([
      expect.objectContaining({
        id: "imported-first",
        name: "Imported first",
        cardCount: 1,
        newCount: 0,
        dueCount: 0,
        suspendedCount: 1,
        lastStudiedAt: null,
      }),
      expect.objectContaining({
        id: "imported-second",
        name: "Imported second",
        cardCount: 1,
        newCount: 1,
        dueCount: 0,
        suspendedCount: 0,
        lastStudiedAt: NOW,
      }),
    ]);
    opened.value.database.close();

    const reopened = await createDeckHomeService({ factory, name }, { now: () => NOW });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(await reopened.value.readSnapshot()).toMatchObject({
      ok: true,
      value: {
        decks: [
          { id: "seed-spanish-basics" },
          { id: "imported-first" },
          { id: "imported-second" },
        ],
      },
    });
    reopened.value.close();
  });

  test("maps populated and empty snapshots to stable presentation states", () => {
    expect(deckPageStateFromSnapshot({ capturedAt: NOW, decks: [] })).toEqual({
      kind: "empty",
    });
    expect(deckPageStateFromSnapshot({
      capturedAt: NOW,
      decks: [{
        id: "deck",
        name: "Durable deck",
        cardCount: 2,
        newCount: 1,
        dueCount: 0,
        suspendedCount: 1,
        lastStudiedAt: NOW,
        canStartSession: false,
      }],
    })).toEqual({
      kind: "populated",
      decks: [{
        id: "deck",
        name: "Durable deck",
        cardCount: 2,
        newCount: 1,
        dueCount: 0,
        suspendedCount: 1,
      }],
    });
  });

  test("selects once under concurrent activation and resumes the durable session", async () => {
    const name = nextDatabaseName("select-concurrent");
    const service = await createDeckHomeService(
      { factory, name, seed: { clock: { now: () => NOW } } },
      { now: () => NOW },
    );
    expect(service.ok).toBe(true);
    if (!service.ok) return;

    const [first, second] = await Promise.all([
      service.value.selectDeck("seed-spanish-basics"),
      service.value.selectDeck("seed-spanish-basics"),
    ]);

    expect([first.status, second.status].sort()).toEqual(["created", "resumed"]);
    expect(first.session?.id).toBe(second.session?.id);
    expect(first.session?.sequence).toBe(1);
    expect((await service.value.selectDeck("seed-spanish-basics")).status).toBe("resumed");
    service.value.close();

    const reopened = await createDeckHomeService(
      { factory, name },
      { now: () => NOW },
    );
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const resumed = await reopened.value.selectDeck("seed-spanish-basics");
    expect(resumed.status).toBe("resumed");
    expect(resumed.session?.id).toBe(first.session?.id);
    reopened.value.close();
  });

  test("projects new counts from the active session and then the next bounded intake", async () => {
    const name = nextDatabaseName("session-aware-counts");
    const opened = await openDatabaseWithSeed({
      factory,
      name,
      seed: { clock: { now: () => NOW } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const repositories = createRepositories(opened.value.database);
    const service = await createDeckHomeService({ factory, name }, { now: () => NOW });
    expect(service.ok).toBe(true);
    if (!service.ok) return;

    const selected = await service.value.selectDeck("seed-spanish-basics");
    expect(selected.status).toBe("created");
    expect(selected.session?.queueEntries).toHaveLength(20);
    expect(await service.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { decks: [{ newCount: 20, dueCount: 0 }] },
    });
    if (!selected.session) return;

    const admittedCardIds = selected.session.queueEntries.map((entry) => entry.cardId);
    const firstSchedule = await repositories.schedules.get(admittedCardIds[0]!);
    expect(firstSchedule.ok && firstSchedule.value).toBeTruthy();
    if (!firstSchedule.ok || !firstSchedule.value) return;
    expect((await repositories.schedules.put({
      ...firstSchedule.value,
      state: "review",
      dueAt: selected.session.nextDayAt,
    })).ok).toBe(true);
    expect((await repositories.sessions.put({
      ...selected.session,
      queueEntries: selected.session.queueEntries.slice(1),
      activeCardId: selected.session.queueEntries[1]!.cardId,
      completedPresentationCount: 1,
      updatedAt: NOW,
    })).ok).toBe(true);
    expect(await service.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { decks: [{ newCount: 19, dueCount: 0 }] },
    });

    for (const cardId of admittedCardIds.slice(1)) {
      const schedule = await repositories.schedules.get(cardId);
      expect(schedule.ok && schedule.value).toBeTruthy();
      if (!schedule.ok || !schedule.value) return;
      expect((await repositories.schedules.put({
        ...schedule.value,
        state: "review",
        dueAt: selected.session.nextDayAt,
      })).ok).toBe(true);
    }
    expect((await repositories.sessions.put({
      ...selected.session,
      queueEntries: [],
      activeCardId: null,
      completedPresentationCount: 20,
      completedAt: NOW,
      updatedAt: NOW,
    })).ok).toBe(true);
    expect(await service.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { decks: [{ newCount: 4, dueCount: 0 }] },
    });

    service.value.close();
    opened.value.database.close();
  });

  test("lists and enqueues overdue cards abandoned in a prior-day session", async () => {
    const name = nextDatabaseName("prior-day-overdue-intake");
    const opened = await openDatabaseWithSeed({
      factory,
      name,
      seed: { clock: { now: () => NOW } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const repositories = createRepositories(opened.value.database);
    const schedules = await repositories.schedules.listByDeckId("seed-spanish-basics");
    expect(schedules.ok).toBe(true);
    if (!schedules.ok) return;
    const overdueAt = NOW - 86_400_000;
    const abandoned = schedules.value.slice(0, 20);
    for (const schedule of abandoned) {
      expect((await repositories.schedules.put({
        ...schedule,
        state: "review",
        dueAt: overdueAt,
      })).ok).toBe(true);
    }
    expect((await repositories.sessions.put({
      id: "prior-day-session",
      deckId: "seed-spanish-basics",
      dayKey: "2027-01-14",
      sequence: 1,
      intakeLimit: 20,
      nextDayAt: NOW - 1,
      queueEntries: abandoned.map((schedule, index) => ({
        cardId: schedule.cardId,
        dueAt: overdueAt,
        ordinal: index + 1,
      })),
      activeCardId: abandoned[0]!.cardId,
      plannedPresentationCount: 20,
      completedPresentationCount: 0,
      currentSide: "front",
      ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
      startedAt: overdueAt,
      updatedAt: overdueAt,
      completedAt: null,
      lastCommandIds: [],
    })).ok).toBe(true);
    opened.value.database.close();

    const service = await createDeckHomeService({ factory, name }, { now: () => NOW });
    expect(service.ok).toBe(true);
    if (!service.ok) return;
    expect(await service.value.readSnapshot()).toMatchObject({
      ok: true,
      value: {
        decks: [{ newCount: 0, dueCount: 20, canStartSession: true }],
      },
    });

    const selected = await service.value.selectDeck("seed-spanish-basics");
    expect(selected).toMatchObject({
      status: "created",
      session: {
        sequence: 1,
        plannedPresentationCount: 20,
      },
    });
    expect(selected.session?.queueEntries.map((entry) => entry.cardId).sort()).toEqual(
      abandoned.map((schedule) => schedule.cardId).sort(),
    );
    service.value.close();
  });

  test("navigates only after a successful selection and safely resumes after navigation failure", async () => {
    const name = nextDatabaseName("navigation-failure");
    const service = await createDeckHomeService(
      { factory, name, seed: { clock: { now: () => NOW } } },
      { now: () => NOW },
    );
    expect(service.ok).toBe(true);
    if (!service.ok) return;

    await expect(selectDeckAndNavigate(
      service.value,
      "seed-spanish-basics",
      () => { throw new Error("navigation unavailable"); },
    )).rejects.toThrow("navigation unavailable");

    const destinations: string[] = [];
    const retry = await selectDeckAndNavigate(
      service.value,
      "seed-spanish-basics",
      (href) => destinations.push(href),
    );
    expect(retry.status).toBe("resumed");
    expect(retry.session?.sequence).toBe(1);
    expect(destinations).toEqual(["/study/?deck=seed-spanish-basics"]);
    service.value.close();
  });

  test("returns caught-up without creating an empty session", async () => {
    const name = nextDatabaseName("caught-up");
    const opened = await openDatabaseWithSeed({
      factory,
      name,
      seed: { clock: { now: () => NOW } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const repositories = createRepositories(opened.value.database);
    const schedules = await repositories.schedules.listByDeckId("seed-spanish-basics");
    expect(schedules.ok).toBe(true);
    if (!schedules.ok) return;
    for (const schedule of schedules.value) {
      expect((await repositories.schedules.put({
        ...schedule,
        dueAt: NOW + 7 * 86_400_000,
        state: "review",
      })).ok).toBe(true);
    }
    opened.value.database.close();

    const service = await createDeckHomeService(
      { factory, name },
      { now: () => NOW },
    );
    expect(service.ok).toBe(true);
    if (!service.ok) return;
    expect(await service.value.selectDeck("seed-spanish-basics")).toMatchObject({
      status: "no-session",
      reason: "caught-up",
      session: null,
    });
    service.value.close();

    const verification = await openDatabaseWithSeed({ factory, name });
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    const sessions = await createRepositories(verification.value.database).sessions.list();
    expect(sessions.ok).toBe(true);
    if (sessions.ok) expect(sessions.value).toEqual([]);
    verification.value.database.close();
  });

  test("restores only suspended schedules, preserves memory, and refreshes home counts", async () => {
    const name = nextDatabaseName("restore");
    const opened = await openDatabaseWithSeed({
      factory,
      name,
      seed: { clock: { now: () => NOW } },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const repositories = createRepositories(opened.value.database);
    const schedules = await repositories.schedules.listByDeckId("seed-spanish-basics");
    expect(schedules.ok).toBe(true);
    if (!schedules.ok) return;
    const original = {
      ...schedules.value[0]!,
      dueAt: NOW - 1234,
      stability: 7.5,
      difficulty: 6.25,
      elapsedDays: 4,
      scheduledDays: 9,
      reps: 8,
      lapses: 2,
      state: "review" as const,
      lastReviewAt: NOW - 10_000,
      suspended: true,
    };
    expect((await repositories.schedules.put(original)).ok).toBe(true);
    opened.value.database.close();

    const service = await createDeckHomeService(
      { factory, name },
      { now: () => NOW },
    );
    expect(service.ok).toBe(true);
    if (!service.ok) return;
    expect(await service.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { decks: [{ newCount: 20, dueCount: 0, suspendedCount: 1 }] },
    });
    const restored = await service.value.restoreSuspended(
      "seed-spanish-basics",
      "restore-home",
    );
    expect(restored).toMatchObject({ status: "restored", restoredCount: 1 });
    expect(await service.value.restoreSuspended(
      "seed-spanish-basics",
      "restore-home",
    )).toEqual({ ...restored, status: "already-restored", kind: "already-restored", changed: false, idempotent: true });
    expect(await service.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { decks: [{ newCount: 19, dueCount: 1, suspendedCount: 0 }] },
    });
    service.value.close();

    const verification = await openDatabaseWithSeed({ factory, name });
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    const durable = await createRepositories(verification.value.database).schedules.get(original.cardId);
    expect(durable.ok && durable.value).toEqual({ ...original, suspended: false });
    verification.value.database.close();
  });
});

type BrowserRemovalService = Pick<
  import("../../lib/application/deck-home-service").BrowserDeckHomeService,
  "confirmRemoval" | "readSnapshot"
>;

function removalPreview() {
  return {
    deckId: "biology",
    deckName: "Biology",
    cardCount: 2,
    mediaCount: 1,
    revision: "opaque",
  };
}

function memoryStorage(initial: string | null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(ACTIVE_SESSION_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key); },
  };
}

function nextDatabaseName(label: string): string {
  const name = `deck-home-${label}-${crypto.randomUUID()}`;
  databaseNames.push(name);
  return name;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
