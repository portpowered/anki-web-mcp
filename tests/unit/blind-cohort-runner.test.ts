import { describe, expect, test } from "bun:test";

import type { PublicWebMcpPort, SemanticBrowserPort } from "../../scripts/blind-cohort/contract";
import {
  REQUIRED_BROWSER_VERSION,
  runBlindCohort,
  type BlindCohortRunnerOptions,
  type ProbeAgentContext,
  type ProbeAttemptResult,
  type ProbeBrowserContext,
  type ProbeTerminalStatus,
} from "../../scripts/blind-cohort/runner";

const semanticBrowser: SemanticBrowserPort = {
  observe: async () => ({}),
  activate: async () => ({}),
  enterText: async () => ({}),
  attachFixture: async () => ({}),
};
const publicWebMcp: PublicWebMcpPort = {
  discover: async () => [],
  invoke: async () => ({}),
};

type Evidence = {
  probeId: string;
  status: string;
  passed: boolean;
  firstFailure: { reason: string } | null;
};
type Overrides = {
  browser?: (probeId: string, ordinal: number) => Partial<ProbeBrowserContext>;
  agent?: (probeId: string, ordinal: number) => Partial<ProbeAgentContext>;
  finalize?: BlindCohortRunnerOptions<Evidence>["finalizeEvidence"];
  timeoutMs?: number;
  signal?: AbortSignal;
};

function harness(overrides: Overrides = {}) {
  const events: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let browserOrdinal = 0;
  let agentOrdinal = 0;

  const options: BlindCohortRunnerOptions<Evidence> = {
    concurrency: 1,
    timeoutMs: overrides.timeoutMs ?? 100,
    signal: overrides.signal,
    browserFactory: {
      create: async ({ probeId, browserVersion, viewport }) => {
        const ordinal = ++browserOrdinal;
        events.push(`browser:create:${probeId}:${browserVersion}:${viewport.width}`);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const base: ProbeBrowserContext = {
          profileId: `profile-${ordinal}`,
          userDataDirectory: `C:\\disposable\\profile-${ordinal}`,
          browserVersion: REQUIRED_BROWSER_VERSION,
          semanticBrowser,
          publicWebMcp,
          verifyIndexedDbEmpty: async () => {
            events.push(`idb:empty:${probeId}`);
            return true;
          },
          close: async () => { events.push(`browser:close:${probeId}`); },
          removeProfile: async () => {
            events.push(`profile:remove:${probeId}`);
            active -= 1;
          },
        };
        return Object.assign(base, overrides.browser?.(probeId, ordinal));
      },
    },
    agentFactory: {
      create: async ({ probeId }) => {
        const ordinal = ++agentOrdinal;
        events.push(`agent:create:${probeId}`);
        const base: ProbeAgentContext = {
          contextId: `agent-${ordinal}`,
          run: async (_input, { attempt }) => {
            events.push(`agent:run:${probeId}:${attempt}`);
            return { status: "passed" };
          },
          close: async () => { events.push(`agent:close:${probeId}`); },
        };
        return Object.assign(base, overrides.agent?.(probeId, ordinal));
      },
    },
    finalizeEvidence: overrides.finalize ?? (async ({ task, status }) => {
      events.push(`evidence:${task.id}:${status}`);
      return { probeId: task.id, status, passed: status === "passed", firstFailure: null };
    }),
  };
  return { options, events, maximumActive: () => maximumActive };
}

describe("blind cohort serial isolation runner", () => {
  test("runs all ten probes numerically with fresh contexts and closes each profile before the next", async () => {
    const fixture = harness();
    const result = await runBlindCohort(fixture.options);

    expect(result.status).toBe("passed");
    expect(result.records.map((record) => String(record.probeId))).toEqual(
      Array.from({ length: 10 }, (_, index) => `probe-${index + 1}`),
    );
    expect(new Set(result.records.map((record) => record.agentContextId)).size).toBe(10);
    expect(new Set(result.records.map((record) => record.browserProfileId)).size).toBe(10);
    expect(fixture.maximumActive()).toBe(1);
    for (let number = 1; number <= 10; number += 1) {
      const probeId = `probe-${number}`;
      expect(fixture.events.indexOf(`idb:empty:${probeId}`)).toBeLessThan(
        fixture.events.indexOf(`agent:create:${probeId}`),
      );
      expect(fixture.events.indexOf(`evidence:${probeId}:passed`)).toBeLessThan(
        fixture.events.indexOf(`browser:close:${probeId}`),
      );
      if (number < 10) {
        expect(fixture.events.indexOf(`profile:remove:${probeId}`)).toBeLessThan(
          fixture.events.findIndex((event) => event.startsWith(`browser:create:probe-${number + 1}:`)),
        );
      }
    }
  });

  test("rejects concurrency rather than coercing it before starting a browser", async () => {
    const fixture = harness();
    await expect(runBlindCohort({
      ...fixture.options,
      concurrency: 2 as 1,
    })).rejects.toEqual(expect.objectContaining({ code: "invalid-concurrency" }));
    expect(fixture.events).toEqual([]);
  });

  test("allows one retry only after a clear structured error and reuses the same context", async () => {
    const outcomes: ProbeAttemptResult[] = [
      {
        status: "failed",
        requestSelfRecovery: true,
        structuredError: { code: "stale-state", message: "State changed", recoverable: true },
      },
      { status: "passed" },
    ];
    const fixture = harness({
      agent: (probeId) => probeId === "probe-1" ? {
        run: async (_input, { attempt }) => {
          fixture.events.push(`agent:run:${probeId}:${attempt}`);
          return outcomes.shift()!;
        },
      } : {},
    });
    const result = await runBlindCohort(fixture.options);

    expect(result.status).toBe("passed");
    expect(result.records[0]).toEqual(expect.objectContaining({ retryCount: 1, status: "passed" }));
    expect(fixture.events.filter((event) => event === "agent:create:probe-1")).toHaveLength(1);
    expect(fixture.events.filter((event) => event.startsWith("browser:create:probe-1:"))).toHaveLength(1);
  });

  test.each([
    ["unstructured retry", { status: "failed", requestSelfRecovery: true } satisfies ProbeAttemptResult],
    ["human-assisted retry", { status: "failed", humanHintUsed: true } satisfies ProbeAttemptResult],
  ])("fails and stops on %s", async (_label, outcome) => {
    const fixture = harness({ agent: (probeId) => probeId === "probe-1" ? { run: async () => outcome } : {} });
    const result = await runBlindCohort(fixture.options);

    expect(result.status).toBe("failed");
    expect(result.records).toHaveLength(1);
    expect(result.firstFailure?.probeId).toBe("probe-1");
    expect(fixture.events.some((event) => event.includes("probe-2"))).toBe(false);
    expect(fixture.events).toContain("profile:remove:probe-1");
  });

  test("rejects a second retry request and never restarts the agent or profile", async () => {
    const fixture = harness({
      agent: (probeId) => probeId === "probe-1" ? {
        run: async () => ({
          status: "failed",
          requestSelfRecovery: true,
          structuredError: { code: "temporary", message: "Try again", recoverable: true },
        }),
      } : {},
    });
    const result = await runBlindCohort(fixture.options);

    expect(result.records).toHaveLength(1);
    expect(result.firstFailure).toEqual(expect.objectContaining({ retryCount: 1, status: "failed" }));
    expect(result.firstFailure?.reason).toContain("second self-recovery");
    expect(fixture.events.filter((event) => event === "agent:create:probe-1")).toHaveLength(1);
  });

  test("stops and cleans up for timeout, agent crash, browser failure, and dirty IndexedDB", async () => {
    const cases: Array<[string, Overrides, ProbeTerminalStatus]> = [
      ["timeout", { timeoutMs: 5, agent: (id) => id === "probe-1" ? { run: async () => await new Promise(() => {}) } : {} }, "timeout"],
      ["agent crash", { agent: (id) => id === "probe-1" ? { run: async () => { throw new Error("agent crashed"); } } : {} }, "agent-failure"],
      ["browser crash", { agent: (id) => id === "probe-1" ? { run: async () => ({ status: "browser-failure", detail: "browser crashed" }) } : {} }, "browser-failure"],
      ["dirty IndexedDB", { browser: (id) => id === "probe-1" ? { verifyIndexedDbEmpty: async () => false } : {} }, "isolation-failure"],
    ];

    for (const [, overrides, expectedStatus] of cases) {
      const fixture = harness(overrides);
      const result = await runBlindCohort(fixture.options);
      expect(result.firstFailure?.status).toBe(expectedStatus);
      expect(result.records).toHaveLength(1);
      expect(fixture.events).toContain("browser:close:probe-1");
      expect(fixture.events).toContain("profile:remove:probe-1");
      expect(fixture.events.some((event) => event.includes("probe-2"))).toBe(false);
    }
  });

  test("cleanup failure is terminal after evidence and still attempts profile removal", async () => {
    const fixture = harness({
      browser: (probeId) => probeId === "probe-1" ? {
        close: async () => { fixture.events.push("browser:close:probe-1"); throw new Error("close failed"); },
      } : {},
    });
    const result = await runBlindCohort(fixture.options);

    expect(result.firstFailure).toEqual(expect.objectContaining({ status: "cleanup-failure", reason: "close failed" }));
    expect(fixture.events).toContain("profile:remove:probe-1");
    expect(fixture.events.some((event) => event.includes("probe-2"))).toBe(false);
  });

  test.each([
    ["profile identity", { profileId: "same-profile" }],
    ["user-data directory", { userDataDirectory: "C:\\disposable\\same-profile" }],
  ])("rejects a reused %s and cleans the duplicate profile without launching it", async (_label, browser) => {
    expect(_label).toBeString();
    const fixture = harness({ browser: () => browser });
    const result = await runBlindCohort(fixture.options);

    expect(result.records).toHaveLength(2);
    expect(result.firstFailure).toEqual(expect.objectContaining({
      probeId: "probe-2",
      status: "isolation-failure",
    }));
    expect(fixture.events).not.toContain("agent:create:probe-2");
    expect(fixture.events).toContain("profile:remove:probe-2");
  });

  test("rejects a reused agent context and does not expose prior-probe memory", async () => {
    const receivedInputs: unknown[] = [];
    const fixture = harness({
      agent: () => ({
        contextId: "same-agent",
        run: async (input) => {
          receivedInputs.push(input);
          return { status: "passed" };
        },
      }),
    });
    const result = await runBlindCohort(fixture.options);

    expect(result.records).toHaveLength(2);
    expect(result.firstFailure).toEqual(expect.objectContaining({ probeId: "probe-2", status: "isolation-failure" }));
    expect(receivedInputs).toHaveLength(1);
    expect(fixture.events).toContain("agent:close:probe-2");
    expect(fixture.events).toContain("profile:remove:probe-2");
  });

  test("treats evidence finalization failure as terminal and still destroys the profile", async () => {
    const fixture = harness({
      finalize: async () => { throw new Error("observer evidence incomplete"); },
    });
    const result = await runBlindCohort(fixture.options);

    expect(result.firstFailure).toEqual(expect.objectContaining({
      probeId: "probe-1",
      status: "evidence-failure",
      reason: "observer evidence incomplete",
    }));
    expect(fixture.events).toContain("agent:close:probe-1");
    expect(fixture.events).toContain("browser:close:probe-1");
    expect(fixture.events).toContain("profile:remove:probe-1");
    expect(fixture.events.some((event) => event.includes("probe-2"))).toBe(false);
  });

  test("stops before probe N+1 when trusted evidence scoring rejects an agent-reported pass", async () => {
    const fixture = harness({
      finalize: async ({ task, status }) => {
        fixture.events.push(`evidence:${task.id}:${status}`);
        return {
          probeId: task.id,
          status,
          passed: false,
          firstFailure: { reason: "Trusted durable state did not match the expected effect." },
        };
      },
    });
    const result = await runBlindCohort(fixture.options);

    expect(result.records).toHaveLength(1);
    expect(result.firstFailure).toEqual(expect.objectContaining({
      probeId: "probe-1",
      status: "failed",
      reason: "Trusted durable state did not match the expected effect.",
    }));
    expect(fixture.events).toContain("evidence:probe-1:passed");
    expect(fixture.events).toContain("profile:remove:probe-1");
    expect(fixture.events.some((event) => event.includes("probe-2"))).toBe(false);
  });

  test("rejects the wrong browser version before agent launch", async () => {
    const fixture = harness({ browser: () => ({ browserVersion: "152.0.7977.64" }) });
    const result = await runBlindCohort(fixture.options);

    expect(result.firstFailure).toEqual(expect.objectContaining({ status: "isolation-failure" }));
    expect(fixture.events).not.toContain("agent:create:probe-1");
    expect(fixture.events).toContain("profile:remove:probe-1");
  });

  test("cancellation aborts an in-flight agent and removes its disposable profile", async () => {
    const cancellation = new AbortController();
    const fixture = harness({
      signal: cancellation.signal,
      agent: (probeId) => probeId === "probe-1" ? {
        run: async (_input, { signal }) => await new Promise<ProbeAttemptResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          cancellation.abort(new Error("operator cancelled"));
        }),
      } : {},
    });
    const result = await runBlindCohort(fixture.options);

    expect(result.firstFailure).toEqual(expect.objectContaining({ status: "cancelled" }));
    expect(fixture.events).toContain("agent:close:probe-1");
    expect(fixture.events).toContain("browser:close:probe-1");
    expect(fixture.events).toContain("profile:remove:probe-1");
    expect(fixture.events.some((event) => event.includes("probe-2"))).toBe(false);
  });
});
