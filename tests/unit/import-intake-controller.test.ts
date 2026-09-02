import { describe, expect, test } from "bun:test";

import {
  APKG_ACCEPT,
  createImportFileController,
  createImportProgressController,
  formatImportProgress,
  isDurableImportSuccess,
  importFailurePresentation,
  importWarningMessage,
  IMPORT_INTAKE_HELP,
  submitImportIntake,
} from "../../lib/application/import-intake-controller";
import { createNormalizedImportReport } from "../../lib/application/production-import";
import { importError } from "../../lib/import/errors";
import type {
  ImportEvent,
  ImportOperation,
  ImportOutcome,
  ImportProgress,
  ImportState,
  NormalizedImportGraph,
} from "../../lib/import/contracts";

describe("APKG import intake controller", () => {
  test("identifies only service-confirmed durable terminal outcomes", () => {
    const successOutcome: ImportOutcome<NormalizedImportGraph> = {
      status: "success",
      operationId: "durable-success",
      packageSha256: "a".repeat(64),
      warnings: [],
      commit: { importId: "import", deckIds: ["deck"] },
    };

    expect(isDurableImportSuccess({
      kind: "terminal",
      operationId: successOutcome.operationId,
      outcome: successOutcome,
      announcement: "saved",
    })).toBe(true);
    expect(isDurableImportSuccess({
      kind: "terminal",
      operationId: "failed",
      outcome: {
        status: "failed",
        operationId: "failed",
        error: importError("COMMIT_FAILED", { operationId: "failed" }),
      },
      announcement: "not saved",
    })).toBe(false);
    expect(isDurableImportSuccess({
      kind: "duplicate-cancelled",
      operationId: "duplicate",
      announcement: "cancelled",
    })).toBe(false);
  });

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

  test("opts into replacement only with an explicit existing import target", async () => {
    const requests: unknown[] = [];
    const operation = { operationId: "import-replace" } as ImportOperation;
    const checksum = "d".repeat(64);
    const controller = createImportFileController({
      start(request) {
        requests.push(request);
        return operation;
      },
    }, () => "import-replace");

    await controller.start(
      new File([new Uint8Array([1])], "deck.apkg"),
      { replacementImportId: checksum },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      duplicatePolicy: "replace",
      replacementImportId: checksum,
    });
  });
});

describe("safe import report metadata", () => {
  test("derives only deck identity and safe aggregate counts from the validated graph", () => {
    const graph = {
      decks: [{ id: "deck-1", name: "Spanish <script>alert(1)</script>" }, { id: "deck-2", name: "Travel" }],
      notes: [{}, {}, {}],
      cards: [
        { deckId: "deck-1" },
        { deckId: "deck-1" },
        { deckId: "deck-2" },
      ],
      media: [{}, {}],
    } as unknown as NormalizedImportGraph;

    expect(createNormalizedImportReport(graph)).toEqual({
      decks: [
        { id: "deck-1", name: "Spanish <script>alert(1)</script>", cardCount: 2 },
        { id: "deck-2", name: "Travel", cardCount: 1 },
      ],
      deckCount: 2,
      noteCount: 3,
      cardCount: 3,
      mediaCount: 2,
    });
  });

  test("maps diagnostic codes to application-owned copy", () => {
    expect(importWarningMessage("UNSAFE_CONTENT_REMOVED"))
      .toBe("Unsafe imported content was removed.");
    expect(importFailurePresentation("ARCHIVE_INVALID", false)).toMatchObject({
      heading: "Package could not be read",
      action: "choose-another",
    });
    expect(importFailurePresentation("QUOTA_EXCEEDED", true)).toMatchObject({
      heading: "Not enough storage",
      action: "retry",
    });
    expect(importFailurePresentation("WORKER_FAILED", true)).toMatchObject({
      heading: "Importer stopped responding",
      action: "retry",
    });
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

  test("requests a route refresh once and only after durable success", async () => {
    const failed = new TestImportOperation("import-failed");
    const committed = new TestImportOperation("import-committed");
    const queue = [failed, committed];
    const refreshes: string[] = [];
    const controller = createImportProgressController<TestGraph>({
      start: async () => queue.shift()!,
    }, {
      onDurableSuccess: (outcome) => {
        refreshes.push(outcome.commit.importId);
      },
    });
    const file = new File(["deck"], "deck.apkg");

    await controller.start(file);
    failed.terminal({
      status: "failed",
      operationId: failed.operationId,
      error: importError("COMMIT_FAILED", { operationId: failed.operationId }),
    });
    expect(refreshes).toEqual([]);

    await controller.start(file);
    committed.terminal({
      status: "success",
      operationId: committed.operationId,
      packageSha256: "a".repeat(64),
      warnings: [],
      commit: { importId: "durable-import", deckIds: ["deck-a", "deck-b"] },
    });
    await committed.result;

    expect(refreshes).toEqual(["durable-import"]);
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

  test("holds a duplicate at the safe cancel choice without starting replacement", async () => {
    const checksum = "a".repeat(64);
    const duplicate = new TestImportOperation("import-duplicate");
    const starts: Array<{ file: File; replacement?: { replacementImportId: string } }> = [];
    const controller = createImportProgressController<TestGraph>({
      start: async (file, replacement) => {
        starts.push({ file, replacement });
        return duplicate;
      },
    });
    const file = new File(["deck"], "deck.apkg");

    await controller.start(file);
    duplicate.terminal({
      status: "failed",
      operationId: duplicate.operationId,
      error: importError("DUPLICATE_IMPORT", {
        operationId: duplicate.operationId,
        detail: checksum,
      }),
    });

    expect(controller.state).toEqual({
      kind: "duplicate",
      operationId: duplicate.operationId,
      existingImportId: checksum,
      announcement: "Duplicate package found. Cancel import is the safe default.",
    });
    expect(starts).toEqual([{ file, replacement: undefined }]);
    expect(controller.cancelDuplicate()).toBe(true);
    expect(controller.cancelDuplicate()).toBe(false);
    expect(controller.state).toMatchObject({ kind: "duplicate-cancelled" });
    expect(starts).toHaveLength(1);
  });

  test("starts one explicit replacement with the retained original File and target", async () => {
    const checksum = "b".repeat(64);
    const duplicate = new TestImportOperation("import-duplicate");
    const replacement = new TestImportOperation("import-replacement");
    const operations = [duplicate, replacement];
    const starts: Array<{ file: File; replacement?: { replacementImportId: string } }> = [];
    const controller = createImportProgressController<TestGraph>({
      start: async (file, options) => {
        starts.push({ file, replacement: options });
        return operations.shift()!;
      },
    });
    const file = new File(["deck"], "deck.apkg");
    await controller.start(file);
    duplicate.terminal({
      status: "failed",
      operationId: duplicate.operationId,
      error: importError("DUPLICATE_IMPORT", { detail: checksum }),
    });

    const firstConfirmation = controller.confirmDuplicateReplacement();
    const repeatedConfirmation = controller.confirmDuplicateReplacement();
    expect(await firstConfirmation).toBe(true);
    expect(await repeatedConfirmation).toBe(false);
    expect(starts).toEqual([
      { file, replacement: undefined },
      { file, replacement: { replacementImportId: checksum } },
    ]);
    expect(controller.state).toMatchObject({
      kind: "active",
      operationId: replacement.operationId,
    });
  });

  test("offers retry or safe cancellation after an atomic replacement failure", async () => {
    const checksum = "c".repeat(64);
    const duplicate = new TestImportOperation("import-duplicate");
    const failedReplacement = new TestImportOperation("import-replacement-failed");
    const retry = new TestImportOperation("import-replacement-retry");
    const operations = [duplicate, failedReplacement, retry];
    const replacements: Array<{ replacementImportId: string } | undefined> = [];
    const controller = createImportProgressController<TestGraph>({
      start: async (_file, options) => {
        replacements.push(options);
        return operations.shift()!;
      },
    });
    await controller.start(new File(["deck"], "deck.apkg"));
    duplicate.terminal({
      status: "failed",
      operationId: duplicate.operationId,
      error: importError("DUPLICATE_IMPORT", { detail: checksum }),
    });
    await controller.confirmDuplicateReplacement();
    failedReplacement.terminal({
      status: "failed",
      operationId: failedReplacement.operationId,
      error: importError("REPLACE_FAILED"),
    });

    expect(controller.state).toMatchObject({
      kind: "terminal",
      canRetryReplacement: true,
      outcome: { status: "failed", error: { code: "REPLACE_FAILED" } },
    });
    expect(await controller.retryReplacement()).toBe(true);
    expect(replacements).toEqual([
      undefined,
      { replacementImportId: checksum },
      { replacementImportId: checksum },
    ]);

    retry.terminal({
      status: "failed",
      operationId: retry.operationId,
      error: importError("REPLACE_FAILED"),
    });
    expect(controller.cancelDuplicate()).toBe(true);
    expect(controller.state).toMatchObject({ kind: "duplicate-cancelled" });
  });

  test("retries a recoverable failure once with the retained File and dismisses terminal state", async () => {
    const failed = new TestImportOperation("import-worker-failed");
    const retry = new TestImportOperation("import-worker-retry");
    const operations = [failed, retry];
    const files: File[] = [];
    const controller = createImportProgressController<TestGraph>({
      start: async (file) => {
        files.push(file);
        return operations.shift()!;
      },
    });
    const file = new File(["deck"], "deck.apkg");
    await controller.start(file);
    failed.terminal({
      status: "failed",
      operationId: failed.operationId,
      error: importError("WORKER_FAILED"),
    });

    expect(controller.state).toMatchObject({ kind: "terminal", canRetryImport: true });
    expect(await controller.retryImport()).toBe(true);
    expect(await controller.retryImport()).toBe(false);
    expect(files).toEqual([file, file]);

    retry.terminal({
      status: "failed",
      operationId: retry.operationId,
      error: importError("INVALID_PACKAGE"),
    });
    expect(controller.state).toMatchObject({ kind: "terminal", canRetryImport: false });
    expect(controller.dismiss()).toBe(true);
    expect(controller.dismiss()).toBe(false);
    expect(controller.state).toEqual({ kind: "idle" });
  });
});
