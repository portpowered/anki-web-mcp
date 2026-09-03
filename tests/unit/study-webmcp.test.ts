import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StudyPage } from "../../components/study";
import { studyViewFromSnapshot } from "../../components/study-route-preview";
import {
  createStudyRouteService,
  type StudyRouteSnapshot,
} from "../../lib/application/study-route-service";
import {
  createStudyToolController,
  flipInputSchema,
  getStudyStateInputSchema,
  goHomeInputSchema,
  setStudyStateInputSchema,
  serializeStudyState,
  STUDY_TOOL_NAMES,
  suspendInputSchema,
} from "../../lib/application/study-webmcp";
import { readVisibleRatingPreviews } from "../../scripts/webmcp-study-observation";

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
          session: {
            sequence: 1,
            completed_presentations: 0,
            planned_presentations: 20,
            remaining: 20,
          },
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

  test("shares exact previews across React, reads, flip, registration rotation, and suspension retry", async () => {
    const name = `study-webmcp-preview-parity-${crypto.randomUUID()}`;
    databaseNames.push(name);
    let now = NOW;
    const service = await createStudyRouteService(
      { factory, name, seed: { clock: { now: () => NOW } } },
      { now: () => now },
    );
    const published: StudyRouteSnapshot[] = [];
    const controller = () => createStudyToolController({
      service,
      deckId: DECK_ID,
      publishSnapshot: (snapshot) => published.push(snapshot),
      navigateHome: () => undefined,
      readHomeDeckCount: async () => 1,
    });
    const firstController = controller();
    const first = await stateData(firstController);
    const cardId = first.current_card!.id;
    const firstPreviews = serializedPreviewArray(first);
    expect(visiblePreviewArray(published.at(-1)!)).toEqual(firstPreviews);

    now += 61;
    const flipped = await firstController.execute("flip", {
      card_id: cardId,
      command_id: "preview-flip",
    });
    if (!flipped.ok || !("state" in flipped.data)) throw new Error("flip failed");
    expect(serializedPreviewArray(flipped.data.state)).toEqual(firstPreviews);
    expect(visiblePreviewArray(published.at(-1)!)).toEqual(firstPreviews);
    expect(Date.parse(flipped.data.state.captured_at)).toBeGreaterThan(Date.parse(first.captured_at));

    now += 61;
    const rotatedController = controller();
    const rotated = await stateData(rotatedController);
    expect(serializedPreviewArray(rotated)).toEqual(firstPreviews);
    expect(visiblePreviewArray(published.at(-1)!)).toEqual(firstPreviews);
    expect(Date.parse(rotated.captured_at)).toBeGreaterThan(Date.parse(flipped.data.state.captured_at));

    const suspendedCardId = rotated.current_card!.id;
    const suspended = await rotatedController.execute("suspend", {
      card_id: suspendedCardId,
      command_id: "preview-suspend",
    });
    if (!suspended.ok || !("state" in suspended.data)) throw new Error("suspend failed");
    const postSuspendPreviews = serializedPreviewArray(suspended.data.state);
    expect(visiblePreviewArray(published.at(-1)!)).toEqual(postSuspendPreviews);

    now += 61;
    const retried = await rotatedController.execute("suspend", {
      card_id: suspendedCardId,
      command_id: "preview-suspend",
    });
    if (!retried.ok || !("state" in retried.data) || !("suspension" in retried.data)) {
      throw new Error("retry failed");
    }
    expect(retried.data.suspension.idempotent).toBe(true);
    expect(serializedPreviewArray(retried.data.state)).toEqual(postSuspendPreviews);
    expect(visiblePreviewArray(published.at(-1)!)).toEqual(postSuspendPreviews);
    expect(Date.parse(retried.data.state.captured_at))
      .toBeGreaterThan(Date.parse(suspended.data.state.captured_at));
    service.close();
  });

  test("reports delayed same-day work as remaining instead of an empty session", () => {
    const delayedAt = NOW + 10 * 60_000;
    const waiting = serializeStudyState({
      kind: "waiting",
      capturedAt: NOW,
      deckId: DECK_ID,
      deckName: "Spanish Basics",
      sessionId: "session-today",
      sequence: 1,
      completedPresentationCount: 20,
      plannedPresentationCount: 21,
      completedTodayCount: 0,
      todayCardCount: 1,
      nextDueAt: delayedAt,
    });

    expect(waiting).toMatchObject({
      status: "waiting",
      current_card: null,
      session: {
        completed_presentations: 20,
        planned_presentations: 21,
        remaining: 1,
      },
      next_due_at: new Date(delayedAt).toISOString(),
    });
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

  test("serializes distinct conflicting mutations into one legal transition", async () => {
    const { service, controller } = await openController("conflicting-mutations");
    const cardId = (await stateData(controller)).current_card!.id;
    await controller.execute("flip", { card_id: cardId, command_id: "conflict-flip" });

    const [rating, suspension] = await Promise.all([
      controller.execute("set_state", {
        card_id: cardId,
        command_id: "conflict-rating",
        rating: "good",
      }),
      controller.execute("suspend", {
        card_id: cardId,
        command_id: "conflict-suspension",
      }),
    ]);

    expect(rating).toMatchObject({
      ok: true,
      data: { transition: { reviewed_card_id: cardId, idempotent: false } },
    });
    expect(suspension).toMatchObject({ ok: false, error: { code: "STALE_CARD" } });
    expect(await controller.execute("get_state", {})).toMatchObject({
      ok: true,
      data: { state: { session: { completed_presentations: 1 } } },
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

function serializedPreviewArray(state: Awaited<ReturnType<typeof stateData>>) {
  const previews = state.current_card?.rating_previews;
  if (!previews) return [];
  return (["again", "hard", "good", "easy"] as const).map((rating) => ({
    rating,
    ...previews[rating],
  }));
}

function visiblePreviewArray(snapshot: StudyRouteSnapshot) {
  const view = studyViewFromSnapshot(snapshot);
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(createElement(StudyPage, {
    deck: view.deck,
    progress: view.progress,
    state: view.state,
    onReturnToDecks: () => undefined,
    onToggle: () => undefined,
    onRate: () => undefined,
  }));
  return readVisibleRatingPreviews(window.document as unknown as Document);
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
