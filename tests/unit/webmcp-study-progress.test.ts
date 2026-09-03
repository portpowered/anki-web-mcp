import { describe, expect, test } from "bun:test";

import {
  DurableStudyProgressError,
  projectDurableVisibleStudyProgress,
  type DurableStudyProgressSnapshot,
} from "../../scripts/webmcp-study-progress";

const DAY_START = Date.parse("2026-09-01T07:00:00.000Z");
const NOW = DAY_START + 12 * 60 * 60 * 1_000;
const NEXT_DAY = Date.parse("2026-09-02T07:00:00.000Z");

function snapshot(): DurableStudyProgressSnapshot {
  const cards = Array.from({ length: 20 }, (_, index) => ({
    id: `card-${index + 1}`,
    deckId: "deck-1",
  }));
  const schedules = cards.map((card) => ({
    cardId: card.id,
    deckId: card.deckId,
    dueAt: DAY_START,
    state: "new" as const,
    lastReviewAt: null,
    suspended: false,
  }));
  return {
    capturedAt: NOW,
    deckId: "deck-1",
    sessionId: "session-1",
    decks: [{ id: "deck-1" }],
    cards,
    schedules,
    sessions: [{
      id: "session-1",
      deckId: "deck-1",
      dayKey: "2026-09-01",
      sequence: 1,
      nextDayAt: NEXT_DAY,
      queueEntries: cards.map((card, index) => ({
        cardId: card.id,
        dueAt: DAY_START,
        ordinal: index + 1,
      })),
      activeCardId: "card-1",
      plannedPresentationCount: 20,
      completedPresentationCount: 0,
      currentSide: "front",
      ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
      startedAt: DAY_START + 1,
      updatedAt: NOW,
      completedAt: null,
    }],
  };
}

function rateFirstCard(subject: DurableStudyProgressSnapshot, dueAt: number): void {
  const session = subject.sessions[0]!;
  subject.schedules[0] = {
    ...subject.schedules[0]!,
    dueAt,
    state: "learning",
    lastReviewAt: NOW,
  };
  session.queueEntries.shift();
  session.completedPresentationCount = 1;
  session.ratingCounts.good = 1;
  if (dueAt < NEXT_DAY) {
    session.queueEntries.push({ cardId: "card-1", dueAt, ordinal: 21 });
    session.plannedPresentationCount = 21;
  }
  session.activeCardId = "card-2";
}

function detailOf(subject: DurableStudyProgressSnapshot): string | null {
  try {
    projectDurableVisibleStudyProgress(subject);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(DurableStudyProgressError);
    return (error as DurableStudyProgressError).detail;
  }
}

describe("durable visible study progress projection", () => {
  test("keeps a same-day requeue unique while presentation progress grows", () => {
    const subject = snapshot();
    rateFirstCard(subject, NOW + 10 * 60 * 1_000);

    expect(subject.sessions[0]).toMatchObject({
      completedPresentationCount: 1,
      plannedPresentationCount: 21,
    });
    expect(projectDurableVisibleStudyProgress(subject)).toEqual({
      completedTodayCount: 0,
      todayCardCount: 20,
      pendingTodayCount: 20,
      sessionKind: "active",
      activeCardId: "card-2",
    });
  });

  test("counts a card completed at the cutoff without changing the unique denominator", () => {
    const subject = snapshot();
    rateFirstCard(subject, NEXT_DAY);

    expect(projectDurableVisibleStudyProgress(subject)).toMatchObject({
      completedTodayCount: 1,
      todayCardCount: 20,
      pendingTodayCount: 19,
    });
  });

  test("is deterministic for repeated, waiting, completed, and later-sequence sessions", () => {
    const repeated = snapshot();
    rateFirstCard(repeated, NOW - 1);
    repeated.schedules.slice(1).forEach((schedule, index) => { schedule.dueAt = NOW + index + 1; });
    repeated.sessions[0]!.queueEntries
      .filter((entry) => entry.cardId !== "card-1")
      .forEach((entry, index) => { entry.dueAt = NOW + index + 1; });
    repeated.sessions[0]!.activeCardId = "card-1";
    expect(projectDurableVisibleStudyProgress(repeated)).toMatchObject({
      completedTodayCount: 0,
      todayCardCount: 20,
      sessionKind: "active",
      activeCardId: "card-1",
    });

    const waiting = snapshot();
    waiting.capturedAt = NOW - 2_000;
    waiting.sessions[0]!.updatedAt = waiting.capturedAt;
    waiting.schedules.forEach((schedule, index) => { schedule.dueAt = NOW + index + 1; });
    waiting.sessions[0]!.queueEntries.forEach((entry, index) => { entry.dueAt = NOW + index + 1; });
    waiting.sessions[0]!.activeCardId = null;
    expect(projectDurableVisibleStudyProgress(waiting).sessionKind).toBe("waiting");

    const completed = snapshot();
    completed.schedules.forEach((schedule) => {
      schedule.dueAt = NEXT_DAY;
      schedule.state = "review";
      schedule.lastReviewAt = NOW;
    });
    const completedSession = completed.sessions[0]!;
    completedSession.queueEntries = [];
    completedSession.activeCardId = null;
    completedSession.plannedPresentationCount = 20;
    completedSession.completedPresentationCount = 20;
    completedSession.ratingCounts.good = 20;
    completedSession.updatedAt = NOW;
    completedSession.completedAt = NOW;
    expect(projectDurableVisibleStudyProgress(completed)).toMatchObject({
      completedTodayCount: 20,
      todayCardCount: 20,
      pendingTodayCount: 0,
      sessionKind: "completed",
    });

    const later = snapshot();
    const first = later.sessions[0]!;
    first.queueEntries = [];
    first.activeCardId = null;
    first.plannedPresentationCount = 1;
    first.completedPresentationCount = 1;
    first.ratingCounts.good = 1;
    first.updatedAt = NOW - 10;
    first.completedAt = NOW - 10;
    later.schedules[0] = {
      ...later.schedules[0]!,
      dueAt: NEXT_DAY,
      state: "review",
      lastReviewAt: NOW - 10,
    };
    later.sessions.push({
      ...structuredClone(first),
      id: "session-2",
      sequence: 2,
      queueEntries: [{ cardId: "card-2", dueAt: DAY_START, ordinal: 1 }],
      activeCardId: "card-2",
      plannedPresentationCount: 1,
      completedPresentationCount: 0,
      ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
      startedAt: NOW - 5,
      updatedAt: NOW,
      completedAt: null,
    });
    later.sessionId = "session-2";
    expect(projectDurableVisibleStudyProgress(later)).toMatchObject({
      completedTodayCount: 1,
      todayCardCount: 2,
      sessionKind: "active",
      activeCardId: "card-2",
    });
  });

  test.each([
    ["missing card", (value: DurableStudyProgressSnapshot) => value.cards.shift(), "durable:schedule_card_relationship"],
    ["missing schedule", (value: DurableStudyProgressSnapshot) => value.schedules.shift(), "durable:missing_schedule"],
    ["duplicate schedule", (value: DurableStudyProgressSnapshot) => value.schedules.push(structuredClone(value.schedules[0]!)), "durable:duplicate_schedule_card_id"],
    ["duplicate queue card", (value: DurableStudyProgressSnapshot) => value.sessions[0]!.queueEntries[1]!.cardId = "card-1", "durable:duplicate_session_queue_card_id"],
    ["duplicate queue ordinal", (value: DurableStudyProgressSnapshot) => value.sessions[0]!.queueEntries[1]!.ordinal = 1, "durable:duplicate_session_queue_ordinal"],
    ["cross-deck queue", (value: DurableStudyProgressSnapshot) => {
      value.decks.push({ id: "deck-2" });
      value.cards[0]!.deckId = "deck-2";
      value.schedules[0]!.deckId = "deck-2";
    }, "durable:session_queue_deck_relationship"],
    ["stale identity", (value: DurableStudyProgressSnapshot) => value.sessionId = "missing", "durable:session_identity"],
    ["impossible progress", (value: DurableStudyProgressSnapshot) => value.sessions[0]!.plannedPresentationCount = 21, "durable:session_progress"],
    ["queue schedule disagreement", (value: DurableStudyProgressSnapshot) => value.schedules[0]!.dueAt += 1, "durable:session_queue_due_relationship"],
    ["bad day cutoff", (value: DurableStudyProgressSnapshot) => value.sessions[0]!.nextDayAt += 24 * 60 * 60 * 1_000, "durable:session_cutoff_relationship"],
  ])("rejects %s instead of guessing", (_name, mutate, detail) => {
    const subject = snapshot();
    mutate(subject);
    expect(detailOf(subject)).toBe(detail);
  });

  test("rejects stale sequence identity and contradictory active or delayed state", () => {
    const stale = snapshot();
    const old = stale.sessions[0]!;
    old.queueEntries = [];
    old.activeCardId = null;
    old.plannedPresentationCount = 0;
    old.updatedAt = NOW - 2;
    old.completedAt = NOW - 2;
    stale.sessions.push({
      ...structuredClone(old),
      id: "session-2",
      sequence: 2,
      queueEntries: [{ cardId: "card-1", dueAt: DAY_START, ordinal: 1 }],
      activeCardId: "card-1",
      plannedPresentationCount: 1,
      startedAt: NOW - 1,
      updatedAt: NOW,
      completedAt: null,
    });
    expect(detailOf(stale)).toBe("durable:stale_session_identity");

    const delayed = snapshot();
    delayed.sessions[0]!.activeCardId = null;
    expect(detailOf(delayed)).toBe("durable:session_active_card_relationship");

    const wrongActive = snapshot();
    wrongActive.sessions[0]!.activeCardId = "card-2";
    expect(detailOf(wrongActive)).toBe("durable:session_active_card_relationship");
  });
});
