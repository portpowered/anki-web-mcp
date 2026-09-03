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
    visibleDecks: [deck],
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
