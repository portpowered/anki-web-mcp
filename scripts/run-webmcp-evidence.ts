import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  activeStudyToolNames,
  emptyStudyToolNames,
  homeToolNames,
} from "./webmcp-production-contract";

import { webMcpOrigin } from "../lib/webmcp";

const repositoryRoot = resolve(import.meta.dir, "..");
const evidenceRoot = join(repositoryRoot, ".artifacts", "webmcp-evidence");
const oracleEvidencePath = join(
  repositoryRoot,
  ".artifacts",
  "webmcp-oracle",
  "report.json",
);
const boundaryEvidencePath = join(
  repositoryRoot,
  ".artifacts",
  "webmcp-boundaries",
  "report.json",
);
const staticEvidencePath = join(
  repositoryRoot,
  "test-results",
  "static-smoke",
  "root-webmcp.json",
);
const reportPath = join(evidenceRoot, "report.json");
const decisionRecordPath = join(evidenceRoot, "decision-record.md");
const productionBaseUrl = (
  process.env.WEBMCP_BOUNDARY_BASE_URL ?? `${webMcpOrigin}/anki-web-mcp`
).replace(/\/$/, "");
const productionRootUrl = `${productionBaseUrl}/`;
const productionStudyUrl = `${productionBaseUrl}/study/`;
const allowFailure = process.env.WEBMCP_EVIDENCE_ALLOW_FAILURE === "1";

type JsonRecord = Record<string, unknown>;

type CommandResult = {
  name: string;
  argv: string[];
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMilliseconds: number;
  exitCode: number | null;
  failure: string | null;
};

type ArtifactResult = {
  path: string;
  present: boolean;
  value: unknown;
  error: string | null;
};

type CriterionStatus = "passed" | "failed" | "not-evaluable" | "pending";

type CriterionResult = {
  id: string;
  requirement: string;
  status: CriterionStatus;
  evidence: string[];
  note: string;
};

type WebMcpEvidenceReport = {
  schemaVersion: 1;
  generatedAt: string;
  runtimeOnly: true;
  overall: "supported" | "no-go" | "not-evaluable";
  conclusion: "supported" | "no-go";
  downstream: "supported" | "no-go" | "not-evaluable";
  project: {
    name: "Production Eight-Tool Native WebMCP Acceptance Evidence";
    requiredOrigin: string;
    productionUrls: { root: string; study: string };
    toolScope: string[];
  };
  procedure: {
    command: string;
    oracle: unknown;
    localControls: unknown;
    deployedProduction: unknown;
    crossOriginExperiment: unknown;
    productionRuntimeMode: string;
    productionTestingFlag: string;
    productionPolyfill: string;
  };
  browser: {
    expected: unknown;
    oracleObserved: unknown;
    productionObserved: unknown;
  };
  originTrial: {
    evidenceDate: string;
    oracle: unknown;
    productionRoutes: Array<{
      url: string;
      metaPresent: boolean | null;
      status: string | null;
      feature: string | null;
      origin: string | null;
      expiry: number | null;
      parseError: string | null;
    }>;
  };
  runtimeEvidence: {
    oracle: unknown;
    localStaticControls: unknown;
    production: { root: unknown; study: unknown };
    productionJourneys: {
      home: unknown;
      study: unknown;
      suspensionAndRestore: unknown;
    };
    isolation: unknown;
    lifecycle: {
      localRootReloadVerified: boolean | null;
      localRouteEvidence: unknown;
      deployedRouteEvidence: unknown;
    };
    cancellation: {
      deployedRoot: unknown;
      deployedStudy: unknown;
    };
    consoleAndNetworkFailures: {
      oracle: unknown;
      productionRoot: unknown;
      productionStudy: unknown;
      isolation: unknown;
    };
  };
  gates: {
    quality: {
      passed: boolean;
      commands: string[];
    };
    localControls: { passed: boolean; command: string };
    externalOracle: { passed: boolean; classification: string | null; failureCode: string | null };
    deployedProduction: { passed: boolean; status: string | null; failureCode: string | null };
    isolation: { passed: boolean; status: string | null; failureCode: string | null };
  };
  criteria: CriterionResult[];
  failure: {
    boundary: string | null;
    reproduction: string[];
    impact: string;
  };
  limitations: string[];
  rerunWhen: string[];
  artifacts: {
    oracle: string;
    localStatic: string;
    boundaries: string;
    report: string;
    decisionRecord: string;
  };
  commands: CommandResult[];
  reports: {
    oracle: unknown;
    localStatic: unknown;
    boundaries: unknown;
  };
};

const commandResults: CommandResult[] = [];

await rm(evidenceRoot, { recursive: true, force: true });
await rm(join(repositoryRoot, "test-results", "static-smoke"), {
  recursive: true,
  force: true,
});
await mkdir(evidenceRoot, { recursive: true });

await runCommand("typecheck", ["run", "typecheck"], {}, 120_000);
await runCommand("lint", ["run", "lint"], {}, 120_000);
await runCommand("unit tests", ["run", "test"], {}, 120_000);
await runCommand("static production build", ["run", "build"], {}, 180_000);
await runCommand(
  "local exported-site controls",
  ["run", "test:browser"],
  {},
  180_000,
);
await runCommand(
  "external native WebMCP oracle and disabled-API control",
  ["run", "scripts/run-webmcp-oracle.ts"],
  {
    WEBMCP_ORACLE_EVIDENCE: oracleEvidencePath,
    WEBMCP_ORACLE_ALLOW_FAILURE: "1",
  },
  180_000,
);
await runCommand(
  "exact production routes and isolation boundary",
  ["run", "scripts/run-webmcp-boundaries.ts"],
  {
    WEBMCP_BOUNDARY_EVIDENCE: boundaryEvidencePath,
    WEBMCP_BOUNDARY_ALLOW_FAILURE: "1",
  },
  180_000,
);

const oracleArtifact = await readJsonArtifact(oracleEvidencePath);
const staticArtifact = await readJsonArtifact(staticEvidencePath);
const boundaryArtifact = await readJsonArtifact(boundaryEvidencePath);
const oracle = asRecord(oracleArtifact.value);
const localStatic = asRecord(staticArtifact.value);
const boundaries = asRecord(boundaryArtifact.value);
const oracleOverall = stringAt(oracle, "overall");
const oracleFailureCode = stringAt(oracle, "oracle", "failureCode");
const oraclePassed = oracleOverall === "passed";
const localControlsPassed = commandPassed("local exported-site controls") &&
  staticArtifact.present;
const qualityCommandNames = [
  "typecheck",
  "lint",
  "unit tests",
  "static production build",
];
const qualityPassed = qualityCommandNames.every(commandPassed);
const productionStatus = stringAt(boundaries, "production", "status");
const productionFailureCode = stringAt(
  boundaries,
  "production",
  "failureCode",
);
const lifecycleStatus = stringAt(boundaries, "lifecycle", "status");
const lifecycleFailureCode = stringAt(boundaries, "lifecycle", "failureCode");
const deployedProductionPassed = productionStatus === "passed" &&
  lifecycleStatus === "passed";
const deployedFailureCode = productionFailureCode ?? lifecycleFailureCode;
const isolationStatus = stringAt(boundaries, "isolation", "status");
const isolationFailureCode = stringAt(boundaries, "isolation", "failureCode");
const isolationPassed = isolationStatus === "passed";
const runtimeChecksPassed = oraclePassed &&
  localControlsPassed &&
  deployedProductionPassed &&
  isolationPassed;
const overall: WebMcpEvidenceReport["overall"] = !oraclePassed
  ? "not-evaluable"
  : qualityPassed && runtimeChecksPassed
    ? "supported"
    : "no-go";
const conclusion: WebMcpEvidenceReport["conclusion"] = overall === "supported"
  ? "supported"
  : "no-go";
const downstream: WebMcpEvidenceReport["downstream"] = !oraclePassed
  ? "not-evaluable"
  : overall === "supported"
    ? "supported"
    : "no-go";
const generatedAt = new Date().toISOString();
const productionRoot = recordAt(boundaries, "production", "root");
const productionStudy = recordAt(boundaries, "production", "study");
const oracleScenario = recordAt(oracle, "oracle");
const browser = recordAt(boundaries, "browser");
const expectedBrowser = recordAt(oracle, "procedure", "expectedBrowser");
const localRootReloadVerified = booleanAt(
  localStatic,
  "reloadVerified",
);

const report: WebMcpEvidenceReport = {
  schemaVersion: 1,
  generatedAt,
  runtimeOnly: true,
  overall,
  conclusion,
  downstream,
  project: {
    name: "Production Eight-Tool Native WebMCP Acceptance Evidence",
    requiredOrigin: webMcpOrigin,
    productionUrls: {
      root: productionRootUrl,
      study: productionStudyUrl,
    },
    toolScope: [
      `home: ${homeToolNames.join(", ")}`,
      `study with an active card: ${activeStudyToolNames.join(", ")}`,
      `study without an active card: ${emptyStudyToolNames.join(", ")}`,
    ],
  },
  procedure: {
    command: "bun run webmcp:evidence",
    oracle: pathAt(oracle, "procedure"),
    localControls: {
      command: "bun run test:browser",
      runtimeMode: "ordinary Chromium static-export control; page-local presentation doubles are labeled non-native",
      evidencePath: staticEvidencePath,
    },
    deployedProduction: pathAt(boundaries, "procedure"),
    crossOriginExperiment: pathAt(
      boundaries,
      "procedure",
      "crossOriginExperiment",
    ),
    productionRuntimeMode: "exact GitHub Pages URLs in the pinned browser; runtime document.modelContext calls only",
    productionTestingFlag: stringAt(
      boundaries,
      "procedure",
      "productionWebMcpTestingFlag",
    ) ?? "not-recorded",
    productionPolyfill: stringAt(
      boundaries,
      "procedure",
      "productionPolyfill",
    ) ?? "not-recorded",
  },
  browser: {
    expected: expectedBrowser,
    oracleObserved: pathAt(oracle, "oracle", "browser"),
    productionObserved: browser,
  },
  originTrial: {
    evidenceDate: generatedAt,
    oracle: pathAt(oracleScenario, "originTrial"),
    productionRoutes: [
      originTrialRoute(productionRootUrl, productionRoot),
      originTrialRoute(productionStudyUrl, productionStudy),
    ],
  },
  runtimeEvidence: {
    oracle: oracleScenario,
    localStaticControls: localStatic,
    production: {
      root: productionRoot,
      study: productionStudy,
    },
    productionJourneys: {
      home: pathAt(boundaries, "homeJourney"),
      study: pathAt(boundaries, "studyJourney"),
      suspensionAndRestore: pathAt(boundaries, "suspensionJourney"),
    },
    isolation: pathAt(boundaries, "isolation"),
    lifecycle: {
      localRootReloadVerified,
      localRouteEvidence: localStatic,
      deployedRouteEvidence: pathAt(boundaries, "lifecycle"),
    },
    cancellation: {
      deployedRoot: pathAt(productionRoot, "cancelledCall"),
      deployedStudy: pathAt(productionStudy, "cancelledCall"),
    },
    consoleAndNetworkFailures: {
      oracle: pathAt(oracleScenario, "diagnostics"),
      productionRoot: pathAt(productionRoot, "browserErrors"),
      productionStudy: pathAt(productionStudy, "browserErrors"),
      isolation: pathAt(boundaries, "isolation", "browserErrors"),
    },
  },
  gates: {
    quality: { passed: qualityPassed, commands: qualityCommandNames },
    localControls: {
      passed: localControlsPassed,
      command: "bun run test:browser",
    },
    externalOracle: {
      passed: oraclePassed,
      classification: oracleOverall,
      failureCode: oracleFailureCode,
    },
    deployedProduction: {
      passed: deployedProductionPassed,
      status: productionStatus,
      failureCode: deployedFailureCode,
    },
    isolation: {
      passed: isolationPassed,
      status: isolationStatus,
      failureCode: isolationFailureCode,
    },
  },
  criteria: [],
  failure: {
    boundary: failureBoundary({
      oraclePassed,
      oracleFailureCode,
      qualityPassed,
      localControlsPassed,
      deployedProductionPassed,
      productionFailureCode: deployedFailureCode,
      isolationPassed,
      isolationFailureCode,
    }),
    reproduction: [
      "bun install --frozen-lockfile",
      "bun run webmcp:evidence",
      "For an expected no-go/not-evaluable capture, set WEBMCP_EVIDENCE_ALLOW_FAILURE=1; this does not convert the result into support.",
    ],
    impact: oraclePassed
      ? "Do not begin production WebMCP work or treat a local flag, mock, extension, polyfill, alternate origin, or proxy host as satisfying the required GitHub Pages native boundary until the failed check is rerun and passes."
      : "The external native oracle is not established, so deployed-native stories are not evaluable; do not infer either support or an application-specific failure from this environment.",
  },
  limitations: [
    "All support claims are exact to the recorded browser/build, operating system, launch mode, token state, production URLs, and evidence date; nearby browser versions and alternate hosts are unproven.",
    "The local static browser control intentionally exercises absent-API and page-local presentation behavior; it is not native WebMCP evidence.",
    "The cross-origin boundary experiment is separately labeled and enables WebMCP only on loopback to test policy behavior; it cannot establish GitHub Pages support.",
    "Origin-trial raw token values, execute functions, Window objects, imported content, card data, persistence, network writes, and production Anki actions are excluded from evidence.",
    "Review-stage CI terminal results, deployed-run attachments, and merge status belong in the PR conversation, never in this generated artifact or a source commit.",
  ],
  rerunWhen: [
    "the pinned browser/build, operating system, launch flags, or WebMCP contract changes",
    "the origin-trial token, its expiry, the required production origin, Pages project path, or Permissions Policy changes",
    "route registration, tool schemas, cancellation handling, visible or durable production state, or static asset hosting changes",
    "the reviewer requests a fresh exact-production run or the PR head changes after the last evidence capture",
  ],
  artifacts: {
    oracle: oracleEvidencePath,
    localStatic: staticEvidencePath,
    boundaries: boundaryEvidencePath,
    report: reportPath,
    decisionRecord: decisionRecordPath,
  },
  commands: commandResults,
  reports: {
    oracle: oracleArtifact.value,
    localStatic: staticArtifact.value,
    boundaries: boundaryArtifact.value,
  },
};

report.criteria = buildCriteria(report);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(decisionRecordPath, renderDecisionRecord(report), "utf8");

console.log(JSON.stringify({
  overall: report.overall,
  conclusion: report.conclusion,
  downstream: report.downstream,
  failureBoundary: report.failure.boundary,
  reports: report.artifacts,
}, null, 2));

if (report.overall !== "supported" && !allowFailure) {
  process.exitCode = 1;
}

function buildCriteria(currentReport: WebMcpEvidenceReport): CriterionResult[] {
  const oracleStatus: CriterionStatus = currentReport.gates.externalOracle.passed
    ? "passed"
    : "failed";
  const downstreamStatus: CriterionStatus = currentReport.gates.externalOracle.passed
    ? currentReport.gates.deployedProduction.passed ? "passed" : "failed"
    : "not-evaluable";
  const isolationStatus: CriterionStatus = currentReport.gates.externalOracle.passed
    ? currentReport.gates.isolation.passed && currentReport.gates.localControls.passed
      ? "passed"
      : "failed"
    : "not-evaluable";
  const qualityStatus: CriterionStatus = currentReport.gates.quality.passed
    ? "passed"
    : "failed";
  return [
    {
      id: "project-001",
      requirement: "External native WebMCP oracle and disabled-API control",
      status: oracleStatus,
      evidence: ["reports.oracle.overall", "reports.oracle.oracle", "reports.oracle.control"],
      note: currentReport.gates.externalOracle.passed
        ? "The maintained external oracle and native-unavailable control agree with the pinned runtime procedure."
        : "The oracle did not establish native behavior; downstream deployed-native claims are not evaluable.",
    },
    {
      id: "project-002",
      requirement: "Exact production root and study native exposure",
      status: downstreamStatus,
      evidence: ["reports.boundaries.production.root", "reports.boundaries.production.study"],
      note: currentReport.gates.deployedProduction.passed
        ? "Both exact production routes passed native discovery and structured execution."
        : currentReport.gates.externalOracle.passed
          ? `The deployed route gate is ${currentReport.gates.deployedProduction.status ?? "unrecorded"}; lifecycle status is ${stringAt(currentReport.runtimeEvidence.lifecycle.deployedRouteEvidence, "status") ?? "unrecorded"}.`
          : "Not evaluated because the external native oracle failed.",
    },
    {
      id: "project-003",
      requirement: "Route-scoped discovery, structured mutation, lifecycle, and cancellation",
      status: downstreamStatus,
      evidence: ["runtimeEvidence.lifecycle", "runtimeEvidence.production", "runtimeEvidence.cancellation"],
      note: currentReport.gates.deployedProduction.passed
        ? "The report retains route tool snapshots, state transitions, duplicate/invalid calls, and aborted-call outcomes."
        : "Route lifecycle and cancellation cannot support a deployed-native claim until production discovery passes.",
    },
    {
      id: "project-004",
      requirement: "Origin, Permissions Policy, registration failure, and graceful-failure isolation",
      status: isolationStatus,
      evidence: ["reports.boundaries.isolation", "reports.localStatic", "originTrial.productionRoutes"],
      note: currentReport.gates.isolation.passed && currentReport.gates.localControls.passed
        ? "The separately labeled local policy experiment and absent-API controls passed their bounded checks."
        : "Boundary or local-control evidence is incomplete or failed.",
    },
    {
      id: "project-005",
      requirement: "Machine-readable evidence and a conservative supported/no-go decision",
      status: "passed",
      evidence: ["artifacts.report", "artifacts.decisionRecord", "criteria"],
      note: "This command writes the report and decision record under ignored artifact paths without raw tokens or CI transcripts.",
    },
    {
      id: "project-006",
      requirement: "Typecheck, tests, build, lint, and static browser controls",
      status: qualityStatus,
      evidence: ["commands", "gates.quality", "gates.localControls"],
      note: qualityStatus === "passed"
        ? "All local quality commands recorded a passing exit status."
        : "At least one local quality command failed; inspect its command result and rerun after fixing the cause.",
    },
    {
      id: "project-007",
      requirement: "Open PR, started required CI, blocking feedback addressed, and review-stage handoff",
      status: "pending",
      evidence: [],
      note: "This is an external review-stage gate; attach the final deployed-run and CI summary to the PR conversation after the final push.",
    },
  ];
}

function originTrialRoute(
  url: string,
  route: JsonRecord | null,
): WebMcpEvidenceReport["originTrial"]["productionRoutes"][number] {
  return {
    url,
    metaPresent: booleanAt(route, "originTrialMetaPresent"),
    status: stringAt(route, "originTrialStatus"),
    feature: stringAt(route, "originTrialFeature"),
    origin: stringAt(route, "originTrialOrigin"),
    expiry: numberAt(route, "originTrialExpiry"),
    parseError: stringAt(route, "originTrialParseError"),
  };
}

function failureBoundary(input: {
  oraclePassed: boolean;
  oracleFailureCode: string | null;
  qualityPassed: boolean;
  localControlsPassed: boolean;
  deployedProductionPassed: boolean;
  productionFailureCode: string | null;
  isolationPassed: boolean;
  isolationFailureCode: string | null;
}): string | null {
  if (!input.oraclePassed) {
    return `external-oracle:${input.oracleFailureCode ?? "oracle-failed"}`;
  }
  if (!input.qualityPassed) {
    return "local-quality-gate-failed";
  }
  if (!input.localControlsPassed) {
    return "local-exported-site-control-failed";
  }
  if (!input.deployedProductionPassed) {
    return `deployed-production:${input.productionFailureCode ?? "production-no-go"}`;
  }
  if (!input.isolationPassed) {
    return `isolation:${input.isolationFailureCode ?? "isolation-no-go"}`;
  }
  return null;
}

function renderDecisionRecord(currentReport: WebMcpEvidenceReport): string {
  const lines = [
    "# WebMCP Anki deployed compatibility decision",
    "",
    `Decision: **${currentReport.conclusion.toUpperCase()}**  `,
    `Runtime classification: **${currentReport.overall}**  `,
    `Downstream classification: **${currentReport.downstream}**  `,
    `Evidence date: ${currentReport.generatedAt}  `,
    "",
    "This record is generated by `bun run webmcp:evidence`. It is runtime-only " +
      "evidence for the bounded compatibility spike, not production WebMCP approval.",
    "",
    "## Required deployment shape",
    "",
    `- Required origin: ${currentReport.project.requiredOrigin}`,
    `- Root URL: ${currentReport.project.productionUrls.root}`,
    `- Study URL: ${currentReport.project.productionUrls.study}`,
    `- Production runtime mode: ${currentReport.procedure.productionRuntimeMode}`,
    `- WebMCP testing flag: ${currentReport.procedure.productionTestingFlag}`,
    `- Production polyfill: ${currentReport.procedure.productionPolyfill}`,
    "",
    "## Browser and origin-trial matrix",
    "",
    `- Expected browser: ${display(currentReport.browser.expected)}`,
    `- Oracle browser observed: ${display(currentReport.browser.oracleObserved)}`,
    `- Production browser observed: ${display(currentReport.browser.productionObserved)}`,
    "",
    "| Route | Meta delivered | Runtime status | Feature | Token origin | Expiry | Parse error |",
    "| --- | --- | --- | --- | --- | ---: | --- |",
  ];
  for (const route of currentReport.originTrial.productionRoutes) {
    lines.push(
      `| ${route.url} | ${display(route.metaPresent)} | ${display(route.status)} | ${display(route.feature)} | ${display(route.origin)} | ${display(route.expiry)} | ${display(route.parseError)} |`,
    );
  }
  lines.push(
    "",
    "The raw origin-trial token is intentionally never written. `accepted`, " +
      "`rejected`, `expired`, `mismatched`, `not-required`, and `unknown` are runtime " +
      "classifications; token presence alone is not support evidence.",
    "",
    "## Runtime observations",
    "",
    `- External oracle: ${display(currentReport.gates.externalOracle)}.`,
    `- Local exported-site controls: ${display(currentReport.gates.localControls)}.`,
    `- Exact production routes: ${display(currentReport.gates.deployedProduction)}.`,
    `- Cross-origin/Permissions Policy experiment: ${display(currentReport.gates.isolation)}.`,
    "",
    "| Production route | Discovered tools | Valid call | Duplicate call | Invalid call | Cancelled call | Browser errors |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const [name, route] of [
    ["root", asRecord(currentReport.runtimeEvidence.production.root)],
    ["study", asRecord(currentReport.runtimeEvidence.production.study)],
  ] as const) {
    lines.push(
      `| ${name} | ${toolNames(route)} | ${callSummary(recordAt(route, "validCall"))} | ${callSummary(recordAt(route, "duplicateCall"))} | ${callSummary(recordAt(route, "invalidCall"))} | ${callSummary(recordAt(route, "cancelledCall"))} | ${display(pathAt(route, "browserErrors"))} |`,
    );
  }
  lines.push(
    "",
    `- Local lifecycle/reload evidence: root reload verified = ${display(currentReport.runtimeEvidence.lifecycle.localRootReloadVerified)}.`,
    `- Deployed lifecycle evidence: ${display(currentReport.runtimeEvidence.lifecycle.deployedRouteEvidence)}.`,
    "- The machine-readable report retains schemas, annotations, structured results, visible before/after state, route discovery, cancellation, console errors, and failed requests.",
    "- The cross-origin experiment is a separate loopback run; it is not deployed-native evidence.",
    "",
    "## Project-level gate mapping",
    "",
    "| ID | Requirement | Status | Evidence | Note |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const criterion of currentReport.criteria) {
    lines.push(
      `| ${criterion.id} | ${criterion.requirement} | ${criterion.status} | ${criterion.evidence.join(", ") || "none"} | ${criterion.note} |`,
    );
  }
  lines.push(
    "",
    "## Failure boundary and reproduction",
    "",
    `- Failure boundary: ${display(currentReport.failure.boundary)}`,
    `- Impact: ${currentReport.failure.impact}`,
    "",
    ...currentReport.failure.reproduction.map((command) => `- ${command}`),
    "",
    "A no-go or not-evaluable result is not converted into success by a local " +
      "WebMCP flag, mock, extension injection, polyfill, alternate host, or proxy.",
    "",
    "## Limitations and rerun triggers",
    "",
    ...currentReport.limitations.map((item) => `- ${item}`),
    "",
    "Rerun when:",
    ...currentReport.rerunWhen.map((item) => `- ${item}`),
    "",
    "## Reviewer handoff",
    "",
    "Attach or summarize this generated decision and the exact deployed-run and " +
      "CI results in the open PR conversation. Do not commit this artifact, CI " +
      "transcripts, or run-status updates; the artifact paths are listed in " +
      "`report.json`.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function toolNames(route: JsonRecord | null): string {
  const tools = arrayAt(route, "discoveredTools");
  const names = tools
    .map((tool) => stringAt(asRecord(tool), "name"))
    .filter((name): name is string => name !== null);
  return names.length === 0 ? "none" : names.join(", ");
}

function callSummary(call: JsonRecord | null): string {
  if (!call) {
    return "not-recorded";
  }
  const status = stringAt(call, "status") ?? "unknown";
  const result = asRecord(call.result);
  const code = stringAt(result, "code");
  return code ? `${status} (${code})` : status;
}

function commandPassed(name: string): boolean {
  return commandResults.some(
    (command) => command.name === name && command.status === "passed",
  );
}

async function runCommand(
  name: string,
  args: string[],
  environment: Record<string, string | undefined>,
  timeoutMilliseconds: number,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedMilliseconds = Date.now();
  const argv = [process.execPath, ...args];
  console.log(`Running ${name}: ${argv.join(" ")}`);
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete childEnvironment[key];
    } else {
      childEnvironment[key] = value;
    }
  }

  let child: Bun.Subprocess | undefined;
  let exitCode: number | null = null;
  let failure: string | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn(argv, {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = readProcessStream(child.stdout);
    const stderrPromise = readProcessStream(child.stderr);
    try {
      const timeoutMarker = "timeout" as const;
      const result = await Promise.race([
        child.exited,
        new Promise<number | typeof timeoutMarker>((resolvePromise) => {
          timeoutHandle = setTimeout(() => resolvePromise(timeoutMarker), timeoutMilliseconds);
        }),
      ]);
      if (result === timeoutMarker) {
        await terminateProcessTree(child);
        await Promise.allSettled([stdoutPromise, stderrPromise]);
        exitCode = null;
        failure = `exceeded ${timeoutMilliseconds}ms timeout`;
      } else {
        exitCode = result;
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        if (result !== 0) {
          failure = truncate(`${stdout}\n${stderr}`.trim());
        }
      }
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  } catch (error) {
    failure = truncate(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  const finishedAt = new Date().toISOString();
  const status: CommandResult["status"] = exitCode === 0 ? "passed" : "failed";
  commandResults.push({
    name,
    argv,
    status,
    startedAt,
    finishedAt,
    durationMilliseconds: Date.now() - startedMilliseconds,
    exitCode,
    failure,
  });
  console.log(`${status === "passed" ? "Passed" : "Failed"} ${name}`);
}

async function readJsonArtifact(path: string): Promise<ArtifactResult> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return { path, present: true, value, error: null };
  } catch (error) {
    return {
      path,
      present: false,
      value: null,
      error: truncate(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
    };
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function recordAt(value: unknown, ...keys: string[]): JsonRecord | null {
  return asRecord(pathAt(value, ...keys));
}

function pathAt(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record || !(key in record)) {
      return null;
    }
    current = record[key];
  }
  return current;
}

function stringAt(value: unknown, ...keys: string[]): string | null {
  const result = pathAt(value, ...keys);
  return typeof result === "string" ? result : null;
}

function booleanAt(value: unknown, ...keys: string[]): boolean | null {
  const result = pathAt(value, ...keys);
  return typeof result === "boolean" ? result : null;
}

function numberAt(value: unknown, ...keys: string[]): number | null {
  const result = pathAt(value, ...keys);
  return typeof result === "number" && Number.isFinite(result) ? result : null;
}

function arrayAt(value: unknown, ...keys: string[]): unknown[] {
  const result = pathAt(value, ...keys);
  return Array.isArray(result) ? result : [];
}

function display(value: unknown): string {
  if (typeof value === "string") {
    return value.replaceAll("|", "\\|").replaceAll("\n", " ");
  }
  if (value === null || value === undefined) {
    return "none";
  }
  try {
    const encoded = JSON.stringify(value);
    return (encoded ?? "undefined").replaceAll("|", "\\|").replaceAll("\n", " ");
  } catch {
    return "unserializable";
  }
}

function truncate(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 1_997)}...` : value;
}

function readProcessStream(
  stream: Bun.Subprocess["stdout"] | Bun.Subprocess["stderr"],
): Promise<string> {
  if (stream && typeof stream !== "number") {
    return new Response(stream).text();
  }
  return Promise.resolve("");
}

async function terminateProcessTree(child: Bun.Subprocess): Promise<void> {
  if (process.platform !== "win32") {
    child.kill();
    return;
  }

  const killer = Bun.spawn(
    ["taskkill", "/PID", String(child.pid), "/T", "/F"],
    { stdout: "ignore", stderr: "ignore" },
  );
  await Promise.race([
    killer.exited,
    new Promise<null>((resolvePromise) =>
      setTimeout(() => resolvePromise(null), 2_000),
    ),
  ]);
  if (killer.exitCode === null) {
    killer.kill();
  }
}
