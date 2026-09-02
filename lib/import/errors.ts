import { IMPORT_STATES, type ImportStage } from "./contracts";

export const IMPORT_ERROR_CODES = [
  "INVALID_IMPORT_REQUEST",
  "INVALID_PACKAGE",
  "UNSUPPORTED_PACKAGE",
  "ARCHIVE_INVALID",
  "ARCHIVE_LIMIT_EXCEEDED",
  "ARCHIVE_PATH_UNSAFE",
  "COLLECTION_INVALID",
  "SQLITE_INVALID",
  "ZSTD_INVALID",
  "PROTOBUF_INVALID",
  "MEDIA_MAP_INVALID",
  "NORMALIZATION_FAILED",
  "TEMPLATE_COMPILATION_FAILED",
  "MEDIA_INVALID",
  "MIME_NOT_ALLOWED",
  "DUPLICATE_IMPORT",
  "IMPORT_CANCELLED",
  "IMPORT_TIMEOUT",
  "QUOTA_EXCEEDED",
  "COMMIT_FAILED",
  "REPLACE_FAILED",
  "WORKER_FAILED",
] as const;

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

const IMPORT_ERROR_MESSAGES: Readonly<Record<ImportErrorCode, string>> = {
  INVALID_IMPORT_REQUEST: "The import request is invalid.",
  INVALID_PACKAGE: "The package is invalid.",
  UNSUPPORTED_PACKAGE: "The package layout is not supported.",
  ARCHIVE_INVALID: "The package archive is invalid.",
  ARCHIVE_LIMIT_EXCEEDED: "The package exceeds an archive safety limit.",
  ARCHIVE_PATH_UNSAFE: "The package contains an unsafe archive path.",
  COLLECTION_INVALID: "The package collection is invalid.",
  SQLITE_INVALID: "The package collection database is invalid.",
  ZSTD_INVALID: "The compressed collection is invalid.",
  PROTOBUF_INVALID: "The package metadata is invalid.",
  MEDIA_MAP_INVALID: "The package media map is invalid.",
  NORMALIZATION_FAILED: "The package records could not be normalized.",
  TEMPLATE_COMPILATION_FAILED: "The package templates could not be compiled safely.",
  MEDIA_INVALID: "The package media is invalid.",
  MIME_NOT_ALLOWED: "The package contains media with a disallowed MIME type.",
  DUPLICATE_IMPORT: "This package has already been imported.",
  IMPORT_CANCELLED: "The import was cancelled.",
  IMPORT_TIMEOUT: "The import exceeded its time limit.",
  QUOTA_EXCEEDED: "There is not enough local storage for this import.",
  COMMIT_FAILED: "The import could not be committed.",
  REPLACE_FAILED: "The existing import could not be replaced.",
  WORKER_FAILED: "The import Worker failed.",
};

export interface ImportErrorOptions {
  readonly operationId?: string;
  readonly stage?: ImportStage;
  readonly retryable?: boolean;
  /** Safe, bounded context only; raw exceptions must never cross the API. */
  readonly detail?: string;
}

/** Stable, structured, structured-clone-safe caller-facing error envelope. */
export interface ImportError {
  readonly code: ImportErrorCode;
  readonly message: string;
  readonly operationId: string | null;
  readonly stage: ImportStage | null;
  readonly retryable: boolean;
  readonly detail?: string;
}

export function importError(
  code: ImportErrorCode,
  options: ImportErrorOptions = {},
): ImportError {
  const detail = safeDetail(options.detail);
  return Object.freeze({
    code,
    message: IMPORT_ERROR_MESSAGES[code],
    operationId: options.operationId ?? null,
    stage: options.stage ?? null,
    retryable: options.retryable ?? isRetryable(code),
    ...(detail === undefined ? {} : { detail }),
  });
}

export function isImportError(value: unknown): value is ImportError {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ImportError>;
  return (
    typeof candidate.code === "string"
    && (IMPORT_ERROR_CODES as readonly string[]).includes(candidate.code)
    && typeof candidate.message === "string"
    && (candidate.operationId === null || typeof candidate.operationId === "string")
    && (
      candidate.stage === null
      || (
        typeof candidate.stage === "string"
        && (IMPORT_STATES as readonly string[]).includes(candidate.stage)
      )
    )
    && typeof candidate.retryable === "boolean"
    && (candidate.detail === undefined || typeof candidate.detail === "string")
  );
}

/** Map infrastructure failures without exposing their name, message, or DOM object. */
export function mapImportFailure(
  cause: unknown,
  fallbackCode: ImportErrorCode,
  options: ImportErrorOptions = {},
): ImportError {
  if (isImportError(cause)) {
    return importError(cause.code, {
      ...options,
      operationId: options.operationId ?? cause.operationId ?? undefined,
      stage: options.stage ?? cause.stage ?? undefined,
      retryable: options.retryable ?? cause.retryable,
      detail: options.detail,
    });
  }

  const name = exceptionName(cause);
  const code = name === "QuotaExceededError"
    ? "QUOTA_EXCEEDED"
    : name === "TimeoutError"
      ? "IMPORT_TIMEOUT"
      : fallbackCode;
  return importError(code, options);
}

/** Rebuild a validated Worker error using only application-owned messages. */
export function normalizeImportError(
  error: ImportError,
  operationId: string,
): ImportError {
  return importError(error.code, {
    operationId,
    stage: error.stage ?? undefined,
    retryable: error.retryable,
    detail: error.detail,
  });
}

export function errorForCancellation(
  operationId: string,
  stage: ImportStage,
  reason: ImportCancellationReason,
): ImportError {
  return importError("IMPORT_CANCELLED", {
    operationId,
    stage,
    detail: reason,
  });
}

export type ImportCancellationReason = "caller" | "superseded" | "timeout";

function isRetryable(code: ImportErrorCode): boolean {
  return code === "IMPORT_TIMEOUT"
    || code === "WORKER_FAILED"
    || code === "QUOTA_EXCEEDED"
    || code === "COMMIT_FAILED"
    || code === "REPLACE_FAILED";
}

function safeDetail(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value.slice(0, 160);
}

function exceptionName(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object" || !("name" in cause)) {
    return undefined;
  }
  const name = (cause as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}
