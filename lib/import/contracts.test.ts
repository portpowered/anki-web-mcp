import { describe, expect, test } from "bun:test";

import {
  ImportLifecycle,
  ImportLifecycleTransitionError,
  isLegalImportTransition,
} from "./lifecycle";
import {
  type CommitReadyGraph,
  type ImportWorkerFactory,
  type ImportWorkerHandle,
  type ImportWorkerPort,
} from "./contracts";
import { IMPORT_ERROR_CODES, importError, isImportError } from "./errors";
import { createImportService } from "../application/import-service";
import {
  IMPORT_WORKER_PROTOCOL,
  IMPORT_WORKER_PROTOCOL_VERSION,
  type ImportWorkerMessage,
  type ImportWorkerStartRequest,
} from "./protocol";

interface TestGraph extends CommitReadyGraph {
  readonly marker: string;
  readonly nested?: { readonly values: readonly string[] };
}

class FakeWorkerPort implements ImportWorkerPort<TestGraph> {
  public request: ImportWorkerStartRequest | undefined;
  public observer:
    | { onMessage(message: unknown): void; onError(cause: unknown): void }
    | undefined;
  public cancelled = false;
  public cancelReason: string | undefined;
  public terminated = false;

  public start(
    request: ImportWorkerStartRequest,
    observer: {
      onMessage(message: unknown): void;
      onError(cause: unknown): void;
    },
  ): ImportWorkerHandle {
    this.request = request;
    this.observer = observer;
    return {
      cancel: (reason) => {
        this.cancelled = true;
        this.cancelReason = reason;
      },
      terminate: () => {
        this.terminated = true;
      },
    };
  }

  public emit(message: ImportWorkerMessage<TestGraph>): void {
    this.observer?.onMessage(message);
  }

  public emitUnknown(message: unknown): void {
    this.observer?.onMessage(message);
  }
}

class FakeWorkerFactory implements ImportWorkerFactory<TestGraph> {
  public readonly ports: FakeWorkerPort[] = [];

  public create(): FakeWorkerPort {
    const port = new FakeWorkerPort();
    this.ports.push(port);
    return port;
  }
}

const graph: TestGraph = { marker: "validated" };

describe("import lifecycle contract", () => {
  test("documents and enforces the only legal state transitions", () => {
    expect(isLegalImportTransition("preflight", "validating-archive")).toBe(true);
    expect(isLegalImportTransition("preflight", "committing")).toBe(false);
    expect(isLegalImportTransition("committing", "cancelled")).toBe(false);

    const lifecycle = new ImportLifecycle<TestGraph>("contract-op");
    expect(() => lifecycle.transition("parsing-records")).toThrow(
      ImportLifecycleTransitionError,
    );
    lifecycle.transition("validating-archive");
    expect(lifecycle.state).toBe("validating-archive");
  });

  test("accepts zero, known, and unknown totals while rejecting regressions", () => {
    const lifecycle = new ImportLifecycle<TestGraph>("progress-op");
    expect(lifecycle.recordProgress({
      stage: "preflight",
      completed: 0,
      total: 0,
      stageCompleted: 0,
      stageTotal: 0,
    })).toBe(true);
    expect(lifecycle.recordProgress({
      stage: "validating-archive",
      completed: 0,
      total: null,
      stageCompleted: 0,
      stageTotal: null,
    })).toBe(false);
    expect(lifecycle.recordProgress({
      stage: "preflight",
      completed: 0,
      total: null,
      stageCompleted: 0,
      stageTotal: null,
    })).toBe(true);
    expect(lifecycle.recordProgress({
      stage: "preflight",
      completed: 1,
      total: 0,
      stageCompleted: 0,
      stageTotal: 0,
    })).toBe(false);
    expect(lifecycle.recordProgress({
      stage: "preflight",
      completed: 0,
      total: null,
      stageCompleted: 0,
      stageTotal: null,
    })).toBe(true);
  });

  test("accumulates warnings and emits one terminal event only", () => {
    const lifecycle = new ImportLifecycle<TestGraph>("warning-op");
    const events: string[] = [];
    lifecycle.subscribe((event) => events.push(event.type));
    lifecycle.addWarning({
      code: "UNSUPPORTED_TEMPLATE_FEATURE",
      message: "A supported warning",
      stage: "compiling-content",
    });
    lifecycle.transition("failed");
    const outcome = {
      status: "failed" as const,
      operationId: "warning-op",
      error: importError("UNSUPPORTED_PACKAGE", {
        operationId: "warning-op",
        stage: "failed",
      }),
    };

    expect(lifecycle.emitTerminal(outcome)).toBe(true);
    expect(lifecycle.emitTerminal(outcome)).toBe(false);
    expect(lifecycle.addWarning({
      code: "MISSING_MEDIA",
      message: "Late warning",
      stage: "importing-media",
    })).toBe(false);
    expect(lifecycle.recordProgress({
      stage: "preflight",
      completed: 0,
      total: null,
      stageCompleted: 0,
      stageTotal: null,
    })).toBe(false);
    expect(lifecycle.warnings).toHaveLength(1);
    expect(events.filter((event) => event === "terminal")).toHaveLength(1);
  });
});

describe("application import service contract", () => {
  test("publishes serializable application-owned envelopes for every error code", () => {
    for (const code of IMPORT_ERROR_CODES) {
      const error = importError(code, {
        operationId: "error-contract",
        stage: "preflight",
        detail: "safe context",
      });
      expect(isImportError(error)).toBe(true);
      expect(JSON.parse(JSON.stringify(error))).toEqual(error);
      expect(error.message.length).toBeGreaterThan(0);
    }
    expect(isImportError({
      ...importError("INVALID_PACKAGE"),
      stage: "library-internal-stage",
    })).toBe(false);
  });

  test("keeps every Worker-reported domain failure terminal and non-committing", async () => {
    const serviceOwnedCodes = new Set([
      "INVALID_IMPORT_REQUEST",
      "ARCHIVE_LIMIT_EXCEEDED",
      "INVALID_PACKAGE",
      "DUPLICATE_IMPORT",
      "IMPORT_CANCELLED",
      "IMPORT_TIMEOUT",
      "QUOTA_EXCEEDED",
      "COMMIT_FAILED",
      "REPLACE_FAILED",
    ]);
    const workerReportedCodes = IMPORT_ERROR_CODES.filter(
      (code) => !serviceOwnedCodes.has(code),
    );

    for (const [index, code] of workerReportedCodes.entries()) {
      const operationId = `domain-error-${index}`;
      const factory = new FakeWorkerFactory();
      let commitCalls = 0;
      const service = createImportService<TestGraph>({
        workerFactory: factory,
        hashPackage: async () => index.toString(16).padStart(64, "0"),
        committer: {
          commit: async () => {
            commitCalls += 1;
            return { importId: "unexpected", deckIds: [] };
          },
        },
      });
      const operation = service.start({
        operationId,
        packageBytes: new Uint8Array([index + 1]),
      });
      const terminalStatuses: string[] = [];
      operation.subscribe((event) => {
        if (event.type === "terminal") terminalStatuses.push(event.outcome.status);
      });
      const port = await waitForPort(factory, 0);
      emitWorkerStages(port, operationId);
      port.emit({
        protocol: IMPORT_WORKER_PROTOCOL,
        version: IMPORT_WORKER_PROTOCOL_VERSION,
        type: "terminal",
        operationId,
        status: "failed",
        commitReady: false,
        error: importError(code, {
          operationId,
          stage: "importing-media",
          detail: "bounded fault injection",
        }),
      });
      port.emit(successMessage(operationId));

      await expect(operation.result).resolves.toMatchObject({
        status: "failed",
        error: { code },
      });
      expect(operation.state).toBe("failed");
      expect(terminalStatuses).toEqual(["failed"]);
      expect(commitCalls).toBe(0);
      expect(port.terminated).toBe(true);
    }
  });

  test("defaults duplicate policy to cancel and commits warning-bearing success", async () => {
    const factory = new FakeWorkerFactory();
    const committed: Array<{ policy: string; warnings: number }> = [];
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async () => "A".repeat(64),
      committer: {
        commit: async (input) => {
          committed.push({
            policy: input.duplicatePolicy,
            warnings: input.warnings.length,
          });
          return { importId: "import-1", deckIds: ["deck-1"] };
        },
      },
    });

    const operation = service.start({
      operationId: "default-policy",
      packageBytes: new Uint8Array([1, 2, 3]),
    });
    const events: Array<{ type: string; completed?: number }> = [];
    operation.subscribe((event) => events.push({
      type: event.type,
      ...("completed" in event ? { completed: event.completed } : {}),
    }));
    const port = await waitForPort(factory, 0);
    expect(port.request?.protocol).toBe(IMPORT_WORKER_PROTOCOL);
    expect(port.request?.version).toBe(IMPORT_WORKER_PROTOCOL_VERSION);
    expect(port.request?.duplicatePolicy).toBe("cancel");

    emitWorkerStages(port, "default-policy");
    port.emit({
      protocol: IMPORT_WORKER_PROTOCOL,
      version: IMPORT_WORKER_PROTOCOL_VERSION,
      type: "warning",
      operationId: "default-policy",
      warning: {
        code: "UNSUPPORTED_TEMPLATE_FEATURE",
        message: "The unsupported filter was ignored.",
        stage: "compiling-content",
      },
    });
    port.emit({
      protocol: IMPORT_WORKER_PROTOCOL,
      version: IMPORT_WORKER_PROTOCOL_VERSION,
      type: "terminal",
      operationId: "default-policy",
      status: "success",
      commitReady: true,
      graph,
      warnings: [],
    });

    const result = await operation.result;
    expect(result.status).toBe("success-with-warnings");
    if (result.status === "success-with-warnings") {
      expect(result.warnings).toHaveLength(1);
      expect(result.commit.deckIds).toEqual(["deck-1"]);
    }
    expect(committed).toEqual([{ policy: "cancel", warnings: 1 }]);
    expect(events.map((event) => event.completed).filter(
      (completed): completed is number => completed !== undefined,
    )).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("cancels a known checksum before starting the Worker and permits explicit replacement", async () => {
    const factory = new FakeWorkerFactory();
    const checksum = "9".repeat(64);
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async () => checksum,
      committer: {
        findExisting: async () => ({ importId: checksum, packageSha256: checksum }),
        commit: async () => ({ importId: checksum, deckIds: ["replacement"] }),
      },
    });

    const duplicate = service.start({
      operationId: "known-duplicate",
      packageBytes: new Uint8Array([1]),
    });
    await expect(duplicate.result).resolves.toMatchObject({
      status: "failed",
      error: { code: "DUPLICATE_IMPORT", stage: "preflight" },
    });
    expect(factory.ports).toHaveLength(0);

    const replacement = service.start({
      operationId: "explicit-replacement",
      packageBytes: new Uint8Array([1]),
      duplicatePolicy: "replace",
      replacementImportId: checksum,
    });
    const port = await waitForPort(factory, 0);
    emitWorkerStages(port, "explicit-replacement");
    port.emit(successMessage("explicit-replacement"));
    await expect(replacement.result).resolves.toMatchObject({
      status: "success",
      commit: { importId: checksum, deckIds: ["replacement"] },
    });
  });

  test("passes an explicit prior import target when changed package bytes replace a graph", async () => {
    const factory = new FakeWorkerFactory();
    const originalChecksum = "a".repeat(64);
    const replacementChecksum = "b".repeat(64);
    const commits: Array<{
      checksum: string;
      replacementImportId?: string;
      marker: string;
    }> = [];
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async (bytes) => bytes[0] === 1
        ? originalChecksum
        : replacementChecksum,
      committer: {
        commit: async (input) => {
          commits.push({
            checksum: input.packageSha256,
            replacementImportId: input.replacementImportId,
            marker: input.graph.marker,
          });
          return { importId: input.packageSha256, deckIds: [input.graph.marker] };
        },
      },
    });

    const original = service.start({
      operationId: "original-package",
      packageBytes: new Uint8Array([1]),
    });
    const originalPort = await waitForPort(factory, 0);
    emitWorkerStages(originalPort, "original-package");
    originalPort.emit(successMessage("original-package", { marker: "original" }));
    await expect(original.result).resolves.toMatchObject({ status: "success" });

    const replacement = service.start({
      operationId: "changed-package",
      packageBytes: new Uint8Array([2]),
      duplicatePolicy: "replace",
      replacementImportId: originalChecksum,
    });
    const replacementPort = await waitForPort(factory, 1);
    emitWorkerStages(replacementPort, "changed-package");
    replacementPort.emit(successMessage("changed-package", { marker: "replacement" }));
    await expect(replacement.result).resolves.toMatchObject({
      status: "success",
      packageSha256: replacementChecksum,
      commit: { importId: replacementChecksum, deckIds: ["replacement"] },
    });
    expect(commits).toEqual([
      {
        checksum: originalChecksum,
        replacementImportId: undefined,
        marker: "original",
      },
      {
        checksum: replacementChecksum,
        replacementImportId: originalChecksum,
        marker: "replacement",
      },
    ]);
  });

  test("rejects replacement requests without exactly one explicit prior import target", async () => {
    const factory = new FakeWorkerFactory();
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async () => "a".repeat(64),
      committer: {
        commit: async () => ({ importId: "unused", deckIds: [] }),
      },
    });

    await expect(service.start({
      operationId: "missing-replacement-target",
      packageBytes: new Uint8Array([1]),
      duplicatePolicy: "replace",
    }).result).resolves.toMatchObject({
      status: "failed",
      error: { code: "INVALID_IMPORT_REQUEST" },
    });
    await expect(service.start({
      operationId: "target-with-cancel-policy",
      packageBytes: new Uint8Array([1]),
      replacementImportId: "a".repeat(64),
    }).result).resolves.toMatchObject({
      status: "failed",
      error: { code: "INVALID_IMPORT_REQUEST" },
    });
    expect(factory.ports).toHaveLength(0);
  });

  test("returns a stable representative failure and lets callers branch on it", async () => {
    const factory = new FakeWorkerFactory();
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async () => "b".repeat(64),
      committer: {
        commit: async () => ({ importId: "unused", deckIds: [] }),
      },
    });
    const operation = service.start({
      operationId: "unsupported-package",
      packageBytes: new Uint8Array([9]),
    });
    const port = await waitForPort(factory, 0);
    port.emit({
      protocol: IMPORT_WORKER_PROTOCOL,
      version: IMPORT_WORKER_PROTOCOL_VERSION,
      type: "terminal",
      operationId: "unsupported-package",
      status: "failed",
      commitReady: false,
      error: importError("UNSUPPORTED_PACKAGE", {
        operationId: "unsupported-package",
        stage: "validating-archive",
      }),
    });

    const result = await operation.result;
    if (result.status !== "failed") {
      throw new Error("Expected a failed import result");
    }
    expect(result.error.code).toBe("UNSUPPORTED_PACKAGE");
    expect(result.error.message).not.toContain("Error");
    expect(operation.state).toBe("failed");
  });

  test("cancellation settles once and makes late Worker success ineligible", async () => {
    const factory = new FakeWorkerFactory();
    let commitCalls = 0;
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async () => "c".repeat(64),
      committer: {
        commit: async () => {
          commitCalls += 1;
          return { importId: "never", deckIds: [] };
        },
      },
    });
    const operation = service.start({
      operationId: "cancelled-operation",
      packageBytes: new Uint8Array([4]),
    });
    const port = await waitForPort(factory, 0);
    const terminalEvents: string[] = [];
    operation.subscribe((event) => {
      if (event.type === "terminal") terminalEvents.push(event.outcome.status);
    });

    expect(operation.cancel()).toBe(true);
    emitWorkerStages(port, "cancelled-operation");
    const result = await operation.result;
    expect(result.status).toBe("cancelled");
    expect(operation.cancel()).toBe(false);
    expect(port.cancelled).toBe(true);
    expect(port.terminated).toBe(true);
    expect(commitCalls).toBe(0);
    expect(terminalEvents).toEqual(["cancelled"]);
  });

  test("rejects operation ID reuse without aliasing or replacing the active operation", async () => {
    const factory = new FakeWorkerFactory();
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async () => "d".repeat(64),
      committer: {
        commit: async () => ({ importId: "original", deckIds: ["deck-original"] }),
      },
    });
    const original = service.start({
      operationId: "unique-operation",
      packageBytes: new Uint8Array([1]),
    });
    const port = await waitForPort(factory, 0);
    const duplicate = service.start({
      operationId: "unique-operation",
      packageBytes: new Uint8Array([2]),
    });

    const duplicateResult = await duplicate.result;
    expect(duplicateResult.status).toBe("failed");
    if (duplicateResult.status === "failed") {
      expect(duplicateResult.error.code).toBe("INVALID_IMPORT_REQUEST");
    }
    expect(duplicate).not.toBe(original);
    expect(service.get("unique-operation")).toBe(original);
    expect(factory.ports).toHaveLength(1);

    emitWorkerStages(port, "unique-operation");
    port.emit(successMessage("unique-operation"));
    expect((await original.result).status).toBe("success");
  });

  test("supersedes an active operation and ignores its late Worker result", async () => {
    const factory = new FakeWorkerFactory();
    const committedOperations: string[] = [];
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async (bytes) => bytes[0] === 1 ? "e".repeat(64) : "f".repeat(64),
      committer: {
        commit: async (input) => {
          committedOperations.push(input.operationId);
          return { importId: input.operationId, deckIds: [input.operationId] };
        },
      },
    });
    const oldOperation = service.start({
      operationId: "old-operation",
      packageBytes: new Uint8Array([1]),
    });
    const oldPort = await waitForPort(factory, 0);
    const newOperation = service.supersede("old-operation", {
      operationId: "new-operation",
      packageBytes: new Uint8Array([2]),
      duplicatePolicy: "replace",
      replacementImportId: "e".repeat(64),
    });
    const newPort = await waitForPort(factory, 1);

    expect((await oldOperation.result).status).toBe("cancelled");
    expect(oldPort.cancelled).toBe(true);
    oldPort.emit(successMessage("old-operation"));
    emitWorkerStages(newPort, "new-operation");
    newPort.emit(successMessage("new-operation"));

    expect((await newOperation.result).status).toBe("success");
    expect(newPort.request?.duplicatePolicy).toBe("replace");
    expect(committedOperations).toEqual(["new-operation"]);
  });

  test("fails malformed active-operation Worker messages without exposing payload details", async () => {
    const factory = new FakeWorkerFactory();
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async () => "1".repeat(64),
      committer: {
        commit: async () => ({ importId: "unused", deckIds: [] }),
      },
    });
    const operation = service.start({
      operationId: "malformed-message",
      packageBytes: new Uint8Array([1]),
    });
    const port = await waitForPort(factory, 0);
    port.emitUnknown({
      operationId: "malformed-message",
      type: "terminal",
      libraryStack: "must not escape",
    });

    const result = await operation.result;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("WORKER_FAILED");
      expect(JSON.stringify(result.error)).not.toContain("libraryStack");
    }
  });

  test("times out a hung Worker with a stable failure and terminates it", async () => {
    const factory = new FakeWorkerFactory();
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async () => "2".repeat(64),
      committer: {
        commit: async () => ({ importId: "unused", deckIds: [] }),
      },
    });
    const operation = service.start({
      operationId: "hung-worker",
      packageBytes: new Uint8Array([1]),
      limits: { maxParseTimeMs: 5 },
    });
    const port = await waitForPort(factory, 0);

    const result = await operation.result;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("IMPORT_TIMEOUT");
    }
    expect(port.cancelReason).toBe("timeout");
    expect(port.terminated).toBe(true);
  });

  test("protects the commit graph and ignores messages after Worker success", async () => {
    const factory = new FakeWorkerFactory();
    let finishCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const workerGraph: TestGraph = {
      marker: "validated",
      nested: { values: ["safe"] },
    };
    let committedGraph: TestGraph | undefined;
    const service = createImportService<TestGraph>({
      workerFactory: factory,
      hashPackage: async () => "3".repeat(64),
      committer: {
        commit: async (input) => {
          committedGraph = input.graph;
          await commitGate;
          return { importId: "protected", deckIds: [] };
        },
      },
    });
    const operation = service.start({
      operationId: "protected-graph",
      packageBytes: new Uint8Array([1]),
    });
    const port = await waitForPort(factory, 0);
    emitWorkerStages(port, "protected-graph");
    port.emit({
      protocol: IMPORT_WORKER_PROTOCOL,
      version: IMPORT_WORKER_PROTOCOL_VERSION,
      type: "terminal",
      operationId: "protected-graph",
      status: "success",
      commitReady: true,
      graph: workerGraph,
      warnings: [],
    });
    await Promise.resolve();

    expect(operation.state).toBe("committing");
    expect(port.terminated).toBe(true);
    expect(committedGraph).not.toBe(workerGraph);
    expect(Object.isFrozen(committedGraph)).toBe(true);
    expect(Object.isFrozen(committedGraph?.nested)).toBe(true);
    expect(Object.isFrozen(committedGraph?.nested?.values)).toBe(true);

    port.emitUnknown({ operationId: "protected-graph", type: "corrupt-late-message" });
    port.observer?.onError(new Error("late Worker crash"));
    expect(operation.state).toBe("committing");
    finishCommit();
    expect((await operation.result).status).toBe("success");
  });
});

async function waitForPort(
  factory: FakeWorkerFactory,
  index: number,
): Promise<FakeWorkerPort> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = factory.ports[index];
    if (port) return port;
    await Promise.resolve();
  }
  throw new Error("The fake Worker was not started");
}

function emitWorkerStages(port: FakeWorkerPort, operationId: string): void {
  const stages = [
    "validating-archive",
    "decompressing-collection",
    "parsing-records",
    "compiling-content",
    "importing-media",
  ] as const;
  stages.forEach((stage, index) => {
    port.emit({
      protocol: IMPORT_WORKER_PROTOCOL,
      version: IMPORT_WORKER_PROTOCOL_VERSION,
      type: "progress",
      operationId,
      stage,
      completed: index + 1,
      total: stages.length,
      stageCompleted: 1,
      stageTotal: 1,
    });
  });
}

function successMessage(
  operationId: string,
  resultGraph: TestGraph = graph,
): ImportWorkerMessage<TestGraph> {
  return {
    protocol: IMPORT_WORKER_PROTOCOL,
    version: IMPORT_WORKER_PROTOCOL_VERSION,
    type: "terminal",
    operationId,
    status: "success",
    commitReady: true,
    graph: resultGraph,
    warnings: [],
  };
}
