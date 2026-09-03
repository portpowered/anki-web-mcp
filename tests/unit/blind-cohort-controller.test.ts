import { describe, expect, test } from "bun:test";

import { BLIND_COHORT_MANIFEST, type BlindProbeTask, type RestrictedProbeInput } from "../../scripts/blind-cohort/contract";
import { runBlindCohortController } from "../../scripts/blind-cohort/controller";
import type { TrustedProbeObserver } from "../../scripts/blind-cohort/evidence";
import type { ObservableProbeBrowser } from "../../scripts/blind-cohort/live-adapters";
import { assessBlindCohortPreflight, type BlindCohortPreflightEvidence } from "../../scripts/blind-cohort/preflight";
import { REQUIRED_BROWSER_VERSION, type ProbeAgentContext, type ProbeAttemptResult } from "../../scripts/blind-cohort/runner";

const sha = "a".repeat(40);

function passingPreflight(): BlindCohortPreflightEvidence {
  return {
    requestedSha: sha,
    repositoryHead: sha,
    fetchedMainHead: sha,
    protectedCi: { headSha: sha, status: "completed", conclusion: "success" },
    pagesDeployment: { sourceSha: sha, status: "success" },
    routes: {
      root: { status: 200, marker: "deck-home" },
      study: { status: 200, marker: "study" },
    },
    observedDeploymentSha: sha,
    unresolvedReleaseCandidatePrs: 0,
    ordinaryReleaseChecks: { sha, status: "passed" },
    eightToolAggregate: {
      sha,
      status: "passed",
      browserVersion: REQUIRED_BROWSER_VERSION,
      completeToolCount: 8,
    },
  };
}

describe("blind cohort exact-revision preflight", () => {
  test("accepts only one exact qualified SHA with terminal gates", () => {
    expect(assessBlindCohortPreflight(passingPreflight())).toEqual({
      status: "passed",
      sha,
      deployedUrl: "https://portpowered.github.io/anki-web-mcp/",
      failure: null,
    });
  });

  test.each([
    ["abbreviated SHA", (value: BlindCohortPreflightEvidence) => ({ ...value, requestedSha: "abc123" })],
    ["intervening main", (value: BlindCohortPreflightEvidence) => ({ ...value, fetchedMainHead: "b".repeat(40) })],
    ["pending CI", (value: BlindCohortPreflightEvidence) => ({ ...value, protectedCi: { ...value.protectedCi, status: "queued" } })],
    ["stale observed deployment", (value: BlindCohortPreflightEvidence) => ({ ...value, observedDeploymentSha: "b".repeat(40) })],
    ["missing route", (value: BlindCohortPreflightEvidence) => ({ ...value, routes: { ...value.routes, study: { status: 404, marker: "study" } } })],
    ["open release PR", (value: BlindCohortPreflightEvidence) => ({ ...value, unresolvedReleaseCandidatePrs: 1 })],
    ["wrong aggregate browser", (value: BlindCohortPreflightEvidence) => ({ ...value, eightToolAggregate: { ...value.eightToolAggregate, browserVersion: "152.0.0.0" } })],
  ])("rejects %s before execution", (_label, mutate) => {
    expect(assessBlindCohortPreflight(mutate(passingPreflight())).status).toBe("failed");
  });
});

test("invalid preflight writes sanitized NO-GO and starts zero agents or browsers", async () => {
  let browserStarts = 0;
  let agentStarts = 0;
  const artifacts = new Map<string, string>();
  const result = await runBlindCohortController({
    preflight: { ...passingPreflight(), observedDeploymentSha: "b".repeat(40) },
    apiKey: "secret-key",
    model: "test-model",
    timeoutMs: 100,
    artifactDirectory: ".ignored",
    createBrowser: async () => { browserStarts += 1; throw new Error("must not start"); },
    createAgent: () => { agentStarts += 1; throw new Error("must not start"); },
    writeArtifact: async (name, value) => { artifacts.set(name, value); },
  });
  expect(result.exitCode).toBe(1);
  expect(browserStarts).toBe(0);
  expect(agentStarts).toBe(0);
  expect(artifacts.get("preflight-no-go.json")).toContain('"decision": "NO-GO"');
});

test("runnable controller creates ten isolated contexts and emits one live 10/10 report", async () => {
  let browserNumber = 0;
  let agentNumber = 0;
  const closed: string[] = [];
  const removed: string[] = [];
  const artifacts = new Map<string, string>();
  const browsersByProfile = new Map<string, FakeBrowser>();

  const result = await runBlindCohortController({
    preflight: passingPreflight(),
    apiKey: "controller-only-secret",
    model: "test-model",
    timeoutMs: 1_000,
    artifactDirectory: ".ignored",
    createBrowser: async ({ transcript }) => {
      browserNumber += 1;
      const browser = new FakeBrowser(browserNumber, transcript, closed, removed);
      browsersByProfile.set(browser.profileId, browser);
      return browser;
    },
    createAgent: () => new FakeAgent(++agentNumber),
    createObserver: (_key, _model, browser) => observerFor(browser),
    writeArtifact: async (name, value) => { artifacts.set(name, value); },
  });

  expect(result.exitCode).toBe(0);
  expect(result.report).toMatchObject({ decision: "GO", score: "10/10", attempted: 10, deployedSha: sha });
  expect(browserNumber).toBe(10);
  expect(agentNumber).toBe(10);
  expect(closed).toHaveLength(10);
  expect(removed).toHaveLength(10);
  expect(new Set([...browsersByProfile.keys()]).size).toBe(10);
  expect(artifacts.get("report.json")).toContain('"evidenceOrigin": "live"');
  expect([...artifacts.values()].join("\n")).not.toContain("controller-only-secret");
});

test("controller preserves a pre-agent browser boundary as evidence and stops without an observer model", async () => {
  let agentStarts = 0;
  let observerStarts = 0;
  const artifacts = new Map<string, string>();
  const result = await runBlindCohortController({
    preflight: passingPreflight(),
    apiKey: "controller-only-secret",
    model: "test-model",
    timeoutMs: 1_000,
    artifactDirectory: ".ignored",
    createBrowser: async ({ transcript }) => new FakeBrowser(1, transcript, [], [], "151.0.0.0"),
    createAgent: () => { agentStarts += 1; throw new Error("must not start"); },
    createObserver: () => { observerStarts += 1; throw new Error("must not start"); },
    writeArtifact: async (name, value) => { artifacts.set(name, value); },
  });

  expect(result).toMatchObject({ exitCode: 1, report: { decision: "NO-GO", attempted: 1 } });
  expect(agentStarts).toBe(0);
  expect(observerStarts).toBe(0);
  expect(result.report?.probes[0]).toMatchObject({
    agentContextId: "not-started",
    terminalStatus: "isolation-failure",
    terminalReason: `Browser version must be ${REQUIRED_BROWSER_VERSION}.`,
  });
  expect(artifacts.get("report.json")).toContain('"decision": "NO-GO"');
});

test("browser creation failure emits complete sanitized NO-GO evidence without starting an agent or later probe", async () => {
  let browserStarts = 0;
  let agentStarts = 0;
  let observerStarts = 0;
  const artifacts = new Map<string, string>();
  const result = await runBlindCohortController({
    preflight: passingPreflight(),
    apiKey: "controller-only-secret",
    model: "test-model",
    timeoutMs: 1_000,
    artifactDirectory: ".ignored",
    createBrowser: async () => {
      browserStarts += 1;
      throw new Error("Chrome launch failed with apiKey=controller-only-secret at /tmp/private-profile");
    },
    createAgent: () => { agentStarts += 1; throw new Error("must not start"); },
    createObserver: () => { observerStarts += 1; throw new Error("must not start"); },
    writeArtifact: async (name, value) => { artifacts.set(name, value); },
  });

  expect(browserStarts).toBe(1);
  expect(agentStarts).toBe(0);
  expect(observerStarts).toBe(0);
  expect(result).toMatchObject({
    exitCode: 1,
    report: {
      decision: "NO-GO",
      attempted: 1,
      firstFailure: { probeId: "probe-1", category: "test-environment-flake" },
    },
  });
  expect(result.report?.probes[0]).toMatchObject({
    probeId: "probe-1",
    taskNumber: 1,
    deployedSha: sha,
    deployedUrl: BLIND_COHORT_MANIFEST.tasks[0].publicUrl,
    agentContextId: "not-started",
    browserProfileId: "unavailable",
    browserVersion: "unavailable",
    retryCount: 0,
    retryReason: null,
    terminalStatus: "browser-failure",
    terminalReason: "Chrome launch failed with [redacted-credential] at [redacted-local-path]",
    finalUi: { trusted: true, ambiguous: true, failureCategory: "test-environment-flake" },
    durableState: { trusted: true, ambiguous: true, failureCategory: "test-environment-flake" },
    judgments: expect.arrayContaining([
      expect.objectContaining({ dimension: "functionality", status: "fail" }),
    ]),
    metrics: expect.arrayContaining([
      expect.objectContaining({ name: "correct-final-state", passed: false, failureCategory: "test-environment-flake" }),
    ]),
    passed: false,
  });
  expect(result.report?.probes[0]?.transcript.map((event) => event.action)).toEqual([
    "browser-create-started",
    "browser-create-failed",
  ]);
  const output = [...artifacts.values()].join("\n");
  expect(output).toContain('\"decision\": \"NO-GO\"');
  expect(output).not.toContain("controller-only-secret");
  expect(output).not.toContain("/tmp/private-profile");
});

class FakeBrowser implements ObservableProbeBrowser {
  readonly profileId: string;
  readonly userDataDirectory: string;
  readonly browserVersion: string;
  readonly semanticBrowser;
  readonly publicWebMcp;

  constructor(
    number: number,
    transcript: { append(channel: "visible" | "webmcp", action: string, result: unknown): void },
    private readonly closed: string[],
    private readonly removed: string[],
    browserVersion: string = REQUIRED_BROWSER_VERSION,
  ) {
    this.profileId = `profile-${number}`;
    this.userDataDirectory = `/tmp/fresh-profile-${number}`;
    this.browserVersion = browserVersion;
    this.semanticBrowser = {
      observe: async () => { const result = "semantic view"; transcript.append("visible", "observe", result); return result; },
      activate: async () => null,
      enterText: async () => null,
      attachFixture: async () => null,
    };
    this.publicWebMcp = { discover: async () => [], invoke: async () => ({ ok: true }) };
  }

  async verifyIndexedDbEmpty(): Promise<boolean> { return true; }
  async captureRawObservation(): Promise<{ url: string; aria: string; durable: unknown }> {
    return { url: "https://portpowered.github.io/anki-web-mcp/", aria: "semantic view", durable: { stores: [] } };
  }
  async close(): Promise<void> { this.closed.push(this.profileId); }
  async removeProfile(): Promise<void> { this.removed.push(this.profileId); }
}

class FakeAgent implements ProbeAgentContext {
  readonly contextId: string;
  constructor(number: number) { this.contextId = `agent-${number}`; }
  async run(input: RestrictedProbeInput): Promise<ProbeAttemptResult> {
    await input.semanticBrowser.observe();
    return { status: "passed" };
  }
  async close(): Promise<void> {}
}

function observerFor(browser: ObservableProbeBrowser): TrustedProbeObserver {
  const number = Number(browser.profileId.split("-").at(-1));
  const task = BLIND_COHORT_MANIFEST.tasks[number - 1] as BlindProbeTask;
  return {
    capture: async () => ({
      finalUi: {
        trusted: true,
        route: task.expected.finalUi.route,
        visibleState: [...task.expected.finalUi.visibleState],
        ambiguous: false,
        failureCategory: null,
      },
      durableState: {
        trusted: true,
        effects: [...task.expected.durableState],
        mutatedDecks: task.expected.destructiveTarget.allowedDeck === null ? [] : [task.expected.destructiveTarget.allowedDeck],
        ambiguous: false,
        failureCategory: null,
      },
      judgments: task.judgments.map((dimension) => ({ dimension, status: "pass" as const, reason: "Observable result is clear." })),
      completionBasis: "expected-effects",
    }),
  };
}
