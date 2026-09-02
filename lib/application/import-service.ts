import {
  ImportLifecycle,
  isTerminalImportState,
} from "../import/lifecycle";
import {
  type CommitReadyGraph,
  type ImportCommitInput,
  type ImportEvent,
  type ImportOperation,
  type ImportOutcome,
  type ImportRequest,
  type ImportService,
  type ImportServiceDependencies,
  type ImportState,
  type ImportWarning,
  type ImportWorkerStage,
  type ImportWorkerObserver,
  IMPORT_WORKER_STAGES,
} from "../import/contracts";
import {
  errorForCancellation,
  importError,
  isImportError,
  mapImportFailure,
  normalizeImportError,
  type ImportCancellationReason,
  type ImportError,
} from "../import/errors";
import {
  DEFAULT_IMPORT_LIMITS,
  normalizeImportLimits,
  type ImportLimits,
} from "../import/limits";
import {
  isImportWorkerMessage,
  type ImportWorkerMessage,
  type ImportWorkerStartRequest,
} from "../import/protocol";

const DEFAULT_FILE_NAME = "import.apkg";
const OPERATION_ID_MAX_LENGTH = 128;
const FILE_NAME_MAX_LENGTH = 255;

type NormalizedImportRequest = Omit<ImportRequest, "fileName" | "limits" | "duplicatePolicy"> & {
  readonly fileName: string;
  readonly limits: ImportLimits;
  readonly duplicatePolicy: "cancel" | "replace";
};

interface ImportOperationInternal<Graph extends CommitReadyGraph>
  extends ImportOperation<Graph> {
  cancel(reason?: ImportCancellationReason): boolean;
}

/** Create the application-owned import service once application adapters exist. */
export function createImportService<Graph extends CommitReadyGraph = CommitReadyGraph>(
  dependencies: ImportServiceDependencies<Graph>,
): ImportService<Graph> {
  return new ApplicationImportService(dependencies);
}

export class ApplicationImportService<Graph extends CommitReadyGraph = CommitReadyGraph>
  implements ImportService<Graph> {
  private readonly operations = new Map<string, ImportOperationInternal<Graph>>();
  private readonly startedOperationIds = new Set<string>();

  public constructor(
    private readonly dependencies: ImportServiceDependencies<Graph>,
  ) {}

  public start(request: ImportRequest): ImportOperation<Graph> {
    const operationId = validOperationId(request?.operationId)
      ? request.operationId
      : "invalid-operation";

    if (!validOperationId(request?.operationId)) {
      return this.rememberFailed(
        operationId,
        importError("INVALID_IMPORT_REQUEST", { operationId }),
      );
    }

    if (this.startedOperationIds.has(operationId)) {
      return ImportOperationController.failed(
        operationId,
        this.dependencies,
        importError("INVALID_IMPORT_REQUEST", {
          operationId,
          detail: "operationId must be unique",
        }),
      );
    }
    this.startedOperationIds.add(operationId);

    let normalized: NormalizedImportRequest;
    try {
      normalized = normalizeRequest(request, this.dependencies.defaultLimits);
    } catch {
      return this.rememberFailed(
        operationId,
        importError("INVALID_IMPORT_REQUEST", { operationId }),
      );
    }

    if (request.supersedesOperationId !== undefined) {
      const previous = this.operations.get(request.supersedesOperationId);
      if (!previous || !previous.cancel("superseded")) {
        return this.rememberFailed(
          operationId,
          importError("INVALID_IMPORT_REQUEST", {
            operationId,
            detail: "supersedesOperationId is not an active cancellable operation",
          }),
        );
      }
    }

    const operation: ImportOperationController<Graph> = new ImportOperationController(
      normalized,
      this.dependencies,
      () => this.operations.get(operationId) === operation,
    );
    this.operations.set(operationId, operation);
    operation.run();
    return operation;
  }

  public supersede(
    operationId: string,
    request: ImportRequest,
  ): ImportOperation<Graph> {
    return this.start({ ...request, supersedesOperationId: operationId });
  }

  public get(operationId: string): ImportOperation<Graph> | undefined {
    return this.operations.get(operationId);
  }

  private rememberFailed(operationId: string, error: ImportError): ImportOperation<Graph> {
    if (this.operations.has(operationId)) {
      return this.operations.get(operationId)!;
    }

    const operation = ImportOperationController.failed(
      operationId,
      this.dependencies,
      error,
    );
    this.operations.set(operationId, operation);
    return operation;
  }
}

class ImportOperationController<Graph extends CommitReadyGraph = CommitReadyGraph>
  implements ImportOperationInternal<Graph> {
  private readonly lifecycle: ImportLifecycle<Graph>;
  private readonly resultPromise: Promise<ImportOutcome<Graph>>;
  private resolveResult!: (outcome: ImportOutcome<Graph>) => void;
  private workerHandle:
    { cancel(reason?: ImportCancellationReason): void; terminate(): void }
    | undefined;
  private packageSha256: string | undefined;
  private cancelReason: ImportCancellationReason | undefined;
  private workerTimeout: ReturnType<typeof setTimeout> | undefined;
  private workerTerminalReceived = false;
  private settled = false;

  public constructor(
    private readonly request: NormalizedImportRequest,
    private readonly dependencies: ImportServiceDependencies<Graph>,
    private readonly ownsOperation: () => boolean,
  ) {
    this.lifecycle = new ImportLifecycle<Graph>(request.operationId);
    this.resultPromise = new Promise<ImportOutcome<Graph>>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  public static failed<Graph extends CommitReadyGraph>(
    operationId: string,
    dependencies: ImportServiceDependencies<Graph>,
    error: ImportError,
  ): ImportOperationController<Graph> {
    const request: NormalizedImportRequest = {
      operationId,
      packageBytes: new Uint8Array(0),
      fileName: DEFAULT_FILE_NAME,
      limits: DEFAULT_IMPORT_LIMITS,
      duplicatePolicy: "cancel",
    };
    const operation = new ImportOperationController(
      request,
      dependencies,
      () => true,
    );
    operation.fail(error);
    return operation;
  }

  public get operationId(): string {
    return this.request.operationId;
  }

  public get result(): Promise<ImportOutcome<Graph>> {
    return this.resultPromise;
  }

  public get state(): ImportState {
    return this.lifecycle.state;
  }

  public get warnings(): readonly ImportWarning[] {
    return this.lifecycle.warnings;
  }

  public get progress() {
    return this.lifecycle.progress;
  }

  public subscribe(listener: (event: ImportEvent<Graph>) => void): () => void {
    return this.lifecycle.subscribe(listener);
  }

  public cancel(reason: ImportCancellationReason = "caller"): boolean {
    if (
      this.settled
      || isTerminalImportState(this.lifecycle.state)
      || this.lifecycle.state === "committing"
    ) {
      return false;
    }

    this.cancelReason = reason;
    const stage = this.lifecycle.state;
    this.workerHandle?.cancel(reason);
    this.settleCancelled(reason, stage);
    this.workerHandle?.terminate();
    return true;
  }

  public run(): void {
    void this.execute();
  }

  private async execute(): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = copyPackageBytes(this.request.packageBytes);
      if (bytes.byteLength > this.request.limits.maxPackageBytes) {
        this.fail(importError("ARCHIVE_LIMIT_EXCEEDED", {
          operationId: this.operationId,
          stage: "preflight",
        }));
        return;
      }

      this.lifecycle.recordProgress({
        stage: "preflight",
        completed: 0,
        total: null,
        stageCompleted: 0,
        stageTotal: 0,
      });

      const hasher = this.dependencies.hashPackage ?? hashPackageSha256;
      const digest = await hasher(bytes);
      if (this.settled) {
        return;
      }
      if (!/^[0-9a-f]{64}$/i.test(digest)) {
        this.fail(importError("INVALID_PACKAGE", {
          operationId: this.operationId,
          stage: "preflight",
        }));
        return;
      }
      this.packageSha256 = digest.toLowerCase();

      const existing = await this.dependencies.committer.findExisting?.(
        this.packageSha256,
      );
      if (this.settled) {
        return;
      }
      if (existing && this.request.duplicatePolicy === "cancel") {
        this.fail(importError("DUPLICATE_IMPORT", {
          operationId: this.operationId,
          stage: "preflight",
          detail: existing.importId,
        }));
        return;
      }

      const workerPort = this.dependencies.workerFactory.create();
      const workerRequest: ImportWorkerStartRequest = {
        protocol: "webmcp-anki/apkg-import",
        version: 1,
        type: "start",
        operationId: this.operationId,
        fileName: this.request.fileName,
        packageBytes: bytes.slice().buffer as ArrayBuffer,
        packageSha256: this.packageSha256,
        limits: this.request.limits,
        duplicatePolicy: this.request.duplicatePolicy,
      };
      const observer: ImportWorkerObserver<Graph> = {
        onMessage: (message) => this.handleWorkerMessage(message),
        onError: (cause) => this.handleWorkerError(cause),
      };

      if (this.settled) {
        return;
      }
      this.workerHandle = workerPort.start(workerRequest, observer);
      if (!this.settled && !this.workerTerminalReceived) {
        this.workerTimeout = setTimeout(
          () => this.handleWorkerTimeout(),
          this.request.limits.maxParseTimeMs,
        );
      }
    } catch (cause) {
      if (!this.settled) {
        this.fail(mapImportFailure(cause, "WORKER_FAILED", {
          operationId: this.operationId,
          stage: this.lifecycle.state,
        }));
      }
    }
  }

  private handleWorkerMessage(message: unknown): void {
    if (this.settled || this.workerTerminalReceived) {
      return;
    }
    if (!isImportWorkerMessage<Graph>(message)) {
      if (hasOperationId(message, this.operationId)) {
        this.fail(importError("WORKER_FAILED", {
          operationId: this.operationId,
          stage: this.lifecycle.state,
          detail: "Worker message did not match the active protocol",
        }));
      }
      return;
    }
    if (message.operationId !== this.operationId) {
      return;
    }

    switch (message.type) {
      case "progress":
        this.handleProgress(message.stage, message);
        return;
      case "warning":
        this.lifecycle.addWarning(message.warning);
        return;
      case "terminal":
        this.workerTerminalReceived = true;
        this.clearWorkerTimeout();
        this.workerHandle?.terminate();
        if (message.status === "success") {
          this.handleWorkerSuccess(message.graph, message.warnings);
        } else if (message.status === "cancelled") {
          const reason = cancellationReason(message.error) ?? this.cancelReason ?? "caller";
          this.cancel(reason);
        } else {
          this.fail(withOperationId(message.error, this.operationId));
        }
    }
  }

  private handleWorkerError(cause: unknown): void {
    if (this.settled || this.workerTerminalReceived) {
      return;
    }
    this.fail(mapImportFailure(cause, "WORKER_FAILED", {
      operationId: this.operationId,
      stage: this.lifecycle.state,
    }));
  }

  private handleProgress(
    stage: ImportWorkerStage,
    progress: Extract<ImportWorkerMessage<Graph>, { type: "progress" }>,
  ): void {
    const targetState = stage;
    if (this.lifecycle.state !== targetState) {
      if (!this.transitionToWorkerStage(targetState)) {
        this.fail(importError("WORKER_FAILED", {
          operationId: this.operationId,
          stage: this.lifecycle.state,
          detail: "Worker stage transition was out of order",
        }));
        return;
      }
    }

    const accepted = this.lifecycle.recordProgress({
      stage,
      completed: progress.completed,
      total: progress.total,
      stageCompleted: progress.stageCompleted,
      stageTotal: progress.stageTotal,
    });
    if (!accepted) {
      this.fail(importError("WORKER_FAILED", {
        operationId: this.operationId,
        stage: this.lifecycle.state,
        detail: "Worker progress was not monotonic",
      }));
    }
  }

  private transitionToWorkerStage(stage: ImportWorkerStage): boolean {
    const currentIndex = IMPORT_WORKER_STAGES.indexOf(
      this.lifecycle.state as ImportWorkerStage,
    );
    const targetIndex = IMPORT_WORKER_STAGES.indexOf(stage);
    if (targetIndex !== currentIndex + 1 && !(currentIndex === -1 && targetIndex === 0)) {
      return false;
    }

    try {
      this.lifecycle.transition(stage);
      return true;
    } catch {
      return false;
    }
  }

  private handleWorkerSuccess(
    graph: Graph,
    workerWarnings: readonly ImportWarning[],
  ): void {
    if (this.lifecycle.state !== "importing-media") {
      this.fail(importError("WORKER_FAILED", {
        operationId: this.operationId,
        stage: this.lifecycle.state,
        detail: "Worker reached success before all parser stages",
      }));
      return;
    }

    for (const warning of workerWarnings) {
      if (!this.hasWarning(warning)) {
        this.lifecycle.addWarning(warning);
      }
    }

    try {
      this.lifecycle.transition("commit-ready");
      if (this.cancelReason || !this.ownsOperation()) {
        this.cancel(this.cancelReason ?? "superseded");
        return;
      }
      this.lifecycle.transition("committing");
    } catch {
      this.fail(importError("WORKER_FAILED", {
        operationId: this.operationId,
        stage: this.lifecycle.state,
      }));
      return;
    }

    let protectedGraph: Graph;
    try {
      protectedGraph = protectCommitReadyGraph(graph);
    } catch {
      this.fail(importError("WORKER_FAILED", {
        operationId: this.operationId,
        stage: "commit-ready",
        detail: "Worker graph could not be protected",
      }));
      return;
    }

    void this.commit(protectedGraph);
  }

  private handleWorkerTimeout(): void {
    if (this.settled || this.workerTerminalReceived) {
      return;
    }
    this.workerHandle?.cancel("timeout");
    this.fail(importError("IMPORT_TIMEOUT", {
      operationId: this.operationId,
      stage: this.lifecycle.state,
      detail: "maxParseTimeMs",
    }));
  }

  private clearWorkerTimeout(): void {
    if (this.workerTimeout !== undefined) {
      clearTimeout(this.workerTimeout);
      this.workerTimeout = undefined;
    }
  }

  private async commit(graph: Graph): Promise<void> {
    if (this.settled || !this.ownsOperation() || this.lifecycle.state !== "committing") {
      return;
    }

    const input: ImportCommitInput<Graph> = {
      operationId: this.operationId,
      packageSha256: this.packageSha256!,
      duplicatePolicy: this.request.duplicatePolicy,
      graph,
      warnings: this.lifecycle.warnings,
      request: this.request,
    };

    try {
      const commit = await this.dependencies.committer.commit(input);
      if (this.settled) {
        return;
      }
      const status = this.lifecycle.warnings.length > 0
        ? "success-with-warnings"
        : "success";
      const outcome: ImportOutcome<Graph> = {
        status,
        operationId: this.operationId,
        packageSha256: this.packageSha256!,
        warnings: this.lifecycle.warnings,
        commit,
      };
      this.complete(status, outcome);
    } catch (cause) {
      this.fail(mapImportFailure(
        cause,
        this.request.duplicatePolicy === "replace" ? "REPLACE_FAILED" : "COMMIT_FAILED",
        { operationId: this.operationId, stage: "committing" },
      ));
    }
  }

  private hasWarning(warning: ImportWarning): boolean {
    return this.lifecycle.warnings.some((existing) =>
      existing.code === warning.code
      && existing.stage === warning.stage
      && existing.source?.kind === warning.source?.kind
      && existing.source?.id === warning.source?.id,
    );
  }

  private settleCancelled(
    reason: ImportCancellationReason,
    stage: ImportState,
  ): void {
    if (this.settled) {
      return;
    }
    const error = errorForCancellation(this.operationId, stage, reason);
    const outcome: ImportOutcome<Graph> = {
      status: "cancelled",
      operationId: this.operationId,
      error,
      reason,
    };
    try {
      this.lifecycle.transition("cancelled");
    } catch {
      return;
    }
    this.settled = true;
    this.clearWorkerTimeout();
    this.lifecycle.emitTerminal(outcome);
    this.resolveResult(outcome);
  }

  private fail(error: ImportError): void {
    if (this.settled || isTerminalImportState(this.lifecycle.state)) {
      return;
    }
    const normalizedError = withOperationId(error, this.operationId);
    const outcome: ImportOutcome<Graph> = {
      status: "failed",
      operationId: this.operationId,
      error: normalizedError,
    };
    try {
      this.lifecycle.transition("failed");
    } catch {
      return;
    }
    this.settled = true;
    this.clearWorkerTimeout();
    this.lifecycle.emitTerminal(outcome);
    this.resolveResult(outcome);
    this.workerHandle?.terminate();
  }

  private complete(
    status: "success" | "success-with-warnings",
    outcome: ImportOutcome<Graph>,
  ): void {
    if (this.settled || (status !== "success" && status !== "success-with-warnings")) {
      return;
    }
    try {
      this.lifecycle.transition(status);
    } catch {
      this.fail(importError("COMMIT_FAILED", {
        operationId: this.operationId,
        stage: "committing",
      }));
      return;
    }
    this.settled = true;
    this.clearWorkerTimeout();
    this.lifecycle.emitTerminal(outcome);
    this.resolveResult(outcome);
    this.workerHandle?.terminate();
  }
}

function normalizeRequest(
  request: ImportRequest,
  defaultLimits: Partial<ImportLimits> | undefined,
): NormalizedImportRequest {
  if (!request.packageBytes || !(request.packageBytes instanceof ArrayBuffer || request.packageBytes instanceof Uint8Array)) {
    throw new TypeError("packageBytes must be an ArrayBuffer or Uint8Array");
  }
  if (request.fileName !== undefined && (
    typeof request.fileName !== "string"
    || request.fileName.length > FILE_NAME_MAX_LENGTH
  )) {
    throw new TypeError("fileName is invalid");
  }
  if (
    request.duplicatePolicy !== undefined
    && request.duplicatePolicy !== "cancel"
    && request.duplicatePolicy !== "replace"
  ) {
    throw new TypeError("duplicatePolicy is invalid");
  }

  const limits = normalizeImportLimits({
    ...defaultLimits,
    ...request.limits,
  });
  return Object.freeze({
    ...request,
    fileName: request.fileName?.trim() || DEFAULT_FILE_NAME,
    limits,
    duplicatePolicy: request.duplicatePolicy ?? "cancel",
  });
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= OPERATION_ID_MAX_LENGTH;
}

function copyPackageBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

async function hashPackageSha256(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("SHA-256 is unavailable");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function cancellationReason(error: ImportError): ImportCancellationReason | undefined {
  if (error.detail === "caller" || error.detail === "superseded" || error.detail === "timeout") {
    return error.detail;
  }
  return undefined;
}

function withOperationId(error: ImportError, operationId: string): ImportError {
  return isImportError(error)
    ? normalizeImportError(error, operationId)
    : importError("WORKER_FAILED", { operationId });
}

function hasOperationId(value: unknown, operationId: string): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && "operationId" in value
    && (value as { operationId?: unknown }).operationId === operationId,
  );
}

function protectCommitReadyGraph<Graph extends CommitReadyGraph>(graph: Graph): Graph {
  const clone = structuredClone(graph);
  return deepFreezeRecords(clone);
}

function deepFreezeRecords<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreezeRecords(child, seen);
  }
  return Object.freeze(value);
}
