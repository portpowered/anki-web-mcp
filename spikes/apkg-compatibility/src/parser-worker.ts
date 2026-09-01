import { unzip, type UnzipFileInfo } from "fflate";
import { Decompress as ZstdDecompressor } from "fzstd";
import * as protobuf from "protobufjs/minimal";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import filterXSS, { safeAttrValue as defaultSafeAttrValue } from "xss";
import {
  DEFAULT_PARSE_LIMITS,
  PARSER_STAGES,
  type NormalizedCard,
  type NormalizedCardTemplate,
  type NormalizedDeck,
  type NormalizedField,
  type NormalizedNote,
  type NormalizedNotetype,
  type NormalizedStagedResult,
  type ParseLimits,
  type ParseRequest,
  type ParserArchiveEntry,
  type ParserDiagnostic,
  type ParserErrorCode,
  type ParserMediaEntry,
  type ParserProgressMessage,
  type ParserStage,
  type ParserTerminalMessage,
  type ParserUnsupportedMessage,
  type ParserWorkerMessage,
  type ParserWarning,
  type ParserWarningCode,
  type SupportedLayout,
} from "./protocol";

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const cancelledOperations = new Set<string>();
const activeOperations = new Set<string>();
const completedOperations: string[] = [];
let sqliteModulePromise: ReturnType<typeof sqlite3InitModule> | undefined;

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data as {
    type?: unknown;
    operationId?: unknown;
  };

  if (request.type === "cancel" && typeof request.operationId === "string") {
    if (activeOperations.has(request.operationId)) {
      cancelledOperations.add(request.operationId);
    }
    return;
  }

  if (request.type !== "parse" || typeof request.operationId !== "string") {
    return;
  }

  if (
    activeOperations.has(request.operationId) ||
    completedOperations.includes(request.operationId)
  ) {
    // Operation IDs are single-use. A duplicate request cannot create a
    // second terminal or re-open a result that has already been settled.
    return;
  }

  activeOperations.add(request.operationId);
  void parseOperation(request as ParseRequest);
});

async function parseOperation(request: ParseRequest): Promise<void> {
  const startedAt = performance.now();
  let currentStage: ParserStage = PARSER_STAGES[0];
  let terminalSent = false;
  const context = new ParseContext(request, startedAt, (message) => {
    workerScope.postMessage(message satisfies ParserWorkerMessage);
  });

  const sendTerminal = (message: ParserTerminalMessage): void => {
    if (terminalSent) {
      return;
    }
    terminalSent = true;
    const transfer = message.status === "success"
      ? message.stagedResult.normalized.media.map((media) => media.bytes)
      : [];
    workerScope.postMessage(message satisfies ParserWorkerMessage, transfer);
  };

  try {
    const limits = validateRequest(request);
    context.setLimits(limits);

    currentStage = "archive";
    await context.checkpoint(currentStage);
    const archive = await readArchive(
      new Uint8Array(request.packageBytes),
      limits,
    );
    context.reserveMemory(
      request.packageBytes.byteLength + archive.memoryBytes,
      currentStage,
      "transferred package and extracted ZIP members",
    );
    await context.checkpoint(currentStage);
    context.progress(currentStage, 1);

    currentStage = "collection";
    await context.checkpoint(currentStage);
    const detected = detectLayout(archive.entries);
    await context.checkpoint(currentStage);
    context.progress(currentStage, 2);

    currentStage = "decompression";
    await context.checkpoint(currentStage);
    const decompressed = decompressCollection(
      detected,
      archive.entries,
      context,
    );
    context.addExpandedBytes(
      decompressed.collectionBytes.byteLength,
      currentStage,
    );
    await context.checkpoint(currentStage);
    context.progress(currentStage, 3);

    currentStage = "database";
    await context.checkpoint(currentStage);
    context.reserveMemory(
      decompressed.collectionBytes.byteLength,
      currentStage,
      "SQLite/WASM transient image",
    );
    let database: SqliteValidation;
    try {
      database = await validateSqlite(decompressed.collectionBytes);
    } finally {
      context.releaseMemory(decompressed.collectionBytes.byteLength);
    }
    await context.checkpoint(currentStage);
    context.progress(currentStage, 4);

    currentStage = "media";
    await context.checkpoint(currentStage);
    const media = await parseMedia(
      detected.layout,
      archive.entries,
      context,
    );
    await context.checkpoint(currentStage);
    context.progress(currentStage, 5);

    currentStage = "sanitization";
    await context.checkpoint(currentStage);
    const normalizedMemoryEstimate = estimateNormalizedMemory(
      database.normalized,
      media,
    );
    context.reserveMemory(
      normalizedMemoryEstimate,
      currentStage,
      "sanitized normalized result",
    );
    const sanitized = sanitizeNormalized(
      database.normalized,
      media,
    );
    await context.checkpoint(currentStage);
    context.progress(currentStage, 6);

    await context.checkpoint(currentStage);
    const stagedResult: NormalizedStagedResult = {
      packageSha256: await sha256(new Uint8Array(request.packageBytes)),
      layout: detected.layout,
      collectionMember: detected.collectionMember,
      archiveMembers: archive.members,
      normalized: {
        ...sanitized.normalized,
        media,
      },
      validation: {
        collectionBytes: decompressed.collectionBytes.byteLength,
        sqliteTables: database.tables,
        expandedBytes: context.expandedBytes,
        peakMemoryBytes: context.peakMemoryBytes,
        sanitizer: "worker-whitelist",
      },
      warnings: sanitized.warnings,
    };

    sendTerminal({
      kind: "terminal",
      operationId: request.operationId,
      status: "success",
      commitReady: true,
      stagedResult,
      elapsedMs: Math.round(performance.now() - startedAt),
      workerRuntime: "dedicated-worker",
    });
  } catch (error) {
    if (error instanceof CooperativeCancellation) {
      sendTerminal({
        kind: "terminal",
        operationId: request.operationId,
        status: "cancelled",
        commitReady: false,
        stagedResult: null,
        diagnostic: {
          code: "CANCELLED",
          stage: error.stage,
          message: "Parser operation cancelled at a cooperative checkpoint",
        },
      });
    } else if (error instanceof UnsupportedLayoutFailure) {
      const diagnostic: ParserUnsupportedMessage = {
        kind: "terminal",
        operationId: request.operationId,
        status: "unsupported",
        commitReady: false,
        stagedResult: null,
        diagnostic: {
          code: "UNSUPPORTED_LAYOUT",
          stage: error.stage,
          message: error.message,
          detail: error.detail,
        },
      };
      sendTerminal(diagnostic);
    } else {
      const failure = toParserFailure(error, currentStage);
      const diagnostic: ParserDiagnostic = {
        code: failure.code,
        stage: failure.stage,
        message: failure.message,
        detail: failure.detail,
      };
      sendTerminal({
        kind: "terminal",
        operationId: request.operationId,
        status: "error",
        commitReady: false,
        stagedResult: null,
        diagnostic,
      });
    }
  } finally {
    activeOperations.delete(request.operationId);
    cancelledOperations.delete(request.operationId);
    completedOperations.push(request.operationId);
    if (completedOperations.length > 128) {
      completedOperations.shift();
    }
  }
}

function validateRequest(request: ParseRequest): ParseLimits {
  if (
    !(request.packageBytes instanceof ArrayBuffer) ||
    typeof request.operationId !== "string" ||
    request.operationId.length === 0
  ) {
    throw new ParserFailure(
      "INVALID_REQUEST",
      "archive",
      "The parser request must include an operation ID and ArrayBuffer package bytes",
    );
  }

  const candidate = request.limits;
  if (!candidate || typeof candidate !== "object") {
    throw new ParserFailure(
      "INVALID_REQUEST",
      "archive",
      "The parser request must include explicit limits",
    );
  }

  const values: Array<[keyof ParseLimits, number]> = [
    ["maxPackageBytes", candidate.maxPackageBytes],
    ["maxArchiveEntries", candidate.maxArchiveEntries],
    ["maxExpandedBytes", candidate.maxExpandedBytes],
    ["maxEntryBytes", candidate.maxEntryBytes],
    ["maxCompressionRatio", candidate.maxCompressionRatio],
    ["maxParseTimeMs", candidate.maxParseTimeMs],
    ["maxMemoryBytes", candidate.maxMemoryBytes],
  ];
  if (
    values.some(
      ([key, value]) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0 ||
        (key !== "maxCompressionRatio" && !Number.isInteger(value)),
    )
  ) {
    throw new ParserFailure(
      "INVALID_REQUEST",
      "archive",
      "All parser limits must be finite positive numbers",
    );
  }

  return {
    maxPackageBytes: candidate.maxPackageBytes,
    maxArchiveEntries: candidate.maxArchiveEntries,
    maxExpandedBytes: candidate.maxExpandedBytes,
    maxEntryBytes: candidate.maxEntryBytes,
    maxCompressionRatio: candidate.maxCompressionRatio,
    maxParseTimeMs: candidate.maxParseTimeMs,
    maxMemoryBytes: candidate.maxMemoryBytes,
  };
}

interface ArchiveState {
  entries: Record<string, Uint8Array>;
  members: ParserArchiveEntry[];
  expandedBytes: number;
  memoryBytes: number;
}

function readArchive(
  bytes: Uint8Array,
  limits: ParseLimits,
): Promise<ArchiveState> {
  if (bytes.byteLength > limits.maxPackageBytes) {
    return Promise.reject(
      new ParserFailure(
        "ARCHIVE_LIMIT_EXCEEDED",
        "archive",
        "The package exceeds the configured original-size limit",
        `packageBytes=${bytes.byteLength}, maxPackageBytes=${limits.maxPackageBytes}`,
      ),
    );
  }

  return new Promise<ArchiveState>((resolve, reject) => {
    const names = new Set<string>();
    const members: ParserArchiveEntry[] = [];
    let expandedBytes = 0;
    let failure: ParserFailure | UnsupportedLayoutFailure | undefined;

    const fail = (nextFailure: ParserFailure | UnsupportedLayoutFailure): void => {
      failure ??= nextFailure;
    };

    const filter = (file: UnzipFileInfo): boolean => {
      if (failure) {
        return false;
      }

      let path: string;
      try {
        path = normalizeArchivePath(file.name, "archive");
      } catch (error) {
        if (error instanceof ParserFailure) {
          fail(error);
          return false;
        }
        throw error;
      }
      if (names.has(path)) {
        fail(
          new ParserFailure(
            "UNSAFE_ARCHIVE_PATH",
            "archive",
            "Archive contains duplicate normalized member paths",
            path,
          ),
        );
        return false;
      }

      if (members.length >= limits.maxArchiveEntries) {
        fail(
          new ParserFailure(
            "ARCHIVE_LIMIT_EXCEEDED",
            "archive",
            "The package exceeds the configured entry-count limit",
            `maxArchiveEntries=${limits.maxArchiveEntries}`,
          ),
        );
        return false;
      }

      if (
        !Number.isSafeInteger(file.size) ||
        !Number.isSafeInteger(file.originalSize) ||
        file.size < 0 ||
        file.originalSize < 0
      ) {
        fail(
          new ParserFailure(
            "INVALID_ZIP",
            "archive",
            "ZIP member sizes are not safe integers",
            path,
          ),
        );
        return false;
      }

      if (file.originalSize > limits.maxEntryBytes) {
        fail(
          new ParserFailure(
            "ARCHIVE_LIMIT_EXCEEDED",
            "archive",
            "A ZIP member exceeds the configured per-entry limit",
            `${path}: ${file.originalSize} > ${limits.maxEntryBytes}`,
          ),
        );
        return false;
      }

      const nextExpandedBytes = expandedBytes + file.originalSize;
      if (nextExpandedBytes > limits.maxExpandedBytes) {
        fail(
          new ParserFailure(
            "ARCHIVE_LIMIT_EXCEEDED",
            "archive",
            "The package exceeds the configured expanded-size limit",
            `expandedBytes>${limits.maxExpandedBytes}`,
          ),
        );
        return false;
      }

      const ratio = file.size === 0
        ? file.originalSize === 0
          ? 1
          : Number.POSITIVE_INFINITY
        : file.originalSize / file.size;
      if (ratio > limits.maxCompressionRatio) {
        fail(
          new ParserFailure(
            "ARCHIVE_LIMIT_EXCEEDED",
            "archive",
            "A ZIP member exceeds the configured compression-ratio limit",
            `${path}: ratio=${ratio.toFixed(2)}, max=${limits.maxCompressionRatio}`,
          ),
        );
        return false;
      }

      names.add(path);
      members.push({
        path,
        compressedBytes: file.size,
        expandedBytes: file.originalSize,
      });
      expandedBytes = nextExpandedBytes;
      return true;
    };

    try {
      unzip(bytes, { filter }, (error, entries) => {
        if (failure) {
          reject(failure);
          return;
        }
        if (error || !entries) {
          reject(
            new ParserFailure(
              "INVALID_ZIP",
              "archive",
              "The package is not a valid ZIP archive",
              error instanceof Error ? error.message : undefined,
            ),
          );
          return;
        }
        if (members.length === 0) {
          reject(
            new ParserFailure(
              "INVALID_ZIP",
              "archive",
              "The ZIP archive contains no members",
            ),
          );
          return;
        }

        const canonicalEntries: Record<string, Uint8Array> = {};
        let memoryBytes = 0;
        for (const [name, entry] of Object.entries(entries)) {
          const canonicalName = normalizeArchivePath(name, "archive");
          const member = members.find((candidate) => candidate.path === canonicalName);
          if (!member || member.expandedBytes !== entry.byteLength) {
            reject(
              new ParserFailure(
                "INVALID_ZIP",
                "archive",
                "ZIP member size metadata does not match extracted bytes",
                `${canonicalName}: declared=${member?.expandedBytes ?? "missing"}, actual=${entry.byteLength}`,
              ),
            );
            return;
          }
          canonicalEntries[canonicalName] = entry;
          memoryBytes += entry.byteLength;
          if (looksLikeZip(entry)) {
            reject(
              new UnsupportedLayoutFailure(
                "archive",
                "Nested ZIP archives are not supported",
                canonicalName,
              ),
            );
            return;
          }
        }
        resolve({ entries: canonicalEntries, members, expandedBytes, memoryBytes });
      });
    } catch (error) {
      reject(
        new ParserFailure(
          "INVALID_ZIP",
          "archive",
          "The ZIP archive could not be read",
          error instanceof Error ? error.message : undefined,
        ),
      );
    }
  });
}

interface DetectedLayout {
  layout: SupportedLayout;
  collectionMember: string;
}

function detectLayout(entries: Record<string, Uint8Array>): DetectedLayout {
  const names = new Set(Object.keys(entries));
  const collectionMembers = [...names].filter((name) =>
    name.startsWith("collection."),
  );

  if (names.has("collection.anki21b")) {
    if (!names.has("meta") || !names.has("media")) {
      throw new UnsupportedLayoutFailure(
        "collection",
        "Current packages require meta, collection.anki21b, and media members",
      );
    }
    validateCurrentMetadata(entries.meta);
    validateLayoutMembers(entries, "current-anki21b");
    return { layout: "current-anki21b", collectionMember: "collection.anki21b" };
  }

  if (names.has("collection.anki21")) {
    if (!names.has("media")) {
      throw new UnsupportedLayoutFailure(
        "collection",
        "Transition packages require collection.anki21 and media members",
      );
    }
    if (names.has("meta")) {
      throw new UnsupportedLayoutFailure(
        "collection",
        "A transition package cannot advertise current-format metadata",
      );
    }
    validateLayoutMembers(entries, "transition-anki21");
    return { layout: "transition-anki21", collectionMember: "collection.anki21" };
  }

  if (names.has("collection.anki2")) {
    if (!names.has("media")) {
      throw new UnsupportedLayoutFailure(
        "collection",
        "Legacy packages require collection.anki2 and media members",
      );
    }
    if (names.has("meta")) {
      throw new UnsupportedLayoutFailure(
        "collection",
        "A legacy package cannot advertise current-format metadata",
      );
    }
    validateLayoutMembers(entries, "legacy-anki2");
    return { layout: "legacy-anki2", collectionMember: "collection.anki2" };
  }

  const unknownCollection = collectionMembers.join(", ");
  throw new UnsupportedLayoutFailure(
    "collection",
    "The package does not contain a supported collection member",
    unknownCollection || "no collection.* member",
  );
}

function validateLayoutMembers(
  entries: Record<string, Uint8Array>,
  layout: SupportedLayout,
): void {
  const allowed = new Set(
    layout === "legacy-anki2"
      ? ["collection.anki2", "media"]
      : layout === "transition-anki21"
        ? ["collection.anki2", "collection.anki21", "media"]
        : ["meta", "collection.anki2", "collection.anki21b", "media"],
  );
  for (const name of Object.keys(entries)) {
    if (allowed.has(name) || /^\d+$/.test(name)) {
      continue;
    }
    throw new UnsupportedLayoutFailure(
      "collection",
      `The ${layout} package contains an unsupported archive member`,
      name,
    );
  }
}

function validateCurrentMetadata(bytes: Uint8Array | undefined): void {
  if (!bytes) {
    throw new UnsupportedLayoutFailure(
      "collection",
      "Current package metadata is missing",
    );
  }

  try {
    const reader = protobuf.Reader.create(bytes);
    let version: number | undefined;
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      if ((tag >>> 3) === 1 && (tag & 7) === 0) {
        version = reader.uint32();
      } else {
        reader.skipType(tag & 7);
      }
    }
    if (version !== 3) {
      throw new UnsupportedLayoutFailure(
        "collection",
        "The current package metadata version is unsupported",
        `version=${String(version)}`,
      );
    }
  } catch (error) {
    if (error instanceof UnsupportedLayoutFailure) {
      throw error;
    }
    throw new ParserFailure(
      "INVALID_PROTOBUF_MEDIA_MAP",
      "collection",
      "Current package metadata is not valid protobuf",
      error instanceof Error ? error.message : undefined,
    );
  }
}

interface DecompressedCollection {
  collectionBytes: Uint8Array;
}

interface ZstdFrameInfo {
  windowBytes: number;
  contentBytes: number | undefined;
}

function decompressCollection(
  detected: DetectedLayout,
  entries: Record<string, Uint8Array>,
  context: ParseContext,
): DecompressedCollection {
  const bytes = entries[detected.collectionMember];
  if (!bytes) {
    throw new UnsupportedLayoutFailure(
      "decompression",
      `Required collection member ${detected.collectionMember} is missing`,
    );
  }

  if (detected.layout !== "current-anki21b") {
    return { collectionBytes: bytes };
  }

  return {
    collectionBytes: decompressZstdBounded(
      bytes,
      context,
      "decompression",
      detected.collectionMember,
    ),
  };
}

function decompressZstdBounded(
  bytes: Uint8Array,
  context: ParseContext,
  stage: ParserStage,
  label: string,
): Uint8Array {
  const frame = readZstdFrameInfo(bytes, stage, label);
  context.assertZstdWindow(frame.windowBytes, stage, label);
  if (frame.contentBytes !== undefined) {
    context.assertDecompressedSize(frame.contentBytes, stage, label);
  }

  const chunks: Uint8Array[] = [];
  let outputBytes = 0;
  try {
    const decoder = new ZstdDecompressor((chunk) => {
      if (chunk.byteLength === 0) {
        return;
      }
      const nextOutputBytes = outputBytes + chunk.byteLength;
      context.assertDecompressedSize(nextOutputBytes, stage, label);
      context.reserveMemory(chunk.byteLength, stage, `${label} output`);
      outputBytes = nextOutputBytes;
      chunks.push(chunk.slice());
    });
    decoder.push(bytes, true);
  } catch (error) {
    context.releaseMemory(outputBytes);
    if (error instanceof ParserFailure) {
      throw error;
    }
    throw new ParserFailure(
      "INVALID_ZSTD",
      stage,
      `${label} is not a valid Zstandard frame`,
      error instanceof Error ? error.message : undefined,
    );
  }

  if (frame.contentBytes !== undefined && frame.contentBytes !== outputBytes) {
    context.releaseMemory(outputBytes);
    throw new ParserFailure(
      "INVALID_ZSTD",
      stage,
      `${label} declares a different decompressed size`,
      `declared=${frame.contentBytes}, actual=${outputBytes}`,
    );
  }

  if (chunks.length === 0) {
    return new Uint8Array();
  }

  // Streaming output chunks are copied before they can be reused by fzstd.
  // Account for the temporary second copy while consolidating them.
  context.reserveMemory(outputBytes, stage, `${label} output consolidation`);
  const output = concatBytes(chunks);
  context.releaseMemory(outputBytes);
  return output;
}

function readZstdFrameInfo(
  bytes: Uint8Array,
  stage: ParserStage,
  label: string,
): ZstdFrameInfo {
  const invalid = (detail?: string): ParserFailure =>
    new ParserFailure(
      "INVALID_ZSTD",
      stage,
      `${label} is not a valid Zstandard frame`,
      detail,
    );

  if (
    bytes.byteLength < 5 ||
    bytes[0] !== 0x28 ||
    bytes[1] !== 0xb5 ||
    bytes[2] !== 0x2f ||
    bytes[3] !== 0xfd
  ) {
    throw invalid("missing Zstandard frame magic");
  }

  const descriptor = bytes[4];
  if ((descriptor & 0x18) !== 0) {
    throw invalid("reserved frame-header bits are set");
  }
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const contentSizeFlag = descriptor >>> 6;
  let offset = 5;
  let windowBytes: number | undefined;

  if (!singleSegment) {
    if (offset >= bytes.byteLength) {
      throw invalid("missing window descriptor");
    }
    const windowDescriptor = bytes[offset];
    offset += 1;
    const windowBase = 2 ** (10 + (windowDescriptor >>> 3));
    windowBytes = windowBase + (windowBase >>> 3) * (windowDescriptor & 0x07);
  }

  const dictionaryBytes = dictionaryFlag === 0
    ? 0
    : dictionaryFlag === 1
      ? 1
      : dictionaryFlag === 2
        ? 2
        : 4;
  offset += dictionaryBytes;

  const contentSizeBytes = contentSizeFlag === 0
    ? singleSegment
      ? 1
      : 0
    : 2 ** contentSizeFlag;
  if (offset + contentSizeBytes > bytes.byteLength) {
    throw invalid("truncated frame content-size field");
  }

  let contentBytes: number | undefined;
  if (contentSizeBytes !== 0) {
    contentBytes = readLittleEndianNumber(bytes, offset, contentSizeBytes);
    if (contentSizeFlag === 1) {
      contentBytes += 256;
    }
    if (!Number.isSafeInteger(contentBytes)) {
      throw invalid("frame content size is not a safe integer");
    }
  }

  if (singleSegment) {
    windowBytes = contentBytes;
  }
  if (windowBytes === undefined || windowBytes <= 0) {
    // A single-segment frame always has a content size. A zero-byte frame is
    // still safe, but fzstd needs a one-byte window for its internal state.
    windowBytes = 1;
  }
  return { windowBytes, contentBytes };
}

function readLittleEndianNumber(
  bytes: Uint8Array,
  offset: number,
  length: number,
): number {
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value += bytes[offset + index] * 2 ** (index * 8);
  }
  return value;
}

type NormalizedRecords = Omit<NormalizedStagedResult["normalized"], "media">;

interface SqliteRow {
  [column: string]: unknown;
}

type QueryRows = (sql: string) => SqliteRow[];

interface SqliteValidation {
  tables: string[];
  normalized: NormalizedRecords;
}

interface NotetypeDefinition {
  id: string;
  name: string;
  fields: Array<{ ordinal: number; name: string }>;
  templates: Array<{
    ordinal: number;
    name: string;
    questionFormat: string;
    answerFormat: string;
  }>;
  css: string;
}

type DeckDefinition = NormalizedDeck;

async function validateSqlite(bytes: Uint8Array): Promise<SqliteValidation> {
  if (!hasSqliteHeader(bytes)) {
    throw new ParserFailure(
      "INVALID_SQLITE",
      "database",
      "The collection does not have an SQLite 3 header",
    );
  }

  sqliteModulePromise ??= sqlite3InitModule();
  const sqlite3 = await sqliteModulePromise;
  const database = new sqlite3.oo1.DB(":memory:", "c");
  const databasePointer = database.pointer;
  if (!databasePointer) {
    database.close();
    throw new ParserFailure(
      "INVALID_SQLITE",
      "database",
      "SQLite/WASM did not return a database handle",
    );
  }
  let allocated:
    | Parameters<typeof sqlite3.capi.sqlite3_deserialize>[2]
    | undefined;

  try {
    // Anki's current collection export can retain a WAL-mode header even
    // though the package contains no -wal sidecar. SQLite/WASM then tries to
    // open that missing sidecar while reading the deserialized image. The
    // parser uses a private read-only image, so switch only the transient
    // journal-mode header bytes to rollback mode; no package bytes are changed.
    const transientBytes = normalizeTransientSqliteHeader(bytes);
    allocated = sqlite3.wasm.allocFromTypedArray(transientBytes);
    const resultCode = sqlite3.capi.sqlite3_deserialize(
      databasePointer,
      "main",
      allocated,
      transientBytes.byteLength,
      transientBytes.byteLength,
      1,
    );
    if (resultCode !== 0) {
      database.checkRc(resultCode);
    }
    // FREEONCLOSE transfers the allocation to SQLite. The database is never
    // used for writes and query_only makes that contract explicit.
    allocated = undefined;
    const collationCode = sqlite3.capi.sqlite3_create_collation_v2(
      databasePointer,
      "unicase",
      sqlite3.capi.SQLITE_UTF8,
      0,
      (_context: number | bigint, leftLength: number, leftPointer: number | bigint,
        rightLength: number, rightPointer: number | bigint) => {
        const heap = sqlite3.wasm.heap8u();
        const left = utf8Decoder.decode(
          heap.subarray(Number(leftPointer), Number(leftPointer) + leftLength),
        );
        const right = utf8Decoder.decode(
          heap.subarray(Number(rightPointer), Number(rightPointer) + rightLength),
        );
        return left < right ? -1 : left > right ? 1 : 0;
      },
      0,
    );
    if (collationCode !== 0) {
      database.checkRc(collationCode);
    }
    database.exec("PRAGMA query_only = ON;");
    const rows = database.exec({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      rowMode: "object",
      returnValue: "resultRows",
    }) as Array<{ name?: unknown }>;
    const tables = rows.map((row) => String(row.name ?? ""));
    if (!tables.includes("col") || !tables.includes("notes") || !tables.includes("cards")) {
      throw new Error("collection lacks required col, notes, or cards tables");
    }
    const queryRows: QueryRows = (sql) =>
      database.exec({
        sql,
        rowMode: "object",
        returnValue: "resultRows",
      }) as SqliteRow[];
    return {
      tables,
      normalized: normalizeCollection(queryRows, tables),
    };
  } catch (error) {
    throw new ParserFailure(
      "INVALID_SQLITE",
      "database",
      "The collection could not be opened read-only by SQLite/WASM",
      error instanceof Error ? error.message : undefined,
    );
  } finally {
    if (allocated !== undefined) {
      sqlite3.wasm.dealloc(allocated);
    }
    database.close();
  }
}

function normalizeCollection(query: QueryRows, tables: string[]): NormalizedRecords {
  const modernTables = ["decks", "notetypes", "fields", "templates"].filter(
    (table) => tables.includes(table),
  );
  if (modernTables.length !== 0 && modernTables.length !== 4) {
    throw new Error(
      `collection has an incomplete modern schema: ${modernTables.join(",")}`,
    );
  }

  if (modernTables.length === 4) {
    return normalizeModernCollection(query);
  }
  return normalizeLegacyCollection(query);
}

function normalizeLegacyCollection(query: QueryRows): NormalizedRecords {
  const rows = query("SELECT models, decks FROM col LIMIT 1");
  if (rows.length !== 1) {
    throw new Error("collection must contain exactly one col row");
  }

  const models = parseJsonRecord(rows[0].models, "col.models");
  const decks = parseJsonRecord(rows[0].decks, "col.decks");
  const definitions = Object.entries(models).map(([key, rawModel]) =>
    parseLegacyNotetype(key, rawModel),
  );
  const deckDefinitions = Object.entries(decks).map(([key, rawDeck]) =>
    parseLegacyDeck(key, rawDeck),
  );
  return buildNormalizedRecords(query, definitions, deckDefinitions);
}

function normalizeModernCollection(query: QueryRows): NormalizedRecords {
  const deckDefinitions = query("SELECT id, name FROM decks").map((row) => ({
    id: toId(row.id, "decks.id"),
    name: normalizeDeckName(toString(row.name, "decks.name")),
  }));
  assertUniqueIds(deckDefinitions, "decks");
  const definitionsById = new Map<string, NotetypeDefinition>();
  const fieldsByNotetype = new Map<
    string,
    Array<{ ordinal: number; name: string }>
  >();
  for (const row of query("SELECT ntid, ord, name FROM fields")) {
    const notetypeId = toId(row.ntid, "fields.ntid");
    const fields = fieldsByNotetype.get(notetypeId) ?? [];
    fields.push({
      ordinal: toOrdinal(row.ord, "fields.ord"),
      name: toString(row.name, "fields.name"),
    });
    fieldsByNotetype.set(notetypeId, fields);
  }

  const templatesByNotetype = new Map<
    string,
    Array<{
      ordinal: number;
      name: string;
      questionFormat: string;
      answerFormat: string;
    }>
  >();
  for (const row of query("SELECT ntid, ord, name, config FROM templates")) {
    const notetypeId = toId(row.ntid, "templates.ntid");
    const config = toBytes(row.config, "templates.config");
    const questionFormat = readProtobufStringField(config, 1, "template question format");
    const answerFormat = readProtobufStringField(config, 2, "template answer format");
    if (questionFormat === undefined || answerFormat === undefined) {
      throw new Error(`template ${notetypeId} is missing question or answer format`);
    }
    const templates = templatesByNotetype.get(notetypeId) ?? [];
    templates.push({
      ordinal: toOrdinal(row.ord, "templates.ord"),
      name: toString(row.name, "templates.name"),
      questionFormat,
      answerFormat,
    });
    templatesByNotetype.set(notetypeId, templates);
  }

  for (const row of query("SELECT id, name, config FROM notetypes")) {
    const id = toId(row.id, "notetypes.id");
    if (definitionsById.has(id)) {
      throw new Error(`notetypes contain duplicate id ${id}`);
    }
    const fields = fieldsByNotetype.get(id) ?? [];
    const templates = templatesByNotetype.get(id) ?? [];
    if (fields.length === 0 || templates.length === 0) {
      throw new Error(`notetype ${id} has no fields or templates`);
    }
    validateOrdinals(fields, `fields for notetype ${id}`);
    validateOrdinals(templates, `templates for notetype ${id}`);
    const config = toBytes(row.config, "notetypes.config");
    definitionsById.set(id, {
      id,
      name: toString(row.name, "notetypes.name"),
      fields: fields.sort(compareOrdinal),
      templates: templates.sort(compareOrdinal),
      css: readProtobufStringField(config, 3, "notetype CSS") ?? "",
    });
  }

  if (definitionsById.size === 0) {
    throw new Error("modern collection contains no notetypes");
  }
  for (const id of fieldsByNotetype.keys()) {
    if (!definitionsById.has(id)) {
      throw new Error(`fields refer to unknown notetype ${id}`);
    }
  }
  for (const id of templatesByNotetype.keys()) {
    if (!definitionsById.has(id)) {
      throw new Error(`templates refer to unknown notetype ${id}`);
    }
  }

  const definitions = [...definitionsById.values()];
  const normalizedDecks = sortDecks(deckDefinitions);
  return buildNormalizedRecords(query, definitions, normalizedDecks);
}

function parseLegacyNotetype(key: string, rawModel: unknown): NotetypeDefinition {
  const model = parseJsonRecord(rawModel, `col.models.${key}`);
  const id = toId(model.id ?? key, `col.models.${key}.id`);
  const fields = parseJsonArray(model.flds, `col.models.${key}.flds`).map(
    (rawField) => {
      const field = parseJsonRecord(rawField, `col.models.${key}.field`);
      return {
        ordinal: toOrdinal(field.ord, `col.models.${key}.field.ord`),
        name: toString(field.name, `col.models.${key}.field.name`),
      };
    },
  );
  const templates = parseJsonArray(model.tmpls, `col.models.${key}.tmpls`).map(
    (rawTemplate) => {
      const template = parseJsonRecord(rawTemplate, `col.models.${key}.template`);
      return {
        ordinal: toOrdinal(template.ord, `col.models.${key}.template.ord`),
        name: toString(template.name, `col.models.${key}.template.name`),
        questionFormat: toString(
          template.qfmt,
          `col.models.${key}.template.qfmt`,
        ),
        answerFormat: toString(
          template.afmt,
          `col.models.${key}.template.afmt`,
        ),
      };
    },
  );
  validateOrdinals(fields, `fields for notetype ${id}`);
  validateOrdinals(templates, `templates for notetype ${id}`);
  return {
    id,
    name: toString(model.name, `col.models.${key}.name`),
    fields: fields.sort(compareOrdinal),
    templates: templates.sort(compareOrdinal),
    css: toString(model.css, `col.models.${key}.css`),
  };
}

function parseLegacyDeck(key: string, rawDeck: unknown): DeckDefinition {
  const deck = parseJsonRecord(rawDeck, `col.decks.${key}`);
  return {
    id: toId(deck.id ?? key, `col.decks.${key}.id`),
    name: normalizeDeckName(toString(deck.name, `col.decks.${key}.name`)),
  };
}

function buildNormalizedRecords(
  query: QueryRows,
  rawDefinitions: NotetypeDefinition[],
  rawDecks: DeckDefinition[],
): NormalizedRecords {
  const definitions = [...rawDefinitions].sort(
    (left, right) => compareCanonical(left.name, right.name) ||
      compareCanonical(left.id, right.id),
  );
  const decks = sortDecks(rawDecks);
  assertUniqueIds(definitions, "notetypes");
  assertUniqueIds(decks, "decks");
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const deckById = new Map(decks.map((deck) => [deck.id, deck]));

  const normalizedNotetypes: NormalizedNotetype[] = definitions.map((definition) => ({
    id: definition.id,
    name: definition.name,
    fields: definition.fields.map((field) => field.name),
    templates: definition.templates.map((template) => template.name),
  }));
  const fields: NormalizedField[] = definitions.flatMap((definition) =>
    definition.fields.map((field) => ({
      notetypeId: definition.id,
      ordinal: field.ordinal,
      name: field.name,
    })),
  );
  const cardTemplates: NormalizedCardTemplate[] = definitions.flatMap((definition) =>
    definition.templates.map((template) => ({
      notetypeId: definition.id,
      ordinal: template.ordinal,
      name: template.name,
      questionFormat: template.questionFormat,
      answerFormat: template.answerFormat,
    })),
  );

  const rawNotes = query("SELECT id, guid, mid, tags, flds FROM notes")
    .map((row) => ({
      id: toId(row.id, "notes.id"),
      sourceGuid: toString(row.guid, "notes.guid"),
      notetypeId: toId(row.mid, "notes.mid"),
      tags: parseTags(row.tags, "notes.tags"),
      fieldText: toString(row.flds, "notes.flds"),
    }))
    .sort((left, right) => compareCanonical(left.id, right.id));
  const noteDefinitions = new Map<string, NotetypeDefinition>();
  const noteIds = new Set<string>();
  for (const note of rawNotes) {
    if (noteIds.has(note.id)) {
      throw new Error(`notes contain duplicate id ${note.id}`);
    }
    noteIds.add(note.id);
    const definition = definitionById.get(note.notetypeId);
    if (!definition) {
      throw new Error(`note ${note.id} refers to unknown notetype ${note.notetypeId}`);
    }
    noteDefinitions.set(note.id, definition);
  }

  const rawCards = query("SELECT id, nid, did, ord FROM cards").map((row) => ({
    id: toId(row.id, "cards.id"),
    noteId: toId(row.nid, "cards.nid"),
    deckId: toId(row.did, "cards.did"),
    templateOrdinal: toOrdinal(row.ord, "cards.ord"),
  })).sort(compareCards);
  const cardsByNote = new Map<string, typeof rawCards>();
  const cardIds = new Set<string>();
  const cards: NormalizedCard[] = rawCards.map((card) => {
    if (cardIds.has(card.id)) {
      throw new Error(`cards contain duplicate id ${card.id}`);
    }
    cardIds.add(card.id);
    const definition = noteDefinitions.get(card.noteId);
    if (!definition) {
      throw new Error(`card ${card.id} refers to missing note ${card.noteId}`);
    }
    if (!deckById.has(card.deckId)) {
      throw new Error(`card ${card.id} refers to unknown deck ${card.deckId}`);
    }
    if (card.templateOrdinal >= definition.templates.length) {
      throw new Error(`card ${card.id} refers to unknown template ordinal ${card.templateOrdinal}`);
    }
    const noteCards = cardsByNote.get(card.noteId) ?? [];
    noteCards.push(card);
    cardsByNote.set(card.noteId, noteCards);
    return {
      id: card.id,
      noteId: card.noteId,
      deckId: card.deckId,
      templateOrdinal: card.templateOrdinal,
      scheduling: "fresh",
    };
  });

  const notes: NormalizedNote[] = rawNotes.map((note) => {
    const definition = noteDefinitions.get(note.id);
    if (!definition) {
      throw new Error(`note ${note.id} has no notetype definition`);
    }
    const noteCards = cardsByNote.get(note.id) ?? [];
    if (noteCards.length === 0) {
      throw new Error(`note ${note.id} has no cards`);
    }
    const fieldsForNote = note.fieldText.split("\x1f");
    if (fieldsForNote.length !== definition.fields.length) {
      throw new Error(
        `note ${note.id} has ${fieldsForNote.length} fields; expected ${definition.fields.length}`,
      );
    }
    return {
      id: note.id,
      sourceGuid: note.sourceGuid,
      notetypeId: note.notetypeId,
      deckId: noteCards[0].deckId,
      fields: fieldsForNote,
      tags: note.tags,
    };
  });

  const css = definitions
    .map((definition) => definition.css)
    .filter((value) => value.length > 0)
    .join("\n");
  return {
    decks,
    notetypes: normalizedNotetypes,
    notes,
    cards,
    cardTemplates,
    fields,
    css,
  };
}

function parseJsonRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsonArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return value;
}

function toString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function toId(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) {
    if (!/^\d+$/.test(value)) {
      throw new Error(`${label} must be a numeric identifier`);
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "bigint" && value >= 0n) {
    return value.toString();
  }
  throw new Error(`${label} must be a non-negative integer identifier`);
}

function toOrdinal(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer ordinal`);
  }
  return value;
}

function toBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new Error(`${label} must be a binary protobuf value`);
}

function parseTags(value: unknown, label: string): string[] {
  const text = toString(value, label).trim();
  return text.length === 0
    ? []
    : [...new Set(text.split(/\s+/))].sort(compareCanonical);
}

function assertUniqueIds(values: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new Error(`${label} contain duplicate id ${value.id}`);
    }
    ids.add(value.id);
  }
}

function normalizeDeckName(name: string): string {
  return name.replaceAll("\x1f", "::");
}

function validateOrdinals(
  values: Array<{ ordinal: number }>,
  label: string,
): void {
  const sorted = [...values].sort(compareOrdinal);
  sorted.forEach((value, index) => {
    if (value.ordinal !== index) {
      throw new Error(`${label} must have contiguous ordinals starting at zero`);
    }
  });
}

function readProtobufStringField(
  bytes: Uint8Array,
  fieldNumber: number,
  label: string,
): string | undefined {
  try {
    const reader = protobuf.Reader.create(bytes);
    let value: string | undefined;
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const currentField = tag >>> 3;
      const wireType = tag & 7;
      if (currentField === fieldNumber) {
        if (wireType !== 2 || value !== undefined) {
          throw new Error(`${label} has an invalid or duplicate field`);
        }
        value = reader.string();
      } else {
        reader.skipType(wireType);
      }
    }
    return value;
  } catch (error) {
    throw new Error(
      `${label} is not valid protobuf: ${error instanceof Error ? error.message : "decode failed"}`,
    );
  }
}

function sortDecks(decks: DeckDefinition[]): DeckDefinition[] {
  return [...decks].sort(
    (left, right) => compareCanonical(left.name, right.name) ||
      compareCanonical(left.id, right.id),
  );
}

function compareOrdinal(
  left: { ordinal: number },
  right: { ordinal: number },
): number {
  return left.ordinal - right.ordinal;
}

function compareCards(
  left: { id: string },
  right: { id: string },
): number {
  return compareCanonical(left.id, right.id);
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function parseMedia(
  layout: SupportedLayout,
  entries: Record<string, Uint8Array>,
  context: ParseContext,
): Promise<ParserMediaEntry[]> {
  let mediaBytes = entries.media;
  if (!mediaBytes) {
    throw new ParserFailure(
      "INVALID_PROTOBUF_MEDIA_MAP",
      "media",
      "The package does not contain a media map",
    );
  }

  if (layout === "current-anki21b") {
    mediaBytes = decompressZstdBounded(
      mediaBytes,
      context,
      "media",
      "The current media map",
    );
    context.addExpandedBytes(mediaBytes.byteLength, "media");
  }

  const mediaMap = layout === "current-anki21b"
    ? parseProtobufMediaMap(mediaBytes)
    : parseJsonMediaMap(mediaBytes);
  if (layout === "current-anki21b") {
    // The decoded map is only needed while resolving archive members; do not
    // carry its temporary bytes into the staged-result memory estimate.
    context.releaseMemory(mediaBytes.byteLength);
  }
  const mediaEntries: ParserMediaEntry[] = [];

  for (const [sourceMember, media] of mediaMap) {
    await context.checkpoint("media");
    const data = entries[sourceMember];
    if (!data) {
      throw new ParserFailure(
        "INVALID_PROTOBUF_MEDIA_MAP",
        "media",
        "The media map refers to a missing archive member",
        `${sourceMember} -> ${media.name}`,
      );
    }

    let mediaData = data;
    if (layout === "current-anki21b") {
      mediaData = decompressZstdBounded(
        data,
        context,
        "media",
        `Media member ${sourceMember}`,
      );
    }
    context.addExpandedBytes(mediaData.byteLength, "media");
    context.assertEntrySize(mediaData.byteLength, sourceMember);
    validateMediaMime(media.name, mediaData);
    const mediaSha1 = await sha1(mediaData);
    if (
      media.declaredBytes !== undefined &&
      media.declaredBytes !== mediaData.byteLength
    ) {
      throw new ParserFailure(
        "INVALID_PROTOBUF_MEDIA_MAP",
        "media",
        "The media map declared a different byte length",
        `${media.name}: declared=${media.declaredBytes}, actual=${mediaData.byteLength}`,
      );
    }
    if (
      media.declaredSha1 !== undefined &&
      bytesToHex(media.declaredSha1) !== mediaSha1
    ) {
      throw new ParserFailure(
        "INVALID_PROTOBUF_MEDIA_MAP",
        "media",
        "The media map declared a different SHA-1",
        `${media.name}: declared=${bytesToHex(media.declaredSha1)}, actual=${mediaSha1}`,
      );
    }
    context.reserveMemory(
      mediaData.byteLength,
      "media",
      `staged media ${media.name}`,
    );
    mediaEntries.push({
      name: media.name,
      sourceMember,
      byteLength: mediaData.byteLength,
      sha1: mediaSha1,
      bytes: copyArrayBuffer(mediaData),
    });
    if (layout === "current-anki21b") {
      // Keep the copied ArrayBuffer accounted for, but release the bounded
      // decompressor's temporary output before the next media member.
      context.releaseMemory(mediaData.byteLength);
    }
  }

  return mediaEntries.sort((left, right) =>
    compareCanonical(left.name, right.name) ||
    compareCanonical(left.sourceMember, right.sourceMember),
  );
}

interface MediaMapEntry {
  name: string;
  declaredBytes?: number;
  declaredSha1?: Uint8Array;
}

function parseJsonMediaMap(bytes: Uint8Array): Map<string, MediaMapEntry> {
  try {
    const value: unknown = JSON.parse(utf8Decoder.decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("media map must be an object");
    }
    const mediaMap = new Map<string, MediaMapEntry>();
    for (const [sourceMember, rawName] of Object.entries(value)) {
      if (!/^\d+$/.test(sourceMember) || typeof rawName !== "string") {
        throw new Error("media map entries must be numeric keys and string names");
      }
      const name = normalizeMediaName(rawName);
      if (mediaMapHasName(mediaMap, name)) {
        throw new ParserFailure(
          "UNSAFE_ARCHIVE_PATH",
          "media",
          "Media names collide after Unicode/path normalization",
          name,
        );
      }
      mediaMap.set(sourceMember, { name });
    }
    return mediaMap;
  } catch (error) {
    if (error instanceof ParserFailure) {
      throw error;
    }
    throw new ParserFailure(
      "INVALID_PROTOBUF_MEDIA_MAP",
      "media",
      "The legacy media map is not valid UTF-8 JSON",
      error instanceof Error ? error.message : undefined,
    );
  }
}

function parseProtobufMediaMap(bytes: Uint8Array): Map<string, MediaMapEntry> {
  try {
    const reader = protobuf.Reader.create(bytes);
    const mediaMap = new Map<string, MediaMapEntry>();
    let sourceMember = 0;
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      if ((tag >>> 3) !== 1 || (tag & 7) !== 2) {
        reader.skipType(tag & 7);
        continue;
      }
      const length = reader.uint32();
      const end = reader.pos + length;
      if (end > reader.len) {
        throw new Error("media entry extends beyond protobuf input");
      }
      const entryReader = protobuf.Reader.create(reader.buf.subarray(reader.pos, end));
      reader.pos = end;
      let name: string | undefined;
      let declaredBytes: number | undefined;
      let declaredSha1: Uint8Array | undefined;
      while (entryReader.pos < entryReader.len) {
        const entryTag = entryReader.uint32();
        switch (entryTag >>> 3) {
          case 1:
            if ((entryTag & 7) !== 2) throw new Error("media name has invalid wire type");
            name = entryReader.string();
            break;
          case 2:
            if ((entryTag & 7) !== 0) throw new Error("media byte length has invalid wire type");
            declaredBytes = entryReader.uint32();
            break;
          case 3:
            if ((entryTag & 7) !== 2) throw new Error("media SHA-1 has invalid wire type");
            declaredSha1 = entryReader.bytes();
            break;
          default:
            entryReader.skipType(entryTag & 7);
        }
      }
      if (
        name === undefined ||
        declaredBytes === undefined ||
        !declaredSha1 ||
        declaredSha1.byteLength !== 20
      ) {
        throw new Error("media entry lacks name, byte length, or SHA-1");
      }
      const normalizedName = normalizeMediaName(name);
      if (mediaMapHasName(mediaMap, normalizedName)) {
        throw new ParserFailure(
          "UNSAFE_ARCHIVE_PATH",
          "media",
          "Media names collide after Unicode/path normalization",
          normalizedName,
        );
      }
      mediaMap.set(String(sourceMember), {
        name: normalizedName,
        declaredBytes,
        declaredSha1,
      });
      sourceMember += 1;
    }
    if (mediaMap.size === 0) {
      throw new Error("media map has no entries");
    }
    return mediaMap;
  } catch (error) {
    if (error instanceof ParserFailure) {
      throw error;
    }
    throw new ParserFailure(
      "INVALID_PROTOBUF_MEDIA_MAP",
      "media",
      "The current media map is not valid protobuf",
      error instanceof Error ? error.message : undefined,
    );
  }
}

function validateMediaMime(name: string, bytes: Uint8Array): void {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const allowedMimeByExtension: Record<string, string> = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".png": "image/png",
    ".txt": "text/plain",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".webp": "image/webp",
  };
  const mime = allowedMimeByExtension[extension];
  if (!mime || isActiveMediaMime(extension) || !hasExpectedMediaSignature(mime, bytes)) {
    throw new ParserFailure(
      "DISALLOWED_MEDIA_MIME",
      "media",
      "The package contains media with a disallowed or mismatched MIME type",
      `${name}: ${mime ?? "unknown"}`,
    );
  }
}

function isActiveMediaMime(extension: string): boolean {
  return [
    ".css",
    ".htm",
    ".html",
    ".js",
    ".mjs",
    ".svg",
    ".swf",
    ".wasm",
    ".xhtml",
    ".xml",
  ].includes(extension);
}

function hasExpectedMediaSignature(mime: string, bytes: Uint8Array): boolean {
  switch (mime) {
    case "image/png":
      return bytes.byteLength >= 8 &&
        bytes.slice(0, 8).every((byte, index) => byte === [
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
        ][index]);
    case "image/gif":
      return decodeAscii(bytes.slice(0, 6)) === "GIF87a" ||
        decodeAscii(bytes.slice(0, 6)) === "GIF89a";
    case "image/jpeg":
      return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
        bytes[2] === 0xff;
    case "image/webp":
      return bytes.byteLength >= 12 && decodeAscii(bytes.slice(0, 4)) === "RIFF" &&
        decodeAscii(bytes.slice(8, 12)) === "WEBP";
    case "text/plain":
      return !bytes.includes(0);
    case "audio/mpeg":
      return bytes.byteLength >= 3 && (
        decodeAscii(bytes.slice(0, 3)) === "ID3" ||
        (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      );
    case "audio/ogg":
      return decodeAscii(bytes.slice(0, 4)) === "OggS";
    case "audio/mp4":
      return bytes.byteLength >= 8 && decodeAscii(bytes.slice(4, 8)) === "ftyp";
    case "audio/wav":
      return bytes.byteLength >= 12 && decodeAscii(bytes.slice(0, 4)) === "RIFF" &&
        decodeAscii(bytes.slice(8, 12)) === "WAVE";
    case "audio/webm":
      // WebM is an EBML container. The four-byte marker is enough for this
      // conservative MIME gate; the media bytes remain opaque to the spike.
      return bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 &&
        bytes[2] === 0xdf && bytes[3] === 0xa3;
    default:
      return false;
  }
}

function decodeAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function sanitizeNormalized(
  normalized: NormalizedRecords,
  media: ParserMediaEntry[],
): { normalized: NormalizedRecords; warnings: ParserWarning[] } {
  const mediaNames = new Set(media.map((entry) => entry.name));
  const warnings = new WarningCollector();
  const sanitizeContent = (value: string, label: string): string => {
    collectContentWarnings(value, label, mediaNames, warnings);
    const output = sanitizeHtml(value, mediaNames);
    if (output !== value) {
      warnings.add(
        "UNSAFE_HTML_REMOVED",
        "Unsafe HTML or navigation was removed from card content",
        label,
      );
    }
    return output;
  };

  const sanitizedNotes = normalized.notes.map((note) => ({
    ...note,
    fields: note.fields.map((field, index) =>
      sanitizeContent(field, `note ${note.id} field ${index}`),
    ),
  }));
  const sanitizedTemplates = normalized.cardTemplates.map((template) => ({
    ...template,
    questionFormat: sanitizeContent(
      template.questionFormat,
      `template ${template.notetypeId}/${template.ordinal} question`,
    ),
    answerFormat: sanitizeContent(
      template.answerFormat,
      `template ${template.notetypeId}/${template.ordinal} answer`,
    ),
  }));
  const css = sanitizeCss(normalized.css, warnings);

  return {
    normalized: {
      ...normalized,
      notes: sanitizedNotes,
      cardTemplates: sanitizedTemplates,
      css,
    },
    warnings: warnings.toArray(),
  };
}

const SAFE_HTML_TAGS: Record<string, string[]> = {
  b: [],
  br: [],
  blockquote: [],
  code: [],
  div: [],
  em: [],
  h1: [],
  h2: [],
  h3: [],
  i: [],
  img: ["alt", "height", "loading", "src", "title", "width"],
  li: [],
  ol: [],
  p: [],
  pre: [],
  small: [],
  span: [],
  strong: [],
  sub: [],
  sup: [],
  table: [],
  tbody: [],
  td: [],
  th: [],
  thead: [],
  tr: [],
  u: [],
  ul: [],
};

const STRIP_TAG_BODIES = [
  "applet",
  "base",
  "embed",
  "form",
  "iframe",
  "link",
  "meta",
  "object",
  "script",
  "style",
  "svg",
  "template",
  "video",
] as const;

function sanitizeHtml(value: string, mediaNames: Set<string>): string {
  const output = filterXSS(value, {
    allowList: SAFE_HTML_TAGS,
    stripIgnoreTag: true,
    stripIgnoreTagBody: [...STRIP_TAG_BODIES],
    safeAttrValue: (tag, name, attrValue, cssFilter) => {
      if (tag === "img" && name === "src") {
        const normalized = tryNormalizeMediaReference(attrValue);
        return normalized && mediaNames.has(normalized) ? normalized : "";
      }
      return defaultSafeAttrValue(tag, name, attrValue, cssFilter);
    },
  });
  // xss intentionally retains a valueless whitelisted attribute when its
  // safeAttrValue rejects it. Remove that inert placeholder as well as any
  // unexpected URL attributes so no browser navigation/fetch can occur.
  return output.replace(/\s(?:src|href)(?:\s*=\s*(?:""|''))?(?=[\s>])/gi, "");
}

function sanitizeCss(value: string, warnings: WarningCollector): string {
  const output = value
    .replace(/@import\b[^;{}]*(?:;|$)/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "")
    .replace(/(?:expression|behavior|-moz-binding)\s*\([^)]*\)/gi, "");
  if (output !== value) {
    warnings.add(
      "UNSAFE_HTML_REMOVED",
      "Unsafe CSS networking or scripting was removed from card styling",
      "notetype CSS",
    );
  }
  return output;
}

function collectContentWarnings(
  value: string,
  label: string,
  mediaNames: Set<string>,
  warnings: WarningCollector,
): void {
  if (/\{\{\s*type\s*:/i.test(value)) {
    warnings.add(
      "TYPE_ANSWER",
      "Type-answer fields are preserved as text but are not interactive",
      label,
    );
  }
  if (/\{\{\s*tts\b|\[\s*anki:tts\b/i.test(value)) {
    warnings.add(
      "TTS",
      "Text-to-speech directives are preserved but are not executed",
      label,
    );
  }
  if (/\[\$|\$\$|\\(?:\(|\[|begin\{)/i.test(value)) {
    warnings.add(
      "LATEX",
      "LaTeX directives are preserved but are not rendered by the spike",
      label,
    );
  }
  if (/<\s*script\b|\bon[a-z]+\s*=|javascript\s*:/i.test(value)) {
    warnings.add(
      "JAVASCRIPT",
      "JavaScript-dependent card content is not executed",
      label,
    );
  }
  if (/\{\{\s*(?:cloze:|#|\/|#if\b)/i.test(value)) {
    warnings.add(
      "UNSUPPORTED_TEMPLATE_FEATURE",
      "An unsupported Anki template directive is preserved as text",
      label,
    );
  }

  for (const reference of extractMediaReferences(value)) {
    const normalized = tryNormalizeMediaReference(reference);
    if (!normalized || !mediaNames.has(normalized)) {
      warnings.add(
        "MISSING_MEDIA",
        "A card references media that is not present in the package",
        `${label}: ${reference}`,
      );
    }
  }
}

function extractMediaReferences(value: string): string[] {
  const references: string[] = [];
  const imagePattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of value.matchAll(imagePattern)) {
    const reference = match[1] ?? match[2] ?? match[3];
    if (reference !== undefined) {
      references.push(reference);
    }
  }
  const soundPattern = /\[sound:([^\]]+)\]/gi;
  for (const match of value.matchAll(soundPattern)) {
    if (match[1] !== undefined) {
      references.push(match[1].trim());
    }
  }
  return references;
}

function tryNormalizeMediaReference(value: string): string | undefined {
  try {
    return normalizeArchivePath(value.trim(), "sanitization");
  } catch {
    return undefined;
  }
}

function estimateNormalizedMemory(
  normalized: NormalizedRecords,
  media: ParserMediaEntry[],
): number {
  const textBytes = [
    ...normalized.decks.flatMap((deck) => [deck.id, deck.name]),
    ...normalized.notetypes.flatMap((notetype) => [
      notetype.id,
      notetype.name,
      ...notetype.fields,
      ...notetype.templates,
    ]),
    ...normalized.notes.flatMap((note) => [
      note.id,
      note.sourceGuid,
      note.notetypeId,
      note.deckId,
      ...note.fields,
      ...note.tags,
    ]),
    ...normalized.cards.flatMap((card) => [card.id, card.noteId, card.deckId]),
    ...normalized.cardTemplates.flatMap((template) => [
      template.notetypeId,
      template.name,
      template.questionFormat,
      template.answerFormat,
    ]),
    ...normalized.fields.flatMap((field) => [field.notetypeId, field.name]),
    normalized.css,
    ...media.map((entry) => entry.name),
  ].reduce((total, value) => total + textEncoder.encode(value).byteLength, 0);
  return textBytes + media.reduce((total, entry) => total + entry.byteLength, 0);
}

class WarningCollector {
  private readonly warnings = new Map<string, ParserWarning>();

  public add(
    code: ParserWarningCode,
    message: string,
    detail: string,
  ): void {
    this.warnings.set(`${code}\u0000${detail}`, { code, message, detail });
  }

  public toArray(): ParserWarning[] {
    return [...this.warnings.values()].sort((left, right) =>
      compareCanonical(left.code, right.code) ||
      compareCanonical(left.detail ?? "", right.detail ?? ""),
    );
  }
}

function normalizeArchivePath(path: string, stage: ParserStage): string {
  if (!path || path.includes("\0") || path.includes("\ufffd")) {
    throw new ParserFailure(
      "UNSAFE_ARCHIVE_PATH",
      stage,
      "Archive member name is empty or contains malformed text",
      path,
    );
  }
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    throw new ParserFailure(
      "UNSAFE_ARCHIVE_PATH",
      stage,
      "Archive member path is absolute",
      path,
    );
  }
  const canonical = path.normalize("NFC").replaceAll("\\", "/");
  if (
    canonical.split("/").some((segment) => segment === "..") ||
    canonical.startsWith("../") ||
    canonical === ".."
  ) {
    throw new ParserFailure(
      "UNSAFE_ARCHIVE_PATH",
      stage,
      "Archive member path contains parent traversal",
      path,
    );
  }
  return canonical;
}

function normalizeMediaName(name: string): string {
  return normalizeArchivePath(name, "media");
}

function mediaMapHasName(mediaMap: Map<string, MediaMapEntry>, name: string): boolean {
  return [...mediaMap.values()].some((existing) => existing.name === name);
}

function hasSqliteHeader(bytes: Uint8Array): boolean {
  const header = textEncoder.encode("SQLite format 3\0");
  return bytes.byteLength >= header.byteLength && header.every(
    (byte, index) => bytes[index] === byte,
  );
}

function normalizeTransientSqliteHeader(bytes: Uint8Array): Uint8Array {
  // SQLite file header bytes 18 and 19 are the write/read versions. Value 2
  // means WAL. A package has no separate WAL file, so make an owned copy with
  // the self-contained rollback-journal marker expected by the in-memory VFS.
  if (bytes[18] !== 2 && bytes[19] !== 2) {
    return bytes;
  }
  const copy = bytes.slice();
  copy[18] = 1;
  copy[19] = 1;
  return copy;
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha1(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", copyArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", copyArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

class ParseContext {
  private limits: ParseLimits = DEFAULT_PARSE_LIMITS;
  public expandedBytes = 0;
  private memoryBytes = 0;
  public peakMemoryBytes = 0;

  public constructor(
    private readonly request: ParseRequest,
    private readonly startedAt: number,
    private readonly emit: (message: ParserProgressMessage) => void,
  ) {}

  public setLimits(limits: ParseLimits): void {
    this.limits = limits;
  }

  public progress(stage: ParserStage, completed: number): void {
    this.throwIfCancelled(stage);
    this.throwIfTimedOut(stage);
    this.emit({
      kind: "progress",
      operationId: this.request.operationId,
      stage,
      completed,
      total: PARSER_STAGES.length,
    });
  }

  public addExpandedBytes(bytes: number, stage: ParserStage): void {
    this.expandedBytes += bytes;
    if (this.expandedBytes > this.limits.maxExpandedBytes) {
      throw new ParserFailure(
        "ARCHIVE_LIMIT_EXCEEDED",
        stage,
        "Decompressed package data exceeds the expanded-size limit",
        `expandedBytes=${this.expandedBytes}, maxExpandedBytes=${this.limits.maxExpandedBytes}`,
      );
    }
  }

  public assertEntrySize(bytes: number, member: string): void {
    if (bytes > this.limits.maxEntryBytes) {
      throw new ParserFailure(
        "ARCHIVE_LIMIT_EXCEEDED",
        "media",
        "A decompressed member exceeds the per-entry limit",
      `${member}: ${bytes} > ${this.limits.maxEntryBytes}`,
      );
    }
  }

  public assertDecompressedSize(
    bytes: number,
    stage: ParserStage,
    label: string,
  ): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ParserFailure(
        "INVALID_ZSTD",
        stage,
        `${label} reported an unsafe decompressed size`,
      );
    }
    if (bytes > this.limits.maxEntryBytes) {
      throw new ParserFailure(
        "ARCHIVE_LIMIT_EXCEEDED",
        stage,
        `${label} exceeds the per-entry limit after decompression`,
        `${bytes} > ${this.limits.maxEntryBytes}`,
      );
    }
    if (this.expandedBytes + bytes > this.limits.maxExpandedBytes) {
      throw new ParserFailure(
        "ARCHIVE_LIMIT_EXCEEDED",
        stage,
        `${label} exceeds the expanded-size limit after decompression`,
        `expandedBytes=${this.expandedBytes + bytes}, maxExpandedBytes=${this.limits.maxExpandedBytes}`,
      );
    }
    if (this.memoryBytes + bytes > this.limits.maxMemoryBytes) {
      throw new ParserFailure(
        "MEMORY_LIMIT_EXCEEDED",
        stage,
        `${label} exceeds the parser memory limit`,
        `memoryBytes=${this.memoryBytes + bytes}, maxMemoryBytes=${this.limits.maxMemoryBytes}`,
      );
    }
  }

  public assertZstdWindow(
    bytes: number,
    stage: ParserStage,
    label: string,
  ): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ParserFailure(
        "INVALID_ZSTD",
        stage,
        `${label} reported an unsafe window size`,
      );
    }
    if (this.memoryBytes + bytes > this.limits.maxMemoryBytes) {
      throw new ParserFailure(
        "MEMORY_LIMIT_EXCEEDED",
        stage,
        `${label} requires more zstd window memory than allowed`,
        `windowBytes=${bytes}, memoryBytes=${this.memoryBytes}, maxMemoryBytes=${this.limits.maxMemoryBytes}`,
      );
    }
  }

  public reserveMemory(bytes: number, stage: ParserStage, label: string): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ParserFailure(
        "MEMORY_LIMIT_EXCEEDED",
        stage,
        `${label} reported an unsafe memory size`,
      );
    }
    const nextMemoryBytes = this.memoryBytes + bytes;
    if (nextMemoryBytes > this.limits.maxMemoryBytes) {
      throw new ParserFailure(
        "MEMORY_LIMIT_EXCEEDED",
        stage,
        `${label} exceeds the parser memory limit`,
        `memoryBytes=${nextMemoryBytes}, maxMemoryBytes=${this.limits.maxMemoryBytes}`,
      );
    }
    this.memoryBytes = nextMemoryBytes;
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes, this.memoryBytes);
  }

  public releaseMemory(bytes: number): void {
    this.memoryBytes = Math.max(0, this.memoryBytes - bytes);
  }

  public async checkpoint(stage: ParserStage): Promise<void> {
    this.throwIfCancelled(stage);
    this.throwIfTimedOut(stage);
    const delay = Math.max(
      0,
      Math.min(100, this.request.checkpointDelayMs ?? 0),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    this.throwIfCancelled(stage);
    this.throwIfTimedOut(stage);
  }

  private throwIfCancelled(stage: ParserStage): void {
    if (cancelledOperations.has(this.request.operationId)) {
      throw new CooperativeCancellation(stage);
    }
  }

  private throwIfTimedOut(stage: ParserStage): void {
    if (performance.now() - this.startedAt > this.limits.maxParseTimeMs) {
      throw new ParserFailure(
        "PARSE_LIMIT_EXCEEDED",
        stage,
        "The parser exceeded its configured time limit",
        `maxParseTimeMs=${this.limits.maxParseTimeMs}`,
      );
    }
  }
}

class CooperativeCancellation extends Error {
  public constructor(public readonly stage: ParserStage) {
    super("Parser operation cancelled at a cooperative checkpoint");
    this.name = "CooperativeCancellation";
  }
}

class ParserFailure extends Error {
  public constructor(
    public readonly code: Exclude<ParserErrorCode, "CANCELLED" | "UNSUPPORTED_LAYOUT">,
    public readonly stage: ParserStage,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ParserFailure";
  }
}

class UnsupportedLayoutFailure extends Error {
  public constructor(
    public readonly stage: ParserStage,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "UnsupportedLayoutFailure";
  }
}

function toParserFailure(error: unknown, stage: ParserStage): ParserFailure {
  if (error instanceof ParserFailure) {
    return error;
  }
  return new ParserFailure(
    "INVALID_REQUEST",
    stage,
    "The Worker parser failed before it could produce a validated staged result",
    error instanceof Error ? error.message : "Unknown parser failure",
  );
}
