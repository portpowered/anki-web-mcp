import {
  IMPORT_WARNING_CODES,
  IMPORT_WORKER_STAGES,
  type CommitReadyGraph,
  type ImportDuplicatePolicy,
  type ImportProgressStage,
  type ImportWarning,
} from "./contracts";
import { isImportError, type ImportError } from "./errors";
import type { ImportLimits } from "./limits";

/** Bump only when the structured-clone message contract changes. */
export const IMPORT_WORKER_PROTOCOL = "webmcp-anki/apkg-import" as const;
export const IMPORT_WORKER_PROTOCOL_VERSION = 1 as const;

export type ImportWorkerProtocolVersion =
  typeof IMPORT_WORKER_PROTOCOL_VERSION;

export interface ImportWorkerStartRequest {
  readonly protocol: typeof IMPORT_WORKER_PROTOCOL;
  readonly version: ImportWorkerProtocolVersion;
  readonly type: "start";
  readonly operationId: string;
  readonly fileName: string;
  readonly packageBytes: ArrayBuffer;
  readonly packageSha256: string;
  readonly limits: ImportLimits;
  readonly duplicatePolicy: ImportDuplicatePolicy;
}

export type ImportWorkerCancelReason = "caller" | "superseded" | "timeout";

export interface ImportWorkerCancelRequest {
  readonly protocol: typeof IMPORT_WORKER_PROTOCOL;
  readonly version: ImportWorkerProtocolVersion;
  readonly type: "cancel";
  readonly operationId: string;
  readonly reason: ImportWorkerCancelReason;
}

export type ImportWorkerRequest =
  | ImportWorkerStartRequest
  | ImportWorkerCancelRequest;

export interface ImportWorkerProgressMessage {
  readonly protocol: typeof IMPORT_WORKER_PROTOCOL;
  readonly version: ImportWorkerProtocolVersion;
  readonly type: "progress";
  readonly operationId: string;
  readonly stage: Exclude<ImportProgressStage, "preflight" | "commit-ready" | "committing">;
  /** Operation-level counters; completed never decreases for an operation. */
  readonly completed: number;
  readonly total: number | null;
  readonly stageCompleted: number;
  readonly stageTotal: number | null;
}

export interface ImportWorkerWarningMessage {
  readonly protocol: typeof IMPORT_WORKER_PROTOCOL;
  readonly version: ImportWorkerProtocolVersion;
  readonly type: "warning";
  readonly operationId: string;
  readonly warning: ImportWarning;
}

export interface ImportWorkerSuccessMessage<Graph extends CommitReadyGraph = CommitReadyGraph> {
  readonly protocol: typeof IMPORT_WORKER_PROTOCOL;
  readonly version: ImportWorkerProtocolVersion;
  readonly type: "terminal";
  readonly operationId: string;
  readonly status: "success";
  readonly commitReady: true;
  readonly graph: Graph;
  readonly warnings: readonly ImportWarning[];
}

export interface ImportWorkerCancelledMessage {
  readonly protocol: typeof IMPORT_WORKER_PROTOCOL;
  readonly version: ImportWorkerProtocolVersion;
  readonly type: "terminal";
  readonly operationId: string;
  readonly status: "cancelled";
  readonly commitReady: false;
  readonly error: ImportError;
}

export interface ImportWorkerFailureMessage {
  readonly protocol: typeof IMPORT_WORKER_PROTOCOL;
  readonly version: ImportWorkerProtocolVersion;
  readonly type: "terminal";
  readonly operationId: string;
  readonly status: "failed";
  readonly commitReady: false;
  readonly error: ImportError;
}

export type ImportWorkerTerminalMessage<Graph extends CommitReadyGraph = CommitReadyGraph> =
  | ImportWorkerSuccessMessage<Graph>
  | ImportWorkerCancelledMessage
  | ImportWorkerFailureMessage;

export type ImportWorkerMessage<Graph extends CommitReadyGraph = CommitReadyGraph> =
  | ImportWorkerProgressMessage
  | ImportWorkerWarningMessage
  | ImportWorkerTerminalMessage<Graph>;

/** Runtime validation keeps malformed or old-version messages off the service path. */
export function isImportWorkerMessage<Graph extends CommitReadyGraph = CommitReadyGraph>(
  value: unknown,
): value is ImportWorkerMessage<Graph> {
  if (!isProtocolMessage(value)) {
    return false;
  }

  const message = value as {
    type?: unknown;
    operationId?: unknown;
    stage?: unknown;
    completed?: unknown;
    total?: unknown;
    stageCompleted?: unknown;
    stageTotal?: unknown;
    warning?: unknown;
    status?: unknown;
    commitReady?: unknown;
    graph?: unknown;
    error?: unknown;
    warnings?: unknown;
  };

  if (typeof message.operationId !== "string" || message.operationId.length === 0) {
    return false;
  }

  switch (message.type) {
    case "progress":
      return isProgressMessage(message);
    case "warning":
      return isWarningMessage(message);
    case "terminal":
      return isTerminalMessage(message);
    default:
      return false;
  }
}

export function isImportWorkerRequest(value: unknown): value is ImportWorkerRequest {
  if (!isProtocolMessage(value)) {
    return false;
  }

  const request = value as {
    type?: unknown;
    operationId?: unknown;
    fileName?: unknown;
    packageBytes?: unknown;
    packageSha256?: unknown;
    limits?: unknown;
    duplicatePolicy?: unknown;
    reason?: unknown;
  };
  if (typeof request.operationId !== "string" || request.operationId.length === 0) {
    return false;
  }

  if (request.type === "cancel") {
    return request.reason === "caller"
      || request.reason === "superseded"
      || request.reason === "timeout";
  }

  return request.type === "start"
    && typeof request.fileName === "string"
    && request.packageBytes instanceof ArrayBuffer
    && typeof request.packageSha256 === "string"
    && request.packageSha256.length === 64
    && (request.duplicatePolicy === "cancel" || request.duplicatePolicy === "replace")
    && isImportLimits(request.limits);
}

function isProtocolMessage(value: unknown): value is {
  protocol: typeof IMPORT_WORKER_PROTOCOL;
  version: ImportWorkerProtocolVersion;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { protocol?: unknown; version?: unknown };
  return candidate.protocol === IMPORT_WORKER_PROTOCOL
    && candidate.version === IMPORT_WORKER_PROTOCOL_VERSION;
}

function isProgressMessage(message: {
  stage?: unknown;
  completed?: unknown;
  total?: unknown;
  stageCompleted?: unknown;
  stageTotal?: unknown;
}): boolean {
  return (
    typeof message.stage === "string"
    && (IMPORT_WORKER_STAGES as readonly string[]).includes(message.stage)
    && isCounter(message.completed)
    && isTotal(message.total)
    && isCounter(message.stageCompleted)
    && isTotal(message.stageTotal)
    && isWithinTotal(message.completed, message.total)
    && isWithinTotal(message.stageCompleted, message.stageTotal)
  );
}

function isWarningMessage(message: { warning?: unknown }): boolean {
  const warning = message.warning;
  if (!warning || typeof warning !== "object") {
    return false;
  }
  const candidate = warning as Partial<ImportWarning>;
  return typeof candidate.code === "string"
    && (IMPORT_WARNING_CODES as readonly string[]).includes(candidate.code)
    && typeof candidate.message === "string"
    && typeof candidate.stage === "string"
    && (IMPORT_WORKER_STAGES as readonly string[]).includes(candidate.stage)
    && (candidate.source === undefined || isWarningSource(candidate.source));
}

function isTerminalMessage(message: {
  status?: unknown;
  commitReady?: unknown;
  graph?: unknown;
  error?: unknown;
  warnings?: unknown;
}): boolean {
  if (message.status === "success") {
    return message.commitReady === true
      && isRecord(message.graph)
      && Array.isArray(message.warnings)
      && message.warnings.every(isWarningValue);
  }

  return (
    (message.status === "cancelled" || message.status === "failed")
    && message.commitReady === false
    && isImportError(message.error)
    && (message.status !== "cancelled" || message.error.code === "IMPORT_CANCELLED")
  );
}

function isWarningValue(value: unknown): value is ImportWarning {
  return isWarningMessage({ warning: value });
}

function isWarningSource(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const source = value as { kind?: unknown; id?: unknown };
  return (
    (source.kind === "package"
      || source.kind === "deck"
      || source.kind === "model"
      || source.kind === "note"
      || source.kind === "card"
      || source.kind === "template"
      || source.kind === "media")
    && typeof source.id === "string"
    && source.id.length > 0
  );
}

function isImportLimits(value: unknown): value is ImportLimits {
  if (!value || typeof value !== "object") {
    return false;
  }
  const limits = value as Partial<ImportLimits>;
  return (
    isLimit(limits.maxPackageBytes)
    && isLimit(limits.maxExpandedBytes)
    && isLimit(limits.maxArchiveEntries)
    && isLimit(limits.maxEntryBytes)
    && typeof limits.maxCompressionRatio === "number"
    && Number.isFinite(limits.maxCompressionRatio)
    && limits.maxCompressionRatio > 0
    && isLimit(limits.maxNestedArchives)
    && isLimit(limits.maxParseTimeMs)
    && isLimit(limits.maxUtf8Bytes)
    && isLimit(limits.maxMediaCount)
    && isLimit(limits.maxMediaFileBytes)
    && isLimit(limits.maxMediaBytes)
    && Array.isArray(limits.allowedMediaMimeTypes)
    && limits.allowedMediaMimeTypes.every((mime) => typeof mime === "string")
  );
}

function isLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCounter(value: unknown): value is number {
  return isLimit(value);
}

function isTotal(value: unknown): value is number | null {
  return value === null || isCounter(value);
}

function isWithinTotal(value: unknown, total: unknown): boolean {
  return total === null || (
    typeof value === "number"
    && typeof total === "number"
    && value <= total
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
