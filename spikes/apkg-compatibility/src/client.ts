import type {
  EvaluateRequest,
  ProgressMessage,
  TerminalMessage,
  WorkerMessage,
} from "./protocol";

export interface EvaluationCallbacks {
  onProgress?: (message: ProgressMessage) => void;
}

export interface EvaluationOptions {
  checkpointDelayMs?: number;
  pauseAfterProgressStage?: EvaluateRequest["pauseAfterProgressStage"];
  pauseAfterProgressMs?: number;
}

interface PendingEvaluation {
  operationId: string;
  callbacks: EvaluationCallbacks;
  resolve: (message: TerminalMessage) => void;
  reject: (error: Error) => void;
}

export class StackWorkerClient {
  private readonly worker: Worker;
  private nextOperation = 1;
  private pending: PendingEvaluation | undefined;

  public constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
  }

  public evaluate(
    callbacks: EvaluationCallbacks = {},
    options: EvaluationOptions = {},
  ): Promise<TerminalMessage> {
    if (this.pending) {
      return Promise.reject(
        new Error("An APKG stack evaluation is already running"),
      );
    }

    const operationId = `stack-evaluation-${this.nextOperation}`;
    this.nextOperation += 1;
    const request: EvaluateRequest = {
      type: "evaluate",
      operationId,
      checkpointDelayMs: options.checkpointDelayMs ?? 50,
      pauseAfterProgressStage: options.pauseAfterProgressStage,
      pauseAfterProgressMs: options.pauseAfterProgressMs,
    };

    return new Promise<TerminalMessage>((resolve, reject) => {
      this.pending = { operationId, callbacks, resolve, reject };
      this.worker.postMessage(request);
    });
  }

  public cancel(): void {
    if (!this.pending) {
      return;
    }

    this.worker.postMessage({
      type: "cancel",
      operationId: this.pending.operationId,
    });
  }

  public dispose(): void {
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.terminate();
    this.pending = undefined;
  }

  private readonly handleMessage = (event: MessageEvent<WorkerMessage>): void => {
    const message = event.data;
    const pending = this.pending;

    // A superseded operation or a late message cannot settle the current one.
    if (!pending || message.operationId !== pending.operationId) {
      return;
    }

    if (message.kind === "progress") {
      pending.callbacks.onProgress?.(message);
      return;
    }

    this.pending = undefined;
    pending.resolve(message);
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    this.pending = undefined;
    pending.reject(new Error(event.message || "APKG stack Worker failed"));
  };
}
