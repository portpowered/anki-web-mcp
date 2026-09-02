export type ContextIsolationCall = {
  status: "passed" | "failed" | "not-run";
  result: unknown;
  error: string | null;
};

export type ContextStorageSnapshot = {
  indexedDb: Array<{
    name: string;
    stores: Array<{ name: string; count: number; keysSha256: string }>;
  }>;
  localStorageKeys: string[];
  sessionStorageKeys: string[];
};

export type IsolatedContextEvidence = {
  label: "first" | "second";
  seedDecks: unknown;
  deckId: string | null;
  cardId: string | null;
  sessionId: string | null;
  sharedCommandId: string;
  beforePeerMutation: ContextStorageSnapshot;
  afterPeerMutation: ContextStorageSnapshot;
  finalStorage: ContextStorageSnapshot;
  selectCall: ContextIsolationCall;
  flipCall: ContextIsolationCall;
};

export type BrowserContextIsolationEvidence = {
  contexts: [IsolatedContextEvidence, IsolatedContextEvidence];
  browserErrors: string[];
};

export type BrowserContextIsolationAssessment = {
  status: "passed" | "failed";
  failureCode: string | null;
};

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decoded(call: ContextIsolationCall): Record<string, unknown> | null {
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

/** Classify only the independently observed browser-context traces. */
export function assessBrowserContextIsolation(
  evidence: BrowserContextIsolationEvidence,
): BrowserContextIsolationAssessment {
  const [first, second] = evidence.contexts;
  if (!equal(first.seedDecks, second.seedDecks) || !first.deckId || first.deckId !== second.deckId) {
    return { status: "failed", failureCode: "context-seed-mismatch" };
  }
  if (!equal(first.beforePeerMutation, first.afterPeerMutation) ||
      !equal(second.beforePeerMutation, second.afterPeerMutation)) {
    return { status: "failed", failureCode: "context-storage-leaked" };
  }
  if (first.sessionId === null || second.sessionId === null || first.sessionId === second.sessionId) {
    return { status: "failed", failureCode: "context-session-leaked" };
  }
  if (first.sharedCommandId !== second.sharedCommandId ||
      decoded(first.flipCall)?.ok !== true || decoded(second.flipCall)?.ok !== true) {
    return { status: "failed", failureCode: "context-command-history-leaked" };
  }
  if (first.selectCall.status !== "passed" || second.selectCall.status !== "passed" ||
      !first.cardId || !second.cardId) {
    return { status: "failed", failureCode: "context-journey-failed" };
  }
  if (evidence.browserErrors.length > 0) {
    return { status: "failed", failureCode: "context-browser-errors" };
  }
  return { status: "passed", failureCode: null };
}
