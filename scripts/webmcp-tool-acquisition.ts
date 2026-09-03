export type PageTool = {
  readonly name?: string;
};

export type CurrentToolAcquisitionFailureCode =
  | "discovery-timeout"
  | "duplicate-tool"
  | "missing-expected-tool"
  | "mixed-route-inventory"
  | "obsolete-inventory"
  | "route-changed"
  | "unexpected-tool";

export type CurrentToolAcquisition<Tool extends PageTool> = {
  tool: Tool;
  inventory: Tool[];
  toolNames: string[];
  attempts: number;
  routeIdentity: string;
};

/**
 * Resolve one tool from one coherent, current page inventory.
 *
 * The function is deliberately self-contained so the production Playwright probe can
 * serialize it into the inspected page without substituting a mock WebMCP boundary.
 */
export async function acquireCurrentPageTool<Tool extends PageTool>(options: {
  getTools: () => Promise<Tool[]>;
  readRouteIdentity: () => string;
  expectedRouteIdentity: string;
  expectedToolNames: readonly string[];
  otherRouteToolNames: readonly string[];
  requestedName: string;
  previousTool?: Tool;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<CurrentToolAcquisition<Tool>> {
  const failure = (
    code: CurrentToolAcquisitionFailureCode,
    attempts: number,
    observedToolNames: readonly string[],
  ): Error => Object.assign(
    new Error(
      `current-tool-acquisition:${code}:${options.requestedName}:attempts=${attempts}:observed=${
        observedToolNames.join(",")
      }`,
    ),
    {
      name: "CurrentToolAcquisitionError",
      code,
      requestedName: options.requestedName,
      attempts,
      observedToolNames,
    },
  );
  const deadline = Date.now() + options.timeoutMs;
  let attempts = 0;
  let lastCode: CurrentToolAcquisitionFailureCode = "missing-expected-tool";
  let lastNames: string[] = [];

  do {
    attempts += 1;
    const routeBefore = options.readRouteIdentity();
    if (routeBefore !== options.expectedRouteIdentity) {
      throw failure("route-changed", attempts, []);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw failure("discovery-timeout", attempts, lastNames);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const discoveryTimeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(failure("discovery-timeout", attempts, lastNames)),
        remainingMs,
      );
    });
    let inventory: Tool[];
    try {
      inventory = await Promise.race([
        Promise.resolve().then(() => options.getTools()),
        discoveryTimeout,
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    const routeAfter = options.readRouteIdentity();
    const names = inventory.map((tool) => tool.name ?? "");
    lastNames = names;
    if (routeAfter !== routeBefore || routeAfter !== options.expectedRouteIdentity) {
      throw failure("route-changed", attempts, names);
    }

    const expected = new Set(options.expectedToolNames);
    const otherRoute = new Set(options.otherRouteToolNames);
    const duplicate = new Set(names).size !== names.length;
    const unexpected = names.filter((name) => !expected.has(name));
    const missing = options.expectedToolNames.filter((name) => !names.includes(name));
    const candidates = inventory.filter((tool) => tool.name === options.requestedName);

    if (duplicate) lastCode = "duplicate-tool";
    else if (unexpected.some((name) => otherRoute.has(name))) lastCode = "mixed-route-inventory";
    else if (unexpected.length > 0) lastCode = "unexpected-tool";
    else if (missing.length > 0 || inventory.length !== options.expectedToolNames.length ||
        candidates.length !== 1) {
      lastCode = "missing-expected-tool";
    } else if (options.previousTool !== undefined && candidates[0] === options.previousTool) {
      lastCode = "obsolete-inventory";
    } else {
      return {
        tool: candidates[0]!,
        inventory: [...inventory],
        toolNames: names,
        attempts,
        routeIdentity: routeAfter,
      };
    }

    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
    }
  } while (Date.now() < deadline);

  throw failure(lastCode, attempts, lastNames);
}
