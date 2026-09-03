/**
 * Resource limits carried across the import boundary.
 *
 * The parser stories will enforce each limit. Keeping the complete, plain
 * data-only shape here means the application and Worker use the same
 * configuration without importing a parser or browser object.
 */
export interface ImportLimits {
  /** Maximum number of bytes accepted from the caller. */
  readonly maxPackageBytes: number;
  /** Maximum sum of expanded archive member bytes. */
  readonly maxExpandedBytes: number;
  /** Maximum number of archive members. */
  readonly maxArchiveEntries: number;
  /** Maximum expanded bytes for one archive member. */
  readonly maxEntryBytes: number;
  /** Maximum expanded/compressed ratio for non-empty members. */
  readonly maxCompressionRatio: number;
  /** Nested archives are rejected by default; this is a depth bound. */
  readonly maxNestedArchives: number;
  /** Maximum wall-clock parser time. */
  readonly maxParseTimeMs: number;
  /** Maximum decoded UTF-8 payload accepted for one bounded value. */
  readonly maxUtf8Bytes: number;
  /** Maximum verified media members. */
  readonly maxMediaCount: number;
  /** Maximum bytes for one verified media member. */
  readonly maxMediaFileBytes: number;
  /** Maximum aggregate bytes for verified media. */
  readonly maxMediaBytes: number;
  /** MIME allow-list applied after content sniffing. */
  readonly allowedMediaMimeTypes: readonly string[];
}

export type ImportLimitsInput = Partial<ImportLimits>;

export const DEFAULT_IMPORT_LIMITS: ImportLimits = Object.freeze({
  maxPackageBytes: 384 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxArchiveEntries: 20_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxNestedArchives: 0,
  maxParseTimeMs: 300_000,
  maxUtf8Bytes: 8 * 1024 * 1024,
  maxMediaCount: 20_000,
  maxMediaFileBytes: 64 * 1024 * 1024,
  maxMediaBytes: 448 * 1024 * 1024,
  allowedMediaMimeTypes: Object.freeze([
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/plain",
  ]),
});

const NON_NEGATIVE_LIMIT_KEYS = [
  "maxPackageBytes",
  "maxExpandedBytes",
  "maxArchiveEntries",
  "maxEntryBytes",
  "maxNestedArchives",
  "maxParseTimeMs",
  "maxUtf8Bytes",
  "maxMediaCount",
  "maxMediaFileBytes",
  "maxMediaBytes",
] as const satisfies readonly (keyof ImportLimits)[];

/**
 * Merge caller configuration with defaults and reject malformed values before
 * any bytes are handed to a Worker.
 */
export function normalizeImportLimits(
  input: ImportLimitsInput = {},
): ImportLimits {
  const merged: ImportLimits = {
    ...DEFAULT_IMPORT_LIMITS,
    ...input,
    allowedMediaMimeTypes: input.allowedMediaMimeTypes === undefined
      ? [...DEFAULT_IMPORT_LIMITS.allowedMediaMimeTypes]
      : Array.isArray(input.allowedMediaMimeTypes)
        ? [...input.allowedMediaMimeTypes]
        : input.allowedMediaMimeTypes,
  };

  for (const key of NON_NEGATIVE_LIMIT_KEYS) {
    const value = merged[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Import limit ${key} must be a non-negative safe integer.`);
    }
  }

  if (
    !Number.isFinite(merged.maxCompressionRatio)
    || merged.maxCompressionRatio <= 0
  ) {
    throw new TypeError("Import limit maxCompressionRatio must be positive.");
  }

  if (
    !Array.isArray(merged.allowedMediaMimeTypes)
    || merged.allowedMediaMimeTypes.some(
      (mime) => typeof mime !== "string" || mime.length === 0,
    )
  ) {
    throw new TypeError("Import MIME limits must contain non-empty strings.");
  }

  return Object.freeze({
    ...merged,
    allowedMediaMimeTypes: Object.freeze([...merged.allowedMediaMimeTypes]),
  });
}
