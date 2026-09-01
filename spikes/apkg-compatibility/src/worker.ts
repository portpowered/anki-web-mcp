import { zipSync, unzipSync } from "fflate";
import { decompress as decompressZstd } from "fzstd";
import * as protobuf from "protobufjs/minimal";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import filterXSS, { safeAttrValue as defaultSafeAttrValue } from "xss";
import {
  STACK_STAGES,
  type ErrorMessage,
  type EvaluateRequest,
  type ProgressMessage,
  type SanitizerObservation,
  type StackObservations,
  type StackStage,
  type TerminalMessage,
  type WorkerMessage,
} from "./protocol";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const cancelledOperations = new Set<string>();
const activeOperations = new Set<string>();
let sqliteModulePromise: ReturnType<typeof sqlite3InitModule> | undefined;

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data as { type?: string; operationId?: unknown };

  if (request.type === "cancel" && typeof request.operationId === "string") {
    if (activeOperations.has(request.operationId)) {
      cancelledOperations.add(request.operationId);
    }
    return;
  }

  if (request.type === "evaluate" && typeof request.operationId === "string") {
    if (activeOperations.has(request.operationId)) {
      return;
    }

    activeOperations.add(request.operationId);
    void evaluate(request as EvaluateRequest);
  }
});

async function evaluate(request: EvaluateRequest): Promise<void> {
  const startedAt = performance.now();
  const checkpointDelayMs = Math.max(
    0,
    Math.min(100, request.checkpointDelayMs ?? 0),
  );
  const observations: Partial<StackObservations> = {};
  let currentStage: StackStage = STACK_STAGES[0];
  let terminalSent = false;

  const sendTerminal = (message: TerminalMessage): void => {
    if (terminalSent) {
      return;
    }
    terminalSent = true;
    workerScope.postMessage(message satisfies WorkerMessage);
  };

  try {
    for (const [index, stage] of STACK_STAGES.entries()) {
      currentStage = stage;
      await checkpoint(request.operationId, stage, checkpointDelayMs);
      sendProgress({
        kind: "progress",
        operationId: request.operationId,
        stage,
        completed: index,
        total: STACK_STAGES.length,
      });
      await checkpoint(
        request.operationId,
        stage,
        stage === request.pauseAfterProgressStage
          ? Math.max(0, Math.min(2_000, request.pauseAfterProgressMs ?? 0))
          : checkpointDelayMs,
      );

      Object.assign(observations, { [stage]: await runStage(stage) });
    }

    await checkpoint(request.operationId, currentStage, checkpointDelayMs);
    if (!hasAllObservations(observations)) {
      throw new Error("Stack evaluation did not produce every observation");
    }
    sendTerminal({
      kind: "terminal",
      operationId: request.operationId,
      status: "success",
      commitReady: true,
      stagedResult: observations,
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
        stage: error.stage,
        cancellation: "cooperative-checkpoint",
      });
    } else {
      const diagnostic: ErrorMessage = {
        kind: "terminal",
        operationId: request.operationId,
        status: "error",
        commitReady: false,
        stagedResult: null,
        diagnostic: {
          code: "STACK_OPERATION_FAILED",
          stage: currentStage,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 160)
              : "Unknown stack operation failure",
        },
      };
      sendTerminal(diagnostic);
    }
  } finally {
    activeOperations.delete(request.operationId);
    cancelledOperations.delete(request.operationId);
  }
}

function sendProgress(message: ProgressMessage): void {
  if (!cancelledOperations.has(message.operationId)) {
    workerScope.postMessage(message satisfies WorkerMessage);
  }
}

async function checkpoint(
  operationId: string,
  stage: StackStage,
  delayMs: number,
): Promise<void> {
  throwIfCancelled(operationId, stage);
  // A task boundary lets a cancel message reach the Worker between library
  // calls. The selected libraries are synchronous once entered, so the
  // boundary is intentionally explicit and observable.
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  throwIfCancelled(operationId, stage);
}

function throwIfCancelled(operationId: string, stage: StackStage): void {
  if (cancelledOperations.has(operationId)) {
    throw new CooperativeCancellation(stage);
  }
}

async function runStage(
  stage: StackStage,
): Promise<StackObservations[StackStage]> {
  switch (stage) {
    case "zip":
      return runZipProbe();
    case "sqlite":
      return runSqliteProbe();
    case "zstd":
      return runZstdProbe();
    case "protobuf":
      return runProtobufProbe();
    case "sanitizer":
      return runSanitizerProbe();
  }
}

async function runZipProbe(): Promise<StackObservations["zip"]> {
  const collectionPayload = "browser Worker ZIP probe";
  const collectionBytes = textEncoder.encode(collectionPayload);
  const archive = zipSync(
    {
      "collection.anki2": collectionBytes,
      "media": textEncoder.encode("{}"),
    },
    // fflate reads the DOS timestamp through local Date fields. Constructing
    // the earliest valid local calendar date avoids a UTC-to-1979 rollover.
    { level: 6, mtime: new Date(1980, 0, 1) },
  );
  const entries = Object.keys(unzipSync(archive)).sort();
  const extracted = unzipSync(archive)["collection.anki2"];

  if (!extracted || textDecoder.decode(extracted) !== collectionPayload) {
    throw new Error("ZIP round trip did not preserve the probe payload");
  }

  return {
    archiveBytes: archive.byteLength,
    entries,
    collectionPayload,
    collectionSha256: await sha256(extracted),
  };
}

async function runSqliteProbe(): Promise<StackObservations["sqlite"]> {
  sqliteModulePromise ??= sqlite3InitModule();
  const sqlite3 = await sqliteModulePromise;
  const database = new sqlite3.oo1.DB(":memory:", "c");

  try {
    database.exec(
      "CREATE TABLE stack_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
    );
    database.exec(
      "INSERT INTO stack_probe (id, value) VALUES (1, 'legacy'), (2, 'current');",
    );
    const rows = database.exec({
      sql: "SELECT id, value FROM stack_probe ORDER BY id;",
      rowMode: "object",
      returnValue: "resultRows",
    });

    return {
      libraryVersion: sqlite3.version.libVersion,
      rows: rows.map((row) => ({
        id: Number(row.id),
        value: String(row.value),
      })),
    };
  } finally {
    database.close();
  }
}

function runZstdProbe(): StackObservations["zstd"] {
  const text = "browser zstd probe";
  const payload = textEncoder.encode(text);
  const compressed = makeRawZstdFrame(payload);
  const decompressed = decompressZstd(compressed);

  if (textDecoder.decode(decompressed) !== text) {
    throw new Error("Zstandard round trip did not preserve the probe payload");
  }

  return {
    compressedBytes: compressed.byteLength,
    decompressedBytes: decompressed.byteLength,
    text,
  };
}

function makeRawZstdFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > 255) {
    throw new Error("The fixed zstd probe payload is too large");
  }

  const frame = new Uint8Array(9 + payload.byteLength);
  frame.set([0x28, 0xb5, 0x2f, 0xfd, 0x20, payload.byteLength], 0);
  // A single last raw block: type=raw (00), last=1, size in bits 3..23.
  frame[6] = (payload.byteLength << 3) | 1;
  frame.set(payload, 9);
  return frame;
}

function runProtobufProbe(): StackObservations["protobuf"] {
  const encoded = protobuf.Writer.create()
    .uint32(10)
    .string("current-media-map")
    .uint32(16)
    .uint32(7)
    .finish();
  const reader = protobuf.Reader.create(encoded);
  let name = "";
  let ordinal = 0;

  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        name = reader.string();
        break;
      case 2:
        ordinal = reader.uint32();
        break;
      default:
        reader.skipType(tag & 7);
        break;
    }
  }

  if (name !== "current-media-map" || ordinal !== 7) {
    throw new Error("Protobuf round trip did not preserve the probe message");
  }

  return {
    encodedBytes: encoded.byteLength,
    decoded: { name, ordinal },
  };
}

function runSanitizerProbe(): SanitizerObservation {
  const dirty =
    '<p>café <strong>safe</strong></p><img src="media://0" alt="áudio">' +
    '<script>alert(1)</script><form action="https://evil.invalid">' +
    '<input onfocus="steal()"></form><iframe src="https://evil.invalid"></iframe>' +
    '<a href="https://evil.invalid">leave package</a>';
  const output = filterXSS(dirty, {
    allowList: {
      br: [],
      em: [],
      img: ["alt", "src"],
      p: [],
      strong: [],
    },
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["form", "iframe", "script"],
    safeAttrValue: (tag, name, value, cssFilter) => {
      if (name === "src" && tag === "img" && value.startsWith("media://")) {
        return value;
      }
      return defaultSafeAttrValue(tag, name, value, cssFilter);
    },
  });
  const removedUnsafeContent =
    !output.includes("<script") &&
    !output.includes("onfocus") &&
    !output.includes("<form") &&
    !output.includes("<iframe") &&
    !output.includes("evil.invalid");
  const retainsPackageMedia = output.includes('src="media://0"');

  if (!removedUnsafeContent || !retainsPackageMedia) {
    throw new Error("Sanitizer did not enforce the Worker probe policy");
  }

  return {
    inputBytes: textEncoder.encode(dirty).byteLength,
    output,
    removedUnsafeContent,
    retainsPackageMedia,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

class CooperativeCancellation extends Error {
  public constructor(public readonly stage: StackStage) {
    super("Evaluation cancelled at cooperative checkpoint");
    this.name = "CooperativeCancellation";
  }
}

function hasAllObservations(
  observations: Partial<StackObservations>,
): observations is StackObservations {
  return Boolean(
    observations.zip &&
      observations.sqlite &&
      observations.zstd &&
      observations.protobuf &&
      observations.sanitizer,
  );
}
