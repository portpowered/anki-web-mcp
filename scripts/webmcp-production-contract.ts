export const homeToolNames = [
  "list_decks",
  "select_deck",
  "restore_suspended",
] as const;

export const activeStudyToolNames = [
  "get_state",
  "flip",
  "set_state",
  "suspend",
  "go_home",
] as const;

export const emptyStudyToolNames = ["get_state", "go_home"] as const;

export type ProductionToolName =
  | (typeof homeToolNames)[number]
  | (typeof activeStudyToolNames)[number];

export type ProductionToolContract = {
  readonly name: ProductionToolName;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly untrustedContentHint: false;
  };
};

export const homeToolContracts: readonly ProductionToolContract[] = [
  {
    name: "list_decks",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
  },
  {
    name: "select_deck",
    inputSchema: {
      type: "object",
      properties: { deck_id: { type: "string", minLength: 1 } },
      required: ["deck_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
  },
  {
    name: "restore_suspended",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string", minLength: 1 },
        command_id: { type: "string", minLength: 1 },
      },
      required: ["deck_id", "command_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
  },
] as const;

export type InventoryFailureCode =
  | "duplicate-tool"
  | "missing-expected-tool"
  | "mixed-route-inventory"
  | "unexpected-tool";

export type InventoryAssessment = {
  status: "passed" | "failed";
  failureCode: InventoryFailureCode | null;
  observedToolNames: string[];
  expectedToolNames: string[];
  missingToolNames: string[];
  unexpectedToolNames: string[];
};

const allProductionToolNames = new Set<string>([
  ...homeToolNames,
  ...activeStudyToolNames,
]);
const homeTools = new Set<string>(homeToolNames);
const studyTools = new Set<string>(activeStudyToolNames);

/** Fail closed before invocation after the route inventory has settled. */
export function assessProductionInventory(
  observedToolNames: readonly string[],
  expectedToolNames: readonly ProductionToolName[],
): InventoryAssessment {
  const observed = [...observedToolNames];
  const expected = [...expectedToolNames];
  const missing = expected.filter((name) => !observed.includes(name));
  const unexpected = observed.filter((name) => !expected.includes(name as ProductionToolName));
  const duplicate = new Set(observed).size !== observed.length;
  const hasHome = observed.some((name) => homeTools.has(name));
  const hasStudy = observed.some((name) => studyTools.has(name));
  const exact = observed.length === expected.length &&
    expected.every((name) => observed.includes(name));

  let failureCode: InventoryFailureCode | null = null;
  if (duplicate) failureCode = "duplicate-tool";
  else if (hasHome && hasStudy) failureCode = "mixed-route-inventory";
  else if (unexpected.some((name) => !allProductionToolNames.has(name))) {
    failureCode = "unexpected-tool";
  } else if (unexpected.length > 0) failureCode = "mixed-route-inventory";
  else if (missing.length > 0 || !exact) failureCode = "missing-expected-tool";

  return {
    status: failureCode === null ? "passed" : "failed",
    failureCode,
    observedToolNames: observed,
    expectedToolNames: expected,
    missingToolNames: missing,
    unexpectedToolNames: unexpected,
  };
}

export async function invokeAfterInventoryCheck<T>(options: {
  observedToolNames: readonly string[];
  expectedToolNames: readonly ProductionToolName[];
  invoke: () => Promise<T>;
}): Promise<{ assessment: InventoryAssessment; result: T | null }> {
  const assessment = assessProductionInventory(
    options.observedToolNames,
    options.expectedToolNames,
  );
  if (assessment.status === "failed") {
    return { assessment, result: null };
  }
  return { assessment, result: await options.invoke() };
}
