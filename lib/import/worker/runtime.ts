import type { ImportWorkerRequest, ImportWorkerMessage } from "../protocol";
import {
  IMPORT_WORKER_PROTOCOL,
  IMPORT_WORKER_PROTOCOL_VERSION,
  isImportWorkerRequest,
} from "../protocol";
import { importError } from "../errors";
import { validateArchive, ArchiveValidationFailure } from "./archive";
import { CollectionFailure, normalizeCollectionArchive } from "./collection";

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
      this.progress(request.operationId, "validating-archive", 0, 3, 0, 1);
      const archive = await validateArchive(new Uint8Array(request.packageBytes), request.limits, {
        operationId: request.operationId,
        now: this.host.now,
        startedAt,
        isCancelled: () => this.cancelled.has(request.operationId),
      });
      this.progress(request.operationId, "validating-archive", 1, 3, 1, 1);
      this.progress(request.operationId, "decompressing-collection", 1, 3, 0, 1);
      const graph = await normalizeCollectionArchive(archive, {
        operationId: request.operationId,
        packageSha256: request.packageSha256,
        limits: request.limits,
        now: this.host.now,
        startedAt,
        isCancelled: () => this.cancelled.has(request.operationId),
      });
      this.progress(request.operationId, "decompressing-collection", 2, 3, 1, 1);
      this.progress(request.operationId, "parsing-records", 3, 3, 1, 1);
      this.host.postMessage({
        protocol: IMPORT_WORKER_PROTOCOL,
        version: IMPORT_WORKER_PROTOCOL_VERSION,
        type: "terminal",
        operationId: request.operationId,
        status: "success",
        commitReady: true,
        graph,
        warnings: [],
      });
    } catch (error) {
      const failure = error instanceof ArchiveValidationFailure
        ? error.error
        : error instanceof CollectionFailure
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

  private progress(
    operationId: string,
    stage: "validating-archive" | "decompressing-collection" | "parsing-records",
    completed: number,
    total: number,
    stageCompleted: number,
    stageTotal: number,
  ): void {
    this.host.postMessage({
      protocol: IMPORT_WORKER_PROTOCOL,
      version: IMPORT_WORKER_PROTOCOL_VERSION,
      type: "progress",
      operationId,
      stage,
      completed,
      total,
      stageCompleted,
      stageTotal,
    });
  }
}
