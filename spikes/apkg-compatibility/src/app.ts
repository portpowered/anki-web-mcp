import { StackWorkerClient } from "./client";
import { ParserWorkerClient, type ParserOptions } from "./parser-client";
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
  }
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
