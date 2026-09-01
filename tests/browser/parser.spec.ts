import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  DEFAULT_PARSE_LIMITS,
  type ParserTerminalMessage,
} from "../../spikes/apkg-compatibility/src/protocol";

const fixtureRoot = resolve(
  "spikes",
  "apkg-compatibility",
  "fixtures",
);

const parserLimits = {
  ...DEFAULT_PARSE_LIMITS,
  maxParseTimeMs: 30_000,
};

test.describe("browser APKG parser contract", () => {
  test("transfers a package to the real Worker and emits monotonic staged progress", async ({
    page,
  }) => {
    const packageBytes = await readFixture("synthetic/legacy-anki2.apkg");
    const externalRequests: string[] = [];
    const expectedOrigin = new URL(
      process.env.APKG_BROWSER_BASE_URL ??
        `http://127.0.0.1:${process.env.APKG_BROWSER_PORT ?? "4173"}/`,
    ).origin;
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== expectedOrigin) {
        externalRequests.push(request.url());
      }
    });
    await page.goto("");
    const initialHeartbeat = Number(
      await page.locator("#heartbeat").getAttribute("data-heartbeat"),
    );

    const outcome = await page.evaluate(
      async ({ bytes, limits }) => {
        const progress: Array<{ stage: string; completed: number; total: number }> = [];
        const terminal = await window.apkgParserHarness.parse(
          new Uint8Array(bytes),
          {
            limits,
            checkpointDelayMs: 25,
            onProgress: (message) => progress.push(message),
          },
        );
        return { progress, terminal };
      },
      { bytes: [...packageBytes], limits: parserLimits },
    );

    expect(outcome.progress.map((message) => message.stage)).toEqual([
      "archive",
      "collection",
      "decompression",
      "database",
      "media",
      "sanitization",
    ]);
    expect(outcome.progress.map((message) => message.completed)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
    ]);
    expect(outcome.progress.every((message) => message.total === 6)).toBe(true);

    expect(outcome.terminal).toMatchObject({
      status: "success",
      commitReady: true,
      workerRuntime: "dedicated-worker",
    });
    if (outcome.terminal.status !== "success") {
      throw new Error("Expected a successful parser terminal");
    }
    expect(outcome.terminal.stagedResult).toMatchObject({
      layout: "legacy-anki2",
      collectionMember: "collection.anki2",
      archiveMembers: [
        { path: "0" },
        { path: "1" },
        { path: "collection.anki2" },
        { path: "media" },
      ],
      normalized: {
        media: [
          { name: "café.png", sourceMember: "0", byteLength: 68 },
          { name: "音声.txt", sourceMember: "1", byteLength: 47 },
        ],
      },
      validation: {
        sanitizer: "worker-whitelist",
      },
    });
    expect(outcome.terminal.stagedResult.packageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.terminal.stagedResult.validation.sqliteTables).toEqual(
      expect.arrayContaining(["col", "notes", "cards"]),
    );
    expect(outcome.terminal.stagedResult.normalized.media[0].bytes).toBeDefined();
    expect(externalRequests).toEqual([]);
    expect(Number(await page.locator("#heartbeat").getAttribute("data-heartbeat"))).toBeGreaterThan(
      initialHeartbeat,
    );
  });

  test("returns structured failures with no commit-ready staged records", async ({
    page,
  }) => {
    await page.goto("");
    const cases: Array<[string, string]> = [
      ["synthetic/invalid-sqlite.apkg", "INVALID_SQLITE"],
      ["synthetic/invalid-zstd.apkg", "INVALID_ZSTD"],
      ["synthetic/invalid-protobuf-media.apkg", "INVALID_PROTOBUF_MEDIA_MAP"],
      ["synthetic/invalid-media-declaration.apkg", "INVALID_PROTOBUF_MEDIA_MAP"],
      ["synthetic/invalid-media-json.apkg", "INVALID_PROTOBUF_MEDIA_MAP"],
      ["synthetic/traversal-media.apkg", "UNSAFE_ARCHIVE_PATH"],
      ["synthetic/absolute-archive-path.apkg", "UNSAFE_ARCHIVE_PATH"],
      ["synthetic/traversal-archive-path.apkg", "UNSAFE_ARCHIVE_PATH"],
      ["synthetic/duplicate-normalized-archive-path.apkg", "UNSAFE_ARCHIVE_PATH"],
      ["synthetic/disallowed-media-mime.apkg", "DISALLOWED_MEDIA_MIME"],
      ["synthetic/unknown-layout.apkg", "UNSUPPORTED_LAYOUT"],
    ];

    for (const [fixture, code] of cases) {
      const packageBytes = await readFixture(fixture);
      const outcome = await parseInPage(page, packageBytes);
      expect(outcome.status, fixture).not.toBe("success");
      expect(outcome.commitReady, fixture).toBe(false);
      expect(outcome.stagedResult, fixture).toBeNull();
      expect(outcome.diagnostic.code, fixture).toBe(code);
    }

    const invalidZip = await page.evaluate(
      async (limits) =>
        window.apkgParserHarness.parse(new Uint8Array([1, 2, 3]), { limits }),
      parserLimits,
    );
    expect(invalidZip).toMatchObject({
      status: "error",
      commitReady: false,
      stagedResult: null,
      diagnostic: { code: "INVALID_ZIP", stage: "archive" },
    });

    const archiveLimit = await page.evaluate(
      async ({ bytes, limits }) =>
        window.apkgParserHarness.parse(new Uint8Array(bytes), {
          limits: { ...limits, maxPackageBytes: 1 },
        }),
      { bytes: [...(await readFixture("synthetic/legacy-anki2.apkg"))], limits: parserLimits },
    );
    expect(archiveLimit).toMatchObject({
      status: "error",
      commitReady: false,
      stagedResult: null,
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED", stage: "archive" },
    });

    const parseLimit = await page.evaluate(
      async ({ bytes, limits }) =>
        window.apkgParserHarness.parse(new Uint8Array(bytes), {
          limits: { ...limits, maxParseTimeMs: 1 },
          checkpointDelayMs: 10,
        }),
      { bytes: [...(await readFixture("synthetic/legacy-anki2.apkg"))], limits: parserLimits },
    );
    expect(parseLimit).toMatchObject({
      status: "error",
      commitReady: false,
      stagedResult: null,
      diagnostic: { code: "PARSE_LIMIT_EXCEEDED", stage: "archive" },
    });
  });

  test("exercises the transition and current zstd/protobuf layout branches", async ({
    page,
  }) => {
    await page.goto("");
    for (const [fixture, layout] of [
      ["synthetic/transition-anki21.apkg", "transition-anki21"],
      ["synthetic/current-anki21b.apkg", "current-anki21b"],
    ] as const) {
      const packageBytes = await readFixture(fixture);
      const outcome = await parseInPage(page, packageBytes);
      expect(outcome).toMatchObject({
        status: "success",
        commitReady: true,
        stagedResult: { layout },
      });
    }
  });

  test("sanitizes card content while preserving safe markup and reports warnings", async ({
    page,
  }) => {
    await page.goto("");
    const outcome = await parseSuccessInPage(
      page,
      await readFixture("synthetic/sanitization-warning.apkg"),
    );
    const { normalized, warnings } = outcome.stagedResult;
    const firstNote = normalized.notes[0];

    expect(firstNote.fields[0]).toContain("<strong>café</strong>");
    expect(firstNote.fields[0]).toContain('src="café.png"');
    expect(firstNote.fields[0]).not.toMatch(/script|form|iframe|onfocus|onerror|evil\.invalid/i);
    expect(firstNote.fields[1]).toContain("{{type:Front}}");
    expect(firstNote.fields[1]).toContain("{{tts en_US:Front}}");
    expect(firstNote.fields[1]).toContain("[$]x^2[/]");
    expect(firstNote.fields[1]).not.toContain("src=\"missing.png\"");

    expect(normalized.cardTemplates[0].questionFormat).toContain("{{#unsupported}}");
    expect(normalized.css).toContain("color: green");
    expect(normalized.css).not.toMatch(/@import|url\s*\(|evil\.invalid/i);
    expect(warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "UNSAFE_HTML_REMOVED",
        "MISSING_MEDIA",
        "UNSUPPORTED_TEMPLATE_FEATURE",
        "TYPE_ANSWER",
        "TTS",
        "LATEX",
        "JAVASCRIPT",
      ]),
    );
    expect(warnings.every((warning) => warning.detail)).toBe(true);
  });

  test("enforces configured limits at the measured boundary and below it", async ({
    page,
  }) => {
    await page.goto("");
    const packageBytes = await readFixture("synthetic/legacy-anki2.apkg");
    const baseline = await parseSuccessInPage(page, packageBytes);
    const members = baseline.stagedResult.archiveMembers;
    const requiredExpandedBytes = Math.max(
      members.reduce((total, member) => total + member.expandedBytes, 0),
      baseline.stagedResult.validation.expandedBytes,
    );
    const maximumEntryBytes = Math.max(
      ...members.map((member) => member.expandedBytes),
    );
    const maximumCompressionRatio = Math.max(
      ...members.map((member) => member.expandedBytes / member.compressedBytes),
    );
    const parse = (limits: typeof parserLimits) => page.evaluate(
      async ({ bytes, limits: requestLimits }) =>
        window.apkgParserHarness.parse(new Uint8Array(bytes), {
          limits: requestLimits,
        }),
      { bytes: [...packageBytes], limits },
    );

    await expect(parse({
      ...parserLimits,
      maxPackageBytes: packageBytes.byteLength,
    })).resolves.toMatchObject({ status: "success", commitReady: true });
    await expect(parse({
      ...parserLimits,
      maxPackageBytes: packageBytes.byteLength - 1,
    })).resolves.toMatchObject({
      status: "error",
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });

    await expect(parse({
      ...parserLimits,
      maxArchiveEntries: members.length,
    })).resolves.toMatchObject({ status: "success", commitReady: true });
    await expect(parse({
      ...parserLimits,
      maxArchiveEntries: members.length - 1,
    })).resolves.toMatchObject({
      status: "error",
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });

    await expect(parse({
      ...parserLimits,
      maxExpandedBytes: requiredExpandedBytes,
    })).resolves.toMatchObject({ status: "success", commitReady: true });
    await expect(parse({
      ...parserLimits,
      maxExpandedBytes: requiredExpandedBytes - 1,
    })).resolves.toMatchObject({
      status: "error",
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });

    await expect(parse({
      ...parserLimits,
      maxEntryBytes: maximumEntryBytes,
    })).resolves.toMatchObject({ status: "success", commitReady: true });
    await expect(parse({
      ...parserLimits,
      maxEntryBytes: maximumEntryBytes - 1,
    })).resolves.toMatchObject({
      status: "error",
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });

    await expect(parse({
      ...parserLimits,
      maxCompressionRatio: maximumCompressionRatio,
    })).resolves.toMatchObject({ status: "success", commitReady: true });
    await expect(parse({
      ...parserLimits,
      maxCompressionRatio: maximumCompressionRatio * (1 - 1e-9),
    })).resolves.toMatchObject({
      status: "error",
      diagnostic: { code: "ARCHIVE_LIMIT_EXCEEDED" },
    });

    const peakMemoryBytes = baseline.stagedResult.validation.peakMemoryBytes;
    await expect(parse({
      ...parserLimits,
      maxMemoryBytes: peakMemoryBytes,
    })).resolves.toMatchObject({ status: "success", commitReady: true });
    await expect(parse({
      ...parserLimits,
      maxMemoryBytes: peakMemoryBytes - 1,
    })).resolves.toMatchObject({
      status: "error",
      diagnostic: { code: "MEMORY_LIMIT_EXCEEDED" },
    });
  });

  test("cancellation at CPU-heavy stage boundaries has no partial result", async ({
    page,
  }) => {
    await page.goto("");
    const packageBytes = await readFixture("synthetic/legacy-anki2.apkg");
    for (const stage of ["decompression", "database", "media", "sanitization"] as const) {
      const terminal = await page.evaluate(
        async ({ bytes, limits, cancelStage }) =>
          window.apkgParserHarness.parse(new Uint8Array(bytes), {
            limits,
            checkpointDelayMs: 10,
            onProgress: (message) => {
              if (message.stage === cancelStage) {
                window.apkgParserHarness.cancel();
              }
            },
          }),
        { bytes: [...packageBytes], limits: parserLimits, cancelStage: stage },
      );
      expect(terminal, stage).toMatchObject({
        status: "cancelled",
        commitReady: false,
        stagedResult: null,
        diagnostic: { code: "CANCELLED" },
      });
    }
  });

  test("normalizes every supported synthetic and real-export matrix row", async ({
    page,
  }) => {
    await page.goto("");
    const cases = [
      {
        fixture: "synthetic/legacy-anki2.apkg",
        layout: "legacy-anki2",
        decks: 2,
        fields: 3,
        cardTemplates: 2,
      },
      {
        fixture: "synthetic/transition-anki21.apkg",
        layout: "transition-anki21",
        decks: 2,
        fields: 3,
        cardTemplates: 2,
      },
      {
        fixture: "synthetic/current-anki21b.apkg",
        layout: "current-anki21b",
        decks: 2,
        fields: 3,
        cardTemplates: 2,
      },
      {
        fixture: "real/anki-2.1.49-legacy.apkg",
        layout: "legacy-anki2",
        decks: 3,
        fields: 5,
        cardTemplates: 3,
      },
      {
        fixture: "real/anki-25.9.4-transition.apkg",
        layout: "transition-anki21",
        decks: 3,
        fields: 5,
        cardTemplates: 3,
      },
      {
        fixture: "real/anki-25.9.4-current.colpkg",
        layout: "current-anki21b",
        decks: 3,
        fields: 3,
        cardTemplates: 2,
      },
    ] as const;

    for (const testCase of cases) {
      let outcome;
      try {
        outcome = await parseSuccessInPage(
          page,
          await readFixture(testCase.fixture),
        );
      } catch (error) {
        throw new Error(
          `${testCase.fixture}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      expect(outcome.status, testCase.fixture).toBe("success");
      expect(outcome.stagedResult.layout, testCase.fixture).toBe(testCase.layout);

      const normalized = outcome.stagedResult.normalized;
      expect(normalized.decks, testCase.fixture).toHaveLength(testCase.decks);
      expect(normalized.notes, testCase.fixture).toHaveLength(2);
      expect(normalized.cards, testCase.fixture).toHaveLength(4);
      expect(normalized.cardTemplates, testCase.fixture).toHaveLength(
        testCase.cardTemplates,
      );
      expect(normalized.fields, testCase.fixture).toHaveLength(testCase.fields);
      expect(normalized.media, testCase.fixture).toHaveLength(2);
      expect(normalized.decks.map((deck) => deck.name), testCase.fixture).toEqual(
        testCase.decks === 2
          ? ["P0B Fixture", "P0B Fixture::子 deck"]
          : ["Default", "P0B Fixture", "P0B Fixture::子 deck"],
      );
      expect(
        normalized.notes.map((note) => ({
          fields: note.fields,
          tags: note.tags,
          hasSourceGuid: note.sourceGuid.length > 0,
        })),
        testCase.fixture,
      ).toEqual([
        {
          fields: [
            "こんにちは / café",
            '<img src="café.png"> [sound:音声.txt]\nAnswer α',
            "Context in the parent deck",
          ],
          tags: ["media", "unicode"],
          hasSourceGuid: true,
        },
        {
          fields: ["Second note", "Réponse β", "子 deck context"],
          tags: ["templates"],
          hasSourceGuid: true,
        },
      ]);
      expect(
        normalized.media.map(({ name, byteLength }) => ({ name, byteLength })),
        testCase.fixture,
      ).toEqual([
        { name: "café.png", byteLength: 68 },
        { name: "音声.txt", byteLength: 47 },
      ]);
      expect(normalized.cardTemplates.every((template) =>
        template.questionFormat.length > 0 && template.answerFormat.length > 0,
      ), testCase.fixture).toBe(true);
      expect(normalized.cards.every((card) => card.scheduling === "fresh"),
        testCase.fixture).toBe(true);
      expect(normalized.css, testCase.fixture).toContain(".card");

      const repeated = await parseSuccessInPage(
        page,
        await readFixture(testCase.fixture),
      );
      expect(normalizedSnapshot(repeated.stagedResult.normalized), testCase.fixture)
        .toBe(normalizedSnapshot(normalized));
    }
  });

  test("cancellation emits one non-commit terminal and exposes no late success", async ({
    page,
  }) => {
    await page.goto("");
    const packageBytes = await readFixture("synthetic/legacy-anki2.apkg");
    const outcome = await page.evaluate(
      async ({ bytes, limits }) => {
        const progress: string[] = [];
        const terminal = await window.apkgParserHarness.parse(
          new Uint8Array(bytes),
          {
            limits,
            checkpointDelayMs: 100,
            onProgress: (message) => {
              progress.push(message.stage);
              if (message.stage === "database") {
                window.apkgParserHarness.cancel();
              }
            },
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { progress, terminal };
      },
      { bytes: [...packageBytes], limits: parserLimits },
    );

    expect(outcome.progress).toEqual([
      "archive",
      "collection",
      "decompression",
      "database",
    ]);
    expect(outcome.terminal).toMatchObject({
      status: "cancelled",
      commitReady: false,
      stagedResult: null,
      diagnostic: {
        code: "CANCELLED",
      },
    });
  });

  test("superseded operation messages cannot settle the replacement", async ({ page }) => {
    await page.goto("");
    const packageBytes = await readFixture("synthetic/legacy-anki2.apkg");
    const outcome = await page.evaluate(
      async ({ bytes, limits }) => {
        const first = window.apkgParserHarness.parse(new Uint8Array(bytes), {
          limits,
          checkpointDelayMs: 100,
        });
        void first.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 125));
        return window.apkgParserHarness.replace(new Uint8Array(bytes), {
          limits,
          checkpointDelayMs: 0,
        });
      },
      { bytes: [...packageBytes], limits: parserLimits },
    );
    expect(outcome).toMatchObject({
      status: "success",
      commitReady: true,
      stagedResult: { layout: "legacy-anki2" },
    });
  });
});

async function readFixture(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(fixtureRoot, relativePath)));
}

async function parseInPage(
  page: Page,
  packageBytes: Uint8Array,
): Promise<Extract<ParserTerminalMessage, { status: "error" | "unsupported" }>> {
  return page.evaluate(
    async ({ bytes, limits }) =>
      window.apkgParserHarness.parse(new Uint8Array(bytes), { limits }),
    { bytes: [...packageBytes], limits: parserLimits },
  ) as Promise<Extract<ParserTerminalMessage, { status: "error" | "unsupported" }>>;
}

async function parseSuccessInPage(
  page: Page,
  packageBytes: Uint8Array,
): Promise<Extract<ParserTerminalMessage, { status: "success" }>> {
  const outcome = await page.evaluate(
    async ({ bytes, limits }) =>
      window.apkgParserHarness.parse(new Uint8Array(bytes), { limits }),
    { bytes: [...packageBytes], limits: parserLimits },
  );
  if (outcome.status !== "success") {
    throw new Error(
      `Expected a successful parser terminal, got ${outcome.status}: ${JSON.stringify(outcome.diagnostic)}`,
    );
  }
  return outcome;
}

function normalizedSnapshot(
  normalized: Extract<ParserTerminalMessage, { status: "success" }>["stagedResult"]["normalized"],
): string {
  return JSON.stringify({
    ...normalized,
    // ArrayBuffer contents are covered by the media byte length/SHA-1
    // assertions; omit the transferable payload for the record comparison.
    media: normalized.media.map(({ bytes: _bytes, ...media }) => media),
  });
}
