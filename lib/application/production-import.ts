import type { NormalizedImportGraph } from "../import/contracts";
import type { ImportLimitsInput } from "../import/limits";
import { BrowserImportWorkerFactory } from "../import/worker/browser-worker";
import {
  createIndexedDbImportCommitter,
  type IndexedDbImportCommitterOptions,
} from "../persistence/import-commit";
import { createImportService } from "./import-service";

export interface ProductionImportServiceOptions
extends IndexedDbImportCommitterOptions {
  defaultLimits?: ImportLimitsInput;
}

/** Wire the production dedicated Worker to the atomic IndexedDB committer. */
export function createProductionImportService(
  database: IDBDatabase,
  options: ProductionImportServiceOptions = {},
) {
  const { defaultLimits, ...committerOptions } = options;
  return createImportService<NormalizedImportGraph>({
    workerFactory: new BrowserImportWorkerFactory<NormalizedImportGraph>(),
    committer: createIndexedDbImportCommitter(database, committerOptions),
    defaultLimits,
  });
}
