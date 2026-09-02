import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import { createDeckHomeService } from "../../lib/application/deck-home-service";
import {
  createHomeToolController,
  HOME_TOOL_NAMES,
  listDecksInputSchema,
  restoreSuspendedInputSchema,
  selectDeckInputSchema,
} from "../../lib/application/home-webmcp";
import { openDatabaseWithSeed } from "../../lib/persistence/seed";
import { createRepositories } from "../../lib/persistence/repositories";

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

describe("home WebMCP tools", () => {
  test("publishes exactly the documented home definitions", async () => {
    const service = await openService("definitions");
    const controller = createHomeToolController({
      service,
      navigate: () => undefined,
      publishSnapshot: () => undefined,
    });

    expect(controller.tools.map((tool) => tool.name)).toEqual([...HOME_TOOL_NAMES]);
    expect(controller.tools.map((tool) => tool.inputSchema)).toEqual([
      listDecksInputSchema,
      selectDeckInputSchema,
      restoreSuspendedInputSchema,
    ]);
    expect(controller.tools.map((tool) => tool.annotations)).toEqual([
      { readOnlyHint: true, untrustedContentHint: false },
      { readOnlyHint: false, untrustedContentHint: false },
      { readOnlyHint: false, untrustedContentHint: false },
    ]);
    expect(controller.tools.every((tool) => !tool.description.includes("Spanish"))).toBe(true);
    service.close();
  });

  test("lists the same persisted snapshot in visible order without mutating it", async () => {
    const service = await openService("list");
    const published: string[][] = [];
    const controller = createHomeToolController({
      service,
      navigate: () => undefined,
      publishSnapshot: (snapshot) => published.push(snapshot.decks.map((deck) => deck.id)),
    });
    const before = await service.readSnapshot();
    const result = await controller.execute("list_decks", {});
    const after = await service.readSnapshot();

    expect(result).toEqual({
      ok: true,
      data: {
        page: "decks",
        decks: [{
          id: "seed-spanish-basics",
          name: "Spanish Basics",
          card_count: 24,
          new_count: 24,
          due_count: 0,
          suspended_count: 0,
          last_studied_at: null,
          can_start_session: true,
        }],
      },
    });
    expect(after).toEqual(before);
    expect(published).toEqual([["seed-spanish-basics"]]);
    expect(await controller.execute("list_decks", { extra: true })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", recoverable: true },
    });
    service.close();
  });

  test("selects through the durable session boundary and navigates with an encoded id", async () => {
    const service = await openService("select");
    const destinations: string[] = [];
    const controller = createHomeToolController({
      service,
      navigate: (href) => destinations.push(href),
      publishSnapshot: () => undefined,
    });

    expect(await controller.execute("select_deck", {
      deck_id: "seed-spanish-basics",
    })).toMatchObject({
      ok: true,
      data: {
        page: "study",
        deck_id: "seed-spanish-basics",
        session: { sequence: 1, status: "created" },
        caught_up: false,
      },
    });
    expect(destinations).toEqual(["/study/?deck=seed-spanish-basics"]);

    expect(await controller.execute("select_deck", { deck_id: "missing" })).toMatchObject({
      ok: false,
      error: { code: "DECK_NOT_FOUND" },
    });
    service.close();
  });

  test("classifies navigation failure after a committed start and safely resumes on retry", async () => {
    const service = await openService("navigation");
    const failing = createHomeToolController({
      service,
      navigate: () => { throw new Error("router unavailable"); },
      publishSnapshot: () => undefined,
    });
    expect(await failing.execute("select_deck", {
      deck_id: "seed-spanish-basics",
    })).toMatchObject({
      ok: false,
      error: { code: "NAVIGATION_ERROR", recoverable: true },
    });

    const retry = createHomeToolController({
      service,
      navigate: () => undefined,
      publishSnapshot: () => undefined,
    });
    expect(await retry.execute("select_deck", {
      deck_id: "seed-spanish-basics",
    })).toMatchObject({
      ok: true,
      data: { session: { sequence: 1, status: "resumed" } },
    });
    service.close();
  });

  test("restores idempotently, publishes committed counts, and preserves exact scheduling memory", async () => {
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
      dueAt: NOW + 12_345,
      stability: 8.5,
      difficulty: 4.25,
      reps: 7,
      lapses: 2,
      state: "review" as const,
      lastReviewAt: NOW - 50_000,
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
    const published: number[] = [];
    const controller = createHomeToolController({
      service: service.value,
      navigate: () => undefined,
      publishSnapshot: (snapshot) => published.push(snapshot.decks[0]!.suspendedCount),
    });
    expect(await controller.execute("restore_suspended", {
      deck_id: "seed-spanish-basics",
      command_id: "restore-1",
    })).toMatchObject({
      ok: true,
      data: { restored_count: 1, idempotent: false },
    });
    expect(await controller.execute("restore_suspended", {
      deck_id: "seed-spanish-basics",
      command_id: "restore-1",
    })).toMatchObject({
      ok: true,
      data: { restored_count: 1, idempotent: true },
    });
    expect(published).toEqual([0, 0]);
    service.value.close();

    const verification = await openDatabaseWithSeed({ factory, name });
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    const restored = await createRepositories(verification.value.database).schedules.get(original.cardId);
    expect(restored.ok && restored.value).toEqual({ ...original, suspended: false });
    verification.value.database.close();
  });

  test("rejects malformed and inactive calls with stable serializable envelopes", async () => {
    const service = await openService("errors");
    let active = true;
    const controller = createHomeToolController({
      service,
      navigate: () => undefined,
      publishSnapshot: () => undefined,
      isActive: () => active,
    });
    expect(await controller.execute("restore_suspended", {
      deck_id: "seed-spanish-basics",
      command_id: "",
    })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    active = false;
    const inactive = await controller.execute("list_decks", {});
    expect(inactive).toMatchObject({ ok: false, error: { code: "WRONG_PAGE" } });
    expect(() => JSON.stringify(inactive)).not.toThrow();
    service.close();
  });
});

async function openService(label: string) {
  const result = await createDeckHomeService(
    {
      factory,
      name: nextDatabaseName(label),
      seed: { clock: { now: () => NOW } },
    },
    { now: () => NOW },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function nextDatabaseName(label: string): string {
  const name = `home-webmcp-${label}-${crypto.randomUUID()}`;
  databaseNames.push(name);
  return name;
}
