import type {
  ImportCancellationReason,
  ImportError,
} from "./errors";
import type { ImportLimits, ImportLimitsInput } from "./limits";

export const IMPORT_STATES = [
  "preflight",
  "validating-archive",
  "decompressing-collection",
  "parsing-records",
  "compiling-content",
  "importing-media",
  "commit-ready",
  "committing",
  "success",
  "success-with-warnings",
  "cancelled",
  "failed",
] as const;

export type ImportState = (typeof IMPORT_STATES)[number];
/** Alias used by error envelopes and diagnostics. */
export type ImportStage = ImportState;

export const IMPORT_PROGRESS_STAGES = [
  "preflight",
  "validating-archive",
  "decompressing-collection",
  "parsing-records",
  "compiling-content",
  "importing-media",
  "commit-ready",
  "committing",
] as const;

export type ImportProgressStage = (typeof IMPORT_PROGRESS_STAGES)[number];

export const IMPORT_WORKER_STAGES = [
  "validating-archive",
  "decompressing-collection",
  "parsing-records",
  "compiling-content",
  "importing-media",
] as const;

export type ImportWorkerStage = (typeof IMPORT_WORKER_STAGES)[number];

export type ImportDuplicatePolicy = "cancel" | "replace";

/**
 * The bytes and caller metadata accepted by the application boundary. The
 * optional fields intentionally have defaults so callers cannot accidentally
 * opt into replacement or unbounded parser behavior.
 */
export interface ImportRequest {
  readonly operationId: string;
  readonly packageBytes: Uint8Array | ArrayBuffer;
  readonly fileName?: string;
  readonly limits?: ImportLimitsInput;
  readonly duplicatePolicy?: ImportDuplicatePolicy;
  /** Start this operation only after superseding the named active operation. */
  readonly supersedesOperationId?: string;
}

export interface ImportProgress {
  readonly operationId: string;
  readonly stage: ImportProgressStage;
  /** Operation-level completed units; this value never decreases. */
  readonly completed: number;
  /** Operation-level total, or null when the total is not knowable yet. */
  readonly total: number | null;
  /** Stage-local counters may reset when the stage changes. */
  readonly stageCompleted: number;
  readonly stageTotal: number | null;
}

export const IMPORT_WARNING_CODES = [
  "UNSAFE_CONTENT_REMOVED",
  "UNSUPPORTED_TEMPLATE_FEATURE",
  "MISSING_MEDIA",
  "MISSING_MEDIA_MAP_ENTRY",
  "UNSUPPORTED_FEATURE",
] as const;

export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];

export type ImportWarningSourceKind =
  | "package"
  | "deck"
  | "model"
  | "note"
  | "card"
  | "template"
  | "media";

export interface ImportWarningSource {
  readonly kind: ImportWarningSourceKind;
  readonly id: string;
}

/** Warning messages are diagnostics, never executable imported content. */
export interface ImportWarning {
  readonly code: ImportWarningCode;
  readonly message: string;
  readonly stage: ImportProgressStage;
  readonly source?: ImportWarningSource;
}

/**
 * The graph is deliberately opaque at this enabling boundary. Parser stories
 * will refine its normalized records; the service only guarantees that the
 * Worker supplied one validated, structured-clone-safe value.
 */
export interface CommitReadyGraph {
  readonly [key: string]: unknown;
}

export interface ImportCommitInput<Graph extends CommitReadyGraph = CommitReadyGraph> {
  readonly operationId: string;
  readonly packageSha256: string;
  readonly duplicatePolicy: ImportDuplicatePolicy;
  readonly graph: Graph;
  readonly warnings: readonly ImportWarning[];
  readonly request: Readonly<ImportRequest> & {
    readonly limits: ImportLimits;
    readonly duplicatePolicy: ImportDuplicatePolicy;
  };
}

export interface ImportCommitResult {
  readonly importId: string;
  readonly deckIds: readonly string[];
}

export interface ImportSuccessResult {
  readonly status: "success" | "success-with-warnings";
  readonly operationId: string;
  readonly packageSha256: string;
  readonly warnings: readonly ImportWarning[];
  readonly commit: ImportCommitResult;
}

export interface ImportCancelledResult {
  readonly status: "cancelled";
  readonly operationId: string;
  readonly error: ImportError;
  readonly reason: ImportCancellationReason;
}

export interface ImportFailedResult {
  readonly status: "failed";
  readonly operationId: string;
  readonly error: ImportError;
}

export type ImportOutcome<Graph extends CommitReadyGraph = CommitReadyGraph> =
  | ImportSuccessResult
  | ImportCancelledResult
  | ImportFailedResult;

export interface ImportStateEvent {
  readonly type: "state";
  readonly operationId: string;
  readonly state: ImportState;
}

export interface ImportProgressEvent extends ImportProgress {
  readonly type: "progress";
}

export interface ImportWarningEvent {
  readonly type: "warning";
  readonly operationId: string;
  readonly warning: ImportWarning;
}

export interface ImportTerminalEvent<Graph extends CommitReadyGraph = CommitReadyGraph> {
  readonly type: "terminal";
  readonly operationId: string;
  readonly outcome: ImportOutcome<Graph>;
}

export type ImportEvent<Graph extends CommitReadyGraph = CommitReadyGraph> =
  | ImportStateEvent
  | ImportProgressEvent
  | ImportWarningEvent
  | ImportTerminalEvent<Graph>;

export interface ImportOperation<Graph extends CommitReadyGraph = CommitReadyGraph> {
  readonly operationId: string;
  readonly result: Promise<ImportOutcome<Graph>>;
  readonly state: ImportState;
  readonly warnings: readonly ImportWarning[];
  readonly progress: ImportProgress | null;
  subscribe(listener: (event: ImportEvent<Graph>) => void): () => void;
  /** Returns false after terminal state or once commit has begun. */
  cancel(reason?: ImportCancellationReason): boolean;
}

export interface ImportWorkerObserver<Graph extends CommitReadyGraph = CommitReadyGraph> {
  /** Worker messages cross an untrusted runtime boundary and are validated by the service. */
  onMessage(message: unknown): void;
  onError(cause: unknown): void;
}

export interface ImportWorkerHandle {
  cancel(): void;
  terminate(): void;
}

export interface ImportWorkerPort<Graph extends CommitReadyGraph = CommitReadyGraph> {
  start(
    request: import("./protocol").ImportWorkerStartRequest,
    observer: ImportWorkerObserver<Graph>,
  ): ImportWorkerHandle;
}

export interface ImportWorkerFactory<Graph extends CommitReadyGraph = CommitReadyGraph> {
  create(): ImportWorkerPort<Graph>;
}

export interface ImportCommitter<Graph extends CommitReadyGraph = CommitReadyGraph> {
  commit(input: ImportCommitInput<Graph>): Promise<ImportCommitResult>;
}

export interface ImportServiceDependencies<Graph extends CommitReadyGraph = CommitReadyGraph> {
  readonly workerFactory: ImportWorkerFactory<Graph>;
  readonly committer: ImportCommitter<Graph>;
  readonly hashPackage?: (bytes: Uint8Array) => Promise<string>;
  readonly defaultLimits?: ImportLimitsInput;
}

export interface ImportService<Graph extends CommitReadyGraph = CommitReadyGraph> {
  start(request: ImportRequest): ImportOperation<Graph>;
  /** Explicit supersession helper; replacement is still a separate policy. */
  supersede(
    operationId: string,
    request: ImportRequest,
  ): ImportOperation<Graph>;
  get(operationId: string): ImportOperation<Graph> | undefined;
}
