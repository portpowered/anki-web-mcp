import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import { createStudyRouteService } from "../../lib/application/study-route-service";
import {
  createStudyToolController,
  flipInputSchema,
  getStudyStateInputSchema,
  goHomeInputSchema,
  setStudyStateInputSchema,
  STUDY_TOOL_NAMES,
  suspendInputSchema,
} from "../../lib/application/study-webmcp";

const NOW = 1_800_000_000_000;
const DECK_ID = "seed-spanish-basics";
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

describe("study WebMCP tools", () => {
  test("publishes exactly the five production study definitions", async () => {
    const { service, controller } = await openController("definitions");
    expect(controller.tools.map((tool) => tool.name)).toEqual([...STUDY_TOOL_NAMES]);
    expect(controller.tools.map((tool) => tool.inputSchema)).toEqual([
      getStudyStateInputSchema,
      flipInputSchema,
      setStudyStateInputSchema,
      suspendInputSchema,
      goHomeInputSchema,
    ]);
    expect(controller.tools.map((tool) => tool.annotations)).toEqual([
      { readOnlyHint: true, untrustedContentHint: true },
      { readOnlyHint: false, untrustedContentHint: false },
      { readOnlyHint: false, untrustedContentHint: false },
      { readOnlyHint: false, untrustedContentHint: false },
      { readOnlyHint: false, untrustedContentHint: false },
    ]);
    expect(controller.tools.every((tool) => !tool.description.includes("Spanish"))).toBe(true);
    service.close();
  });

  test("get_state mirrors the committed front state and withholds the answer", async () => {
    const published: string[] = [];
    const { service, controller } = await openController("get-state", {
      publish: (kind) => published.push(kind),
    });
    const result = await controller.execute("get_state", {});
    expect(result).toMatchObject({
      ok: true,
      data: {
        state: {
          page: "study",
          status: "active",
          deck: { id: DECK_ID, name: "Spanish Basics" },
          session: { sequence: 1, completed_presentations: 0, planned_presentations: 20 },
          current_card: {
            side: "front",
            front_text: "hola",
            rating_previews: {
              again: { interval: expect.any(String), due_at: expect.any(String) },
              hard: { interval: expect.any(String), due_at: expect.any(String) },
              good: { interval: expect.any(String), due_at: expect.any(String) },
              easy: { interval: expect.any(String), due_at: expect.any(String) },
            },
          },
          allowed_actions: ["get_state", "flip", "suspend", "go_home"],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("hello");
    expect(published).toEqual(["active"]);
    service.close();
  });

  test("flip and every rating publish the committed visible state with guarded transitions", async () => {
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      const { service, controller } = await openController(`rating-${rating}`);
      const front = await stateData(controller);
      const cardId = front.current_card!.id;

      expect(await controller.execute("set_state", {
        card_id: cardId,
        command_id: `early-${rating}`,
        rating,
      })).toMatchObject({ ok: false, error: { code: "ANSWER_NOT_REVEALED" } });

      expect(await controller.execute("flip", {
        card_id: cardId,
        command_id: `flip-${rating}`,
      })).toMatchObject({
        ok: true,
        data: {
          command_id: `flip-${rating}`,
          reveal: { changed: true, idempotent: false },
          state: { current_card: { id: cardId, side: "back", back_text: "hello" } },
        },
      });
      expect(await controller.execute("flip", {
        card_id: cardId,
        command_id: `flip-${rating}`,
      })).toMatchObject({
        ok: true,
        data: {
          command_id: `flip-${rating}`,
          reveal: { changed: false, idempotent: true },
          state: { current_card: { id: cardId, side: "back", back_text: "hello" } },
        },
      });

      const rated = await controller.execute("set_state", {
        card_id: cardId,
        command_id: `rate-${rating}`,
        rating,
      });
      expect(rated).toMatchObject({
        ok: true,
        data: {
          command_id: `rate-${rating}`,
          transition: {
            rating,
            reviewed_card_id: cardId,
            previous_due_at: expect.any(String),
            next_due_at: expect.any(String),
            idempotent: false,
          },
          state: { session: { completed_presentations: 1 } },
        },
      });
      expect(() => JSON.stringify(rated)).not.toThrow();
      service.close();
    }
  });

  test("retries are idempotent and stale, duplicate, concurrent, and inactive calls are safe", async () => {
    let active = true;
    const { service, controller } = await openController("guards", {
      active: () => active,
    });
    const cardId = (await stateData(controller)).current_card!.id;
    await controller.execute("flip", { card_id: cardId, command_id: "flip-1" });

    const input = { card_id: cardId, command_id: "rate-1", rating: "good" };
    const [first, concurrent] = await Promise.all([
      controller.execute("set_state", input),
      controller.execute("set_state", input),
    ]);
    expect(first).toEqual(concurrent);
    expect(first).toMatchObject({ ok: true, data: { transition: { idempotent: false } } });
    expect(await controller.execute("set_state", input)).toMatchObject({
      ok: true,
      data: { transition: { idempotent: true } },
    });
    expect(await controller.execute("suspend", {
      card_id: cardId,
      command_id: "rate-1",
    })).toMatchObject({ ok: false, error: { code: "DUPLICATE_COMMAND" } });
    expect(await controller.execute("suspend", {
      card_id: cardId,
      command_id: "suspend-stale",
    })).toMatchObject({ ok: false, error: { code: "STALE_CARD" } });

    active = false;
    expect(await controller.execute("get_state", {})).toMatchObject({
      ok: false,
      error: { code: "WRONG_PAGE" },
    });
    service.close();
  });

  test("an execution invalidated at the service boundary rolls back and cannot publish", async () => {
    const name = `study-webmcp-late-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const service = await createStudyRouteService(
      { factory, name, seed: { clock: { now: () => NOW } } },
      { now: () => NOW },
    );
    const initial = await service.load(DECK_ID);
    if (initial.kind !== "active") throw new Error("expected an active session");
    let active = true;
    const published: string[] = [];
    const controller = createStudyToolController({
      service: {
        load: (deckId) => service.load(deckId),
        reveal: (sessionId, cardId, canCommit) => {
          active = false;
          return service.reveal(sessionId, cardId, canCommit);
        },
        rate: (...args) => service.rate(...args),
        suspend: (...args) => service.suspend(...args),
      },
      deckId: DECK_ID,
      publishSnapshot: (snapshot) => published.push(snapshot.kind),
      navigateHome: () => undefined,
      readHomeDeckCount: async () => 1,
      isActive: () => active,
    });

    expect(await controller.execute("flip", {
      card_id: initial.cardId,
      command_id: "late-flip",
    })).toMatchObject({ ok: false, error: { code: "WRONG_PAGE" } });
    const durable = await service.load(DECK_ID);
    expect(durable).toMatchObject({
      kind: "active",
      cardId: initial.cardId,
      side: "front",
    });
    expect(published).toEqual([]);
    service.close();
  });

  test("a registration abort during an in-flight mutation rolls back without late publication", async () => {
    const name = `study-webmcp-abort-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const service = await createStudyRouteService(
      { factory, name, seed: { clock: { now: () => NOW } } },
      { now: () => NOW },
    );
    const initial = await service.load(DECK_ID);
    if (initial.kind !== "active") throw new Error("expected an active session");
    const registration = new AbortController();
    const published: string[] = [];
    const controller = createStudyToolController({
      service: {
        load: (deckId) => service.load(deckId),
        reveal: (sessionId, cardId, canCommit) => {
          registration.abort();
          return service.reveal(sessionId, cardId, canCommit);
        },
        rate: (...args) => service.rate(...args),
        suspend: (...args) => service.suspend(...args),
      },
      deckId: DECK_ID,
      publishSnapshot: (snapshot) => published.push(snapshot.kind),
      navigateHome: () => undefined,
      readHomeDeckCount: async () => 1,
    });

    expect(await controller.execute("flip", {
      card_id: initial.cardId,
      command_id: "aborted-flip",
    }, { signal: registration.signal })).toMatchObject({
      ok: false,
      error: { code: "WRONG_PAGE" },
    });
    expect(await service.load(DECK_ID)).toMatchObject({
      kind: "active",
      cardId: initial.cardId,
      side: "front",
    });
    expect(published).toEqual([]);
    service.close();
  });

  test("suspend advances durable state and go_home reports the visible deck count", async () => {
    const destinations: string[] = [];
    const { service, controller } = await openController("suspend-home", {
      navigate: () => destinations.push("/"),
      deckCount: 1,
    });
    const cardId = (await stateData(controller)).current_card!.id;
    expect(await controller.execute("suspend", {
      card_id: cardId,
      command_id: "suspend-1",
    })).toMatchObject({
      ok: true,
      data: {
        suspension: {
          suspended_card_id: cardId,
          removed_occurrence_count: 1,
          outcome: "active",
          idempotent: false,
        },
        state: { status: "active" },
      },
    });
    expect(await controller.execute("go_home", {})).toEqual({
      ok: true,
      data: { page: "decks", deck_count: 1 },
    });
    expect(destinations).toEqual(["/"]);
    service.close();
  });

  test("rejects malformed inputs and unavailable cards with stable envelopes", async () => {
    const { service, controller } = await openController("invalid");
    expect(await controller.execute("flip", { card_id: "", command_id: "x" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await controller.execute("set_state", {
      card_id: "card",
      command_id: "x",
      rating: "best",
    })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await controller.execute("flip", {
      card_id: "not-current",
      command_id: "stale",
    })).toMatchObject({ ok: false, error: { code: "STALE_CARD" } });
    service.close();
  });
});

async function stateData(controller: Awaited<ReturnType<typeof openController>>["controller"]) {
  const result = await controller.execute("get_state", {});
  if (!result.ok || !("state" in result.data)) throw new Error("Study state unavailable.");
  return result.data.state;
}

async function openController(
  label: string,
  options: {
    publish?: (kind: string) => void;
    active?: () => boolean;
    navigate?: () => void;
    deckCount?: number;
  } = {},
) {
  const name = `study-webmcp-${label}-${crypto.randomUUID()}`;
  databaseNames.push(name);
  const service = await createStudyRouteService(
    { factory, name, seed: { clock: { now: () => NOW } } },
    { now: () => NOW },
  );
  const controller = createStudyToolController({
    service,
    deckId: DECK_ID,
    publishSnapshot: (snapshot) => options.publish?.(snapshot.kind),
    navigateHome: options.navigate ?? (() => undefined),
    readHomeDeckCount: async () => options.deckCount ?? 1,
    isActive: options.active,
  });
  return { service, controller };
}
