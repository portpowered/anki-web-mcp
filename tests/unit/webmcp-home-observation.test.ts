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
    decks: [{
      id: "deck-1",
      name: "Fresh deck",
      cardCount: schedules.length,
      sessionIntakeLimit: 20,
      createdAt: NOW - 1,
      lastStudiedAt: null,
    }],
    cards: schedules.map((_, index) => ({
      id: `card-${index}`,
      deckId: "deck-1",
      creationOrder: index,
    })),
    schedules: schedules.map((value, index) => ({
      ...value,
      cardId: `card-${index}`,
    })),
    sessions: [],
    ...overrides,
  };
}

function schedule(
  state: DurableHomeSnapshot["schedules"][number]["state"],
  suspended = false,
): DurableHomeSnapshot["schedules"][number] {
  return {
    cardId: "card-0",
    deckId: "deck-1",
    dueAt: NOW,
    state,
    lastReviewAt: null,
    suspended,
  };
}

function activeSession(): DurableHomeSnapshot["sessions"][number] {
  return {
    id: "session-1",
    deckId: "deck-1",
    dayKey: "2027-01-15",
    sequence: 1,
    intakeLimit: 20,
    nextDayAt: NOW + 86_400_000,
    queueEntries: [{ cardId: "card-0", dueAt: NOW, ordinal: 1 }],
    activeCardId: "card-0",
    plannedPresentationCount: 1,
    completedPresentationCount: 0,
    currentSide: "front",
    startedAt: NOW - 10,
    updatedAt: NOW - 5,
    completedAt: null,
  };
}

function projectionFailure(snapshot: DurableHomeSnapshot): string | null {
  try {
    projectDurableHomeDecks(snapshot);
    return null;
  } catch (error) {
    return error !== null && typeof error === "object" && "detail" in error
      ? String(error.detail)
      : String(error);
  }
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

  test("bounds a fresh 24-card all-new deck by its configured intake", () => {
    expect(projectDurableHomeDecks(snapshot(
      Array.from({ length: 24 }, () => schedule("new")),
    ))).toEqual([{
      id: "deck-1",
      name: "Fresh deck",
      card_count: 24,
      new_count: 20,
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

  test("projects under-limit and mixed intake in due-state, due-time, creation, and ID order", () => {
    const states = ["new", "review", "learning", "relearning", "new"] as const;
    const mixed = snapshot(states.map((state) => schedule(state)), {
      decks: [{
        id: "deck-1",
        name: "Fresh deck",
        cardCount: 5,
        sessionIntakeLimit: 4,
        createdAt: NOW - 1,
        lastStudiedAt: null,
      }],
    });
    mixed.cards[0]!.creationOrder = 2;
    mixed.cards[4]!.creationOrder = 1;

    expect(projectDurableHomeDecks(mixed)).toEqual([expect.objectContaining({
      card_count: 5,
      new_count: 1,
      due_count: 3,
    })]);
    expect(projectDurableHomeDecks({
      ...mixed,
      cards: [...mixed.cards].reverse(),
      schedules: [...mixed.schedules].reverse(),
    })).toEqual(projectDurableHomeDecks(mixed));
  });

  test("uses every remaining active-session occurrence including delayed same-day work", () => {
    const active = snapshot([
      schedule("new"),
      { ...schedule("learning"), dueAt: NOW + 1_000 },
      schedule("review"),
    ]);
    active.sessions = [{
      ...activeSession(),
      queueEntries: [
        { cardId: "card-0", dueAt: NOW, ordinal: 1 },
        { cardId: "card-2", dueAt: NOW, ordinal: 3 },
        { cardId: "card-1", dueAt: NOW + 1_000, ordinal: 2 },
      ],
      plannedPresentationCount: 3,
    }];

    expect(projectDurableHomeDecks(active)).toEqual([expect.objectContaining({
      new_count: 1,
      due_count: 1,
      can_start_session: true,
    })]);
  });

  test("keeps a waiting delayed session startable without substituting a new intake", () => {
    const waiting = snapshot([
      { ...schedule("learning"), dueAt: NOW + 1_000 },
      schedule("new"),
    ]);
    waiting.sessions = [{
      ...activeSession(),
      queueEntries: [{ cardId: "card-0", dueAt: NOW + 1_000, ordinal: 1 }],
      activeCardId: null,
    }];

    expect(projectDurableHomeDecks(waiting)).toEqual([expect.objectContaining({
      new_count: 0,
      due_count: 0,
      can_start_session: true,
    })]);

    expect(projectDurableHomeDecks({ ...waiting, capturedAt: NOW + 1_000 })).toEqual([
      expect.objectContaining({
        new_count: 0,
        due_count: 1,
        can_start_session: true,
      }),
    ]);
  });

  test("omits empty durable deck definitions while preserving populated deck order", () => {
    const withEmptyDeck = snapshot([schedule("new")]);
    withEmptyDeck.decks.unshift({
      id: "empty-deck",
      name: "Default",
      cardCount: 0,
      sessionIntakeLimit: 20,
      createdAt: NOW - 2,
      lastStudiedAt: null,
    });

    expect(projectDurableHomeDecks(withEmptyDeck)).toEqual([
      expect.objectContaining({
        id: "deck-1",
        card_count: 1,
        new_count: 1,
      }),
    ]);
  });

  test("completed intake is history and a next same-day preview selects only the other cards", () => {
    const completed = snapshot(Array.from({ length: 24 }, () => schedule("new")));
    for (let index = 0; index < 20; index += 1) {
      completed.schedules[index] = {
        ...completed.schedules[index]!,
        state: "review",
        dueAt: NOW + 86_400_000,
        lastReviewAt: NOW - 1,
      };
    }
    completed.sessions = [{
      ...activeSession(),
      queueEntries: [],
      activeCardId: null,
      plannedPresentationCount: 20,
      completedPresentationCount: 20,
      updatedAt: NOW - 1,
      completedAt: NOW - 1,
    }];

    expect(projectDurableHomeDecks(completed)).toEqual([expect.objectContaining({
      card_count: 24,
      new_count: 4,
      due_count: 0,
      can_start_session: true,
    })]);
  });

  test("excludes next-day and suspended records without replacing active queue entries", () => {
    const current = snapshot([
      schedule("new"),
      { ...schedule("review"), dueAt: NOW + 86_400_000 },
      schedule("learning", true),
    ]);
    current.sessions = [activeSession()];

    expect(projectDurableHomeDecks(current)).toEqual([expect.objectContaining({
      card_count: 3,
      new_count: 1,
      due_count: 0,
      suspended_count: 1,
    })]);
  });

  test("preserves multiple-deck identity, last studied, startability, and stable order", () => {
    const multiple = snapshot([schedule("review")]);
    multiple.decks.push({
      id: "deck-0",
      name: "Later by creation",
      cardCount: 1,
      sessionIntakeLimit: 20,
      createdAt: NOW,
      lastStudiedAt: NOW - 5,
    });
    multiple.cards.push({ id: "other-card", deckId: "deck-0", creationOrder: 0 });
    multiple.schedules.push({
      cardId: "other-card",
      deckId: "deck-0",
      dueAt: NOW + 1,
      state: "review",
      lastReviewAt: NOW - 10,
      suspended: false,
    });

    expect(projectDurableHomeDecks(multiple)).toEqual([
      expect.objectContaining({ id: "deck-1", due_count: 1, can_start_session: true }),
      expect.objectContaining({
        id: "deck-0",
        due_count: 0,
        last_studied_at: new Date(NOW - 5).toISOString(),
        can_start_session: false,
      }),
    ]);
  });

  test.each([
    ["duplicate deck", (value: DurableHomeSnapshot) => { value.decks.push({ ...value.decks[0]! }); }, "durable:duplicate_deck_id"],
    ["card count drift", (value: DurableHomeSnapshot) => { value.decks[0]!.cardCount += 1; }, "durable:card_count"],
    ["duplicate card", (value: DurableHomeSnapshot) => { value.cards.push({ ...value.cards[0]! }); }, "durable:duplicate_card_id"],
    ["orphan card", (value: DurableHomeSnapshot) => { value.cards[0]!.deckId = "missing"; }, "durable:card_deck_relationship"],
    ["duplicate schedule", (value: DurableHomeSnapshot) => { value.schedules.push({ ...value.schedules[0]! }); }, "durable:duplicate_schedule_card_id"],
    ["cross-deck schedule", (value: DurableHomeSnapshot) => { value.schedules[0]!.deckId = "missing"; }, "durable:schedule_deck_relationship"],
    ["malformed schedule state", (value: DurableHomeSnapshot) => { (value.schedules[0] as { state: string }).state = "graduated"; }, "durable:schedule_state"],
    ["non-finite due time", (value: DurableHomeSnapshot) => { value.schedules[0]!.dueAt = Number.NaN; }, "durable:schedule_due_at"],
    ["missing schedule", (value: DurableHomeSnapshot) => { value.schedules = []; }, "durable:missing_schedule"],
  ] as const)("fails closed for %s", (_case, corrupt, detail) => {
    const value = snapshot([schedule("new")]);
    corrupt(value);
    expect(projectionFailure(value)).toBe(detail);
  });

  test.each([
    ["duplicate session", (value: DurableHomeSnapshot) => { value.sessions.push({ ...value.sessions[0]! }); }, "durable:duplicate_session_id"],
    ["cross-deck session", (value: DurableHomeSnapshot) => { value.sessions[0]!.deckId = "missing"; }, "durable:session_deck_relationship"],
    ["invalid sequence", (value: DurableHomeSnapshot) => { value.sessions[0]!.sequence = 0; }, "durable:session_sequence"],
    ["captured intake drift", (value: DurableHomeSnapshot) => { value.sessions[0]!.intakeLimit = 19; }, "durable:session_intake_limit_relationship"],
    ["invalid calendar day", (value: DurableHomeSnapshot) => { value.sessions[0]!.dayKey = "2027-02-31"; }, "durable:session_day_key"],
    ["stale session", (value: DurableHomeSnapshot) => {
      value.sessions[0]!.nextDayAt = NOW;
      value.sessions[0]!.queueEntries[0]!.dueAt = NOW - 1;
      value.schedules[0]!.dueAt = NOW - 1;
    }, "durable:stale_active_session"],
    ["bad progress", (value: DurableHomeSnapshot) => { value.sessions[0]!.plannedPresentationCount = 2; }, "durable:session_progress"],
    ["missing queue card", (value: DurableHomeSnapshot) => { value.sessions[0]!.queueEntries[0]!.cardId = "missing"; }, "durable:session_queue_card_relationship"],
    ["duplicate queue card", (value: DurableHomeSnapshot) => {
      value.sessions[0]!.queueEntries.push({ ...value.sessions[0]!.queueEntries[0]!, ordinal: 2 });
      value.sessions[0]!.plannedPresentationCount = 2;
    }, "durable:duplicate_session_queue_card_id"],
    ["queue due drift", (value: DurableHomeSnapshot) => { value.sessions[0]!.queueEntries[0]!.dueAt += 1; }, "durable:session_queue_due_relationship"],
    ["next-day queue", (value: DurableHomeSnapshot) => {
      value.sessions[0]!.queueEntries[0]!.dueAt = value.sessions[0]!.nextDayAt;
      value.schedules[0]!.dueAt = value.sessions[0]!.nextDayAt;
    }, "durable:session_queue_cutoff_relationship"],
    ["suspended queue", (value: DurableHomeSnapshot) => { value.schedules[0]!.suspended = true; }, "durable:session_queue_suspended"],
    ["active-card drift", (value: DurableHomeSnapshot) => {
      value.sessions[0]!.activeCardId = null;
      value.sessions[0]!.updatedAt = NOW;
    }, "durable:session_active_card_relationship"],
    ["completed queue", (value: DurableHomeSnapshot) => { value.sessions[0]!.completedAt = value.sessions[0]!.updatedAt; }, "durable:session_completion"],
  ] as const)("attributes corrupt %s relationships", (_case, corrupt, detail) => {
    const value = snapshot([schedule("new")], { sessions: [activeSession()] });
    corrupt(value);
    expect(projectionFailure(value)).toBe(detail);
  });

  test("rejects ambiguous active sessions and inconsistent same-day cutoffs", () => {
    const ambiguous = snapshot([schedule("new")], { sessions: [activeSession()] });
    ambiguous.sessions.push({
      ...activeSession(),
      id: "session-2",
      sequence: 2,
    });
    expect(projectionFailure(ambiguous)).toBe("durable:ambiguous_active_session");

    const cutoffs = snapshot([schedule("new")], { sessions: [activeSession()] });
    cutoffs.sessions.push({
      ...activeSession(),
      id: "session-2",
      sequence: 2,
      queueEntries: [],
      activeCardId: null,
      plannedPresentationCount: 1,
      completedPresentationCount: 1,
      updatedAt: NOW - 1,
      completedAt: NOW - 1,
      nextDayAt: NOW + 86_400_001,
    });
    expect(projectionFailure(cutoffs)).toBe("durable:session_cutoff_relationship");
  });

  test("rejects duplicate durable session sequence keys and a non-earliest active card", () => {
    const duplicateSequence = snapshot([schedule("new")], { sessions: [activeSession()] });
    duplicateSequence.sessions.push({
      ...activeSession(),
      id: "session-2",
      queueEntries: [],
      activeCardId: null,
      plannedPresentationCount: 1,
      completedPresentationCount: 1,
      updatedAt: NOW - 1,
      completedAt: NOW - 1,
    });
    expect(projectionFailure(duplicateSequence)).toBe("durable:duplicate_session_sequence");

    const wrongActive = snapshot([schedule("new"), schedule("review")]);
    wrongActive.sessions = [{
      ...activeSession(),
      queueEntries: [
        { cardId: "card-0", dueAt: NOW, ordinal: 0 },
        { cardId: "card-1", dueAt: NOW, ordinal: 1 },
      ],
      activeCardId: "card-1",
      plannedPresentationCount: 2,
    }];
    expect(projectionFailure(wrongActive)).toBe("durable:session_active_card_relationship");
  });

  test("attributes absent required durable fields instead of defaulting them", () => {
    const missingLimit = snapshot([schedule("new")]);
    (missingLimit.decks[0] as Partial<DurableHomeSnapshot["decks"][number]>).sessionIntakeLimit =
      undefined;
    expect(projectionFailure(missingLimit)).toBe("durable:session_intake_limit");

    const missingSuspension = snapshot([schedule("new")]);
    (missingSuspension.schedules[0] as Partial<DurableHomeSnapshot["schedules"][number]>).suspended =
      undefined;
    expect(projectionFailure(missingSuspension)).toBe("durable:schedule_suspended");
  });

  test("corrupt parity-shaped numbers cannot influence the raw durable result", () => {
    const durable = snapshot(Array.from({ length: 24 }, () => schedule("new")));
    const copiedStructuredAndVisible = { card_count: 24, new_count: 24, due_count: 0 };

    expect(copiedStructuredAndVisible.new_count).toBe(24);
    expect(projectDurableHomeDecks(durable)[0]).toMatchObject({
      card_count: 24,
      new_count: 20,
      due_count: 0,
    });
  });

  test("carries last-studied and active-session startability without inferring counts", () => {
    const durableSnapshot = snapshot(
      [{ ...schedule("review"), dueAt: NOW + 1 }],
      {
        decks: [{
          id: "deck-1",
          name: "Fresh deck",
          cardCount: 1,
          sessionIntakeLimit: 20,
          createdAt: NOW - 1,
          lastStudiedAt: NOW - 10,
        }],
        sessions: [{
          ...activeSession(),
          queueEntries: [{ cardId: "card-0", dueAt: NOW + 1, ordinal: 1 }],
          activeCardId: null,
        }],
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
