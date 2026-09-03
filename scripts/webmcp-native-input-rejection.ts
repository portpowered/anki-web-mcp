import {
  assessProductionInventory,
  type ProductionToolName,
} from "./webmcp-production-contract";

export type NativeInputRejectionCall = {
  status: "passed" | "failed" | "not-run";
  result: unknown;
  error: string | null;
};

export type NativeInputRejectionInvocation = {
  intendedToolName: ProductionToolName;
  acquiredToolName: string | null;
  availableToolNames: string[];
  source: string;
  executeStarted: boolean;
};

export type NativeInputRejectionEvidence = {
  label: string;
  serializedInput: string;
  expectedToolNames: readonly ProductionToolName[];
  expectedIntendedToolName: ProductionToolName;
  invocation: NativeInputRejectionInvocation;
  call: NativeInputRejectionCall;
};

export type NativeInputRejectionFailure =
  | "case"
  | "inventory"
  | "acquisition"
  | "attempt"
  | "response"
  | "signature";

export type NativeInputRejectionAssessment =
  | { accepted: true; failure: null; detail: null }
  | { accepted: false; failure: NativeInputRejectionFailure; detail: string };

const supportedChromeParseInputError =
  /^UnknownError: Failed to parse input arguments\.?$/;

function rejected(
  failure: NativeInputRejectionFailure,
  detail: string,
): NativeInputRejectionAssessment {
  return { accepted: false, failure, detail };
}

/**
 * Credit only Chrome's observed pre-callback rejection for the exact serialized
 * null case. Every fact is supplied by recorded evidence so classification is
 * deterministic and independent of ambient browser state.
 */
export function assessNativeInputRejection(
  evidence: NativeInputRejectionEvidence,
): NativeInputRejectionAssessment {
  if (evidence.label !== "malformed" || evidence.serializedInput !== "null") {
    return rejected("case", "exact-malformed-null-required");
  }

  const inventory = assessProductionInventory(
    evidence.invocation.availableToolNames,
    evidence.expectedToolNames,
  );
  if (inventory.status !== "passed") {
    return rejected("inventory", inventory.failureCode ?? "inventory-mismatch");
  }

  if (evidence.invocation.source !== "current-registration" ||
      evidence.invocation.intendedToolName !== evidence.expectedIntendedToolName ||
      evidence.invocation.acquiredToolName !== evidence.invocation.intendedToolName) {
    return rejected("acquisition", "current-intended-tool-required");
  }

  if (!evidence.invocation.executeStarted) {
    return rejected("attempt", "execute-tool-not-started");
  }

  if (evidence.call.status !== "failed" || evidence.call.result !== null) {
    return rejected("response", "failed-with-null-result-required");
  }

  if (evidence.call.error === null ||
      !supportedChromeParseInputError.test(evidence.call.error)) {
    return rejected("signature", "unsupported-native-error");
  }

  return { accepted: true, failure: null, detail: null };
}
