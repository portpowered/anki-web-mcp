import { StackWorkerClient } from "./client";
import { ParserWorkerClient, type ParserOptions } from "./parser-client";
import { createImportService } from "../../../lib/application/import-service";
import type {
  ImportProgressStage,
  NormalizedImportGraph,
} from "../../../lib/import/contracts";
import { BrowserImportWorkerFactory } from "../../../lib/import/worker/browser-worker";
import { createProductionImportService } from "../../../lib/application/production-import";
import { openDatabase, deleteDatabase } from "../../../lib/persistence/database";
import { createRepositories } from "../../../lib/persistence/repositories";
import {
  STACK_STAGES,
  type ProgressMessage,
  type TerminalMessage,
} from "./protocol";

declare global {
  interface Window {
    apkgParserHarness: {
      parse: (
        packageBytes: Uint8Array | ArrayBuffer,
        options?: ParserOptions,
      ) => ReturnType<ParserWorkerClient["parse"]>;
      replace: (
        packageBytes: Uint8Array | ArrayBuffer,
        options?: ParserOptions,
      ) => ReturnType<ParserWorkerClient["parse"]>;
      cancel: () => void;
    };
    productionImportHarness: {
      run: (
        packageBytes: Uint8Array | ArrayBuffer,
        cancelAtStage?: ImportProgressStage,
      ) => Promise<ProductionImportObservation>;
      persist: (
        packageBytes: Uint8Array | ArrayBuffer,
      ) => Promise<ProductionPersistenceObservation>;
      supersede: (
        packageBytes: Uint8Array | ArrayBuffer,
      ) => Promise<ProductionSupersessionObservation>;
    };
  }
}

interface ProductionImportObservation {
  readonly status: string;
  readonly errorCode: string | null;
  readonly errorStage: string | null;
  readonly errorDetail: string | null;
  readonly progress: readonly ImportProgressStage[];
  readonly monotonicProgress: boolean;
  readonly terminalCount: number;
  readonly heartbeatDelta: number;
  readonly committed: null | {
    readonly layout: string;
    readonly decks: number;
    readonly cards: number;
    readonly media: number;
    readonly mediaBytes: number;
    readonly graphFrozen: boolean;
    readonly recordsFrozen: boolean;
  };
}

interface ProductionPersistenceObservation {
  readonly status: string;
  readonly errorCode: string | null;
  readonly importId: string | null;
  readonly deckIds: readonly string[];
  readonly counts: {
    readonly imports: number;
    readonly decks: number;
    readonly notes: number;
    readonly cards: number;
    readonly schedules: number;
    readonly media: number;
  } | null;
  readonly allSchedulesFresh: boolean;
  readonly mediaBytes: number;
}

interface ProductionSupersessionObservation {
  readonly oldStatus: string;
  readonly replacementStatus: string;
  readonly oldTerminalCount: number;
  readonly replacementTerminalCount: number;
  readonly committedOperationIds: readonly string[];
}

const runButton = getElement<HTMLButtonElement>("run");
const cancelButton = getElement<HTMLButtonElement>("cancel");
const status = getElement<HTMLParagraphElement>("status");
const result = getElement<HTMLPreElement>("result");
const heartbeat = getElement<HTMLParagraphElement>("heartbeat");
const client = new StackWorkerClient();
const parserClient = new ParserWorkerClient();
window.apkgParserHarness = {
  parse: (packageBytes, options) => parserClient.parse(packageBytes, options),
  replace: (packageBytes, options) => parserClient.replace(packageBytes, options),
  cancel: () => parserClient.cancel(),
};
let heartbeatValue = 0;
let cspViolationCount = 0;

window.productionImportHarness = {
  async run(packageBytes, cancelAtStage) {
    const heartbeatStart = heartbeatValue;
    let terminalCount = 0;
    const progress: ImportProgressStage[] = [];
    const completedProgress: number[] = [];
    let committed: ProductionImportObservation["committed"] = null;
    const service = createImportService<NormalizedImportGraph>({
      workerFactory: new BrowserImportWorkerFactory<NormalizedImportGraph>(),
      committer: {
        async commit(input) {
          committed = {
            layout: input.graph.layout,
            decks: input.graph.decks.length,
            cards: input.graph.cards.length,
            media: input.graph.media.length,
            mediaBytes: input.graph.media.reduce(
              (total, item) => total + item.bytes.byteLength,
              0,
            ),
            graphFrozen: Object.isFrozen(input.graph),
            recordsFrozen: Object.isFrozen(input.graph.cards)
              && input.graph.cards.every((card) =>
                Object.isFrozen(card) && Object.isFrozen(card.content)
              ),
          };
          return {
            importId: input.operationId,
            deckIds: input.graph.decks.map((deck) => deck.id),
          };
        },
      },
    });
    const operation = service.start({
      operationId: `browser-production-${crypto.randomUUID()}`,
      packageBytes,
      limits: { maxParseTimeMs: 30_000 },
    });
    operation.subscribe((event) => {
      if (event.type === "progress") {
        progress.push(event.stage);
        completedProgress.push(event.completed);
        if (event.stage === cancelAtStage) {
          operation.cancel();
        }
      } else if (event.type === "terminal") {
        terminalCount += 1;
      }
    });
    const outcome = await operation.result;
    return {
      status: outcome.status,
      errorCode: outcome.status === "failed" || outcome.status === "cancelled"
        ? outcome.error.code
        : null,
      errorStage: outcome.status === "failed" || outcome.status === "cancelled"
        ? outcome.error.stage
        : null,
      errorDetail: outcome.status === "failed" || outcome.status === "cancelled"
        ? outcome.error.detail ?? null
        : null,
      progress,
      monotonicProgress: completedProgress.every(
        (completed, index) => index === 0 || completed >= completedProgress[index - 1]!,
      ),
      terminalCount,
      heartbeatDelta: heartbeatValue - heartbeatStart,
      committed,
    };
  },
  async persist(packageBytes) {
    const databaseName = "anki-web-mcp-browser-import-test";
    await deleteDatabase({ name: databaseName });
    const opened = await openDatabase({ name: databaseName });
    if (!opened.ok) throw new Error(opened.error.message);

    const service = createProductionImportService(opened.value, {
      clock: { now: () => 1_900_000_000_000 },
    });
    const outcome = await service.start({
      operationId: `browser-persist-${crypto.randomUUID()}`,
      packageBytes,
      fileName: "browser-fixture.apkg",
      limits: { maxParseTimeMs: 30_000 },
    }).result;
    opened.value.close();

    if (outcome.status === "failed" || outcome.status === "cancelled") {
      await deleteDatabase({ name: databaseName });
      return {
        status: outcome.status,
        errorCode: outcome.error.code,
        importId: null,
        deckIds: [],
        counts: null,
        allSchedulesFresh: false,
        mediaBytes: 0,
      };
    }

    const reopened = await openDatabase({ name: databaseName });
    if (!reopened.ok) throw new Error(reopened.error.message);
    const repositories = createRepositories(reopened.value);
    const results = await Promise.all([
      repositories.imports.list(),
      repositories.decks.listByImportId(outcome.commit.importId),
      repositories.notes.list(),
      repositories.cards.list(),
      repositories.schedules.list(),
      repositories.media.listByImportId(outcome.commit.importId),
    ]);
    reopened.value.close();
    await deleteDatabase({ name: databaseName });
    if (results.some((result) => !result.ok)) {
      throw new Error("The persisted import graph could not be reopened.");
    }
    const [imports, decks, notes, cards, schedules, media] = results;
    if (!imports.ok || !decks.ok || !notes.ok || !cards.ok || !schedules.ok || !media.ok) {
      throw new Error("The persisted import graph could not be read.");
    }
    return {
      status: outcome.status,
      errorCode: null,
      importId: outcome.commit.importId,
      deckIds: outcome.commit.deckIds,
      counts: {
        imports: imports.value.length,
        decks: decks.value.length,
        notes: notes.value.length,
        cards: cards.value.length,
        schedules: schedules.value.length,
        media: media.value.length,
      },
      allSchedulesFresh: schedules.value.every((schedule) =>
        schedule.state === "new"
        && schedule.reps === 0
        && schedule.lapses === 0
        && schedule.lastReviewAt === null,
      ),
      mediaBytes: media.value.reduce((total, item) => total + item.blob.size, 0),
    };
  },
  async supersede(packageBytes) {
    const committedOperationIds: string[] = [];
    const terminalCounts = new Map<string, number>();
    const service = createImportService<NormalizedImportGraph>({
      workerFactory: new BrowserImportWorkerFactory<NormalizedImportGraph>(),
      committer: {
        async commit(input) {
          committedOperationIds.push(input.operationId);
          return {
            importId: input.operationId,
            deckIds: input.graph.decks.map((deck) => deck.id),
          };
        },
      },
    });
    const oldOperationId = `browser-stale-${crypto.randomUUID()}`;
    const replacementOperationId = `browser-replacement-${crypto.randomUUID()}`;
    let resolveWorkerStart!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      resolveWorkerStart = resolve;
    });
    const oldOperation = service.start({
      operationId: oldOperationId,
      packageBytes,
      limits: { maxParseTimeMs: 30_000 },
    });
    oldOperation.subscribe((event) => {
      if (event.type === "progress" && event.stage === "validating-archive") {
        resolveWorkerStart();
      }
      if (event.type === "terminal") {
        terminalCounts.set(oldOperationId, (terminalCounts.get(oldOperationId) ?? 0) + 1);
      }
    });
    await workerStarted;
    const replacement = service.supersede(oldOperationId, {
      operationId: replacementOperationId,
      packageBytes,
      limits: { maxParseTimeMs: 30_000 },
    });
    replacement.subscribe((event) => {
      if (event.type === "terminal") {
        terminalCounts.set(
          replacementOperationId,
          (terminalCounts.get(replacementOperationId) ?? 0) + 1,
        );
      }
    });
    const [oldOutcome, replacementOutcome] = await Promise.all([
      oldOperation.result,
      replacement.result,
    ]);
    return {
      oldStatus: oldOutcome.status,
      replacementStatus: replacementOutcome.status,
      oldTerminalCount: terminalCounts.get(oldOperationId) ?? 0,
      replacementTerminalCount: terminalCounts.get(replacementOperationId) ?? 0,
      committedOperationIds,
    };
  },
};

window.addEventListener("securitypolicyviolation", () => {
  cspViolationCount += 1;
});

const heartbeatTimer = window.setInterval(() => {
  heartbeatValue += 1;
  heartbeat.dataset.heartbeat = String(heartbeatValue);
  heartbeat.textContent = String(heartbeatValue);
}, 10);

runButton.addEventListener("click", () => {
  void runEvaluation();
});
cancelButton.addEventListener("click", () => client.cancel());
window.addEventListener("pagehide", () => {
  window.clearInterval(heartbeatTimer);
  client.dispose();
  parserClient.dispose();
});

async function runEvaluation(): Promise<void> {
  runButton.disabled = true;
  cancelButton.disabled = false;
  cspViolationCount = 0;
  status.dataset.status = "running";
  status.dataset.stage = "starting";
  status.textContent = "Starting the browser Worker…";
  result.textContent = "Evaluation in progress…";

  try {
    const pauseAfterProgressStage = getPauseStage();
    const terminal = await client.evaluate(
      { onProgress: renderProgress },
      {
        checkpointDelayMs: 50,
        pauseAfterProgressStage,
        pauseAfterProgressMs: pauseAfterProgressStage ? 1_000 : undefined,
      },
    );
    renderTerminal(terminal);
  } catch (error) {
    status.dataset.status = "error";
    status.dataset.stage = "unknown";
    status.textContent = "The browser Worker could not be reached.";
    result.textContent = JSON.stringify(
      { error: error instanceof Error ? error.message : "UnknownError" },
      null,
      2,
    );
  } finally {
    runButton.disabled = false;
    cancelButton.disabled = true;
  }
}

function getPauseStage(): (typeof STACK_STAGES)[number] | undefined {
  const requestedStage = new URLSearchParams(window.location.search).get(
    "pauseAfterProgress",
  );
  return STACK_STAGES.find((stage) => stage === requestedStage);
}

function renderProgress(message: ProgressMessage): void {
  status.dataset.stage = message.stage;
  status.textContent = `Worker stage: ${message.stage} (${message.completed}/${message.total})`;
}

function renderTerminal(terminal: TerminalMessage): void {
  status.dataset.status = terminal.status;
  status.dataset.stage = terminal.status;
  status.textContent = `Worker evaluation: ${terminal.status}`;
  result.textContent = JSON.stringify(
    terminal.status === "success"
      ? { ...terminal, cspViolationCount, mainThreadHeartbeat: heartbeatValue }
      : terminal,
    null,
    2,
  );
}

function getElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required probe element: ${id}`);
  }
  return element as unknown as T;
}
