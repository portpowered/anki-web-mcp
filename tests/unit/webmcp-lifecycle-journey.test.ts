import { describe, expect, test } from "bun:test";

import {
  assessLifecycleJourney,
  type LifecycleJourneyEvidence,
  type LifecycleSnapshot,
} from "../../scripts/webmcp-lifecycle-journey";
import {
  activeStudyToolNames,
  emptyStudyToolNames,
  homeToolNames,
} from "../../scripts/webmcp-production-contract";

const deckId = "seed-spanish-basics";
const firstCardId = "seed-card-1";
const replacementCardId = "seed-card-2";

function call(result: unknown): LifecycleJourneyEvidence["oldHomeCall"] {
  return { status: "passed", result: JSON.stringify(result), error: null };
}

function snapshot(
  route: "deck-home" | "study",
  toolNames: readonly string[],
  cardId: string | null,
  side: "front" | "back" | null,
  durable: unknown,
): LifecycleSnapshot {
  return {
    url: route === "deck-home" ? "https://example.test/" : `https://example.test/study/?deck=${deckId}`,
    route,
    toolNames: [...toolNames],
    cardId,
    side,
    durable,
  };
}

function evidence(): LifecycleJourneyEvidence {
  const firstStudy = snapshot("study", activeStudyToolNames, firstCardId, "front", { revision: 1 });
  const ratedStudy = snapshot("study", activeStudyToolNames, replacementCardId, "front", { revision: 2 });
  const root = snapshot("deck-home", homeToolNames, null, null, { revision: 2 });
  const secondStudy = snapshot("study", activeStudyToolNames, replacementCardId, "front", { revision: 2 });
  const missing = snapshot("study", emptyStudyToolNames, null, null, { revision: 2 });
  return {
    observations: [
      { step: "root-initial", snapshot: snapshot("deck-home", homeToolNames, null, null, { revision: 0 }) },
      { step: "study-first", snapshot: firstStudy },
      { step: "root-return", snapshot: root },
      { step: "study-second", snapshot: secondStudy },
      { step: "study-missing-card", snapshot: missing },
    ],
    deckId,
    firstCardId,
    replacementCardId,
    missingCardCall: call({ ok: true, data: { state: { status: "missing-deck" } } }),
    oldHomeCall: call({ ok: false, error: { code: "WRONG_PAGE" } }),
    oldStudyCall: call({ ok: false, error: { code: "WRONG_PAGE" } }),
    staleCardCall: call({ ok: false, error: { code: "STALE_CARD" } }),
    beforeOldHome: firstStudy,
    afterOldHome: firstStudy,
    beforeOldStudy: root,
    afterOldStudy: root,
    beforeStaleCard: ratedStudy,
    afterStaleCard: ratedStudy,
    cancellation: { marker: "pending", before: secondStudy, after: secondStudy },
    browserErrors: [],
  };
}

describe("production lifecycle journey classification", () => {
  test("accepts exact route/card cleanup and an uncommitted navigation cancellation", () => {
    expect(assessLifecycleJourney(evidence())).toEqual({ status: "passed", failureCode: null });
  });

  test("rejects mixed readiness, active obsolete handles, and stale mutations", () => {
    const mixed = evidence();
    mixed.observations[2]!.snapshot.toolNames.push("get_state");
    expect(assessLifecycleJourney(mixed).failureCode).toBe("lifecycle-root-return-mixed-route-inventory");

    const obsolete = evidence();
    obsolete.oldStudyCall = call({ ok: true, data: { state: {} } });
    expect(assessLifecycleJourney(obsolete).failureCode).toBe("lifecycle-old-study-handle-active");

    const stale = evidence();
    stale.afterStaleCard = { ...stale.afterStaleCard, durable: { revision: 3 } };
    expect(assessLifecycleJourney(stale).failureCode).toBe("lifecycle-stale-card-mutated");
  });

  test("accepts a native-level rejection only when the removed handle is explicitly classified", () => {
    const native = evidence();
    native.oldHomeCall = {
      status: "failed",
      result: null,
      error: "UnknownError: native proxy is no longer registered",
      classification: "NATIVE_HANDLE_UNREGISTERED",
    };
    expect(assessLifecycleJourney(native)).toEqual({ status: "passed", failureCode: null });

    const generic = evidence();
    generic.oldHomeCall = { status: "failed", result: null, error: "UnknownError: failed" };
    expect(assessLifecycleJourney(generic).failureCode).toBe("lifecycle-old-home-handle-active");
  });

  test("rejects a settled or late-committing cancelled mutation", () => {
    const settled = evidence();
    settled.cancellation.marker = "settled:{}";
    expect(assessLifecycleJourney(settled).failureCode).toBe("lifecycle-cancellation-late-commit");

    const committed = evidence();
    committed.cancellation.after = {
      ...committed.cancellation.after,
      side: "back",
      durable: { revision: 3 },
    };
    expect(assessLifecycleJourney(committed).failureCode).toBe("lifecycle-cancellation-late-commit");
  });
});
