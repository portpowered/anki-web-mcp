import { describe, expect, test } from "bun:test";

import {
  assessSuspensionJourney,
  type SuspensionJourneyEvidence,
} from "../../scripts/webmcp-suspension-journey";

const rootUrl = "https://portpowered.github.io/anki-web-mcp/";
const deckId = "seed-spanish-basics";
const cardId = "seed-card-1";
const nextCardId = "seed-card-2";
const firstCapture = Date.parse("2026-09-03T10:31:09.875Z");
const retryCapture = firstCapture + 76;

function ratingPreviews(capturedAt: number) {
  return Object.fromEntries(
    ["again", "hard", "good", "easy"].map((rating, index) => [rating, {
      interval: `${index + 1} minute${index === 0 ? "" : "s"}`,
      due_at: new Date(capturedAt + (index + 1) * 60_000).toISOString(),
    }]),
  );
}

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
const nextSchedule = {
  ...schedule,
  cardId: nextCardId,
  dueAt: 1_700_000_000_500,
};
const beforeSession = {
  id: "session-1",
  deckId,
  sequence: 1,
  queueEntries: [
    { cardId, dueAt: 1, ordinal: 0 },
    { cardId: nextCardId, dueAt: 3, ordinal: 2 },
  ],
  activeCardId: cardId,
  plannedPresentationCount: 20,
  completedPresentationCount: 0,
  currentSide: "front",
  completedAt: null,
  lastCommandIds: [],
};
const afterSession = {
  ...beforeSession,
  queueEntries: [{ cardId: nextCardId, dueAt: 3, ordinal: 2 }],
  activeCardId: nextCardId,
  plannedPresentationCount: 19,
  updatedAt: 1_700_000_000_100,
  lastCommandIds: ["evidence-suspend"],
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
      progressTotal: currentCardId === cardId ? 20 : 19,
    },
    durable: {
      deck: { id: deckId, name: "Spanish Basics" },
      session: structuredClone(session),
      card: { id: currentCardId, deckId },
      cards: [{ id: cardId, deckId }, { id: nextCardId, deckId }],
      schedule: structuredClone(currentSchedule),
      schedules: [structuredClone(schedule), structuredClone(nextSchedule)],
      commandEvidence: null as unknown,
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
  afterSuspend.durable.schedules = [{ ...schedule, suspended: true }, structuredClone(nextSchedule)];
  afterSuspend.durable.commandEvidence = {
    key: "study.suspend:evidence-suspend",
    value: { kind: "suspend", sessionId: beforeSession.id, cardId },
  };
  const suspensionResult = {
    ok: true,
    data: {
      command_id: "evidence-suspend",
      suspension: {
        suspended_card_id: cardId,
        removed_occurrence_count: 1,
        outcome: "active",
        next_card_id: nextCardId,
        idempotent: false,
      },
      state: {
        status: "active",
        captured_at: new Date(firstCapture).toISOString(),
        session: { id: "session-1", sequence: 1, planned_presentations: 19 },
        current_card: {
          id: nextCardId,
          side: "front",
          rating_previews: ratingPreviews(firstCapture),
        },
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
    suspendRetryToolNames: ["get_state", "flip", "set_state", "suspend", "go_home"],
    suspendRegistrationRotated: true,
    suspendRetryAcquisitionAttempts: 1,
    suspendCommandId: "evidence-suspend",
    collisionToolNames: ["get_state", "flip", "set_state", "suspend", "go_home"],
    crossToolCollisionToolNames: ["get_state", "flip", "set_state", "suspend", "go_home"],
    goHomeToolNames: ["get_state", "flip", "set_state", "suspend", "go_home"],
    homeToolNames: ["list_decks", "select_deck", "restore_suspended"],
    restoreRetryToolNames: ["list_decks", "select_deck", "restore_suspended"],
    finalStudyToolNames: ["get_state", "flip", "set_state", "suspend", "go_home"],
    before: studySnapshot(beforeSession, cardId, schedule),
    afterSuspend,
    afterSuspendRetry: structuredClone(afterSuspend),
    afterCollision: structuredClone(afterSuspend),
    afterCrossToolCollision: structuredClone(afterSuspend),
    homeAfterGo: homeSnapshot(true),
    homeAfterRestore: homeSnapshot(false),
    homeAfterRestoreRetry: homeSnapshot(false),
    suspendCall: call(suspensionResult),
    suspendRetryCall: call({
      ...suspensionResult,
      data: {
        ...suspensionResult.data,
        state: {
          ...suspensionResult.data.state,
          captured_at: new Date(retryCapture).toISOString(),
          current_card: {
            ...suspensionResult.data.state.current_card,
            rating_previews: ratingPreviews(retryCapture),
          },
        },
        suspension: {
          ...suspensionResult.data.suspension,
          removed_occurrence_count: 0,
          idempotent: true,
        },
      },
    }),
    collisionCall: call({ ok: false, error: { code: "DUPLICATE_COMMAND" } }),
    crossToolCollisionCall: call({ ok: false, error: { code: "DUPLICATE_COMMAND" } }),
    goHomeCall: call({ ok: true, data: { page: "decks", deck_count: 1 } }),
    restoreCall: call({
      ok: true,
      data: { deck_id: deckId, restored_count: 1, idempotent: false },
    }),
    restoreRetryCall: call({
      ok: true,
      data: { deck_id: deckId, restored_count: 1, idempotent: true },
    }),
    selectDeckCall: call({ ok: true, data: { deck_id: deckId } }),
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

  test("accepts the production 76 ms observation and rating-preview advance", () => {
    const subject = evidence();
    const first = JSON.parse(subject.suspendCall.result as string);
    const retry = JSON.parse(subject.suspendRetryCall.result as string);

    expect(Date.parse(retry.data.state.captured_at) - Date.parse(first.data.state.captured_at))
      .toBe(76);
    for (const rating of Object.keys(first.data.state.current_card.rating_previews)) {
      expect(
        Date.parse(retry.data.state.current_card.rating_previews[rating].due_at) -
          Date.parse(first.data.state.current_card.rating_previews[rating].due_at),
      ).toBe(76);
    }
    expect(assessSuspensionJourney(subject, rootUrl)).toEqual({
      status: "passed",
      failureCode: null,
    });
  });

  test("rejects invalid or backward suspension capture times", () => {
    const cases: Array<[string, "first" | "retry", unknown]> = [
      ["missing first", "first", undefined],
      ["missing retry", "retry", undefined],
      ["non-finite first", "first", Number.POSITIVE_INFINITY],
      ["non-finite retry", "retry", Number.POSITIVE_INFINITY],
      ["unparseable first", "first", "not-a-time"],
      ["unparseable retry", "retry", "not-a-time"],
      ["backward", "retry", new Date(firstCapture - 1).toISOString()],
    ];
    for (const [label, target, capturedAt] of cases) {
      const subject = evidence();
      const result = JSON.parse(
        (target === "first" ? subject.suspendCall.result : subject.suspendRetryCall.result) as string,
      );
      if (capturedAt === undefined) delete result.data.state.captured_at;
      else result.data.state.captured_at = capturedAt;
      if (target === "first") subject.suspendCall = call(result);
      else subject.suspendRetryCall = call(result);
      expect(assessSuspensionJourney(subject, rootUrl).failureCode, label).toBe(
        "suspend-idempotency-failed",
      );
    }
  });

  test("rejects preview projection, membership, interval, and material timestamp drift", () => {
    const cases: Array<[string, (subject: SuspensionJourneyEvidence) => void]> = [
      ["divergent preview advance", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.rating_previews.good.due_at =
          new Date(retryCapture + 3 * 60_000 + 1).toISOString();
        subject.suspendRetryCall = call(retry);
      }],
      ["missing preview", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        delete retry.data.state.current_card.rating_previews.easy;
        subject.suspendRetryCall = call(retry);
      }],
      ["extra preview", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.rating_previews.unknown = {
          interval: "5 minutes",
          due_at: new Date(retryCapture + 5 * 60_000).toISOString(),
        };
        subject.suspendRetryCall = call(retry);
      }],
      ["invalid preview due time", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.rating_previews.again.due_at = "not-a-time";
        subject.suspendRetryCall = call(retry);
      }],
      ["reordered previews", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.rating_previews = Object.fromEntries(
          Object.entries(retry.data.state.current_card.rating_previews).reverse(),
        );
        subject.suspendRetryCall = call(retry);
      }],
      ["changed interval", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.rating_previews.hard.interval = "99 days";
        subject.suspendRetryCall = call(retry);
      }],
      ["nested timestamp", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.session.updated_at = new Date(retryCapture).toISOString();
        subject.suspendRetryCall = call(retry);
      }],
      ["persisted due time", (subject) => {
        const durable = subject.afterSuspendRetry.durable as { schedule: { dueAt: number } };
        durable.schedule.dueAt += 76;
      }],
    ];

    for (const [label, mutate] of cases) {
      const subject = evidence();
      mutate(subject);
      expect(assessSuspensionJourney(subject, rootUrl).failureCode, label).toBe(
        "suspend-idempotency-failed",
      );
    }
  });

  test("keeps surrounding suspension state, route, inventory, and identity fields material", () => {
    const cases: Array<[
      string,
      (subject: SuspensionJourneyEvidence) => void,
      string,
    ]> = [
      ["one preview drift", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.rating_previews.easy.due_at =
          new Date(retryCapture + 4 * 60_000 + 76).toISOString();
        subject.suspendRetryCall = call(retry);
      }, "suspend-idempotency-failed"],
      ["nested tool-state timestamp", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.presentation = {
          revealed_at: new Date(retryCapture).toISOString(),
        };
        subject.suspendRetryCall = call(retry);
      }, "suspend-idempotency-failed"],
      ["persisted schedule field", (subject) => {
        const durable = subject.afterSuspendRetry.durable as {
          schedules: Array<{ cardId: string; scheduledDays: number }>;
        };
        durable.schedules.find((item) => item.cardId === nextCardId)!.scheduledDays += 1;
      }, "suspend-idempotency-failed"],
      ["persisted session timestamp", (subject) => {
        const durable = subject.afterSuspendRetry.durable as {
          session: { updatedAt: number };
        };
        durable.session.updatedAt += 76;
      }, "suspend-idempotency-failed"],
      ["visible route", (subject) => {
        (subject.afterSuspendRetry.visible as { route: string }).route = "decks";
      }, "suspend-idempotency-failed"],
      ["retry route inventory", (subject) => {
        subject.suspendRetryToolNames.push("restore_suspended");
      }, "suspend-retry-acquisition-failed"],
      ["command identity", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.command_id = "near-collision-command";
        subject.suspendRetryCall = call(retry);
      }, "suspend-idempotency-failed"],
      ["transition identity", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.suspension.next_card_id = "seed-card-3";
        subject.suspendRetryCall = call(retry);
      }, "suspend-idempotency-failed"],
    ];

    for (const [label, mutate, failureCode] of cases) {
      const subject = evidence();
      mutate(subject);
      expect(assessSuspensionJourney(subject, rootUrl).failureCode, label).toBe(failureCode);
    }
  });

  test("rejects a second suspend effect or a non-classified command collision", () => {
    const secondEffects: Array<[string, (subject: SuspensionJourneyEvidence) => void]> = [
      ["durable queue mutation", (subject) => {
        const durable = subject.afterSuspendRetry.durable as {
          session: { queueEntries: Array<{ dueAt: number }> };
        };
        durable.session.queueEntries[0].dueAt += 1;
      }],
      ["persisted card mutation", (subject) => {
        const durable = subject.afterSuspendRetry.durable as {
          card: { deckId: string };
        };
        durable.card.deckId = "different-deck";
      }],
      ["command evidence mutation", (subject) => {
        const durable = subject.afterSuspendRetry.durable as {
          commandEvidence: { value: { cardId: string } };
        };
        durable.commandEvidence.value.cardId = nextCardId;
      }],
      ["visible mutation with equal progress", (subject) => {
        const visible = subject.afterSuspendRetry.visible as {
          cardId: string;
          progressCurrent: number;
          progressTotal: number;
        };
        visible.cardId = "seed-card-3";
        expect(visible.progressCurrent).toBe(
          (subject.afterSuspend.visible as { progressCurrent: number }).progressCurrent,
        );
        expect(visible.progressTotal).toBe(
          (subject.afterSuspend.visible as { progressTotal: number }).progressTotal,
        );
      }],
      ["review log replacement with equal count", (subject) => {
        const before = subject.before.durable as { reviewLogs: unknown[] };
        const first = subject.afterSuspend.durable as { reviewLogs: unknown[] };
        const retry = subject.afterSuspendRetry.durable as { reviewLogs: unknown[] };
        before.reviewLogs.push({ id: "review-1", rating: "good" });
        first.reviewLogs.push({ id: "review-1", rating: "good" });
        retry.reviewLogs.push({ id: "review-2", rating: "good" });
      }],
    ];

    for (const [label, mutate] of secondEffects) {
      const subject = evidence();
      mutate(subject);
      expect(assessSuspensionJourney(subject, rootUrl).failureCode, label).toBe(
        "suspend-idempotency-failed",
      );
    }

    const collision = evidence();
    collision.collisionCall = call({ ok: false, error: { code: "STALE_CARD" } });
    expect(assessSuspensionJourney(collision, rootUrl).failureCode).toBe(
      "suspend-command-collision-failed",
    );
  });

  test("requires both collision paths to use exact current study inventories without mutation", () => {
    const cases: Array<[string, (subject: SuspensionJourneyEvidence) => void, string]> = [
      ["same-tool collision skipped", (subject) => {
        subject.collisionCall = { status: "not-run", result: null, error: null };
      }, "suspend-command-collision-failed"],
      ["same-tool inventory mixed", (subject) => {
        subject.collisionToolNames.push("list_decks");
      }, "cross-tool-command-collision-failed"],
      ["cross-tool collision wrong", (subject) => {
        subject.crossToolCollisionCall = call({ ok: true, data: {} });
      }, "cross-tool-command-collision-failed"],
      ["cross-tool inventory stale", (subject) => {
        subject.crossToolCollisionToolNames = ["list_decks", "select_deck", "restore_suspended"];
      }, "cross-tool-command-collision-failed"],
      ["cross-tool mutation", (subject) => {
        subject.afterCrossToolCollision = {
          ...subject.afterCrossToolCollision,
          durable: { changed: true },
        };
      }, "cross-tool-command-collision-failed"],
    ];
    for (const [label, mutate, failureCode] of cases) {
      const subject = evidence();
      mutate(subject);
      expect(assessSuspensionJourney(subject, rootUrl).failureCode, label).toBe(failureCode);
    }
  });

  test("rejects every non-idempotent retry result shape and identity drift", () => {
    const cases: Array<[string, (subject: SuspensionJourneyEvidence) => void]> = [
      ["native UnknownError", (subject) => {
        subject.suspendRetryCall = {
          status: "failed",
          result: null,
          error: "UnknownError: Tool is no longer registered",
        };
      }],
      ["skipped retry", (subject) => {
        subject.suspendRetryCall = { status: "not-run", result: null, error: null };
      }],
      ["unstructured retry", (subject) => {
        subject.suspendRetryCall = call("ok");
      }],
      ["non-idempotent retry", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.suspension.idempotent = false;
        subject.suspendRetryCall = call(result);
      }],
      ["second reported removal", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.suspension.removed_occurrence_count = 1;
        subject.suspendRetryCall = call(result);
      }],
      ["wrong command identity", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.command_id = "different-command";
        subject.suspendRetryCall = call(result);
      }],
      ["wrong suspension identity", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.suspension.suspended_card_id = nextCardId;
        subject.suspendRetryCall = call(result);
      }],
      ["wrong session identity", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.state.session.id = "different-session";
        subject.suspendRetryCall = call(result);
      }],
      ["wrong session sequence", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.state.session.sequence = 2;
        subject.suspendRetryCall = call(result);
      }],
      ["wrong transition outcome", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.suspension.outcome = "completed";
        subject.suspendRetryCall = call(result);
      }],
      ["wrong transition next card", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.suspension.next_card_id = "seed-card-3";
        subject.suspendRetryCall = call(result);
      }],
      ["wrong state status", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.state.status = "completed";
        subject.suspendRetryCall = call(result);
      }],
      ["wrong current card side", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.state.current_card.side = "back";
        subject.suspendRetryCall = call(result);
      }],
      ["wrong serialized state", (subject) => {
        const result = JSON.parse(subject.suspendRetryCall.result as string);
        result.data.state.session.planned_presentations = 18;
        subject.suspendRetryCall = call(result);
      }],
    ];

    for (const [label, mutate] of cases) {
      const subject = evidence();
      mutate(subject);
      expect(assessSuspensionJourney(subject, rootUrl).failureCode, label).toBe(
        "suspend-idempotency-failed",
      );
    }
  });

  test("derives the one allowed effect from pre-suspend evidence", () => {
    const cases: Array<[string, (subject: SuspensionJourneyEvidence) => void]> = [
      ["copied suspended pre-state", (subject) => {
        (subject.before.durable as { schedule: { suspended: boolean } }).schedule.suspended = true;
      }],
      ["second schedule mutation", (subject) => {
        const schedules = (subject.afterSuspend.durable as {
          schedules: Array<{ cardId: string; stability: number }>;
        }).schedules;
        schedules.find((item) => item.cardId === nextCardId)!.stability = 99;
      }],
      ["missing command evidence", (subject) => {
        (subject.afterSuspend.durable as { commandEvidence: unknown }).commandEvidence = null;
      }],
      ["second presentation advance", (subject) => {
        (subject.afterSuspend.durable as {
          session: { completedPresentationCount: number };
        }).session.completedPresentationCount = 1;
      }],
      ["wrong planned progress", (subject) => {
        (subject.afterSuspend.visible as { progressTotal: number }).progressTotal = 18;
      }],
      ["wrong current card", (subject) => {
        (subject.afterSuspend.durable as { session: { activeCardId: string } })
          .session.activeCardId = "seed-card-3";
      }],
    ];

    for (const [label, mutate] of cases) {
      const subject = evidence();
      mutate(subject);
      subject.afterSuspendRetry = structuredClone(subject.afterSuspend);
      subject.afterCollision = structuredClone(subject.afterSuspend);
      expect(assessSuspensionJourney(subject, rootUrl).failureCode, label).toBe(
        "suspend-transition-mismatch",
      );
    }
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

  test("requires a fresh exact study registration for the suspend retry", () => {
    const stable = evidence();
    stable.suspendRegistrationRotated = false;
    expect(assessSuspensionJourney(stable, rootUrl).failureCode).toBe(
      "suspend-retry-acquisition-failed",
    );

    const mixed = evidence();
    mixed.suspendRetryToolNames.push("list_decks");
    expect(assessSuspensionJourney(mixed, rootUrl).failureCode).toBe(
      "suspend-retry-acquisition-failed",
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

  test("requires current home restore registrations and an exact return-to-study inventory", () => {
    const mixedRestore = evidence();
    mixedRestore.restoreRetryToolNames.push("suspend");
    expect(assessSuspensionJourney(mixedRestore, rootUrl).failureCode).toBe(
      "restore-idempotency-failed",
    );

    const skippedReturn = evidence();
    skippedReturn.selectDeckCall = { status: "not-run", result: null, error: null };
    expect(assessSuspensionJourney(skippedReturn, rootUrl).failureCode).toBe(
      "restore-study-return-failed",
    );

    const mixedStudy = evidence();
    mixedStudy.finalStudyToolNames.push("restore_suspended");
    expect(assessSuspensionJourney(mixedStudy, rootUrl).failureCode).toBe(
      "restore-study-return-failed",
    );
  });
});
