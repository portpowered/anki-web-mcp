import { describe, expect, test } from "bun:test";

import {
  assessSuspensionJourney,
  type SuspensionPreviewBoundaryEvidence,
  type SuspensionJourneyEvidence,
} from "../../scripts/webmcp-suspension-journey";
import { createProductionSchedulerAdapter } from "../../lib/domain/scheduler";
import type { ScheduleRecord } from "../../lib/domain/entities";

const rootUrl = "https://portpowered.github.io/anki-web-mcp/";
const deckId = "seed-spanish-basics";
const cardId = "seed-card-1";
const nextCardId = "seed-card-2";
const firstCapture = Date.parse("2026-09-03T13:21:12.465Z");
const retryCapture = Date.parse("2026-09-03T13:21:12.525Z");
const canonicalScheduler = createProductionSchedulerAdapter();

function ratingPreviews() {
  return {
    again: { interval: "1 minute", due_at: "2026-09-03T13:22:12.465Z" },
    hard: { interval: "6 minutes", due_at: "2026-09-03T13:27:12.465Z" },
    good: { interval: "10 minutes", due_at: "2026-09-03T13:31:12.465Z" },
    easy: { interval: "9 days", due_at: "2026-09-12T13:21:12.465Z" },
  };
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
        deck: { id: deckId, name: "Spanish Basics" },
        session: { id: "session-1", sequence: 1, planned_presentations: 19 },
        current_card: {
          id: nextCardId,
          side: "front",
          rating_previews: ratingPreviews(),
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
            rating_previews: ratingPreviews(),
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

function boundaryEvidence(
  subject: SuspensionJourneyEvidence,
  elapsedMs: number,
  changed = false,
): SuspensionJourneyEvidence {
  const retry = JSON.parse(subject.suspendRetryCall.result as string);
  const retryAt = firstCapture + elapsedMs;
  retry.data.state.captured_at = new Date(retryAt).toISOString();
  const calculation = canonicalScheduler.calculate(
    nextSchedule as ScheduleRecord,
    new Date(retryAt),
  );
  const controlledSchedulerOutcomes = changed
    ? Object.fromEntries((["again", "hard", "good", "easy"] as const).map((rating) => [
      rating,
      {
        interval: calculation[rating].preview.intervalLabel,
        due_at: new Date(calculation[rating].schedule.dueAt).toISOString(),
      },
    ]))
    : ratingPreviews();
  retry.data.state.current_card.rating_previews = structuredClone(controlledSchedulerOutcomes);
  subject.suspendRetryCall = call(retry);

  const identity = {
    deckId,
    sessionId: afterSession.id,
    sessionSequence: afterSession.sequence,
    cardId: nextCardId,
    schedule: structuredClone(nextSchedule),
  };
  const explicitClockAt = new Date(retryAt).toISOString();
  subject.previewBoundaryEvidence = {
    preRetry: {
      capturedAt: new Date(firstCapture).toISOString(),
      presentationIdentity: structuredClone(identity),
    },
    explicitClockAt,
    invalidation: {
      reason: "meaningful-time",
      thresholdMs: 60_000,
      previousCalculationAt: new Date(firstCapture).toISOString(),
      recalculatedAt: explicitClockAt,
      generationBefore: 4,
      generationAfter: 5,
      presentationIdentity: structuredClone(identity),
    },
    schedulerCalculation: {
      invocationCount: 1,
      calculatedAt: explicitClockAt,
      presentationIdentity: structuredClone(identity),
      inputSchedule: structuredClone(nextSchedule),
      outcomes: structuredClone(controlledSchedulerOutcomes),
    },
  } satisfies SuspensionPreviewBoundaryEvidence;
  return subject;
}

describe("production suspension journey classification", () => {
  test("accepts an isolated durable suspend, home navigation, and restore flow", () => {
    expect(assessSuspensionJourney(evidence(), rootUrl)).toEqual({
      status: "passed",
      failureCode: null,
      failureDetail: null,
    });
  });

  test("accepts the production 60 ms observation with an exactly retained preview", () => {
    const subject = evidence();
    const first = JSON.parse(subject.suspendCall.result as string);
    const retry = JSON.parse(subject.suspendRetryCall.result as string);

    expect(Date.parse(retry.data.state.captured_at) - Date.parse(first.data.state.captured_at))
      .toBe(60);
    expect(first.data.state.current_card.rating_previews.good.due_at)
      .toBe("2026-09-03T13:31:12.465Z");
    expect(first.data.state.current_card.rating_previews.easy.due_at)
      .toBe("2026-09-12T13:21:12.465Z");
    for (const rating of Object.keys(first.data.state.current_card.rating_previews)) {
      expect(retry.data.state.current_card.rating_previews[rating])
        .toEqual(first.data.state.current_card.rating_previews[rating]);
    }
    expect(assessSuspensionJourney(subject, rootUrl)).toEqual({
      status: "passed",
      failureCode: null,
      failureDetail: null,
    });
  });

  test("would fail the production fixture under the obsolete capture-delta rule", () => {
    const subject = evidence();
    const first = JSON.parse(subject.suspendCall.result as string).data.state;
    const retry = JSON.parse(subject.suspendRetryCall.result as string).data.state;
    const captureAdvance = Date.parse(retry.captured_at) - Date.parse(first.captured_at);
    const obsoleteCaptureDeltaRulePasses = Object.keys(first.current_card.rating_previews)
      .every((rating) =>
        Date.parse(retry.current_card.rating_previews[rating].due_at) -
          Date.parse(first.current_card.rating_previews[rating].due_at) === captureAdvance
      );

    expect(captureAdvance).toBe(60);
    expect(obsoleteCaptureDeltaRulePasses).toBe(false);
    expect(assessSuspensionJourney(subject, rootUrl).status).toBe("passed");
  });

  test("enforces retained previews at 59,999 ms and accepts retention at the boundary", () => {
    expect(assessSuspensionJourney(boundaryEvidence(evidence(), 59_999), rootUrl).status)
      .toBe("passed");
    expect(assessSuspensionJourney(boundaryEvidence(evidence(), 60_000), rootUrl).status)
      .toBe("passed");
    expect(assessSuspensionJourney(boundaryEvidence(evidence(), 60_001), rootUrl).status)
      .toBe("passed");

    const drift = boundaryEvidence(evidence(), 59_999, true);
    const assessment = assessSuspensionJourney(drift, rootUrl);
    expect(assessment).toMatchObject({
      failureCode: "suspend-idempotency-failed",
      failureDetail: "preview:retained-drift:again",
    });
  });

  test("accepts one independently evidenced recalculation at and beyond 60,000 ms", () => {
    for (const elapsedMs of [60_000, 60_001]) {
      const subject = boundaryEvidence(evidence(), elapsedMs, true);
      expect(assessSuspensionJourney(subject, rootUrl), String(elapsedMs)).toEqual({
        status: "passed",
        failureCode: null,
        failureDetail: null,
      });
    }
  });

  test("rejects incomplete, stale, cross-identity, and mirrored boundary evidence", () => {
    const cases: Array<[
      string,
      (subject: SuspensionJourneyEvidence) => void,
      RegExp,
    ]> = [
      ["missing evidence", (subject) => {
        subject.previewBoundaryEvidence = null;
      }, /^preview:boundary-provenance:missing$/],
      ["wrong explicit clock", (subject) => {
        subject.previewBoundaryEvidence!.explicitClockAt = new Date(firstCapture + 60_001).toISOString();
      }, /^preview:boundary-provenance:clock$/],
      ["incomplete invalidation", (subject) => {
        subject.previewBoundaryEvidence!.invalidation.generationAfter = 7;
      }, /^preview:boundary-provenance:invalidation$/],
      ["stale schedule", (subject) => {
        (subject.previewBoundaryEvidence!.schedulerCalculation.inputSchedule as { reps: number }).reps--;
      }, /^preview:boundary-provenance:scheduler-input$/],
      ["cross-card scheduler", (subject) => {
        (subject.previewBoundaryEvidence!.schedulerCalculation.presentationIdentity as { cardId: string })
          .cardId = cardId;
      }, /^preview:identity:boundary-mismatch$/],
      ["cross-session invalidation", (subject) => {
        (subject.previewBoundaryEvidence!.invalidation.presentationIdentity as { sessionId: string })
          .sessionId = "other-session";
      }, /^preview:identity:boundary-mismatch$/],
      ["cross-deck pre-retry", (subject) => {
        (subject.previewBoundaryEvidence!.preRetry.presentationIdentity as { deckId: string })
          .deckId = "other-deck";
      }, /^preview:identity:boundary-mismatch$/],
      ["multiple scheduler calls", (subject) => {
        subject.previewBoundaryEvidence!.schedulerCalculation.invocationCount = 2;
      }, /^preview:boundary-provenance:scheduler-input$/],
      ["incomplete scheduler result", (subject) => {
        delete (subject.previewBoundaryEvidence!.schedulerCalculation.outcomes as Record<string, unknown>).easy;
      }, /^preview:boundary-scheduler:shape$/],
      ["mirrored retry while every provenance claim remains valid", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.rating_previews.good.interval = "mirrored runtime value";
        subject.previewBoundaryEvidence!.schedulerCalculation.outcomes =
          structuredClone(retry.data.state.current_card.rating_previews);
        subject.suspendRetryCall = call(retry);
      }, /^preview:boundary-provenance:scheduler-result$/],
      ["forged common shift", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        for (const preview of Object.values(retry.data.state.current_card.rating_previews) as Array<{ due_at: string }>) {
          preview.due_at = new Date(Date.parse(preview.due_at) + 5_000).toISOString();
        }
        subject.suspendRetryCall = call(retry);
      }, /^preview:boundary-provenance:scheduler-result$/],
    ];

    for (const [label, mutate, detail] of cases) {
      const subject = boundaryEvidence(evidence(), 60_000, true);
      mutate(subject);
      const assessment = assessSuspensionJourney(subject, rootUrl);
      expect(assessment.failureCode, label).toBe("suspend-idempotency-failed");
      expect(assessment.failureDetail, label).toMatch(detail);
    }
  });

  test("rejects recalculation before threshold and invalid scheduler due times", () => {
    const premature = boundaryEvidence(evidence(), 59_999, true);
    expect(assessSuspensionJourney(premature, rootUrl).failureDetail)
      .toBe("preview:retained-drift:again");

    const invalidDue = boundaryEvidence(evidence(), 60_001, true);
    const outcomes = invalidDue.previewBoundaryEvidence!.schedulerCalculation.outcomes as Record<
      string,
      { due_at: string }
    >;
    outcomes.again.due_at = new Date(firstCapture + 60_000).toISOString();
    const retry = JSON.parse(invalidDue.suspendRetryCall.result as string);
    retry.data.state.current_card.rating_previews.again.due_at = outcomes.again.due_at;
    invalidDue.suspendRetryCall = call(retry);
    expect(assessSuspensionJourney(invalidDue, rootUrl).failureDetail)
      .toBe("preview:value:again:retry-due-invalid");
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
      const assessment = assessSuspensionJourney(subject, rootUrl);
      expect(assessment.failureCode, label).toBe(
        "suspend-idempotency-failed",
      );
      expect(assessment.failureDetail, label).toMatch(/^preview:capture:/);
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

  test("rejects one or all retained preview changes and forged common shifts", () => {
    const cases: Array<[string, (previews: Record<string, {
      interval: string;
      due_at: string;
    }>) => void]> = [
      ["one interval", (previews) => {
        previews.hard.interval = "7 minutes";
      }],
      ["all intervals", (previews) => {
        for (const preview of Object.values(previews)) preview.interval += " changed";
      }],
      ["one due", (previews) => {
        previews.good.due_at = new Date(Date.parse(previews.good.due_at) + 1).toISOString();
      }],
      ["all due by capture delta", (previews) => {
        for (const preview of Object.values(previews)) {
          preview.due_at = new Date(Date.parse(preview.due_at) + 60).toISOString();
        }
      }],
      ["forged common shift", (previews) => {
        for (const preview of Object.values(previews)) {
          preview.due_at = new Date(Date.parse(preview.due_at) + 10_000).toISOString();
        }
      }],
      ["combined drift", (previews) => {
        for (const preview of Object.values(previews)) {
          preview.interval += " changed";
          preview.due_at = new Date(Date.parse(preview.due_at) + 60).toISOString();
        }
      }],
    ];

    for (const [label, mutate] of cases) {
      const subject = evidence();
      const retry = JSON.parse(subject.suspendRetryCall.result as string);
      mutate(retry.data.state.current_card.rating_previews);
      subject.suspendRetryCall = call(retry);
      const assessment = assessSuspensionJourney(subject, rootUrl);
      expect(assessment.failureCode, label).toBe("suspend-idempotency-failed");
      expect(assessment.failureDetail, label).toMatch(/^preview:retained-drift:/);
    }
  });

  test("rejects duplicate-shaped ratings, backward due times, and presentation identity drift", () => {
    const cases: Array<[string, (subject: SuspensionJourneyEvidence) => void, RegExp]> = [
      ["duplicate-shaped ratings", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.rating_previews = [
          ["again", retry.data.state.current_card.rating_previews.again],
          ["again", retry.data.state.current_card.rating_previews.again],
          ["hard", retry.data.state.current_card.rating_previews.hard],
          ["good", retry.data.state.current_card.rating_previews.good],
          ["easy", retry.data.state.current_card.rating_previews.easy],
        ];
        subject.suspendRetryCall = call(retry);
      }, /^preview:shape:/],
      ["first due before capture", (subject) => {
        const first = JSON.parse(subject.suspendCall.result as string);
        first.data.state.current_card.rating_previews.again.due_at =
          new Date(firstCapture - 1).toISOString();
        subject.suspendCall = call(first);
      }, /^preview:value:again:first-due-invalid$/],
      ["retry due before capture", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.current_card.rating_previews.again.due_at =
          new Date(retryCapture - 1).toISOString();
        subject.suspendRetryCall = call(retry);
      }, /^preview:value:again:retry-due-invalid$/],
      ["cross-deck state", (subject) => {
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        retry.data.state.deck.id = "other-deck";
        subject.suspendRetryCall = call(retry);
      }, /^preview:identity:/],
      ["stale schedule revision", (subject) => {
        const durable = subject.afterSuspendRetry.durable as {
          schedules: Array<{ cardId: string; reps: number }>;
        };
        durable.schedules.find((item) => item.cardId === nextCardId)!.reps -= 1;
      }, /^preview:identity:/],
    ];

    for (const [label, mutate, detail] of cases) {
      const subject = evidence();
      mutate(subject);
      const assessment = assessSuspensionJourney(subject, rootUrl);
      expect(assessment.failureCode, label).toBe("suspend-idempotency-failed");
      expect(assessment.failureDetail, label).toMatch(detail);
    }
  });

  test("rejects matching malformed rating-preview identities in both captures", () => {
    const cases: Array<[string, (previews: Record<string, unknown>) => void]> = [
      ["same required preview missing", (previews) => {
        delete previews.easy;
      }],
      ["same unknown preview added", (previews) => {
        previews.unknown = {
          interval: "5 minutes",
          due_at: new Date(firstCapture + 5 * 60_000).toISOString(),
        };
      }],
    ];

    for (const [label, mutate] of cases) {
      const subject = evidence();
      const first = JSON.parse(subject.suspendCall.result as string);
      const retry = JSON.parse(subject.suspendRetryCall.result as string);
      mutate(first.data.state.current_card.rating_previews);
      mutate(retry.data.state.current_card.rating_previews);
      if (retry.data.state.current_card.rating_previews.unknown) {
        retry.data.state.current_card.rating_previews.unknown.due_at =
          new Date(retryCapture + 5 * 60_000).toISOString();
      }
      subject.suspendCall = call(first);
      subject.suspendRetryCall = call(retry);

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

  test("derives every post-first material family instead of trusting matching retry evidence", () => {
    const cases: Array<[string, (subject: SuspensionJourneyEvidence) => void]> = [
      ["visible route copied into retry", (subject) => {
        (subject.afterSuspend.visible as { route: string }).route = "decks";
      }],
      ["current card record copied into retry", (subject) => {
        (subject.afterSuspend.durable as { card: Record<string, unknown> }).card.marker =
          "not-from-pre-suspend-cards";
      }],
      ["review log replacement with an unchanged count", (subject) => {
        (subject.before.durable as { reviewLogs: unknown[] }).reviewLogs.push({ id: "review-1" });
        (subject.afterSuspend.durable as { reviewLogs: unknown[] }).reviewLogs.push({
          id: "review-2",
        });
      }],
      ["first transition outcome copied into retry", (subject) => {
        const first = JSON.parse(subject.suspendCall.result as string);
        const retry = JSON.parse(subject.suspendRetryCall.result as string);
        first.data.suspension.outcome = "completed";
        retry.data.suspension.outcome = "completed";
        subject.suspendCall = call(first);
        subject.suspendRetryCall = call(retry);
      }],
    ];

    for (const [label, mutate] of cases) {
      const subject = evidence();
      mutate(subject);
      subject.afterSuspendRetry = structuredClone(subject.afterSuspend);
      subject.afterCollision = structuredClone(subject.afterSuspend);
      subject.afterCrossToolCollision = structuredClone(subject.afterSuspend);
      expect(assessSuspensionJourney(subject, rootUrl), label).toMatchObject({
        status: "failed",
        failureCode: "suspend-transition-mismatch",
        failureDetail: "transition:first-effect",
      });
    }
  });

  test("requires exact retry transition serialization beyond effect accounting", () => {
    const subject = evidence();
    const retry = JSON.parse(subject.suspendRetryCall.result as string);
    retry.data.suspension.lifecycle_generation = 2;
    subject.suspendRetryCall = call(retry);

    expect(assessSuspensionJourney(subject, rootUrl)).toMatchObject({
      status: "failed",
      failureCode: "suspend-idempotency-failed",
      failureDetail: "retry:identity-or-material-state",
    });
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
