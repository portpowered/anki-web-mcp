import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import {
  createDeckHomeService,
  DeckHomeService,
  DeckHomeSnapshotRefreshController,
  type DeckHomeSnapshot,
  type DeckHomeSnapshotReader,
} from "../../lib/application/deck-home-service";
import type { DomainResult } from "../../lib/domain/errors";
import { success } from "../../lib/domain/errors";
import { openDatabaseWithSeed } from "../../lib/persistence/seed";
import { createRepositories } from "../../lib/persistence/repositories";
import {
  deckPageStateFromSnapshot,
  formatLastStudied,
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
        dueCount: 24,
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
      dueCount: 22,
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
        dueCount: 0,
        suspendedCount: 1,
        lastStudiedAt: null,
      }),
      expect.objectContaining({
        id: "imported-second",
        name: "Imported second",
        cardCount: 1,
        dueCount: 1,
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
        dueCount: 0,
        suspendedCount: 1,
        lastStudiedLabel: "Studied today",
      }],
    });
    expect(formatLastStudied(null, NOW)).toBe("Not studied yet");
    expect(formatLastStudied(NOW - 86_400_000, NOW)).toBe("Studied 1d ago");
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
      value: { decks: [{ dueCount: 23, suspendedCount: 1 }] },
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
      value: { decks: [{ dueCount: 24, suspendedCount: 0 }] },
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
