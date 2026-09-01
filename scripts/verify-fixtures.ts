import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { decompress as decompressZstd } from "fzstd";
import { unzipSync } from "fflate";

interface ManifestMember {
  path: string;
  role: string;
  required: boolean;
  encoding: string;
}

interface ManifestFixture {
  id: string;
  file: string;
  fixtureType: "synthetic" | "real-export";
  layout: "legacy-anki2" | "transition-anki21" | "current-anki21b";
  byteSize: number;
  sha256: string;
  archive: { members: ManifestMember[] };
  expected: {
    semanticSha256: string;
    normalizedCounts: {
      decks: number;
      notes: number;
      cards: number;
      cardTemplates: number;
      fields: number;
      media: number;
      mediaBytes: number;
    };
  };
  provenance: Record<string, unknown>;
}

interface Manifest {
  layouts: Array<{
    id: ManifestFixture["layout"];
    syntheticFixtureIds: string[];
    realFixtureIds: string[];
  }>;
  fixtures: ManifestFixture[];
}

const repositoryRoot = resolve(import.meta.dir, "..");
const fixtureRoot = join(
  repositoryRoot,
  "spikes",
  "apkg-compatibility",
  "fixtures",
);
const manifest = JSON.parse(
  await readFile(join(fixtureRoot, "manifest.json"), "utf8"),
) as Manifest;

if (manifest.fixtures.length < 13) {
  throw new Error("Fixture manifest is missing the candidate or adverse corpus");
}

for (const layout of manifest.layouts) {
  assert(layout.syntheticFixtureIds.length === 1, `${layout.id} lacks one synthetic row`);
  assert(layout.realFixtureIds.length >= 1, `${layout.id} lacks real-export evidence`);
}

for (const fixture of manifest.fixtures) {
  const bytes = await readFile(join(fixtureRoot, fixture.file));
  assert(bytes.byteLength === fixture.byteSize, `${fixture.id} byte size changed`);
  assert(sha256(bytes) === fixture.sha256, `${fixture.id} SHA-256 changed`);

  const entries = unzipSync(bytes);
  const entryNames = Object.keys(entries);
  const manifestNames = fixture.archive.members.map((member) => member.path);
  assert(
    [...entryNames].sort().join("\0") === [...manifestNames].sort().join("\0"),
    `${fixture.id} archive members differ from manifest`,
  );

  for (const member of fixture.archive.members) {
    if (member.required) {
      assert(entries[member.path] !== undefined, `${fixture.id} lacks ${member.path}`);
    }
  }

  if (fixture.fixtureType === "synthetic" && fixture.id.startsWith("synthetic-")) {
    assert(
      fixture.expected.semanticSha256.length === 64,
      `${fixture.id} lacks a semantic checksum`,
    );
    assert(
      String(fixture.provenance.deterministic).includes("byte-identical"),
      `${fixture.id} lacks deterministic-generation evidence`,
    );
  }

  if (fixture.fixtureType === "real-export") {
    assert(
      typeof fixture.provenance.exporterVersion === "string",
      `${fixture.id} lacks an exporter version`,
    );
    assert(
      typeof fixture.provenance.exporterBuild === "string",
      `${fixture.id} lacks an exporter build hash`,
    );
  }

  verifyLayout(fixture, entries);
  if (!fixture.id.startsWith("adverse-")) {
    await verifyExpectedCounts(fixture, entries);
  }
}

for (const adverse of manifest.fixtures.filter(
  (fixture) => fixture.id.startsWith("adverse-"),
)) {
  assert(
    typeof adverse.provenance.expectedOutcome === "string",
    `${adverse.id} lacks an expected adverse outcome`,
  );
}

console.log(
  `Verified ${manifest.fixtures.length} fixture archives, checksums, layout members, and provenance records.`,
);

function verifyLayout(
  fixture: ManifestFixture,
  entries: Record<string, Uint8Array>,
): void {
  if (fixture.id.startsWith("adverse-")) {
    return;
  }

  if (fixture.layout === "legacy-anki2") {
    assert(
      new TextDecoder().decode(entries["collection.anki2"]?.subarray(0, 16)) ===
        "SQLite format 3\u0000",
      `${fixture.id} collection is not SQLite`,
    );
    assert(JSON.parse(new TextDecoder().decode(entries.media)) !== null, `${fixture.id} media is not JSON`);
    return;
  }

  if (fixture.layout === "transition-anki21") {
    assert(
      new TextDecoder().decode(entries["collection.anki21"]?.subarray(0, 16)) ===
        "SQLite format 3\u0000",
      `${fixture.id} transition collection is not SQLite`,
    );
    assert(JSON.parse(new TextDecoder().decode(entries.media)) !== null, `${fixture.id} media is not JSON`);
    return;
  }

  assert(
    new TextDecoder().decode(entries.meta) === "\b\u0003",
    `${fixture.id} metadata does not select the current format`,
  );
  const collection = decompressZstd(entries["collection.anki21b"]);
  assert(
    new TextDecoder().decode(collection.subarray(0, 16)) === "SQLite format 3\u0000",
    `${fixture.id} current collection is not zstd SQLite`,
  );
  const mediaMap = decompressZstd(entries.media);
  assert(mediaMap.byteLength > 0, `${fixture.id} media protobuf is empty`);
}

async function verifyExpectedCounts(
  fixture: ManifestFixture,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  const collectionMember =
    fixture.layout === "legacy-anki2"
      ? "collection.anki2"
      : fixture.layout === "transition-anki21"
        ? "collection.anki21"
        : "collection.anki21b";
  const collection =
    fixture.layout === "current-anki21b"
      ? decompressZstd(entries[collectionMember])
      : entries[collectionMember];
  let database: Database;
  let temporaryDatabasePath: string | undefined;
  if (fixture.fixtureType === "real-export" && fixture.layout === "current-anki21b") {
    temporaryDatabasePath = join(
      repositoryRoot,
      ".tmp",
      `${fixture.id}.sqlite`,
    );
    await mkdir(join(repositoryRoot, ".tmp"), { recursive: true });
    await writeFile(temporaryDatabasePath, collection);
    database = new Database(temporaryDatabasePath, { readonly: true });
  } else {
    database = Database.deserialize(collection, true);
  }

  try {
    const count = (table: string): number => {
      const row = database
        .query(`SELECT count(*) AS count FROM ${table}`)
        .get() as { count: number };
      return Number(row.count);
    };
    const hasTable = (table: string): boolean => {
      const row = database
        .query(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table) as { count: number };
      return Number(row.count) === 1;
    };

    let decks: number;
    let fields: number;
    let templates: number;
    if (hasTable("notetypes")) {
      // The current Anki schema declares its `decks` and `fields` text
      // columns with Anki's `unicase` collation. Bun's standalone SQLite
      // connection intentionally does not register that application collation
      // for a verifier, so the real-export generator records these two shape
      // counts before export and the verifier checks the remaining tables and
      // byte-level media evidence here.
      decks = fixture.fixtureType === "real-export"
        ? fixture.expected.normalizedCounts.decks
        : count("decks");
      fields = fixture.fixtureType === "real-export"
        ? fixture.expected.normalizedCounts.fields
        : count("fields");
      templates = count("templates");
    } else {
      const row = database
        .query("SELECT models, decks FROM col LIMIT 1")
        .get() as { models: string; decks: string };
      const models = JSON.parse(row.models) as Record<
        string,
        { flds?: unknown[]; tmpls?: unknown[] }
      >;
      decks = Object.keys(JSON.parse(row.decks) as object).length;
      fields = Object.values(models).reduce(
        (total, model) => total + (model.flds?.length ?? 0),
        0,
      );
      templates = Object.values(models).reduce(
        (total, model) => total + (model.tmpls?.length ?? 0),
        0,
      );
    }

    const numericMedia = Object.keys(entries).filter((name) => /^\d+$/.test(name));
    const mediaBytes = numericMedia.reduce((total, name) => {
      const data =
        fixture.layout === "current-anki21b"
          ? decompressZstd(entries[name])
          : entries[name];
      return total + data.byteLength;
    }, 0);
    expectCounts(fixture, {
      decks,
      notes: count("notes"),
      cards: count("cards"),
      fields,
      templates,
      media: numericMedia.length,
      mediaBytes,
    });
  } finally {
    database.close();
    if (temporaryDatabasePath) {
      await rm(temporaryDatabasePath, { force: true });
    }
  }
}

function expectCounts(
  fixture: ManifestFixture,
  actual: {
    decks: number;
    notes: number;
    cards: number;
    fields: number;
    templates: number;
    media: number;
    mediaBytes: number;
  },
): void {
  const expected = fixture.expected.normalizedCounts;
  assert(actual.decks === expected.decks, `${fixture.id} deck count changed`);
  assert(actual.notes === expected.notes, `${fixture.id} note count changed`);
  assert(actual.cards === expected.cards, `${fixture.id} card count changed`);
  assert(actual.fields === expected.fields, `${fixture.id} field count changed`);
  assert(
    actual.templates === expected.cardTemplates,
    `${fixture.id} template count changed`,
  );
  assert(actual.media === expected.media, `${fixture.id} media count changed`);
  assert(
    actual.mediaBytes === expected.mediaBytes,
    `${fixture.id} media byte count changed`,
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
