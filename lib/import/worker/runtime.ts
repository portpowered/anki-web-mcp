import type { ImportWorkerRequest, ImportWorkerMessage } from "../protocol";
import {
  IMPORT_WORKER_PROTOCOL,
  IMPORT_WORKER_PROTOCOL_VERSION,
  isImportWorkerRequest,
} from "../protocol";
import { importError } from "../errors";
import { validateArchive, ArchiveValidationFailure } from "./archive";

export interface ImportWorkerRuntimeHost {
  postMessage(message: ImportWorkerMessage): void;
  now?: () => number;
}

/** Owns operation identity and terminal exclusivity inside one Worker. */
export class ImportWorkerRuntime {
  private readonly cancelled = new Set<string>();
  private readonly active = new Set<string>();
  private readonly completed = new Set<string>();

  public constructor(private readonly host: ImportWorkerRuntimeHost) {}

  public receive(value: unknown): void {
    if (!isImportWorkerRequest(value)) {
      return;
    }
    if (value.type === "cancel") {
      if (this.active.has(value.operationId)) {
        this.cancelled.add(value.operationId);
      }
      return;
    }
    if (this.active.has(value.operationId) || this.completed.has(value.operationId)) {
      return;
    }
    this.active.add(value.operationId);
    void this.run(value);
  }

  private async run(request: Extract<ImportWorkerRequest, { type: "start" }>): Promise<void> {
    const startedAt = this.host.now?.() ?? performance.now();
    try {
      this.progress(request.operationId, 0, 1);
      const archive = await validateArchive(new Uint8Array(request.packageBytes), request.limits, {
        operationId: request.operationId,
        now: this.host.now,
        startedAt,
        isCancelled: () => this.cancelled.has(request.operationId),
      });
      this.progress(request.operationId, 1, 1);
      // Later normalization stories consume this validated archive. Until then,
      // a valid ZIP is intentionally not represented as a commit-ready graph.
      this.host.postMessage({
        protocol: IMPORT_WORKER_PROTOCOL,
        version: IMPORT_WORKER_PROTOCOL_VERSION,
        type: "terminal",
        operationId: request.operationId,
        status: "failed",
        commitReady: false,
        error: importError("UNSUPPORTED_PACKAGE", {
          operationId: request.operationId,
          stage: "decompressing-collection",
          detail: `validatedArchiveMembers:${archive.members.length}`,
        }),
      });
    } catch (error) {
      const failure = error instanceof ArchiveValidationFailure
        ? error.error
        : importError("WORKER_FAILED", {
          operationId: request.operationId,
          stage: "validating-archive",
        });
      this.host.postMessage({
        protocol: IMPORT_WORKER_PROTOCOL,
        version: IMPORT_WORKER_PROTOCOL_VERSION,
        type: "terminal",
        operationId: request.operationId,
        status: failure.code === "IMPORT_CANCELLED" ? "cancelled" : "failed",
        commitReady: false,
        error: failure,
      });
    } finally {
      this.active.delete(request.operationId);
      this.cancelled.delete(request.operationId);
      this.completed.add(request.operationId);
    }
  }

  private progress(operationId: string, completed: number, total: number): void {
    this.host.postMessage({
      protocol: IMPORT_WORKER_PROTOCOL,
      version: IMPORT_WORKER_PROTOCOL_VERSION,
      type: "progress",
      operationId,
      stage: "validating-archive",
      completed,
      total,
      stageCompleted: completed,
      stageTotal: total,
    });
  }
}
