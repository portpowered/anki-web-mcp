export const STACK_STAGES = [
  "zip",
  "sqlite",
  "zstd",
  "protobuf",
  "sanitizer",
] as const;

export type StackStage = (typeof STACK_STAGES)[number];

export interface EvaluateRequest {
  type: "evaluate";
  operationId: string;
  checkpointDelayMs?: number;
  pauseAfterProgressStage?: StackStage;
  pauseAfterProgressMs?: number;
}

export interface CancelRequest {
  type: "cancel";
  operationId: string;
}

export type WorkerRequest = EvaluateRequest | CancelRequest;

export interface ProgressMessage {
  kind: "progress";
  operationId: string;
  stage: StackStage;
  completed: number;
  total: number;
}

export interface ZipObservation {
  archiveBytes: number;
  entries: string[];
  collectionPayload: string;
  collectionSha256: string;
}

export interface SqliteObservation {
  libraryVersion: string;
  rows: Array<{ id: number; value: string }>;
}

export interface ZstdObservation {
  compressedBytes: number;
  decompressedBytes: number;
  text: string;
}

export interface ProtobufObservation {
  encodedBytes: number;
  decoded: { name: string; ordinal: number };
}

export interface SanitizerObservation {
  inputBytes: number;
  output: string;
  removedUnsafeContent: boolean;
  retainsPackageMedia: boolean;
}

export interface StackObservations {
  zip: ZipObservation;
  sqlite: SqliteObservation;
  zstd: ZstdObservation;
  protobuf: ProtobufObservation;
  sanitizer: SanitizerObservation;
}

export interface SuccessMessage {
  kind: "terminal";
  operationId: string;
  status: "success";
  commitReady: true;
  stagedResult: StackObservations;
  elapsedMs: number;
  workerRuntime: "dedicated-worker";
}

export interface CancelledMessage {
  kind: "terminal";
  operationId: string;
  status: "cancelled";
  commitReady: false;
  stagedResult: null;
  stage: StackStage;
  cancellation: "cooperative-checkpoint";
}

export interface ErrorMessage {
  kind: "terminal";
  operationId: string;
  status: "error";
  commitReady: false;
  stagedResult: null;
  diagnostic: {
    code: "STACK_OPERATION_FAILED";
    stage: StackStage;
    errorName: string;
    errorMessage: string;
  };
}

export type TerminalMessage =
  | SuccessMessage
  | CancelledMessage
  | ErrorMessage;

export type WorkerMessage = ProgressMessage | TerminalMessage;

/**
 * The parser stages are deliberately ordered. A terminal success is not
 * emitted until every stage has completed, so a consumer can treat the
 * result as an all-or-nothing staged value.
 */
export const PARSER_STAGES = [
  "archive",
  "collection",
  "decompression",
  "database",
  "media",
  "sanitization",
] as const;

export type ParserStage = (typeof PARSER_STAGES)[number];

export const PARSER_ERROR_CODES = [
  "UNSUPPORTED_LAYOUT",
  "INVALID_ZIP",
  "ARCHIVE_LIMIT_EXCEEDED",
  "MEMORY_LIMIT_EXCEEDED",
  "INVALID_SQLITE",
  "INVALID_ZSTD",
  "INVALID_PROTOBUF_MEDIA_MAP",
  "DISALLOWED_MEDIA_MIME",
  "UNSAFE_ARCHIVE_PATH",
  "PARSE_LIMIT_EXCEEDED",
  "CANCELLED",
  "INVALID_REQUEST",
] as const;

export type ParserErrorCode = (typeof PARSER_ERROR_CODES)[number];

export type SupportedLayout =
  | "legacy-anki2"
  | "transition-anki21"
  | "current-anki21b";

export interface ParseLimits {
  /** Maximum size of the transferred ZIP package. */
  maxPackageBytes: number;
  /** Maximum number of central-directory entries. */
  maxArchiveEntries: number;
  /** Maximum sum of all entry original sizes. */
  maxExpandedBytes: number;
  /** Maximum original size for one entry. */
  maxEntryBytes: number;
  /** Maximum original/compressed ratio for a non-empty entry. */
  maxCompressionRatio: number;
  /** Maximum wall-clock time for the complete parser operation. */
  maxParseTimeMs: number;
  /** Maximum parser-owned live memory estimate, including the transferred package. */
  maxMemoryBytes: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxPackageBytes: 16 * 1024 * 1024,
  maxArchiveEntries: 512,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxParseTimeMs: 15_000,
  maxMemoryBytes: 128 * 1024 * 1024,
};

export interface ParseRequest {
  type: "parse";
  operationId: string;
  packageBytes: ArrayBuffer;
  limits: ParseLimits;
  /** Test-only task-boundary delay; the production caller leaves this unset. */
  checkpointDelayMs?: number;
}

export type ParserWorkerRequest = ParseRequest | CancelRequest;

export interface ParserArchiveEntry {
  path: string;
  compressedBytes: number;
  expandedBytes: number;
}

export interface ParserMediaEntry {
  name: string;
  sourceMember: string;
  byteLength: number;
  sha1: string;
  bytes: ArrayBuffer;
}

export interface NormalizedDeck {
  id: string;
  name: string;
}

export interface NormalizedNotetype {
  id: string;
  name: string;
  fields: string[];
  templates: string[];
}

export interface NormalizedField {
  notetypeId: string;
  ordinal: number;
  name: string;
}

export interface NormalizedCardTemplate {
  notetypeId: string;
  ordinal: number;
  name: string;
  questionFormat: string;
  answerFormat: string;
}

export interface NormalizedNote {
  id: string;
  sourceGuid: string;
  notetypeId: string;
  deckId: string;
  fields: string[];
  tags: string[];
}

export interface NormalizedCard {
  id: string;
  noteId: string;
  deckId: string;
  templateOrdinal: number;
  /** Imported review state is intentionally not active scheduling input. */
  scheduling: "fresh";
}

/**
 * This is the isolated spike's staged boundary. Format-specific archive and
 * SQLite details stop here; downstream code consumes one deterministic model.
 */
export interface NormalizedStagedResult {
  packageSha256: string;
  layout: SupportedLayout;
  collectionMember: string;
  archiveMembers: ParserArchiveEntry[];
  normalized: {
    decks: NormalizedDeck[];
    notetypes: NormalizedNotetype[];
    notes: NormalizedNote[];
    cards: NormalizedCard[];
    cardTemplates: NormalizedCardTemplate[];
    fields: NormalizedField[];
    media: ParserMediaEntry[];
    css: string;
  };
  validation: {
    collectionBytes: number;
    sqliteTables: string[];
    expandedBytes: number;
    peakMemoryBytes: number;
    sanitizer: "worker-whitelist";
  };
  warnings: ParserWarning[];
}

export const PARSER_WARNING_CODES = [
  "UNSAFE_HTML_REMOVED",
  "MISSING_MEDIA",
  "UNSUPPORTED_TEMPLATE_FEATURE",
  "TYPE_ANSWER",
  "TTS",
  "LATEX",
  "JAVASCRIPT",
] as const;

export type ParserWarningCode = (typeof PARSER_WARNING_CODES)[number];

export interface ParserWarning {
  code: ParserWarningCode;
  message: string;
  detail?: string;
}

export interface ParserProgressMessage {
  kind: "progress";
  operationId: string;
  stage: ParserStage;
  /** Number of completed stages; values are strictly monotonic per operation. */
  completed: number;
  total: typeof PARSER_STAGES.length;
}

export interface ParserSuccessMessage {
  kind: "terminal";
  operationId: string;
  status: "success";
  commitReady: true;
  stagedResult: NormalizedStagedResult;
  elapsedMs: number;
  workerRuntime: "dedicated-worker";
}

export interface ParserCancelledMessage {
  kind: "terminal";
  operationId: string;
  status: "cancelled";
  commitReady: false;
  stagedResult: null;
  diagnostic: {
    code: "CANCELLED";
    stage: ParserStage;
    message: "Parser operation cancelled at a cooperative checkpoint";
  };
}

export interface ParserUnsupportedMessage {
  kind: "terminal";
  operationId: string;
  status: "unsupported";
  commitReady: false;
  stagedResult: null;
  diagnostic: ParserDiagnosticBase & { code: "UNSUPPORTED_LAYOUT" };
}

export interface ParserErrorMessage {
  kind: "terminal";
  operationId: string;
  status: "error";
  commitReady: false;
  stagedResult: null;
  diagnostic: ParserDiagnostic;
}

export interface ParserDiagnosticBase {
  code: ParserErrorCode;
  stage: ParserStage;
  message: string;
  detail?: string;
}

export interface ParserDiagnostic extends ParserDiagnosticBase {
  code: Exclude<ParserErrorCode, "CANCELLED" | "UNSUPPORTED_LAYOUT">;
}

export type ParserTerminalMessage =
  | ParserSuccessMessage
  | ParserCancelledMessage
  | ParserUnsupportedMessage
  | ParserErrorMessage;

export type ParserWorkerMessage =
  | ParserProgressMessage
  | ParserTerminalMessage;
