import {
  BLIND_COHORT_MANIFEST,
  launchRestrictedProbe,
  validateBlindCohortManifest,
  type BlindCohortManifest,
  type BlindProbeTask,
  type PublicWebMcpPort,
  type RestrictedProbeInput,
  type SemanticBrowserPort,
} from "./contract";

export const REQUIRED_BROWSER_VERSION = "152.0.7977.65" as const;

export type ProbeTerminalStatus =
  | "passed"
  | "failed"
  | "timeout"
  | "agent-failure"
  | "browser-failure"
  | "isolation-failure"
  | "cleanup-failure"
  | "cancelled"
  | "evidence-failure";

export interface StructuredProbeError {
  readonly code: string;
  readonly message: string;
  readonly recoverable: true;
}

export interface ProbeAttemptResult {
  readonly status: "passed" | "failed" | "browser-failure";
  readonly structuredError?: StructuredProbeError;
  readonly requestSelfRecovery?: boolean;
  readonly humanHintUsed?: boolean;
  readonly detail?: string;
}

export interface ProbeAgentContext {
  readonly contextId: string;
  run(
    input: RestrictedProbeInput,
    control: { readonly attempt: 1 | 2; readonly signal: AbortSignal },
  ): Promise<ProbeAttemptResult>;
  close(): Promise<void>;
}

export interface ProbeBrowserContext {
  readonly profileId: string;
  /** Trusted controller-only path. It is never copied into records or agent input. */
  readonly userDataDirectory: string;
  readonly browserVersion: string;
  readonly semanticBrowser: SemanticBrowserPort;
  readonly publicWebMcp: PublicWebMcpPort;
  verifyIndexedDbEmpty(publicUrl: string): Promise<boolean>;
  close(): Promise<void>;
  removeProfile(): Promise<void>;
}

export interface ProbeEvidenceInput {
  readonly task: BlindProbeTask;
  readonly agentContextId: string | null;
  readonly browserProfileId: string;
  readonly attempts: readonly ProbeAttemptResult[];
  readonly status: Exclude<ProbeTerminalStatus, "cleanup-failure" | "evidence-failure">;
  readonly reason: string | null;
}

export interface ProbeRunRecord<Evidence> {
  readonly probeId: BlindProbeTask["id"];
  readonly agentContextId: string | null;
  readonly browserProfileId: string | null;
  readonly status: ProbeTerminalStatus;
  readonly reason: string | null;
  readonly retryCount: 0 | 1;
  readonly evidence: Evidence | null;
}

export interface FinalizedProbeEvidence {
  readonly passed: boolean;
  readonly firstFailure: { readonly reason: string } | null;
}

export interface BlindCohortRun<Evidence> {
  readonly cohortId: BlindCohortManifest["cohortId"];
  readonly status: "passed" | "failed";
  readonly records: readonly ProbeRunRecord<Evidence>[];
  readonly firstFailure: ProbeRunRecord<Evidence> | null;
}

export interface BlindCohortRunnerOptions<Evidence extends FinalizedProbeEvidence> {
  readonly manifest?: unknown;
  readonly concurrency: 1;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly browserFactory: {
    create(options: {
      readonly probeId: BlindProbeTask["id"];
      readonly browserVersion: typeof REQUIRED_BROWSER_VERSION;
      readonly viewport: BlindProbeTask["viewport"];
    }): Promise<ProbeBrowserContext>;
  };
  readonly agentFactory: {
    create(options: { readonly probeId: BlindProbeTask["id"] }): Promise<ProbeAgentContext>;
  };
  readonly finalizeEvidence: (input: ProbeEvidenceInput) => Promise<Evidence>;
}

export class BlindRunnerError extends Error {
  constructor(readonly code: "invalid-concurrency" | "invalid-timeout", message: string) {
    super(message);
    this.name = "BlindRunnerError";
  }
}

/** Runs the immutable cohort contract serially and stops after its first terminal failure. */
export async function runBlindCohort<Evidence extends FinalizedProbeEvidence>(
  options: BlindCohortRunnerOptions<Evidence>,
): Promise<BlindCohortRun<Evidence>> {
  if (options.concurrency !== 1) {
    throw new BlindRunnerError("invalid-concurrency", "Blind probes require concurrency exactly equal to one.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new BlindRunnerError("invalid-timeout", "Probe timeout must be a positive finite number.");
  }

  const manifest = validateBlindCohortManifest(options.manifest ?? BLIND_COHORT_MANIFEST);
  const usedAgentIds = new Set<string>();
  const usedProfileIds = new Set<string>();
  const usedProfileDirectories = new Set<string>();
  const records: ProbeRunRecord<Evidence>[] = [];

  for (const task of manifest.tasks) {
    if (options.signal?.aborted) break;
    const record = await runOneProbe(
      options,
      manifest,
      task,
      usedAgentIds,
      usedProfileIds,
      usedProfileDirectories,
    );
    records.push(record);
    if (record.status !== "passed") break;
  }

  const firstFailure = records.find((record) => record.status !== "passed") ?? null;
  return Object.freeze({
    cohortId: manifest.cohortId,
    status: firstFailure === null && records.length === manifest.tasks.length ? "passed" : "failed",
    records: Object.freeze(records),
    firstFailure,
  });
}

async function runOneProbe<Evidence extends FinalizedProbeEvidence>(
  options: BlindCohortRunnerOptions<Evidence>,
  manifest: BlindCohortManifest,
  task: BlindProbeTask,
  usedAgentIds: Set<string>,
  usedProfileIds: Set<string>,
  usedProfileDirectories: Set<string>,
): Promise<ProbeRunRecord<Evidence>> {
  let browser: ProbeBrowserContext | null = null;
  let agent: ProbeAgentContext | null = null;
  let evidence: Evidence | null = null;
  const attempts: ProbeAttemptResult[] = [];
  let status: ProbeTerminalStatus = "agent-failure";
  let reason: string | null = null;

  try {
    browser = await options.browserFactory.create({
      probeId: task.id,
      browserVersion: REQUIRED_BROWSER_VERSION,
      viewport: task.viewport,
    });
    if (
      browser.browserVersion !== REQUIRED_BROWSER_VERSION ||
      !claimUniqueIdentity(browser.profileId, usedProfileIds) ||
      !claimUniqueIdentity(browser.userDataDirectory, usedProfileDirectories)
    ) {
      status = "isolation-failure";
      reason = browser.browserVersion !== REQUIRED_BROWSER_VERSION
        ? `Browser version must be ${REQUIRED_BROWSER_VERSION}.`
        : "Browser profile identity or user-data directory was empty or reused.";
    } else if (!await browser.verifyIndexedDbEmpty(task.publicUrl)) {
      status = "isolation-failure";
      reason = "IndexedDB was not empty before agent launch.";
    } else if (options.signal?.aborted) {
      status = "cancelled";
      reason = "Cohort was cancelled before agent launch.";
    } else {
      agent = await options.agentFactory.create({ probeId: task.id });
      if (!claimUniqueIdentity(agent.contextId, usedAgentIds)) {
        status = "isolation-failure";
        reason = "Agent context identity was empty or reused.";
      } else {
        ({ status, reason } = await runAttempts(options, manifest, task, browser, agent, attempts));
      }
    }
  } catch (error) {
    status = options.signal?.aborted ? "cancelled" : browser === null ? "browser-failure" : "agent-failure";
    reason = errorMessage(error);
  }

  try {
    evidence = await options.finalizeEvidence({
      task,
      agentContextId: agent?.contextId ?? null,
      browserProfileId: browser?.profileId ?? "unavailable",
      attempts: Object.freeze([...attempts]),
      status: status as ProbeEvidenceInput["status"],
      reason,
    });
    if (status === "passed" && !evidence.passed) {
      status = "failed";
      reason = evidence.firstFailure?.reason ?? "Trusted evidence scoring rejected the probe outcome.";
    }
  } catch (error) {
    status = "evidence-failure";
    reason = errorMessage(error);
  }

  const cleanupErrors: string[] = [];
  if (agent !== null) await captureCleanup(() => agent!.close(), cleanupErrors);
  if (browser !== null) {
    await captureCleanup(() => browser!.close(), cleanupErrors);
    await captureCleanup(() => browser!.removeProfile(), cleanupErrors);
  }
  if (cleanupErrors.length > 0) {
    status = "cleanup-failure";
    reason = cleanupErrors.join("; ");
  }

  return Object.freeze({
    probeId: task.id,
    agentContextId: agent?.contextId ?? null,
    browserProfileId: browser?.profileId ?? null,
    status,
    reason,
    retryCount: attempts.length === 2 ? 1 : 0,
    evidence,
  });
}

async function runAttempts<Evidence extends FinalizedProbeEvidence>(
  options: BlindCohortRunnerOptions<Evidence>,
  manifest: BlindCohortManifest,
  task: BlindProbeTask,
  browser: ProbeBrowserContext,
  agent: ProbeAgentContext,
  attempts: ProbeAttemptResult[],
): Promise<{ status: ProbeTerminalStatus; reason: string | null }> {
  for (const attempt of [1, 2] as const) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    let result: ProbeAttemptResult;
    try {
      result = await withTimeout(
        launchRestrictedProbe({
          manifest,
          probeNumber: task.number,
          semanticBrowser: browser.semanticBrowser,
          publicWebMcp: browser.publicWebMcp,
          agentFactory: { start: (input) => agent.run(input, { attempt, signal: controller.signal }) },
        }),
        options.timeoutMs,
        controller,
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) return { status: "cancelled", reason: errorMessage(error) };
      if (error instanceof ProbeTimeoutError) return { status: "timeout", reason: error.message };
      return { status: "agent-failure", reason: errorMessage(error) };
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
    }

    attempts.push(Object.freeze({ ...result }));
    if (result.humanHintUsed) return { status: "failed", reason: "Human assistance is forbidden." };
    if (result.status === "browser-failure") return { status: "browser-failure", reason: result.detail ?? null };
    if (result.status === "passed") {
      if (result.requestSelfRecovery || result.structuredError !== undefined) {
        return { status: "failed", reason: "A passing attempt cannot also claim recovery or a structured error." };
      }
      return { status: "passed", reason: null };
    }

    if (!result.requestSelfRecovery) return { status: "failed", reason: result.detail ?? "Agent reported failure." };
    if (!isClearStructuredError(result.structuredError)) {
      return { status: "failed", reason: "Self-recovery requires a clear structured error." };
    }
    if (attempt === 2) return { status: "failed", reason: "A second self-recovery retry is forbidden." };
  }
  return { status: "failed", reason: "Probe exhausted its permitted attempts." };
}

function claimUniqueIdentity(identity: string, used: Set<string>): boolean {
  if (identity.trim() === "" || used.has(identity)) return false;
  used.add(identity);
  return true;
}

function isClearStructuredError(error: StructuredProbeError | undefined): error is StructuredProbeError {
  return error !== undefined && error.recoverable === true && error.code.trim() !== "" && error.message.trim() !== "";
}

async function captureCleanup(operation: () => Promise<void>, errors: string[]): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(errorMessage(error));
  }
}

class ProbeTimeoutError extends Error {}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  externalSignal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new ProbeTimeoutError(`Probe exceeded its ${timeoutMs}ms timeout.`));
      reject(controller.signal.reason);
    }, timeoutMs);
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    if (externalSignal === undefined) return;
    abortListener = () => reject(externalSignal.reason ?? new Error("Cohort cancelled."));
    if (externalSignal.aborted) abortListener();
    else externalSignal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([operation, timeout, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) externalSignal?.removeEventListener("abort", abortListener);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
