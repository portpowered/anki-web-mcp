import {
  DEFAULT_PARSE_LIMITS,
  PARSER_STAGES,
  type ParseLimits,
  type ParserProgressMessage,
  type ParserTerminalMessage,
  type ParserWorkerMessage,
} from "./protocol";

export interface ParserCallbacks {
  onProgress?: (message: ParserProgressMessage) => void;
}

export interface ParserOptions extends ParserCallbacks {
  limits?: ParseLimits;
  /** Test-only task-boundary delay; production callers leave this unset. */
  checkpointDelayMs?: number;
}

interface PendingParse {
  operationId: string;
  callbacks: ParserCallbacks;
  resolve: (message: ParserTerminalMessage) => void;
  reject: (error: Error) => void;
  lastCompleted: number;
}

/** Main-thread facade for the isolated parser Worker. */
export class ParserWorkerClient {
  private readonly worker: Worker;
  private nextOperation = 1;
  private pending: PendingParse | undefined;
  private disposed = false;

  public constructor() {
    this.worker = new Worker(new URL("./parser-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
  }

  public parse(
    packageBytes: Uint8Array | ArrayBuffer,
    options: ParserOptions = {},
  ): Promise<ParserTerminalMessage> {
    if (this.disposed) {
      return Promise.reject(new Error("The parser Worker has been disposed"));
    }
    if (this.pending) {
      return Promise.reject(
        new Error("An APKG parser operation is already running; cancel it first"),
      );
    }

    const operationId = `apkg-parse-${this.nextOperation}`;
    this.nextOperation += 1;
    const transferableBytes = packageBytes instanceof ArrayBuffer
      ? packageBytes.slice(0)
      : packageBytes.slice().buffer;
    const request = {
      type: "parse" as const,
      operationId,
      packageBytes: transferableBytes,
      limits: options.limits ?? DEFAULT_PARSE_LIMITS,
      checkpointDelayMs: options.checkpointDelayMs,
    };

    return new Promise<ParserTerminalMessage>((resolve, reject) => {
      this.pending = {
        operationId,
        callbacks: options,
        resolve,
        reject,
        lastCompleted: 0,
      };
      this.worker.postMessage(request, [transferableBytes]);
    });
  }

  /** Cancel cooperatively and keep the promise pending until the terminal arrives. */
  public cancel(): void {
    const pending = this.pending;
    if (!pending || this.disposed) {
      return;
    }
    this.worker.postMessage({
      type: "cancel",
      operationId: pending.operationId,
    });
  }

  /**
   * Supersede the current operation. Its promise is rejected locally and all
   * later messages from its operation ID are ignored by the client.
   */
  public replace(
    packageBytes: Uint8Array | ArrayBuffer,
    options: ParserOptions = {},
  ): Promise<ParserTerminalMessage> {
    const pending = this.pending;
    if (pending) {
      this.pending = undefined;
      pending.reject(new Error("APKG parser operation superseded"));
      this.worker.postMessage({
        type: "cancel",
        operationId: pending.operationId,
      });
    }
    return this.parse(packageBytes, options);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new Error("The parser Worker was disposed"));
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.terminate();
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isParserWorkerMessage(event.data)) {
      return;
    }

    const message = event.data;
    const pending = this.pending;
    // This drops messages from a superseded operation, including a late
    // terminal emitted after its cancellation checkpoint.
    if (!pending || message.operationId !== pending.operationId) {
      return;
    }

    if (message.kind === "progress") {
      const stageIndex = PARSER_STAGES.indexOf(message.stage);
      if (
        message.completed <= pending.lastCompleted ||
        message.completed !== stageIndex + 1
      ) {
        return;
      }
      pending.lastCompleted = message.completed;
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
    pending.reject(new Error(event.message || "APKG parser Worker failed"));
  };
}

function isParserWorkerMessage(value: unknown): value is ParserWorkerMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as {
    kind?: unknown;
    operationId?: unknown;
    stage?: unknown;
    completed?: unknown;
    status?: unknown;
    commitReady?: unknown;
    stagedResult?: unknown;
  };
  if (typeof message.operationId !== "string") {
    return false;
  }
  if (message.kind === "progress") {
    return (
      typeof message.stage === "string" &&
      (PARSER_STAGES as readonly string[]).includes(message.stage) &&
      typeof message.completed === "number"
    );
  }
  if (message.kind !== "terminal") {
    return false;
  }
  return (
    (message.status === "success" &&
      message.commitReady === true &&
      message.stagedResult !== null) ||
    ((message.status === "error" || message.status === "cancelled" ||
      message.status === "unsupported") &&
      message.commitReady === false &&
      message.stagedResult === null)
  );
}
