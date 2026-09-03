import { describe, expect, test } from "bun:test";

import {
  activeStudyToolNames,
  assessProductionInventory,
  emptyStudyToolNames,
  homeToolNames,
  invokeAfterInventoryCheck,
} from "../../scripts/webmcp-production-contract";

describe("production WebMCP discovery contract", () => {
  test("accepts only the complete route/state inventories", () => {
    expect(assessProductionInventory(homeToolNames, homeToolNames)).toMatchObject({
      status: "passed",
      failureCode: null,
    });
    expect(
      assessProductionInventory(
        ["restore_suspended", "list_decks", "select_deck"],
        homeToolNames,
      ),
    ).toMatchObject({ status: "passed", failureCode: null });
    expect(assessProductionInventory(activeStudyToolNames, activeStudyToolNames)).toMatchObject({
      status: "passed",
      failureCode: null,
    });
    expect(assessProductionInventory(emptyStudyToolNames, emptyStudyToolNames)).toMatchObject({
      status: "passed",
      failureCode: null,
    });
  });

  test.each([
    {
      name: "removed diagnostic tool",
      observed: ["webmcp_diagnostic_increment"],
      expected: homeToolNames,
      code: "unexpected-tool",
    },
    {
      name: "missing expected tool",
      observed: ["list_decks", "select_deck"],
      expected: homeToolNames,
      code: "missing-expected-tool",
    },
    {
      name: "unexpected tool",
      observed: [...homeToolNames, "delete_deck"],
      expected: homeToolNames,
      code: "unexpected-tool",
    },
    {
      name: "mixed route inventory",
      observed: ["list_decks", "select_deck", "restore_suspended", "get_state"],
      expected: homeToolNames,
      code: "mixed-route-inventory",
    },
  ] as const)("rejects $name with observed and expected scope before calling", async ({
    observed,
    expected,
    code,
  }) => {
    let calls = 0;
    const outcome = await invokeAfterInventoryCheck({
      observedToolNames: observed,
      expectedToolNames: expected,
      invoke: async () => ++calls,
    });

    expect(outcome.result).toBeNull();
    expect(calls).toBe(0);
    expect(outcome.assessment).toMatchObject({
      status: "failed",
      failureCode: code,
      observedToolNames: [...observed],
      expectedToolNames: [...expected],
    });
  });
});
