import {
  activeStudyToolNames,
  assessProductionInventory,
  homeToolContracts,
  homeToolNames,
} from "./webmcp-production-contract";
import {
  parseHomeDeckObservations,
  type DurableDeckMetadataObservation,
  type HomeDeckObservation,
  type VisibleHomeDeckObservation,
  type VisibleHomePageObservation,
} from "./webmcp-home-observation";
import {
  assessNativeInputRejection,
  type NativeInputRejectionInvocation,
} from "./webmcp-native-input-rejection";

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
  durableBefore: HomeDeckObservation[];
  durableDeckMetadataBefore: DurableDeckMetadataObservation[];
  durableAfterList: HomeDeckObservation[];
  durableAfterMalformed: HomeDeckObservation[];
  durableAfterExtra: HomeDeckObservation[];
  durableAfterSelect: unknown;
  visibleHome: VisibleHomePageObservation;
  listCall: HomeJourneyCall;
  repeatedListCall: HomeJourneyCall;
  malformedListCall: HomeJourneyCall;
  malformedListInput: string;
  malformedListInvocation: NativeInputRejectionInvocation;
  extraListCall: HomeJourneyCall;
  selectCall: HomeJourneyCall;
  selectedDeckId: string | null;
  visibleStudy: unknown;
  browserErrors: string[];
};

export type HomeJourneyAssessment = {
  status: "passed" | "failed";
  failureCode: string | null;
  failureDetail: string | null;
};

function failed(failureCode: string, failureDetail: string | null = null): HomeJourneyAssessment {
  return { status: "failed", failureCode, failureDetail };
}

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

function structuredInvalidInput(call: HomeJourneyCall): boolean {
  const result = decoded(call);
  const error = result?.error !== null && typeof result?.error === "object"
    ? result.error as Record<string, unknown>
    : null;
  return call.status === "passed" && result?.ok === false && !("data" in (result ?? {})) &&
    error?.code === "INVALID_INPUT" &&
    typeof error.message === "string" && error.message.trim().length > 0 &&
    error.recoverable === true &&
    typeof error.suggested_action === "string" && error.suggested_action.trim().length > 0;
}

function toolContractsMatch(evidence: HomeJourneyEvidence): boolean {
  return homeToolContracts.every((expected) => {
    const observed = evidence.homeTools.find((tool) => tool.name === expected.name);
    return observed !== undefined &&
      equal(decodedSchema(observed.inputSchema), expected.inputSchema) &&
      equal(observed.annotations, expected.annotations);
  });
}

const deckFields = [
  "id",
  "name",
  "card_count",
  "new_count",
  "due_count",
  "suspended_count",
  "last_studied_at",
  "can_start_session",
] as const satisfies ReadonlyArray<keyof HomeDeckObservation>;

function deckParityMismatch(
  listedDecks: HomeDeckObservation[],
  durableDecks: HomeDeckObservation[],
  durableDeckMetadata: DurableDeckMetadataObservation[],
  visibleHome: VisibleHomePageObservation,
): string | null {
  if (visibleHome.state !== "populated") {
    return `visible:page_state:${visibleHome.state ?? "missing"}`;
  }
  if (durableDecks.length !== listedDecks.length) {
    return visibleHome.decks.length === durableDecks.length
      ? "structured:deck_count"
      : "durable:deck_count";
  }
  if (visibleHome.decks.length !== listedDecks.length) {
    return "visible:deck_count";
  }

  for (const [index, listed] of listedDecks.entries()) {
    const durable = durableDecks[index];
    const visible: VisibleHomeDeckObservation | undefined = visibleHome.decks[index];
    if (!durable) return "durable:deck_count";
    if (!visible) return "visible:deck_count";

    const durableMetadata = durableDeckMetadata.find((deck) => deck.id === durable.id);
    if (!durableMetadata) return "durable:last_studied_at";
    if (!equal(durableMetadata.last_studied_at, listed.last_studied_at)) {
      return "structured:last_studied_at";
    }
    if (!equal(durableMetadata.last_studied_at, durable.last_studied_at)) {
      return "durable:last_studied_at";
    }

    for (const field of deckFields) {
      if (!equal(durable[field], listed[field])) {
        const visibleValue = field === "can_start_session"
          ? visible.study_keyboard_operable
          : field === "suspended_count" && visible.suspended_count === null &&
              !visible.recovery_available ? 0
          : field === "last_studied_at" ? durableMetadata.last_studied_at : visible[field];
        // When both independent observations agree, identify the structured view.
        // Otherwise the durable projection is the first disagreeing view.
        return visibleValue !== undefined && equal(visibleValue, durable[field])
          ? `structured:${field}`
          : `durable:${field}`;
      }
    }

    for (const field of ["id", "name", "card_count", "new_count", "due_count"] as const) {
      if (!equal(visible[field], listed[field])) return `visible:${field}`;
    }
    if (listed.suspended_count === 0) {
      if (visible.suspended_count !== null) return "visible:suspended_count";
      if (visible.recovery_available) return "visible:recovery_available";
    } else {
      if (visible.suspended_count !== null) return "visible:suspended_count";
      if (!visible.recovery_available) return "visible:recovery_available";
    }
    if (visible.study_action === null) return "visible:study_action";
    if (visible.study_keyboard_operable !== listed.can_start_session) {
      return "visible:can_start_session";
    }
  }
  return null;
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
    return failed(`home-${homeInventory.failureCode}`);
  }
  if (!toolContractsMatch(evidence)) {
    return failed("home-tool-contract-mismatch");
  }
  if (evidence.initialUrl !== expectedRootUrl) {
    return failed("home-route-mismatch");
  }
  if (!equal(evidence.stateBefore, evidence.stateAfterList) ||
      !equal(evidence.durableBefore, evidence.durableAfterList) ||
      !equal(evidence.listCall.result, evidence.repeatedListCall.result)) {
    return failed("list-decks-mutated-state");
  }
  const listed = decoded(evidence.listCall);
  const listedData = listed?.data !== null && typeof listed?.data === "object"
    ? listed.data as Record<string, unknown>
    : null;
  const listedDecks = parseHomeDeckObservations(listedData?.decks);
  if (listed?.ok !== true || listedData?.page !== "decks" ||
      listedDecks === null || listedDecks.length === 0) {
    return failed("persisted-seed-unavailable");
  }
  const parityMismatch = deckParityMismatch(
    listedDecks,
    evidence.durableBefore,
    evidence.durableDeckMetadataBefore,
    evidence.visibleHome,
  );
  if (parityMismatch) {
    return failed("deck-state-parity-mismatch", parityMismatch);
  }
  if (evidence.selectedDeckId !== listedDecks[0]?.id) {
    return failed("select-deck-failed", "selected_deck_id");
  }
  const malformed = assessNativeInputRejection({
    label: "malformed",
    serializedInput: evidence.malformedListInput,
    expectedToolNames: homeToolNames,
    expectedIntendedToolName: "list_decks",
    invocation: evidence.malformedListInvocation,
    call: evidence.malformedListCall,
  });
  if (!malformed.accepted) {
    return failed(
      "invalid-list-input-mutated-state",
      `native-${malformed.failure}:malformed:${malformed.detail}`,
    );
  }
  if (!structuredInvalidInput(evidence.extraListCall)) {
    return failed("invalid-list-input-mutated-state", "response-contract:extra");
  }
  if (!equal(evidence.stateAfterList, evidence.stateAfterMalformed) ||
      !equal(evidence.stateAfterList, evidence.stateAfterExtra) ||
      !equal(evidence.durableAfterList, evidence.durableAfterMalformed) ||
      !equal(evidence.durableAfterList, evidence.durableAfterExtra)) {
    return failed("invalid-list-input-mutated-state");
  }
  const selected = decoded(evidence.selectCall);
  const selectedData = selected?.data !== null && typeof selected?.data === "object"
    ? selected.data as Record<string, unknown>
    : null;
  if (selected?.ok !== true || selectedData?.page !== "study" ||
      selectedData.deck_id !== evidence.selectedDeckId ||
      selectedData.session === null || evidence.durableAfterSelect === null) {
    return failed("select-deck-failed");
  }
  const expectedStudyUrl = `${expectedStudyBaseUrl}?deck=${encodeURIComponent(evidence.selectedDeckId ?? "")}`;
  if (evidence.finalUrl !== expectedStudyUrl || evidence.deploymentRoute !== "study") {
    return failed("study-navigation-mismatch");
  }
  const studyInventory = assessProductionInventory(
    evidence.studyToolNames,
    activeStudyToolNames,
  );
  if (studyInventory.failureCode) {
    return failed(`study-${studyInventory.failureCode}`);
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
    return failed("study-state-parity-mismatch");
  }
  if (evidence.browserErrors.length > 0) {
    return failed("home-journey-browser-errors");
  }
  return { status: "passed", failureCode: null, failureDetail: null };
}
