import { describe, expect, test } from "bun:test";

import {
  assessStudyJourney,
  type StudyJourneyEvidence,
  type StudyJourneySnapshot,
} from "../../scripts/webmcp-study-journey";
import { activeStudyToolContracts } from "../../scripts/webmcp-production-contract";
import type { ScheduleRecord } from "../../lib/domain/entities";
import { createProductionSchedulerAdapter } from "../../lib/domain/scheduler";

const deckId = "seed-spanish-basics";
const cardId = "card-1";
const DAY_START = Date.parse("2026-09-01T07:00:00.000Z");
const NOW = DAY_START + 12 * 60 * 60 * 1_000;
const NEXT_DAY = Date.parse("2026-09-02T07:00:00.000Z");
const canonicalScheduler = createProductionSchedulerAdapter();

function scheduleSnapshot(value: ScheduleRecord): Omit<ScheduleRecord, "cardId" | "deckId"> {
  const { cardId: _cardId, deckId: _deckId, ...snapshotValue } = value;
  void _cardId;
  void _deckId;
  return snapshotValue;
}

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
    lastCommandIds: completed ? ["rate-1"] : [],
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
  const schedules = cards.map((candidate) => {
    const initial = canonicalScheduler.createNewCardFor(candidate.id, deckId, new Date(DAY_START));
    return completed && candidate.id === cardId
      ? canonicalScheduler.apply(initial, "good", new Date(NOW)).schedule
      : initial;
  });
  const reviewedBefore = canonicalScheduler.createNewCardFor(cardId, deckId, new Date(DAY_START));
  const reviewedAfter = canonicalScheduler.apply(reviewedBefore, "good", new Date(NOW)).schedule;
  const reviewLogs = completed ? [{
    id: "log-1",
    sessionId: "session-1",
    cardId,
    deckId,
    rating: "good",
    commandId: "rate-1",
    reviewedAt: NOW,
    before: scheduleSnapshot(reviewedBefore),
    after: scheduleSnapshot(reviewedAfter),
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
        decks: [{
          id: deckId,
          name: "Spanish Basics",
          ...(completed ? { lastStudiedAt: NOW } : {}),
        }],
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

type TestSchedule = ScheduleRecord;

type TestReviewLog = {
  id: string;
  sessionId: string;
  cardId: string;
  deckId: string;
  rating: string;
  commandId: string;
  reviewedAt: number;
  before: Omit<TestSchedule, "cardId" | "deckId">;
  after: Omit<TestSchedule, "cardId" | "deckId">;
};

type TestSession = Omit<ReturnType<typeof session>, "activeCardId" | "completedAt"> & {
  activeCardId: string | null;
  completedAt: number | null;
};

type TestDurable = {
  capturedAt: number;
  session: TestSession;
  card: ReturnType<typeof card> | null;
  schedule: TestSchedule | null;
  schedules: TestSchedule[];
  reviewLogs: TestReviewLog[];
  stores: {
    cards: Array<ReturnType<typeof card>>;
    schedules: TestSchedule[];
    sessions: TestSession[];
    reviewLogs: TestReviewLog[];
    decks: Array<{ id: string; name: string; lastStudiedAt?: number }>;
    meta: Array<{ key: string; value: number; capturedAt?: number }>;
  };
};

type TestVisible = {
  state: string;
  cardId: string | null;
  side: string | null;
  answerState: string;
  answerSemantic: unknown;
  content: string;
  progressCurrent: number | string;
  progressTotal: number;
};

type TestCallResult = {
  data: {
    state: {
      status: string;
      current_card: { id: string; front_text: string } | null;
      session: { completed_presentations: number; planned_presentations: number };
    };
    transition: {
      rating: string;
      reviewed_card_id: string;
      next_due_at: string;
      next_card_id: string | null;
      idempotent: boolean;
    };
  };
};

function durableOf(value: StudyJourneySnapshot): TestDurable {
  return value.durable as TestDurable;
}

function visibleOf(value: StudyJourneySnapshot): TestVisible {
  return value.visible as TestVisible;
}

function resultOf(value: StudyJourneyEvidence["getStateCall"]): TestCallResult {
  return value.result as TestCallResult;
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

function setIncreasingCaptureTimes(subject: StudyJourneyEvidence): StudyJourneySnapshot[] {
  const snapshots = [
    "before",
    "afterRead",
    "afterRepeatedRead",
    "afterPrematureRating",
    "afterFlip",
    "afterFlipRetry",
    "afterRating",
  ] as const;
  return snapshots.map((name, index) => {
    subject[name] = structuredClone(subject[name]);
    durableOf(subject[name]).capturedAt = NOW + index;
    return subject[name];
  });
}

function setRatingOutcome(
  subject: StudyJourneyEvidence,
  rating: StudyJourneyEvidence["rating"],
  expectedDueAt?: number,
): void {
  const beforeSchedule = durableOf(subject.afterFlip).schedules
    .find((value) => value.cardId === cardId)!;
  const appliedSchedule = canonicalScheduler.apply(beforeSchedule, rating, new Date(NOW)).schedule;
  if (expectedDueAt !== undefined && appliedSchedule.dueAt !== expectedDueAt) {
    throw new Error(`Unexpected canonical ${rating} dueAt: ${appliedSchedule.dueAt}`);
  }
  const dueAt = appliedSchedule.dueAt;
  subject.rating = rating;
  const result = subject.ratingCall.result as {
    data: {
      state: { session: { planned_presentations: number } };
      transition: { rating: string; next_due_at: string };
    };
  };
  result.data.transition.rating = rating;
  result.data.transition.next_due_at = new Date(dueAt).toISOString();
  const durable = durableOf(subject.afterRating);
  durable.reviewLogs[0]!.rating = rating;
  durable.reviewLogs[0]!.before = scheduleSnapshot(beforeSchedule);
  durable.reviewLogs[0]!.after = scheduleSnapshot(appliedSchedule);
  const reviewedIndex = durable.schedules.findIndex((value) => value.cardId === cardId);
  durable.schedules[reviewedIndex] = appliedSchedule;
  durable.stores.schedules = durable.schedules;
  durable.stores.reviewLogs = durable.reviewLogs;
  const requeued = durable.session.queueEntries.find((entry) => entry.cardId === cardId);
  if (requeued) requeued.dueAt = dueAt;
  durable.session.ratingCounts = { again: 0, hard: 0, good: 0, easy: 0 };
  durable.session.ratingCounts[rating] = 1;
  if (dueAt >= NEXT_DAY) {
    durable.session.queueEntries = durable.session.queueEntries.filter((entry) => entry.cardId !== cardId);
    durable.session.plannedPresentationCount = 20;
    result.data.state.session.planned_presentations = 20;
    (subject.afterRating.visible as { progressCurrent: number }).progressCurrent = 1;
  }
}

function evidenceForScheduleState(
  stateValue: "review" | "relearning",
  rating: StudyJourneyEvidence["rating"],
): StudyJourneyEvidence {
  const subject = evidence();
  const priorSchedule: ScheduleRecord = {
    cardId,
    deckId,
    dueAt: DAY_START - 1,
    stability: 4,
    difficulty: 5,
    elapsedDays: 1,
    scheduledDays: 4,
    reps: 3,
    lapses: stateValue === "relearning" ? 1 : 0,
    state: stateValue,
    lastReviewAt: NOW - 24 * 60 * 60 * 1_000,
    suspended: false,
    learningSteps: stateValue === "relearning" ? 0 : undefined,
    legacyEaseFactor: null,
  };
  for (const snapshotValue of [
    subject.before,
    subject.afterRead,
    subject.afterRepeatedRead,
    subject.afterPrematureRating,
    subject.afterFlip,
    subject.afterFlipRetry,
  ]) {
    const durable = durableOf(snapshotValue);
    durable.schedules[0] = structuredClone(priorSchedule);
    durable.stores.schedules = durable.schedules;
    durable.schedule = durable.schedules[0];
    durable.session.queueEntries[0]!.dueAt = priorSchedule.dueAt;
    durable.stores.sessions = [durable.session];
  }
  setRatingOutcome(subject, rating);
  return subject;
}

function forgeMirroredDueAt(subject: StudyJourneyEvidence, forgedDueAt: number): void {
  const durable = durableOf(subject.afterRating);
  durable.schedules.find((schedule) => schedule.cardId === cardId)!.dueAt = forgedDueAt;
  durable.stores.schedules.find((schedule) => schedule.cardId === cardId)!.dueAt = forgedDueAt;
  durable.reviewLogs[durable.reviewLogs.length - 1]!.after.dueAt = forgedDueAt;
  durable.stores.reviewLogs[durable.stores.reviewLogs.length - 1]!.after.dueAt = forgedDueAt;
  const requeued = durable.session.queueEntries.find((entry) => entry.cardId === cardId);
  if (requeued) requeued.dueAt = forgedDueAt;
  const storedRequeue = durable.stores.sessions[0]!.queueEntries
    .find((entry) => entry.cardId === cardId);
  if (storedRequeue) storedRequeue.dueAt = forgedDueAt;
  resultOf(subject.ratingCall).data.transition.next_due_at = new Date(forgedDueAt).toISOString();
}

function singleCardLifecycleEvidence(
  beforeCompleted = 0,
  rating: StudyJourneyEvidence["rating"] = "good",
): StudyJourneyEvidence {
  const subject = evidence();
  const ratingTime = NOW;
  const initialSchedule = canonicalScheduler.createNewCardFor(cardId, deckId, new Date(DAY_START));
  const priorReviewedAt = ratingTime - 10 * 60 * 1_000;
  const priorApplied = canonicalScheduler.apply(
    initialSchedule,
    "good",
    new Date(priorReviewedAt),
  ).schedule;
  const beforeSchedule = beforeCompleted === 0 ? initialSchedule : priorApplied;
  const appliedSchedule = canonicalScheduler.apply(beforeSchedule, rating, new Date(ratingTime)).schedule;
  const dueAt = appliedSchedule.dueAt;
  const priorCounts = { again: 0, hard: 0, good: beforeCompleted, easy: 0 };
  const priorLogs: TestReviewLog[] = beforeCompleted === 0 ? [] : [{
    id: "prior-log-1",
    sessionId: "session-1",
    cardId,
    deckId,
    rating: "good",
    commandId: "prior-rate-1",
    reviewedAt: priorReviewedAt,
    before: scheduleSnapshot(initialSchedule),
    after: scheduleSnapshot(priorApplied),
  }];

  const configureBefore = (snapshotValue: StudyJourneySnapshot, side: "front" | "back") => {
    const durable = durableOf(snapshotValue);
    const visible = visibleOf(snapshotValue);
    const currentSession = durable.session;
    durable.schedules = [structuredClone(beforeSchedule)];
    durable.reviewLogs = structuredClone(priorLogs);
    durable.stores.cards = [durable.stores.cards[0]];
    durable.stores.schedules = durable.schedules;
    durable.stores.reviewLogs = durable.reviewLogs;
    currentSession.queueEntries = [{
      cardId,
      dueAt: beforeSchedule.dueAt,
      ordinal: beforeCompleted + 1,
    }];
    currentSession.completedPresentationCount = beforeCompleted;
    currentSession.plannedPresentationCount = beforeCompleted + 1;
    currentSession.ratingCounts = structuredClone(priorCounts);
    currentSession.lastCommandIds = priorLogs.map((log) => log.commandId);
    currentSession.currentSide = side;
    currentSession.activeCardId = cardId;
    durable.stores.sessions = [currentSession];
    visible.progressCurrent = 0;
    visible.progressTotal = 1;
  };
  configureBefore(subject.before, "front");
  configureBefore(subject.afterRead, "front");
  configureBefore(subject.afterRepeatedRead, "front");
  configureBefore(subject.afterPrematureRating, "front");
  configureBefore(subject.afterFlip, "back");
  configureBefore(subject.afterFlipRetry, "back");
  for (const journeyCall of [
    subject.getStateCall,
    subject.repeatedGetStateCall,
    subject.flipCall,
    subject.flipRetryCall,
  ]) {
    const callState = resultOf(journeyCall).data.state.session;
    callState.completed_presentations = beforeCompleted;
    callState.planned_presentations = beforeCompleted + 1;
  }

  const afterDurable = durableOf(subject.afterRating);
  const afterVisible = visibleOf(subject.afterRating);
  const afterSession = afterDurable.session;
  afterDurable.schedules = [appliedSchedule];
  afterDurable.reviewLogs = [...structuredClone(priorLogs), {
    id: "log-1",
    sessionId: "session-1",
    cardId,
    deckId,
    rating,
    commandId: "rate-1",
    reviewedAt: ratingTime,
    before: scheduleSnapshot(beforeSchedule),
    after: scheduleSnapshot(appliedSchedule),
  }];
  afterDurable.stores.cards = [afterDurable.stores.cards[0]];
  afterDurable.stores.schedules = afterDurable.schedules;
  afterDurable.stores.reviewLogs = afterDurable.reviewLogs;
  afterDurable.stores.decks[0].lastStudiedAt = ratingTime;
  const remainsToday = dueAt < NEXT_DAY;
  afterSession.queueEntries = remainsToday
    ? [{ cardId, dueAt, ordinal: beforeCompleted + 2 }]
    : [];
  afterSession.activeCardId = null;
  afterSession.currentSide = "front";
  afterSession.completedPresentationCount = beforeCompleted + 1;
  afterSession.plannedPresentationCount = beforeCompleted + 1 + Number(remainsToday);
  afterSession.ratingCounts = { ...priorCounts, [rating]: priorCounts[rating] + 1 };
  afterSession.lastCommandIds = [...priorLogs.map((log) => log.commandId), "rate-1"];
  afterSession.completedAt = remainsToday ? null : ratingTime;
  afterDurable.stores.sessions = [afterSession];
  afterDurable.card = null;
  afterDurable.schedule = null;
  afterVisible.state = remainsToday ? "waiting" : "completion";
  afterVisible.cardId = null;
  afterVisible.side = null;
  afterVisible.answerState = "withheld";
  afterVisible.answerSemantic = null;
  afterVisible.content = "";
  afterVisible.progressCurrent = remainsToday ? 0 : 1;
  afterVisible.progressTotal = 1;

  const rated = resultOf(subject.ratingCall);
  rated.data.state.status = afterVisible.state;
  rated.data.state.current_card = null;
  rated.data.state.session.completed_presentations = beforeCompleted + 1;
  rated.data.state.session.planned_presentations = afterSession.plannedPresentationCount;
  rated.data.transition.next_due_at = new Date(dueAt).toISOString();
  rated.data.transition.next_card_id = null;
  rated.data.transition.rating = rating;
  subject.rating = rating;
  return subject;
}

describe("production study journey classification", () => {
  test("accepts increasing acquisition times without rewriting the timestamp-bearing snapshots", () => {
    const subject = evidence();
    const snapshots = setIncreasingCaptureTimes(subject);

    expect(assessStudyJourney(subject)).toEqual({
      status: "passed", failureCode: null, failureDetail: null,
    });
    expect(snapshots.map((snapshotValue) => durableOf(snapshotValue).capturedAt))
      .toEqual(snapshots.map((_snapshotValue, index) => NOW + index));
  });

  test.each([
    ["missing", undefined],
    ["null", null],
    ["string", String(NOW)],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["outside the Date epoch", 8_640_000_000_000_001],
  ])("fails closed for a %s capture timestamp", (_case, capturedAt) => {
    const subject = evidence();
    setIncreasingCaptureTimes(subject);
    const durable = subject.before.durable as Record<string, unknown>;
    if (capturedAt === undefined) delete durable.capturedAt;
    else durable.capturedAt = capturedAt;

    expect(assessStudyJourney(subject)).toEqual({
      status: "failed",
      failureCode: "capture-timestamp-invalid",
      failureDetail: "durable:capture-time:before:invalid",
    });
  });

  test("attributes backward capture chronology before material mutation assessment", () => {
    const subject = evidence();
    setIncreasingCaptureTimes(subject);
    durableOf(subject.afterRead).capturedAt = NOW + 2;
    durableOf(subject.afterRepeatedRead).capturedAt = NOW + 1;
    durableOf(subject.afterRepeatedRead).stores.meta[0]!.value = 4;

    expect(assessStudyJourney(subject)).toEqual({
      status: "failed",
      failureCode: "capture-timestamp-invalid",
      failureDetail: "durable:capture-time:afterRepeatedRead:backward",
    });
  });

  test("keeps persisted and nested timestamp fields material while capture time advances", () => {
    const persisted = evidence();
    setIncreasingCaptureTimes(persisted);
    durableOf(persisted.afterRead).session.updatedAt = NOW + 1;
    durableOf(persisted.afterRead).stores.sessions[0]!.updatedAt = NOW + 1;
    expect(assessStudyJourney(persisted)).toMatchObject({
      status: "failed",
      failureCode: "get-state-parity-or-mutation",
      failureDetail: "front-tool-visible-durable-parity",
    });

    const nested = evidence();
    setIncreasingCaptureTimes(nested);
    durableOf(nested.before).stores.meta[0]!.capturedAt = NOW - 1;
    durableOf(nested.afterRead).stores.meta[0]!.capturedAt = NOW;
    expect(assessStudyJourney(nested)).toMatchObject({
      status: "failed",
      failureCode: "get-state-parity-or-mutation",
      failureDetail: "front-tool-visible-durable-parity",
    });
  });

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

  test.each([
    ["again", NOW + 60_000],
    ["hard", NOW + 6 * 60_000],
    ["good", NOW + 10 * 60_000],
  ] as const)(
    "accepts %s with a same-day requeue and independent visible progress",
    (rating, dueAt) => {
      const subject = evidence();
      setRatingOutcome(subject, rating, dueAt);
      expect(assessStudyJourney(subject)).toEqual({
        status: "passed", failureCode: null, failureDetail: null,
      });
    },
  );

  test("accepts Easy beyond the day cutoff as unique-card completion", () => {
    const subject = evidence();
    setRatingOutcome(subject, "easy");
    expect(assessStudyJourney(subject)).toEqual({
      status: "passed", failureCode: null, failureDetail: null,
    });
  });

  test("accepts waiting, repeated-presentation, and completed session outcomes", () => {
    expect(assessStudyJourney(singleCardLifecycleEvidence()))
      .toEqual({ status: "passed", failureCode: null, failureDetail: null });
    expect(assessStudyJourney(singleCardLifecycleEvidence(1, "again")))
      .toEqual({ status: "passed", failureCode: null, failureDetail: null });
    expect(assessStudyJourney(singleCardLifecycleEvidence(0, "easy")))
      .toEqual({ status: "passed", failureCode: null, failureDetail: null });
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

  test.each([
    ["rating", "tool:rating-transition", (subject: StudyJourneyEvidence) => {
      resultOf(subject.ratingCall).data.transition.rating = "hard";
    }],
    ["reviewed card", "tool:rating-transition", (subject: StudyJourneyEvidence) => {
      resultOf(subject.ratingCall).data.transition.reviewed_card_id = "card-2";
    }],
    ["next card", "tool:rating-transition", (subject: StudyJourneyEvidence) => {
      resultOf(subject.ratingCall).data.transition.next_card_id = "card-3";
    }],
    ["next due", "durable:schedule", (subject: StudyJourneyEvidence) => {
      resultOf(subject.ratingCall).data.transition.next_due_at =
        new Date(NOW + 1).toISOString();
    }],
    ["idempotent flag", "tool:rating-transition", (subject: StudyJourneyEvidence) => {
      resultOf(subject.ratingCall).data.transition.idempotent = true;
    }],
  ] as const)("rejects an independently wrong tool %s", (_label, detail, mutate) => {
    const subject = evidence();
    mutate(subject);
    expect(assessStudyJourney(subject)).toMatchObject({
      status: "failed",
      failureCode: "rating-transition-mismatch",
      failureDetail: detail,
    });
  });

  test("rejects stale serialized state after the transition itself agrees", () => {
    const stale = evidence();
    resultOf(stale.ratingCall).data.state.session.completed_presentations = 0;
    expect(assessStudyJourney(stale).failureDetail).toBe("durable:session");

    const staleCard = evidence();
    resultOf(staleCard.ratingCall).data.state.current_card!.front_text = "stale";
    expect(assessStudyJourney(staleCard).failureDetail).toBe("tool:serialized-state");
  });

  test.each([
    ["missing log", "durable:review-log", (subject: StudyJourneyEvidence) => {
      durableOf(subject.afterRating).reviewLogs = [];
    }],
    ["duplicate log", "durable:review-log", (subject: StudyJourneyEvidence) => {
      const durable = durableOf(subject.afterRating);
      durable.reviewLogs.push(structuredClone(durable.reviewLogs[0]));
    }],
    ["wrong log session", "durable:review-log", (subject: StudyJourneyEvidence) => {
      durableOf(subject.afterRating).reviewLogs[0]!.sessionId = "session-other";
    }],
    ["wrong log card", "durable:review-log", (subject: StudyJourneyEvidence) => {
      durableOf(subject.afterRating).reviewLogs[0]!.cardId = "card-2";
    }],
    ["wrong log rating", "durable:review-log", (subject: StudyJourneyEvidence) => {
      durableOf(subject.afterRating).reviewLogs[0]!.rating = "hard";
    }],
    ["wrong log command", "durable:review-log", (subject: StudyJourneyEvidence) => {
      durableOf(subject.afterRating).reviewLogs[0]!.commandId = "rate-other";
    }],
    ["wrong before schedule", "durable:schedule", (subject: StudyJourneyEvidence) => {
      durableOf(subject.afterRating).reviewLogs[0]!.before.reps = 7;
    }],
    ["wrong after schedule", "durable:schedule", (subject: StudyJourneyEvidence) => {
      durableOf(subject.afterRating).reviewLogs[0]!.after.reps = 7;
    }],
  ] as const)("rejects durable collision: %s", (_label, detail, mutate) => {
    const subject = evidence();
    mutate(subject);
    expect(assessStudyJourney(subject)).toMatchObject({
      status: "failed", failureCode: "rating-transition-mismatch", failureDetail: detail,
    });
  });

  test("rejects a coherently mirrored but impossible schedule transition", () => {
    const subject = evidence();
    const forgedDueAt = NOW + 11 * 60_000;
    forgeMirroredDueAt(subject, forgedDueAt);

    expect(assessStudyJourney(subject)).toMatchObject({
      status: "failed",
      failureCode: "rating-transition-mismatch",
      failureDetail: "durable:schedule-transition",
    });
  });

  test.each([
    ["new Easy", () => {
      const subject = evidence();
      setRatingOutcome(subject, "easy");
      return subject;
    }],
    ["review Good", () => evidenceForScheduleState("review", "good")],
    ["relearning Good", () => evidenceForScheduleState("relearning", "good")],
  ] as const)("rejects a coherently forged canonical due date for %s", (_label, makeSubject) => {
    const subject = makeSubject();
    const currentDueAt = durableOf(subject.afterRating).schedules
      .find((schedule) => schedule.cardId === cardId)!.dueAt;
    forgeMirroredDueAt(subject, currentDueAt + 24 * 60 * 60 * 1_000);

    expect(assessStudyJourney(subject)).toMatchObject({
      status: "failed",
      failureCode: "rating-transition-mismatch",
      failureDetail: "durable:schedule-transition",
    });
  });

  test("rejects queue, counter, active-card, and allowlist collisions", () => {
    const queue = evidence();
    const queueDurable = durableOf(queue.afterRating);
    queueDurable.session.queueEntries.splice(1, 1);
    queueDurable.session.plannedPresentationCount -= 1;
    resultOf(queue.ratingCall).data.state.session.planned_presentations -= 1;
    visibleOf(queue.afterRating).progressTotal -= 1;
    expect(assessStudyJourney(queue).failureDetail).toBe("durable:session-queue");

    const counts = evidence();
    const countDurable = durableOf(counts.afterRating);
    countDurable.session.ratingCounts.good = 0;
    countDurable.session.ratingCounts.easy = 1;
    expect(assessStudyJourney(counts).failureDetail).toBe("durable:session-rating-counts");

    const active = evidence();
    const activeDurable = durableOf(active.afterRating);
    activeDurable.session.activeCardId = "card-3";
    activeDurable.card = activeDurable.stores.cards[2];
    visibleOf(active.afterRating).cardId = "card-3";
    visibleOf(active.afterRating).content = "adiós";
    resultOf(active.ratingCall).data.state.current_card!.id = "card-3";
    resultOf(active.ratingCall).data.transition.next_card_id = "card-3";
    expect(assessStudyJourney(active).failureDetail).toBe("durable:session_active_card_relationship");

    const deck = evidence();
    durableOf(deck.afterRating).stores.decks[0]!.name = "Hostile rename";
    expect(assessStudyJourney(deck).failureDetail).toBe("durable:illegal-rating-mutation");
  });

  test("rejects malformed and stale visible progress without copying presentation counters", () => {
    const malformed = evidence();
    visibleOf(malformed.afterRating).progressCurrent = "0";
    expect(assessStudyJourney(malformed).failureDetail).toBe("visible:progress");

    const staleCompletion = evidence();
    setRatingOutcome(staleCompletion, "easy");
    visibleOf(staleCompletion.afterRating).progressCurrent = 0;
    expect(assessStudyJourney(staleCompletion).failureDetail).toBe("visible:progress");

    const copiedPresentation = evidence();
    visibleOf(copiedPresentation.afterRating).progressCurrent = 1;
    visibleOf(copiedPresentation.afterRating).progressTotal = 21;
    expect(assessStudyJourney(copiedPresentation).failureDetail).toBe("visible:progress");
  });

  test("preserves deterministic first failure and the browser-error boundary", () => {
    const simultaneous = evidence();
    resultOf(simultaneous.ratingCall).data.transition.rating = "hard";
    visibleOf(simultaneous.afterRating).progressCurrent = 99;
    simultaneous.browserErrors.push("pageerror: hostile");
    expect(assessStudyJourney(simultaneous).failureDetail).toBe("tool:rating-transition");

    const browser = evidence();
    browser.browserErrors.push("pageerror: production failure");
    expect(assessStudyJourney(browser)).toMatchObject({
      status: "failed",
      failureCode: "study-journey-browser-errors",
      failureDetail: "browser-errors",
    });
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
