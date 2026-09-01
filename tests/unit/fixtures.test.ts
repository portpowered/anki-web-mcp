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
  };
  provenance: Record<string, unknown>;
}

interface FixtureManifest {
  layouts: Array<{
    id: Fixture["layout"];
    syntheticFixtureIds: string[];
    realFixtureIds: string[];
  }>;
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
  for (const layout of manifest.layouts) {
    expect(layout.syntheticFixtureIds).toHaveLength(1);
    expect(layout.realFixtureIds.length).toBeGreaterThan(0);
    expect(fixtures.get(layout.syntheticFixtureIds[0])?.layout).toBe(layout.id);
    expect(fixtures.get(layout.realFixtureIds[0])?.layout).toBe(layout.id);
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

  for (const fixture of real) {
    const bytes = await readFile(join(fixtureRoot, fixture.file));
    expect(bytes.byteLength).toBe(fixture.byteSize);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      fixture.sha256,
    );
    expect(fixture.provenance.exporter).toBe("Anki");
    expect(fixture.provenance.exporterVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fixture.provenance.exporterBuild).toMatch(/^[0-9a-f]+$/);
    expect(fixture.provenance.contentLicense).toContain("repository MIT");
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
  }
});
