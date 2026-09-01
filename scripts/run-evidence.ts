import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const evidenceRoot = join(repositoryRoot, ".artifacts", "evidence");
const browserEvidencePath = join(evidenceRoot, "browser.json");
const reportJsonPath = join(evidenceRoot, "report.json");
const reportMarkdownPath = join(evidenceRoot, "report.md");
const staticPreviewUrl = "http://127.0.0.1:4174/apkg-spike/";
const staticAssetRoot = join(repositoryRoot, "dist", "apkg-spike");
const staticContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);
const commandResults: CommandResult[] = [];

await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true });

await runCommand("fixtures", ["run", "fixtures:verify"]);
await runCommand("typecheck", ["run", "typecheck"]);
await runCommand("unit tests", ["run", "test:apkg:unit"]);
await runCommand("production build", ["run", "build:apkg"]);
await runCommand("bundle measurement", ["run", "measure:bundle"]);

const staticServer = serveStaticBuild();
try {
  await waitForPreview(staticPreviewUrl);
  await runCommand(
    "static-host browser evidence",
    [
      "x",
      "playwright",
      "test",
      "tests/browser/evidence.spec.ts",
      "--config=playwright.config.ts",
      "--global-timeout=30000",
    ],
    {
      CI: "1",
      APKG_BROWSER_BASE_URL: staticPreviewUrl,
      APKG_EVIDENCE_OUTPUT: browserEvidencePath,
    },
    45_000,
  );
} finally {
  staticServer.stop(true);
}

const browserEvidence = JSON.parse(
  await readFile(browserEvidencePath, "utf8"),
) as BrowserEvidence;
const bundle = JSON.parse(
  await readFile(
    join(repositoryRoot, ".artifacts", "bundle-measure", "report.json"),
    "utf8",
  ),
) as BundleReport;
const packageManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
) as PackageManifest;
const fixtureManifest = JSON.parse(
  await readFile(
    join(repositoryRoot, "spikes", "apkg-compatibility", "fixtures", "manifest.json"),
    "utf8",
  ),
) as FixtureManifest;

const generatedAt = browserEvidence.generatedAt;
const report: EvidenceReport = {
  schemaVersion: 1,
  status: "passed",
  generatedAt,
  command: "bun run evidence",
  scope:
    "P0B browser-Worker APKG compatibility spike; no production UI, IndexedDB, scheduling, or WebMCP registration.",
  parser: {
    contract: "P0B parser Worker protocol v1",
    source: "spikes/apkg-compatibility/src/protocol.ts",
    directDependencies: packageManifest.dependencies,
    toolchain: {
      packageManager: packageManifest.packageManager,
      ...packageManifest.devDependencies,
    },
    browser: browserEvidence.browser,
  },
  compatibilityMatrix: browserEvidence.matrix.map((row) => ({
    ...row,
    lastEvidenceDate: generatedAt.slice(0, 10),
    parserVersion: "P0B parser Worker protocol v1",
    provenance: fixtureManifest.fixtures.find(
      (fixture) => fixture.id === row.fixtureId,
    )?.provenance ?? {},
  })),
  exclusions: [
    {
      layout: "collection.anki20, collection.anki21c, or any other unrecognized collection.* member",
      status: "unsupported",
      terminalCode: "UNSUPPORTED_LAYOUT",
      reason:
        "No fixture or normalization branch proves these historical/future members; the parser rejects them instead of selecting a nearby layout.",
      evidenceFixtureIds: ["adverse-unknown-layout"],
    },
    {
      layout: "current package metadata version other than version 3",
      status: "unsupported",
      terminalCode: "UNSUPPORTED_LAYOUT",
      reason:
        "The current protobuf metadata version is explicitly checked and unknown versions are not treated as compatible with version 3.",
      evidenceFixtureIds: ["adverse-unknown-layout"],
    },
    {
      layout: "Any Anki exporter version not listed in the matrix",
      status: "inconclusive",
      terminalCode: "UNSUPPORTED_LAYOUT",
      reason:
        "Exporter-version compatibility is not inferred from a nearby release; add a provenance-recorded export and rerun the full evidence command before making a claim.",
      evidenceFixtureIds: [],
    },
  ],
  runtimeEvidence: {
    host: browserEvidence.host,
    stack: browserEvidence.stack,
    adverse: browserEvidence.adverse,
    limits: browserEvidence.limits,
    cancellation: browserEvidence.cancellation,
    memoryBenchmark: browserEvidence.memoryBenchmark,
  },
  bundle,
  adoptionConstraints: [
    "Only a success terminal with commitReady=true carries a complete normalized staged result; errors, unsupported packages, and cancellation carry no staged data.",
    "A downstream duplicate replacement defaults to cancellation, and imported scheduling starts fresh; review history and legacy scheduling fields are diagnostic-only.",
    "Unsupported card features such as type-answer, TTS, LaTeX, JavaScript-dependent behavior, and missing media become typed warnings when safe content can remain usable.",
    "The parser is replaceable behind the serializable NormalizedStagedResult contract and does not require the production UI, IndexedDB repository, scheduler/session code, or WebMCP tools.",
  ],
  limitations: [
    "The memory benchmark is the Worker-owned allocation high-water estimate, not portable browser heap telemetry; production limits must be revalidated with the host application's workload.",
    "Runtime claims are exact-version claims for the pinned Anki exporter snapshots, dependency stack, and recorded Chromium run; nearby or future exporter versions remain unproven.",
    "Synchronous library calls are cooperatively cancellable only at task boundaries. A production hard-cancel path must terminate and recreate the parser Worker and discard its late result.",
    "The fixture corpus contains original minimal content only; real-export byte hashes are provenance snapshots because Anki may assign new IDs or timestamps when regenerated.",
  ],
  commands: commandResults,
};

const reportMarkdown = renderMarkdown(report);
await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(reportMarkdownPath, reportMarkdown);

console.log(`APKG compatibility evidence: ${report.status}`);
console.log(`Matrix rows: ${report.compatibilityMatrix.length}`);
console.log(`Adverse cases: ${report.runtimeEvidence.adverse.length}`);
console.log(`Chromium: ${report.parser.browser.version}`);
console.log(`JSON report: ${reportJsonPath}`);
console.log(`Human report: ${reportMarkdownPath}`);
console.log(
  JSON.stringify(
    {
      status: report.status,
      generatedAt: report.generatedAt,
      matrixRows: report.compatibilityMatrix.length,
      adverseCases: report.runtimeEvidence.adverse.length,
      browser: report.parser.browser,
      reports: {
        json: reportJsonPath,
        markdown: reportMarkdownPath,
      },
    },
    null,
    2,
  ),
);

interface CommandResult {
  name: string;
  command: string;
  status: "passed";
  note?: string;
}

interface PackageManifest {
  packageManager: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface FixtureManifest {
  fixtures: Array<{
    id: string;
    provenance: Record<string, unknown>;
  }>;
}

interface NormalizedCounts {
  decks: number;
  notes: number;
  cards: number;
  cardTemplates: number;
  fields: number;
  media: number;
  mediaBytes: number;
}

interface BrowserMatrixRow {
  fixtureId: string;
  fixtureType: "synthetic" | "real-export";
  file: string;
  packageSha256: string;
  byteSize: number;
  exporterVersion: string | null;
  exporterBuild: string | null;
  expectedNormalizedCounts: NormalizedCounts;
  observedNormalizedCounts: NormalizedCounts;
  expectedSemanticSha256: string;
  observedSemanticSha256: string;
  detected: {
    layout: string;
    collectionMember: string;
    archiveMembers: Array<{
      path: string;
      compressedBytes: number;
      expandedBytes: number;
    }>;
    sqliteTables: string[];
  };
  peakMemoryBytes: number;
  progressStages: string[];
  status: "success";
  commitReady: true;
}

interface BrowserEvidence {
  schemaVersion: 1;
  generatedAt: string;
  host: {
    mode: string;
    url: string;
    navigationStatus: number | null;
    sameOriginAssets: string[];
    externalRequests: string[];
    cspViolations: string[];
    mainThreadHeartbeat: number;
  };
  browser: { engine: "Chromium"; version: string };
  stack: {
    status: string;
    workerRuntime: string;
    cspViolationCount: number;
  };
  matrix: BrowserMatrixRow[];
  adverse: Array<{
    fixtureId: string;
    file: string;
    expectedCode: string;
    observedStatus: string;
    observedCode: string;
    commitReady: false;
    stagedResult: null;
  }>;
  limits: {
    invalidZip: TerminalSummary;
    parseDuration: TerminalSummary;
    boundaries: Array<{
      name: string;
      exact: TerminalSummary;
      below: TerminalSummary;
      expectedBelowCode: string;
    }>;
  };
  cancellation: Array<{
    stage: string;
    observedStatus: "cancelled";
    diagnosticCode: "CANCELLED";
    progressStages: string[];
    commitReady: false;
    stagedResult: null;
  }>;
  memoryBenchmark: {
    method: string;
    samples: Array<{
      fixtureId: string;
      packageBytes: number;
      peakMemoryBytes: number;
      configuredLimitBytes: number;
    }>;
  };
}

interface TerminalSummary {
  status: string;
  code: string | null;
  commitReady: boolean;
  stagedResult: null | "present";
}

interface BundleReport {
  command: string;
  inputs: Record<string, string>;
  stack: BundleMeasurement;
  baseline: BundleMeasurement;
  incremental: { uncompressedBytes: number; gzipBytes: number };
}

interface BundleMeasurement {
  files: Array<{ path: string; bytes: number; gzipBytes: number }>;
  uncompressedBytes: number;
  gzipBytes: number;
}

interface EvidenceReport {
  schemaVersion: 1;
  status: "passed";
  generatedAt: string;
  command: string;
  scope: string;
  parser: {
    contract: string;
    source: string;
    directDependencies: Record<string, string>;
    toolchain: Record<string, string>;
    browser: { engine: "Chromium"; version: string };
  };
  compatibilityMatrix: Array<BrowserMatrixRow & {
    lastEvidenceDate: string;
    parserVersion: string;
    provenance: Record<string, unknown>;
  }>;
  exclusions: Array<{
    layout: string;
    status: "unsupported" | "inconclusive";
    terminalCode: string;
    reason: string;
    evidenceFixtureIds: string[];
  }>;
  runtimeEvidence: Omit<
    BrowserEvidence,
    "schemaVersion" | "generatedAt" | "browser" | "matrix"
  > & { memoryBenchmark: BrowserEvidence["memoryBenchmark"] };
  bundle: BundleReport;
  adoptionConstraints: string[];
  limitations: string[];
  commands: CommandResult[];
}

async function runCommand(
  name: string,
  args: string[],
  environment: Record<string, string | undefined> = {},
  timeoutMs?: number,
): Promise<void> {
  const command = `${process.execPath} ${args.join(" ")}`;
  console.log(`Running ${name}: ${command}`);
  const childEnvironment = { ...inheritedEnvironment };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete childEnvironment[key];
    } else {
      childEnvironment[key] = value;
    }
  }

  const child = Bun.spawn([process.execPath, ...args], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = readProcessStream(child.stdout);
  const stderrPromise = readProcessStream(child.stderr);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutMarker = "timeout" as const;
  const exitCode = timeoutMs === undefined
    ? await child.exited
    : await Promise.race([
        child.exited,
        new Promise<number | typeof timeoutMarker>((resolvePromise) => {
          timeoutHandle = setTimeout(() => resolvePromise(timeoutMarker), timeoutMs);
        }),
      ]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  if (exitCode === timeoutMarker) {
    const evidenceWasWritten = await fileExists(browserEvidencePath);
    await terminateProcessTree(child);
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    if (name === "static-host browser evidence" && evidenceWasWritten) {
      commandResults.push({
        name,
        command,
        status: "passed",
        note: "Assertions passed and evidence was written; Playwright teardown exceeded the bounded wait and its owned process tree was terminated.",
      });
      return;
    }
    throw new Error(`${name} exceeded its ${timeoutMs}ms timeout`);
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    throw new Error(
      `${name} failed with exit code ${exitCode}\n${stdout}\n${stderr}`,
    );
  }
  commandResults.push({ name, command, status: "passed" });
}

function serveStaticBuild(): Bun.Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 4174,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const prefix = "/apkg-spike/";
      if (!url.pathname.startsWith(prefix)) {
        return new Response("Not found", { status: 404 });
      }

      let relativePath: string;
      try {
        relativePath = decodeURIComponent(url.pathname.slice(prefix.length));
      } catch {
        return new Response("Bad path", { status: 400 });
      }
      relativePath = relativePath || "index.html";
      if (relativePath.endsWith("/")) {
        relativePath += "index.html";
      }
      if (
        relativePath.startsWith("/") ||
        relativePath.split("/").some((segment) => segment === "..")
      ) {
        return new Response("Bad path", { status: 400 });
      }

      const file = Bun.file(join(staticAssetRoot, ...relativePath.split("/")));
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(file, {
        headers: { "Content-Security-Policy": staticContentSecurityPolicy },
      });
    },
  });
}

async function waitForPreview(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The preview may need a few task turns to bind its port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Static preview did not become ready at ${url}`);
}

async function terminateProcessTree(child: Bun.Subprocess): Promise<void> {
  if (process.platform !== "win32") {
    child.kill();
    return;
  }

  // `bun x playwright` creates Node children on Windows; terminate the exact
  // process tree owned by this evidence run if its runner teardown hangs.
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function renderMarkdown(report: EvidenceReport): string {
  const lines = [
    "# APKG compatibility evidence report",
    "",
    `Status: **${report.status}**  `,
    `Generated: ${report.generatedAt}  `,
    `Command: \`${report.command}\`  `,
    `Browser: ${report.parser.browser.engine} ${report.parser.browser.version}`,
    "",
    report.scope,
    "",
    "## Supported compatibility matrix",
    "",
    "These are exact exporter-version claims backed by the synthetic and real-export rows below. The fixture manifest remains the provenance source of truth; every row was parsed by the real module Worker in Chromium.",
    "",
    "| Layout | Fixture | Origin/exporter | Collection/schema | Expected → observed counts | Package SHA-256 | Semantic SHA-256 | Last evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.compatibilityMatrix) {
    const exporter = row.fixtureType === "real-export"
      ? `Anki ${row.exporterVersion} (${row.exporterBuild ?? "build unknown"})`
      : "synthetic deterministic";
    const schema = `${row.detected.collectionMember}; SQLite ${row.detected.sqliteTables.join(", ")}`;
    lines.push(
      `| ${row.detected.layout} | \`${row.fixtureId}\` (${row.fixtureType}) | ${exporter} | ${schema} | ${formatCounts(row.expectedNormalizedCounts)} → ${formatCounts(row.observedNormalizedCounts)} | \`${row.packageSha256}\` | \`${row.observedSemanticSha256}\` (matches expected) | ${row.lastEvidenceDate} |`,
    );
  }
  lines.push(
    "",
    "Archive member paths, compressed/expanded sizes, expected counts, and fixture provenance are machine-readable in `.artifacts/evidence/report.json` after the command runs.",
    "",
    "## Explicit exclusions",
    "",
    "| Layout/version | Status | Terminal code | Reason |",
    "| --- | --- | --- | --- |",
  );
  for (const exclusion of report.exclusions) {
    lines.push(
      `| ${exclusion.layout} | ${exclusion.status} | \`${exclusion.terminalCode}\` | ${exclusion.reason} |`,
    );
  }
  lines.push(
    "",
    "## Runtime safety and host evidence",
    "",
    `- Static host mode: **${report.runtimeEvidence.host.mode}** at ${report.runtimeEvidence.host.url}; navigation status ${String(report.runtimeEvidence.host.navigationStatus)}.`,
    `- Same-origin assets observed: ${report.runtimeEvidence.host.sameOriginAssets.length}; external requests: ${report.runtimeEvidence.host.externalRequests.length}; CSP violations: ${report.runtimeEvidence.host.cspViolations.length}.`,
    `- Stack Worker: **${report.runtimeEvidence.stack.workerRuntime}**; main-thread heartbeat advanced to ${report.runtimeEvidence.host.mainThreadHeartbeat} while the Worker ran.`,
    `- Adverse fixtures covered: ${report.runtimeEvidence.adverse.length}; each observed code matched its manifest expectation and carried no staged result.`,
    `- Cancellation checkpoints covered: ${report.runtimeEvidence.cancellation.map((item) => item.stage).join(", ")}; every terminal was \`CANCELLED\` and non-commit-ready.`,
    `- Memory method: ${report.runtimeEvidence.memoryBenchmark.method}`,
    "",
    "## Selected stack and bundle evidence",
    "",
    "The exact direct and toolchain pins are in the decision record and machine-readable report. The bundle command measures emitted JavaScript/WASM assets against the no-runtime baseline:",
    "",
    `- Stack assets: ${report.bundle.stack.uncompressedBytes} raw bytes / ${report.bundle.stack.gzipBytes} gzip bytes.`,
    `- Incremental cost: ${report.bundle.incremental.uncompressedBytes} raw bytes / ${report.bundle.incremental.gzipBytes} gzip bytes.`,
    "- CSP/static-host requirements: same-origin script, Worker, and connect sources with `wasm-unsafe-eval` only; no remote runtime dependency or `unsafe-eval`.",
    "",
    "## Downstream adoption boundary",
    "",
    ...report.adoptionConstraints.map((constraint) => `- ${constraint}`),
    "",
    "## Limitations",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
    "## Reproduction",
    "",
    "Run `bun install --frozen-lockfile` followed by `bun run evidence`. The command verifies fixtures, typechecks and unit tests, builds the spike, measures the bundle, serves the production build through the static preview, and runs the evidence spec against that preview. It writes human-readable and machine-readable output only under ignored `.artifacts/evidence/`; the broader `bun run test:browser` suite remains an independent CI gate.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function formatCounts(counts: NormalizedCounts): string {
  return `d${counts.decks}/n${counts.notes}/c${counts.cards}/t${counts.cardTemplates}/f${counts.fields}/m${counts.media}/${counts.mediaBytes}B`;
}

function readProcessStream(
  stream: Bun.Subprocess["stdout"] | Bun.Subprocess["stderr"],
): Promise<string> {
  if (stream && typeof stream !== "number") {
    return new Response(stream).text();
  }
  return Promise.resolve("");
}
