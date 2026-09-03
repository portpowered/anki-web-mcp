import { isDeepStrictEqual } from "node:util";

import type { BlindProbeTask, JudgmentDimension, SemanticRoute } from "./contract";
import type { ProbeAttemptResult, ProbeEvidenceInput } from "./runner";

export const BLIND_EVIDENCE_SCHEMA_VERSION = "webmcp-blind-evidence/v1" as const;

export const FAILURE_CATEGORIES = [
  "tool-discovery",
  "ambiguous-description-schema",
  "missing-state",
  "ui-discoverability",
  "navigation",
  "stale-state-race",
  "import-compatibility",
  "scheduler-state-corruption",
  "responsive-layout",
  "test-environment-flake",
] as const;

export type FailureCategory = typeof FAILURE_CATEGORIES[number];
export type ProbeMetricName =
  | "correct-final-state"
  | "no-human-hint"
  | "safe-destructive-target"
  | "bounded-structured-recovery"
  | "unambiguous-outcome";

export interface TranscriptEvent {
  readonly sequence: number;
  readonly at: string;
  readonly channel: "visible" | "webmcp";
  readonly action: string;
  readonly result: unknown;
}

export interface SemanticUiObservation {
  readonly trusted: true;
  readonly route: SemanticRoute;
  readonly visibleState: readonly string[];
  readonly ambiguous: boolean;
  readonly failureCategory: FailureCategory | null;
}

export interface DurableStateObservation {
  readonly trusted: true;
  readonly effects: readonly string[];
  readonly mutatedDecks: readonly string[];
  readonly ambiguous: boolean;
  readonly failureCategory: FailureCategory | null;
}

export interface ProbeJudgment {
  readonly dimension: JudgmentDimension;
  readonly status: "pass" | "fail";
  readonly reason: string;
}

export interface TrustedObservation {
  readonly finalUi: SemanticUiObservation;
  readonly durableState: DurableStateObservation;
  readonly judgments: readonly ProbeJudgment[];
  readonly completionBasis: "expected-effects" | "agent-claim" | "wrong-reason" | "ambiguous";
}

export interface TrustedProbeObserver {
  /** Runs after agent work while the browser and IndexedDB are still available. */
  capture(task: BlindProbeTask): Promise<TrustedObservation>;
}

export interface ProbeMetric {
  readonly name: ProbeMetricName;
  readonly passed: boolean;
  readonly reason: string;
  readonly failureCategory: FailureCategory | null;
}

export interface BlindProbeEvidence {
  readonly schemaVersion: typeof BLIND_EVIDENCE_SCHEMA_VERSION;
  readonly probeId: BlindProbeTask["id"];
  readonly taskNumber: BlindProbeTask["number"];
  readonly taskInstruction: string;
  readonly fixtureId: string | null;
  readonly deployedSha: string;
  readonly deployedUrl: string;
  readonly runId: string;
  readonly agentContextId: string;
  readonly browserProfileId: string;
  readonly browserVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly transcript: readonly TranscriptEvent[];
  readonly structuredErrors: readonly { readonly code: string; readonly message: string }[];
  readonly retryCount: 0 | 1;
  readonly retryReason: string | null;
  readonly terminalStatus: ProbeEvidenceInput["status"];
  readonly terminalReason: string | null;
  readonly finalUi: SemanticUiObservation;
  readonly durableState: DurableStateObservation;
  readonly judgments: readonly ProbeJudgment[];
  readonly completionBasis: TrustedObservation["completionBasis"];
  readonly metrics: readonly ProbeMetric[];
  readonly passed: boolean;
  readonly firstFailure: { readonly metric: ProbeMetricName; readonly category: FailureCategory; readonly reason: string } | null;
}

export interface CaptureProbeEvidenceInput extends ProbeEvidenceInput {
  readonly deployedSha: string;
  readonly deployedUrl: string;
  readonly runId: string;
  readonly browserVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly transcript: readonly TranscriptEvent[];
  readonly observer: TrustedProbeObserver;
  readonly secrets?: readonly string[];
}

export class BlindEvidenceError extends Error {
  constructor(
    readonly code: "invalid-evidence" | "unsafe-evidence",
    message: string,
  ) {
    super(message);
    this.name = "BlindEvidenceError";
  }
}

/** Capture trusted post-agent state, redact it, validate it, then score it fail-closed. */
export async function captureAndScoreProbeEvidence(
  input: CaptureProbeEvidenceInput,
): Promise<BlindProbeEvidence> {
  const observation = await input.observer.capture(input.task);
  const retryCount: 0 | 1 = input.attempts.length === 2 ? 1 : 0;
  const candidate: Omit<BlindProbeEvidence, "metrics" | "passed" | "firstFailure"> = {
    schemaVersion: BLIND_EVIDENCE_SCHEMA_VERSION,
    probeId: input.task.id,
    taskNumber: input.task.number,
    taskInstruction: input.task.instruction,
    fixtureId: input.task.fixture?.id ?? null,
    deployedSha: input.deployedSha,
    deployedUrl: input.deployedUrl,
    runId: input.runId,
    agentContextId: input.agentContextId ?? "",
    browserProfileId: input.browserProfileId,
    browserVersion: input.browserVersion,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    transcript: input.transcript,
    structuredErrors: input.attempts.flatMap((attempt) => attempt.structuredError === undefined
      ? []
      : [{ code: attempt.structuredError.code, message: attempt.structuredError.message }]),
    retryCount,
    retryReason: retryReason(input.attempts),
    terminalStatus: input.status,
    terminalReason: input.reason,
    ...observation,
  };
  const sanitized = sanitizeBlindEvidence(candidate, input.secrets) as typeof candidate;
  validateEvidenceCandidate(sanitized, input.task);
  const metrics = scoreMetrics(sanitized, input.task, input.attempts);
  const firstFailedMetric = metrics.find((metric) => !metric.passed) ?? null;
  const evidence: BlindProbeEvidence = {
    ...sanitized,
    metrics,
    passed: firstFailedMetric === null,
    firstFailure: firstFailedMetric === null ? null : {
      metric: firstFailedMetric.name,
      category: firstFailedMetric.failureCategory!,
      reason: firstFailedMetric.reason,
    },
  };
  return deepFreeze(evidence);
}

const metricOrder: readonly ProbeMetricName[] = [
  "correct-final-state",
  "no-human-hint",
  "safe-destructive-target",
  "bounded-structured-recovery",
  "unambiguous-outcome",
];

function scoreMetrics(
  evidence: Omit<BlindProbeEvidence, "metrics" | "passed" | "firstFailure">,
  task: BlindProbeTask,
  attempts: readonly ProbeAttemptResult[],
): readonly ProbeMetric[] {
  const uiMatches = evidence.finalUi.route === task.expected.finalUi.route &&
    task.expected.finalUi.visibleState.every((expected) => evidence.finalUi.visibleState.includes(expected));
  const durableMatches = task.expected.durableState.every((expected) => evidence.durableState.effects.includes(expected));
  const expectedState = evidence.terminalStatus === "passed" && uiMatches && durableMatches &&
    evidence.completionBasis === "expected-effects";
  const humanHint = attempts.some((attempt) => attempt.humanHintUsed === true);
  const allowedDeck = task.expected.destructiveTarget.allowedDeck;
  const wrongTarget = evidence.durableState.mutatedDecks.some((deck) => allowedDeck === null || deck !== allowedDeck);
  const recoveryValid = attempts.length <= 2 && (attempts.length < 2 || (
    attempts[0]?.status === "failed" &&
    attempts[0].requestSelfRecovery === true &&
    isStructured(attempts[0]) &&
    attempts[1]?.requestSelfRecovery !== true &&
    attempts[1]?.structuredError === undefined
  ));
  const unambiguous = !evidence.finalUi.ambiguous && !evidence.durableState.ambiguous &&
    evidence.completionBasis !== "ambiguous" &&
    evidence.judgments.every((judgment) => judgment.status === "pass");

  const byName: Record<ProbeMetricName, ProbeMetric> = {
    "correct-final-state": metric(
      "correct-final-state",
      expectedState,
      expectedState ? "Trusted UI and durable state match the task contract." : "Trusted final UI or durable state does not prove the expected effects.",
      evidence.finalUi.failureCategory ?? evidence.durableState.failureCategory ?? "missing-state",
    ),
    "no-human-hint": metric(
      "no-human-hint",
      !humanHint,
      humanHint ? "Human assistance was used." : "No human hint was used.",
      "ui-discoverability",
    ),
    "safe-destructive-target": metric(
      "safe-destructive-target",
      !wrongTarget,
      wrongTarget ? "A durable mutation affected a forbidden deck." : "No wrong-target destructive mutation was observed.",
      "scheduler-state-corruption",
    ),
    "bounded-structured-recovery": metric(
      "bounded-structured-recovery",
      recoveryValid,
      recoveryValid ? "Recovery use is within the structured single-retry limit." : "Recovery was unstructured, repeated, or otherwise ineligible.",
      "stale-state-race",
    ),
    "unambiguous-outcome": metric(
      "unambiguous-outcome",
      unambiguous,
      unambiguous ? "Tool, schema, state, navigation, and judgments are unambiguous." : "The observed outcome or a required judgment is ambiguous or failed.",
      evidence.finalUi.failureCategory ?? evidence.durableState.failureCategory ?? "ambiguous-description-schema",
    ),
  };
  return Object.freeze(metricOrder.map((name) => Object.freeze(byName[name])));
}

function metric(name: ProbeMetricName, passed: boolean, reason: string, category: FailureCategory): ProbeMetric {
  return { name, passed, reason, failureCategory: passed ? null : category };
}

function isStructured(attempt: ProbeAttemptResult): boolean {
  return attempt.structuredError?.recoverable === true &&
    attempt.structuredError.code.trim() !== "" && attempt.structuredError.message.trim() !== "";
}

function retryReason(attempts: readonly ProbeAttemptResult[]): string | null {
  return attempts.length === 2 ? attempts[0]?.structuredError?.message ?? null : null;
}

function validateEvidenceCandidate(
  evidence: Omit<BlindProbeEvidence, "metrics" | "passed" | "firstFailure">,
  task: BlindProbeTask,
): void {
  const fail = (message: string): never => { throw new BlindEvidenceError("invalid-evidence", message); };
  if (!/^[0-9a-f]{40}$/u.test(evidence.deployedSha)) fail("A full lowercase deployed SHA is required.");
  if (evidence.deployedUrl !== task.publicUrl) fail("Evidence URL must equal the task's public deployed URL.");
  if (evidence.browserVersion.trim() === "") fail("Browser version identity is required.");
  for (const [label, identity] of [["run", evidence.runId], ["agent", evidence.agentContextId], ["profile", evidence.browserProfileId]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identity)) fail(`${label} identity must be non-empty and opaque.`);
  }
  const started = Date.parse(evidence.startedAt);
  const finished = Date.parse(evidence.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) fail("Evidence timestamps are missing or out of order.");
  if (evidence.transcript.length === 0) fail("The ordered visible/tool transcript is required.");
  if (!evidence.transcript.every((event, index) => event.sequence === index + 1 &&
    (event.channel === "visible" || event.channel === "webmcp") &&
    Number.isFinite(Date.parse(event.at)) && event.action.trim() !== "")) {
    fail("Transcript events must be complete, timestamped, and consecutively ordered.");
  }
  if (evidence.finalUi.trusted !== true || evidence.durableState.trusted !== true) fail("UI and durable state must come from the trusted observer.");
  if (evidence.finalUi.route !== "home" && evidence.finalUi.route !== "study") fail("Trusted UI route is malformed.");
  const validCategories = new Set<string>(FAILURE_CATEGORIES);
  if ([evidence.finalUi.failureCategory, evidence.durableState.failureCategory]
    .some((category) => category !== null && !validCategories.has(category))) fail("Evidence contains an unknown failure category.");
  if (evidence.finalUi.visibleState.length === 0 || evidence.durableState.effects.length === 0) fail("Trusted UI and durable observations must be present.");
  if (evidence.retryCount === 1 && evidence.retryReason === null) fail("A retry requires its structured reason.");
  if (evidence.retryCount === 0 && evidence.retryReason !== null) fail("A retry reason without a retry is contradictory.");
  if (evidence.judgments.length !== task.judgments.length || task.judgments.some((dimension) =>
    evidence.judgments.filter((judgment) => judgment.dimension === dimension).length !== 1)) {
    fail("Exactly one functionality, UX, and UI judgment is required.");
  }
  if (evidence.judgments.some((judgment) => judgment.status !== "pass" && judgment.status !== "fail")) fail("A judgment status is malformed.");
  if (evidence.judgments.some((judgment) => judgment.reason.trim() === "")) fail("Every judgment requires a reason.");
  if (evidence.structuredErrors.some((error) => error.code.trim() === "" || error.message.trim() === "")) {
    fail("Structured error evidence is malformed.");
  }
  assertSafeEvidence(evidence);
}

const sensitiveKeys = new Set([
  "originTrial", "originTrialToken", "originTrialMetadata", "authorization", "apiKey", "clientSecret", "password",
  "userDataDirectory", "profilePath", "front", "back", "frontText", "backText", "content", "cardHtml",
]);
const credentialPattern = /(?:bearer\s+[A-Za-z0-9._~+/=-]+|(?:api[_-]?key|password|client[_-]?secret)\s*[:=]\s*\S+)/giu;
const originTrialPattern = /(?:origin[- ]trial(?: token| metadata)?\s*[:=]\s*)\S+/giu;
const localPathPattern = /(?:[A-Za-z]:\\|\/(?:home|Users|tmp)\/)[^\s"']+/gu;

/** Recursively removes unsafe private material while preserving event order and classifications. */
export function sanitizeBlindEvidence(value: unknown, secrets: readonly string[] = []): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    let result = value;
    for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
      result = result.split(secret).join("[redacted-secret]");
    }
    return result
      .replace(credentialPattern, "[redacted-credential]")
      .replace(originTrialPattern, "[redacted-origin-trial]")
      .replace(localPathPattern, "[redacted-local-path]");
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeBlindEvidence(item, secrets));
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    sensitiveKeys.has(key) ? `[redacted-${key}]` : sanitizeBlindEvidence(entry, secrets),
  ]));
}

/** A sink wrapper guarantees only sanitized evidence crosses a console/artifact/report boundary. */
export function sanitizedEvidenceSink(
  write: (safeValue: unknown) => void | Promise<void>,
  secrets: readonly string[] = [],
): (value: unknown) => Promise<void> {
  return async (value) => await write(sanitizeBlindEvidence(value, secrets));
}

function assertSafeEvidence(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (credentialPattern.test(encoded) || originTrialPattern.test(encoded) || localPathPattern.test(encoded)) {
    credentialPattern.lastIndex = 0;
    originTrialPattern.lastIndex = 0;
    localPathPattern.lastIndex = 0;
    throw new BlindEvidenceError("unsafe-evidence", "Evidence still contains unsafe private material after redaction.");
  }
  credentialPattern.lastIndex = 0;
  originTrialPattern.lastIndex = 0;
  localPathPattern.lastIndex = 0;
}

export interface BlindCohortReport {
  readonly cohortId: "release-candidate-cohort-one";
  readonly deployedSha: string;
  readonly decision: "GO" | "NO-GO";
  readonly score: `${number}/10`;
  readonly attempted: number;
  readonly firstFailure: (BlindProbeEvidence["firstFailure"] & { readonly probeId: BlindProbeEvidence["probeId"] }) | null;
  readonly probes: readonly BlindProbeEvidence[];
  readonly humanSummary: string;
}

/** Builds machine and human output from one decision object; partial or malformed cohorts fail closed. */
export function buildCohortReport(records: readonly BlindProbeEvidence[]): BlindCohortReport {
  if (records.length === 0) throw new BlindEvidenceError("invalid-evidence", "At least one attempted probe is required.");
  const ordered = [...records].sort((a, b) => a.taskNumber - b.taskNumber);
  if (!isDeepStrictEqual(records, ordered) || records.some((record, index) => record.taskNumber !== index + 1)) {
    throw new BlindEvidenceError("invalid-evidence", "Probe records must be an unreplayed numeric prefix.");
  }
  const sha = records[0]!.deployedSha;
  if (records.some((record) => record.deployedSha !== sha)) throw new BlindEvidenceError("invalid-evidence", "All probes must target one exact SHA.");
  const passed = records.filter((record) => record.passed).length;
  const firstFailedRecord = records.find((record) => !record.passed) ?? null;
  const go = records.length === 10 && passed === 10 && firstFailedRecord === null;
  const firstFailure = firstFailedRecord !== null
    ? { probeId: firstFailedRecord.probeId, ...firstFailedRecord.firstFailure! }
    : go
      ? null
      : {
          probeId: `probe-${records.length + 1}` as BlindProbeTask["id"],
          metric: "correct-final-state" as const,
          category: "test-environment-flake" as const,
          reason: "The cohort ended without complete evidence for the next required probe.",
        };
  const decision = go ? "GO" : "NO-GO";
  const score = `${passed}/10` as const;
  const humanSummary = firstFailure === null
    ? `Cohort one ${score} ${decision} on ${sha}.`
    : `Cohort one ${score} ${decision} on ${sha}; first failure ${firstFailure.probeId} ${firstFailure.metric}/${firstFailure.category}: ${firstFailure.reason}`;
  return deepFreeze({
    cohortId: "release-candidate-cohort-one",
    deployedSha: sha,
    decision,
    score,
    attempted: records.length,
    firstFailure,
    probes: records,
    humanSummary,
  });
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
