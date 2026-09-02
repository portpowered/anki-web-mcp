/// <reference lib="webworker" />

import { ImportWorkerRuntime } from "./runtime";

const workerScope = self as DedicatedWorkerGlobalScope;
const runtime = new ImportWorkerRuntime({
  postMessage(message) {
    workerScope.postMessage(message);
  },
});

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  runtime.receive(event.data);
});
