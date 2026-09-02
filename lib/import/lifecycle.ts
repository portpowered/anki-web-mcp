import {
  IMPORT_PROGRESS_STAGES,
  IMPORT_STATES,
  type ImportEvent,
  type ImportOutcome,
  type ImportProgress,
  type ImportProgressStage,
  type ImportState,
  type ImportWarning,
} from "./contracts";

export const IMPORT_TERMINAL_STATES = [
  "success",
  "success-with-warnings",
  "cancelled",
  "failed",
] as const satisfies readonly ImportState[];

export type ImportTerminalState = (typeof IMPORT_TERMINAL_STATES)[number];

const LEGAL_TRANSITIONS: Readonly<Record<ImportState, readonly ImportState[]>> = {
  preflight: ["validating-archive", "cancelled", "failed"],
  "validating-archive": ["decompressing-collection", "cancelled", "failed"],
  "decompressing-collection": ["parsing-records", "cancelled", "failed"],
  "parsing-records": ["compiling-content", "cancelled", "failed"],
  "compiling-content": ["importing-media", "cancelled", "failed"],
  "importing-media": ["commit-ready", "cancelled", "failed"],
  "commit-ready": ["committing", "cancelled", "failed"],
  committing: ["success", "success-with-warnings", "failed"],
  success: [],
  "success-with-warnings": [],
  cancelled: [],
  failed: [],
};

export function isTerminalImportState(state: ImportState): state is ImportTerminalState {
  return (IMPORT_TERMINAL_STATES as readonly string[]).includes(state);
}

export function isLegalImportTransition(
  from: ImportState,
  to: ImportState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export class ImportLifecycleTransitionError extends Error {
  public constructor(
    public readonly from: ImportState,
    public readonly to: ImportState,
  ) {
    super(`Illegal import lifecycle transition: ${from} -> ${to}`);
    this.name = "ImportLifecycleTransitionError";
  }
}

/**
 * Small state machine shared by the application service and contract tests.
 * It is the only place that emits public state/progress/warning events, which
 * makes terminal exclusivity and monotonic progress enforceable in one place.
 */
export class ImportLifecycle<Graph extends import("./contracts").CommitReadyGraph> {
  private currentState: ImportState = "preflight";
  private currentProgress: ImportProgress | null = null;
  private readonly warningList: ImportWarning[] = [];
  private readonly listeners = new Set<(event: ImportEvent<Graph>) => void>();
  private terminalEmitted = false;

  public constructor(public readonly operationId: string) {}

  public get state(): ImportState {
    return this.currentState;
  }

  public get warnings(): readonly ImportWarning[] {
    return this.warningList;
  }

  public get progress(): ImportProgress | null {
    return this.currentProgress;
  }

  public subscribe(listener: (event: ImportEvent<Graph>) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener, {
      type: "state",
      operationId: this.operationId,
      state: this.currentState,
    });
    if (this.currentProgress) {
      this.notify(listener, {
        type: "progress",
        ...this.currentProgress,
      });
    }
    for (const warning of this.warningList) {
      this.notify(listener, {
        type: "warning",
        operationId: this.operationId,
        warning,
      });
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  public transition(to: ImportState): void {
    if (!isLegalImportTransition(this.currentState, to)) {
      throw new ImportLifecycleTransitionError(this.currentState, to);
    }
    this.currentState = to;
    this.emit({
      type: "state",
      operationId: this.operationId,
      state: to,
    });
  }

  /** Return false rather than throwing when a late event targets a terminal op. */
  public recordProgress(progress: Omit<ImportProgress, "operationId">): boolean {
    if (
      isTerminalImportState(this.currentState)
      || !isProgressStage(progress.stage)
      || progress.stage !== this.currentState
      || !isCounter(progress.completed)
      || !isTotal(progress.total)
      || !isCounter(progress.stageCompleted)
      || !isTotal(progress.stageTotal)
      || !isWithinTotal(progress.completed, progress.total)
      || !isWithinTotal(progress.stageCompleted, progress.stageTotal)
    ) {
      return false;
    }

    const previous = this.currentProgress;
    if (previous) {
      if (progress.completed < previous.completed) {
        return false;
      }
      if (
        previous.total !== null
        && progress.total !== null
        && progress.total < previous.total
      ) {
        return false;
      }
      if (
        progress.stage === previous.stage
        && (
          progress.stageCompleted < previous.stageCompleted
          || (
            previous.stageTotal !== null
            && progress.stageTotal !== null
            && progress.stageTotal < previous.stageTotal
          )
        )
      ) {
        return false;
      }
    }

    this.currentProgress = Object.freeze({
      operationId: this.operationId,
      ...progress,
    });
    this.emit({
      type: "progress",
      ...this.currentProgress,
    });
    return true;
  }

  public addWarning(warning: ImportWarning): boolean {
    if (isTerminalImportState(this.currentState)) {
      return false;
    }
    this.warningList.push(Object.freeze({
      ...warning,
      ...(warning.source ? { source: Object.freeze({ ...warning.source }) } : {}),
    }));
    this.emit({
      type: "warning",
      operationId: this.operationId,
      warning: this.warningList[this.warningList.length - 1]!,
    });
    return true;
  }

  public emitTerminal(outcome: ImportOutcome<Graph>): boolean {
    if (!isTerminalImportState(this.currentState) || this.terminalEmitted) {
      return false;
    }
    this.terminalEmitted = true;
    this.emit({
      type: "terminal",
      operationId: this.operationId,
      outcome,
    });
    return true;
  }

  private emit(event: ImportEvent<Graph>): void {
    for (const listener of this.listeners) {
      this.notify(listener, event);
    }
  }

  private notify(listener: (event: ImportEvent<Graph>) => void, event: ImportEvent<Graph>): void {
    try {
      listener(event);
    } catch {
      // A caller observer cannot interrupt the import state machine.
    }
  }
}

function isProgressStage(value: ImportProgressStage): boolean {
  return (IMPORT_PROGRESS_STAGES as readonly string[]).includes(value);
}

function isCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTotal(value: number | null): boolean {
  return value === null || isCounter(value);
}

function isWithinTotal(value: number, total: number | null): boolean {
  return total === null || value <= total;
}
