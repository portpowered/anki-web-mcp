import { describe, expect, test } from "bun:test";

import {
  DEFAULT_IMPORT_LIMITS,
  normalizeImportLimits,
  type ImportLimitsInput,
} from "./limits";

describe("production import limit configuration", () => {
  test("returns frozen independent defaults and preserves exact valid boundaries", () => {
    const defaults = normalizeImportLimits();
    const exactZeroes = normalizeImportLimits({
      maxPackageBytes: 0,
      maxExpandedBytes: 0,
      maxArchiveEntries: 0,
      maxEntryBytes: 0,
      maxNestedArchives: 0,
      maxParseTimeMs: 0,
      maxUtf8Bytes: 0,
      maxMediaCount: 0,
      maxMediaFileBytes: 0,
      maxMediaBytes: 0,
      maxCompressionRatio: Number.MIN_VALUE,
      allowedMediaMimeTypes: ["image/png"],
    });

    expect(defaults).toEqual(DEFAULT_IMPORT_LIMITS);
    expect(defaults).not.toBe(DEFAULT_IMPORT_LIMITS);
    expect(defaults.allowedMediaMimeTypes).not.toBe(
      DEFAULT_IMPORT_LIMITS.allowedMediaMimeTypes,
    );
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults.allowedMediaMimeTypes)).toBe(true);
    expect(exactZeroes).toMatchObject({
      maxPackageBytes: 0,
      maxExpandedBytes: 0,
      maxCompressionRatio: Number.MIN_VALUE,
      allowedMediaMimeTypes: ["image/png"],
    });
  });

  test("rejects every non-negative integer limit below and beyond its safe range", () => {
    const integerLimits = [
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
    ] as const;

    for (const key of integerLimits) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
        expect(() => normalizeImportLimits({ [key]: value })).toThrow(
          `Import limit ${key} must be a non-negative safe integer.`,
        );
      }
    }
  });

  test("rejects non-positive compression ratios and malformed MIME allow-lists", () => {
    for (const maxCompressionRatio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeImportLimits({ maxCompressionRatio })).toThrow(
        "Import limit maxCompressionRatio must be positive.",
      );
    }

    const malformedLists: unknown[] = ["image/png", [""], [42], ["image/png", null]];
    for (const allowedMediaMimeTypes of malformedLists) {
      expect(() => normalizeImportLimits({
        allowedMediaMimeTypes,
      } as ImportLimitsInput)).toThrow(
        "Import MIME limits must contain non-empty strings.",
      );
    }
  });
});
