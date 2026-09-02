import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { zipSync, type Zippable } from "fflate";

const repositoryRoot = resolve(import.meta.dir, "..");
const fixtureRoot = join(
  repositoryRoot,
  "spikes",
  "apkg-compatibility",
  "fixtures",
);
const syntheticRoot = join(fixtureRoot, "synthetic");
const zipTimestamp = new Date(1980, 0, 1, 0, 0, 0);
const textEncoder = new TextEncoder();

const layoutIds = [
  "legacy-anki2",
  "transition-anki21",
  "current-anki21b",
] as const;
type LayoutId = (typeof layoutIds)[number];

interface MediaFixture {
  name: string;
  bytes: Uint8Array;
}

interface NormalizedExpectation {
  decks: Array<{ id: string; name: string }>;
  fields: string[];
  media: Array<{ name: string; sha1: string; bytes: number }>;
  notes: Array<{
    sourceGuid: string;
    fields: string[];
    tags: string[];
  }>;
  templates: Array<{ name: string; ordinal: number }>;
}

interface FixtureRecord {
  id: string;
  file: string;
  fixtureType: "synthetic" | "real-export";
  layout: LayoutId;
  packageKind: "deck-apkg" | "collection-colpkg";
  supportStatus: "candidate" | "adverse";
  byteSize: number;
  sha256: string;
  archive: {
    members: Array<{
      path: string;
      role: string;
      required: boolean;
      encoding: "stored" | "deflate" | "zstd" | "protobuf" | "json";
    }>;
  };
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
    normalized: NormalizedExpectation;
    warnings: Array<{
      code: "UNSAFE_CONTENT_REMOVED" | "UNSUPPORTED_TEMPLATE_FEATURE" | "MISSING_MEDIA";
      sourceKind: "note" | "template" | "media";
    }>;
  };
  provenance: Record<string, unknown>;
}

interface CollectionContentOverrides {
  notes?: NormalizedExpectation["notes"];
  templates?: Array<{
    name: string;
    ordinal: number;
    qfmt: string;
    afmt: string;
  }>;
  css?: string;
}

const mediaFixtures: MediaFixture[] = [
  {
    name: "café.png",
    // A 1x1 transparent PNG. It is a fixture byte sequence, not copied deck
    // content.
    bytes: decodeBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ),
  },
  {
    name: "音声.wav",
    // A one-sample, 8 kHz, mono PCM WAV made specifically for this corpus.
    bytes: bytes(
      0x52, 0x49, 0x46, 0x46, 0x25, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
      0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00,
      0x01, 0x00, 0x08, 0x00, 0x64, 0x61, 0x74, 0x61,
      0x01, 0x00, 0x00, 0x00, 0x80,
    ),
  },
];

const normalizedExpectation: NormalizedExpectation = {
  decks: [
    { id: "2000000000001", name: "P0B Fixture" },
    { id: "2000000000002", name: "P0B Fixture::子 deck" },
  ],
  fields: ["Front", "Back", "Context"],
  media: mediaFixtures.map((media) => ({
    name: media.name,
    sha1: sha1(media.bytes),
    bytes: media.bytes.byteLength,
  })),
  notes: [
    {
      sourceGuid: "fixture-guid-alpha",
      fields: [
        "こんにちは / café",
        '<img src="café.png"> [sound:音声.wav]\nAnswer α',
        "Context in the parent deck",
      ],
      tags: ["media", "unicode"],
    },
    {
      sourceGuid: "fixture-guid-beta",
      fields: [
        "Second note",
        "Réponse β",
        "子 deck context",
      ],
      tags: ["templates"],
    },
  ],
  templates: [
    { name: "Card 1", ordinal: 0 },
    { name: "Card 2", ordinal: 1 },
  ],
};

const normalizedCounts = {
  decks: normalizedExpectation.decks.length,
  notes: normalizedExpectation.notes.length,
  cards: normalizedExpectation.notes.length * normalizedExpectation.templates.length,
  cardTemplates: normalizedExpectation.templates.length,
  fields: normalizedExpectation.fields.length,
  media: normalizedExpectation.media.length,
  mediaBytes: normalizedExpectation.media.reduce(
    (total, media) => total + media.bytes,
    0,
  ),
};

const semanticSha256 = sha256(
  textEncoder.encode(JSON.stringify(normalizedExpectation)),
);

await mkdir(syntheticRoot, { recursive: true });

const collectionBytes = serializeCollection(true);
const dummyCollectionBytes = serializeCollection(false);
const sanitizationCollectionBytes = serializeCollection(true, {
  notes: [
    {
      sourceGuid: "fixture-guid-alpha",
      fields: [
        '<p>安全 <strong>café</strong></p><script>alert("blocked")</script>' +
          '<form action="https://evil.invalid"><input onfocus="steal()"></form>' +
          '<iframe src="https://evil.invalid">frame</iframe>' +
          '<a href="https://evil.invalid">external link</a>' +
          '<img src="café.png" alt="safe" onerror="steal()">',
        "{{type:Front}} {{tts en_US:Front}} [$]x^2[/] <img src=\"missing.png\">",
        "Context in the parent deck",
      ],
      tags: ["media", "unicode"],
    },
    {
      sourceGuid: "fixture-guid-beta",
      fields: [
        "Second note",
        "Réponse β",
        "子 deck context",
      ],
      tags: ["templates"],
    },
  ],
  templates: [
    {
      name: "Card 1",
      ordinal: 0,
      qfmt: "<p>{{Front}}</p>{{#unsupported}}ignored{{/unsupported}}",
      afmt: "{{FrontSide}}<hr id=answer>{{Back}}",
    },
    {
      name: "Card 2",
      ordinal: 1,
      qfmt: "{{Context}}",
      afmt: "{{FrontSide}}<hr id=answer>{{Back}}",
    },
  ],
  css: '@import url("https://evil.invalid/style.css"); .card { background: url(https://evil.invalid/p.png); color: green; }',
});
const mediaMapJson = textEncoder.encode(
  JSON.stringify(Object.fromEntries(mediaFixtures.map((media, index) => [String(index), media.name]))),
);
const mediaMapProtobuf = encodeMediaEntries(mediaFixtures);
const invalidMediaMapProtobuf = encodeMediaEntries(mediaFixtures, {
  declaredBytesDelta: 1,
});

const generatedArchives: Record<LayoutId, Uint8Array> = {
  "legacy-anki2": buildLegacyArchive(collectionBytes, mediaMapJson),
  "transition-anki21": buildTransitionArchive(
    collectionBytes,
    dummyCollectionBytes,
    mediaMapJson,
  ),
  "current-anki21b": buildCurrentArchive(
    collectionBytes,
    dummyCollectionBytes,
    mediaMapProtobuf,
  ),
};

for (const [layout, archive] of Object.entries(generatedArchives) as Array<[
  LayoutId,
  Uint8Array,
]>) {
  await writeFile(
    join(syntheticRoot, `${layout}.apkg`),
    archive,
  );
}

await writeFile(
  join(syntheticRoot, "sanitization-warning.apkg"),
  buildLegacyArchive(sanitizationCollectionBytes, mediaMapJson),
);

const adverseArchives: Array<{
  id: string;
  layout: LayoutId;
  filename: string;
  packageKind: "deck-apkg" | "collection-colpkg";
  purpose: string;
  expectedOutcome: string;
  archive: Uint8Array;
  members: FixtureRecord["archive"]["members"];
}> = [
  {
    id: "adverse-invalid-sqlite",
    layout: "legacy-anki2",
    filename: "invalid-sqlite.apkg",
    packageKind: "deck-apkg",
    purpose: "Valid ZIP with a non-SQLite collection payload.",
    expectedOutcome: "invalid-sqlite",
    archive: buildArchive({
      "collection.anki2": textEncoder.encode("not a SQLite database"),
      media: textEncoder.encode("{}"),
    }),
    members: [
      member("collection.anki2", "collection", true, "deflate"),
      member("media", "media-map", true, "json"),
    ],
  },
  {
    id: "adverse-traversal-media",
    layout: "legacy-anki2",
    filename: "traversal-media.apkg",
    packageKind: "deck-apkg",
    purpose: "Media map contains a parent traversal path.",
    expectedOutcome: "unsafe-archive-path",
    archive: buildArchive({
      "collection.anki2": collectionBytes,
      media: textEncoder.encode('{"0":"../outside.txt"}'),
      "0": textEncoder.encode("path traversal probe"),
    }),
    members: [
      member("collection.anki2", "collection", true, "deflate"),
      member("media", "media-map", true, "json"),
      member("0", "media-bytes", true, "stored"),
    ],
  },
  {
    id: "adverse-duplicate-normalized-media",
    layout: "legacy-anki2",
    filename: "duplicate-normalized-media.apkg",
    packageKind: "deck-apkg",
    purpose: "Two media names normalize to the same NFC path.",
    expectedOutcome: "unsafe-archive-path",
    archive: buildArchive({
      "collection.anki2": collectionBytes,
      media: textEncoder.encode('{"0":"é.txt","1":"é.txt"}'),
      "0": textEncoder.encode("first normalized name"),
      "1": textEncoder.encode("second normalized name"),
    }),
    members: [
      member("collection.anki2", "collection", true, "deflate"),
      member("media", "media-map", true, "json"),
      member("0", "media-bytes", true, "stored"),
      member("1", "media-bytes", true, "stored"),
    ],
  },
  {
    id: "adverse-absolute-archive-path",
    layout: "legacy-anki2",
    filename: "absolute-archive-path.apkg",
    packageKind: "deck-apkg",
    purpose: "ZIP contains an absolute member path.",
    expectedOutcome: "unsafe-archive-path",
    archive: buildArchive({
      "collection.anki2": collectionBytes,
      media: mediaMapJson,
      "/absolute.txt": textEncoder.encode("absolute path probe"),
    }),
    members: [
      member("collection.anki2", "collection", true, "deflate"),
      member("media", "media-map", true, "json"),
      member("/absolute.txt", "unsafe-member", true, "stored"),
    ],
  },
  {
    id: "adverse-traversal-archive-path",
    layout: "legacy-anki2",
    filename: "traversal-archive-path.apkg",
    packageKind: "deck-apkg",
    purpose: "ZIP contains a parent-traversing member path.",
    expectedOutcome: "unsafe-archive-path",
    archive: buildArchive({
      "collection.anki2": collectionBytes,
      media: mediaMapJson,
      "../outside.txt": textEncoder.encode("archive traversal probe"),
    }),
    members: [
      member("collection.anki2", "collection", true, "deflate"),
      member("media", "media-map", true, "json"),
      member("../outside.txt", "unsafe-member", true, "stored"),
    ],
  },
  {
    id: "adverse-duplicate-normalized-archive-path",
    layout: "legacy-anki2",
    filename: "duplicate-normalized-archive-path.apkg",
    packageKind: "deck-apkg",
    purpose: "ZIP contains two members that collide after NFC normalization.",
    expectedOutcome: "unsafe-archive-path",
    archive: buildArchive({
      "collection.anki2": collectionBytes,
      media: mediaMapJson,
      "é.txt": textEncoder.encode("first archive path"),
      "é.txt": textEncoder.encode("second archive path"),
    }),
    members: [
      member("collection.anki2", "collection", true, "deflate"),
      member("media", "media-map", true, "json"),
      member("é.txt", "unsafe-member", true, "stored"),
      member("é.txt", "unsafe-member", true, "stored"),
    ],
  },
  {
    id: "adverse-invalid-media-json",
    layout: "legacy-anki2",
    filename: "invalid-media-json.apkg",
    packageKind: "deck-apkg",
    purpose: "Legacy package has malformed UTF-8 JSON media metadata.",
    expectedOutcome: "invalid-protobuf-media-map",
    archive: buildArchive({
      "collection.anki2": collectionBytes,
      media: textEncoder.encode("{not valid json"),
    }),
    members: [
      member("collection.anki2", "collection", true, "deflate"),
      member("media", "media-map", true, "json"),
    ],
  },
  {
    id: "adverse-disallowed-media-mime",
    layout: "legacy-anki2",
    filename: "disallowed-media-mime.apkg",
    packageKind: "deck-apkg",
    purpose: "A media map points at an executable HTML MIME payload.",
    expectedOutcome: "disallowed-media-mime",
    archive: buildArchive({
      "collection.anki2": collectionBytes,
      media: textEncoder.encode('{"0":"payload.html"}'),
      "0": textEncoder.encode("<!doctype html><script>alert(1)</script>"),
    }),
    members: [
      member("collection.anki2", "collection", true, "deflate"),
      member("media", "media-map", true, "json"),
      member("0", "media-bytes", true, "stored"),
    ],
  },
  {
    id: "adverse-unknown-layout",
    layout: "current-anki21b",
    filename: "unknown-layout.apkg",
    packageKind: "collection-colpkg",
    purpose: "Metadata advertises an unknown package version.",
    expectedOutcome: "unsupported-layout",
    archive: buildArchive({
      meta: bytes(0x08, 0x63),
      "collection.anki21b": textEncoder.encode("unknown layout"),
      media: textEncoder.encode("{}"),
    }),
    members: [
      member("meta", "package-metadata", true, "protobuf"),
      member("collection.anki21b", "collection", true, "stored"),
      member("media", "media-map", true, "json"),
    ],
  },
  {
    id: "adverse-invalid-zstd",
    layout: "current-anki21b",
    filename: "invalid-zstd.apkg",
    packageKind: "collection-colpkg",
    purpose: "Current layout with a corrupt collection Zstandard frame.",
    expectedOutcome: "invalid-zstd",
    archive: buildArchive({
      meta: bytes(0x08, 0x03),
      "collection.anki21b": bytes(0x28, 0xb5, 0x2f, 0xfd, 0xff),
      media: zstdFrame(mediaMapProtobuf),
    }),
    members: [
      member("meta", "package-metadata", true, "protobuf"),
      member("collection.anki21b", "collection", true, "zstd"),
      member("media", "media-map", true, "zstd"),
    ],
  },
  {
    id: "adverse-invalid-protobuf-media",
    layout: "current-anki21b",
    filename: "invalid-protobuf-media.apkg",
    packageKind: "collection-colpkg",
    purpose: "Current layout with a decompression-valid but malformed media map.",
    expectedOutcome: "invalid-protobuf-media-map",
    archive: buildArchive({
      meta: bytes(0x08, 0x03),
      "collection.anki21b": zstdFrame(collectionBytes),
      media: zstdFrame(bytes(0xff, 0xff, 0xff)),
    }),
    members: [
      member("meta", "package-metadata", true, "protobuf"),
      member("collection.anki21b", "collection", true, "zstd"),
      member("media", "media-map", true, "zstd"),
    ],
  },
  {
    id: "adverse-invalid-media-declaration",
    layout: "current-anki21b",
    filename: "invalid-media-declaration.apkg",
    packageKind: "collection-colpkg",
    purpose: "Current protobuf media metadata disagrees with the mapped bytes.",
    expectedOutcome: "invalid-protobuf-media-map",
    archive: buildCurrentArchive(
      collectionBytes,
      dummyCollectionBytes,
      invalidMediaMapProtobuf,
    ),
    members: [
      member("meta", "package-metadata", true, "protobuf"),
      member("collection.anki2", "compatibility-dummy", false, "stored"),
      member("collection.anki21b", "collection", true, "zstd"),
      member("0", "media-bytes", true, "zstd"),
      member("1", "media-bytes", true, "zstd"),
      member("media", "media-map", true, "zstd"),
    ],
  },
  {
    id: "adverse-nested-archive",
    layout: "legacy-anki2",
    filename: "nested-archive.apkg",
    packageKind: "deck-apkg",
    purpose: "Collection member is itself a ZIP archive.",
    expectedOutcome: "unsupported-layout",
    archive: buildArchive({
      "collection.anki2": buildArchive({
        "collection.anki2": textEncoder.encode("nested"),
      }),
      media: textEncoder.encode("{}"),
    }),
    members: [
      member("collection.anki2", "nested-archive", true, "deflate"),
      member("media", "media-map", true, "json"),
    ],
  },
];

for (const adverse of adverseArchives) {
  await writeFile(join(syntheticRoot, adverse.filename), adverse.archive);
}

const existingManifest = await readManifest();
const syntheticRecords = await Promise.all([
  ...layoutIds.map(async (layout) =>
    createRecord({
      id: `synthetic-${layout}`,
      layout,
      file: `synthetic/${layout}.apkg`,
      fixtureType: "synthetic",
      packageKind: layout === "current-anki21b" ? "collection-colpkg" : "deck-apkg",
      members: syntheticMembers(layout),
      provenance: {
        kind: "synthetic",
        generator: "scripts/generate-fixtures.ts",
        command: "bun run fixtures:generate",
        deterministic: "byte-identical on the pinned Bun/SQLite/fflate toolchain",
        contentLicense: "Original repository-owned fixture content under the repository MIT license.",
        note: "Synthetic archives are compatibility probes, not evidence of exporter behavior.",
      },
    }),
  ),
  createRecord({
    id: "sanitization-warning",
    layout: "legacy-anki2",
    file: "synthetic/sanitization-warning.apkg",
    fixtureType: "synthetic",
    packageKind: "deck-apkg",
    members: syntheticMembers("legacy-anki2"),
    warnings: [
      { code: "UNSAFE_CONTENT_REMOVED", sourceKind: "note" },
      { code: "UNSUPPORTED_TEMPLATE_FEATURE", sourceKind: "template" },
      { code: "MISSING_MEDIA", sourceKind: "media" },
    ],
    provenance: {
      kind: "synthetic-sanitization-input",
      generator: "scripts/generate-fixtures.ts",
      command: "bun run fixtures:generate",
      deterministic: "byte-identical on the pinned Bun/SQLite/fflate toolchain",
      contentLicense: "Original repository-owned fixture content under the repository MIT license.",
      purpose: "Safe rendering warnings for executable HTML, unsupported Anki directives, and missing media.",
    },
  }),
  ...adverseArchives.map(async (adverse) => {
    const record = await createRecord({
      id: adverse.id,
      layout: adverse.layout,
      file: `synthetic/${adverse.filename}`,
      fixtureType: "synthetic",
      packageKind: adverse.packageKind,
      members: adverse.members,
      provenance: {
        kind: "synthetic-adverse-input",
        generator: "scripts/generate-fixtures.ts",
        command: "bun run fixtures:generate",
        deterministic: "byte-identical on the pinned Bun/SQLite/fflate toolchain",
        contentLicense: "Original repository-owned fixture content under the repository MIT license.",
        expectedOutcome: adverse.expectedOutcome,
        purpose: adverse.purpose,
      },
    });
    record.supportStatus = "adverse";
    record.expected.normalizedCounts = {
      decks: 0,
      notes: 0,
      cards: 0,
      cardTemplates: 0,
      fields: 0,
      media: 0,
      mediaBytes: 0,
    };
    record.expected.semanticSha256 = "";
    record.expected.normalized = {
      decks: [],
      fields: [],
      media: [],
      notes: [],
      templates: [],
    };
    return record;
  }),
]);

const realRecords = existingManifest.fixtures.filter(
  (fixture: FixtureRecord) => fixture.fixtureType === "real-export",
);
const manifest = {
  schemaVersion: 2,
  recordedOn: "2026-09-01",
  purpose:
    "Auditable shared APKG fixtures for production import tests and the isolated browser-Worker compatibility harness.",
  layouts: layoutIds.map((layout) => ({
    id: layout,
    collectionMember:
      layout === "legacy-anki2"
        ? "collection.anki2"
        : layout === "transition-anki21"
          ? "collection.anki21"
          : "collection.anki21b",
    syntheticFixtureIds: [
      `synthetic-${layout}`,
    ],
    realFixtureIds: realRecords
      .filter((fixture) => fixture.layout === layout)
      .map((fixture) => fixture.id),
    supportClaim:
      "Fixture shape is proven by a provenance-recorded real export and a deterministic synthetic equivalent; production compatibility is asserted only through public import outcomes.",
  })),
  coverage: {
    normalizedContent: {
      multiDeckRelationships: layoutIds.flatMap((layout) => [
        `synthetic-${layout}`,
        ...realRecords
          .filter((fixture) => fixture.layout === layout)
          .map((fixture) => fixture.id),
      ]),
      unicode: layoutIds.map((layout) => `synthetic-${layout}`),
      textImageShortAudio: layoutIds.map((layout) => `synthetic-${layout}`),
      templates: layoutIds.map((layout) => `synthetic-${layout}`),
      warningBearingContent: ["sanitization-warning"],
    },
    adverseInputs: {
      invalidSqlite: ["adverse-invalid-sqlite"],
      invalidZstd: ["adverse-invalid-zstd"],
      invalidMediaMap: [
        "adverse-invalid-media-json",
        "adverse-invalid-protobuf-media",
        "adverse-invalid-media-declaration",
      ],
      archivePath: [
        "adverse-absolute-archive-path",
        "adverse-traversal-archive-path",
        "adverse-duplicate-normalized-archive-path",
      ],
      mediaPath: [
        "adverse-traversal-media",
        "adverse-duplicate-normalized-media",
      ],
      nestedArchive: ["adverse-nested-archive"],
      unsupportedLayout: ["adverse-unknown-layout"],
      disallowedMime: ["adverse-disallowed-media-mime"],
      activeContent: ["sanitization-warning"],
    },
    configurableLimitBases: {
      packageBytes: ["synthetic-legacy-anki2"],
      expandedBytes: ["synthetic-legacy-anki2"],
      archiveEntries: ["synthetic-legacy-anki2"],
      entryBytes: ["synthetic-legacy-anki2"],
      compressionRatio: ["synthetic-legacy-anki2"],
      parseTime: ["synthetic-current-anki21b"],
      utf8Bytes: ["synthetic-legacy-anki2"],
      mediaCount: ["synthetic-legacy-anki2"],
      mediaFileBytes: ["synthetic-legacy-anki2"],
      mediaBytes: ["synthetic-legacy-anki2"],
      cancellationCheckpoints: [
        "synthetic-legacy-anki2",
        "synthetic-current-anki21b",
      ],
    },
  },
  fixtures: [...syntheticRecords, ...realRecords].sort((a, b) =>
    a.id.localeCompare(b.id),
  ),
};

await writeFile(
  join(fixtureRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(
  `Generated ${syntheticRecords.length} synthetic fixtures and refreshed ${realRecords.length} real-export records.`,
);

async function createRecord(input: {
  id: string;
  layout: LayoutId;
  file: string;
  fixtureType: "synthetic" | "real-export";
  packageKind: "deck-apkg" | "collection-colpkg";
  members: FixtureRecord["archive"]["members"];
  warnings?: FixtureRecord["expected"]["warnings"];
  provenance: Record<string, unknown>;
}): Promise<FixtureRecord> {
  const bytes = await readFile(join(fixtureRoot, input.file));
  return {
    id: input.id,
    file: input.file,
    fixtureType: input.fixtureType,
    layout: input.layout,
    packageKind: input.packageKind,
    supportStatus: "candidate",
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
    archive: { members: input.members },
    expected: {
      normalizedCounts,
      semanticSha256,
      normalized: normalizedExpectation,
      warnings: input.warnings ?? [],
    },
    provenance: input.provenance,
  };
}

async function readManifest(): Promise<{ fixtures: FixtureRecord[] }> {
  try {
    return JSON.parse(
      await readFile(join(fixtureRoot, "manifest.json"), "utf8"),
    ) as { fixtures: FixtureRecord[] };
  } catch {
    return { fixtures: [] };
  }
}

function syntheticMembers(layout: LayoutId): FixtureRecord["archive"]["members"] {
  if (layout === "legacy-anki2") {
    return [
      member("collection.anki2", "collection", true, "deflate"),
      member("0", "media-bytes", true, "stored"),
      member("1", "media-bytes", true, "stored"),
      member("media", "media-map", true, "json"),
    ];
  }
  if (layout === "transition-anki21") {
    return [
      member("collection.anki2", "compatibility-dummy", false, "deflate"),
      member("collection.anki21", "collection", true, "deflate"),
      member("0", "media-bytes", true, "stored"),
      member("1", "media-bytes", true, "stored"),
      member("media", "media-map", true, "json"),
    ];
  }
  return [
    member("meta", "package-metadata", true, "protobuf"),
    member("collection.anki2", "compatibility-dummy", false, "stored"),
    member("collection.anki21b", "collection", true, "zstd"),
    member("0", "media-bytes", true, "zstd"),
    member("1", "media-bytes", true, "zstd"),
    member("media", "media-map", true, "zstd"),
  ];
}

function member(
  path: string,
  role: string,
  required: boolean,
  encoding: FixtureRecord["archive"]["members"][number]["encoding"],
): FixtureRecord["archive"]["members"][number] {
  return { path, role, required, encoding };
}

function buildLegacyArchive(
  collection: Uint8Array,
  mediaMap: Uint8Array,
): Uint8Array {
  return buildArchive({
    "collection.anki2": collection,
    "0": mediaFixtures[0].bytes,
    "1": mediaFixtures[1].bytes,
    media: mediaMap,
  });
}

function buildTransitionArchive(
  collection: Uint8Array,
  dummyCollection: Uint8Array,
  mediaMap: Uint8Array,
): Uint8Array {
  return buildArchive({
    "collection.anki2": [dummyCollection, { level: 6 }],
    "collection.anki21": [collection, { level: 6 }],
    "0": [mediaFixtures[0].bytes, { level: 0 }],
    "1": [mediaFixtures[1].bytes, { level: 0 }],
    media: [mediaMap, { level: 6 }],
  });
}

function buildCurrentArchive(
  collection: Uint8Array,
  dummyCollection: Uint8Array,
  mediaMap: Uint8Array,
): Uint8Array {
  return buildArchive({
    meta: [bytes(0x08, 0x03), { level: 0 }],
    "collection.anki2": [dummyCollection, { level: 0 }],
    "collection.anki21b": [zstdFrame(collection), { level: 0 }],
    "0": [zstdFrame(mediaFixtures[0].bytes), { level: 0 }],
    "1": [zstdFrame(mediaFixtures[1].bytes), { level: 0 }],
    media: [zstdFrame(mediaMap), { level: 0 }],
  });
}

function buildArchive(entries: Zippable): Uint8Array {
  return zipSync(entries, { level: 6, mtime: zipTimestamp });
}

function serializeCollection(
  includeContent: boolean,
  overrides: CollectionContentOverrides = {},
): Uint8Array {
  const templates = overrides.templates ?? [
    {
      name: "Card 1",
      ordinal: 0,
      qfmt: "{{Front}}",
      afmt: "{{FrontSide}}<hr id=answer>{{Back}}",
    },
    {
      name: "Card 2",
      ordinal: 1,
      qfmt: "{{Context}}",
      afmt: "{{FrontSide}}<hr id=answer>{{Back}}",
    },
  ];
  const notes = overrides.notes ?? normalizedExpectation.notes;
  const css = overrides.css ?? ".card { font-family: sans-serif; }";
  const database = new Database(":memory:");
  database.exec(`
    PRAGMA auto_vacuum = 0;
    PRAGMA application_id = 0x50304230;
    PRAGMA encoding = 'UTF-8';
    PRAGMA journal_mode = OFF;
    PRAGMA page_size = 4096;
    PRAGMA user_version = 11;
    CREATE TABLE col (
      id integer PRIMARY KEY,
      crt integer NOT NULL,
      mod integer NOT NULL,
      scm integer NOT NULL,
      ver integer NOT NULL,
      dty integer NOT NULL,
      usn integer NOT NULL,
      ls integer NOT NULL,
      conf text NOT NULL,
      models text NOT NULL,
      decks text NOT NULL,
      dconf text NOT NULL,
      tags text NOT NULL
    );
    CREATE TABLE notes (
      id integer PRIMARY KEY,
      guid text NOT NULL,
      mid integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      tags text NOT NULL,
      flds text NOT NULL,
      sfld integer NOT NULL,
      csum integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE cards (
      id integer PRIMARY KEY,
      nid integer NOT NULL,
      did integer NOT NULL,
      ord integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      type integer NOT NULL,
      queue integer NOT NULL,
      due integer NOT NULL,
      ivl integer NOT NULL,
      factor integer NOT NULL,
      reps integer NOT NULL,
      lapses integer NOT NULL,
      left integer NOT NULL,
      odue integer NOT NULL,
      odid integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE revlog (
      id integer PRIMARY KEY,
      cid integer NOT NULL,
      usn integer NOT NULL,
      ease integer NOT NULL,
      ivl integer NOT NULL,
      lastIvl integer NOT NULL,
      factor integer NOT NULL,
      time integer NOT NULL,
      type integer NOT NULL
    );
    CREATE TABLE graves (
      oid integer NOT NULL,
      type integer NOT NULL,
      usn integer NOT NULL,
      PRIMARY KEY (oid, type)
    ) WITHOUT ROWID;
    CREATE INDEX ix_notes_usn ON notes (usn);
    CREATE INDEX ix_cards_nid ON cards (nid);
    CREATE INDEX ix_cards_usn ON cards (usn);
  `);

  const models = JSON.stringify({
    "1000000000001": {
      id: 1000000000001,
      name: "P0B Fixture Note",
      type: 0,
      mod: 1700000000,
      usn: -1,
      sortf: 0,
      did: null,
      flds: normalizedExpectation.fields.map((name, ord) => ({
        name,
        ord,
        sticky: false,
        rtl: false,
        font: "Arial",
        size: 20,
      })),
      tmpls: templates.map((template) => ({
        name: template.name,
        ord: template.ordinal,
        qfmt: template.qfmt,
        afmt: template.afmt,
        did: null,
      })),
      css,
      req: [
        [0, "any", [0]],
        [1, "any", [2]],
      ],
    },
  });
  const decks = JSON.stringify({
    "2000000000001": {
      id: 2000000000001,
      name: "P0B Fixture",
      desc: "",
      dyn: 0,
      conf: 1,
      mod: 1700000000,
      usn: -1,
    },
    "2000000000002": {
      id: 2000000000002,
      name: "P0B Fixture::子 deck",
      desc: "",
      dyn: 0,
      conf: 1,
      mod: 1700000000,
      usn: -1,
    },
  });

  database
    .prepare(
      "INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      1,
      1700000000,
      1700000000,
      1700000000,
      11,
      0,
      -1,
      0,
      JSON.stringify({ nextPos: 1, estTimes: true }),
      models,
      decks,
      JSON.stringify({ "1": { new: 20, rev: 200 } }),
      JSON.stringify({}),
    );

  if (includeContent) {
    const noteRows = notes.map((note, index) => ({
      id: 3000000000001 + index,
      note,
      deckId: 2000000000001 + index,
    }));
    const insertNote = database.prepare(
      "INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertCard = database.prepare(
      "INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    for (const [noteIndex, { id, note, deckId }] of noteRows.entries()) {
      insertNote.run(
        id,
        note.sourceGuid,
        1000000000001,
        1700000000,
        -1,
        note.tags.join(" "),
        note.fields.join("\x1f"),
        0,
        0,
        0,
        JSON.stringify({ source: "synthetic-fixture" }),
      );
      for (const template of templates) {
        insertCard.run(
          5000000000001 + noteIndex * templates.length + template.ordinal,
          id,
          deckId,
          template.ordinal,
          1700000000,
          -1,
          0,
          0,
          0,
          0,
          2500,
          0,
          0,
          0,
          0,
          0,
          0,
          JSON.stringify({ scheduling: "diagnostic-only" }),
        );
      }
    }
  }

  const serialized = new Uint8Array(database.serialize());
  database.close();
  return serialized;
}

function encodeMediaEntries(
  media: MediaFixture[],
  options: { declaredBytesDelta?: number } = {},
): Uint8Array {
  const entries = media.map((fixture, index) =>
    concat(
      fieldBytes(1, textEncoder.encode(fixture.name)),
      fieldVarint(
        2,
        fixture.bytes.byteLength + (index === 0 ? options.declaredBytesDelta ?? 0 : 0),
      ),
      fieldBytes(3, hexToBytes(sha1(fixture.bytes))),
    ),
  );
  return concat(...entries.map((entry) => fieldBytes(1, entry)));
}

function fieldBytes(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concat(encodeVarint((fieldNumber << 3) | 2), encodeVarint(value.byteLength), value);
}

function fieldVarint(fieldNumber: number, value: number): Uint8Array {
  return concat(encodeVarint(fieldNumber << 3), encodeVarint(value));
}

function encodeVarint(value: number): Uint8Array {
  const output: number[] = [];
  let remaining = value >>> 0;
  do {
    const next = remaining & 0x7f;
    remaining >>>= 7;
    output.push(remaining === 0 ? next : next | 0x80);
  } while (remaining !== 0);
  return Uint8Array.from(output);
}

function zstdFrame(payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(payload.byteLength <= 255 ? 9 : 12);
  header.set([0x28, 0xb5, 0x2f, 0xfd]);
  if (payload.byteLength <= 255) {
    header[4] = 0x20;
    header[5] = payload.byteLength;
  } else {
    header[4] = 0xa0;
    new DataView(header.buffer).setUint32(5, payload.byteLength, true);
  }

  const blocks: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.byteLength) {
    const size = Math.min(128 * 1024, payload.byteLength - offset);
    const isLast = offset + size === payload.byteLength;
    const blockHeader = (size << 3) | (isLast ? 1 : 0);
    blocks.push(
      bytes(
        blockHeader & 0xff,
        (blockHeader >>> 8) & 0xff,
        (blockHeader >>> 16) & 0xff,
      ),
      payload.subarray(offset, offset + size),
    );
    offset += size;
  }
  return concat(header, ...blocks);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha1(value: Uint8Array): string {
  return createHash("sha1").update(value).digest("hex");
}
