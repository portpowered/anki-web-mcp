import { describe, expect, test } from "bun:test";

import {
  assessHomeJourney,
  type HomeJourneyEvidence,
} from "../../scripts/webmcp-home-journey";
import { homeToolContracts } from "../../scripts/webmcp-production-contract";

const rootUrl = "https://portpowered.github.io/anki-web-mcp/";
const studyBaseUrl = "https://portpowered.github.io/anki-web-mcp/study/";

function call(result: unknown): HomeJourneyEvidence["listCall"] {
  return { status: "passed", result, error: null };
}

function evidence(): HomeJourneyEvidence {
  const deck = {
    id: "seed-spanish-basics",
    name: "Spanish Basics",
    card_count: 24,
    new_count: 24,
    due_count: 0,
    suspended_count: 0,
    last_studied_at: null,
    can_start_session: true,
  };
  const listResult = { ok: true, data: { page: "decks", decks: [deck] } };
  const invalidResult = {
    ok: false,
    error: { code: "INVALID_INPUT", message: "invalid", recoverable: true },
  };
  const visible = { route: "deck-home", pageState: "populated", text: "Spanish Basics" };
  const session = {
    id: "session-1",
    deckId: deck.id,
    sequence: 1,
    activeCardId: "card-1",
    completedAt: null,
  };
  return {
    initialUrl: rootUrl,
    finalUrl: `${studyBaseUrl}?deck=${deck.id}`,
    deploymentRoute: "study",
    homeTools: homeToolContracts.map((contract) => ({
      name: contract.name,
      inputSchema: JSON.stringify(contract.inputSchema),
      annotations: contract.annotations,
    })),
    studyToolNames: ["get_state", "flip", "set_state", "suspend", "go_home"],
    stateBefore: visible,
    stateAfterList: visible,
    stateAfterMalformed: visible,
    stateAfterExtra: visible,
    durableBefore: [structuredClone(deck)],
    durableAfterList: [structuredClone(deck)],
    durableAfterMalformed: [structuredClone(deck)],
    durableAfterExtra: [structuredClone(deck)],
    durableAfterSelect: session,
    visibleHome: {
      state: "populated",
      decks: [{
        id: deck.id,
        name: deck.name,
        card_count: deck.card_count,
        new_count: deck.new_count,
        due_count: deck.due_count,
        suspended_count: null,
        recovery_available: false,
        study_action: "start",
        study_keyboard_operable: true,
      }],
    },
    listCall: call(listResult),
    repeatedListCall: call(structuredClone(listResult)),
    malformedListCall: call(invalidResult),
    extraListCall: call(invalidResult),
    selectCall: call({
      ok: true,
      data: {
        page: "study",
        deck_id: deck.id,
        session: { id: session.id, sequence: session.sequence, status: "created" },
        caught_up: false,
      },
    }),
    selectedDeckId: deck.id,
    visibleStudy: {
      deck_id: deck.id,
      session_sequence: session.sequence,
      current_card_id: session.activeCardId,
    },
    browserErrors: [],
  };
}

type DeckField = "card_count" | "new_count" | "due_count" | "suspended_count";

function listedDeck(subject: HomeJourneyEvidence): Record<string, unknown> {
  return (subject.listCall.result as {
    data: { decks: Array<Record<string, unknown>> };
  }).data.decks[0]!;
}

function refreshRepeatedList(subject: HomeJourneyEvidence): void {
  subject.repeatedListCall.result = structuredClone(subject.listCall.result);
}

function updateDurableDeck(
  subject: HomeJourneyEvidence,
  update: (deck: HomeJourneyEvidence["durableBefore"][number]) => void,
): void {
  update(subject.durableBefore[0]!);
  subject.durableAfterList = structuredClone(subject.durableBefore);
  subject.durableAfterMalformed = structuredClone(subject.durableBefore);
  subject.durableAfterExtra = structuredClone(subject.durableBefore);
}

function expectParityFailure(subject: HomeJourneyEvidence, detail: string): void {
  expect(assessHomeJourney(subject, rootUrl, studyBaseUrl)).toEqual({
    status: "failed",
    failureCode: "deck-state-parity-mismatch",
    failureDetail: detail,
  });
}

describe("production home journey classification", () => {
  test("accepts a returned persisted deck and matching production navigation", () => {
    expect(assessHomeJourney(evidence(), rootUrl, studyBaseUrl)).toEqual({
      status: "passed",
      failureCode: null,
      failureDetail: null,
    });
  });

  test("observes current all-new row semantics without legacy cards or zero-suspended copy", () => {
    const fresh = evidence();
    expect(fresh.visibleHome.decks[0]).toMatchObject({
      name: "Spanish Basics",
      card_count: 24,
      new_count: 24,
      due_count: 0,
      suspended_count: null,
      recovery_available: false,
    });
    expect(assessHomeJourney(fresh, rootUrl, studyBaseUrl).status).toBe("passed");
  });

  test.each(["card_count", "new_count", "due_count", "suspended_count"] as DeckField[])(
    "identifies independent structured %s corruption",
    (field) => {
      const corrupted = evidence();
      listedDeck(corrupted)[field] = Number(listedDeck(corrupted)[field]) + 1;
      refreshRepeatedList(corrupted);
      expectParityFailure(corrupted, `structured:${field}`);
    },
  );

  test.each(["card_count", "new_count", "due_count", "suspended_count"] as DeckField[])(
    "identifies independent durable %s corruption",
    (field) => {
      const corrupted = evidence();
      updateDurableDeck(corrupted, (deck) => deck[field] += 1);
      expectParityFailure(corrupted, `durable:${field}`);
    },
  );

  test.each(["card_count", "new_count", "due_count", "suspended_count"] as DeckField[])(
    "identifies independent visible %s corruption",
    (field) => {
      const corrupted = evidence();
      if (field === "suspended_count") {
        corrupted.visibleHome.decks[0]!.suspended_count = 1;
      } else {
        corrupted.visibleHome.decks[0]![field] =
          Number(corrupted.visibleHome.decks[0]![field]) + 1;
      }
      expectParityFailure(corrupted, `visible:${field}`);
    },
  );

  test("rejects matching corruption in two observations instead of allowing consensus drift", () => {
    const corrupted = evidence();
    updateDurableDeck(corrupted, (deck) => deck.due_count = 7);
    corrupted.visibleHome.decks[0]!.due_count = 7;
    expectParityFailure(corrupted, "structured:due_count");
  });

  test("identifies durable last-studied and startability drift", () => {
    const lastStudied = evidence();
    updateDurableDeck(lastStudied, (deck) => {
      deck.last_studied_at = "2026-09-02T00:00:00.000Z";
    });
    expectParityFailure(lastStudied, "durable:last_studied_at");

    const startability = evidence();
    updateDurableDeck(startability, (deck) => deck.can_start_session = false);
    expectParityFailure(startability, "durable:can_start_session");
  });

  test("requires the visible recovery affordance for nonzero suspension without fabricating a count", () => {
    const suspended = evidence();
    const listed = JSON.parse(String(JSON.stringify(suspended.listCall.result)));
    listed.data.decks[0].new_count = 21;
    listed.data.decks[0].suspended_count = 3;
    suspended.listCall.result = listed;
    suspended.repeatedListCall.result = structuredClone(listed);
    suspended.durableBefore[0]!.new_count = 21;
    suspended.durableBefore[0]!.suspended_count = 3;
    suspended.durableAfterList = structuredClone(suspended.durableBefore);
    suspended.durableAfterMalformed = structuredClone(suspended.durableBefore);
    suspended.durableAfterExtra = structuredClone(suspended.durableBefore);
    suspended.visibleHome.decks[0]!.new_count = 21;
    suspended.visibleHome.decks[0]!.suspended_count = null;
    suspended.visibleHome.decks[0]!.recovery_available = true;
    expect(assessHomeJourney(suspended, rootUrl, studyBaseUrl).status).toBe("passed");

    const missingRecovery = structuredClone(suspended);
    missingRecovery.visibleHome.decks[0]!.recovery_available = false;
    expect(assessHomeJourney(missingRecovery, rootUrl, studyBaseUrl).failureCode).toBe(
      "deck-state-parity-mismatch",
    );
    expect(assessHomeJourney(missingRecovery, rootUrl, studyBaseUrl).failureDetail).toBe(
      "visible:recovery_available",
    );
    expect(assessHomeJourney(evidence(), rootUrl, studyBaseUrl).status).toBe("passed");
  });

  test.each(["loading", "empty", "error"] as const)(
    "rejects a %s page before treating rows as ready",
    (state) => {
      const stale = evidence();
      stale.visibleHome.state = state;
      expect(assessHomeJourney(stale, rootUrl, studyBaseUrl).failureCode).toBe(
        "deck-state-parity-mismatch",
      );
      expect(assessHomeJourney(stale, rootUrl, studyBaseUrl).failureDetail).toBe(
        `visible:page_state:${state}`,
      );
    },
  );

  test("rejects visible identity, order, and keyboard-semantic drift", () => {
    const wrongName = evidence();
    wrongName.visibleHome.decks[0]!.name = "Another deck";
    expect(assessHomeJourney(wrongName, rootUrl, studyBaseUrl).failureCode).toBe(
      "deck-state-parity-mismatch",
    );
    expect(assessHomeJourney(wrongName, rootUrl, studyBaseUrl).failureDetail).toBe(
      "visible:name",
    );

    const inaccessible = evidence();
    inaccessible.visibleHome.decks[0]!.study_keyboard_operable = false;
    expect(assessHomeJourney(inaccessible, rootUrl, studyBaseUrl).failureCode).toBe(
      "deck-state-parity-mismatch",
    );
    expect(assessHomeJourney(inaccessible, rootUrl, studyBaseUrl).failureDetail).toBe(
      "visible:can_start_session",
    );
  });

  test("requires visible rows to preserve structured and durable deck order", () => {
    const ordered = evidence();
    const second = {
      id: "seed-world-capitals",
      name: "World Capitals",
      card_count: 10,
      new_count: 8,
      due_count: 2,
      suspended_count: 0,
      last_studied_at: null,
      can_start_session: true,
    };
    const listed = structuredClone(ordered.listCall.result) as {
      data: { decks: Array<typeof second> };
    };
    listed.data.decks.push(second);
    ordered.listCall.result = listed;
    ordered.repeatedListCall.result = structuredClone(listed);
    for (const durable of [
      ordered.durableBefore,
      ordered.durableAfterList,
      ordered.durableAfterMalformed,
      ordered.durableAfterExtra,
    ]) durable.push(structuredClone(second));
    ordered.visibleHome.decks.push({
      id: second.id,
      name: second.name,
      card_count: second.card_count,
      new_count: second.new_count,
      due_count: second.due_count,
      suspended_count: null,
      recovery_available: false,
      study_action: "start",
      study_keyboard_operable: true,
    });
    expect(assessHomeJourney(ordered, rootUrl, studyBaseUrl).status).toBe("passed");

    ordered.visibleHome.decks.reverse();
    expect(assessHomeJourney(ordered, rootUrl, studyBaseUrl).failureCode).toBe(
      "deck-state-parity-mismatch",
    );
    expect(assessHomeJourney(ordered, rootUrl, studyBaseUrl).failureDetail).toBe("visible:id");
  });

  test("rejects missing, extra, renamed, and reordered durable decks", () => {
    const missing = evidence();
    missing.durableBefore = [];
    missing.durableAfterList = [];
    expectParityFailure(missing, "durable:deck_count");

    const renamed = evidence();
    renamed.durableBefore[0]!.name = "Renamed durable deck";
    renamed.durableAfterList = structuredClone(renamed.durableBefore);
    expectParityFailure(renamed, "durable:name");

    const extra = evidence();
    extra.durableBefore.push({ ...extra.durableBefore[0]!, id: "extra-deck" });
    extra.durableAfterList = structuredClone(extra.durableBefore);
    expectParityFailure(extra, "durable:deck_count");
  });

  test("identifies structured and visible identity or cardinality corruption", () => {
    const structuredId = evidence();
    listedDeck(structuredId).id = "wrong-structured-id";
    refreshRepeatedList(structuredId);
    expectParityFailure(structuredId, "structured:id");

    const structuredName = evidence();
    listedDeck(structuredName).name = "Wrong structured name";
    refreshRepeatedList(structuredName);
    expectParityFailure(structuredName, "structured:name");

    const structuredExtra = evidence();
    const extraListed = { ...listedDeck(structuredExtra), id: "extra-structured-deck" };
    (structuredExtra.listCall.result as {
      data: { decks: Array<Record<string, unknown>> };
    }).data.decks.push(extraListed);
    refreshRepeatedList(structuredExtra);
    expectParityFailure(structuredExtra, "structured:deck_count");

    const missingVisibleId = evidence();
    missingVisibleId.visibleHome.decks[0]!.id = null;
    expectParityFailure(missingVisibleId, "visible:id");

    const missingVisibleDeck = evidence();
    missingVisibleDeck.visibleHome.decks = [];
    expectParityFailure(missingVisibleDeck, "visible:deck_count");

    const extraVisibleDeck = evidence();
    extraVisibleDeck.visibleHome.decks.push(structuredClone(extraVisibleDeck.visibleHome.decks[0]!));
    expectParityFailure(extraVisibleDeck, "visible:deck_count");
  });

  test("rejects wrong selected IDs, tool results, routes, and visible study identity", () => {
    const wrongSelection = evidence();
    wrongSelection.selectedDeckId = "wrong-deck";
    expect(assessHomeJourney(wrongSelection, rootUrl, studyBaseUrl)).toMatchObject({
      failureCode: "select-deck-failed",
      failureDetail: "selected_deck_id",
    });

    const wrongResult = evidence();
    (wrongResult.selectCall.result as { data: { deck_id: string } }).data.deck_id = "wrong-deck";
    expect(assessHomeJourney(wrongResult, rootUrl, studyBaseUrl).failureCode).toBe(
      "select-deck-failed",
    );

    const wrongRoute = evidence();
    wrongRoute.deploymentRoute = "decks";
    expect(assessHomeJourney(wrongRoute, rootUrl, studyBaseUrl).failureCode).toBe(
      "study-navigation-mismatch",
    );

    const wrongVisibleStudy = evidence();
    (wrongVisibleStudy.visibleStudy as { deck_id: string }).deck_id = "wrong-deck";
    expect(assessHomeJourney(wrongVisibleStudy, rootUrl, studyBaseUrl).failureCode).toBe(
      "study-state-parity-mismatch",
    );
  });

  test("rejects fabricated navigation and mixed study discovery", () => {
    const fabricated = evidence();
    fabricated.finalUrl = `${studyBaseUrl}?deck=fabricated`;
    expect(assessHomeJourney(fabricated, rootUrl, studyBaseUrl).failureCode).toBe(
      "study-navigation-mismatch",
    );

    const mixed = evidence();
    mixed.studyToolNames.push("list_decks");
    expect(assessHomeJourney(mixed, rootUrl, studyBaseUrl).failureCode).toBe(
      "study-mixed-route-inventory",
    );
  });

  test("rejects wrong-reason reads, schema drift, and invalid-input mutation", () => {
    const schemaDrift = evidence();
    schemaDrift.homeTools[0]!.annotations = { readOnlyHint: false };
    expect(assessHomeJourney(schemaDrift, rootUrl, studyBaseUrl).failureCode).toBe(
      "home-tool-contract-mismatch",
    );

    const mutatedRead = evidence();
    mutatedRead.durableAfterList = [];
    expect(assessHomeJourney(mutatedRead, rootUrl, studyBaseUrl).failureCode).toBe(
      "list-decks-mutated-state",
    );

    const changedRepeatedResult = evidence();
    (changedRepeatedResult.repeatedListCall.result as { data: { page: string } }).data.page = "changed";
    expect(assessHomeJourney(changedRepeatedResult, rootUrl, studyBaseUrl).failureCode).toBe(
      "list-decks-mutated-state",
    );

    const changedVisibleRead = evidence();
    changedVisibleRead.stateAfterList = { changed: true };
    expect(assessHomeJourney(changedVisibleRead, rootUrl, studyBaseUrl).failureCode).toBe(
      "list-decks-mutated-state",
    );

    const mutatedInvalid = evidence();
    mutatedInvalid.stateAfterExtra = { changed: true };
    expect(assessHomeJourney(mutatedInvalid, rootUrl, studyBaseUrl).failureCode).toBe(
      "invalid-list-input-mutated-state",
    );

    const mutatedMalformedDurable = evidence();
    mutatedMalformedDurable.durableAfterMalformed = [];
    expect(assessHomeJourney(mutatedMalformedDurable, rootUrl, studyBaseUrl).failureCode).toBe(
      "invalid-list-input-mutated-state",
    );
  });

  test("accepts native schema rejection for input that cannot be parsed", () => {
    const nativeRejected = evidence();
    nativeRejected.malformedListCall = {
      status: "failed",
      result: null,
      error: "UnknownError: Failed to parse input arguments",
    };
    expect(assessHomeJourney(nativeRejected, rootUrl, studyBaseUrl).status).toBe("passed");
  });
});
