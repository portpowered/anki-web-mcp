import { describe, expect, test } from "bun:test";

import {
  APKG_ACCEPT,
  createImportFileController,
  createImportProgressController,
  formatImportProgress,
  IMPORT_INTAKE_HELP,
  submitImportIntake,
} from "../../lib/application/import-intake-controller";
import { importError } from "../../lib/import/errors";
import type {
  ImportEvent,
  ImportOperation,
  ImportOutcome,
  ImportProgress,
  ImportState,
} from "../../lib/import/contracts";

describe("APKG import intake controller", () => {
  test("forwards the original accepted File exactly once", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "Spanish.APKG");
    const accepted: File[] = [];

    const result = submitImportIntake([file], (candidate) => accepted.push(candidate));

    expect(result).toEqual({ accepted: true, file });
    expect(accepted).toEqual([file]);
    expect(accepted[0]).toBe(file);
  });

  test("rejects empty, multiple, and wrong-extension intake without calling the service", () => {
    const accepted: File[] = [];
    const receive = (file: File) => accepted.push(file);
    const apkg = new File(["deck"], "deck.apkg");

    expect(submitImportIntake([], receive)).toEqual({
      accepted: false,
      reason: "empty",
      message: IMPORT_INTAKE_HELP,
    });
    expect(submitImportIntake([apkg, apkg], receive)).toEqual({
      accepted: false,
      reason: "multiple",
      message: IMPORT_INTAKE_HELP,
    });
    expect(submitImportIntake([new File(["text"], "deck.txt")], receive)).toEqual({
      accepted: false,
      reason: "invalid-extension",
      message: IMPORT_INTAKE_HELP,
    });
    expect(accepted).toEqual([]);
    expect(APKG_ACCEPT).toBe(".apkg");
  });

  test("reads accepted bytes and invokes the production service contract once", async () => {
    const requests: unknown[] = [];
    const operation = { operationId: "import-test" } as ImportOperation;
    const controller = createImportFileController({
      start(request) {
        requests.push(request);
        return operation;
      },
    }, () => "import-test");
    const file = new File([new Uint8Array([7, 8, 9])], "deck.apkg");

    const started = await controller.start(file);

    expect(started).toBe(operation);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operationId: "import-test",
      fileName: "deck.apkg",
      duplicatePolicy: "cancel",
    });
    expect(Array.from(new Uint8Array(
      (requests[0] as { packageBytes: ArrayBuffer }).packageBytes,
    ))).toEqual([7, 8, 9]);
  });
});

type TestGraph = { readonly decks: readonly unknown[] };

class TestImportOperation implements ImportOperation<TestGraph> {
  public state: ImportState = "preflight";
  public progress: ImportProgress | null = null;
  public warnings = [];
  public cancelCalls = 0;
  private readonly listeners = new Set<(event: ImportEvent<TestGraph>) => void>();
  private resolveResult!: (outcome: ImportOutcome<TestGraph>) => void;
  public readonly result = new Promise<ImportOutcome<TestGraph>>((resolve) => {
    this.resolveResult = resolve;
  });

  public constructor(public readonly operationId: string) {}

  public subscribe(listener: (event: ImportEvent<TestGraph>) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "state", operationId: this.operationId, state: this.state });
    return () => this.listeners.delete(listener);
  }

  public cancel(): boolean {
    if (this.state === "committing" || isTerminal(this.state)) return false;
    this.cancelCalls += 1;
    this.terminal({
      status: "cancelled",
      operationId: this.operationId,
      reason: "caller",
      error: importError("IMPORT_CANCELLED", {
        operationId: this.operationId,
        stage: this.state,
      }),
    });
    return true;
  }

  public emit(event: ImportEvent<TestGraph>): void {
    if (event.type === "state") this.state = event.state;
    if (event.type === "progress") this.progress = event;
    for (const listener of this.listeners) listener(event);
  }

  public terminal(outcome: ImportOutcome<TestGraph>): void {
    this.state = outcome.status;
    this.emit({ type: "terminal", operationId: this.operationId, outcome });
    this.resolveResult(outcome);
  }
}

function isTerminal(state: ImportState): boolean {
  return state === "success"
    || state === "success-with-warnings"
    || state === "cancelled"
    || state === "failed";
}

function progress(
  operationId: string,
  stage: ImportProgress["stage"],
  completed: number,
  total: number | null,
  stageCompleted = completed,
  stageTotal = total,
): Extract<ImportEvent<TestGraph>, { type: "progress" }> {
  return {
    type: "progress",
    operationId,
    stage,
    completed,
    total,
    stageCompleted,
    stageTotal,
  };
}

describe("import progress presentation controller", () => {
  test("formats known, unknown, and zero totals without inventing percentages", () => {
    expect(formatImportProgress("parsing-records", {
      completed: 12,
      total: 20,
      stageCompleted: 4,
      stageTotal: 8,
    })).toBe("Reading cards and notes: 4 of 8.");
    expect(formatImportProgress("importing-media", {
      completed: 12,
      total: null,
      stageCompleted: 3,
      stageTotal: null,
    })).toBe("Importing media: 3 completed.");
    expect(formatImportProgress("preflight", {
      completed: 0,
      total: 0,
      stageCompleted: 0,
      stageTotal: 0,
    })).toBe("Checking the package: 0 of 0.");
  });

  test("publishes every stage but throttles count-only live announcements", async () => {
    let timestamp = 100;
    const operation = new TestImportOperation("import-progress");
    const controller = createImportProgressController<TestGraph>({
      start: async () => operation,
    }, { now: () => timestamp, announcementIntervalMs: 500 });
    const states: typeof controller.state[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.start(new File(["deck"], "deck.apkg"));
    operation.emit(progress(operation.operationId, "preflight", 0, null));
    expect(controller.state.kind === "active" && controller.state.announcement).toBe("");

    timestamp += 600;
    operation.emit(progress(operation.operationId, "preflight", 2, null));
    expect(controller.state.kind === "active" && controller.state.announcement)
      .toBe("Checking the package: 2 completed.");

    operation.emit({
      type: "state",
      operationId: operation.operationId,
      state: "validating-archive",
    });
    expect(controller.state.kind === "active" && controller.state.announcement)
      .toBe("Validating the archive…");
    expect(states.some((state) => state.kind === "active" && state.stage === "preflight")).toBe(true);
  });

  test("requests pre-commit cancellation once and publishes retry guidance", async () => {
    const operation = new TestImportOperation("import-cancel");
    const controller = createImportProgressController<TestGraph>({
      start: async () => operation,
    });
    await controller.start(new File(["deck"], "deck.apkg"));

    expect(controller.state).toMatchObject({ kind: "active", canCancel: true });
    expect(controller.cancel()).toBe(true);
    expect(controller.cancel()).toBe(false);
    expect(operation.cancelCalls).toBe(1);
    expect(controller.state).toMatchObject({
      kind: "terminal",
      outcome: { status: "cancelled" },
      announcement: "Import cancelled. Your saved decks were not changed. Choose a file to try again.",
    });
  });

  test("removes cancellation at commit and prevents a concurrent operation", async () => {
    const operation = new TestImportOperation("import-commit");
    let starts = 0;
    const controller = createImportProgressController<TestGraph>({
      start: async () => {
        starts += 1;
        return operation;
      },
    });
    const file = new File(["deck"], "deck.apkg");
    await controller.start(file);
    expect(await controller.start(file)).toBe(false);
    expect(starts).toBe(1);

    operation.emit({ type: "state", operationId: operation.operationId, state: "committing" });
    expect(controller.state).toMatchObject({
      kind: "active",
      stage: "committing",
      canCancel: false,
    });
    expect(controller.cancel()).toBe(false);
    expect(operation.cancelCalls).toBe(0);
  });

  test("ignores late events and results from an obsolete completed operation", async () => {
    const first = new TestImportOperation("import-first");
    const second = new TestImportOperation("import-second");
    const queue = [first, second];
    const controller = createImportProgressController<TestGraph>({
      start: async () => queue.shift()!,
    });
    const file = new File(["deck"], "deck.apkg");
    await controller.start(file);
    first.terminal({
      status: "failed",
      operationId: first.operationId,
      error: importError("WORKER_FAILED", { operationId: first.operationId }),
    });
    await controller.start(file);
    first.emit(progress(first.operationId, "parsing-records", 9, 10));
    first.terminal({
      status: "success",
      operationId: first.operationId,
      packageSha256: "a".repeat(64),
      warnings: [],
      commit: { importId: "old", deckIds: ["old"] },
    });

    expect(controller.state).toMatchObject({
      kind: "active",
      operationId: second.operationId,
      stage: "preflight",
    });
  });
});
