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
    durableBefore: [deck],
    durableAfterList: [deck],
    durableAfterMalformed: [deck],
    durableAfterExtra: [deck],
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
    repeatedListCall: call(listResult),
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

describe("production home journey classification", () => {
  test("accepts a returned persisted deck and matching production navigation", () => {
    expect(assessHomeJourney(evidence(), rootUrl, studyBaseUrl)).toEqual({
      status: "passed",
      failureCode: null,
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

  test("requires a visible nonzero suspended value and recovery affordance, then accepts recovery", () => {
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
    suspended.visibleHome.decks[0]!.suspended_count = 3;
    suspended.visibleHome.decks[0]!.recovery_available = true;
    expect(assessHomeJourney(suspended, rootUrl, studyBaseUrl).status).toBe("passed");

    const missingRecovery = structuredClone(suspended);
    missingRecovery.visibleHome.decks[0]!.recovery_available = false;
    expect(assessHomeJourney(missingRecovery, rootUrl, studyBaseUrl).failureCode).toBe(
      "deck-state-parity-mismatch",
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
    },
  );

  test("rejects visible identity, order, and keyboard-semantic drift", () => {
    const wrongName = evidence();
    wrongName.visibleHome.decks[0]!.name = "Another deck";
    expect(assessHomeJourney(wrongName, rootUrl, studyBaseUrl).failureCode).toBe(
      "deck-state-parity-mismatch",
    );

    const inaccessible = evidence();
    inaccessible.visibleHome.decks[0]!.study_keyboard_operable = false;
    expect(assessHomeJourney(inaccessible, rootUrl, studyBaseUrl).failureCode).toBe(
      "deck-state-parity-mismatch",
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

    const mutatedInvalid = evidence();
    mutatedInvalid.stateAfterExtra = { changed: true };
    expect(assessHomeJourney(mutatedInvalid, rootUrl, studyBaseUrl).failureCode).toBe(
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
