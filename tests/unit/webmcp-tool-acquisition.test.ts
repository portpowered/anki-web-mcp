import { describe, expect, test } from "bun:test";

import {
  acquireCurrentPageTool,
} from "../../scripts/webmcp-tool-acquisition";

type Tool = {
  name: string;
  generation: number;
  invoke: () => string;
};

const studyNames = ["get_state", "flip", "set_state", "suspend", "go_home"];
const homeNames = ["list_decks", "select_deck", "restore_suspended"];

function generation(value: number): Tool[] {
  return studyNames.map((name) => ({
    name,
    generation: value,
    invoke: () => `${name}:${value}`,
  }));
}

async function acquire(
  getTools: () => Promise<Tool[]>,
  overrides: Partial<Parameters<typeof acquireCurrentPageTool<Tool>>[0]> = {},
) {
  return await acquireCurrentPageTool({
    getTools,
    readRouteIdentity: () => "study:https://example.test/study/?deck=one",
    expectedRouteIdentity: "study:https://example.test/study/?deck=one",
    expectedToolNames: studyNames,
    otherRouteToolNames: homeNames,
    requestedName: "suspend",
    timeoutMs: 5,
    pollIntervalMs: 0,
    ...overrides,
  });
}

async function failureCode(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error("expected acquisition to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("CurrentToolAcquisitionError");
    return (error as Error & { code: string }).code;
  }
}

describe("current page-scoped WebMCP tool acquisition", () => {
  test("reacquires the rotated suspend object and never invokes the retired handle", async () => {
    const firstGeneration = generation(1);
    const retiredSuspend = firstGeneration.find((tool) => tool.name === "suspend")!;
    retiredSuspend.invoke = () => {
      throw new DOMException("native proxy is no longer registered", "UnknownError");
    };
    const currentGeneration = generation(2);
    let retryInvokedGeneration: number | null = null;
    currentGeneration.find((tool) => tool.name === "suspend")!.invoke = () => {
      retryInvokedGeneration = 2;
      return "idempotent-retry";
    };

    try {
      retiredSuspend.invoke();
      throw new Error("retired native handle unexpectedly remained callable");
    } catch (error) {
      expect((error as Error).name).toBe("UnknownError");
    }

    const acquired = await acquire(async () => currentGeneration, {
      previousTool: retiredSuspend,
    });

    expect(acquired.tool).not.toBe(retiredSuspend);
    expect(acquired.inventory.every((tool) => tool.generation === 2)).toBe(true);
    expect(acquired.tool.invoke()).toBe("idempotent-retry");
    expect(retryInvokedGeneration === 2).toBe(true);
  });

  test("waits within its bound for one exact coherent inventory", async () => {
    const current = generation(2);
    const observations = [
      generation(1),
      [current[0]!, current[1]!],
      current,
    ];
    const retired = observations[0]!.find((tool) => tool.name === "suspend")!;
    let index = 0;
    const acquired = await acquire(async () => observations[Math.min(index++, 2)]!, {
      previousTool: retired,
      timeoutMs: 50,
    });

    expect(acquired.attempts).toBe(3);
    expect(acquired.tool.generation).toBe(2);
    expect(acquired.toolNames).toEqual(studyNames);
  });

  test.each([
    ["missing requested name", studyNames.filter((name) => name !== "suspend"), "missing-expected-tool"],
    ["duplicate requested name", [...studyNames, "suspend"], "duplicate-tool"],
    ["duplicate unrelated name", [...studyNames, "flip"], "duplicate-tool"],
    ["unexpected name", [...studyNames, "debug"], "unexpected-tool"],
    ["mixed home and study names", [...studyNames, "list_decks"], "mixed-route-inventory"],
  ] as const)("rejects %s", async (_label, names, code) => {
    const tools = names.map((name) => ({ name, generation: 2, invoke: () => name }));
    expect(await failureCode(acquire(async () => tools))).toBe(code);
  });

  test("rejects an obsolete snapshot and times out with stable attribution", async () => {
    const stale = generation(1);
    const oldSuspend = stale.find((tool) => tool.name === "suspend")!;
    const operation = acquire(async () => stale, { previousTool: oldSuspend });
    expect(await failureCode(operation)).toBe("obsolete-inventory");
  });

  test("fails closed when the route changes while getTools is pending", async () => {
    let route = "study:https://example.test/study/?deck=one";
    const operation = acquire(async () => {
      route = "home:https://example.test/";
      return generation(2);
    }, { readRouteIdentity: () => route });
    expect(await failureCode(operation)).toBe("route-changed");
  });

  test("is self-contained when serialized into the production page", async () => {
    const serialized = (0, eval)(`(${acquireCurrentPageTool.toString()})`) as
      typeof acquireCurrentPageTool<Tool>;
    const current = generation(2);
    const acquired = await serialized({
      getTools: async () => current,
      readRouteIdentity: () => "study:one",
      expectedRouteIdentity: "study:one",
      expectedToolNames: studyNames,
      otherRouteToolNames: homeNames,
      requestedName: "suspend",
      timeoutMs: 5,
      pollIntervalMs: 0,
    });
    expect(acquired.tool.name).toBe("suspend");
  });
});
