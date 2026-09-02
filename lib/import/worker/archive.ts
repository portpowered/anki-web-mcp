import { unzip, type UnzipFileInfo } from "fflate";

import { importError, type ImportError } from "../errors";
import type { ImportLimits } from "../limits";

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffff;
const ZIP_SIGNATURES = new Set([
  LOCAL_FILE_SIGNATURE,
  CENTRAL_DIRECTORY_SIGNATURE,
  END_OF_CENTRAL_DIRECTORY_SIGNATURE,
]);
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface ValidatedArchiveMember {
  readonly path: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly crc32: number;
  readonly bytes: Uint8Array;
}

export interface ValidatedArchive {
  readonly members: readonly ValidatedArchiveMember[];
  readonly expandedBytes: number;
  readonly nestedArchiveCount: number;
}

export interface ArchiveValidationControl {
  readonly operationId: string;
  readonly now?: () => number;
  readonly startedAt?: number;
  readonly isCancelled?: () => boolean;
}

export class ArchiveValidationFailure extends Error {
  public constructor(public readonly error: ImportError) {
    super(error.message);
    this.name = "ArchiveValidationFailure";
  }
}

interface CentralDirectoryMember {
  readonly rawPath: Uint8Array;
  readonly path: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

/**
 * Validate and expand one APKG ZIP under caller-supplied limits.
 *
 * This module is imported by the dedicated Worker runtime. It deliberately
 * does not expose a main-thread fallback or attempt to interpret collection
 * records.
 */
export async function validateArchive(
  packageBytes: Uint8Array,
  limits: ImportLimits,
  control: ArchiveValidationControl,
): Promise<ValidatedArchive> {
  const checkpoint = createCheckpoint(limits, control);
  checkpoint();
  enforceLimit(
    packageBytes.byteLength <= limits.maxPackageBytes,
    control.operationId,
    `maxPackageBytes:${packageBytes.byteLength}:${limits.maxPackageBytes}`,
  );

  const centralMembers = readCentralDirectory(packageBytes, limits, control, checkpoint);
  checkpoint();
  const extracted = await expandArchive(packageBytes, centralMembers, control, checkpoint);
  checkpoint();

  let nestedArchiveCount = 0;
  const members: ValidatedArchiveMember[] = [];
  for (const central of centralMembers) {
    checkpoint();
    const bytes = extracted.get(central.path);
    if (!bytes || bytes.byteLength !== central.expandedBytes) {
      failInvalid(control.operationId, `member-size:${central.path}`);
    }
    if (crc32(bytes) !== central.crc32) {
      failInvalid(control.operationId, `member-crc:${central.path}`);
    }
    if (looksLikeZip(bytes)) {
      nestedArchiveCount += 1;
      enforceLimit(
        nestedArchiveCount <= limits.maxNestedArchives,
        control.operationId,
        `maxNestedArchives:${nestedArchiveCount}:${limits.maxNestedArchives}`,
      );
    }
    members.push(Object.freeze({
      path: central.path,
      compressedBytes: central.compressedBytes,
      expandedBytes: central.expandedBytes,
      crc32: central.crc32,
      bytes,
    }));
  }

  return Object.freeze({
    members: Object.freeze(members),
    expandedBytes: members.reduce((total, member) => total + member.expandedBytes, 0),
    nestedArchiveCount,
  });
}

function readCentralDirectory(
  bytes: Uint8Array,
  limits: ImportLimits,
  control: ArchiveValidationControl,
  checkpoint: () => void,
): CentralDirectoryMember[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0 || eocdOffset + 22 > bytes.byteLength) {
    failInvalid(control.operationId, "end-of-central-directory");
  }

  const disk = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const commentBytes = view.getUint16(eocdOffset + 20, true);
  if (
    disk !== 0
    || centralDisk !== 0
    || diskEntries !== totalEntries
    || totalEntries === ZIP64_SENTINEL
    || eocdOffset + 22 + commentBytes !== bytes.byteLength
    || centralOffset + centralBytes !== eocdOffset
  ) {
    failInvalid(control.operationId, "central-directory-structure");
  }
  enforceLimit(
    totalEntries <= limits.maxArchiveEntries,
    control.operationId,
    `maxArchiveEntries:${totalEntries}:${limits.maxArchiveEntries}`,
  );
  if (totalEntries === 0) {
    failInvalid(control.operationId, "empty-archive");
  }

  const members: CentralDirectoryMember[] = [];
  const normalizedPaths = new Set<string>();
  let cursor = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    checkpoint();
    if (cursor + 46 > eocdOffset || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      failInvalid(control.operationId, "central-directory-entry");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const memberExpandedBytes = view.getUint32(cursor + 24, true);
    const nameBytes = view.getUint16(cursor + 28, true);
    const extraBytes = view.getUint16(cursor + 30, true);
    const memberCommentBytes = view.getUint16(cursor + 32, true);
    const memberDisk = view.getUint16(cursor + 34, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nextCursor = cursor + 46 + nameBytes + extraBytes + memberCommentBytes;
    if (
      nextCursor > eocdOffset
      || memberDisk !== 0
      || (flags & 0x0001) !== 0
      || (method !== 0 && method !== 8)
      || compressedBytes === 0xffffffff
      || memberExpandedBytes === 0xffffffff
      || localHeaderOffset === 0xffffffff
    ) {
      failInvalid(control.operationId, "unsupported-zip-entry");
    }

    const rawPath = bytes.slice(cursor + 46, cursor + 46 + nameBytes);
    const path = decodeAndNormalizePath(rawPath, (flags & 0x0800) !== 0, control.operationId);
    const collisionKey = path.normalize("NFC").toLowerCase();
    if (normalizedPaths.has(collisionKey)) {
      failPath(control.operationId, `duplicate-normalized-path:${path}`);
    }
    normalizedPaths.add(collisionKey);
    validateLocalHeader(bytes, view, rawPath, localHeaderOffset, compressedBytes, centralOffset, control.operationId);

    enforceLimit(
      memberExpandedBytes <= limits.maxEntryBytes,
      control.operationId,
      `maxEntryBytes:${path}:${memberExpandedBytes}:${limits.maxEntryBytes}`,
    );
    if (
      compressedBytes === 0
        ? memberExpandedBytes !== 0
        : memberExpandedBytes / compressedBytes > limits.maxCompressionRatio
    ) {
      failLimit(control.operationId, `maxCompressionRatio:${path}`);
    }
    const nextExpandedBytes = expandedBytes + memberExpandedBytes;
    if (!Number.isSafeInteger(nextExpandedBytes)) {
      failLimit(control.operationId, "maxExpandedBytes:overflow");
    }
    enforceLimit(
      nextExpandedBytes <= limits.maxExpandedBytes,
      control.operationId,
      `maxExpandedBytes:${nextExpandedBytes}:${limits.maxExpandedBytes}`,
    );
    expandedBytes = nextExpandedBytes;
    members.push({
      rawPath,
      path,
      compressedBytes,
      expandedBytes: memberExpandedBytes,
      crc32: crc,
      localHeaderOffset,
    });
    cursor = nextCursor;
  }
  if (cursor !== eocdOffset) {
    failInvalid(control.operationId, "central-directory-length");
  }
  for (const member of members) {
    enforceAcceptedNamespace(member.path, control.operationId);
  }
  enforceRequiredMemberShape(members.map((member) => member.path), control.operationId);
  return members;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 22 - MAX_ZIP_COMMENT_BYTES);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

function decodeAndNormalizePath(
  rawPath: Uint8Array,
  explicitlyUtf8: boolean,
  operationId: string,
): string {
  if (rawPath.byteLength === 0 || (!explicitlyUtf8 && rawPath.some((byte) => byte > 0x7f))) {
    failPath(operationId, "ambiguous-path-encoding");
  }
  let decoded: string;
  try {
    decoded = textDecoder.decode(rawPath);
  } catch {
    failPath(operationId, "malformed-utf8-path");
  }
  const path = decoded.normalize("NFC");
  if (
    path !== decoded && path.normalize("NFD") !== decoded
    || path.startsWith("/")
    || path.startsWith("\\")
    || /^[a-zA-Z]:/.test(path)
    || path.includes("/")
    || path.includes("\\")
    || path === "."
    || path === ".."
    || /[\u0000-\u001f\u007f]/.test(path)
  ) {
    failPath(operationId, `unsafe-path:${bounded(path)}`);
  }
  return path;
}

function enforceAcceptedNamespace(path: string, operationId: string): void {
  if (
    path === "collection.anki2"
    || path === "collection.anki21"
    || path === "collection.anki21b"
    || path === "media"
    || path === "meta"
    || /^\d+$/.test(path)
  ) {
    return;
  }
  failPath(operationId, `outside-apkg-namespace:${bounded(path)}`);
}

function enforceRequiredMemberShape(paths: readonly string[], operationId: string): void {
  const names = new Set(paths);
  const hasLegacy = names.has("collection.anki2");
  const hasTransition = names.has("collection.anki21");
  const hasCurrent = names.has("collection.anki21b");
  if (hasTransition && hasCurrent) {
    failInvalid(operationId, "ambiguous-required-collection");
  }
  if (!hasLegacy && !hasTransition && !hasCurrent) {
    failInvalid(operationId, "missing-required-collection");
  }
}

function validateLocalHeader(
  bytes: Uint8Array,
  view: DataView,
  centralPath: Uint8Array,
  offset: number,
  compressedBytes: number,
  centralOffset: number,
  operationId: string,
): void {
  if (offset + 30 > centralOffset || view.getUint32(offset, true) !== LOCAL_FILE_SIGNATURE) {
    failInvalid(operationId, "local-file-header");
  }
  const nameBytes = view.getUint16(offset + 26, true);
  const extraBytes = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + nameBytes + extraBytes;
  if (dataOffset + compressedBytes > centralOffset) {
    failInvalid(operationId, "local-file-bounds");
  }
  const localPath = bytes.subarray(offset + 30, offset + 30 + nameBytes);
  if (localPath.byteLength !== centralPath.byteLength || !localPath.every((byte, index) => byte === centralPath[index])) {
    failInvalid(operationId, "local-central-path-mismatch");
  }
}

function expandArchive(
  bytes: Uint8Array,
  centralMembers: readonly CentralDirectoryMember[],
  control: ArchiveValidationControl,
  checkpoint: () => void,
): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    let callbackFailure: ArchiveValidationFailure | undefined;
    const canonicalByOriginal = new Map(centralMembers.map((member) => [textDecoder.decode(member.rawPath), member.path]));
    try {
      unzip(bytes, {
        filter(file: UnzipFileInfo): boolean {
          try {
            checkpoint();
            return canonicalByOriginal.has(file.name);
          } catch (error) {
            callbackFailure = asArchiveFailure(error, control.operationId);
            return false;
          }
        },
      }, (error, entries) => {
        if (callbackFailure) {
          reject(callbackFailure);
          return;
        }
        try {
          checkpoint();
          if (error || !entries) {
            failInvalid(control.operationId, "zip-decompression");
          }
          const output = new Map<string, Uint8Array>();
          for (const [originalPath, memberBytes] of Object.entries(entries)) {
            const canonical = canonicalByOriginal.get(originalPath);
            if (!canonical || output.has(canonical)) {
              failInvalid(control.operationId, "zip-entry-mapping");
            }
            output.set(canonical, memberBytes);
          }
          if (output.size !== centralMembers.length) {
            failInvalid(control.operationId, "zip-entry-count");
          }
          resolve(output);
        } catch (caught) {
          reject(asArchiveFailure(caught, control.operationId));
        }
      });
    } catch (error) {
      reject(asArchiveFailure(error, control.operationId));
    }
  });
}

function createCheckpoint(limits: ImportLimits, control: ArchiveValidationControl): () => void {
  const now = control.now ?? (() => performance.now());
  const startedAt = control.startedAt ?? now();
  return (): void => {
    if (control.isCancelled?.()) {
      throw new ArchiveValidationFailure(importError("IMPORT_CANCELLED", {
        operationId: control.operationId,
        stage: "validating-archive",
      }));
    }
    if (now() - startedAt > limits.maxParseTimeMs) {
      throw new ArchiveValidationFailure(importError("IMPORT_TIMEOUT", {
        operationId: control.operationId,
        stage: "validating-archive",
        detail: `maxParseTimeMs:${limits.maxParseTimeMs}`,
      }));
    }
  };
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4
    && ZIP_SIGNATURES.has(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function enforceLimit(condition: boolean, operationId: string, detail: string): asserts condition {
  if (!condition) {
    failLimit(operationId, detail);
  }
}

function failLimit(operationId: string, detail: string): never {
  throw new ArchiveValidationFailure(importError("ARCHIVE_LIMIT_EXCEEDED", {
    operationId,
    stage: "validating-archive",
    detail,
  }));
}

function failInvalid(operationId: string, detail: string): never {
  throw new ArchiveValidationFailure(importError("ARCHIVE_INVALID", {
    operationId,
    stage: "validating-archive",
    detail,
  }));
}

function failPath(operationId: string, detail: string): never {
  throw new ArchiveValidationFailure(importError("ARCHIVE_PATH_UNSAFE", {
    operationId,
    stage: "validating-archive",
    detail,
  }));
}

function asArchiveFailure(error: unknown, operationId: string): ArchiveValidationFailure {
  return error instanceof ArchiveValidationFailure
    ? error
    : new ArchiveValidationFailure(importError("ARCHIVE_INVALID", {
      operationId,
      stage: "validating-archive",
    }));
}

function bounded(value: string): string {
  return value.slice(0, 96);
}
