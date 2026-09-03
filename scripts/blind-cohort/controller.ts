import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { BLIND_COHORT_MANIFEST, PRODUCTION_URL, validateBlindCohortManifest } from "./contract";
import {
  buildCohortReport,
  captureAndScoreProbeEvidence,
  sanitizeBlindEvidence,
  type BlindCohortReport,
  type BlindProbeEvidence,
  type TrustedProbeObserver,
} from "./evidence";
import {
  PlaywrightProbeBrowser,
  ResponsesProbeAgent,
  ResponsesTrustedObserver,
  createLiveTranscript,
  type ObservableProbeBrowser,
} from "./live-adapters";
import {
  assessBlindCohortPreflight,
  type BlindCohortPreflightEvidence,
  type BlindCohortPreflightResult,
} from "./preflight";
import { REQUIRED_BROWSER_VERSION, runBlindCohort, type ProbeAgentContext } from "./runner";

const repositoryRoot = resolve(import.meta.dir, "../..");
const defaultArtifactDirectory = join(repositoryRoot, ".artifacts", "blind-cohort", "cohort-one");

export interface BlindCohortControllerOptions {
  readonly preflight: unknown;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly artifactDirectory: string;
  readonly browserExecutablePath?: string;
  readonly signal?: AbortSignal;
  readonly writeArtifact?: (name: string, value: string) => Promise<void>;
  readonly createBrowser?: (options: Parameters<typeof PlaywrightProbeBrowser.create>[0]) => Promise<ObservableProbeBrowser>;
  readonly createAgent?: (apiKey: string, model: string) => ProbeAgentContext;
  readonly createObserver?: (
    apiKey: string,
    model: string,
    browser: ObservableProbeBrowser,
    signal?: AbortSignal,
  ) => TrustedProbeObserver;
}

export interface BlindCohortControllerResult {
  readonly exitCode: 0 | 1;
  readonly preflight: BlindCohortPreflightResult;
  readonly report: BlindCohortReport | null;
}

/** Runnable orchestration boundary. No browser or model starts unless exact-SHA qualification passes. */
export async function runBlindCohortController(options: BlindCohortControllerOptions): Promise<BlindCohortControllerResult> {
  validateBlindCohortManifest(BLIND_COHORT_MANIFEST);
  const preflight = assessBlindCohortPreflight(options.preflight);
  const writeArtifact = options.writeArtifact ?? (async (name, value) => {
    await mkdir(options.artifactDirectory, { recursive: true });
    await writeFile(join(options.artifactDirectory, name), value, "utf8");
  });
  if (preflight.status !== "passed" || preflight.sha === null) {
    await writeArtifact("preflight-no-go.json", safeJson({ schemaVersion: 1, decision: "NO-GO", preflight }));
    return { exitCode: 1, preflight, report: null };
  }
  if (options.apiKey.trim() === "" || options.model.trim() === "") {
    const failure = { ...preflight, status: "failed" as const, sha: null, failure: "model API configuration is missing" };
    await writeArtifact("preflight-no-go.json", safeJson({ schemaVersion: 1, decision: "NO-GO", preflight: failure }));
    return { exitCode: 1, preflight: failure, report: null };
  }

  const active = new Map<string, {
    browser: ObservableProbeBrowser | null;
    transcript: ReturnType<typeof createLiveTranscript>;
    runId: string;
    startedAt: string;
  }>();
  const createBrowser = options.createBrowser ?? PlaywrightProbeBrowser.create;
  const createAgent = options.createAgent ?? ((apiKey, model) => new ResponsesProbeAgent(apiKey, model));
  const createObserver = options.createObserver ?? ((apiKey, model, browser, signal) =>
    new ResponsesTrustedObserver(apiKey, model, browser, signal));

  const run = await runBlindCohort<BlindProbeEvidence>({
    manifest: BLIND_COHORT_MANIFEST,
    concurrency: 1,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    browserFactory: {
      create: async ({ probeId, viewport }) => {
        const transcript = createLiveTranscript();
        const current = {
          browser: null as ObservableProbeBrowser | null,
          transcript,
          runId: `run-${randomUUID()}`,
          startedAt: new Date().toISOString(),
        };
        active.set(probeId, current);
        transcript.append("visible", "browser-create-started", { browserVersion: REQUIRED_BROWSER_VERSION });
        try {
          const browser = await createBrowser({
            viewport,
            transcript,
            executablePath: options.browserExecutablePath,
          });
          current.browser = browser;
          transcript.append("visible", "browser-created", { browserVersion: browser.browserVersion });
          return browser;
        } catch (error) {
          transcript.append("visible", "browser-create-failed", { reason: errorMessage(error) });
          throw error;
        }
      },
    },
    agentFactory: { create: async () => createAgent(options.apiKey, options.model) },
    finalizeEvidence: async (input) => {
      const current = active.get(input.task.id);
      if (current === undefined) throw new Error("Trusted browser state is unavailable for evidence capture.");
      return await captureAndScoreProbeEvidence({
        ...input,
        evidenceOrigin: "live",
        deployedSha: preflight.sha!,
        deployedUrl: preflight.deployedUrl,
        runId: current.runId,
        browserVersion: current.browser?.browserVersion ?? "unavailable",
        startedAt: current.startedAt,
        finishedAt: new Date().toISOString(),
        transcript: current.transcript.events,
        observer: input.agentContextId === null || current.browser === null
          ? unavailablePreAgentObserver(input.task)
          : createObserver(options.apiKey, options.model, current.browser, options.signal),
        secrets: current.browser === null
          ? [options.apiKey]
          : [options.apiKey, current.browser.userDataDirectory],
      });
    },
  });

  const evidence = run.records.flatMap((record) => record.evidence === null ? [] : [record.evidence]);
  if (run.status !== "passed" && run.firstFailure?.evidence?.passed !== false) {
    await writeArtifact("cohort-no-go.json", safeJson({
      schemaVersion: 1,
      cohortId: run.cohortId,
      decision: "NO-GO",
      deployedSha: preflight.sha,
      firstFailure: {
        probeId: run.firstFailure?.probeId ?? "not-started",
        status: run.firstFailure?.status ?? "cancelled",
        reason: run.firstFailure?.reason ?? "The cohort ended without complete evidence.",
      },
      probes: evidence,
    }));
    return { exitCode: 1, preflight, report: null };
  }
  const report = buildCohortReport(evidence, "live");
  await writeArtifact("report.json", safeJson(report));
  await writeArtifact("summary.txt", String(sanitizeBlindEvidence(report.humanSummary)) + "\n");
  return { exitCode: report.exitCode, preflight, report };
}

export async function qualifyMergedRevision(options: {
  readonly requestedSha: string;
  readonly githubToken?: string;
}): Promise<BlindCohortPreflightEvidence> {
  const requestedSha = options.requestedSha;
  await checkedCommand(["git", "fetch", "origin", "main"]);
  const repositoryHead = await commandOutput(["git", "rev-parse", "HEAD"]);
  const fetchedMainHead = await commandOutput(["git", "rev-parse", "origin/main"]);
  if (repositoryHead !== requestedSha || fetchedMainHead !== requestedSha) {
    throw new Error("Repository HEAD, fetched main, and requested SHA must match before qualification.");
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "anki-web-mcp-blind-cohort",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (options.githubToken) headers.Authorization = `Bearer ${options.githubToken}`;
  const github = async <T>(path: string): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/portpowered/anki-web-mcp/${path}`, { headers });
    if (!response.ok) throw new Error(`GitHub API ${path} failed with HTTP ${response.status}.`);
    return await response.json() as T;
  };
  const branch = await github<{ protected?: boolean }>("branches/main");
  if (branch.protected !== true) throw new Error("Main is not reported as protected.");
  const workflow = await github<{ workflow_runs?: Array<{ head_sha?: string; status?: string; conclusion?: string; event?: string }> }>(
    `actions/workflows/ci.yml/runs?branch=main&event=push&per_page=20`,
  );
  const ci = workflow.workflow_runs?.find((run) => run.head_sha === requestedSha);
  if (ci?.status !== "completed" || ci.conclusion !== "success") throw new Error("Protected-main CI is not successful on the requested SHA.");
  const deployments = await github<Array<{ id?: number; sha?: string }>>("deployments?environment=github-pages&per_page=20");
  const deployment = deployments.find((item) => item.sha === requestedSha);
  if (typeof deployment?.id !== "number") throw new Error("Pages deployment source is unavailable for the requested SHA.");
  const statuses = await github<Array<{ state?: string }>>(`deployments/${deployment.id}/statuses?per_page=1`);
  if (statuses[0]?.state !== "success") throw new Error("Pages deployment is not successful.");
  const pulls = await github<Array<{ head?: { ref?: string } }>>("pulls?state=open&per_page=100");
  const unresolvedReleaseCandidatePrs = pulls.filter((pull) =>
    pull.head?.ref === "webmcp-release-candidate-blind-harness-and-cohort-one").length;

  const [root, study, revisionResponse] = await Promise.all([
    fetch(PRODUCTION_URL),
    fetch(new URL("study/", PRODUCTION_URL)),
    fetch(new URL("deployment-revision.json", PRODUCTION_URL), { cache: "no-store" }),
  ]);
  const [rootBody, studyBody, revisionValue] = await Promise.all([
    root.text(), study.text(), revisionResponse.json() as Promise<unknown>,
  ]);
  const observedDeploymentSha = isRecord(revisionValue) && typeof revisionValue.revision === "string"
    ? revisionValue.revision
    : "";
  if (!root.ok || !rootBody.includes('data-deployment-route="deck-home"') ||
      !study.ok || !studyBody.includes('data-deployment-route="study"') ||
      !revisionResponse.ok || observedDeploymentSha !== requestedSha) {
    throw new Error("Observed production routes or deployment revision do not match the requested SHA.");
  }

  // This command contains the ordinary release checks and exactly one fresh
  // complete production eight-tool aggregate. Its artifacts remain ignored.
  await checkedCommand(["bun", "run", "webmcp:evidence"]);
  const aggregate = JSON.parse(await readFile(join(repositoryRoot, ".artifacts/webmcp-evidence/report.json"), "utf8")) as unknown;
  if (!isRecord(aggregate) || aggregate.overall !== "supported") throw new Error("The fresh eight-tool aggregate did not support the revision.");
  const browserVersion = nestedString(aggregate, "browser", "productionObserved", "actualVersion");
  const deploymentSha = nestedString(aggregate, "project", "deploymentRevision", "deployedCommit");
  if (browserVersion !== REQUIRED_BROWSER_VERSION || deploymentSha !== requestedSha) {
    throw new Error("The eight-tool aggregate used a different browser or deployed SHA.");
  }
  await checkedCommand(["git", "fetch", "origin", "main"]);
  const finalMainHead = await commandOutput(["git", "rev-parse", "origin/main"]);
  const finalRevisionResponse = await fetch(new URL("deployment-revision.json", PRODUCTION_URL), { cache: "no-store" });
  const finalRevisionValue = await finalRevisionResponse.json() as unknown;
  if (finalMainHead !== requestedSha || !finalRevisionResponse.ok ||
      !isRecord(finalRevisionValue) || finalRevisionValue.revision !== requestedSha) {
    throw new Error("Main or the observed deployment changed during qualification.");
  }

  return {
    requestedSha,
    repositoryHead,
    fetchedMainHead,
    protectedCi: { headSha: requestedSha, status: "completed", conclusion: "success" },
    pagesDeployment: { sourceSha: requestedSha, status: "success" },
    routes: {
      root: { status: root.status, marker: "deck-home" },
      study: { status: study.status, marker: "study" },
    },
    observedDeploymentSha,
    unresolvedReleaseCandidatePrs,
    ordinaryReleaseChecks: { sha: requestedSha, status: "passed" },
    eightToolAggregate: {
      sha: requestedSha,
      status: "passed",
      browserVersion: REQUIRED_BROWSER_VERSION,
      completeToolCount: 8,
    },
  };
}

async function main(): Promise<void> {
  const requestedSha = process.env.BLIND_COHORT_SHA ?? "";
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const model = process.env.BLIND_COHORT_MODEL ?? "";
  const artifactDirectory = resolve(process.env.BLIND_COHORT_ARTIFACT_DIR ?? defaultArtifactDirectory);
  try {
    if (apiKey.trim() === "" || model.trim() === "") {
      throw new Error("OPENAI_API_KEY and BLIND_COHORT_MODEL are required before qualification.");
    }
    const preflight = await qualifyMergedRevision({ requestedSha, githubToken: process.env.GITHUB_TOKEN });
    const result = await runBlindCohortController({
      preflight, apiKey, model, artifactDirectory,
      browserExecutablePath: process.env.BLIND_COHORT_CHROME_PATH,
      timeoutMs: Number(process.env.BLIND_COHORT_TIMEOUT_MS ?? "900000"),
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(join(artifactDirectory, "preflight-no-go.json"), safeJson({
      schemaVersion: 1, decision: "NO-GO", failure: error instanceof Error ? error.message : String(error),
    }), "utf8");
    process.exitCode = 1;
  }
}

async function checkedCommand(argv: string[]): Promise<void> {
  const processResult = Bun.spawn(argv, { cwd: repositoryRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await processResult.exited !== 0) throw new Error(`${argv.join(" ")} failed.`);
}

async function commandOutput(argv: string[]): Promise<string> {
  const processResult = Bun.spawn(argv, { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(processResult.stdout).text();
  if (await processResult.exited !== 0) throw new Error(`${argv.join(" ")} failed.`);
  return output.trim();
}

function safeJson(value: unknown): string { return JSON.stringify(sanitizeBlindEvidence(value), null, 2) + "\n"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nestedString(value: Record<string, unknown>, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) current = isRecord(current) ? current[key] : null;
  return typeof current === "string" ? current : null;
}

function unavailablePreAgentObserver(task: BlindCohortManifestTask): TrustedProbeObserver {
  return {
    capture: async () => ({
      finalUi: {
        trusted: true,
        route: task.expected.finalUi.route,
        visibleState: ["agent was not started"],
        ambiguous: true,
        failureCategory: "test-environment-flake",
      },
      durableState: {
        trusted: true,
        effects: ["agent was not started"],
        mutatedDecks: [],
        ambiguous: true,
        failureCategory: "test-environment-flake",
      },
      judgments: task.judgments.map((dimension) => ({
        dimension,
        status: "fail" as const,
        reason: "The isolation boundary failed before agent execution.",
      })),
      completionBasis: "ambiguous",
    }),
  };
}

type BlindCohortManifestTask = (typeof BLIND_COHORT_MANIFEST.tasks)[number];

if (import.meta.main) await main();
