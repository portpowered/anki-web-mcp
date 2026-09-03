import { describe, expect, test } from "bun:test";

import {
  assessAdversarialJourney,
  type AdversarialJourneyEvidence,
  type AdversarialRace,
} from "../../scripts/webmcp-adversarial-journey";

const deckId = "seed-spanish-basics";
const cardId = "card-1";
const ok = (data: object = {}) => ({ status: "passed" as const, result: { ok: true, data }, error: null });
const rejected = (code: string) => ({
  status: "passed" as const,
  result: { ok: false, error: { code } },
  error: null,
});
const dueAt = Date.UTC(2026, 8, 3, 0, 17, 13);
const snapshot = (options: {
  activeCard?: string;
  side?: "front" | "back";
  logs?: number;
  completed?: number;
  suspended?: boolean;
  planned?: number;
  route?: "study" | "deck-home";
} = {}) => ({
  visible: options.route === "deck-home"
    ? {
      route: "deck-home",
      row: "Spanish Basics 24 new • 0 due • 24 total",
      restoreAvailable: options.suspended === true,
    }
    : {
      state: "active",
      cardId: options.activeCard ?? cardId,
      side: options.side ?? "front",
      sideDetail: null,
      progressCurrent: options.completed ?? 0,
      progressTotal: options.planned ?? 20,
    },
  durable: {
    session: {
      id: "session-1",
      sequence: 1,
      activeCardId: options.activeCard ?? cardId,
      currentSide: options.side ?? "front",
      completedPresentationCount: options.completed ?? 0,
      plannedPresentationCount: options.planned ?? 20,
      queueEntries: [{ cardId: options.activeCard ?? cardId }],
    },
    schedule: { cardId, suspended: options.suspended ?? false, reps: options.logs ?? 0, state: "review", dueAt },
    reviewLogs: Array.from({ length: options.logs ?? 0 }, (_, index) => ({
      id: `log-${index}`,
      cardId,
      rating: "good",
      after: { reps: options.logs ?? 0, state: "review", dueAt },
    })),
  },
});

function stateFromSnapshot(value: ReturnType<typeof snapshot>) {
  const visible = value.visible as Record<string, unknown>;
  const session = value.durable.session;
  return {
    page: "study",
    status: visible.state,
    deck: { id: deckId },
    session: {
      id: session.id,
      sequence: session.sequence,
      completed_presentations: session.completedPresentationCount,
      planned_presentations: session.plannedPresentationCount,
    },
    current_card: { id: visible.cardId, side: visible.side },
  };
}

function reviewCall(after: ReturnType<typeof snapshot>, commandId = "race-review") {
  return ok({
    state: stateFromSnapshot(after),
    command_id: commandId,
    transition: {
      rating: "good",
      reviewed_card_id: cardId,
      next_card_id: (after.visible as Record<string, unknown>).cardId,
      next_due_at: new Date(dueAt).toISOString(),
      idempotent: false,
    },
  });
}

function race(kind: AdversarialRace["kind"]): AdversarialRace {
  const before = kind === "restore"
    ? snapshot({ suspended: true, route: "deck-home" })
    : snapshot({ side: kind === "review" || kind === "conflict" ? "back" : "front" });
  const after = kind === "review"
    ? snapshot({ activeCard: "card-2", logs: 1, completed: 1, planned: 21 })
    : kind === "suspend"
      ? snapshot({ activeCard: "card-2", suspended: true, planned: 19 })
      : kind === "restore"
        ? snapshot({ suspended: false, route: "deck-home" })
        : snapshot({ activeCard: "card-2", logs: 1, completed: 1, planned: 21 });
  const review = reviewCall(after, kind === "conflict" ? "race-conflict-review" : "race-review");
  const suspend = ok({
    state: stateFromSnapshot(after),
    command_id: "race-suspend",
    suspension: {
      suspended_card_id: cardId,
      removed_occurrence_count: 1,
      next_card_id: "card-2",
      idempotent: false,
    },
  });
  const restore = (idempotent: boolean) => ok({
    page: "decks",
    decks: [{
      id: deckId,
      name: "Spanish Basics",
      card_count: 24,
      new_count: 24,
      due_count: 0,
      suspended_count: 0,
    }],
    deck_id: deckId,
    command_id: "race-restore",
    restored_count: 1,
    idempotent,
  });
  return {
    kind,
    deckId,
    cardId,
    before,
    after,
    calls: kind === "conflict"
      ? [review, rejected("STALE_CARD")]
      : kind === "restore"
        ? [restore(false), restore(true)]
        : kind === "review"
          ? [review, structuredClone(review)]
          : [suspend, structuredClone(suspend)],
    readCalls: kind === "conflict"
      ? [ok({ state: stateFromSnapshot(before) }), ok({ state: stateFromSnapshot(after) })]
      : [],
  };
}

function evidence(): AdversarialJourneyEvidence {
  const before = snapshot();
  return {
    validation: {
      before,
      invalid: ["missing", "malformed", "wrong-type", "extra"].map((label) => ({
        label,
        call: rejected("INVALID_INPUT"),
        after: structuredClone(before),
      })),
      stale: { label: "stale", call: rejected("STALE_CARD"), after: structuredClone(before) },
      premature: { label: "premature", call: rejected("ANSWER_NOT_REVEALED"), after: structuredClone(before) },
      collision: { label: "collision", call: rejected("DUPLICATE_COMMAND"), after: structuredClone(before) },
      browserErrors: [],
    },
    races: [race("review"), race("suspend"), race("restore"), race("conflict")],
    browserErrors: [],
  };
}

describe("production adversarial journey classification", () => {
  test("accepts classified immutable failures and one-effect races", () => {
    expect(assessAdversarialJourney(evidence())).toEqual({ status: "passed", failureCode: null });
  });

  test("rejects generic invalid errors or mutation after rejection", () => {
    const generic = evidence();
    generic.validation.invalid[0]!.call = { status: "failed", result: null, error: "Error" };
    expect(assessAdversarialJourney(generic).failureCode).toBe("invalid-input-contract-failed");
    const mutated = evidence();
    mutated.validation.stale.after.visible = { changed: true };
    expect(assessAdversarialJourney(mutated).failureCode).toBe("stale-card-contract-failed");
  });

  test("rejects duplicate effects and illegal conflicting outcomes", () => {
    const duplicate = evidence();
    duplicate.races.find((item) => item.kind === "review")!.after = snapshot({ logs: 2, completed: 2 });
    expect(assessAdversarialJourney(duplicate).failureCode).toBe("review-race-contract-failed");
    const conflict = evidence();
    conflict.races.find((item) => item.kind === "conflict")!.calls = [ok(), ok()];
    expect(assessAdversarialJourney(conflict).failureCode).toBe("conflict-race-contract-failed");
  });

  test("rejects divergent same-command results", () => {
    const divergent = evidence();
    const review = divergent.races.find((item) => item.kind === "review")!;
    const changed = structuredClone(review.calls[1]!.result) as { data: { transition: { next_card_id: string } } };
    changed.data.transition.next_card_id = "wrong-card";
    review.calls[1]!.result = changed;
    expect(assessAdversarialJourney(divergent).failureCode).toBe("review-race-contract-failed");
  });

  test("rejects final visible state drift", () => {
    const drifted = evidence();
    const conflict = drifted.races.find((item) => item.kind === "conflict")!;
    (conflict.after.visible as Record<string, unknown>).cardId = "wrong-card";
    expect(assessAdversarialJourney(drifted).failureCode).toBe("conflict-race-contract-failed");
  });

  test("requires each committed race to advance to one authoritative front-side card", () => {
    for (const kind of ["review", "suspend", "conflict"] as const) {
      const wrongSide = evidence();
      const selected = wrongSide.races.find((item) => item.kind === kind)!;
      (selected.after.visible as Record<string, unknown>).side = "back";
      selected.after.durable = {
        ...(selected.after.durable as Record<string, unknown>),
        session: {
          ...((selected.after.durable as { session: Record<string, unknown> }).session),
          currentSide: "back",
        },
      };
      expect(assessAdversarialJourney(wrongSide).failureCode).toBe(`${kind}-race-contract-failed`);

      const copied = evidence();
      const copiedRace = copied.races.find((item) => item.kind === kind)!;
      (copiedRace.after.visible as Record<string, unknown>).sideDetail = "study-side-invalid:copied-front";
      expect(assessAdversarialJourney(copied).failureCode).toBe(`${kind}-race-contract-failed`);
    }
  });
});
