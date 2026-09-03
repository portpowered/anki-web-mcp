import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import * as protobuf from "protobufjs/minimal";

import type { NormalizedImportGraph, SupportedCollectionLayout } from "../contracts";
import { normalizeImportLimits } from "../limits";
import {
  IMPORT_WORKER_PROTOCOL,
  IMPORT_WORKER_PROTOCOL_VERSION,
  type ImportWorkerMessage,
  type ImportWorkerStartRequest,
} from "../protocol";
import { ImportWorkerRuntime } from "./runtime";
import { validateArchive } from "./archive";
import { normalizeCollectionArchive } from "./collection";
import { compileImportContent } from "./content";
import { importPackageMedia, MediaImportFailure } from "./media";

const fixtureRoot = join(process.cwd(), "spikes", "apkg-compatibility", "fixtures");

interface FixtureRecord {
  readonly id: string;
  readonly file: string;
  readonly layout: SupportedCollectionLayout;
  readonly supportStatus: string;
  readonly expected: {
    readonly normalizedCounts: {
      readonly decks: number;
      readonly notes: number;
      readonly cards: number;
      readonly cardTemplates: number;
      readonly fields: number;
      readonly media: number;
      readonly mediaBytes: number;
    };
    readonly normalized: {
      readonly decks: readonly { name: string }[];
      readonly fields: readonly string[];
      readonly notes: readonly { fields: readonly string[]; tags: readonly string[] }[];
      readonly templates: readonly { name: string; ordinal: number }[];
      readonly media: readonly { name: string; bytes: number }[];
    };
  };
}

describe("production collection normalization", () => {
  test("normalizes every supported synthetic and real layout deterministically", async () => {
    const manifest = JSON.parse(
      await readFile(join(fixtureRoot, "manifest.json"), "utf8"),
    ) as { fixtures: FixtureRecord[] };
    const fixtures = manifest.fixtures.filter((fixture) =>
      fixture.supportStatus === "candidate"
      && (fixture.id.startsWith("synthetic-") || fixture.id.startsWith("real-anki-"))
    );
    expect(fixtures).toHaveLength(6);

    for (const fixture of fixtures) {
      const bytes = new Uint8Array(await readFile(join(fixtureRoot, fixture.file)));
      const first = await runWorker(`first-${fixture.id}`, bytes);
      const second = await runWorker(`second-${fixture.id}`, bytes);
      expect(first.status).toBe("success");
      expect(second.status).toBe("success");
      if (first.status !== "success" || second.status !== "success") continue;

      const graph = first.graph;
      expect(graph.layout).toBe(fixture.layout);
      expect(graph.packageSha256).toBe("a".repeat(64));
      expect(graph.decks).toHaveLength(fixture.expected.normalizedCounts.decks);
      expect(graph.notes).toHaveLength(fixture.expected.normalizedCounts.notes);
      expect(graph.cards).toHaveLength(fixture.expected.normalizedCounts.cards);
      expect(graph.cardTemplates).toHaveLength(fixture.expected.normalizedCounts.cardTemplates);
      expect(graph.fields).toHaveLength(fixture.expected.normalizedCounts.fields);
      expect(graph.media).toHaveLength(fixture.expected.normalizedCounts.media);
      expect(graph.media.reduce((total, media) => total + media.byteLength, 0)).toBe(
        fixture.expected.normalizedCounts.mediaBytes,
      );
      expect(graph.media.map(({ name, byteLength }) => ({ name, bytes: byteLength }))).toEqual(
        fixture.expected.normalized.media.map(({ name, bytes }) => ({ name, bytes })),
      );
      expect(graph.media.every((media) => media.sha256.length === 64 && media.bytes.byteLength === media.byteLength)).toBe(true);
      expect(graph.decks.map((deck) => ({ name: deck.name }))).toEqual(
        fixture.expected.normalized.decks.map((deck) => ({ name: deck.name })),
      );
      expect(graph.fields.map((field) => field.name)).toEqual([...fixture.expected.normalized.fields]);
      expect(graph.notes.map((note) => ({ fields: note.fields, tags: note.tags }))).toEqual(
        fixture.expected.normalized.notes.map((note) => ({ fields: note.fields, tags: note.tags })),
      );
      expect(graph.cardTemplates.map(({ name, ordinal }) => ({ name, ordinal }))).toEqual(
        [...fixture.expected.normalized.templates],
      );
      expect(graph.cards.every((card) => card.scheduling === "fresh")).toBe(true);
      expect(graph.cards.flatMap((card) => card.content.mediaReferences).every((key) =>
        graph.media.some((media) => media.id === key)
      )).toBe(true);
      assertRelationships(graph);
      expect(second.graph).toEqual(first.graph);
    }
  }, 30_000);

  test("returns stable SQLite and zstd errors without a commit-ready graph", async () => {
    for (const [file, code, stage] of [
      ["synthetic/invalid-sqlite.apkg", "SQLITE_INVALID", "parsing-records"],
      ["synthetic/invalid-zstd.apkg", "ZSTD_INVALID", "decompressing-collection"],
    ] as const) {
      const outcome = await runWorker(file, new Uint8Array(await readFile(join(fixtureRoot, file))));
      expect(outcome).toMatchObject({
        status: "failed",
        commitReady: false,
        error: { code, stage },
      });
      expect("graph" in outcome).toBe(false);
    }
  });

  test("rejects unsupported/malformed metadata and invalid normalized relationships by name", async () => {
    const currentBytes = new Uint8Array(
      await readFile(join(fixtureRoot, "synthetic/current-anki21b.apkg")),
    );
    for (const [meta, code] of [
      [new Uint8Array([0x08, 0x63]), "UNSUPPORTED_PACKAGE"],
      [new Uint8Array([0xff]), "PROTOBUF_INVALID"],
    ] as const) {
      const entries = unzipSync(currentBytes);
      entries.meta = meta;
      const outcome = await runWorker(`metadata-${code}`, zipSync(entries));
      expect(outcome).toMatchObject({ status: "failed", error: { code } });
      expect("graph" in outcome).toBe(false);
    }

    const legacyBytes = new Uint8Array(
      await readFile(join(fixtureRoot, "synthetic/legacy-anki2.apkg")),
    );
    const entries = unzipSync(legacyBytes);
    const database = Database.deserialize(entries["collection.anki2"]);
    database.exec("UPDATE notes SET mid = 999 WHERE id = (SELECT MIN(id) FROM notes)");
    entries["collection.anki2"] = new Uint8Array(database.serialize());
    database.close();
    const outcome = await runWorker("invalid-relationships", zipSync(entries));
    expect(outcome).toMatchObject({
      status: "failed",
      commitReady: false,
      error: { code: "NORMALIZATION_FAILED", stage: "parsing-records" },
    });
    expect("graph" in outcome).toBe(false);
  });

  test("observes cancellation and elapsed-time bounds before normalization succeeds", async () => {
    const bytes = new Uint8Array(await readFile(join(fixtureRoot, "synthetic/legacy-anki2.apkg")));
    const cancelledMessages: ImportWorkerMessage<NormalizedImportGraph>[] = [];
    const cancelledRuntime = new ImportWorkerRuntime({
      postMessage: (message) => cancelledMessages.push(message as ImportWorkerMessage<NormalizedImportGraph>),
    });
    const request = startRequest("cancel-normalization", bytes);
    cancelledRuntime.receive(request);
    cancelledRuntime.receive({
      protocol: IMPORT_WORKER_PROTOCOL,
      version: IMPORT_WORKER_PROTOCOL_VERSION,
      type: "cancel",
      operationId: request.operationId,
      reason: "caller",
    });
    expect(await terminal(cancelledMessages)).toMatchObject({
      status: "cancelled",
      commitReady: false,
      error: { code: "IMPORT_CANCELLED" },
    });

    let tick = 0;
    const timedMessages: ImportWorkerMessage<NormalizedImportGraph>[] = [];
    const timedRuntime = new ImportWorkerRuntime({
      now: () => tick++,
      postMessage: (message) => timedMessages.push(message as ImportWorkerMessage<NormalizedImportGraph>),
    });
    timedRuntime.receive({
      ...startRequest("timeout-normalization", bytes),
      limits: normalizeImportLimits({ maxParseTimeMs: 1 }),
    });
    expect(await terminal(timedMessages)).toMatchObject({
      status: "failed",
      commitReady: false,
      error: { code: "IMPORT_TIMEOUT" },
    });
  });

  test("returns compiled safe card content and typed warnings through the public Worker outcome", async () => {
    const bytes = new Uint8Array(
      await readFile(join(fixtureRoot, "synthetic/sanitization-warning.apkg")),
    );
    const outcome = await runWorker("sanitization-warning", bytes);
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;

    expect(new Set(outcome.warnings.map((warning) => warning.code))).toEqual(new Set([
      "UNSAFE_CONTENT_REMOVED",
      "UNSUPPORTED_TEMPLATE_FEATURE",
      "MISSING_MEDIA",
    ]));
    expect(new Set(outcome.warnings.map((warning) => warning.source?.kind))).toEqual(
      new Set(["card", "template", "media"]),
    );
    for (const card of outcome.graph.cards) {
      expect(card.content.frontText.length).toBeGreaterThan(0);
      expect(card.content.backText.length).toBeGreaterThan(0);
      expect(card.content.frontHtml).not.toMatch(/<script|onerror|javascript:/i);
      expect(card.content.backHtml).not.toMatch(/<script|onerror|javascript:/i);
      expect(card.content.frontHtml).not.toContain("https://");
      expect(card.content.backHtml).not.toContain("https://");
    }
  });

  test("returns stable media-map, path, declaration, and MIME failures", async () => {
    for (const [file, code] of [
      ["synthetic/invalid-media-json.apkg", "MEDIA_MAP_INVALID"],
      ["synthetic/invalid-protobuf-media.apkg", "MEDIA_MAP_INVALID"],
      ["synthetic/invalid-media-declaration.apkg", "MEDIA_MAP_INVALID"],
      ["synthetic/duplicate-normalized-media.apkg", "ARCHIVE_PATH_UNSAFE"],
      ["synthetic/traversal-media.apkg", "ARCHIVE_PATH_UNSAFE"],
      ["synthetic/disallowed-media-mime.apkg", "MIME_NOT_ALLOWED"],
    ] as const) {
      const outcome = await runWorker(file, new Uint8Array(await readFile(join(fixtureRoot, file))));
      expect(outcome).toMatchObject({
        status: "failed",
        commitReady: false,
        error: { code, stage: "importing-media" },
      });
      expect("graph" in outcome).toBe(false);
    }
  });

  test("enforces exact media limits and the sniffed MIME allow-list", async () => {
    const bytes = new Uint8Array(await readFile(join(fixtureRoot, "synthetic/legacy-anki2.apkg")));
    for (const limits of [
      { maxMediaCount: 2 },
      { maxMediaFileBytes: 68 },
      { maxMediaBytes: 113 },
    ]) {
      expect((await runWorker("exact-media-limit", bytes, limits)).status).toBe("success");
    }
    for (const limits of [
      { maxMediaCount: 1 },
      { maxMediaFileBytes: 67 },
      { maxMediaBytes: 112 },
    ]) {
      expect(await runWorker("plus-one-media-limit", bytes, limits)).toMatchObject({
        status: "failed", error: { code: "ARCHIVE_LIMIT_EXCEEDED", stage: "importing-media" },
      });
    }
    expect(await runWorker("mime-allow-list", bytes, {
      allowedMediaMimeTypes: ["image/png"],
    })).toMatchObject({ status: "failed", error: { code: "MIME_NOT_ALLOWED" } });

    const entries = unzipSync(bytes);
    entries.media = new TextEncoder().encode('{"0":"deceptive.png"}');
    entries["0"] = new TextEncoder().encode("plain text with a deceptive extension");
    delete entries["1"];
    expect(await runWorker("mime-mismatch", zipSync(entries))).toMatchObject({
      status: "failed", error: { code: "MIME_NOT_ALLOWED", stage: "importing-media" },
    });

    const passiveFontEntries = unzipSync(bytes);
    passiveFontEntries.media = new TextEncoder().encode('{"0":"_stroke.ttf"}');
    passiveFontEntries["0"] = Uint8Array.from(
      { length: 1_025 },
      (_, index) => (index * 131 + 17) % 256,
    );
    delete passiveFontEntries["1"];
    const passiveFontOutcome = await runWorker("passive-font", zipSync(passiveFontEntries), {
      maxUtf8Bytes: 1_024,
    });
    expect(passiveFontOutcome.status).toBe("success");
    if (passiveFontOutcome.status === "success") {
      expect(passiveFontOutcome.graph.media).toEqual([]);
      expect(passiveFontOutcome.warnings).toContainEqual(expect.objectContaining({
        code: "UNSUPPORTED_FEATURE",
        stage: "importing-media",
        source: { kind: "media", id: "_stroke.ttf" },
      }));
    }
  });

  test("enforces maxUtf8Bytes at exact decoded-payload boundaries", async () => {
    const source = new Uint8Array(
      await readFile(join(fixtureRoot, "synthetic/legacy-anki2.apkg")),
    );
    const encoder = new TextEncoder();

    const mediaMapEntries = unzipSync(source);
    const longMediaName = `${"é".repeat(1_024)}.png`;
    mediaMapEntries.media = encoder.encode(JSON.stringify({
      0: longMediaName,
      1: "tone.wav",
    }));
    const mediaMapBytes = mediaMapEntries.media.byteLength;
    await expectUtf8Boundary(
      "legacy-media-map",
      zipSync(mediaMapEntries),
      mediaMapBytes,
      "importing-media",
      "media-map",
    );

    const noteEntries = unzipSync(source);
    const noteDatabase = Database.deserialize(noteEntries["collection.anki2"]);
    const noteText = `${"漢".repeat(1_024)}\x1fBack\x1fContext`;
    noteDatabase.query("UPDATE notes SET flds = ? WHERE id = (SELECT MIN(id) FROM notes)").run(noteText);
    noteEntries["collection.anki2"] = new Uint8Array(noteDatabase.serialize());
    noteDatabase.close();
    await expectUtf8Boundary(
      "sqlite-note",
      zipSync(noteEntries),
      encoder.encode(noteText).byteLength,
      "parsing-records",
      "sqlite.value",
    );

    const templateEntries = unzipSync(source);
    const templateDatabase = Database.deserialize(templateEntries["collection.anki2"]);
    const row = templateDatabase.query("SELECT models FROM col LIMIT 1").get() as { models: string };
    const models = JSON.parse(row.models) as Record<string, { tmpls: Array<{ qfmt: string }> }>;
    Object.values(models)[0]!.tmpls[0]!.qfmt = `<section>${"界".repeat(1_024)}</section>`;
    const modelsText = JSON.stringify(models);
    templateDatabase.query("UPDATE col SET models = ?").run(modelsText);
    templateEntries["collection.anki2"] = new Uint8Array(templateDatabase.serialize());
    templateDatabase.close();
    await expectUtf8Boundary(
      "collection-template",
      zipSync(templateEntries),
      encoder.encode(modelsText).byteLength,
      "parsing-records",
      "sqlite.value",
    );

    const currentSource = new Uint8Array(
      await readFile(join(fixtureRoot, "synthetic/current-anki21b.apkg")),
    );
    const modernTemplateEntries = unzipSync(currentSource);
    const modernTemplateDatabase = Database.deserialize(
      Bun.zstdDecompressSync(modernTemplateEntries["collection.anki21b"]),
    );
    const modernQuestion = `{{Front}}${"語".repeat(1_024)}`;
    const modernConfig = protobuf.Writer.create()
      .uint32(10).string(modernQuestion)
      .uint32(18).string("{{FrontSide}}{{Back}}")
      .finish();
    const shortConfig = protobuf.Writer.create()
      .uint32(10).string("{{Context}}")
      .uint32(18).string("{{FrontSide}}{{Back}}")
      .finish();
    const notetypeConfig = protobuf.Writer.create()
      .uint32(26).string(".card { color: black; }")
      .finish();
    modernTemplateDatabase.exec(`
      CREATE TABLE decks (id INTEGER NOT NULL, name TEXT NOT NULL);
      CREATE TABLE notetypes (id INTEGER NOT NULL, name TEXT NOT NULL, config BLOB NOT NULL);
      CREATE TABLE fields (ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL);
      CREATE TABLE templates (ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL, config BLOB NOT NULL);
      INSERT INTO decks VALUES (2000000000001, 'P0B Fixture');
      INSERT INTO decks VALUES (2000000000002, 'P0B Fixture::子 deck');
      INSERT INTO fields VALUES (1000000000001, 0, 'Front');
      INSERT INTO fields VALUES (1000000000001, 1, 'Back');
      INSERT INTO fields VALUES (1000000000001, 2, 'Context');
    `);
    modernTemplateDatabase.query("INSERT INTO notetypes VALUES (?, ?, ?)").run(
      1000000000001,
      "Modern fixture note",
      notetypeConfig,
    );
    modernTemplateDatabase.query("INSERT INTO templates VALUES (?, ?, ?, ?)").run(
      1000000000001,
      0,
      "Card 1",
      modernConfig,
    );
    modernTemplateDatabase.query("INSERT INTO templates VALUES (?, ?, ?, ?)").run(
      1000000000001,
      1,
      "Card 2",
      shortConfig,
    );
    modernTemplateEntries["collection.anki21b"] = Uint8Array.from(
      Bun.zstdCompressSync(modernTemplateDatabase.serialize()),
    );
    modernTemplateDatabase.close();
    await expectUtf8Boundary(
      "modern-template",
      zipSync(modernTemplateEntries),
      encoder.encode(modernQuestion).byteLength,
      "parsing-records",
      "question format",
    );

    const textMediaEntries = unzipSync(source);
    const textBytes = encoder.encode("t".repeat(2_048));
    textMediaEntries.media = encoder.encode(JSON.stringify({ 0: "tiny.png", 1: "long.txt" }));
    textMediaEntries["1"] = textBytes;
    await expectUtf8Boundary(
      "text-media",
      zipSync(textMediaEntries),
      textBytes.byteLength,
      "importing-media",
      "text-media",
    );
  });

  test("warns for missing references and unmapped members, and cancels between media items", async () => {
    const source = new Uint8Array(await readFile(join(fixtureRoot, "synthetic/sanitization-warning.apkg")));
    const entries = unzipSync(source);
    entries["2"] = new TextEncoder().encode("unmapped passive bytes");
    const outcome = await runWorker("media-warnings", zipSync(entries));
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(outcome.warnings.map((warning) => warning.code)).toContain("MISSING_MEDIA");
      expect(outcome.warnings.map((warning) => warning.code)).toContain("MISSING_MEDIA_MAP_ENTRY");
      expect(outcome.graph.media).toHaveLength(2);
    }

    const limits = normalizeImportLimits();
    const archive = await validateArchive(source, limits, { operationId: "cancel-media" });
    const normalized = await normalizeCollectionArchive(archive, {
      operationId: "cancel-media", packageSha256: "b".repeat(64), limits, startedAt: performance.now(),
    });
    const compiled = compileImportContent(normalized, { operationId: "cancel-media" });
    let completed = 0;
    try {
      await importPackageMedia(compiled.graph, archive, {
        operationId: "cancel-media", limits, startedAt: performance.now(),
        isCancelled: () => completed >= 1,
        checkpoint: () => { completed += 1; },
      });
      throw new Error("expected cancellation");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaImportFailure);
      expect((error as MediaImportFailure).error.code).toBe("IMPORT_CANCELLED");
      expect(completed).toBe(1);
    }
  });
});

function assertRelationships(graph: NormalizedImportGraph): void {
  const deckIds = new Set(graph.decks.map((deck) => deck.id));
  const noteIds = new Set(graph.notes.map((note) => note.id));
  const notetypeIds = new Set(graph.notetypes.map((notetype) => notetype.id));
  const templateKeys = new Set(graph.cardTemplates.map((template) =>
    `${template.notetypeId}:${template.ordinal}`
  ));
  for (const note of graph.notes) {
    expect(deckIds.has(note.deckId)).toBe(true);
    expect(notetypeIds.has(note.notetypeId)).toBe(true);
  }
  for (const card of graph.cards) {
    const note = graph.notes.find((candidate) => candidate.id === card.noteId)!;
    expect(noteIds.has(card.noteId)).toBe(true);
    expect(deckIds.has(card.deckId)).toBe(true);
    expect(templateKeys.has(`${note.notetypeId}:${card.templateOrdinal}`)).toBe(true);
  }
}

async function runWorker(operationId: string, bytes: Uint8Array, limitOverrides = {}) {
  const messages: ImportWorkerMessage<NormalizedImportGraph>[] = [];
  const runtime = new ImportWorkerRuntime({
    postMessage: (message) => messages.push(message as ImportWorkerMessage<NormalizedImportGraph>),
  });
  runtime.receive(startRequest(operationId, bytes, limitOverrides));
  return terminal(messages);
}

async function expectUtf8Boundary(
  label: string,
  bytes: Uint8Array,
  boundary: number,
  stage: "parsing-records" | "importing-media",
  detailLabel: string,
): Promise<void> {
  expect(await runWorker(`${label}-exact`, bytes, { maxUtf8Bytes: boundary })).toMatchObject({
    status: "success",
  });
  const failure = await runWorker(`${label}-plus-one`, bytes, { maxUtf8Bytes: boundary - 1 });
  expect(failure).toMatchObject({
    status: "failed",
    commitReady: false,
    error: {
      code: "ARCHIVE_LIMIT_EXCEEDED",
      stage,
      detail: `maxUtf8Bytes:${detailLabel}:${boundary}:${boundary - 1}`,
    },
  });
  expect("graph" in failure).toBe(false);
}

function startRequest(
  operationId: string,
  bytes: Uint8Array,
  limitOverrides: Parameters<typeof normalizeImportLimits>[0] = {},
): ImportWorkerStartRequest {
  return {
    protocol: IMPORT_WORKER_PROTOCOL,
    version: IMPORT_WORKER_PROTOCOL_VERSION,
    type: "start",
    operationId,
    fileName: "fixture.apkg",
    packageBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    packageSha256: "a".repeat(64),
    limits: normalizeImportLimits(limitOverrides),
    duplicatePolicy: "cancel",
  };
}

async function terminal(messages: readonly ImportWorkerMessage<NormalizedImportGraph>[]) {
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const result = messages.find((message) => message.type === "terminal");
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Worker did not return a terminal outcome");
}
