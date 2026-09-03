import { describe, expect, test } from "bun:test";

import {
  assessSuspensionJourney,
  type SuspensionJourneyEvidence,
} from "../../scripts/webmcp-suspension-journey";

const rootUrl = "https://portpowered.github.io/anki-web-mcp/";
const deckId = "seed-spanish-basics";
const cardId = "seed-card-1";
const nextCardId = "seed-card-2";

function call(result: unknown): SuspensionJourneyEvidence["suspendCall"] {
  return { status: "passed", result: JSON.stringify(result), error: null };
}

const schedule = {
  cardId,
  deckId,
  dueAt: 1_700_000_000_000,
  stability: 2.5,
  difficulty: 4.2,
  elapsedDays: 3,
  scheduledDays: 5,
  reps: 2,
  lapses: 0,
  state: "review",
  lastReviewAt: 1_699_000_000_000,
  suspended: false,
};
const beforeSession = {
  id: "session-1",
  deckId,
  sequence: 1,
  queueEntries: [
    { cardId, dueAt: 1, ordinal: 0 },
    { cardId, dueAt: 2, ordinal: 1 },
    { cardId: nextCardId, dueAt: 3, ordinal: 2 },
  ],
  activeCardId: cardId,
  plannedPresentationCount: 3,
  completedPresentationCount: 0,
  currentSide: "front",
  completedAt: null,
  lastCommandIds: [],
};
const afterSession = {
  ...beforeSession,
  queueEntries: [{ cardId: nextCardId, dueAt: 3, ordinal: 2 }],
  activeCardId: nextCardId,
  plannedPresentationCount: 1,
  updatedAt: 1_700_000_000_100,
  lastCommandIds: ["suspend-command"],
};

function studySnapshot(session: object, currentCardId: string, currentSchedule: object) {
  return {
    visible: {
      route: "study",
      state: "active",
      cardId: currentCardId,
      side: "front",
      sideDetail: null,
      progressCurrent: 0,
      progressTotal: currentCardId === cardId ? 3 : 1,
    },
    durable: {
      session: structuredClone(session),
      card: { id: currentCardId, deckId },
      schedule: structuredClone(currentSchedule),
      schedules: [],
      reviewLogs: [],
    },
  };
}

function homeSnapshot(suspended: boolean) {
  return {
    visible: { deckId, recoveryAvailable: suspended, dueCount: suspended ? 2 : 3 },
    session: structuredClone(afterSession),
    schedule: { ...schedule, suspended },
    reviewLogs: [],
  };
}

function evidence(): SuspensionJourneyEvidence {
  const afterSuspend = studySnapshot(
    afterSession,
    nextCardId,
    { ...schedule, cardId: nextCardId, suspended: false },
  );
  // The probe retains the originally suspended card schedule in durable.schedule.
  afterSuspend.durable.schedule = { ...schedule, suspended: true };
  const suspensionResult = {
    ok: true,
    data: {
      suspension: {
        suspended_card_id: cardId,
        removed_occurrence_count: 2,
        outcome: "active",
        next_card_id: nextCardId,
        idempotent: false,
      },
      state: {
        status: "active",
        session: { id: "session-1", sequence: 1, planned_presentations: 1 },
        current_card: { id: nextCardId, side: "front" },
      },
    },
  };
  return {
    deckId,
    cardId,
    studyUrl: `${rootUrl}study/?deck=${deckId}`,
    homeUrl: rootUrl,
    deploymentRoute: "deck-home",
    studyToolNames: ["get_state", "flip", "set_state", "suspend", "go_home"],
    homeToolNames: ["list_decks", "select_deck", "restore_suspended"],
    before: studySnapshot(beforeSession, cardId, schedule),
    afterSuspend,
    afterSuspendRetry: structuredClone(afterSuspend),
    afterCollision: structuredClone(afterSuspend),
    homeAfterGo: homeSnapshot(true),
    homeAfterRestore: homeSnapshot(false),
    homeAfterRestoreRetry: homeSnapshot(false),
    suspendCall: call(suspensionResult),
    suspendRetryCall: call({
      ...suspensionResult,
      data: {
        ...suspensionResult.data,
        suspension: { ...suspensionResult.data.suspension, idempotent: true },
      },
    }),
    collisionCall: call({ ok: false, error: { code: "DUPLICATE_COMMAND" } }),
    goHomeCall: call({ ok: true, data: { page: "decks", deck_count: 1 } }),
    restoreCall: call({
      ok: true,
      data: { deck_id: deckId, restored_count: 1, idempotent: false },
    }),
    restoreRetryCall: call({
      ok: true,
      data: { deck_id: deckId, restored_count: 1, idempotent: true },
    }),
    browserErrors: [],
  };
}

describe("production suspension journey classification", () => {
  test("accepts an isolated durable suspend, home navigation, and restore flow", () => {
    expect(assessSuspensionJourney(evidence(), rootUrl)).toEqual({
      status: "passed",
      failureCode: null,
    });
  });

  test("rejects a second suspend effect or a non-classified command collision", () => {
    const duplicate = evidence();
    duplicate.afterSuspendRetry = {
      ...duplicate.afterSuspendRetry,
      durable: { changedTwice: true },
    };
    expect(assessSuspensionJourney(duplicate, rootUrl).failureCode).toBe(
      "suspend-idempotency-failed",
    );

    const collision = evidence();
    collision.collisionCall = call({ ok: false, error: { code: "STALE_CARD" } });
    expect(assessSuspensionJourney(collision, rootUrl).failureCode).toBe(
      "suspend-command-collision-failed",
    );
  });

  test("rejects scheduling-memory drift and duplicate restoration effects", () => {
    const memoryDrift = evidence();
    (memoryDrift.homeAfterRestore as { schedule: { stability: number } }).schedule.stability = 99;
    expect(assessSuspensionJourney(memoryDrift, rootUrl).failureCode).toBe(
      "restore-transition-mismatch",
    );

    const duplicateRestore = evidence();
    duplicateRestore.homeAfterRestoreRetry = homeSnapshot(true);
    expect(assessSuspensionJourney(duplicateRestore, rootUrl).failureCode).toBe(
      "restore-idempotency-failed",
    );
  });

  test("requires a distinct authoritative front-side card after suspension", () => {
    const back = evidence();
    (back.afterSuspend.visible as { side: string }).side = "back";
    (back.afterSuspend.durable as { session: { currentSide: string } }).session.currentSide = "back";
    const backResult = JSON.parse(back.suspendCall.result as string);
    backResult.data.state.current_card.side = "back";
    back.suspendCall = call(backResult);
    expect(assessSuspensionJourney(back, rootUrl).failureCode).toBe(
      "suspend-transition-mismatch",
    );

    const missing = evidence();
    (missing.afterSuspend.visible as { side: string | null; sideDetail: string | null }).side = null;
    (missing.afterSuspend.visible as { sideDetail: string | null }).sideDetail =
      "study-side-invalid:missing";
    expect(assessSuspensionJourney(missing, rootUrl).failureCode).toBe(
      "suspend-transition-mismatch",
    );

    const malformed = evidence();
    (malformed.afterSuspend.visible as { sideDetail: string | null }).sideDetail =
      "study-side-invalid:malformed:sideways";
    expect(assessSuspensionJourney(malformed, rootUrl).failureCode).toBe(
      "suspend-transition-mismatch",
    );

    const mismatchedIdentity = evidence();
    (mismatchedIdentity.afterSuspend.visible as { cardId: string }).cardId = "seed-card-3";
    expect(assessSuspensionJourney(mismatchedIdentity, rootUrl).failureCode).toBe(
      "suspend-transition-mismatch",
    );
  });

  test("rejects stale study tools and stale study registration at home", () => {
    const studyMixed = evidence();
    studyMixed.studyToolNames.push("list_decks");
    expect(assessSuspensionJourney(studyMixed, rootUrl).failureCode).toBe(
      "suspension-study-mixed-route-inventory",
    );

    const homeMixed = evidence();
    homeMixed.homeToolNames.push("suspend");
    expect(assessSuspensionJourney(homeMixed, rootUrl).failureCode).toBe(
      "go-home-suspension-parity-mismatch",
    );
  });

  test("requires the production recovery affordance before restore and its omission afterward", () => {
    const missingBeforeRestore = evidence();
    (missingBeforeRestore.homeAfterGo as {
      visible: { recoveryAvailable: boolean };
    }).visible.recoveryAvailable = false;
    expect(assessSuspensionJourney(missingBeforeRestore, rootUrl).failureCode).toBe(
      "go-home-suspension-parity-mismatch",
    );

    const staleAfterRestore = evidence();
    (staleAfterRestore.homeAfterRestore as {
      visible: { recoveryAvailable: boolean };
    }).visible.recoveryAvailable = true;
    expect(assessSuspensionJourney(staleAfterRestore, rootUrl).failureCode).toBe(
      "restore-transition-mismatch",
    );
  });
});
