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
const snapshot = (options: { logs?: number; completed?: number; suspended?: boolean; planned?: number } = {}) => ({
  visible: { cardId, side: "front", progressCurrent: options.completed ?? 0 },
  durable: {
    session: { completedPresentationCount: options.completed ?? 0, plannedPresentationCount: options.planned ?? 20 },
    schedule: { cardId, suspended: options.suspended ?? false, reps: options.logs ?? 0 },
    reviewLogs: Array.from({ length: options.logs ?? 0 }, (_, index) => ({ id: `log-${index}`, cardId })),
  },
});

function race(kind: AdversarialRace["kind"]): AdversarialRace {
  const before = snapshot({ suspended: kind === "restore" });
  const after = kind === "review"
    ? snapshot({ logs: 1, completed: 1 })
    : kind === "suspend"
      ? snapshot({ suspended: true, planned: 19 })
      : kind === "restore"
        ? snapshot({ suspended: false })
        : snapshot({ logs: 1, completed: 1 });
  return {
    kind,
    deckId,
    cardId,
    before,
    after,
    calls: kind === "conflict"
      ? [ok(), rejected("STALE_CARD")]
      : kind === "restore"
        ? [ok({ restored_count: 1, idempotent: false }), ok({ restored_count: 1, idempotent: true })]
        : [ok(), ok()],
    readCalls: kind === "conflict" ? [ok(), ok()] : [],
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
});
