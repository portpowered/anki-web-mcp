import {
  activeStudyToolNames,
  assessProductionInventory,
  homeToolContracts,
  homeToolNames,
} from "./webmcp-production-contract";

export type HomeJourneyCall = {
  status: "passed" | "failed" | "not-run";
  result: unknown;
  error: string | null;
};

export type HomeJourneyEvidence = {
  initialUrl: string;
  finalUrl: string | null;
  deploymentRoute: string | null;
  homeTools: Array<{
    name: string | null;
    inputSchema: unknown;
    annotations: unknown;
  }>;
  studyToolNames: string[];
  stateBefore: unknown;
  stateAfterList: unknown;
  stateAfterMalformed: unknown;
  stateAfterExtra: unknown;
  durableBefore: unknown;
  durableAfterList: unknown;
  durableAfterMalformed: unknown;
  durableAfterExtra: unknown;
  durableAfterSelect: unknown;
  visibleDecks: unknown;
  listCall: HomeJourneyCall;
  repeatedListCall: HomeJourneyCall;
  malformedListCall: HomeJourneyCall;
  extraListCall: HomeJourneyCall;
  selectCall: HomeJourneyCall;
  selectedDeckId: string | null;
  visibleStudy: unknown;
  browserErrors: string[];
};

export type HomeJourneyAssessment = {
  status: "passed" | "failed";
  failureCode: string | null;
};

function decoded(call: HomeJourneyCall): Record<string, unknown> | null {
  if (call.status !== "passed") return null;
  const value = typeof call.result === "string"
    ? (() => {
        try {
          return JSON.parse(call.result);
        } catch {
          return null;
        }
      })()
    : call.result;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decodedSchema(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function invalidInput(call: HomeJourneyCall): boolean {
  const result = decoded(call);
  const error = result?.error !== null && typeof result?.error === "object"
    ? result.error as Record<string, unknown>
    : null;
  return (result?.ok === false && error?.code === "INVALID_INPUT") ||
    (call.status === "failed" && /parse input|invalid|schema|argument/i.test(call.error ?? ""));
}

function toolContractsMatch(evidence: HomeJourneyEvidence): boolean {
  return homeToolContracts.every((expected) => {
    const observed = evidence.homeTools.find((tool) => tool.name === expected.name);
    return observed !== undefined &&
      equal(decodedSchema(observed.inputSchema), expected.inputSchema) &&
      equal(observed.annotations, expected.annotations);
  });
}

/** Classify only observable runtime evidence; never infer success from source. */
export function assessHomeJourney(
  evidence: HomeJourneyEvidence,
  expectedRootUrl: string,
  expectedStudyBaseUrl: string,
): HomeJourneyAssessment {
  const homeInventory = assessProductionInventory(
    evidence.homeTools.map((tool) => tool.name ?? ""),
    homeToolNames,
  );
  if (homeInventory.failureCode) {
    return { status: "failed", failureCode: `home-${homeInventory.failureCode}` };
  }
  if (!toolContractsMatch(evidence)) {
    return { status: "failed", failureCode: "home-tool-contract-mismatch" };
  }
  if (evidence.initialUrl !== expectedRootUrl) {
    return { status: "failed", failureCode: "home-route-mismatch" };
  }
  if (!equal(evidence.stateBefore, evidence.stateAfterList) ||
      !equal(evidence.durableBefore, evidence.durableAfterList) ||
      !equal(evidence.listCall.result, evidence.repeatedListCall.result)) {
    return { status: "failed", failureCode: "list-decks-mutated-state" };
  }
  const listed = decoded(evidence.listCall);
  const listedData = listed?.data !== null && typeof listed?.data === "object"
    ? listed.data as Record<string, unknown>
    : null;
  if (listed?.ok !== true || listedData?.page !== "decks" ||
      !Array.isArray(listedData.decks) || listedData.decks.length === 0 ||
      evidence.selectedDeckId !== (listedData.decks[0] as Record<string, unknown>)?.id) {
    return { status: "failed", failureCode: "persisted-seed-unavailable" };
  }
  if (!equal(listedData.decks, evidence.visibleDecks) ||
      !equal(listedData.decks, evidence.durableBefore)) {
    return { status: "failed", failureCode: "deck-state-parity-mismatch" };
  }
  if (!invalidInput(evidence.malformedListCall) || !invalidInput(evidence.extraListCall) ||
      !equal(evidence.stateAfterList, evidence.stateAfterMalformed) ||
      !equal(evidence.stateAfterList, evidence.stateAfterExtra) ||
      !equal(evidence.durableAfterList, evidence.durableAfterMalformed) ||
      !equal(evidence.durableAfterList, evidence.durableAfterExtra)) {
    return { status: "failed", failureCode: "invalid-list-input-mutated-state" };
  }
  const selected = decoded(evidence.selectCall);
  const selectedData = selected?.data !== null && typeof selected?.data === "object"
    ? selected.data as Record<string, unknown>
    : null;
  if (selected?.ok !== true || selectedData?.page !== "study" ||
      selectedData.deck_id !== evidence.selectedDeckId ||
      selectedData.session === null || evidence.durableAfterSelect === null) {
    return { status: "failed", failureCode: "select-deck-failed" };
  }
  const expectedStudyUrl = `${expectedStudyBaseUrl}?deck=${encodeURIComponent(evidence.selectedDeckId ?? "")}`;
  if (evidence.finalUrl !== expectedStudyUrl || evidence.deploymentRoute !== "study") {
    return { status: "failed", failureCode: "study-navigation-mismatch" };
  }
  const studyInventory = assessProductionInventory(
    evidence.studyToolNames,
    activeStudyToolNames,
  );
  if (studyInventory.failureCode) {
    return { status: "failed", failureCode: `study-${studyInventory.failureCode}` };
  }
  const visibleStudy = evidence.visibleStudy !== null && typeof evidence.visibleStudy === "object"
    ? evidence.visibleStudy as Record<string, unknown>
    : null;
  const session = selectedData.session as Record<string, unknown>;
  const durableSession = evidence.durableAfterSelect !== null &&
      typeof evidence.durableAfterSelect === "object"
    ? evidence.durableAfterSelect as Record<string, unknown>
    : null;
  if (visibleStudy?.deck_id !== evidence.selectedDeckId ||
      visibleStudy?.session_sequence !== session.sequence ||
      durableSession?.id !== session.id ||
      durableSession?.deckId !== evidence.selectedDeckId ||
      durableSession?.sequence !== session.sequence ||
      visibleStudy?.current_card_id !== durableSession?.activeCardId) {
    return { status: "failed", failureCode: "study-state-parity-mismatch" };
  }
  if (evidence.browserErrors.length > 0) {
    return { status: "failed", failureCode: "home-journey-browser-errors" };
  }
  return { status: "passed", failureCode: null };
}
