import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";

import { normalizeImportLimits } from "../limits";
import type { ImportErrorCode } from "../errors";
import {
  IMPORT_WORKER_PROTOCOL,
  IMPORT_WORKER_PROTOCOL_VERSION,
  type ImportWorkerMessage,
  type ImportWorkerStartRequest,
} from "../protocol";
import {
  ArchiveValidationFailure,
  validateArchive,
} from "./archive";
import { ImportWorkerRuntime } from "./runtime";

const encoder = new TextEncoder();
const fixtureRoot = join(
  process.cwd(),
  "spikes",
  "apkg-compatibility",
  "fixtures",
  "synthetic",
);

describe("production Worker archive validation", () => {
  test("accepts each byte/count/ratio boundary and rejects boundary plus one", async () => {
    const bytes = packageZip({
      "collection.anki2": encoder.encode("a".repeat(2048)),
      media: encoder.encode("{}"),
    });
    const metadata = centralMetadata(bytes);
    const expanded = metadata.reduce((total, member) => total + member.expandedBytes, 0);
    const largest = Math.max(...metadata.map((member) => member.expandedBytes));
    const ratio = Math.max(...metadata.map((member) =>
      member.compressedBytes === 0 ? 1 : member.expandedBytes / member.compressedBytes
    ));
    const exact = normalizeImportLimits({
      maxPackageBytes: bytes.byteLength,
      maxArchiveEntries: metadata.length,
      maxExpandedBytes: expanded,
      maxEntryBytes: largest,
      maxCompressionRatio: ratio,
    });

    const archive = await validateArchive(bytes, exact, control("exact"));
    expect(archive.expandedBytes).toBe(expanded);
    expect(archive.members.map((member) => member.path)).toEqual([
      "collection.anki2",
      "media",
    ]);

    await expectFailure(bytes, { ...exact, maxPackageBytes: bytes.byteLength - 1 }, "ARCHIVE_LIMIT_EXCEEDED", "maxPackageBytes");
    await expectFailure(bytes, { ...exact, maxArchiveEntries: metadata.length - 1 }, "ARCHIVE_LIMIT_EXCEEDED", "maxArchiveEntries");
    await expectFailure(bytes, { ...exact, maxExpandedBytes: expanded - 1 }, "ARCHIVE_LIMIT_EXCEEDED", "maxExpandedBytes");
    await expectFailure(bytes, { ...exact, maxEntryBytes: largest - 1 }, "ARCHIVE_LIMIT_EXCEEDED", "maxEntryBytes");
    await expectFailure(bytes, { ...exact, maxCompressionRatio: ratio - 0.0001 }, "ARCHIVE_LIMIT_EXCEEDED", "maxCompressionRatio");
  });

  test("rejects unsafe, colliding, and out-of-namespace paths", async () => {
    for (const fixture of [
      "absolute-archive-path.apkg",
      "traversal-archive-path.apkg",
      "duplicate-normalized-archive-path.apkg",
    ]) {
      const bytes = new Uint8Array(await readFile(join(fixtureRoot, fixture)));
      await expectFailure(bytes, {}, "ARCHIVE_PATH_UNSAFE");
    }

    await expectFailure(
      packageZip({ "collection.anki2": encoder.encode("db"), "other.txt": encoder.encode("x") }),
      {},
      "ARCHIVE_PATH_UNSAFE",
      "outside-apkg-namespace",
    );
    await expectFailure(
      packageZip({ "Collection.anki2": encoder.encode("db"), "collection.anki2": encoder.encode("db") }),
      {},
      "ARCHIVE_PATH_UNSAFE",
      "duplicate-normalized-path",
    );
  });

  test("rejects malformed UTF-8 names before extraction", async () => {
    const bytes = packageZip({ "collection.anki2": encoder.encode("db") });
    const malformed = bytes.slice();
    const view = new DataView(malformed.buffer);
    const centralOffset = findSignature(malformed, 0x02014b50);
    const localOffset = view.getUint32(centralOffset + 42, true);
    view.setUint16(centralOffset + 8, view.getUint16(centralOffset + 8, true) | 0x0800, true);
    view.setUint16(localOffset + 6, view.getUint16(localOffset + 6, true) | 0x0800, true);
    malformed[centralOffset + 46] = 0xff;
    malformed[localOffset + 30] = 0xff;

    await expectFailure(malformed, {}, "ARCHIVE_PATH_UNSAFE", "malformed-utf8-path");
  });

  test("rejects missing and ambiguous required collection members", async () => {
    await expectFailure(packageZip({ media: encoder.encode("{}") }), {}, "ARCHIVE_INVALID", "missing-required-collection");
    await expectFailure(packageZip({
      "collection.anki21": encoder.encode("db"),
      "collection.anki21b": encoder.encode("db"),
      media: encoder.encode("{}"),
      meta: encoder.encode("meta"),
    }), {}, "ARCHIVE_INVALID", "ambiguous-required-collection");
  });

  test("bounds nested archives without recursively opening them", async () => {
    const inner = packageZip({ "collection.anki2": encoder.encode("inner") });
    const outer = packageZip({ "collection.anki2": inner, media: encoder.encode("{}") });
    await expectFailure(outer, { maxNestedArchives: 0 }, "ARCHIVE_LIMIT_EXCEEDED", "maxNestedArchives");

    const accepted = await validateArchive(
      outer,
      normalizeImportLimits({ maxNestedArchives: 1 }),
      control("nested-boundary"),
    );
    expect(accepted.nestedArchiveCount).toBe(1);
    expect(accepted.members[0]?.bytes).toEqual(inner);
  });

  test("rejects ZIP signature, structure, decompression, and CRC corruption", async () => {
    await expectFailure(encoder.encode("not a zip"), {}, "ARCHIVE_INVALID");

    const bytes = packageZip({ "collection.anki2": encoder.encode("database bytes") });
    const badStructure = bytes.slice(0, bytes.byteLength - 1);
    await expectFailure(badStructure, {}, "ARCHIVE_INVALID");

    const badCrc = bytes.slice();
    const centralOffset = findSignature(badCrc, 0x02014b50);
    new DataView(badCrc.buffer).setUint32(centralOffset + 16, 0, true);
    await expectFailure(badCrc, {}, "ARCHIVE_INVALID", "member-crc");

    const badPayload = bytes.slice();
    const view = new DataView(badPayload.buffer);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const nameBytes = view.getUint16(localOffset + 26, true);
    const extraBytes = view.getUint16(localOffset + 28, true);
    badPayload[localOffset + 30 + nameBytes + extraBytes] ^= 0xff;
    await expectFailure(badPayload, {}, "ARCHIVE_INVALID");
  });

  test("checks cancellation and parse time before returning archive state", async () => {
    const bytes = packageZip({ "collection.anki2": encoder.encode("db") });
    await expectFailure(bytes, {}, "IMPORT_CANCELLED", undefined, {
      isCancelled: () => true,
    });

    let tick = 0;
    await expectFailure(bytes, { maxParseTimeMs: 1 }, "IMPORT_TIMEOUT", "maxParseTimeMs", {
      now: () => tick++,
      startedAt: 0,
    });
  });

  test("Worker runtime emits one stable non-commit terminal for invalid input", async () => {
    const messages: ImportWorkerMessage[] = [];
    const runtime = new ImportWorkerRuntime({ postMessage: (message) => messages.push(message) });
    const request = startRequest("runtime-invalid", encoder.encode("not zip").buffer);
    runtime.receive(request);
    runtime.receive(request);
    await waitForTerminal(messages);

    const terminals = messages.filter((message) => message.type === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      status: "failed",
      commitReady: false,
      error: { code: "ARCHIVE_INVALID", stage: "validating-archive" },
    });
    expect("graph" in (terminals[0] ?? {})).toBe(false);
  });

  test("Worker runtime does not mark an archive commit-ready before normalization", async () => {
    const messages: ImportWorkerMessage[] = [];
    const runtime = new ImportWorkerRuntime({ postMessage: (message) => messages.push(message) });
    runtime.receive(startRequest(
      "runtime-valid",
      toArrayBuffer(packageZip({ "collection.anki2": encoder.encode("db") })),
    ));
    await waitForTerminal(messages);

    expect(messages.filter((message) => message.type === "progress")).toEqual([
      expect.objectContaining({ stage: "validating-archive", completed: 0, total: 1 }),
      expect.objectContaining({ stage: "validating-archive", completed: 1, total: 1 }),
    ]);
    expect(messages.at(-1)).toMatchObject({
      type: "terminal",
      status: "failed",
      commitReady: false,
      error: { code: "UNSUPPORTED_PACKAGE", stage: "decompressing-collection" },
    });
  });
});

function packageZip(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries, { level: 6, mtime: new Date(1980, 0, 1) });
}

function control(operationId: string) {
  return { operationId };
}

async function expectFailure(
  bytes: Uint8Array,
  limitOverrides: Parameters<typeof normalizeImportLimits>[0],
  code: ImportErrorCode,
  detail?: string,
  controlOverrides: Partial<Parameters<typeof validateArchive>[2]> = {},
): Promise<void> {
  try {
    await validateArchive(bytes, normalizeImportLimits(limitOverrides), {
      operationId: `failure-${code}`,
      ...controlOverrides,
    });
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveValidationFailure);
    const failure = error as ArchiveValidationFailure;
    expect(failure.error.code).toBe(code);
    expect(failure.error.operationId).toBe(`failure-${code}`);
    expect(failure.error.stage).toBe("validating-archive");
    if (detail) {
      expect(failure.error.detail).toContain(detail);
    }
  }
}

function centralMetadata(bytes: Uint8Array): Array<{ compressedBytes: number; expandedBytes: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findSignature(bytes, 0x06054b50, true);
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push({
      compressedBytes: view.getUint32(cursor + 20, true),
      expandedBytes: view.getUint32(cursor + 24, true),
    });
    cursor += 46
      + view.getUint16(cursor + 28, true)
      + view.getUint16(cursor + 30, true)
      + view.getUint16(cursor + 32, true);
  }
  return result;
}

function findSignature(bytes: Uint8Array, signature: number, fromEnd = false): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fromEnd) {
    for (let offset = bytes.byteLength - 4; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === signature) return offset;
    }
  } else {
    for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
      if (view.getUint32(offset, true) === signature) return offset;
    }
  }
  throw new Error("ZIP signature not found");
}

function startRequest(operationId: string, packageBytes: ArrayBuffer): ImportWorkerStartRequest {
  return {
    protocol: IMPORT_WORKER_PROTOCOL,
    version: IMPORT_WORKER_PROTOCOL_VERSION,
    type: "start",
    operationId,
    fileName: "test.apkg",
    packageBytes,
    packageSha256: "a".repeat(64),
    limits: normalizeImportLimits(),
    duplicatePolicy: "cancel",
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function waitForTerminal(messages: readonly ImportWorkerMessage[]): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (messages.some((message) => message.type === "terminal")) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Worker runtime did not produce a terminal message");
}
