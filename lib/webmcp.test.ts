import { describe, expect, test } from "bun:test";

import {
  createDiagnosticCounterController,
  createStudyDiagnosticController,
  diagnosticToolInputSchema,
  detectWebMcpCapability,
  inspectWebMcpOriginTrial,
  probeWebMcpSurface,
  studyDiagnosticToolInputSchema,
  webMcpOrigin,
  webMcpOriginTrialToken,
} from "./webmcp";

describe("WebMCP capability diagnostics", () => {
  test("recognizes the absent native API without mutating the document", () => {
    const documentLike = {};

    expect(detectWebMcpCapability(documentLike)).toEqual({
      kind: "unavailable",
    });
    expect(documentLike).toEqual({});
  });

  test("recognizes an exposed native modelContext surface", () => {
    expect(
      detectWebMcpCapability({
        modelContext: { registerTool() {} },
      }),
    ).toEqual({ kind: "available" });
  });

  test("reports a capability getter failure separately", () => {
    const documentLike = Object.defineProperty({}, "modelContext", {
      get() {
        throw new Error("browser capability probe failed");
      },
    });

    expect(detectWebMcpCapability(documentLike)).toEqual({ kind: "error" });
  });

  test("requires a native registration method for the route probe", () => {
    expect(probeWebMcpSurface({ modelContext: {} })).toMatchObject({
      kind: "error",
    });
    expect(
      probeWebMcpSurface({
        modelContext: { registerTool() {} },
      }).kind,
    ).toBe("available");
  });

  test("keeps the diagnostic tool input bounded and idempotent", async () => {
    const changes: number[] = [];
    let active = true;
    const controller = createDiagnosticCounterController(
      (counter) => changes.push(counter),
      () => active,
    );

    expect(controller.tool.inputSchema).toEqual(diagnosticToolInputSchema);
    expect(await controller.execute({ amount: 2, command_id: "first" })).toEqual({
      status: "applied",
      code: "ok",
      route: "/",
      command: "webmcp_diagnostic_increment",
      command_id: "first",
      amount: 2,
      counter: 2,
    });
    expect(
      await controller.execute({ amount: 2, command_id: "first" }),
    ).toMatchObject({
      status: "rejected",
      code: "duplicate-command",
      counter: 2,
    });
    expect(
      await controller.execute({ amount: 1.5, command_id: "fraction" }),
    ).toMatchObject({
      status: "rejected",
      code: "invalid-input",
      counter: 2,
    });
    expect(
      await controller.execute({ amount: 1, command_id: "extra", extra: true }),
    ).toMatchObject({
      status: "rejected",
      code: "invalid-input",
      counter: 2,
    });

    const abortController = new AbortController();
    abortController.abort();
    expect(
      await controller.execute(
        { amount: 1, command_id: "aborted" },
        { signal: abortController.signal },
      ),
    ).toMatchObject({
      status: "cancelled",
      code: "execution-cancelled",
      counter: 2,
    });

    active = false;
    expect(
      await controller.execute({ amount: 1, command_id: "inactive" }),
    ).toMatchObject({
      status: "cancelled",
      code: "execution-cancelled",
      counter: 2,
    });
    expect(changes).toEqual([2]);
  });

  test("registers a deck-scoped study tool with structured visible state", async () => {
    const changes: string[] = [];
    const controller = createStudyDiagnosticController(
      "diagnostic",
      (state) => changes.push(`${state.side}:${state.lastCommandId}`),
    );

    expect(controller.tool.name).toBe("webmcp_diagnostic_set_side");
    expect(controller.tool.inputSchema).toEqual(studyDiagnosticToolInputSchema);
    expect(
      await controller.execute({
        deck: "diagnostic",
        side: "back",
        command_id: "study-first",
      }),
    ).toEqual({
      status: "applied",
      code: "ok",
      route: "/study/",
      command: "webmcp_diagnostic_set_side",
      deck: "diagnostic",
      side: "back",
      command_id: "study-first",
      mutation_count: 1,
    });
    expect(controller.getState()).toEqual({
      deck: "diagnostic",
      side: "back",
      lastCommandId: "study-first",
      mutationCount: 1,
    });
    expect(
      await controller.execute({
        deck: "diagnostic",
        side: "front",
        command_id: "study-first",
      }),
    ).toMatchObject({
      status: "rejected",
      code: "duplicate-command",
      side: "front",
      mutation_count: 1,
    });
    expect(
      await controller.execute({
        deck: "other",
        side: "front",
        command_id: "wrong-deck",
      }),
    ).toMatchObject({
      status: "rejected",
      code: "invalid-input",
      mutation_count: 1,
    });
    expect(
      await controller.execute({
        deck: "diagnostic",
        side: "middle",
        command_id: "invalid-side",
      }),
    ).toMatchObject({
      status: "rejected",
      code: "invalid-input",
      mutation_count: 1,
    });
    expect(changes).toEqual(["back:study-first"]);
  });

  test("suppresses stale study mutations and admits only one concurrent command", async () => {
    let active = true;
    const changes: string[] = [];
    const controller = createStudyDiagnosticController(
      "diagnostic",
      (state) => changes.push(`${state.side}:${state.lastCommandId}`),
      () => active,
      20,
    );
    const staleCall = controller.execute({
      deck: "diagnostic",
      side: "back",
      command_id: "stale",
    });
    active = false;
    expect(await staleCall).toMatchObject({
      status: "cancelled",
      code: "execution-cancelled",
      mutation_count: 0,
    });
    expect(controller.getState()).toMatchObject({
      side: "front",
      lastCommandId: null,
      mutationCount: 0,
    });

    active = true;
    const first = controller.execute({
      deck: "diagnostic",
      side: "back",
      command_id: "concurrent",
    });
    const duplicate = controller.execute({
      deck: "diagnostic",
      side: "front",
      command_id: "concurrent",
    });
    const results = await Promise.all([first, duplicate]);
    expect(results.filter((result) => result.status === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.code === "duplicate-command")).toHaveLength(1);
    expect(controller.getState()).toMatchObject({
      side: "back",
      lastCommandId: "concurrent",
      mutationCount: 1,
    });
    expect(changes).toEqual(["back:concurrent"]);

    const abortController = new AbortController();
    const abortedCall = controller.execute(
      {
        deck: "diagnostic",
        side: "front",
        command_id: "aborted",
      },
      { signal: abortController.signal },
    );
    abortController.abort();
    expect(await abortedCall).toMatchObject({
      status: "cancelled",
      code: "execution-cancelled",
      mutation_count: 1,
    });
    expect(changes).toEqual(["back:concurrent"]);
  });

  test("classifies the delivered origin-trial metadata without exposing its token", () => {
    const documentWithToken = {
      location: { origin: webMcpOrigin },
      querySelector: () => ({ content: webMcpOriginTrialToken }),
    };

    expect(
      inspectWebMcpOriginTrial(documentWithToken, { kind: "available" }, 1_700_000_000_000),
    ).toBe("accepted");
    expect(
      inspectWebMcpOriginTrial(documentWithToken, { kind: "unavailable" }, 1_700_000_000_000),
    ).toBe("rejected");
    expect(
      inspectWebMcpOriginTrial(
        {
          location: { origin: "https://other.example" },
          querySelector: () => ({ content: webMcpOriginTrialToken }),
        },
        { kind: "available" },
        1_700_000_000_000,
      ),
    ).toBe("mismatched");
    expect(
      inspectWebMcpOriginTrial(
        { location: { origin: webMcpOrigin }, querySelector: () => null },
        { kind: "available" },
      ),
    ).toBe("not-required");
  });

  test("keeps the customer origin and origin-trial token exact", () => {
    expect(webMcpOrigin).toBe("https://portpowered.github.io");
    expect(webMcpOriginTrialToken).toBe(
      "A/MXFu/smsk8zDkOidDtDxnHQbr502frxTfbhB94iRy6Tc8m6BzqVCh3DibOCvEGdPiGm4+ww+AZkNN77vNnTgkAAABpeyJvcmlnaW4iOiJodHRwczovL3BvcnRwb3dlcmVkLmdpdGh1Yi5pbzo0NDMiLCJmZWF0dXJlIjoiV2ViTUNQIiwiZXhwaXJ5IjoxNzk0ODczNjAwLCJpc1RoaXJkUGFydHkiOnRydWV9",
    );
  });
});
