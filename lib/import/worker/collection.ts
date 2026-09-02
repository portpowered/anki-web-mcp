import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { Decompress } from "fzstd";
import * as protobuf from "protobufjs/minimal";

import type {
  NormalizedCard,
  NormalizedCardTemplate,
  NormalizedDeck,
  NormalizedField,
  NormalizedImportGraph,
  NormalizedNote,
  NormalizedNotetype,
  SupportedCollectionLayout,
} from "../contracts";
import { importError, type ImportError } from "../errors";
import type { ImportLimits } from "../limits";
import type { ValidatedArchive, ValidatedArchiveMember } from "./archive";

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
let sqliteModulePromise: ReturnType<typeof sqlite3InitModule> | undefined;

export interface CollectionControl {
  readonly operationId: string;
  readonly packageSha256: string;
  readonly limits: ImportLimits;
  readonly now?: () => number;
  readonly startedAt: number;
  readonly isCancelled?: () => boolean;
}

export class CollectionFailure extends Error {
  public constructor(public readonly error: ImportError) {
    super(error.message);
    this.name = "CollectionFailure";
  }
}

interface DetectedCollection {
  readonly layout: SupportedCollectionLayout;
  readonly member: ValidatedArchiveMember;
}

interface SqliteRow {
  readonly [column: string]: unknown;
}

type QueryRows = (sql: string) => SqliteRow[];

interface NotetypeDefinition {
  readonly id: string;
  readonly name: string;
  readonly fields: Array<{ ordinal: number; name: string }>;
  readonly templates: Array<{
    ordinal: number;
    name: string;
    questionFormat: string;
    answerFormat: string;
  }>;
  readonly css: string;
}

interface NormalizedRecords {
  readonly decks: readonly NormalizedDeck[];
  readonly notetypes: readonly NormalizedNotetype[];
  readonly fields: readonly NormalizedField[];
  readonly cardTemplates: readonly NormalizedCardTemplate[];
  readonly notes: readonly NormalizedNote[];
  readonly cards: readonly NormalizedCard[];
}

/** Decode and normalize a validated archive entirely inside the import Worker. */
export async function normalizeCollectionArchive(
  archive: ValidatedArchive,
  control: CollectionControl,
): Promise<NormalizedImportGraph> {
  const checkpoint = createCheckpoint(control);
  checkpoint("decompressing-collection");
  const detected = detectCollection(archive, control.operationId);
  const collectionBytes = detected.layout === "current-anki21b"
    ? decompressCurrentCollection(detected.member.bytes, archive, control)
    : detected.member.bytes;

  checkpoint("parsing-records");
  const records = await readSqliteCollection(collectionBytes, control.operationId);
  checkpoint("parsing-records");
  return Object.freeze({
    layout: detected.layout,
    packageSha256: control.packageSha256,
    ...records,
  });
}

function detectCollection(
  archive: ValidatedArchive,
  operationId: string,
): DetectedCollection {
  const members = new Map(archive.members.map((member) => [member.path, member]));
  const hasLegacy = members.has("collection.anki2");
  const hasTransition = members.has("collection.anki21");
  const hasCurrent = members.has("collection.anki21b");
  const hasMeta = members.has("meta");
  const hasMedia = members.has("media");

  if (!hasMedia) {
    throw failure("UNSUPPORTED_PACKAGE", operationId, "missing:media");
  }
  if (hasCurrent) {
    if (hasTransition || !hasMeta) {
      throw failure("UNSUPPORTED_PACKAGE", operationId, "ambiguous:current-layout");
    }
    validateCurrentMetadata(members.get("meta")!.bytes, operationId);
    return { layout: "current-anki21b", member: members.get("collection.anki21b")! };
  }
  if (hasTransition) {
    if (hasMeta) {
      throw failure("UNSUPPORTED_PACKAGE", operationId, "ambiguous:transition-layout");
    }
    return { layout: "transition-anki21", member: members.get("collection.anki21")! };
  }
  if (hasLegacy && !hasMeta) {
    return { layout: "legacy-anki2", member: members.get("collection.anki2")! };
  }
  throw failure("UNSUPPORTED_PACKAGE", operationId, "missing:supported-collection");
}

function validateCurrentMetadata(bytes: Uint8Array, operationId: string): void {
  try {
    const reader = protobuf.Reader.create(bytes);
    let version: number | undefined;
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      if ((tag >>> 3) === 1 && (tag & 7) === 0) {
        if (version !== undefined) throw new Error("duplicate version");
        version = reader.uint32();
      } else {
        reader.skipType(tag & 7);
      }
    }
    if (version !== 3) {
      throw failure("UNSUPPORTED_PACKAGE", operationId, `metadataVersion:${String(version)}`);
    }
  } catch (error) {
    if (error instanceof CollectionFailure) throw error;
    throw failure("PROTOBUF_INVALID", operationId, "invalid:package-metadata");
  }
}

function decompressCurrentCollection(
  bytes: Uint8Array,
  archive: ValidatedArchive,
  control: CollectionControl,
): Uint8Array {
  try {
    const frame = readZstdFrame(bytes);
    const maximumOutput = Math.min(
      control.limits.maxEntryBytes,
      control.limits.maxExpandedBytes - archive.expandedBytes,
    );
    if (
      frame.windowBytes > maximumOutput
      || (frame.contentBytes !== undefined && frame.contentBytes > maximumOutput)
    ) {
      throw failure(
        "ARCHIVE_LIMIT_EXCEEDED",
        control.operationId,
        `collectionExpandedBytes:${frame.contentBytes ?? frame.windowBytes}`,
      );
    }
    const chunks: Uint8Array[] = [];
    let outputBytes = 0;
    const decoder = new Decompress((chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutput) {
        throw failure("ARCHIVE_LIMIT_EXCEEDED", control.operationId, `collectionExpandedBytes:${outputBytes}`);
      }
      chunks.push(chunk.slice());
    });
    decoder.push(bytes, true);
    if (frame.contentBytes !== undefined && outputBytes !== frame.contentBytes) {
      throw new Error("size mismatch");
    }
    const output = new Uint8Array(outputBytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } catch (error) {
    if (error instanceof CollectionFailure) throw error;
    throw failure("ZSTD_INVALID", control.operationId, "invalid:collection.anki21b");
  }
}

function readZstdFrame(bytes: Uint8Array): { windowBytes: number; contentBytes?: number } {
  if (
    bytes.byteLength < 5
    || bytes[0] !== 0x28
    || bytes[1] !== 0xb5
    || bytes[2] !== 0x2f
    || bytes[3] !== 0xfd
  ) throw new Error("missing zstd magic");
  const descriptor = bytes[4];
  if ((descriptor & 0x18) !== 0) throw new Error("reserved zstd bits");
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const contentSizeFlag = descriptor >>> 6;
  let offset = 5;
  let windowBytes: number | undefined;
  if (!singleSegment) {
    if (offset >= bytes.byteLength) throw new Error("missing zstd window");
    const windowDescriptor = bytes[offset++];
    const windowBase = 2 ** (10 + (windowDescriptor >>> 3));
    windowBytes = windowBase + (windowBase >>> 3) * (windowDescriptor & 7);
  }
  offset += dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4;
  const length = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 2 ** contentSizeFlag;
  if (offset + length > bytes.byteLength) throw new Error("truncated zstd frame");
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value += bytes[offset + index] * 2 ** (index * 8);
  }
  if (length > 0 && contentSizeFlag === 1) value += 256;
  const contentBytes = length === 0 ? undefined : value;
  if (contentBytes !== undefined && !Number.isSafeInteger(contentBytes)) throw new Error("unsafe zstd size");
  if (singleSegment) windowBytes = contentBytes ?? 1;
  if (windowBytes === undefined || !Number.isSafeInteger(windowBytes) || windowBytes <= 0) {
    throw new Error("invalid zstd window");
  }
  return { windowBytes, ...(contentBytes === undefined ? {} : { contentBytes }) };
}

async function readSqliteCollection(
  bytes: Uint8Array,
  operationId: string,
): Promise<NormalizedRecords> {
  if (!hasSqliteHeader(bytes)) {
    throw failure("SQLITE_INVALID", operationId, "missing:sqlite-header");
  }
  sqliteModulePromise ??= sqlite3InitModule();
  const sqlite3 = await sqliteModulePromise;
  const database = new sqlite3.oo1.DB(":memory:", "c");
  const pointer = database.pointer;
  let allocated: Parameters<typeof sqlite3.capi.sqlite3_deserialize>[2] | undefined;
  try {
    if (!pointer) throw new Error("missing database handle");
    const transientBytes = normalizeTransientSqliteHeader(bytes);
    allocated = sqlite3.wasm.allocFromTypedArray(transientBytes);
    const rc = sqlite3.capi.sqlite3_deserialize(
      pointer,
      "main",
      allocated,
      transientBytes.byteLength,
      transientBytes.byteLength,
      1,
    );
    if (rc !== 0) database.checkRc(rc);
    allocated = undefined;
    database.checkRc(registerUnicaseCollation(sqlite3, pointer));
    database.exec("PRAGMA query_only = ON;");
    const tableRows = database.exec({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      rowMode: "object",
      returnValue: "resultRows",
    }) as Array<{ name?: unknown }>;
    const tables = tableRows.map((row) => String(row.name ?? ""));
    if (!["col", "notes", "cards"].every((table) => tables.includes(table))) {
      throw new Error("missing required tables");
    }
    const query: QueryRows = (sql) => database.exec({
      sql,
      rowMode: "object",
      returnValue: "resultRows",
    }) as SqliteRow[];
    try {
      return normalizeCollection(query, tables);
    } catch {
      throw failure("NORMALIZATION_FAILED", operationId, "invalid:collection-relationships");
    }
  } catch (error) {
    if (error instanceof CollectionFailure) throw error;
    throw failure("SQLITE_INVALID", operationId, "invalid:sqlite-collection");
  } finally {
    if (allocated !== undefined) sqlite3.wasm.dealloc(allocated);
    database.close();
  }
}

function registerUnicaseCollation(
  sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>,
  pointer: NonNullable<InstanceType<Awaited<ReturnType<typeof sqlite3InitModule>>["oo1"]["DB"]>["pointer"]>,
): number {
  return sqlite3.capi.sqlite3_create_collation_v2(
    pointer,
    "unicase",
    sqlite3.capi.SQLITE_UTF8,
    0,
    (_context: number | bigint, leftLength: number, leftPointer: number | bigint,
      rightLength: number, rightPointer: number | bigint) => {
      const heap = sqlite3.wasm.heap8u();
      const left = utf8Decoder.decode(heap.subarray(Number(leftPointer), Number(leftPointer) + leftLength));
      const right = utf8Decoder.decode(heap.subarray(Number(rightPointer), Number(rightPointer) + rightLength));
      return compareCanonical(left, right);
    },
    0,
  );
}

function normalizeCollection(query: QueryRows, tables: readonly string[]): NormalizedRecords {
  const modern = ["decks", "notetypes", "fields", "templates"].filter((table) => tables.includes(table));
  if (modern.length !== 0 && modern.length !== 4) throw new Error("incomplete modern schema");
  return modern.length === 4 ? normalizeModern(query) : normalizeLegacy(query);
}

function normalizeLegacy(query: QueryRows): NormalizedRecords {
  const rows = query("SELECT models, decks FROM col LIMIT 1");
  if (rows.length !== 1) throw new Error("invalid col row count");
  const models = jsonRecord(rows[0].models, "col.models");
  const decks = jsonRecord(rows[0].decks, "col.decks");
  const definitions = Object.entries(models).map(([key, value]) => parseLegacyNotetype(key, value));
  const deckDefinitions = Object.entries(decks).map(([key, value]) => parseLegacyDeck(key, value));
  return buildRecords(query, definitions, deckDefinitions);
}

function normalizeModern(query: QueryRows): NormalizedRecords {
  const decks = query("SELECT id, name FROM decks").map((row) => ({
    id: toId(row.id, "decks.id"),
    name: normalizeDeckName(toStringValue(row.name, "decks.name")),
  }));
  const fieldsByNotetype = new Map<string, Array<{ ordinal: number; name: string }>>();
  for (const row of query("SELECT ntid, ord, name FROM fields")) {
    const id = toId(row.ntid, "fields.ntid");
    const values = fieldsByNotetype.get(id) ?? [];
    values.push({ ordinal: toOrdinal(row.ord, "fields.ord"), name: toStringValue(row.name, "fields.name") });
    fieldsByNotetype.set(id, values);
  }
  const templatesByNotetype = new Map<string, NotetypeDefinition["templates"]>();
  for (const row of query("SELECT ntid, ord, name, config FROM templates")) {
    const id = toId(row.ntid, "templates.ntid");
    const config = toBytes(row.config, "templates.config");
    const questionFormat = readProtobufString(config, 1, "question format");
    const answerFormat = readProtobufString(config, 2, "answer format");
    if (questionFormat === undefined || answerFormat === undefined) throw new Error("missing template format");
    const values = templatesByNotetype.get(id) ?? [];
    values.push({
      ordinal: toOrdinal(row.ord, "templates.ord"),
      name: toStringValue(row.name, "templates.name"),
      questionFormat,
      answerFormat,
    });
    templatesByNotetype.set(id, values);
  }
  const definitions: NotetypeDefinition[] = [];
  for (const row of query("SELECT id, name, config FROM notetypes")) {
    const id = toId(row.id, "notetypes.id");
    const fields = fieldsByNotetype.get(id) ?? [];
    const templates = templatesByNotetype.get(id) ?? [];
    validateOrdinals(fields, `fields:${id}`);
    validateOrdinals(templates, `templates:${id}`);
    definitions.push({
      id,
      name: toStringValue(row.name, "notetypes.name"),
      fields: fields.sort(compareOrdinal),
      templates: templates.sort(compareOrdinal),
      css: readProtobufString(toBytes(row.config, "notetypes.config"), 3, "notetype css") ?? "",
    });
  }
  if (definitions.length === 0) throw new Error("no notetypes");
  const known = new Set(definitions.map((value) => value.id));
  if ([...fieldsByNotetype.keys(), ...templatesByNotetype.keys()].some((id) => !known.has(id))) {
    throw new Error("orphaned modern definitions");
  }
  return buildRecords(query, definitions, decks);
}

function parseLegacyNotetype(key: string, raw: unknown): NotetypeDefinition {
  const model = jsonRecord(raw, `models.${key}`);
  const id = toId(model.id ?? key, `models.${key}.id`);
  const fields = jsonArray(model.flds, `models.${key}.flds`).map((rawField) => {
    const field = jsonRecord(rawField, "field");
    return { ordinal: toOrdinal(field.ord, "field.ord"), name: toStringValue(field.name, "field.name") };
  });
  const templates = jsonArray(model.tmpls, `models.${key}.tmpls`).map((rawTemplate) => {
    const template = jsonRecord(rawTemplate, "template");
    return {
      ordinal: toOrdinal(template.ord, "template.ord"),
      name: toStringValue(template.name, "template.name"),
      questionFormat: toStringValue(template.qfmt, "template.qfmt"),
      answerFormat: toStringValue(template.afmt, "template.afmt"),
    };
  });
  validateOrdinals(fields, `fields:${id}`);
  validateOrdinals(templates, `templates:${id}`);
  return {
    id,
    name: toStringValue(model.name, "model.name"),
    fields: fields.sort(compareOrdinal),
    templates: templates.sort(compareOrdinal),
    css: toStringValue(model.css, "model.css"),
  };
}

function parseLegacyDeck(key: string, raw: unknown): NormalizedDeck {
  const deck = jsonRecord(raw, `decks.${key}`);
  return {
    id: toId(deck.id ?? key, `decks.${key}.id`),
    name: normalizeDeckName(toStringValue(deck.name, `decks.${key}.name`)),
  };
}

function buildRecords(
  query: QueryRows,
  rawDefinitions: readonly NotetypeDefinition[],
  rawDecks: readonly NormalizedDeck[],
): NormalizedRecords {
  const definitions = [...rawDefinitions].sort(compareNamed);
  const decks = [...rawDecks].sort(compareNamed);
  assertUniqueIds(definitions, "notetypes");
  assertUniqueIds(decks, "decks");
  const definitionsById = new Map(definitions.map((value) => [value.id, value]));
  const deckIds = new Set(decks.map((value) => value.id));

  const notetypes: NormalizedNotetype[] = definitions.map((value) => ({
    id: value.id,
    name: value.name,
    fields: value.fields.map((field) => field.name),
    templates: value.templates.map((template) => template.name),
    css: value.css,
  }));
  const fields: NormalizedField[] = definitions.flatMap((definition) => definition.fields.map((field) => ({
    notetypeId: definition.id,
    ordinal: field.ordinal,
    name: field.name,
  })));
  const cardTemplates: NormalizedCardTemplate[] = definitions.flatMap((definition) => definition.templates.map((template) => ({
    notetypeId: definition.id,
    ...template,
  })));

  const rawNotes = query("SELECT id, guid, mid, tags, flds FROM notes").map((row) => ({
    id: toId(row.id, "notes.id"),
    sourceGuid: toStringValue(row.guid, "notes.guid"),
    notetypeId: toId(row.mid, "notes.mid"),
    tags: parseTags(row.tags),
    fieldText: toStringValue(row.flds, "notes.flds"),
  })).sort(compareIdentified);
  assertUniqueIds(rawNotes, "notes");
  const noteDefinitions = new Map<string, NotetypeDefinition>();
  for (const note of rawNotes) {
    const definition = definitionsById.get(note.notetypeId);
    if (!definition) throw new Error("note refers to unknown notetype");
    noteDefinitions.set(note.id, definition);
  }

  const rawCards = query("SELECT id, nid, did, ord FROM cards").map((row) => ({
    id: toId(row.id, "cards.id"),
    noteId: toId(row.nid, "cards.nid"),
    deckId: toId(row.did, "cards.did"),
    templateOrdinal: toOrdinal(row.ord, "cards.ord"),
  })).sort(compareIdentified);
  assertUniqueIds(rawCards, "cards");
  const cardsByNote = new Map<string, typeof rawCards>();
  const cards: NormalizedCard[] = rawCards.map((card) => {
    const definition = noteDefinitions.get(card.noteId);
    if (!definition || !deckIds.has(card.deckId) || card.templateOrdinal >= definition.templates.length) {
      throw new Error("card relationship is invalid");
    }
    const noteCards = cardsByNote.get(card.noteId) ?? [];
    noteCards.push(card);
    cardsByNote.set(card.noteId, noteCards);
    return { ...card, scheduling: "fresh" };
  });
  const notes: NormalizedNote[] = rawNotes.map((note) => {
    const definition = noteDefinitions.get(note.id)!;
    const noteCards = cardsByNote.get(note.id) ?? [];
    const noteFields = note.fieldText.split("\x1f");
    if (noteCards.length === 0 || noteFields.length !== definition.fields.length) {
      throw new Error("note shape is invalid");
    }
    return {
      id: note.id,
      sourceGuid: note.sourceGuid,
      notetypeId: note.notetypeId,
      deckId: noteCards[0].deckId,
      fields: noteFields,
      tags: note.tags,
    };
  });
  return { decks, notetypes, fields, cardTemplates, notes, cards };
}

function createCheckpoint(control: CollectionControl) {
  return (stage: "decompressing-collection" | "parsing-records"): void => {
    if (control.isCancelled?.()) {
      throw new CollectionFailure(importError("IMPORT_CANCELLED", {
        operationId: control.operationId,
        stage,
      }));
    }
    const now = control.now?.() ?? performance.now();
    if (now - control.startedAt > control.limits.maxParseTimeMs) {
      throw new CollectionFailure(importError("IMPORT_TIMEOUT", {
        operationId: control.operationId,
        stage,
      }));
    }
  };
}

function failure(
  code: "UNSUPPORTED_PACKAGE" | "PROTOBUF_INVALID" | "ZSTD_INVALID" | "SQLITE_INVALID" | "NORMALIZATION_FAILED" | "ARCHIVE_LIMIT_EXCEEDED",
  operationId: string,
  detail: string,
): CollectionFailure {
  const stage = code === "SQLITE_INVALID" || code === "NORMALIZATION_FAILED"
    ? "parsing-records"
    : code === "ZSTD_INVALID" || code === "ARCHIVE_LIMIT_EXCEEDED"
      ? "decompressing-collection"
      : "validating-archive";
  return new CollectionFailure(importError(code, { operationId, stage, detail }));
}

function hasSqliteHeader(bytes: Uint8Array): boolean {
  const header = textEncoder.encode("SQLite format 3\0");
  return bytes.byteLength >= header.byteLength && header.every((byte, index) => bytes[index] === byte);
}

function normalizeTransientSqliteHeader(bytes: Uint8Array): Uint8Array {
  if (bytes[18] !== 2 && bytes[19] !== 2) return bytes;
  const copy = bytes.slice();
  copy[18] = 1;
  copy[19] = 1;
  return copy;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be an object`);
  return parsed as Record<string, unknown>;
}

function jsonArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function toStringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function toId(value: unknown, label: string): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "bigint" && value >= 0n) return String(value);
  throw new Error(`${label} must be a non-negative integer`);
}

function toOrdinal(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be an ordinal`);
  return value;
}

function toBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`${label} must be bytes`);
}

function parseTags(value: unknown): string[] {
  const text = toStringValue(value, "notes.tags").trim();
  return text === "" ? [] : [...new Set(text.split(/\s+/))].sort(compareCanonical);
}

function readProtobufString(bytes: Uint8Array, fieldNumber: number, label: string): string | undefined {
  try {
    const reader = protobuf.Reader.create(bytes);
    let value: string | undefined;
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      if ((tag >>> 3) === fieldNumber) {
        if ((tag & 7) !== 2 || value !== undefined) throw new Error("invalid field");
        value = reader.string();
      } else reader.skipType(tag & 7);
    }
    return value;
  } catch {
    throw new Error(`${label} is invalid protobuf`);
  }
}

function validateOrdinals(values: readonly { ordinal: number }[], label: string): void {
  [...values].sort(compareOrdinal).forEach((value, index) => {
    if (value.ordinal !== index) throw new Error(`${label} ordinals are not contiguous`);
  });
}

function assertUniqueIds(values: readonly { id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${label} contain duplicate IDs`);
    ids.add(value.id);
  }
}

function normalizeDeckName(name: string): string {
  return name.replaceAll("\x1f", "::");
}

function compareOrdinal(left: { ordinal: number }, right: { ordinal: number }): number {
  return left.ordinal - right.ordinal;
}

function compareIdentified(left: { id: string }, right: { id: string }): number {
  return compareCanonical(left.id, right.id);
}

function compareNamed(left: { id: string; name: string }, right: { id: string; name: string }): number {
  return compareCanonical(left.name, right.name) || compareCanonical(left.id, right.id);
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
