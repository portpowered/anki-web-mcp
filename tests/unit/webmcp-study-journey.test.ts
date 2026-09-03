import { describe, expect, test } from "bun:test";

import {
  assessStudyJourney,
  type StudyJourneyEvidence,
  type StudyJourneySnapshot,
} from "../../scripts/webmcp-study-journey";
import { activeStudyToolContracts } from "../../scripts/webmcp-production-contract";

const deckId = "seed-spanish-basics";
const cardId = "card-1";
const DAY_START = Date.parse("2026-09-01T07:00:00.000Z");
const NOW = DAY_START + 12 * 60 * 60 * 1_000;
const NEXT_DAY = Date.parse("2026-09-02T07:00:00.000Z");

function call(result: unknown): StudyJourneyEvidence["getStateCall"] {
  return { status: "passed", result, error: null };
}

function session(side: "front" | "back", completed = 0, activeCardId = cardId) {
  const queueEntries = Array.from({ length: 20 }, (_, index) => ({
    cardId: `card-${index + 1}`,
    dueAt: DAY_START,
    ordinal: index + 1,
  }));
  if (completed) {
    queueEntries.shift();
    queueEntries.push({ cardId, dueAt: NOW + 10 * 60 * 1_000, ordinal: 21 });
  }
  return {
    id: "session-1",
    deckId,
    dayKey: "2026-09-01",
    sequence: 1,
    nextDayAt: NEXT_DAY,
    queueEntries,
    activeCardId,
    currentSide: side,
    completedPresentationCount: completed,
    plannedPresentationCount: completed ? 21 : 20,
    ratingCounts: { again: 0, hard: 0, good: completed, easy: 0 },
    startedAt: DAY_START + 1,
    updatedAt: NOW,
    completedAt: null,
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
      planned_presentations: completed ? 21 : 20,
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
  const currentSession = session(side, completed, currentCard);
  const cards = Array.from({ length: 20 }, (_, index) => card(`card-${index + 1}`));
  const schedules = cards.map((candidate) => ({
    cardId: candidate.id,
    deckId,
    dueAt: completed && candidate.id === cardId ? NOW + 10 * 60 * 1_000 : DAY_START,
    reps: completed && candidate.id === cardId ? 1 : 0,
    state: completed && candidate.id === cardId ? "learning" : "new",
    lastReviewAt: completed && candidate.id === cardId ? NOW : null,
    suspended: false,
  }));
  const reviewLogs = completed ? [{
    id: "log-1",
    sessionId: "session-1",
    cardId,
    deckId,
    rating: "good",
    commandId: "rate-1",
    before: {
      dueAt: DAY_START, reps: 0, state: "new", lastReviewAt: null, suspended: false,
    },
    after: {
      dueAt: NOW + 10 * 60 * 1_000, reps: 1, state: "learning", lastReviewAt: NOW, suspended: false,
    },
  }] : [];
  return {
    visible: {
      route: "study",
      state: "active",
      cardId: currentCard,
      sessionSequence: 1,
      side,
      sideDetail: null,
      answerState: side === "front" ? "withheld" : "exposed",
      answerSemantic: side === "front" ? null : { text: value.backText, media: [] },
      content: side === "front" ? value.frontText : value.backText,
      progressCurrent: 0,
      progressTotal: 20,
    },
    durable: {
      capturedAt: NOW,
      session: currentSession,
      card: value,
      schedule: schedules.find((candidate) => candidate.cardId === currentCard),
      schedules,
      reviewLogs,
      answerSemantic: { text: value.backText, media: [] },
      stores: {
        meta: [{ key: "schemaVersion", value: 3 }],
        imports: [{ id: "seed-import" }],
        decks: [{ id: deckId, name: "Spanish Basics" }],
        notes: [{ id: "note-1", fields: { Front: "hola", Back: "hello" } }],
        cards,
        schedules,
        sessions: [currentSession],
        reviewLogs,
        media: [{ importId: "seed-import", name: "answer.png", sha256: "digest" }],
      },
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
    afterFlipRetry: structuredClone(back),
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
          next_due_at: new Date(NOW + 10 * 60 * 1_000).toISOString(),
          next_card_id: "card-2",
          idempotent: false,
        },
      },
    }),
    flipCommandId: "flip-1",
    ratingCommandId: "rate-1",
    rating: "good",
    browserErrors: [],
  };
}

describe("production study journey classification", () => {
  test("accepts one coherent read, reveal, retry, and rating transition", () => {
    const subject = evidence();
    expect((subject.afterRating.durable as { session: object }).session).toMatchObject({
      completedPresentationCount: 1,
      plannedPresentationCount: 21,
    });
    expect(subject.afterRating.visible).toMatchObject({ progressCurrent: 0, progressTotal: 20 });
    expect(assessStudyJourney(subject)).toEqual({
      status: "passed", failureCode: null, failureDetail: null,
    });
  });

  test("attributes rating tool, durable, visible, and mutation failures independently", () => {
    const wrongCommand = evidence();
    ((wrongCommand.ratingCall.result as { data: { command_id: string } }).data).command_id = "rate-other";
    expect(assessStudyJourney(wrongCommand).failureDetail).toBe("tool:rating-transition");

    const wrongLog = evidence();
    (wrongLog.afterRating.durable as { reviewLogs: Array<{ commandId: string }> })
      .reviewLogs[0]!.commandId = "rate-other";
    expect(assessStudyJourney(wrongLog).failureDetail).toBe("durable:review-log");

    const wrongSchedule = evidence();
    (wrongSchedule.afterRating.durable as { schedules: Array<{ dueAt: number }> })
      .schedules[0]!.dueAt += 1;
    expect(assessStudyJourney(wrongSchedule).failureDetail).toBe("durable:schedule");

    const wrongRawProgress = evidence();
    ((wrongRawProgress.ratingCall.result as {
      data: { state: { session: { planned_presentations: number } } };
    }).data.state.session).planned_presentations = 20;
    expect(assessStudyJourney(wrongRawProgress).failureDetail).toBe("durable:session");

    const copiedPresentationProgress = evidence();
    (copiedPresentationProgress.afterRating.visible as { progressCurrent: number }).progressCurrent = 1;
    (copiedPresentationProgress.afterRating.visible as { progressTotal: number }).progressTotal = 21;
    expect(assessStudyJourney(copiedPresentationProgress).failureDetail).toBe("visible:progress");

    const wrongCard = evidence();
    (wrongCard.afterRating.visible as { cardId: string }).cardId = "card-3";
    expect(assessStudyJourney(wrongCard).failureDetail).toBe("visible:card");

    const wrongSide = evidence();
    (wrongSide.afterRating.visible as { side: string }).side = "back";
    expect(assessStudyJourney(wrongSide).failureDetail).toBe("visible:side");

    const unrelatedMutation = evidence();
    ((unrelatedMutation.afterRating.durable as {
      stores: { meta: Array<{ value: number }> };
    }).stores.meta[0]!).value = 4;
    expect(assessStudyJourney(unrelatedMutation).failureDetail)
      .toBe("durable:illegal-rating-mutation");
  });

  test("rejects a pre-reveal mutation or an unclassified rejection", () => {
    const mutated = evidence();
    mutated.afterPrematureRating = snapshot("back");
    expect(assessStudyJourney(mutated).failureCode).toBe("premature-rating-contract-failed");

    const generic = evidence();
    generic.prematureRatingCall = { status: "failed", result: null, error: "Error" };
    expect(assessStudyJourney(generic).failureCode).toBe("premature-rating-contract-failed");
  });

  test("attributes retry contract failures independently from first-flip and rating failures", () => {
    const duplicate = evidence();
    duplicate.flipRetryCall = duplicate.flipCall;
    expect(assessStudyJourney(duplicate)).toMatchObject({
      failureCode: "flip-idempotency-failed",
      failureDetail: "tool:retry-flags",
    });

    const wrongCommand = evidence();
    ((wrongCommand.flipRetryCall.result as { data: { command_id: string } }).data).command_id = "flip-2";
    expect(assessStudyJourney(wrongCommand).failureDetail).toBe("tool:retry-command-id");

    const visibleDrift = evidence();
    (visibleDrift.afterFlipRetry.visible as { answerSemantic: unknown }).answerSemantic = {
      text: "goodbye", media: [],
    };
    expect(assessStudyJourney(visibleDrift).failureDetail).toBe("retry-tool-visible-durable-parity");

    const durableDrift = evidence();
    ((durableDrift.afterFlipRetry.durable as {
      stores: { meta: Array<{ value: number }> };
    }).stores.meta[0]!).value = 4;
    expect(assessStudyJourney(durableDrift).failureDetail).toBe("durable:retry-mutation");

    const drift = evidence();
    (drift.afterRating.durable as { schedules: Array<{ dueAt: number }> }).schedules[0]!.dueAt = 90_000;
    expect(assessStudyJourney(drift).failureCode).toBe("rating-transition-mismatch");
  });

  test("binds first-flip and retry evidence to the requested command identifier", () => {
    const first = evidence();
    ((first.flipCall.result as { data: { command_id: string } }).data).command_id = "copied-command";
    expect(assessStudyJourney(first)).toMatchObject({
      failureCode: "flip-transition-mismatch",
      failureDetail: "tool:first-reveal-command-id",
    });

    const empty = evidence();
    empty.flipCommandId = "";
    expect(assessStudyJourney(empty).failureDetail).toBe("tool:first-reveal-command-id");
  });

  test("requires answer-only visible semantics and an otherwise immutable first reveal", () => {
    const flattened = evidence();
    (flattened.afterFlip.visible as Record<string, unknown>).answerSemantic = {
      text: "hola hello",
      media: [],
    };
    expect(assessStudyJourney(flattened).failureCode).toBe("flip-transition-mismatch");

    const unrelatedCardMutation = evidence();
    (unrelatedCardMutation.afterFlip.durable as {
      card: { frontText: string };
    }).card.frontText = "changed question";
    expect(assessStudyJourney(unrelatedCardMutation).failureCode).toBe("flip-transition-mismatch");

    const scheduleMutation = evidence();
    (scheduleMutation.afterFlip.durable as {
      schedules: Array<{ reps: number }>;
    }).schedules[0]!.reps = 1;
    expect(assessStudyJourney(scheduleMutation).failureCode).toBe("flip-transition-mismatch");

    const deckMutation = evidence();
    ((deckMutation.afterFlip.durable as {
      stores: { decks: Array<{ name: string }> };
    }).stores.decks[0]!).name = "mutated deck";
    expect(assessStudyJourney(deckMutation).failureCode).toBe("flip-transition-mismatch");

    const wrongInitialSide = evidence();
    (wrongInitialSide.afterPrematureRating.durable as {
      session: { currentSide: string };
    }).session.currentSide = "back";
    expect(assessStudyJourney(wrongInitialSide).failureCode).toBe("get-state-parity-or-mutation");
  });

  test.each([
    ["missing answer", "study-answer-count:0"],
    ["duplicate answer", "study-answer-count:2"],
    ["hidden answer", "study-answer-hidden"],
    ["stale card", "study-card-count:2"],
    ["wrong-card answer", "study-answer-outside-card"],
  ])("emits the stable visible leaf for %s", (_case, detail) => {
    const subject = evidence();
    (subject.afterFlip.visible as { sideDetail: string | null }).sideDetail = detail;
    expect(assessStudyJourney(subject)).toMatchObject({
      status: "failed",
      failureCode: "flip-transition-mismatch",
      failureDetail: `visible:${detail}`,
    });
  });

  test("rejects each independently corrupted first-reveal source", () => {
    const visible = evidence();
    (visible.afterFlip.visible as { cardId: string }).cardId = "card-stale";
    expect(assessStudyJourney(visible).failureDetail).toBe("flip-tool-visible-durable-parity");

    const tool = evidence();
    ((tool.flipCall.result as { data: { state: { current_card: { id: string } } } })
      .data.state.current_card).id = "card-stale";
    expect(assessStudyJourney(tool).failureDetail).toBe("flip-tool-visible-durable-parity");

    const durable = evidence();
    (durable.afterFlip.durable as { session: { activeCardId: string } })
      .session.activeCardId = "card-stale";
    expect(assessStudyJourney(durable).failureDetail).toBe("flip-tool-visible-durable-parity");
  });

  test("rejects malformed, copied, substituted, and materially different answer meaning", () => {
    const malformed = evidence();
    const malformedSemantic = { text: "", media: [{ kind: "video", label: "" }] };
    (malformed.afterFlip.visible as Record<string, unknown>).answerSemantic = malformedSemantic;
    (malformed.afterFlip.durable as Record<string, unknown>).answerSemantic = structuredClone(malformedSemantic);
    expect(assessStudyJourney(malformed).failureDetail).toBe("flip-tool-visible-durable-parity");

    const frontContext = evidence();
    (frontContext.afterFlip.visible as Record<string, unknown>).answerSemantic = {
      text: "hola hello", media: [],
    };
    expect(assessStudyJourney(frontContext).failureDetail).toBe("flip-tool-visible-durable-parity");

    const differentVisibleMeaning = evidence();
    (differentVisibleMeaning.afterFlip.visible as Record<string, unknown>).answerSemantic = {
      text: "goodbye", media: [],
    };
    expect(assessStudyJourney(differentVisibleMeaning).failureDetail).toBe("flip-tool-visible-durable-parity");
  });

  test("rejects stale lifecycle, illegal first flags, premature back, and all-agree illegal mutation", () => {
    const staleLifecycle = evidence();
    (staleLifecycle.afterFlip.visible as { sessionSequence: number }).sessionSequence = 2;
    expect(assessStudyJourney(staleLifecycle).failureDetail).toBe("flip-tool-visible-durable-parity");

    const flags = evidence();
    ((flags.flipCall.result as { data: { reveal: { changed: boolean } } }).data.reveal).changed = false;
    expect(assessStudyJourney(flags).failureDetail).toBe("tool:first-reveal-flags");

    const prematureBack = evidence();
    prematureBack.afterPrematureRating = snapshot("back");
    expect(assessStudyJourney(prematureBack).failureCode).toBe("premature-rating-contract-failed");

    const allAgreeButMutated = evidence();
    const beforeStores = (allAgreeButMutated.afterPrematureRating.durable as {
      stores: { decks: Array<{ name: string }> };
    }).stores;
    const afterStores = (allAgreeButMutated.afterFlip.durable as {
      stores: { decks: Array<{ name: string }> };
    }).stores;
    expect(beforeStores.decks[0]!.name).toBe("Spanish Basics");
    afterStores.decks[0]!.name = "Illegally renamed";
    expect(assessStudyJourney(allAgreeButMutated).failureDetail)
      .toBe("durable:illegal-first-reveal-mutation");
  });

  test("requires a distinct authoritative front-side card after rating", () => {
    const back = evidence();
    back.afterRating = snapshot("back", 1, "card-2");
    back.ratingCall = call({
      ok: true,
      data: {
        state: state("back", 1, "card-2"),
        transition: {
          rating: "good",
          reviewed_card_id: cardId,
          next_due_at: new Date(60_000).toISOString(),
          next_card_id: "card-2",
          idempotent: false,
        },
      },
    });
    expect(assessStudyJourney(back).failureCode).toBe("rating-transition-mismatch");

    const malformed = evidence();
    (malformed.afterRating.visible as { sideDetail: string | null }).sideDetail =
      "study-side-invalid:missing";
    expect(assessStudyJourney(malformed).failureCode).toBe("rating-transition-mismatch");

    const sameCard = evidence();
    sameCard.afterRating = snapshot("front", 1, cardId);
    expect(assessStudyJourney(sameCard).failureCode).toBe("rating-transition-mismatch");

    const mismatchedIdentity = evidence();
    (mismatchedIdentity.afterRating.visible as { cardId: string }).cardId = "card-3";
    expect(assessStudyJourney(mismatchedIdentity).failureCode).toBe("rating-transition-mismatch");
  });

  test("rejects schema drift and mixed discovery", () => {
    const schema = evidence();
    schema.tools[0]!.annotations = { readOnlyHint: false, untrustedContentHint: true };
    expect(assessStudyJourney(schema).failureCode).toBe("study-tool-contract-mismatch");

    const mixed = evidence();
    mixed.tools.push({ name: "list_decks", inputSchema: {}, annotations: {} });
    expect(assessStudyJourney(mixed).failureCode).toBe("study-mixed-route-inventory");
  });

  test("rejects DOM-only side or identity corruption while tool and durable state agree", () => {
    const copiedSide = evidence();
    (copiedSide.afterRead.visible as { side: string | null; sideDetail?: string }).side = null;
    (copiedSide.afterRead.visible as { sideDetail?: string }).sideDetail = "study-side-invalid:copied-front";
    expect(assessStudyJourney(copiedSide).failureCode).toBe("get-state-parity-or-mutation");

    const mixedCard = evidence();
    (mixedCard.afterRead.visible as { cardId: string }).cardId = "card-stale";
    expect(assessStudyJourney(mixedCard).failureCode).toBe("get-state-parity-or-mutation");
  });
});
