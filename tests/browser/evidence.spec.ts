import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  DEFAULT_PARSE_LIMITS,
  type NormalizedStagedResult,
  type ParseLimits,
  type ParserStage,
  type ParserTerminalMessage,
} from "../../spikes/apkg-compatibility/src/protocol";

const fixtureRoot = resolve("spikes", "apkg-compatibility", "fixtures");
const manifest = JSON.parse(
  await readFile(resolve(fixtureRoot, "manifest.json"), "utf8"),
) as FixtureManifest;
const parserLimits: ParseLimits = {
  ...DEFAULT_PARSE_LIMITS,
  maxParseTimeMs: 30_000,
};
const evidenceOutput = process.env.APKG_EVIDENCE_OUTPUT;

test.describe.configure({ mode: "serial" });

test.describe("browser compatibility evidence", () => {
  test("records the supported matrix, bounded failures, cancellation, and CSP proof", async ({
    browser,
    page,
  }) => {
    const externalRequests = new Set<string>();
    const requestUrls = new Set<string>();
    const cspViolations: string[] = [];

    await page.addInitScript(() => {
      const evidenceWindow = window as typeof window & {
        __apkgCspViolations?: string[];
      };
      evidenceWindow.__apkgCspViolations = [];
      window.addEventListener("securitypolicyviolation", (event) => {
        evidenceWindow.__apkgCspViolations?.push(
          `${event.violatedDirective}:${event.blockedURI}`,
        );
      });
    });
    page.on("request", (request) => {
      const url = request.url();
      requestUrls.add(url);
      const expectedOrigin = new URL(
        process.env.APKG_BROWSER_BASE_URL ??
          `http://127.0.0.1:${process.env.APKG_BROWSER_PORT ?? "4173"}/`,
      ).origin;
      if (new URL(url).origin !== expectedOrigin) {
        externalRequests.add(url);
      }
    });

    const navigationResponse = await page.goto("");
    expect(navigationResponse?.ok()).toBe(true);
    const initialHeartbeat = Number(
      await page.locator("#heartbeat").getAttribute("data-heartbeat"),
    );

    await page.getByRole("button", { name: "Run stack evaluation" }).click();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-status",
      "success",
      { timeout: 30_000 },
    );
    const stack = JSON.parse(
      (await page.locator("#result").textContent()) ?? "null",
    ) as StackEvidenceResult;
    expect(stack.workerRuntime).toBe("dedicated-worker");
    expect(stack.cspViolationCount).toBe(0);
    expect(stack.mainThreadHeartbeat).toBeGreaterThan(initialHeartbeat);

    const browserVersion = browser.version();
    const matrix: MatrixEvidence[] = [];
    const matrixFixtureIds = manifest.layouts.flatMap((layout) => [
      ...layout.syntheticFixtureIds,
      ...layout.realFixtureIds,
    ]);
    for (const fixtureId of matrixFixtureIds) {
      const fixture = getFixture(fixtureId);
      const packageBytes = await readFixture(fixture.file);
      const observation = await parsePackage(page, packageBytes);
      expect(observation.terminal.status, fixtureId).toBe("success");
      if (observation.terminal.status !== "success") {
        throw new Error(`${fixtureId} did not produce a success terminal`);
      }

      const stagedResult = observation.terminal.stagedResult;
      const observedSemanticSha256 = semanticSha256(fixture, stagedResult);
      expect(stagedResult.packageSha256, fixtureId).toBe(fixture.sha256);
      expect(observedSemanticSha256, fixtureId).toBe(
        fixture.expected.semanticSha256,
      );
      expect(observation.progress.map(({ stage }) => stage), fixtureId).toEqual(
        [
          "archive",
          "collection",
          "decompression",
          "database",
          "media",
          "sanitization",
        ],
      );

      matrix.push({
        fixtureId,
        fixtureType: fixture.fixtureType,
        file: fixture.file,
        packageSha256: fixture.sha256,
        byteSize: fixture.byteSize,
        exporterVersion: typeof fixture.provenance.exporterVersion === "string"
          ? fixture.provenance.exporterVersion
          : null,
        exporterBuild: typeof fixture.provenance.exporterBuild === "string"
          ? fixture.provenance.exporterBuild
          : null,
        expectedNormalizedCounts: fixture.expected.normalizedCounts,
        observedNormalizedCounts: normalizedCounts(stagedResult),
        expectedSemanticSha256: fixture.expected.semanticSha256,
        observedSemanticSha256,
        detected: {
          layout: stagedResult.layout,
          collectionMember: stagedResult.collectionMember,
          archiveMembers: stagedResult.archiveMembers.map((member) => ({
            path: member.path,
            compressedBytes: member.compressedBytes,
            expandedBytes: member.expandedBytes,
          })),
          sqliteTables: stagedResult.validation.sqliteTables,
        },
        peakMemoryBytes: stagedResult.validation.peakMemoryBytes,
        progressStages: observation.progress.map(({ stage }) => stage),
        status: "success",
        commitReady: true,
      });
    }

    const adverse: AdverseEvidence[] = [];
    for (const fixture of manifest.fixtures.filter((candidate) =>
      candidate.id.startsWith("adverse-"),
    )) {
      const observation = await parsePackage(
        page,
        await readFixture(fixture.file),
      );
      const expectedCode = expectedErrorCode(fixture);
      expect(observation.terminal.status, fixture.id).not.toBe("success");
      expect(observation.terminal.commitReady, fixture.id).toBe(false);
      expect(observation.terminal.stagedResult, fixture.id).toBeNull();
      if (observation.terminal.status === "success") {
        throw new Error(`${fixture.id} unexpectedly produced a success terminal`);
      }
      expect(observation.terminal.diagnostic.code, fixture.id).toBe(expectedCode);
      adverse.push({
        fixtureId: fixture.id,
        file: fixture.file,
        expectedCode,
        observedStatus: observation.terminal.status,
        observedCode: observation.terminal.diagnostic.code,
        commitReady: observation.terminal.commitReady,
        stagedResult: observation.terminal.stagedResult,
      });
    }

    const legacyBytes = await readFixture("synthetic/legacy-anki2.apkg");
    const baseline = matrix.find(
      (row) => row.fixtureId === "synthetic-legacy-anki2",
    );
    if (!baseline) {
      throw new Error("The supported matrix did not include the legacy fixture");
    }
    const baselineTerminal = await parsePackage(page, legacyBytes);
    if (baselineTerminal.terminal.status !== "success") {
      throw new Error("The legacy baseline did not produce a success terminal");
    }
    const members = baselineTerminal.terminal.stagedResult.archiveMembers;
    const requiredExpandedBytes = Math.max(
      members.reduce((total, member) => total + member.expandedBytes, 0),
      baselineTerminal.terminal.stagedResult.validation.expandedBytes,
    );
    const maximumEntryBytes = Math.max(
      ...members.map((member) => member.expandedBytes),
    );
    const maximumCompressionRatio = Math.max(
      ...members.map((member) => member.expandedBytes / member.compressedBytes),
    );
    const peakMemoryBytes = baselineTerminal.terminal.stagedResult.validation
      .peakMemoryBytes;
    const limitBoundaries = [
      await limitBoundary(
        page,
        "package-bytes",
        legacyBytes,
        { maxPackageBytes: legacyBytes.byteLength },
        { maxPackageBytes: legacyBytes.byteLength - 1 },
        "ARCHIVE_LIMIT_EXCEEDED",
      ),
      await limitBoundary(
        page,
        "archive-entries",
        legacyBytes,
        { maxArchiveEntries: members.length },
        { maxArchiveEntries: members.length - 1 },
        "ARCHIVE_LIMIT_EXCEEDED",
      ),
      await limitBoundary(
        page,
        "expanded-bytes",
        legacyBytes,
        { maxExpandedBytes: requiredExpandedBytes },
        { maxExpandedBytes: requiredExpandedBytes - 1 },
        "ARCHIVE_LIMIT_EXCEEDED",
      ),
      await limitBoundary(
        page,
        "entry-bytes",
        legacyBytes,
        { maxEntryBytes: maximumEntryBytes },
        { maxEntryBytes: maximumEntryBytes - 1 },
        "ARCHIVE_LIMIT_EXCEEDED",
      ),
      await limitBoundary(
        page,
        "compression-ratio",
        legacyBytes,
        { maxCompressionRatio: maximumCompressionRatio },
        { maxCompressionRatio: maximumCompressionRatio * (1 - 1e-9) },
        "ARCHIVE_LIMIT_EXCEEDED",
      ),
      await limitBoundary(
        page,
        "memory-bytes",
        legacyBytes,
        { maxMemoryBytes: peakMemoryBytes },
        { maxMemoryBytes: peakMemoryBytes - 1 },
        "MEMORY_LIMIT_EXCEEDED",
      ),
    ];

    const invalidZip = await parsePackage(page, new Uint8Array([1, 2, 3]));
    expect(invalidZip.terminal.status).toBe("error");
    if (invalidZip.terminal.status !== "error") {
      throw new Error("Invalid ZIP did not produce an error terminal");
    }
    expect(invalidZip.terminal.diagnostic.code).toBe("INVALID_ZIP");
    const parseLimit = await parsePackage(
      page,
      legacyBytes,
      { maxParseTimeMs: 1 },
      10,
    );
    expect(parseLimit.terminal.status).toBe("error");
    if (parseLimit.terminal.status !== "error") {
      throw new Error("Parse limit did not produce an error terminal");
    }
    expect(parseLimit.terminal.diagnostic.code).toBe("PARSE_LIMIT_EXCEEDED");

    const cancellation: CancellationEvidence[] = [];
    for (const stage of [
      "archive",
      "collection",
      "decompression",
      "database",
      "media",
      "sanitization",
    ] as const) {
      const observation = await parsePackage(page, legacyBytes, {}, 10, stage);
      expect(observation.terminal.status, stage).toBe("cancelled");
      expect(observation.terminal.commitReady, stage).toBe(false);
      expect(observation.terminal.stagedResult, stage).toBeNull();
      if (observation.terminal.status !== "cancelled") {
        throw new Error(`${stage} cancellation did not produce a cancelled terminal`);
      }
      expect(observation.terminal.diagnostic.code, stage).toBe("CANCELLED");
      cancellation.push({
        stage,
        observedStatus: observation.terminal.status,
        diagnosticCode: observation.terminal.diagnostic.code,
        progressStages: observation.progress.map(({ stage: progressStage }) =>
          progressStage
        ),
        commitReady: observation.terminal.commitReady,
        stagedResult: observation.terminal.stagedResult,
      });
    }

    const cspWindow = await page.evaluate(() =>
      (window as typeof window & { __apkgCspViolations?: string[] })
        .__apkgCspViolations ?? []
    );
    cspViolations.push(...cspWindow);
    const pageOrigin = new URL(page.url()).origin;
    const sameOriginAssets = [...requestUrls]
      .filter((url) => new URL(url).origin === pageOrigin)
      .filter((url) => /\/apkg-spike\/(?:assets\/|src\/)/.test(url))
      .sort();
    expect(externalRequests).toEqual(new Set());
    expect(cspViolations).toEqual([]);
    expect(sameOriginAssets.length).toBeGreaterThan(0);

    const evidence: BrowserEvidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      host: {
        mode: process.env.APKG_BROWSER_BASE_URL
          ? "static-preview"
          : "vite-dev-harness",
        url: pageOrigin,
        navigationStatus: navigationResponse?.status() ?? null,
        sameOriginAssets,
        externalRequests: [...externalRequests].sort(),
        cspViolations,
        mainThreadHeartbeat: stack.mainThreadHeartbeat,
      },
      browser: {
        engine: "Chromium",
        version: browserVersion,
      },
      stack: {
        status: stack.status,
        workerRuntime: stack.workerRuntime,
        cspViolationCount: stack.cspViolationCount,
      },
      matrix,
      adverse,
      limits: {
        invalidZip: terminalSummary(invalidZip.terminal),
        parseDuration: terminalSummary(parseLimit.terminal),
        boundaries: limitBoundaries,
      },
      cancellation,
      memoryBenchmark: {
        method:
          "Worker-reported parser-owned live allocation high-water mark; this is not browser heap telemetry.",
        samples: matrix.map((row) => ({
          fixtureId: row.fixtureId,
          packageBytes: row.byteSize,
          peakMemoryBytes: row.peakMemoryBytes,
          configuredLimitBytes: DEFAULT_PARSE_LIMITS.maxMemoryBytes,
        })),
      },
    };

    await writeEvidence(evidence);
    await page.close();
  });
});

interface FixtureManifest {
  layouts: Array<{
    id: string;
    syntheticFixtureIds: string[];
    realFixtureIds: string[];
  }>;
  fixtures: Fixture[];
}

interface Fixture {
  id: string;
  file: string;
  fixtureType: "synthetic" | "real-export";
  layout: string;
  byteSize: number;
  sha256: string;
  expected: {
    normalizedCounts: NormalizedCounts;
    semanticSha256: string;
  };
  provenance: Record<string, unknown>;
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

interface StackEvidenceResult {
  status: string;
  workerRuntime: string;
  cspViolationCount: number;
  mainThreadHeartbeat: number;
}

interface ParseObservation {
  progress: Array<{ stage: ParserStage; completed: number; total: number }>;
  terminal: ParserTerminalMessage;
}

interface MatrixEvidence {
  fixtureId: string;
  fixtureType: Fixture["fixtureType"];
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
  progressStages: ParserStage[];
  status: "success";
  commitReady: true;
}

interface AdverseEvidence {
  fixtureId: string;
  file: string;
  expectedCode: string;
  observedStatus: string;
  observedCode: string;
  commitReady: false;
  stagedResult: null;
}

interface CancellationEvidence {
  stage: ParserStage;
  observedStatus: "cancelled";
  diagnosticCode: "CANCELLED";
  progressStages: ParserStage[];
  commitReady: false;
  stagedResult: null;
}

interface TerminalSummary {
  status: ParserTerminalMessage["status"];
  code: string | null;
  commitReady: boolean;
  stagedResult: null | "present";
}

interface LimitBoundary {
  name: string;
  exact: TerminalSummary;
  below: TerminalSummary;
  expectedBelowCode: string;
}

interface BrowserEvidence {
  schemaVersion: 1;
  generatedAt: string;
  host: {
    mode: "static-preview" | "vite-dev-harness";
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
  matrix: MatrixEvidence[];
  adverse: AdverseEvidence[];
  limits: {
    invalidZip: TerminalSummary;
    parseDuration: TerminalSummary;
    boundaries: LimitBoundary[];
  };
  cancellation: CancellationEvidence[];
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

async function parsePackage(
  page: Page,
  packageBytes: Uint8Array,
  limitOverrides: Partial<ParseLimits> = {},
  checkpointDelayMs = 0,
  cancelStage?: ParserStage,
): Promise<ParseObservation> {
  return page.evaluate(
    async ({ bytes, limits, delay, stage }) => {
      const progress: ParseObservation["progress"] = [];
      const terminal = await window.apkgParserHarness.parse(
        new Uint8Array(bytes),
        {
          limits,
          checkpointDelayMs: delay,
          onProgress: (message) => {
            progress.push(message);
            if (message.stage === stage) {
              window.apkgParserHarness.cancel();
            }
          },
        },
      );
      return { progress, terminal };
    },
    {
      bytes: [...packageBytes],
      limits: { ...parserLimits, ...limitOverrides },
      delay: checkpointDelayMs,
      stage: cancelStage,
    },
  ) as Promise<ParseObservation>;
}

async function limitBoundary(
  page: Page,
  name: string,
  packageBytes: Uint8Array,
  exactOverrides: Partial<ParseLimits>,
  belowOverrides: Partial<ParseLimits>,
  expectedBelowCode: string,
): Promise<LimitBoundary> {
  const exact = await parsePackage(page, packageBytes, exactOverrides);
  const below = await parsePackage(page, packageBytes, belowOverrides);
  expect(exact.terminal.status, `${name} exact`).toBe("success");
  expect(below.terminal.status, `${name} below`).not.toBe("success");
  if (below.terminal.status === "success") {
    throw new Error(`${name} below-boundary request unexpectedly succeeded`);
  }
  expect(below.terminal.diagnostic.code, `${name} below`).toBe(
    expectedBelowCode,
  );
  return {
    name,
    exact: terminalSummary(exact.terminal),
    below: terminalSummary(below.terminal),
    expectedBelowCode,
  };
}

function terminalSummary(terminal: ParserTerminalMessage): TerminalSummary {
  return {
    status: terminal.status,
    code: terminal.status === "success" ? null : terminal.diagnostic.code,
    commitReady: terminal.commitReady,
    stagedResult: terminal.stagedResult === null ? null : "present",
  };
}

function normalizedCounts(result: NormalizedStagedResult): NormalizedCounts {
  return {
    decks: result.normalized.decks.length,
    notes: result.normalized.notes.length,
    cards: result.normalized.cards.length,
    cardTemplates: result.normalized.cardTemplates.length,
    fields: result.normalized.fields.length,
    media: result.normalized.media.length,
    mediaBytes: result.normalized.media.reduce(
      (total, media) => total + media.byteLength,
      0,
    ),
  };
}

function semanticSha256(
  fixture: Fixture,
  result: NormalizedStagedResult,
): string {
  const normalized = result.normalized;
  const decks = normalized.decks.map((deck) => fixture.fixtureType === "synthetic"
    ? { id: deck.id, name: deck.name }
    : { name: deck.name });
  const fields = normalized.fields.map((field) => field.name);
  const media = normalized.media.map((entry) => ({
    name: entry.name,
    sha1: entry.sha1,
    bytes: entry.byteLength,
  }));
  const notes = normalized.notes.map((note) => fixture.fixtureType === "synthetic"
    ? {
        sourceGuid: note.sourceGuid,
        fields: note.fields,
        tags: note.tags,
      }
    : { fields: note.fields, tags: note.tags });
  const templates = normalized.cardTemplates.map((template) => ({
    name: template.name,
    ordinal: template.ordinal,
  }));
  const semantic = fixture.fixtureType === "synthetic"
    ? { decks, fields, media, notes, templates }
    : {
        decks,
        notetypes: normalized.notetypes.map((notetype) => ({
          name: notetype.name,
          fields: notetype.fields,
          templates: notetype.templates,
        })),
        fields,
        templates,
        notes,
        media,
      };
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

function getFixture(id: string): Fixture {
  const fixture = manifest.fixtures.find((candidate) => candidate.id === id);
  if (!fixture) {
    throw new Error(`Fixture manifest is missing ${id}`);
  }
  return fixture;
}

async function readFixture(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(fixtureRoot, relativePath)));
}

function expectedErrorCode(fixture: Fixture): string {
  const outcome = fixture.provenance.expectedOutcome;
  const codes: Record<string, string> = {
    "unsafe-archive-path": "UNSAFE_ARCHIVE_PATH",
    "disallowed-media-mime": "DISALLOWED_MEDIA_MIME",
    "invalid-protobuf-media-map": "INVALID_PROTOBUF_MEDIA_MAP",
    "invalid-sqlite": "INVALID_SQLITE",
    "invalid-zstd": "INVALID_ZSTD",
    "unsupported-layout": "UNSUPPORTED_LAYOUT",
  };
  if (typeof outcome !== "string" || !codes[outcome]) {
    throw new Error(`${fixture.id} has no evidence error-code mapping`);
  }
  return codes[outcome];
}

async function writeEvidence(evidence: BrowserEvidence): Promise<void> {
  if (!evidenceOutput) {
    return;
  }
  await mkdir(dirname(resolve(evidenceOutput)), { recursive: true });
  await writeFile(
    resolve(evidenceOutput),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}
