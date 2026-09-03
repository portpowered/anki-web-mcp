import { describe, expect, test } from "bun:test";

import {
  assessBrowserContextIsolation,
  type BrowserContextIsolationEvidence,
  type ContextStorageSnapshot,
} from "../../scripts/webmcp-browser-context-isolation";
import {
  assessDeploymentRevision,
  type DeploymentRevisionEvidence,
} from "../../scripts/webmcp-deployment-revision";
import { sanitizeWebMcpEvidence } from "../../scripts/webmcp-evidence-sanitization";
import {
  assessWebMcpEvidenceGates,
  type WebMcpEvidenceGateInput,
} from "../../scripts/webmcp-evidence-assessment";

const emptyStorage = (): ContextStorageSnapshot => ({
  indexedDb: [{ name: "anki-web-mcp", stores: [{ name: "decks", count: 1, keysSha256: "digest" }] }],
  localStorageKeys: [],
  sessionStorageKeys: [],
});

function contextEvidence(): BrowserContextIsolationEvidence {
  const call = { status: "passed" as const, result: { ok: true }, error: null };
  return {
    contexts: [
      {
        label: "first",
        seedDecks: [{ id: "seed" }],
        deckId: "seed",
        cardId: "card",
        sessionId: "session-first",
        sharedCommandId: "same-command-in-isolated-contexts",
        beforePeerMutation: emptyStorage(),
        afterPeerMutation: emptyStorage(),
        finalStorage: emptyStorage(),
        selectCall: call,
        flipCall: call,
      },
      {
        label: "second",
        seedDecks: [{ id: "seed" }],
        deckId: "seed",
        cardId: "card",
        sessionId: "session-second",
        sharedCommandId: "same-command-in-isolated-contexts",
        beforePeerMutation: emptyStorage(),
        afterPeerMutation: emptyStorage(),
        finalStorage: emptyStorage(),
        selectCall: call,
        flipCall: call,
      },
    ],
    browserErrors: [],
  };
}

describe("final WebMCP isolation classification", () => {
  test("accepts independent seeds, sessions, storage, and same command IDs", () => {
    expect(assessBrowserContextIsolation(contextEvidence())).toEqual({
      status: "passed",
      failureCode: null,
    });
  });

  test("rejects peer storage visibility and command-history collisions", () => {
    const leaked = contextEvidence();
    leaked.contexts[1].afterPeerMutation.sessionStorageKeys = ["anki.active-session"];
    expect(assessBrowserContextIsolation(leaked).failureCode).toBe("context-storage-leaked");

    const collision = contextEvidence();
    collision.contexts[1].flipCall = {
      status: "passed",
      result: { ok: false, error: { code: "DUPLICATE_COMMAND" } },
      error: null,
    };
    expect(assessBrowserContextIsolation(collision).failureCode).toBe("context-command-history-leaked");
  });
});

const commit = "a".repeat(40);
function deploymentEvidence(): DeploymentRevisionEvidence {
  return {
    repository: "portpowered/anki-web-mcp",
    environment: "github-pages",
    requiredOrigin: "https://portpowered.github.io",
    localHeadCommit: commit,
    finalMainCommit: commit,
    deployedCommit: commit,
    deploymentStatus: "success",
    deploymentUrl: "https://portpowered.github.io/anki-web-mcp/",
    observedAt: "2026-09-02T00:00:00.000Z",
    failure: null,
  };
}

describe("final-main deployment classification", () => {
  test("accepts one successful exact final-main Pages revision", () => {
    expect(assessDeploymentRevision(deploymentEvidence())).toEqual({
      status: "passed",
      failureCode: null,
    });
  });

  test("rejects a feature head, stale deployment, and wrong origin", () => {
    const branch = deploymentEvidence();
    branch.localHeadCommit = "b".repeat(40);
    expect(assessDeploymentRevision(branch).failureCode).toBe("deployment-revision-mismatch");

    const pending = deploymentEvidence();
    pending.deploymentStatus = "pending";
    expect(assessDeploymentRevision(pending).failureCode).toBe("deployment-not-successful");

    const wrongOrigin = deploymentEvidence();
    wrongOrigin.deploymentUrl = "https://example.test/anki-web-mcp/";
    expect(assessDeploymentRevision(wrongOrigin).failureCode).toBe("deployment-origin-mismatch");
  });
});

function passingGates(): WebMcpEvidenceGateInput {
  const passed = () => ({ status: "passed", failureCode: null });
  return {
    oracle: passed(),
    qualityPassed: true,
    localControlsPassed: true,
    productionRoutes: passed(),
    homeJourney: passed(),
    studyJourney: passed(),
    suspensionJourney: passed(),
    adversarialJourney: passed(),
    lifecycle: passed(),
    isolation: passed(),
    browserContextIsolation: passed(),
    deploymentRevision: passed(),
  };
}

describe("aggregate WebMCP evidence classification", () => {
  test("supports only when every independent gate passes", () => {
    expect(assessWebMcpEvidenceGates(passingGates())).toMatchObject({
      overall: "supported",
      downstream: "supported",
      deployedProductionPassed: true,
      failureBoundary: null,
    });
  });

  test("does not let a passing route aggregate mask a home parity failure", () => {
    const gates = passingGates();
    gates.homeJourney = {
      status: "failed",
      failureCode: "deck-state-parity-mismatch",
      failureDetail: "durable:new_count",
    };
    expect(assessWebMcpEvidenceGates(gates)).toMatchObject({
      overall: "no-go",
      downstream: "no-go",
      deployedProductionPassed: false,
      deployedProductionFailureCode: "deck-state-parity-mismatch",
      deployedProductionFailureDetail: "durable:new_count",
      failureBoundary: "deployed-production:deck-state-parity-mismatch",
    });
  });

  test.each([
    "productionRoutes",
    "studyJourney",
    "suspensionJourney",
    "adversarialJourney",
    "lifecycle",
  ] as const)("fails closed when %s is missing or failed", (stage) => {
    const gates = passingGates();
    gates[stage] = { status: "not-evaluable", failureCode: `${stage}-failed` };
    expect(assessWebMcpEvidenceGates(gates)).toMatchObject({
      overall: "no-go",
      deployedProductionPassed: false,
      failureBoundary: `deployed-production:${stage}-failed`,
    });
  });

  test("keeps downstream evidence not-evaluable when the native oracle fails", () => {
    const gates = passingGates();
    gates.oracle = { status: "failed", failureCode: "native-unavailable" };
    expect(assessWebMcpEvidenceGates(gates)).toMatchObject({
      overall: "not-evaluable",
      downstream: "not-evaluable",
      failureBoundary: "external-oracle:native-unavailable",
    });
  });
});

test("sanitizes nested tokens and card content while retaining contract fields", () => {
  const rawToken = "customer-token";
  const sanitized = sanitizeWebMcpEvidence({
    tokenByValue: rawToken,
    originTrialToken: rawToken,
    errors: [`probe failed: ${rawToken}`, { log: `before ${rawToken} after ${rawToken}` }],
    call: {
      front_text: "hola",
      back_text: "hello",
      frontHtml: "<b>hola</b>",
      cardHtml: "<img src=private>",
      questionFormat: "{{Front}}",
      ok: true,
    },
    inputSchema: { type: "object" },
  }, ["", rawToken]);
  expect(JSON.stringify(sanitized)).not.toContain(rawToken);
  expect(sanitized).toEqual({
    tokenByValue: "[redacted-secret]",
    originTrialToken: "[redacted-originTrialToken]",
    errors: [
      "probe failed: [redacted-secret]",
      { log: "before [redacted-secret] after [redacted-secret]" },
    ],
    call: {
      front_text: "[redacted-front_text]",
      back_text: "[redacted-back_text]",
      frontHtml: "[redacted-frontHtml]",
      cardHtml: "[redacted-cardHtml]",
      questionFormat: "[redacted-questionFormat]",
      ok: true,
    },
    inputSchema: { type: "object" },
  });
});
