import type {
  CommitReadyGraph,
  ImportOperation,
  ImportService,
} from "../import/contracts";

export const APKG_ACCEPT = ".apkg" as const;
export const IMPORT_INTAKE_HELP = "Choose exactly one .apkg file to import.";

export type ImportIntakeRejection = "empty" | "multiple" | "invalid-extension";

export type ImportIntakeResult =
  | { readonly accepted: true; readonly file: File }
  | {
      readonly accepted: false;
      readonly reason: ImportIntakeRejection;
      readonly message: typeof IMPORT_INTAKE_HELP;
    };

export type ImportFileController<Graph extends CommitReadyGraph = CommitReadyGraph> = {
  start(file: File): Promise<ImportOperation<Graph>>;
};

/**
 * Validate all browser intake paths through one application-owned boundary.
 * The accepted File object is forwarded unchanged and at most once.
 */
export function submitImportIntake(
  files: ArrayLike<File> | readonly File[],
  onAccepted: (file: File) => void,
): ImportIntakeResult {
  if (files.length === 0) {
    return reject("empty");
  }
  if (files.length !== 1) {
    return reject("multiple");
  }

  const file = files[0];
  if (!file || !file.name.toLocaleLowerCase().endsWith(APKG_ACCEPT)) {
    return reject("invalid-extension");
  }

  onAccepted(file);
  return { accepted: true, file };
}

/** Convert the accepted browser File into the production service request. */
export function createImportFileController<Graph extends CommitReadyGraph>(
  service: Pick<ImportService<Graph>, "start">,
  createOperationId: () => string = defaultOperationId,
): ImportFileController<Graph> {
  return {
    async start(file) {
      const packageBytes = await file.arrayBuffer();
      return service.start({
        operationId: createOperationId(),
        fileName: file.name,
        packageBytes,
        duplicatePolicy: "cancel",
      });
    },
  };
}

function reject(reason: ImportIntakeRejection): ImportIntakeResult {
  return { accepted: false, reason, message: IMPORT_INTAKE_HELP };
}

function defaultOperationId(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `import-${suffix}`;
}
