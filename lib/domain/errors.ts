export const DOMAIN_ERROR_CODES = [
  "open",
  "migration",
  "constraint",
  "not-found",
  "transaction",
  "quota",
  "storage",
  "validation",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  code: DomainErrorCode;
  message: string;
  resource?: string;
  key?: string;
}

export interface Success<T> {
  ok: true;
  value: T;
}

export interface Failure {
  ok: false;
  error: DomainError;
}

export type DomainResult<T> = Success<T> | Failure;

export function success<T>(value: T): Success<T> {
  return { ok: true, value };
}

export function failure(error: DomainError): Failure {
  return { ok: false, error };
}

export function domainError(
  code: DomainErrorCode,
  message: string,
  details: Pick<DomainError, "resource" | "key"> = {},
): DomainError {
  return { code, message, ...details };
}

/** Translate platform/database exceptions into the stable domain vocabulary. */
export function mapDatabaseError(
  cause: unknown,
  fallbackCode: DomainErrorCode = "storage",
  details: Pick<DomainError, "resource" | "key"> = {},
): DomainError {
  const name = readExceptionName(cause);
  const code =
    name === "ConstraintError"
      ? "constraint"
      : name === "NotFoundError"
        ? "not-found"
        : name === "AbortError"
          ? "transaction"
          : name === "VersionError" || name === "InvalidStateError"
            ? "migration"
            : name === "QuotaExceededError"
              ? "quota"
              : name === "UnknownError"
                ? "storage"
              : fallbackCode;

  return domainError(code, messageFor(code), details);
}

function readExceptionName(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("name" in cause)) {
    return undefined;
  }

  const name = (cause as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function messageFor(code: DomainErrorCode): string {
  switch (code) {
    case "open":
      return "The local database could not be opened.";
    case "migration":
      return "The local database could not be migrated.";
    case "constraint":
      return "The requested record conflicts with an existing record.";
    case "not-found":
      return "The requested record was not found.";
    case "transaction":
      return "The database transaction was not committed.";
    case "validation":
      return "The requested domain data is invalid.";
    case "storage":
      return "The local database operation failed.";
    case "quota":
      return "There is not enough local storage for this operation.";
  }
}
