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
const invalidCaptureTimes: Array<[string, unknown]> = [
  ["missing", undefined],
  ["null", null],
  ["string", String(capturedAt)],
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
  ["above the valid Date epoch", 8.64e15 + 1],
  ["below the valid Date epoch", -8.64e15 - 1],
];
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
  const reviewedAt = (index: number) => capturedAt - 10 + index;
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
    lastReviewAt: card.id === cardId && logCount > 0 ? reviewedAt(logCount - 1) : null,
    suspended: card.id === cardId ? options.suspended ?? false : false,
    reps: card.id === cardId ? logCount : 0,
  }));
  const queueEntries = cards.map((card, index) => ({
    cardId: card.id,
    dueAt: card.id === cardId ? scheduleDueAt : dayStart,
    ordinal: index + 1,
  }));
  if (planned - completed === 19) queueEntries.shift();
  if (planned - completed === 20 && completed > 0) {
    queueEntries.shift();
    queueEntries.push({ cardId, dueAt: scheduleDueAt, ordinal: cards.length + completed });
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
    queueEntries,
    ratingCounts: { again: 0, hard: 0, good: logCount, easy: 0 },
    startedAt: dayStart,
    updatedAt: logCount > 0 ? reviewedAt(logCount - 1) : dayStart,
    completedAt: null,
    lastCommandIds: Array.from({ length: logCount }, (_, index) =>
      index === logCount - 1 ? "race-review" : `earlier-review-${index}`),
  };
  const reviewLogs = Array.from({ length: logCount }, (_, index) => ({
    id: `log-${index}`,
    sessionId: session.id,
    deckId,
    cardId,
    rating: "good",
    reviewedAt: reviewedAt(index),
    durationMs: null,
    commandId: index === logCount - 1 ? "race-review" : `earlier-review-${index}`,
    before: {
      reps: index,
      state: index === 0 ? "new" : "learning",
      dueAt: index === 0 ? dayStart : dueAt,
      lastReviewAt: index === 0 ? null : reviewedAt(index - 1),
    },
    after: {
      reps: index + 1,
      state: "learning",
      dueAt: scheduleDueAt,
      lastReviewAt: reviewedAt(index),
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
  after.durable.session.lastCommandIds[after.durable.session.lastCommandIds.length - 1] = commandId;
  after.durable.sessions[0] = after.durable.session;
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

function repeatedReviewBoundary(): {
  before: ReturnType<typeof snapshot>;
  after: ReturnType<typeof snapshot>;
} {
  const before = snapshot({ side: "back", logs: 1, completed: 1, planned: 21 });
  before.durable.reviewLogs[0]!.commandId = "earlier-review";
  before.durable.session.lastCommandIds = ["earlier-review"];
  before.durable.capturedAt = dueAt;
  for (const schedule of before.durable.schedules.slice(1)) schedule.dueAt = dueAt + 500;
  for (const entry of before.durable.session.queueEntries) {
    if (entry.cardId !== cardId) entry.dueAt = dueAt + 500;
  }
  before.durable.sessions[0] = before.durable.session;

  const after = structuredClone(before);
  const reviewedAt = dueAt + 900;
  const nextDueAt = dueAt + 5 * 60 * 1_000;
  after.durable.capturedAt = dueAt + 1_000;
  after.visible = {
    state: "active",
    cardId: "card-2",
    side: "front",
    sideDetail: null,
    progressCurrent: 0,
    progressTotal: 20,
  };
  const previousSchedule = structuredClone(after.durable.schedule);
  after.durable.schedule = {
    ...after.durable.schedule,
    dueAt: nextDueAt,
    lastReviewAt: reviewedAt,
    reps: 2,
  };
  after.durable.schedules[0] = after.durable.schedule;
  after.durable.session = {
    ...after.durable.session,
    activeCardId: "card-2",
    currentSide: "front",
    completedPresentationCount: 2,
    plannedPresentationCount: 22,
    updatedAt: reviewedAt,
    queueEntries: [
      ...after.durable.session.queueEntries.filter((entry) => entry.cardId !== cardId),
      { cardId, dueAt: nextDueAt, ordinal: 22 },
    ],
    ratingCounts: { again: 0, hard: 0, good: 2, easy: 0 },
    lastCommandIds: ["earlier-review", "race-review"],
  };
  after.durable.sessions[0] = after.durable.session;
  after.durable.reviewLogs.push({
    id: "log-1",
    sessionId: after.durable.session.id,
    deckId,
    cardId,
    rating: "good",
    reviewedAt,
    durationMs: null,
    commandId: "race-review",
    before: {
      dueAt: previousSchedule.dueAt,
      state: previousSchedule.state,
      lastReviewAt: previousSchedule.lastReviewAt,
      reps: previousSchedule.reps,
    },
    after: {
      dueAt: nextDueAt,
      state: after.durable.schedule.state,
      lastReviewAt: reviewedAt,
      reps: 2,
    },
  });
  return { before, after };
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
  if (kind === "conflict") {
    after.durable.reviewLogs.at(-1)!.commandId = "race-conflict-review";
    after.durable.session.lastCommandIds = ["race-conflict-review"];
    after.durable.sessions[0] = after.durable.session;
  }
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
      invalid: ["missing", "malformed", "wrong-type", "extra"].map((label, index) => {
        const after = structuredClone(before);
        after.durable.capturedAt += index + 1;
        return {
          label,
          call: rejected("INVALID_INPUT"),
          after,
        };
      }),
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

  test("accepts advancing capture metadata without mutating the observed snapshots", () => {
    const subject = evidence();
    const beforeAssessment = structuredClone(subject.validation);

    expect(subject.validation.invalid.map((attempt) =>
      (attempt.after as ReturnType<typeof snapshot>).durable.capturedAt
    ))
      .toEqual([capturedAt + 1, capturedAt + 2, capturedAt + 3, capturedAt + 4]);
    expect(assessAdversarialJourney(subject)).toEqual({ status: "passed", failureCode: null });
    expect(subject.validation).toEqual(beforeAssessment);
  });

  test.each(invalidCaptureTimes)("fails closed for an invalid %s after capture time", (_case, invalidTime) => {
    const subject = evidence();
    const durable = subject.validation.invalid[0]!.after.durable as Record<string, unknown>;
    if (invalidTime === undefined) delete durable.capturedAt;
    else durable.capturedAt = invalidTime;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "capture-time:missing:after-invalid",
    });
  });

  test.each(invalidCaptureTimes)("fails closed for an invalid %s before capture time", (_case, invalidTime) => {
    const subject = evidence();
    const durable = subject.validation.before.durable as Record<string, unknown>;
    if (invalidTime === undefined) delete durable.capturedAt;
    else durable.capturedAt = invalidTime;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "capture-time:missing:before-invalid",
    });
  });

  test("rejects backward capture time but permits equal capture time", () => {
    const backward = evidence();
    (backward.validation.invalid[0]!.after.durable as Record<string, unknown>).capturedAt = capturedAt - 1;
    expect(assessAdversarialJourney(backward)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "capture-time:missing:after-backward",
    });

    const equalTime = evidence();
    (equalTime.validation.invalid[0]!.after.durable as Record<string, unknown>).capturedAt = capturedAt;
    expect(assessAdversarialJourney(equalTime)).toEqual({ status: "passed", failureCode: null });
  });

  test.each([
    ["persisted timestamp", (after: ReturnType<typeof snapshot>) => {
      after.durable.session.updatedAt += 1;
      after.durable.sessions[0] = after.durable.session;
    }],
    ["nested capturedAt", (after: ReturnType<typeof snapshot>) => {
      (after.durable.cards[0] as Record<string, unknown>).capturedAt = capturedAt + 1;
    }],
    ["visible capturedAt", (after: ReturnType<typeof snapshot>) => {
      (after.visible as Record<string, unknown>).capturedAt = capturedAt + 1;
    }],
  ])("keeps %s material when top-level capture time advances", (_case, mutate) => {
    const subject = evidence();
    const after = subject.validation.invalid[0]!.after as ReturnType<typeof snapshot>;
    mutate(after);

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "material-mutation:missing",
    });
  });

  test("accepts an independently projected non-divergent cutoff boundary", () => {
    const subject = evidence();
    replaceReviewRace(subject, "review", snapshot({ side: "back" }), completedAtCutoff());
    replaceReviewRace(subject, "conflict", snapshot({ side: "back" }), completedAtCutoff());

    expect(assessAdversarialJourney(subject)).toEqual({ status: "passed", failureCode: null });
  });

  test("does not complete a unique card after its later same-day presentation", () => {
    const subject = evidence();
    const { before, after } = repeatedReviewBoundary();
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

  test.each([
    ["before visible progress", (review: AdversarialRace) => {
      (review.before.visible as Record<string, unknown>).progressCurrent = 1;
    }],
    ["visible current progress", (review: AdversarialRace) => {
      (review.after.visible as Record<string, unknown>).progressCurrent = 1;
    }],
    ["visible total progress", (review: AdversarialRace) => {
      (review.after.visible as Record<string, unknown>).progressTotal = 21;
    }],
    ["returned tool completed progress", (review: AdversarialRace) => {
      const state = (review.calls[0]!.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
      state.session.completed_presentations = 0;
      review.calls[1] = structuredClone(review.calls[0]!);
    }],
    ["returned tool planned progress", (review: AdversarialRace) => {
      const state = (review.calls[0]!.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
      state.session.planned_presentations = 20;
      review.calls[1] = structuredClone(review.calls[0]!);
    }],
    ["durable completed progress", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.completedPresentationCount = 2;
      durable.sessions[0] = durable.session;
    }],
    ["durable planned progress", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.plannedPresentationCount = 20;
      durable.sessions[0] = durable.session;
    }],
    ["queue readiness", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.queueEntries[0]!.dueAt += 1;
      durable.sessions[0] = durable.session;
    }],
    ["logged schedule transition", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.reviewLogs[0]!.before.dueAt += 1;
    }],
    ["coherently copied stale transition time", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      const staleReviewAt = durable.reviewLogs[0]!.reviewedAt - 1;
      durable.schedule.lastReviewAt = staleReviewAt;
      durable.schedules[0] = durable.schedule;
      durable.reviewLogs[0]!.after.lastReviewAt = staleReviewAt;
    }],
    ["coherently copied extra repetition", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.schedule.reps += 1;
      durable.schedules[0] = durable.schedule;
      durable.reviewLogs[0]!.after.reps = durable.schedule.reps;
    }],
    ["unrelated queue removal with self-consistent counters", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.queueEntries = durable.session.queueEntries.filter((entry) => entry.cardId !== "card-20");
      durable.session.plannedPresentationCount -= 1;
      durable.sessions[0] = durable.session;
      (review.after.visible as Record<string, unknown>).progressTotal = 19;
      for (const call of review.calls) {
        const state = (call.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
        state.session.planned_presentations = durable.session.plannedPresentationCount;
      }
    }],
    ["missing persisted command binding", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.lastCommandIds = [];
      durable.sessions[0] = durable.session;
    }],
    ["snapshot observation time", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.capturedAt = durable.session.updatedAt - 1;
    }],
    ["unrelated card mutation", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      (durable.cards[1] as Record<string, unknown>).unexpected = true;
    }],
  ])("rejects independently corrupted same-command %s", (_name, mutate) => {
    const subject = evidence();
    const review = subject.races.find((item) => item.kind === "review")!;
    mutate(review);
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "review-race-contract-failed",
    });
  });

  test("rejects alteration of earlier persisted command history on a later review", () => {
    const subject = evidence();
    const { before, after } = repeatedReviewBoundary();
    replaceReviewRace(subject, "review", before, after);
    after.durable.session.lastCommandIds[0] = "replaced-earlier-command";
    after.durable.sessions[0] = after.durable.session;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "review-race-contract-failed",
    });
  });

  test("rejects final visible state drift", () => {
    const drifted = evidence();
    const conflict = drifted.races.find((item) => item.kind === "conflict")!;
    (conflict.after.visible as Record<string, unknown>).cardId = "wrong-card";
    expect(assessAdversarialJourney(drifted).failureCode).toBe("conflict-race-contract-failed");
  });

  test.each([
    ["before visible current progress", (conflict: AdversarialRace) => {
      (conflict.before.visible as Record<string, unknown>).progressCurrent = 1;
    }],
    ["after visible current progress", (conflict: AdversarialRace) => {
      (conflict.after.visible as Record<string, unknown>).progressCurrent = 1;
    }],
    ["after visible total progress", (conflict: AdversarialRace) => {
      (conflict.after.visible as Record<string, unknown>).progressTotal = 21;
    }],
    ["winning tool completed progress", (conflict: AdversarialRace) => {
      const state = (conflict.calls[0]!.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
      state.session.completed_presentations = 0;
    }],
    ["winning tool planned progress", (conflict: AdversarialRace) => {
      const state = (conflict.calls[0]!.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
      state.session.planned_presentations = 20;
    }],
    ["durable completed progress", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.completedPresentationCount = 2;
      durable.sessions[0] = durable.session;
    }],
    ["durable planned progress", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.plannedPresentationCount = 20;
      durable.sessions[0] = durable.session;
    }],
    ["queue readiness", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.queueEntries[0]!.dueAt += 1;
      durable.sessions[0] = durable.session;
    }],
    ["review log transition", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.reviewLogs[0]!.before.dueAt += 1;
    }],
    ["coherently copied stale transition time", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      const staleReviewAt = durable.reviewLogs[0]!.reviewedAt - 1;
      durable.schedule.lastReviewAt = staleReviewAt;
      durable.schedules[0] = durable.schedule;
      durable.reviewLogs[0]!.after.lastReviewAt = staleReviewAt;
    }],
    ["coherently copied extra repetition", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.schedule.reps += 1;
      durable.schedules[0] = durable.schedule;
      durable.reviewLogs[0]!.after.reps = durable.schedule.reps;
    }],
    ["unrelated queue removal with self-consistent counters", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.queueEntries = durable.session.queueEntries.filter((entry) => entry.cardId !== "card-20");
      durable.session.plannedPresentationCount -= 1;
      durable.sessions[0] = durable.session;
      (conflict.after.visible as Record<string, unknown>).progressTotal = 19;
      for (const call of [conflict.calls[0]!, conflict.readCalls[1]!]) {
        const state = (call.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
        state.session.planned_presentations = durable.session.plannedPresentationCount;
      }
    }],
    ["missing persisted command binding", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.lastCommandIds = [];
      durable.sessions[0] = durable.session;
    }],
    ["active card", (conflict: AdversarialRace) => {
      (conflict.after.visible as Record<string, unknown>).cardId = "wrong-card";
    }],
    ["snapshot observation time", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.capturedAt = durable.session.updatedAt - 1;
    }],
    ["unrelated durable record", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      (durable.cards[1] as Record<string, unknown>).unexpected = true;
    }],
  ])("rejects independently corrupted conflict %s", (_name, mutate) => {
    const subject = evidence();
    const conflict = subject.races.find((item) => item.kind === "conflict")!;
    mutate(conflict);
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "conflict-race-contract-failed",
    });
  });

  test("rejects alteration of earlier persisted command history on a later conflict", () => {
    const subject = evidence();
    const { before, after } = repeatedReviewBoundary();
    replaceReviewRace(subject, "conflict", before, after);
    after.durable.session.lastCommandIds[0] = "replaced-earlier-command";
    after.durable.sessions[0] = after.durable.session;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "conflict-race-contract-failed",
    });
  });

  test("rejects conflict winner identity, loser reason, and missing race reads", () => {
    const wrongWinner = evidence();
    const winner = wrongWinner.races.find((item) => item.kind === "conflict")!.calls[0]!;
    (winner.result as { data: { command_id: string } }).data.command_id = "race-review";
    expect(assessAdversarialJourney(wrongWinner).failureCode).toBe("conflict-race-contract-failed");

    const wrongReason = evidence();
    wrongReason.races.find((item) => item.kind === "conflict")!.calls[1] = rejected("DUPLICATE_COMMAND");
    expect(assessAdversarialJourney(wrongReason).failureCode).toBe("conflict-race-contract-failed");

    const skippedRead = evidence();
    skippedRead.races.find((item) => item.kind === "conflict")!.readCalls.pop();
    expect(assessAdversarialJourney(skippedRead).failureCode).toBe("conflict-race-contract-failed");
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
