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
const dayStart = Date.parse("2026-09-03T07:00:00.000Z");
const capturedAt = Date.parse("2026-09-03T12:00:00.000Z");
const nextDayAt = Date.parse("2026-09-04T07:00:00.000Z");
const dueAt = capturedAt + 10 * 60 * 1_000;
const snapshot = (options: {
  activeCard?: string;
  side?: "front" | "back";
  logs?: number;
  completed?: number;
  suspended?: boolean;
  planned?: number;
  visibleCurrent?: number;
  visibleTotal?: number;
  route?: "study" | "deck-home";
} = {}) => {
  const completed = options.completed ?? 0;
  const planned = options.planned ?? 20;
  const logCount = options.logs ?? 0;
  const cards = Array.from({ length: 20 }, (_, index) => ({
    id: `card-${index + 1}`,
    deckId,
  }));
  const scheduleDueAt = logCount > 0 ? dueAt : dayStart;
  const schedules = cards.map((card) => ({
    cardId: card.id,
    deckId,
    dueAt: card.id === cardId ? scheduleDueAt : dayStart,
    state: (card.id === cardId && logCount > 0 ? "learning" : "new") as
      "new" | "learning" | "review" | "relearning",
    lastReviewAt: card.id === cardId && logCount > 0 ? capturedAt - 1 : null,
    suspended: card.id === cardId ? options.suspended ?? false : false,
    reps: card.id === cardId ? logCount : 0,
  }));
  const queueCardIds = cards.map((card) => card.id);
  if (planned - completed === 19) queueCardIds.shift();
  if (planned - completed === 20 && completed > 0) {
    queueCardIds.shift();
    queueCardIds.push(cardId);
  }
  const session = {
    id: "session-1",
    deckId,
    dayKey: "2026-09-03",
    sequence: 1,
    nextDayAt,
    activeCardId: options.activeCard ?? cardId,
    currentSide: options.side ?? "front" as const,
    completedPresentationCount: completed,
    plannedPresentationCount: planned,
    queueEntries: queueCardIds.map((queuedCardId, index) => ({
      cardId: queuedCardId,
      dueAt: queuedCardId === cardId ? scheduleDueAt : dayStart,
      ordinal: index + 1,
    })),
    ratingCounts: { again: 0, hard: 0, good: logCount, easy: 0 },
    startedAt: dayStart,
    updatedAt: capturedAt,
    completedAt: null,
  };
  const reviewLogs = Array.from({ length: logCount }, (_, index) => ({
    id: `log-${index}`,
    sessionId: session.id,
    deckId,
    cardId,
    rating: "good",
    reviewedAt: capturedAt - logCount + index,
    durationMs: null,
    commandId: index === logCount - 1 ? "race-review" : `earlier-review-${index}`,
    before: { reps: index, state: index === 0 ? "new" : "learning", dueAt: dayStart, lastReviewAt: null },
    after: {
      reps: logCount,
      state: "learning",
      dueAt: scheduleDueAt,
      lastReviewAt: capturedAt - 1,
    },
  }));
  return {
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
      progressCurrent: options.visibleCurrent ?? 0,
      progressTotal: options.visibleTotal ?? 20,
    },
    durable: {
      capturedAt,
      decks: [{ id: deckId }],
      cards,
      sessions: [session],
      session,
      schedule: schedules[0],
      schedules,
      reviewLogs,
    },
  };
};

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
  const schedule = after.durable.schedule;
  return ok({
    state: stateFromSnapshot(after),
    command_id: commandId,
    transition: {
      rating: "good",
      reviewed_card_id: cardId,
      next_card_id: (after.visible as Record<string, unknown>).cardId,
      next_due_at: new Date(schedule.dueAt).toISOString(),
      idempotent: false,
    },
  });
}

function replaceReviewRace(
  subject: AdversarialJourneyEvidence,
  kind: "review" | "conflict",
  before: ReturnType<typeof snapshot>,
  after: ReturnType<typeof snapshot>,
): void {
  const selected = subject.races.find((candidate) => candidate.kind === kind)!;
  const commandId = kind === "review" ? "race-review" : "race-conflict-review";
  after.durable.reviewLogs.at(-1)!.commandId = commandId;
  const review = reviewCall(after, commandId);
  selected.before = before;
  selected.after = after;
  selected.calls = kind === "review"
    ? [review, structuredClone(review)]
    : [review, rejected("STALE_CARD")];
  selected.readCalls = kind === "conflict"
    ? [ok({ state: stateFromSnapshot(before) }), ok({ state: stateFromSnapshot(after) })]
    : [];
}

function completedAtCutoff(): ReturnType<typeof snapshot> {
  const result = snapshot({
    activeCard: "card-2",
    logs: 1,
    completed: 1,
    planned: 20,
    visibleCurrent: 1,
  });
  result.durable.schedule.dueAt = nextDayAt;
  result.durable.schedule.state = "review";
  result.durable.schedules[0] = result.durable.schedule;
  result.durable.reviewLogs[0]!.after.dueAt = nextDayAt;
  result.durable.reviewLogs[0]!.after.state = "review";
  return result;
}

function race(kind: AdversarialRace["kind"]): AdversarialRace {
  const before = kind === "restore"
    ? snapshot({ suspended: true, route: "deck-home" })
    : snapshot({ side: kind === "review" || kind === "conflict" ? "back" : "front" });
  const after = kind === "review"
    ? snapshot({ activeCard: "card-2", logs: 1, completed: 1, planned: 21 })
    : kind === "suspend"
      ? snapshot({ activeCard: "card-2", suspended: true, planned: 19, visibleTotal: 19 })
      : kind === "restore"
        ? snapshot({ suspended: false, route: "deck-home" })
        : snapshot({ activeCard: "card-2", logs: 1, completed: 1, planned: 21 });
  if (kind === "conflict") after.durable.reviewLogs.at(-1)!.commandId = "race-conflict-review";
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
    const subject = evidence();
    const after = subject.races.find((item) => item.kind === "review")!.after;
    expect(after.visible).toMatchObject({ progressCurrent: 0, progressTotal: 20 });
    expect(after.durable).toMatchObject({
      session: { completedPresentationCount: 1, plannedPresentationCount: 21 },
    });
    expect(assessAdversarialJourney(subject)).toEqual({ status: "passed", failureCode: null });
  });

  test("accepts an independently projected non-divergent cutoff boundary", () => {
    const subject = evidence();
    replaceReviewRace(subject, "review", snapshot({ side: "back" }), completedAtCutoff());
    replaceReviewRace(subject, "conflict", snapshot({ side: "back" }), completedAtCutoff());

    expect(assessAdversarialJourney(subject)).toEqual({ status: "passed", failureCode: null });
  });

  test("does not complete a unique card after its later same-day presentation", () => {
    const subject = evidence();
    const before = snapshot({ side: "back", logs: 1, completed: 1, planned: 21 });
    before.durable.reviewLogs[0]!.commandId = "earlier-review";
    const after = snapshot({ activeCard: "card-2", logs: 2, completed: 2, planned: 22 });
    after.durable.reviewLogs[0]!.commandId = "earlier-review";
    replaceReviewRace(subject, "review", before, after);

    expect(after.visible).toMatchObject({ progressCurrent: 0, progressTotal: 20 });
    expect(assessAdversarialJourney(subject)).toEqual({ status: "passed", failureCode: null });
  });

  test.each([
    ["missing cards", (value: ReturnType<typeof snapshot>) => { value.durable.cards = []; }],
    ["missing schedules", (value: ReturnType<typeof snapshot>) => { value.durable.schedules = []; }],
    ["duplicate queue membership", (value: ReturnType<typeof snapshot>) => {
      value.durable.session.queueEntries[1]!.cardId = cardId;
      value.durable.sessions[0] = value.durable.session;
    }],
    ["wrong deck identity", (value: ReturnType<typeof snapshot>) => {
      value.durable.session.deckId = "wrong-deck";
      value.durable.sessions[0] = value.durable.session;
    }],
    ["invalid cutoff", (value: ReturnType<typeof snapshot>) => {
      value.durable.session.nextDayAt += 24 * 60 * 60 * 1_000;
      value.durable.sessions[0] = value.durable.session;
    }],
    ["missing observation time", (value: ReturnType<typeof snapshot>) => {
      (value.durable as { capturedAt?: number }).capturedAt = undefined;
    }],
    ["stale observation time", (value: ReturnType<typeof snapshot>) => {
      value.durable.capturedAt = value.durable.session.updatedAt - 1;
    }],
    ["impossible review log", (value: ReturnType<typeof snapshot>) => {
      value.durable.reviewLogs[0]!.sessionId = "wrong-session";
    }],
  ])("fails closed through the public assessor for %s", (_name, mutate) => {
    const subject = evidence();
    const selected = subject.races.find((item) => item.kind === "review")!;
    mutate(selected.after as ReturnType<typeof snapshot>);
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "review-race-contract-failed",
    });
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
