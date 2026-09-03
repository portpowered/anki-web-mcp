import { describe, expect, test } from "bun:test";

import {
  BLIND_COHORT_MANIFEST,
  BlindContractError,
  launchRestrictedProbe,
  validateBlindCohortManifest,
  type PublicWebMcpPort,
  type RestrictedProbeInput,
  type SemanticBrowserPort,
} from "../../scripts/blind-cohort/contract";

const expectedInstructions = [
  "Discover and list every available deck.",
  "Select Spanish Basics and report its current progress.",
  "Reveal one answer in Spanish Basics and rate it Good.",
  "Use get_state, then safely rate the current Spanish Basics card Good without using a stale action.",
  "Study three Spanish Basics cards, return home, and resume that deck.",
  "Import the provided short-session package through the visible interface, select P0B Fixture::子 deck, and complete its two-card session.",
  "Import the provided valid package through the visible interface and select P0B Fixture.",
  "Attempt to import the provided corrupt package through the visible interface, then explain how the application recovered.",
  "Import the provided valid package, then remove P0B Fixture without opening it or removing any other deck.",
  "In this mobile viewport, complete the core Spanish Basics flow: select the deck, reveal one answer, rate it Good, return home, and resume.",
];

type Mutable<T> = T extends string ? string
  : T extends number ? number
    : T extends boolean ? boolean
      : T extends readonly (infer Item)[] ? Mutable<Item>[]
        : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
          : T;
type MutableManifest = Mutable<typeof BLIND_COHORT_MANIFEST> & { baseline?: unknown };

function copyManifest(): MutableManifest {
  return structuredClone(BLIND_COHORT_MANIFEST) as MutableManifest;
}

function errorCode(operation: () => unknown): string {
  try {
    operation();
    throw new Error("expected contract validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(BlindContractError);
    return (error as BlindContractError).code;
  }
}

describe("blind cohort manifest", () => {
  test("defines exactly the ten prescribed tasks in numeric order with observable expectations", () => {
    const manifest = validateBlindCohortManifest(copyManifest());

    expect(manifest.tasks.map((task) => task.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(manifest.tasks.map((task) => task.instruction)).toEqual(expectedInstructions);
    expect(manifest.tasks.every((task) => task.publicUrl.startsWith("https://"))).toBe(true);
    expect(manifest.tasks.every((task) => task.expected.finalUi.visibleState.length > 0)).toBe(true);
    expect(manifest.tasks.every((task) => task.expected.durableState.length > 0)).toBe(true);
    expect(manifest.tasks.every((task) => task.judgments.join(",") === "functionality,ux,ui")).toBe(true);
    expect(manifest.tasks[9]!.viewport).toEqual({ width: 390, height: 844 });
    expect(manifest.tasks.slice(0, 9).every((task) => task.viewport.width === 1440)).toBe(true);
    expect(manifest.tasks.filter((task) => task.fixture !== null).map((task) => task.number)).toEqual([6, 7, 8, 9]);
  });

  test.each([
    ["missing task", (manifest: MutableManifest) => manifest.tasks.pop()],
    ["duplicate task", (manifest: MutableManifest) => { manifest.tasks[1] = manifest.tasks[0]!; }],
    ["reordered task", (manifest: MutableManifest) => { [manifest.tasks[0], manifest.tasks[1]] = [manifest.tasks[1]!, manifest.tasks[0]!]; }],
    ["altered task", (manifest: MutableManifest) => { manifest.tasks[0]!.instruction = "List decks and inspect implementation details."; }],
    ["extra task", (manifest: MutableManifest) => manifest.tasks.push(manifest.tasks[9]!)],
    ["changed fixture", (manifest: MutableManifest) => { manifest.tasks[6]!.fixture!.sha256 = "0".repeat(64); }],
    ["extra historical evidence", (manifest: MutableManifest) => { manifest.baseline = { score: "0/10", deployment: "stock-404" }; }],
  ])("rejects a %s", (_label, mutate) => {
    const manifest = copyManifest();
    mutate(manifest);
    expect(errorCode(() => validateBlindCohortManifest(manifest))).toMatch(/invalid-manifest|forbidden-content/);
  });

  test.each([
    ["repository", "C:\\work\\private\\fixture.apkg"],
    ["source", "Read the source code before using the page"],
    ["selector", "Use CSS selector [data-secret]"],
    ["origin trial", "origin-trial token: private"],
    ["credential", "api_key=private"],
  ])("rejects forbidden %s material before launch", (_label, material) => {
    const manifest = copyManifest();
    manifest.tasks[0].instruction = material;
    expect(errorCode(() => validateBlindCohortManifest(manifest))).toBe("forbidden-content");
  });
});

describe("restricted probe launch boundary", () => {
  const semanticBrowser: SemanticBrowserPort = {
    observe: async () => ({ heading: "Decks" }),
    activate: async (role, name) => ({ role, name }),
    enterText: async (role, name, value) => ({ role, name, value }),
    attachFixture: async (name, fixtureId) => ({ name, fixtureId }),
  };
  const publicWebMcp: PublicWebMcpPort = {
    discover: async () => [{ name: "list_decks", description: "List available decks" }],
    invoke: async (name, input) => ({ name, input }),
  };

  test("gives the agent only its public task and allowlisted capabilities", async () => {
    let received: RestrictedProbeInput | undefined;
    const result = await launchRestrictedProbe({
      manifest: copyManifest(),
      probeNumber: 7,
      semanticBrowser,
      publicWebMcp,
      agentFactory: {
        start: async (input) => {
          received = input;
          return {
            visible: await input.semanticBrowser.observe(),
            tools: await input.publicWebMcp.discover(),
          };
        },
      },
    });

    expect(result).toEqual({
      visible: { heading: "Decks" },
      tools: [{ name: "list_decks", description: "List available decks" }],
    });
    expect(Object.keys(received!).sort()).toEqual([
      "cohortId", "fixture", "instruction", "probeId", "publicUrl", "publicWebMcp",
      "schemaVersion", "semanticBrowser", "viewport",
    ]);
    expect(received!.fixture).toEqual(BLIND_COHORT_MANIFEST.tasks[6]!.fixture);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received!.fixture)).toBe(true);
    for (const denied of [
      "repository", "shell", "filesystem", "rawDom", "cssSelector", "priorTranscript",
      "controllerSecret", "originTrialToken", "expected", "historicalEvidence",
    ]) {
      expect(denied in (received as unknown as Record<string, unknown>)).toBe(false);
    }
  });

  test("validates the whole contract before starting an agent or browser", async () => {
    const manifest = copyManifest();
    manifest.tasks[9].viewport.width = 391;
    let agentStarts = 0;
    let browserCalls = 0;
    const guardedBrowser: SemanticBrowserPort = {
      ...semanticBrowser,
      observe: async () => {
        browserCalls += 1;
        return {};
      },
    };

    await expect(launchRestrictedProbe({
      manifest,
      probeNumber: 1,
      semanticBrowser: guardedBrowser,
      publicWebMcp,
      agentFactory: { start: async () => { agentStarts += 1; } },
    })).rejects.toMatchObject({ code: "invalid-manifest" });
    expect(agentStarts).toBe(0);
    expect(browserCalls).toBe(0);
  });

  test("rejects out-of-range probes before starting the agent", async () => {
    let starts = 0;
    await expect(launchRestrictedProbe({
      manifest: copyManifest(),
      probeNumber: 0,
      semanticBrowser,
      publicWebMcp,
      agentFactory: { start: async () => { starts += 1; } },
    })).rejects.toMatchObject({ code: "invalid-probe" });
    expect(starts).toBe(0);
  });
});
