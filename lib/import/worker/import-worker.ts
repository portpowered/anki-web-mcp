/// <reference lib="webworker" />

import { ImportWorkerRuntime } from "./runtime";

const workerScope = self as DedicatedWorkerGlobalScope;
const runtime = new ImportWorkerRuntime({
  postMessage(message, transfer = []) {
    workerScope.postMessage(message, transfer);
  },
});

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  runtime.receive(event.data);
});
