import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import {
  createDeckHomeService,
  DeckHomeService,
} from "../../lib/application/deck-home-service";
import { success } from "../../lib/domain/errors";
import { openDatabaseWithSeed } from "../../lib/persistence/seed";
import { createRepositories } from "../../lib/persistence/repositories";
import {
  deckPageStateFromSnapshot,
  formatLastStudied,
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
});

function nextDatabaseName(label: string): string {
  const name = `deck-home-${label}-${crypto.randomUUID()}`;
  databaseNames.push(name);
  return name;
}
