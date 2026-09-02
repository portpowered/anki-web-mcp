import { describe, expect, test } from "bun:test";

import {
  APKG_ACCEPT,
  createImportFileController,
  IMPORT_INTAKE_HELP,
  submitImportIntake,
} from "../../lib/application/import-intake-controller";
import type { ImportOperation } from "../../lib/import/contracts";

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
