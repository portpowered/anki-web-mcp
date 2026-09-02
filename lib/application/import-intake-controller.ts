import type {
  CommitReadyGraph,
  ImportEvent,
  ImportOperation,
  ImportOutcome,
  ImportProgress,
  ImportProgressStage,
  ImportService,
  ImportState,
} from "../import/contracts";

export const APKG_ACCEPT = ".apkg" as const;
export const IMPORT_INTAKE_HELP = "Choose exactly one .apkg file to import.";

export type ImportIntakeRejection = "empty" | "multiple" | "invalid-extension";

export type ImportIntakeResult =
  | { readonly accepted: true; readonly file: File }
  | {
      readonly accepted: false;
      readonly reason: ImportIntakeRejection;
      readonly message: typeof IMPORT_INTAKE_HELP;
    };

export type ImportFileController<Graph extends CommitReadyGraph = CommitReadyGraph> = {
  start(
    file: File,
    replacement?: { readonly replacementImportId: string },
  ): Promise<ImportOperation<Graph>>;
};

export const IMPORT_STAGE_LABELS: Readonly<Record<ImportProgressStage, string>> = {
  preflight: "Checking the package",
  "validating-archive": "Validating the archive",
  "decompressing-collection": "Opening the collection",
  "parsing-records": "Reading cards and notes",
  "compiling-content": "Preparing card content",
  "importing-media": "Importing media",
  "commit-ready": "Ready to save",
  committing: "Saving your decks",
};

export type ImportProgressPresentation<Graph extends CommitReadyGraph = CommitReadyGraph> =
  | { readonly kind: "idle" }
  | {
      readonly kind: "active";
      readonly operationId: string | null;
      readonly stage: ImportProgressStage;
      readonly progress: ImportProgress | null;
      readonly cancelRequested: boolean;
      readonly canCancel: boolean;
      readonly announcement: string;
    }
  | {
      readonly kind: "terminal";
      readonly operationId: string;
      readonly outcome: ImportOutcome<Graph>;
      readonly announcement: string;
      readonly canRetryReplacement?: boolean;
    }
  | {
      readonly kind: "duplicate";
      readonly operationId: string;
      readonly existingImportId: string;
      readonly announcement: string;
    }
  | {
      readonly kind: "duplicate-cancelled";
      readonly operationId: string;
      readonly announcement: string;
    };

export type ImportProgressListener<Graph extends CommitReadyGraph = CommitReadyGraph> = (
  presentation: ImportProgressPresentation<Graph>,
) => void;

export interface ImportProgressController<Graph extends CommitReadyGraph = CommitReadyGraph> {
  readonly state: ImportProgressPresentation<Graph>;
  start(file: File): Promise<boolean>;
  cancel(): boolean;
  cancelDuplicate(): boolean;
  confirmDuplicateReplacement(): Promise<boolean>;
  retryReplacement(): Promise<boolean>;
  subscribe(listener: ImportProgressListener<Graph>): () => void;
  dispose(): void;
}

/**
 * Validate all browser intake paths through one application-owned boundary.
 * The accepted File object is forwarded unchanged and at most once.
 */
export function submitImportIntake(
  files: ArrayLike<File> | readonly File[],
  onAccepted: (file: File) => void,
): ImportIntakeResult {
  if (files.length === 0) {
    return reject("empty");
  }
  if (files.length !== 1) {
    return reject("multiple");
  }

  const file = files[0];
  if (!file || !file.name.toLocaleLowerCase().endsWith(APKG_ACCEPT)) {
    return reject("invalid-extension");
  }

  onAccepted(file);
  return { accepted: true, file };
}

/** Convert the accepted browser File into the production service request. */
export function createImportFileController<Graph extends CommitReadyGraph>(
  service: Pick<ImportService<Graph>, "start">,
  createOperationId: () => string = defaultOperationId,
): ImportFileController<Graph> {
  return {
    async start(file, replacement) {
      const packageBytes = await file.arrayBuffer();
      return service.start({
        operationId: createOperationId(),
        fileName: file.name,
        packageBytes,
        duplicatePolicy: replacement ? "replace" : "cancel",
        ...(replacement
          ? { replacementImportId: replacement.replacementImportId }
          : {}),
      });
    },
  };
}

/**
 * Own the single UI operation and translate service events into safe display state.
 * Stage changes are announced immediately; count-only changes are rate limited.
 */
export function createImportProgressController<Graph extends CommitReadyGraph>(
  fileController: ImportFileController<Graph>,
  options: {
    readonly now?: () => number;
    readonly announcementIntervalMs?: number;
  } = {},
): ImportProgressController<Graph> {
  const listeners = new Set<ImportProgressListener<Graph>>();
  const now = options.now ?? Date.now;
  const announcementIntervalMs = options.announcementIntervalMs ?? 750;
  let presentation: ImportProgressPresentation<Graph> = { kind: "idle" };
  let activeOperation: ImportOperation<Graph> | null = null;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let disposed = false;
  let lastAnnouncementAt = Number.NEGATIVE_INFINITY;
  let lastAnnouncedStage: ImportProgressStage | null = null;
  let retainedFile: File | null = null;
  let replacementImportId: string | null = null;

  const publish = (next: ImportProgressPresentation<Graph>) => {
    if (disposed) return;
    presentation = next;
    for (const listener of listeners) listener(next);
  };

  const announceFor = (
    stage: ImportProgressStage,
    progress: ImportProgress | null,
  ): string => {
    const timestamp = now();
    const stageChanged = stage !== lastAnnouncedStage;
    if (!stageChanged && timestamp - lastAnnouncementAt < announcementIntervalMs) {
      return "";
    }
    lastAnnouncedStage = stage;
    lastAnnouncementAt = timestamp;
    return formatImportProgress(stage, progress);
  };

  const finish = (operationId: string, outcome: ImportOutcome<Graph>) => {
    if (activeOperation?.operationId !== operationId) return;
    unsubscribe?.();
    unsubscribe = null;
    activeOperation = null;
    const duplicateId = duplicateImportId(outcome);
    if (duplicateId && retainedFile) {
      replacementImportId = duplicateId;
      publish({
        kind: "duplicate",
        operationId,
        existingImportId: duplicateId,
        announcement: "Duplicate package found. Cancel import is the safe default.",
      });
      return;
    }
    const canRetryReplacement = outcome.status === "failed"
      && outcome.error.code === "REPLACE_FAILED"
      && retainedFile !== null
      && replacementImportId !== null;
    if (!canRetryReplacement) {
      retainedFile = null;
      replacementImportId = null;
    }
    publish({
      kind: "terminal",
      operationId,
      outcome,
      announcement: terminalAnnouncement(outcome),
      canRetryReplacement,
    });
  };

  const handleEvent = (operation: ImportOperation<Graph>, event: ImportEvent<Graph>) => {
    if (disposed || activeOperation !== operation || event.operationId !== operation.operationId) {
      return;
    }
    if (event.type === "terminal") {
      finish(event.operationId, event.outcome);
      return;
    }
    if (event.type === "warning") return;

    const current = presentation.kind === "active" ? presentation : null;
    const stage = event.type === "state"
      ? progressStageForState(event.state)
      : event.stage;
    if (!stage) return;
    const candidateProgress = event.type === "progress"
      ? event
      : current?.progress ?? operation.progress;
    const progress = candidateProgress?.stage === stage ? candidateProgress : null;
    publish({
      kind: "active",
      operationId: operation.operationId,
      stage,
      progress,
      cancelRequested: current?.cancelRequested ?? false,
      canCancel: stage !== "committing" && !(current?.cancelRequested ?? false),
      announcement: announceFor(stage, progress),
    });
  };

  const startOperation = async (
    file: File,
    replacement?: { readonly replacementImportId: string },
  ): Promise<boolean> => {
    if (disposed || presentation.kind === "active") return false;
    const ownGeneration = ++generation;
    retainedFile = file;
    replacementImportId = replacement?.replacementImportId ?? null;
    lastAnnouncedStage = null;
    lastAnnouncementAt = Number.NEGATIVE_INFINITY;
    publish({
      kind: "active",
      operationId: null,
      stage: "preflight",
      progress: null,
      cancelRequested: false,
      canCancel: false,
      announcement: announceFor("preflight", null),
    });

    try {
      const operation = await fileController.start(file, replacement);
      if (disposed || generation !== ownGeneration) return false;
      activeOperation = operation;
      unsubscribe = operation.subscribe((event) => handleEvent(operation, event));
      void operation.result.then((outcome) => finish(operation.operationId, outcome));
      return true;
    } catch {
      if (!disposed && generation === ownGeneration) publish({ kind: "idle" });
      throw new Error("Import could not be started.");
    }
  };

  return {
    get state() {
      return presentation;
    },
    start(file) {
      return startOperation(file);
    },
    cancel() {
      if (disposed || presentation.kind !== "active" || !presentation.canCancel) {
        return false;
      }
      const operation = activeOperation;
      if (!operation) return false;
      publish({ ...presentation, cancelRequested: true, canCancel: false });
      const accepted = operation.cancel("caller");
      if (!accepted && presentation.kind === "active") {
        publish({ ...presentation, cancelRequested: false, canCancel: false });
      }
      return accepted;
    },
    cancelDuplicate() {
      if (
        disposed
        || replacementImportId === null
        || (
          presentation.kind !== "duplicate"
          && !(presentation.kind === "terminal" && presentation.canRetryReplacement)
        )
      ) return false;
      const operationId = presentation.operationId;
      retainedFile = null;
      replacementImportId = null;
      publish({
        kind: "duplicate-cancelled",
        operationId,
        announcement: "Duplicate import cancelled. Your existing saved decks were not changed.",
      });
      return true;
    },
    confirmDuplicateReplacement() {
      if (
        disposed
        || presentation.kind !== "duplicate"
        || retainedFile === null
        || replacementImportId === null
      ) return Promise.resolve(false);
      return startOperation(retainedFile, { replacementImportId });
    },
    retryReplacement() {
      if (
        disposed
        || presentation.kind !== "terminal"
        || !presentation.canRetryReplacement
        || retainedFile === null
        || replacementImportId === null
      ) return Promise.resolve(false);
      return startOperation(retainedFile, { replacementImportId });
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(presentation);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
    },
  };
}

function duplicateImportId<Graph extends CommitReadyGraph>(
  outcome: ImportOutcome<Graph>,
): string | null {
  if (
    outcome.status !== "failed"
    || outcome.error.code !== "DUPLICATE_IMPORT"
    || !outcome.error.detail
    || !/^[0-9a-f]{64}$/i.test(outcome.error.detail)
  ) return null;
  return outcome.error.detail.toLowerCase();
}

export function formatImportProgress(
  stage: ImportProgressStage,
  progress: Pick<ImportProgress, "completed" | "total" | "stageCompleted" | "stageTotal"> | null,
): string {
  const label = IMPORT_STAGE_LABELS[stage];
  if (!progress) return `${label}…`;
  if (progress.stageTotal !== null) {
    return `${label}: ${progress.stageCompleted} of ${progress.stageTotal}.`;
  }
  if (progress.total !== null) return `${label}: ${progress.completed} of ${progress.total}.`;
  if (progress.stageCompleted > 0) return `${label}: ${progress.stageCompleted} completed.`;
  if (progress.completed > 0) return `${label}: ${progress.completed} completed.`;
  return `${label}…`;
}

function progressStageForState(state: ImportState): ImportProgressStage | null {
  return state === "success"
    || state === "success-with-warnings"
    || state === "cancelled"
    || state === "failed"
    ? null
    : state;
}

function terminalAnnouncement<Graph extends CommitReadyGraph>(
  outcome: ImportOutcome<Graph>,
): string {
  if (outcome.status === "cancelled") {
    return "Import cancelled. Your saved decks were not changed. Choose a file to try again.";
  }
  if (outcome.status === "success-with-warnings") {
    return "Import saved with warnings.";
  }
  if (outcome.status === "success") return "Import saved successfully.";
  return "Import stopped before it could be completed. Your saved decks were not changed.";
}

function reject(reason: ImportIntakeRejection): ImportIntakeResult {
  return { accepted: false, reason, message: IMPORT_INTAKE_HELP };
}

function defaultOperationId(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `import-${suffix}`;
}
