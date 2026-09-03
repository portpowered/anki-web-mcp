import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DeckPage } from "../../components/decks/deck-page";
import {
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

describe("production home durable observation", () => {
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
      const window = new Window();
      window.document.body.innerHTML = renderToStaticMarkup(createElement(DeckPage, {
        state: {
          kind: "populated" as const,
          decks: [{
            id: "deck-1",
            name: "Fresh deck",
            cardCount: 24,
            newCount: 23,
            dueCount: 0,
            suspendedCount,
          }],
        },
        onImport: () => undefined,
        onRetry: () => undefined,
        onSelect: () => undefined,
        onRemove: () => undefined,
        onRestoreSuspended: () => undefined,
      }));
      return observeVisibleHomePage(window.document as unknown as ParentNode).decks[0];
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
    expect(projectDurableHomeDecks(snapshot(
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
    ))).toEqual([expect.objectContaining({
      new_count: 0,
      due_count: 0,
      last_studied_at: new Date(NOW - 10).toISOString(),
      can_start_session: true,
    })]);
  });

  test("rejects malformed or incomplete structured observation fields", () => {
    const valid = projectDurableHomeDecks(snapshot([schedule("new")]))[0]!;
    expect(parseHomeDeckObservations([valid])).toEqual([valid]);
    expect(parseHomeDeckObservations([{ ...valid, new_count: undefined }])).toBeNull();
    expect(parseHomeDeckObservations([{ ...valid, due_count: -1 }])).toBeNull();
    expect(parseHomeDeckObservations([{ ...valid, can_start_session: "yes" }])).toBeNull();
  });
});
