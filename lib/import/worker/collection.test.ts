import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";

import type { NormalizedImportGraph, SupportedCollectionLayout } from "../contracts";
import { normalizeImportLimits } from "../limits";
import {
  IMPORT_WORKER_PROTOCOL,
  IMPORT_WORKER_PROTOCOL_VERSION,
  type ImportWorkerMessage,
  type ImportWorkerStartRequest,
} from "../protocol";
import { ImportWorkerRuntime } from "./runtime";

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
    };
    readonly normalized: {
      readonly decks: readonly { name: string }[];
      readonly fields: readonly string[];
      readonly notes: readonly { fields: readonly string[]; tags: readonly string[] }[];
      readonly templates: readonly { name: string; ordinal: number }[];
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

async function runWorker(operationId: string, bytes: Uint8Array) {
  const messages: ImportWorkerMessage<NormalizedImportGraph>[] = [];
  const runtime = new ImportWorkerRuntime({
    postMessage: (message) => messages.push(message as ImportWorkerMessage<NormalizedImportGraph>),
  });
  runtime.receive(startRequest(operationId, bytes));
  return terminal(messages);
}

function startRequest(operationId: string, bytes: Uint8Array): ImportWorkerStartRequest {
  return {
    protocol: IMPORT_WORKER_PROTOCOL,
    version: IMPORT_WORKER_PROTOCOL_VERSION,
    type: "start",
    operationId,
    fileName: "fixture.apkg",
    packageBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    packageSha256: "a".repeat(64),
    limits: normalizeImportLimits(),
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
