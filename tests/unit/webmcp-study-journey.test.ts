import { describe, expect, test } from "bun:test";

import {
  assessStudyJourney,
  type StudyJourneyEvidence,
  type StudyJourneySnapshot,
} from "../../scripts/webmcp-study-journey";
import { activeStudyToolContracts } from "../../scripts/webmcp-production-contract";

const deckId = "seed-spanish-basics";
const cardId = "card-1";

function call(result: unknown): StudyJourneyEvidence["getStateCall"] {
  return { status: "passed", result, error: null };
}

function session(side: "front" | "back", completed = 0, activeCardId = cardId) {
  return {
    id: "session-1",
    deckId,
    sequence: 1,
    activeCardId,
    currentSide: side,
    completedPresentationCount: completed,
    plannedPresentationCount: 20,
  };
}

function card(id = cardId) {
  return { id, deckId, frontText: id === cardId ? "hola" : "adiós", backText: id === cardId ? "hello" : "goodbye" };
}

function state(side: "front" | "back", completed = 0, currentCard = cardId) {
  const value = card(currentCard);
  return {
    page: "study",
    status: "active",
    deck: { id: deckId, name: "Spanish Basics" },
    session: {
      id: "session-1",
      sequence: 1,
      completed_presentations: completed,
      planned_presentations: 20,
    },
    current_card: {
      id: currentCard,
      front_text: value.frontText,
      side,
      ...(side === "back" ? { back_text: value.backText } : {}),
    },
  };
}

function snapshot(side: "front" | "back", completed = 0, currentCard = cardId): StudyJourneySnapshot {
  const value = card(currentCard);
  return {
    visible: {
      route: "study",
      state: "active",
      cardId: currentCard,
      side,
      content: side === "front" ? value.frontText : value.backText,
      progressCurrent: completed,
      progressTotal: 20,
    },
    durable: {
      session: session(side, completed, currentCard),
      card: value,
      schedule: { cardId: currentCard, deckId, dueAt: 0, reps: 0, state: "new" },
      schedules: [
        { cardId, deckId, dueAt: completed ? 60_000 : 0, reps: completed ? 1 : 0, state: completed ? "learning" : "new" },
        { cardId: "card-2", deckId, dueAt: 0, reps: 0, state: "new" },
      ],
      reviewLogs: completed ? [{
        id: "log-1",
        cardId,
        deckId,
        rating: "good",
        after: { dueAt: 60_000, reps: 1, state: "learning" },
      }] : [],
    },
  };
}

function evidence(): StudyJourneyEvidence {
  const front = snapshot("front");
  const back = snapshot("back");
  const rated = snapshot("front", 1, "card-2");
  return {
    url: `https://portpowered.github.io/anki-web-mcp/study/?deck=${deckId}`,
    deckId,
    cardId,
    tools: activeStudyToolContracts.map((contract) => ({
      name: contract.name,
      inputSchema: JSON.stringify(contract.inputSchema),
      annotations: contract.annotations,
    })),
    before: front,
    afterRead: front,
    afterRepeatedRead: front,
    afterPrematureRating: front,
    afterFlip: back,
    afterFlipRetry: back,
    afterRating: rated,
    getStateCall: call({ ok: true, data: { state: state("front") } }),
    repeatedGetStateCall: call({ ok: true, data: { state: state("front") } }),
    prematureRatingCall: call({ ok: false, error: { code: "ANSWER_NOT_REVEALED" } }),
    flipCall: call({
      ok: true,
      data: { state: state("back"), command_id: "flip-1", reveal: { changed: true, idempotent: false } },
    }),
    flipRetryCall: call({
      ok: true,
      data: { state: state("back"), command_id: "flip-1", reveal: { changed: false, idempotent: true } },
    }),
    ratingCall: call({
      ok: true,
      data: {
        state: state("front", 1, "card-2"),
        command_id: "rate-1",
        transition: {
          rating: "good",
          reviewed_card_id: cardId,
          next_due_at: new Date(60_000).toISOString(),
          next_card_id: "card-2",
          idempotent: false,
        },
      },
    }),
    rating: "good",
    browserErrors: [],
  };
}

describe("production study journey classification", () => {
  test("accepts one coherent read, reveal, retry, and rating transition", () => {
    expect(assessStudyJourney(evidence())).toEqual({ status: "passed", failureCode: null });
  });

  test("rejects a pre-reveal mutation or an unclassified rejection", () => {
    const mutated = evidence();
    mutated.afterPrematureRating = snapshot("back");
    expect(assessStudyJourney(mutated).failureCode).toBe("premature-rating-contract-failed");

    const generic = evidence();
    generic.prematureRatingCall = { status: "failed", result: null, error: "Error" };
    expect(assessStudyJourney(generic).failureCode).toBe("premature-rating-contract-failed");
  });

  test("rejects duplicate reveal effects and durable rating drift", () => {
    const duplicate = evidence();
    duplicate.flipRetryCall = duplicate.flipCall;
    expect(assessStudyJourney(duplicate).failureCode).toBe("flip-idempotency-failed");

    const drift = evidence();
    (drift.afterRating.durable as { schedules: Array<{ dueAt: number }> }).schedules[0]!.dueAt = 90_000;
    expect(assessStudyJourney(drift).failureCode).toBe("rating-transition-mismatch");
  });

  test("rejects schema drift and mixed discovery", () => {
    const schema = evidence();
    schema.tools[0]!.annotations = { readOnlyHint: false, untrustedContentHint: true };
    expect(assessStudyJourney(schema).failureCode).toBe("study-tool-contract-mismatch");

    const mixed = evidence();
    mixed.tools.push({ name: "list_decks", inputSchema: {}, annotations: {} });
    expect(assessStudyJourney(mixed).failureCode).toBe("study-mixed-route-inventory");
  });
});
