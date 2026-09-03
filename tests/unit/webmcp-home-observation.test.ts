import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DeckPage } from "../../components/decks/deck-page";
import {
  observeDurableDeckMetadata,
  observeVisibleHomePage,
  parseHomeDeckObservations,
  projectDurableHomeDecks,
  type DurableHomeSnapshot,
} from "../../scripts/webmcp-home-observation";

const NOW = 1_800_000_000_000;

function snapshot(
  schedules: DurableHomeSnapshot["schedules"],
  overrides: Partial<DurableHomeSnapshot> = {},
): DurableHomeSnapshot {
  return {
    capturedAt: NOW,
    decks: [{ id: "deck-1", name: "Fresh deck", createdAt: NOW - 1, lastStudiedAt: null }],
    cards: schedules.map(() => ({ deckId: "deck-1" })),
    schedules,
    sessions: [],
    ...overrides,
  };
}

function schedule(
  state: DurableHomeSnapshot["schedules"][number]["state"],
  suspended = false,
): DurableHomeSnapshot["schedules"][number] {
  return { deckId: "deck-1", dueAt: NOW, state, suspended };
}

function renderDeckPage(
  state: Parameters<typeof DeckPage>[0]["state"],
): { document: Document; observation: ReturnType<typeof observeVisibleHomePage> } {
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(createElement(DeckPage, {
    state,
    onImport: () => undefined,
    onRetry: () => undefined,
    onSelect: () => undefined,
    onRemove: () => undefined,
    onRestoreSuspended: () => undefined,
  }));
  return {
    document: window.document as unknown as Document,
    observation: observeVisibleHomePage(window.document as unknown as ParentNode),
  };
}

describe("production home durable observation", () => {
  test("observes all fresh-deck counts from the real DeckPage row across bullet normalization", () => {
    const rendered = renderDeckPage({
      kind: "populated",
      decks: [{
        id: "deck-1",
        name: "Fresh deck",
        cardCount: 24,
        newCount: 24,
        dueCount: 0,
      }],
    });
    const row = rendered.document.querySelector('[data-deck-row][data-deck-id="deck-1"]');

    expect(row?.textContent?.replace(/\s+/g, "").includes("24new•0due•24total")).toBe(true);
    expect(rendered.observation).toMatchObject({
      state: "populated",
      decks: [{
        id: "deck-1",
        name: "Fresh deck",
        card_count: 24,
        new_count: 24,
        due_count: 0,
      }],
    });
  });

  test("normalizes comma-formatted counts within the matching real deck row", () => {
    const rendered = renderDeckPage({
      kind: "populated",
      decks: [
        {
          id: "deck-other",
          name: "Other deck",
          cardCount: 999,
          newCount: 888,
          dueCount: 777,
        },
        {
          id: "deck-target",
          name: "Target deck",
          cardCount: 12_345,
          newCount: 2_345,
          dueCount: 1_234,
        },
      ],
    });
    const unrelated = rendered.document.createElement("p");
    unrelated.textContent = "99,999 new • 88,888 due • 77,777 total";
    rendered.document.body.prepend(unrelated);
    const observation = observeVisibleHomePage(rendered.document as unknown as ParentNode);

    expect(observation.decks.map((deck) => deck.id)).toEqual(["deck-other", "deck-target"]);
    expect(observation.decks[1]).toMatchObject({
      id: "deck-target",
      card_count: 12_345,
      new_count: 2_345,
      due_count: 1_234,
    });
  });

  test.each([
    ["missing", "", "remove"],
    ["duplicate", "24 new", "duplicate"],
    ["malformed", "twenty-four new", "replace"],
    ["negative", "-24 new", "replace"],
    ["non-finite", "Infinity new", "replace"],
    ["concatenated", "24new", "replace"],
    ["unsafe", "9,007,199,254,740,992 new", "replace"],
  ] as const)("rejects a %s count from the real DeckRow", (_case, text, mutation) => {
    const rendered = renderDeckPage({
      kind: "populated",
      decks: [{
        id: "deck-1",
        name: "Fresh deck",
        cardCount: 24,
        newCount: 24,
        dueCount: 0,
      }],
    });
    const count = rendered.document.querySelector('[data-deck-count="new"]');
    if (mutation === "remove") {
      count?.remove();
    } else if (mutation === "duplicate") {
      count?.after(count.cloneNode(true));
    } else if (count) {
      count.textContent = text;
    }

    expect(observeVisibleHomePage(rendered.document as unknown as ParentNode).decks[0])
      .toMatchObject({
        card_count: 24,
        new_count: null,
        due_count: 0,
      });
  });

  test("keeps duplicate and cross-deck identities observable instead of borrowing counts", () => {
    const rendered = renderDeckPage({
      kind: "populated",
      decks: [
        { id: "deck-target", name: "Target", cardCount: 24, newCount: 24, dueCount: 0 },
        { id: "deck-other", name: "Other", cardCount: 80, newCount: 70, dueCount: 10 },
      ],
    });
    const rows = rendered.document.querySelectorAll<HTMLElement>("[data-deck-row]");

    rows[1]?.setAttribute("data-deck-id", "deck-target");
    const observations = observeVisibleHomePage(rendered.document as unknown as ParentNode).decks;

    expect(observations.map(({ id, card_count, new_count, due_count }) => ({
      id,
      card_count,
      new_count,
      due_count,
    }))).toEqual([
      { id: "deck-target", card_count: 24, new_count: 24, due_count: 0 },
      { id: "deck-target", card_count: 80, new_count: 70, due_count: 10 },
    ]);
  });

  test.each(["loading", "empty", "error"] as const)(
    "distinguishes the real DeckPage %s state from populated success",
    (kind) => {
      const state = kind === "error"
        ? { kind, message: "Storage unavailable" }
        : { kind };
      expect(renderDeckPage(state).observation).toEqual({ state: kind, decks: [] });
    },
  );

  test("projects a fresh 24-card all-new deck independently from IndexedDB records", () => {
    expect(projectDurableHomeDecks(snapshot(
      Array.from({ length: 24 }, () => schedule("new")),
    ))).toEqual([{
      id: "deck-1",
      name: "Fresh deck",
      card_count: 24,
      new_count: 24,
      due_count: 0,
      suspended_count: 0,
      last_studied_at: null,
      can_start_session: true,
    }]);
  });

  test("observes the production recovery affordance before restore and its omission afterward", () => {
    const observe = (suspendedCount: number) => {
      return renderDeckPage({
        kind: "populated" as const,
        decks: [{
          id: "deck-1",
          name: "Fresh deck",
          cardCount: 24,
          newCount: 23,
          dueCount: 0,
          suspendedCount,
        }],
      }).observation.decks[0];
    };

    expect(observe(1)).toMatchObject({
      id: "deck-1",
      suspended_count: null,
      recovery_available: true,
    });
    expect(observe(0)).toMatchObject({
      id: "deck-1",
      suspended_count: null,
      recovery_available: false,
    });
  });

  test("keeps due-at-now new, due non-new, and suspended categories separate", () => {
    expect(projectDurableHomeDecks(snapshot([
      schedule("new"),
      schedule("learning"),
      schedule("review"),
      schedule("relearning"),
      schedule("review", true),
    ]))).toEqual([expect.objectContaining({
      card_count: 5,
      new_count: 1,
      due_count: 3,
      suspended_count: 1,
      can_start_session: true,
    })]);
  });

  test("carries last-studied and active-session startability without inferring counts", () => {
    const durableSnapshot = snapshot(
      [{ ...schedule("review"), dueAt: NOW + 1 }],
      {
        decks: [{
          id: "deck-1",
          name: "Fresh deck",
          createdAt: NOW - 1,
          lastStudiedAt: NOW - 10,
        }],
        sessions: [{ deckId: "deck-1", completedAt: null }],
      },
    );
    expect(projectDurableHomeDecks(durableSnapshot)).toEqual([expect.objectContaining({
      new_count: 0,
      due_count: 0,
      last_studied_at: new Date(NOW - 10).toISOString(),
      can_start_session: true,
    })]);
    expect(observeDurableDeckMetadata(durableSnapshot)).toEqual([{
      id: "deck-1",
      last_studied_at: new Date(NOW - 10).toISOString(),
    }]);
  });

  test("rejects malformed or incomplete structured observation fields", () => {
    const valid = projectDurableHomeDecks(snapshot([schedule("new")]))[0]!;
    expect(parseHomeDeckObservations([valid])).toEqual([valid]);
    expect(parseHomeDeckObservations([{ ...valid, new_count: undefined }])).toBeNull();
    expect(parseHomeDeckObservations([{ ...valid, due_count: -1 }])).toBeNull();
    expect(parseHomeDeckObservations([{ ...valid, can_start_session: "yes" }])).toBeNull();
  });
});
