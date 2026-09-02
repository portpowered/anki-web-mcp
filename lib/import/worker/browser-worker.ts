import type {
  CommitReadyGraph,
  ImportWorkerFactory,
  ImportWorkerHandle,
  ImportWorkerObserver,
  ImportWorkerPort,
} from "../contracts";
import {
  IMPORT_WORKER_PROTOCOL,
  IMPORT_WORKER_PROTOCOL_VERSION,
  type ImportWorkerStartRequest,
} from "../protocol";

export class BrowserImportWorkerFactory<Graph extends CommitReadyGraph = CommitReadyGraph>
implements ImportWorkerFactory<Graph> {
  public create(): ImportWorkerPort<Graph> {
    return new BrowserImportWorkerPort<Graph>();
  }
}

class BrowserImportWorkerPort<Graph extends CommitReadyGraph> implements ImportWorkerPort<Graph> {
  public start(
    request: ImportWorkerStartRequest,
    observer: ImportWorkerObserver<Graph>,
  ): ImportWorkerHandle {
    const worker = new Worker(new URL("./import-worker.ts", import.meta.url), {
      type: "module",
      name: `apkg-import-${request.operationId}`,
    });
    let settled = false;
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!settled) {
        observer.onMessage(event.data);
      }
    });
    worker.addEventListener("error", (event) => {
      if (!settled) {
        observer.onError(event);
      }
    });
    worker.addEventListener("messageerror", (event) => {
      if (!settled) {
        observer.onError(event);
      }
    });
    worker.postMessage(request, [request.packageBytes]);
    return {
      cancel(reason = "caller") {
        if (!settled) {
          worker.postMessage({
            protocol: IMPORT_WORKER_PROTOCOL,
            version: IMPORT_WORKER_PROTOCOL_VERSION,
            type: "cancel",
            operationId: request.operationId,
            reason,
          });
        }
      },
      terminate() {
        settled = true;
        worker.terminate();
      },
    };
  }
}
