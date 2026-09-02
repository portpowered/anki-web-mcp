import { Decompress } from "fzstd";
import * as protobuf from "protobufjs/minimal";

import type {
  ImportWarning,
  NormalizedCard,
  NormalizedImportGraph,
  NormalizedMedia,
} from "../contracts";
import { importError, type ImportError, type ImportErrorCode } from "../errors";
import type { ImportLimits } from "../limits";
import type { ValidatedArchive } from "./archive";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const ACTIVE_EXTENSIONS = new Set(["css", "htm", "html", "js", "mjs", "svg", "swf", "wasm", "xhtml", "xml"]);
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg", mp3: "audio/mpeg",
  oga: "audio/ogg", ogg: "audio/ogg", png: "image/png", txt: "text/plain",
  wav: "audio/wav", webp: "image/webp",
});

export interface MediaControl {
  readonly operationId: string;
  readonly limits: ImportLimits;
  readonly now?: () => number;
  readonly startedAt: number;
  readonly isCancelled?: () => boolean;
  readonly checkpoint?: () => void;
}

export interface MediaImportResult {
  readonly graph: NormalizedImportGraph;
  readonly warnings: readonly ImportWarning[];
}

interface MediaMapEntry {
  readonly sourceMember: string;
  readonly name: string;
  readonly declaredBytes?: number;
  readonly declaredSha1?: Uint8Array;
}

export class MediaImportFailure extends Error {
  public constructor(public readonly error: ImportError) {
    super(error.message);
    this.name = "MediaImportFailure";
  }
}

/** Verify package media and resolve inert logical names to deterministic keys. */
export async function importPackageMedia(
  graph: NormalizedImportGraph,
  archive: ValidatedArchive,
  control: MediaControl,
): Promise<MediaImportResult> {
  const checkpoint = createCheckpoint(control);
  checkpoint();
  const members = new Map(archive.members.map((member) => [member.path, member]));
  const mediaMember = members.get("media");
  if (!mediaMember) throw failure("MEDIA_MAP_INVALID", control.operationId, "missing:media-map");

  let mapBytes = mediaMember.bytes;
  if (graph.layout === "current-anki21b") {
    mapBytes = decompressZstd(mapBytes, control.limits.maxUtf8Bytes, control.operationId, "media-map", "MEDIA_MAP_INVALID");
  }
  enforceUtf8ByteLimit(mapBytes, "media-map", control);
  const entries = graph.layout === "current-anki21b"
    ? parseProtobufMap(mapBytes, control.operationId)
    : parseJsonMap(mapBytes, control.operationId);
  if (entries.length > control.limits.maxMediaCount) {
    throw failure("ARCHIVE_LIMIT_EXCEEDED", control.operationId, `maxMediaCount:${entries.length}:${control.limits.maxMediaCount}`);
  }

  const media: NormalizedMedia[] = [];
  let aggregateBytes = 0;
  for (const entry of entries) {
    checkpoint();
    const member = members.get(entry.sourceMember);
    if (!member) throw failure("MEDIA_MAP_INVALID", control.operationId, `missing-member:${entry.sourceMember}`);
    const bytes = graph.layout === "current-anki21b"
      ? decompressZstd(member.bytes, control.limits.maxMediaFileBytes, control.operationId, entry.sourceMember, "MEDIA_INVALID")
      : member.bytes;
    if (bytes.byteLength > control.limits.maxMediaFileBytes) {
      throw failure("ARCHIVE_LIMIT_EXCEEDED", control.operationId, `maxMediaFileBytes:${bytes.byteLength}:${control.limits.maxMediaFileBytes}`);
    }
    aggregateBytes += bytes.byteLength;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > control.limits.maxMediaBytes) {
      throw failure("ARCHIVE_LIMIT_EXCEEDED", control.operationId, `maxMediaBytes:${aggregateBytes}:${control.limits.maxMediaBytes}`);
    }
    const mimeType = sniffMime(bytes, control);
    validateMime(entry.name, mimeType, control);
    if (entry.declaredBytes !== undefined && entry.declaredBytes !== bytes.byteLength) {
      throw failure("MEDIA_MAP_INVALID", control.operationId, `declared-size:${entry.name}`);
    }
    if (entry.declaredSha1 && bytesToHex(entry.declaredSha1) !== await digest("SHA-1", bytes)) {
      throw failure("MEDIA_MAP_INVALID", control.operationId, `declared-sha1:${entry.name}`);
    }
    const sha256 = await digest("SHA-256", bytes);
    media.push(Object.freeze({
      id: `${graph.packageSha256}/media/${encodeURIComponent(entry.name)}`,
      importPackageSha256: graph.packageSha256,
      sourceMember: entry.sourceMember,
      name: entry.name,
      byteLength: bytes.byteLength,
      sha256,
      mimeType,
      bytes: bytes.slice(),
    }));
    control.checkpoint?.();
  }
  checkpoint();
  media.sort((left, right) => compareCanonical(left.name, right.name));

  const warnings: ImportWarning[] = [];
  const mappedMembers = new Set(entries.map((entry) => entry.sourceMember));
  for (const member of archive.members) {
    if (/^\d+$/.test(member.path) && !mappedMembers.has(member.path)) {
      warnings.push(Object.freeze({
        code: "MISSING_MEDIA_MAP_ENTRY",
        message: "An archive media member was not declared by the media map and was ignored.",
        stage: "importing-media",
        source: { kind: "media" as const, id: member.path },
      }));
    }
  }

  const mediaByName = new Map(media.map((item) => [item.name, item]));
  const warnedMissing = new Set<string>();
  const cards = graph.cards.map((card) => resolveCardMedia(card, mediaByName, warnings, warnedMissing));
  return Object.freeze({
    graph: Object.freeze({ ...graph, cards: Object.freeze(cards), media: Object.freeze(media) }),
    warnings: Object.freeze(warnings),
  });
}

function parseJsonMap(bytes: Uint8Array, operationId: string): MediaMapEntry[] {
  try {
    const text = utf8Decoder.decode(bytes);
    const entries = parseJsonStringObject(text).map(([sourceMember, rawName]) => {
      if (!/^\d+$/.test(sourceMember)) throw new Error("invalid entry");
      return { sourceMember, name: normalizeMediaName(rawName, operationId) };
    });
    validateUniqueNames(entries, operationId);
    return entries;
  } catch (error) {
    if (error instanceof MediaImportFailure) throw error;
    throw failure("MEDIA_MAP_INVALID", operationId, "invalid:legacy-media-map");
  }
}

function parseProtobufMap(bytes: Uint8Array, operationId: string): MediaMapEntry[] {
  try {
    const reader = protobuf.Reader.create(bytes);
    const entries: MediaMapEntry[] = [];
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      if ((tag >>> 3) !== 1 || (tag & 7) !== 2) { reader.skipType(tag & 7); continue; }
      const length = reader.uint32();
      const end = reader.pos + length;
      if (end > reader.len) throw new Error("truncated entry");
      const entryReader = protobuf.Reader.create(reader.buf.subarray(reader.pos, end));
      reader.pos = end;
      let name: string | undefined;
      let declaredBytes: number | undefined;
      let declaredSha1: Uint8Array | undefined;
      while (entryReader.pos < entryReader.len) {
        const entryTag = entryReader.uint32();
        if ((entryTag >>> 3) === 1 && (entryTag & 7) === 2) name = entryReader.string();
        else if ((entryTag >>> 3) === 2 && (entryTag & 7) === 0) declaredBytes = entryReader.uint32();
        else if ((entryTag >>> 3) === 3 && (entryTag & 7) === 2) declaredSha1 = entryReader.bytes();
        else entryReader.skipType(entryTag & 7);
      }
      if (name === undefined || declaredBytes === undefined || declaredSha1?.byteLength !== 20) throw new Error("incomplete entry");
      entries.push({ sourceMember: String(entries.length), name: normalizeMediaName(name, operationId), declaredBytes, declaredSha1 });
    }
    if (entries.length === 0) throw new Error("empty map");
    validateUniqueNames(entries, operationId);
    return entries;
  } catch (error) {
    if (error instanceof MediaImportFailure) throw error;
    throw failure("MEDIA_MAP_INVALID", operationId, "invalid:current-media-map");
  }
}

function normalizeMediaName(raw: string, operationId: string): string {
  const name = raw.trim().normalize("NFC").replaceAll("\\", "/");
  if (!name || name !== raw.normalize("NFC") || name.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(name)
    || name.includes("/") || name === "." || name === ".." || name.includes("\0")) {
    throw failure("ARCHIVE_PATH_UNSAFE", operationId, `unsafe-media-name:${name.slice(0, 80)}`);
  }
  return name;
}

function validateUniqueNames(entries: readonly MediaMapEntry[], operationId: string): void {
  const names = new Set<string>();
  const sources = new Set<string>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (names.has(key) || sources.has(entry.sourceMember)) {
      throw failure("ARCHIVE_PATH_UNSAFE", operationId, `duplicate-media:${entry.name}`);
    }
    names.add(key);
    sources.add(entry.sourceMember);
  }
}

function resolveCardMedia(
  card: NormalizedCard,
  mediaByName: ReadonlyMap<string, NormalizedMedia>,
  warnings: ImportWarning[],
  warnedMissing: Set<string>,
): NormalizedCard {
  const resolved: string[] = [];
  let frontHtml = card.content.frontHtml;
  let backHtml = card.content.backHtml;
  for (const name of card.content.mediaReferences) {
    const item = mediaByName.get(name);
    if (!item) {
      if (!warnedMissing.has(name)) {
        warnedMissing.add(name);
        warnings.push(Object.freeze({
          code: "MISSING_MEDIA",
          message: "Referenced package media is missing; the card remains importable without it.",
          stage: "importing-media",
          source: { kind: "media" as const, id: name },
        }));
      }
      const missingPattern = new RegExp(`\\s*data-anki-media-ref="${escapeRegExp(escapeAttribute(name))}"`, "g");
      frontHtml = frontHtml.replace(missingPattern, "");
      backHtml = backHtml.replace(missingPattern, "");
      continue;
    }
    resolved.push(item.id);
    const escapedName = escapeRegExp(escapeAttribute(name));
    const replacement = `data-anki-media-ref="${escapeAttribute(item.id)}"`;
    const pattern = new RegExp(`data-anki-media-ref="${escapedName}"`, "g");
    frontHtml = frontHtml.replace(pattern, replacement);
    backHtml = backHtml.replace(pattern, replacement);
  }
  return Object.freeze({ ...card, content: Object.freeze({
    ...card.content,
    frontHtml,
    backHtml,
    mediaReferences: Object.freeze([...new Set(resolved)].sort(compareCanonical)),
  }) });
}

function sniffMime(bytes: Uint8Array, control: MediaControl): string | null {
  if (containsActivePayload(bytes)) return null;
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  const head6 = ascii(bytes.subarray(0, 6));
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes.subarray(0, 4)) === "RIFF" && ascii(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (ascii(bytes.subarray(0, 4)) === "RIFF" && ascii(bytes.subarray(8, 12)) === "WAVE") return "audio/wav";
  if (ascii(bytes.subarray(0, 4)) === "OggS") return "audio/ogg";
  if (ascii(bytes.subarray(0, 3)) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  try {
    enforceUtf8ByteLimit(bytes, "text-media", control);
    const text = utf8Decoder.decode(bytes);
    if (!text.includes("\0") && !/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return "text/plain";
  } catch (error) {
    if (error instanceof MediaImportFailure) throw error;
    /* Binary data is intentionally rejected below. */
  }
  return null;
}

function enforceUtf8ByteLimit(
  bytes: Uint8Array,
  label: string,
  control: Pick<MediaControl, "operationId" | "limits">,
): void {
  if (bytes.byteLength > control.limits.maxUtf8Bytes) {
    throw failure(
      "ARCHIVE_LIMIT_EXCEEDED",
      control.operationId,
      `maxUtf8Bytes:${label}:${bytes.byteLength}:${control.limits.maxUtf8Bytes}`,
    );
  }
}

function containsActivePayload(bytes: Uint8Array): boolean {
  const sample = ascii(bytes).toLowerCase();
  return ["<script", "<svg", "<html", "<!doctype", "javascript:", "<iframe", "<object"].some((token) => sample.includes(token));
}

function parseJsonStringObject(text: string): Array<[string, string]> {
  let cursor = 0;
  const skipWhitespace = () => { while (/\s/.test(text[cursor] ?? "")) cursor += 1; };
  const stringValue = (): string => {
    skipWhitespace();
    if (text[cursor] !== '"') throw new Error("expected string");
    const start = cursor++;
    let escaped = false;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (!escaped && character === '"') return JSON.parse(text.slice(start, cursor)) as string;
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
    }
    throw new Error("unterminated string");
  };
  skipWhitespace();
  if (text[cursor++] !== "{") throw new Error("expected object");
  const entries: Array<[string, string]> = [];
  const keys = new Set<string>();
  skipWhitespace();
  if (text[cursor] === "}") cursor += 1;
  else {
    while (cursor < text.length) {
      const key = stringValue();
      if (keys.has(key)) throw new Error("duplicate source member");
      keys.add(key);
      skipWhitespace();
      if (text[cursor++] !== ":") throw new Error("expected colon");
      entries.push([key, stringValue()]);
      skipWhitespace();
      const separator = text[cursor++];
      if (separator === "}") break;
      if (separator !== ",") throw new Error("expected separator");
    }
  }
  skipWhitespace();
  if (cursor !== text.length) throw new Error("trailing data");
  return entries;
}

function validateMime(name: string, mimeType: string | null, control: MediaControl): asserts mimeType is string {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const expected = MIME_BY_EXTENSION[extension];
  if (!mimeType || ACTIVE_EXTENSIONS.has(extension) || !expected || expected !== mimeType
    || !control.limits.allowedMediaMimeTypes.includes(mimeType)) {
    throw failure("MIME_NOT_ALLOWED", control.operationId, `mime:${name}:${mimeType ?? "unknown"}`);
  }
}

function decompressZstd(bytes: Uint8Array, maximumOutput: number, operationId: string, label: string, code: ImportErrorCode): Uint8Array {
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const decoder = new Decompress((chunk) => {
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumOutput) throw failure("ARCHIVE_LIMIT_EXCEEDED", operationId, `${label}:${total}:${maximumOutput}`);
      chunks.push(chunk.slice());
    });
    decoder.push(bytes, true);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  } catch (error) {
    if (error instanceof MediaImportFailure) throw error;
    throw failure(code, operationId, `invalid-zstd:${label}`);
  }
}

function createCheckpoint(control: MediaControl): () => void {
  return () => {
    if (control.isCancelled?.()) throw failure("IMPORT_CANCELLED", control.operationId, "cancelled");
    if ((control.now?.() ?? performance.now()) - control.startedAt > control.limits.maxParseTimeMs) {
      throw failure("IMPORT_TIMEOUT", control.operationId, "parse-time");
    }
  };
}

async function digest(algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(algorithm, input)));
}

function failure(code: ImportErrorCode, operationId: string, detail: string): MediaImportFailure {
  return new MediaImportFailure(importError(code, { operationId, stage: "importing-media", detail }));
}
function bytesToHex(bytes: Uint8Array): string { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function ascii(bytes: Uint8Array): string { return String.fromCharCode(...bytes); }
function matches(bytes: Uint8Array, signature: readonly number[]): boolean { return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value); }
function compareCanonical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function escapeAttribute(value: string): string { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
