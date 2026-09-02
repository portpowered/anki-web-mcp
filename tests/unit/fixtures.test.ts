import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { decompress as decompressZstd } from "fzstd";
import { unzipSync } from "fflate";

interface Fixture {
  id: string;
  file: string;
  fixtureType: "synthetic" | "real-export";
  layout: "legacy-anki2" | "transition-anki21" | "current-anki21b";
  supportStatus: "candidate" | "adverse";
  byteSize: number;
  sha256: string;
  archive: { members: Array<{ path: string; required: boolean }> };
  expected: {
    normalizedCounts: {
      decks: number;
      notes: number;
      cards: number;
      cardTemplates: number;
      fields: number;
      media: number;
      mediaBytes: number;
    };
    semanticSha256: string;
    normalized: {
      decks: Array<{ name: string }>;
      notes: Array<{ fields: string[] }>;
      media: Array<{ name: string; bytes: number }>;
      templates: Array<{ name: string; ordinal: number }>;
    };
    warnings: Array<{ code: string; sourceKind: string }>;
  };
  provenance: Record<string, unknown>;
}

interface FixtureManifest {
  schemaVersion: number;
  purpose: string;
  layouts: Array<{
    id: Fixture["layout"];
    collectionMember: string;
    syntheticFixtureIds: string[];
    realFixtureIds: string[];
    supportClaim: string;
  }>;
  coverage: {
    normalizedContent: Record<string, string[]>;
    adverseInputs: Record<string, string[]>;
    configurableLimitBases: Record<string, string[]>;
  };
  fixtures: Fixture[];
}

const repositoryRoot = resolve(import.meta.dir, "../..");
const fixtureRoot = join(
  repositoryRoot,
  "spikes",
  "apkg-compatibility",
  "fixtures",
);
const manifest = JSON.parse(
  await readFile(join(fixtureRoot, "manifest.json"), "utf8"),
) as FixtureManifest;
const fixtures = new Map(manifest.fixtures.map((fixture) => [fixture.id, fixture]));
const matrixSyntheticIds = new Set(
  manifest.layouts.map((layout) => layout.syntheticFixtureIds[0]),
);

test("each candidate layout has synthetic and real-export evidence", () => {
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.purpose).toContain("production import tests");

  for (const layout of manifest.layouts) {
    expect(layout.syntheticFixtureIds).toHaveLength(1);
    expect(layout.realFixtureIds).toHaveLength(1);
    expect(fixtures.get(layout.syntheticFixtureIds[0])?.layout).toBe(layout.id);
    expect(fixtures.get(layout.realFixtureIds[0])?.layout).toBe(layout.id);
    expect(layout.supportClaim).toContain("public import outcomes");
  }
});

test("synthetic layout fixtures carry the same normalized expectation", async () => {
  const synthetic = manifest.fixtures.filter(
    (fixture) =>
      fixture.fixtureType === "synthetic" &&
      matrixSyntheticIds.has(fixture.id),
  );
  expect(synthetic).toHaveLength(3);
  const first = synthetic[0].expected;

  for (const fixture of synthetic) {
    expect(fixture.expected).toEqual(first);
    const archive = unzipSync(
      await readFile(join(fixtureRoot, fixture.file)),
    );
    for (const member of fixture.archive.members) {
      if (member.required) {
        expect(archive[member.path]).toBeDefined();
      }
    }
    const collectionMember =
      fixture.layout === "legacy-anki2"
        ? "collection.anki2"
        : fixture.layout === "transition-anki21"
          ? "collection.anki21"
          : "collection.anki21b";
    const collection =
      fixture.layout === "current-anki21b"
        ? decompressZstd(archive[collectionMember])
        : archive[collectionMember];
    expect(new TextDecoder().decode(collection.subarray(0, 16))).toBe(
      "SQLite format 3\u0000",
    );
  }
});

test("real snapshots record exact exporter provenance and immutable bytes", async () => {
  const real = manifest.fixtures.filter(
    (fixture) => fixture.fixtureType === "real-export",
  );
  expect(real).toHaveLength(3);

  const expectedExporters: Record<Fixture["layout"], string> = {
    "legacy-anki2": "2.1.49",
    "transition-anki21": "25.09.4",
    "current-anki21b": "25.09.4",
  };

  for (const fixture of real) {
    const bytes = await readFile(join(fixtureRoot, fixture.file));
    expect(bytes.byteLength).toBe(fixture.byteSize);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      fixture.sha256,
    );
    expect(fixture.provenance.exporter).toBe("Anki");
    expect(fixture.provenance.exporterVersion).toBe(
      expectedExporters[fixture.layout],
    );
    expect(fixture.provenance.exporterBuild).toMatch(/^[0-9a-f]+$/);
    expect(fixture.provenance.contentLicense).toContain("repository MIT");
    expect(fixture.provenance.redistributionBasis).toContain("no Anki source");
    expect(fixture.provenance.generator).toBe(
      "scripts/generate-real-fixtures.py",
    );
    expect(fixture.expected.semanticSha256).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("the production scenario matrix references auditable corpus rows", () => {
  const coverageGroups = [
    manifest.coverage.normalizedContent,
    manifest.coverage.adverseInputs,
    manifest.coverage.configurableLimitBases,
  ];

  for (const group of coverageGroups) {
    for (const [scenario, fixtureIds] of Object.entries(group)) {
      expect(scenario.length).toBeGreaterThan(0);
      expect(fixtureIds.length).toBeGreaterThan(0);
      for (const fixtureId of fixtureIds) {
        expect(fixtures.has(fixtureId)).toBe(true);
      }
    }
  }

  expect(Object.keys(manifest.coverage.configurableLimitBases).sort()).toEqual([
    "archiveEntries",
    "cancellationCheckpoints",
    "compressionRatio",
    "entryBytes",
    "expandedBytes",
    "mediaBytes",
    "mediaCount",
    "mediaFileBytes",
    "packageBytes",
    "parseTime",
    "utf8Bytes",
  ]);
  expect(Object.keys(manifest.coverage.adverseInputs).sort()).toEqual([
    "activeContent",
    "archivePath",
    "disallowedMime",
    "invalidMediaMap",
    "invalidSqlite",
    "invalidZstd",
    "mediaPath",
    "nestedArchive",
    "unsupportedLayout",
  ]);
});

test("candidate fixtures cover relationships, Unicode, media, templates, and warnings", () => {
  const requiredContent = manifest.coverage.normalizedContent;
  expect(requiredContent.multiDeckRelationships).toHaveLength(6);
  expect(requiredContent.unicode).toHaveLength(3);
  expect(requiredContent.textImageShortAudio).toHaveLength(3);
  expect(requiredContent.templates).toHaveLength(3);
  expect(requiredContent.warningBearingContent).toEqual([
    "sanitization-warning",
  ]);
  expect(
    fixtures.get("sanitization-warning")?.expected.warnings,
  ).toEqual([
    { code: "UNSAFE_CONTENT_REMOVED", sourceKind: "note" },
    { code: "UNSUPPORTED_TEMPLATE_FEATURE", sourceKind: "template" },
    { code: "MISSING_MEDIA", sourceKind: "media" },
  ]);

  for (const fixtureId of new Set(Object.values(requiredContent).flat())) {
    const fixture = fixtures.get(fixtureId);
    expect(fixture).toBeDefined();
    expect(fixture?.expected.normalizedCounts.decks).toBeGreaterThanOrEqual(2);
    expect(fixture?.expected.normalizedCounts.notes).toBe(2);
    expect(fixture?.expected.normalizedCounts.cards).toBe(4);
    expect(fixture?.expected.normalizedCounts.cardTemplates).toBeGreaterThanOrEqual(2);
  }

  for (const fixtureId of requiredContent.textImageShortAudio) {
    const fixture = fixtures.get(fixtureId);
    expect(fixture?.expected.normalizedCounts.media).toBe(2);
    expect(fixture?.expected.normalizedCounts.mediaBytes).toBeGreaterThan(0);
    expect(fixture?.provenance.contentLicense).toContain("repository MIT");
    expect(fixture?.expected.normalized.media.map((media) => media.name)).toEqual([
      "café.png",
      "音声.wav",
    ]);
    expect(
      fixture?.expected.normalized.notes.some((note) =>
        note.fields.some((field) => field.includes("[sound:音声.wav]"))
      ),
    ).toBe(true);
  }
});

test("adverse fixtures expose a stable expected outcome without normalized data", () => {
  const adverse = manifest.fixtures.filter((fixture) =>
    fixture.id.startsWith("adverse-"),
  );
  expect(adverse.length).toBeGreaterThanOrEqual(7);
  for (const fixture of adverse) {
    expect(fixture.supportStatus).toBe("adverse");
    expect(fixture.provenance.expectedOutcome).toEqual(expect.any(String));
    expect(fixture.expected.normalizedCounts).toEqual({
      decks: 0,
      notes: 0,
      cards: 0,
      cardTemplates: 0,
      fields: 0,
      media: 0,
      mediaBytes: 0,
    });
    expect(fixture.expected.semanticSha256).toBe("");
    expect(fixture.expected.warnings).toEqual([]);
  }
});
