import { describe, expect, test } from "bun:test";

import { BLIND_COHORT_MANIFEST, type BlindProbeTask } from "../../scripts/blind-cohort/contract";
import {
  BLIND_EVIDENCE_SCHEMA_VERSION,
  BlindEvidenceError,
  buildCohortReport,
  captureAndScoreProbeEvidence,
  sanitizedEvidenceSink,
  type BlindProbeEvidence,
  type CaptureProbeEvidenceInput,
  type TrustedObservation,
} from "../../scripts/blind-cohort/evidence";
import { REQUIRED_BROWSER_VERSION, type ProbeAttemptResult } from "../../scripts/blind-cohort/runner";

const sha = "a".repeat(40);

function observation(task: BlindProbeTask): TrustedObservation {
  return {
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
      mutatedDecks: task.expected.destructiveTarget.allowedDeck === null
        ? []
        : [task.expected.destructiveTarget.allowedDeck],
      ambiguous: false,
      failureCategory: null,
    },
    judgments: task.judgments.map((dimension) => ({ dimension, status: "pass", reason: `${dimension} is clear.` })),
    completionBasis: "expected-effects",
  };
}

function input(
  task = BLIND_COHORT_MANIFEST.tasks[0]!,
  overrides: Partial<CaptureProbeEvidenceInput> = {},
  observed: TrustedObservation = observation(task),
): CaptureProbeEvidenceInput {
  return {
    task,
    evidenceOrigin: "simulated",
    agentContextId: `agent-${task.number}`,
    browserProfileId: `profile-${task.number}`,
    attempts: [{ status: "passed" }],
    status: "passed",
    reason: null,
    deployedSha: sha,
    deployedUrl: task.publicUrl,
    runId: `run-${task.number}`,
    browserVersion: REQUIRED_BROWSER_VERSION,
    startedAt: "2026-09-03T10:00:00.000Z",
    finishedAt: "2026-09-03T10:00:01.000Z",
    transcript: [{
      sequence: 1,
      at: "2026-09-03T10:00:00.500Z",
      channel: "visible",
      action: "Observed the deck list",
      result: "Spanish Basics was visible",
    }],
    observer: { capture: async () => observed },
    ...overrides,
  };
}

async function evidenceFor(task: BlindProbeTask): Promise<BlindProbeEvidence> {
  return await captureAndScoreProbeEvidence(input(task));
}

describe("blind probe evidence and Section 13 scoring", () => {
  test("captures the complete versioned record from a trusted post-agent observer", async () => {
    let observerCalled = false;
    const task = BLIND_COHORT_MANIFEST.tasks[0]!;
    const evidence = await captureAndScoreProbeEvidence(input(task, {
      observer: { capture: async (observedTask) => {
        observerCalled = true;
        expect(observedTask).toBe(task);
        return observation(task);
      } },
    }));

    expect(observerCalled).toBe(true);
    expect(evidence).toEqual(expect.objectContaining({
      schemaVersion: BLIND_EVIDENCE_SCHEMA_VERSION,
      evidenceOrigin: "simulated",
      probeId: "probe-1",
      deployedSha: sha,
      deployedUrl: task.publicUrl,
      browserVersion: REQUIRED_BROWSER_VERSION,
      retryCount: 0,
      retryReason: null,
      terminalStatus: "passed",
      passed: true,
      firstFailure: null,
    }));
    expect(evidence.transcript).toHaveLength(1);
    expect(evidence.metrics.map((metric) => [metric.name, metric.passed])).toEqual([
      ["correct-final-state", true],
      ["no-human-hint", true],
      ["safe-destructive-target", true],
      ["bounded-structured-recovery", true],
      ["unambiguous-outcome", true],
    ]);
    expect(evidence.judgments.map((judgment) => judgment.dimension)).toEqual(["functionality", "ux", "ui"]);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  test("records one eligible structured-error recovery and its reason", async () => {
    const attempts: ProbeAttemptResult[] = [
      {
        status: "failed",
        requestSelfRecovery: true,
        structuredError: { code: "stale-state", message: "State changed", recoverable: true },
      },
      { status: "passed" },
    ];
    const evidence = await captureAndScoreProbeEvidence(input(undefined, { attempts }));

    expect(evidence.retryCount).toBe(1);
    expect(evidence.retryReason).toBe("State changed");
    expect(evidence.structuredErrors).toEqual([{ code: "stale-state", message: "State changed" }]);
    expect(evidence.metrics.find((metric) => metric.name === "bounded-structured-recovery")?.passed).toBe(true);
  });

  test("scores all five metrics independently and uses stable within-probe precedence", async () => {
    const task = BLIND_COHORT_MANIFEST.tasks[8]!;
    const observed = observation(task);
    const attempts: ProbeAttemptResult[] = [
      {
        status: "failed",
        requestSelfRecovery: true,
        humanHintUsed: true,
        structuredError: { code: "temporary", message: "Asked to retry", recoverable: true },
      },
      { status: "passed", requestSelfRecovery: true },
    ];
    const evidence = await captureAndScoreProbeEvidence(input(task, { attempts }, {
      ...observed,
      finalUi: {
        ...observed.finalUi,
        route: "study",
        visibleState: ["an unexpected study view"],
        ambiguous: true,
        failureCategory: "navigation",
      },
      durableState: {
        ...observed.durableState,
        effects: ["an unexpected durable effect"],
        mutatedDecks: ["Spanish Basics"],
        ambiguous: true,
        failureCategory: "scheduler-state-corruption",
      },
      judgments: observed.judgments.map((judgment) => ({ ...judgment, status: "fail", reason: "Observed failure." })),
      completionBasis: "wrong-reason",
    }));

    expect(evidence.metrics.map((metric) => metric.passed)).toEqual([false, false, false, false, false]);
    expect(evidence.firstFailure).toEqual(expect.objectContaining({
      metric: "correct-final-state",
      category: "navigation",
    }));
  });

  test("rejects wrong-reason success even when the agent and expected state claim success", async () => {
    const task = BLIND_COHORT_MANIFEST.tasks[0]!;
    const evidence = await captureAndScoreProbeEvidence(input(task, {}, {
      ...observation(task),
      completionBasis: "agent-claim",
    }));

    expect(evidence.passed).toBe(false);
    expect(evidence.firstFailure?.metric).toBe("correct-final-state");
    expect(evidence.firstFailure?.category).toBe("missing-state");
  });

  test.each([
    ["full SHA", { deployedSha: "abc" }],
    ["public URL", { deployedUrl: "https://example.test/" }],
    ["opaque agent identity", { agentContextId: "C:\\private\\agent" }],
    ["ordered timestamps", { finishedAt: "2026-09-03T09:59:59.000Z" }],
    ["transcript", { transcript: [] }],
  ])("fails closed when required %s evidence is malformed", async (_label, overrides) => {
    await expect(captureAndScoreProbeEvidence(input(undefined, overrides))).rejects.toBeInstanceOf(BlindEvidenceError);
  });

  test("rejects missing or contradictory trusted observations and judgments", async () => {
    const task = BLIND_COHORT_MANIFEST.tasks[0]!;
    const complete = observation(task);
    const cases: TrustedObservation[] = [
      { ...complete, finalUi: { ...complete.finalUi, trusted: false as true } },
      { ...complete, durableState: { ...complete.durableState, effects: [] } },
      { ...complete, judgments: complete.judgments.slice(0, 2) },
      { ...complete, judgments: complete.judgments.map((item) => ({ ...item, reason: "" })) },
    ];
    for (const observed of cases) {
      await expect(captureAndScoreProbeEvidence(input(task, {}, observed))).rejects.toBeInstanceOf(BlindEvidenceError);
    }
  });

  test.each([
    ["origin", { evidenceOrigin: undefined }],
    ["agent context", { agentContextId: null }],
    ["profile identity", { browserProfileId: "" }],
    ["browser version", { browserVersion: "" }],
    ["start timestamp", { startedAt: "" }],
    ["terminal status", { status: "unknown" }],
  ])("rejects a missing or malformed required %s field", async (_label, overrides) => {
    await expect(captureAndScoreProbeEvidence(input(undefined, overrides as Partial<CaptureProbeEvidenceInput>)))
      .rejects.toBeInstanceOf(BlindEvidenceError);
  });

  test("redacts secrets, raw origin-trial metadata, local paths, profile data, credentials, and card content before every sink", async () => {
    const writes: unknown[] = [];
    const write = sanitizedEvidenceSink((safe) => { writes.push(safe); }, ["super-secret"]);
    await write({
      message: "Bearer provider-token super-secret origin-trial token=raw-token C:\\private\\profile",
      userDataDirectory: "C:\\private\\profile",
      frontText: "private imported card",
      nested: { apiKey: "credential", classification: "navigation" },
    });
    const encoded = JSON.stringify(writes);

    expect(encoded).not.toContain("provider-token");
    expect(encoded).not.toContain("super-secret");
    expect(encoded).not.toContain("raw-token");
    expect(encoded).not.toContain("private\\\\profile");
    expect(encoded).not.toContain("private imported card");
    expect(encoded).not.toContain('"apiKey":"credential"');
    expect(encoded).toContain("navigation");
  });

  test("redacts capture input before the scored record becomes observable", async () => {
    const evidence = await captureAndScoreProbeEvidence(input(undefined, {
      secrets: ["provider-secret"],
      transcript: [{
        sequence: 1,
        at: "2026-09-03T10:00:00.500Z",
        channel: "webmcp",
        action: "Received api_key=provider-secret",
        result: { content: "private card", error: "C:\\tmp\\profile" },
      }],
    }));
    const encoded = JSON.stringify(evidence);

    expect(encoded).not.toContain("provider-secret");
    expect(encoded).not.toContain("private card");
    expect(encoded).not.toContain("C:\\\\tmp");
    expect(encoded).toContain("redacted");
  });

  test("creates 10/10 GO only from ten independent passing records and keeps human output exact", async () => {
    const records = await Promise.all(BLIND_COHORT_MANIFEST.tasks.map(evidenceFor));
    const report = buildCohortReport(records);

    expect(report).toEqual(expect.objectContaining({
      decision: "GO",
      score: "10/10",
      attempted: 10,
      evidenceOrigin: "simulated",
      exitCode: 0,
      firstFailure: null,
      humanSummary: `Cohort one 10/10 GO on ${sha}.`,
    }));
  });

  test("labels hermetic output simulated and rejects it at the live cohort boundary", async () => {
    const records = await Promise.all(BLIND_COHORT_MANIFEST.tasks.map(evidenceFor));
    const hermetic = buildCohortReport(records);

    expect(hermetic.evidenceOrigin).toBe("simulated");
    await expect(async () => buildCohortReport(records, "live")).toThrow(BlindEvidenceError);
  });

  test("reports the earliest concrete failed probe and never promotes a partial cohort", async () => {
    const first = await evidenceFor(BLIND_COHORT_MANIFEST.tasks[0]!);
    const task = BLIND_COHORT_MANIFEST.tasks[1]!;
    const failed = await captureAndScoreProbeEvidence(input(task, {}, {
      ...observation(task),
      finalUi: { ...observation(task).finalUi, route: "home", failureCategory: "navigation" },
    }));
    const report = buildCohortReport([first, failed]);

    expect(report.decision).toBe("NO-GO");
    expect(report.score).toBe("1/10");
    expect(report.exitCode).toBe(1);
    expect(report.firstFailure).toEqual(expect.objectContaining({ probeId: "probe-2", category: "navigation" }));
    expect(report.humanSummary).toContain("probe-2 correct-final-state/navigation");
  });

  test("fails closed with matching machine and human attribution when attempted passes are incomplete", async () => {
    const first = await evidenceFor(BLIND_COHORT_MANIFEST.tasks[0]!);
    const report = buildCohortReport([first]);

    expect(report).toEqual(expect.objectContaining({ decision: "NO-GO", score: "1/10", attempted: 1 }));
    expect(report.firstFailure).toEqual(expect.objectContaining({
      probeId: "probe-2",
      metric: "correct-final-state",
      category: "test-environment-flake",
    }));
    expect(report.humanSummary).toContain("1/10 NO-GO");
    expect(report.humanSummary).toContain("probe-2 correct-final-state/test-environment-flake");
  });

  test("rejects replayed, reordered, skipped, or mixed-revision records", async () => {
    const one = await evidenceFor(BLIND_COHORT_MANIFEST.tasks[0]!);
    const two = await evidenceFor(BLIND_COHORT_MANIFEST.tasks[1]!);
    await expect(async () => buildCohortReport([two, one])).toThrow(BlindEvidenceError);
    await expect(async () => buildCohortReport([one, one])).toThrow(BlindEvidenceError);
    await expect(async () => buildCohortReport([{ ...one, deployedSha: "b".repeat(40) }, two])).toThrow(BlindEvidenceError);
  });

  test("rejects tampered stored records before producing any report", async () => {
    const record = await evidenceFor(BLIND_COHORT_MANIFEST.tasks[0]!);
    const cases: BlindProbeEvidence[] = [
      { ...record, schemaVersion: undefined as unknown as typeof BLIND_EVIDENCE_SCHEMA_VERSION },
      { ...record, browserVersion: "151.0.0.0" },
      { ...record, taskInstruction: "Different task" },
      { ...record, transcript: [] },
      { ...record, metrics: record.metrics.slice(1) },
      { ...record, passed: false },
      { ...record, firstFailure: { metric: "correct-final-state", category: "missing-state", reason: "invented" } },
    ];
    for (const candidate of cases) {
      await expect(async () => buildCohortReport([candidate])).toThrow(BlindEvidenceError);
    }
  });

  test("selects the earliest probe and stable metric precedence across multiple failures", async () => {
    const firstTask = BLIND_COHORT_MANIFEST.tasks[0]!;
    const secondTask = BLIND_COHORT_MANIFEST.tasks[1]!;
    const first = await captureAndScoreProbeEvidence(input(firstTask, {
      attempts: [{ status: "passed", humanHintUsed: true }],
    }, {
      ...observation(firstTask),
      finalUi: { ...observation(firstTask).finalUi, route: "study", failureCategory: "navigation" },
      completionBasis: "wrong-reason",
    }));
    const second = await captureAndScoreProbeEvidence(input(secondTask, {}, {
      ...observation(secondTask),
      finalUi: { ...observation(secondTask).finalUi, ambiguous: true, failureCategory: "ui-discoverability" },
    }));

    const report = buildCohortReport([first, second]);
    expect(first.metrics.filter((metric) => !metric.passed).map((metric) => metric.name)).toEqual([
      "correct-final-state", "no-human-hint",
    ]);
    expect(report.firstFailure).toEqual(expect.objectContaining({
      probeId: "probe-1",
      metric: "correct-final-state",
      category: "navigation",
    }));
    expect(report.humanSummary).toContain("probe-1 correct-final-state/navigation");
  });
});
