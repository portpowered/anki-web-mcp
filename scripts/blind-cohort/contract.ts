import { isDeepStrictEqual } from "node:util";

export const BLIND_COHORT_SCHEMA_VERSION = "webmcp-blind-cohort/v1" as const;
export const BLIND_COHORT_ID = "release-candidate-cohort-one" as const;
export const PRODUCTION_URL = "https://portpowered.github.io/anki-web-mcp/" as const;

export type ProbeNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type JudgmentDimension = "functionality" | "ux" | "ui";
export type SemanticRoute = "home" | "study";

export interface ProbeFixture {
  readonly id: "short-session" | "valid-import" | "corrupt-import";
  readonly attachmentName: string;
  readonly mediaType: "application/octet-stream";
  readonly sha256: string;
}

export interface ProbeExpectation {
  readonly finalUi: {
    readonly route: SemanticRoute;
    readonly visibleState: readonly string[];
  };
  readonly durableState: readonly string[];
  readonly destructiveTarget: {
    readonly allowedDeck: string | null;
    readonly forbidOtherDeckMutation: true;
  };
}

export interface BlindProbeTask {
  readonly number: ProbeNumber;
  readonly id: `probe-${ProbeNumber}`;
  readonly instruction: string;
  readonly publicUrl: typeof PRODUCTION_URL;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly fixture: ProbeFixture | null;
  readonly expected: ProbeExpectation;
  readonly judgments: readonly JudgmentDimension[];
}

export interface BlindCohortManifest {
  readonly schemaVersion: typeof BLIND_COHORT_SCHEMA_VERSION;
  readonly cohortId: typeof BLIND_COHORT_ID;
  readonly historicalEvidence: "excluded";
  readonly tasks: readonly BlindProbeTask[];
}

const desktop = { width: 1440, height: 900 } as const;
const mobile = { width: 390, height: 844 } as const;
const allJudgments = ["functionality", "ux", "ui"] as const;
const unchangedDecks = {
  allowedDeck: null,
  forbidOtherDeckMutation: true,
} as const;

const validFixture = {
  id: "valid-import",
  attachmentName: "cohort-one-valid.apkg",
  mediaType: "application/octet-stream",
  sha256: "c462442cb7f04266c10e96dcfc01b388730f071cda7e7a6c2242b0f9c477f9af",
} as const;

export const BLIND_COHORT_MANIFEST: BlindCohortManifest = deepFreeze({
  schemaVersion: BLIND_COHORT_SCHEMA_VERSION,
  cohortId: BLIND_COHORT_ID,
  historicalEvidence: "excluded",
  tasks: [
    task(1, "Discover and list every available deck.", desktop, null, {
      finalUi: { route: "home", visibleState: ["Available decks includes Spanish Basics"] },
      durableState: ["Spanish Basics exists with 24 cards", "no study state changed"],
      destructiveTarget: unchangedDecks,
    }),
    task(2, "Select Spanish Basics and report its current progress.", desktop, null, {
      finalUi: { route: "study", visibleState: ["Spanish Basics study view", "progress is reported"] },
      durableState: ["Spanish Basics remains selected", "no review was recorded"],
      destructiveTarget: unchangedDecks,
    }),
    task(3, "Reveal one answer in Spanish Basics and rate it Good.", desktop, null, {
      finalUi: { route: "study", visibleState: ["the next Spanish Basics card or completion state"] },
      durableState: ["exactly one Good review was recorded for Spanish Basics"],
      destructiveTarget: unchangedDecks,
    }),
    task(4, "Use get_state, then safely rate the current Spanish Basics card Good without using a stale action.", desktop, null, {
      finalUi: { route: "study", visibleState: ["the rating result is visible and unambiguous"] },
      durableState: ["exactly one current-card Good review was recorded", "no stale command changed state"],
      destructiveTarget: unchangedDecks,
    }),
    task(5, "Study three Spanish Basics cards, return home, and resume that deck.", desktop, null, {
      finalUi: { route: "study", visibleState: ["Spanish Basics resumes after the saved reviews"] },
      durableState: ["exactly three reviews were recorded", "the resumable Spanish Basics session is current"],
      destructiveTarget: unchangedDecks,
    }),
    task(6, "Import the provided short-session package through the visible interface, select P0B Fixture::子 deck, and complete its two-card session.", desktop, {
      ...validFixture,
      id: "short-session",
      attachmentName: "cohort-one-short-session.apkg",
    }, {
      finalUi: { route: "study", visibleState: ["P0B Fixture::子 deck session is complete"] },
      durableState: ["the fixture import exists", "both child-deck cards have reviews", "the child-deck session is complete"],
      destructiveTarget: unchangedDecks,
    }),
    task(7, "Import the provided valid package through the visible interface and select P0B Fixture.", desktop, validFixture, {
      finalUi: { route: "study", visibleState: ["P0B Fixture is the selected study deck"] },
      durableState: ["the fixture import and both fixture decks exist", "no fixture card was reviewed"],
      destructiveTarget: unchangedDecks,
    }),
    task(8, "Attempt to import the provided corrupt package through the visible interface, then explain how the application recovered.", desktop, {
      id: "corrupt-import",
      attachmentName: "cohort-one-corrupt.apkg",
      mediaType: "application/octet-stream",
      sha256: "538e92d2d96d89ba7de911a907f027e17841fdf1b130b23497cbacb047c0f4de",
    }, {
      finalUi: { route: "home", visibleState: ["a recoverable import error", "another package can be chosen"] },
      durableState: ["no import or deck was created", "Spanish Basics is unchanged"],
      destructiveTarget: unchangedDecks,
    }),
    task(9, "Import the provided valid package, then remove P0B Fixture without opening it or removing any other deck.", desktop, validFixture, {
      finalUi: { route: "home", visibleState: ["P0B Fixture is absent", "Spanish Basics and P0B Fixture::子 deck remain"] },
      durableState: ["P0B Fixture and only its owned records were removed", "the other decks are unchanged"],
      destructiveTarget: { allowedDeck: "P0B Fixture", forbidOtherDeckMutation: true },
    }),
    task(10, "In this mobile viewport, complete the core Spanish Basics flow: select the deck, reveal one answer, rate it Good, return home, and resume.", mobile, null, {
      finalUi: { route: "study", visibleState: ["the resumed Spanish Basics study view fits the mobile viewport"] },
      durableState: ["exactly one Good review was recorded", "the Spanish Basics session resumes"],
      destructiveTarget: unchangedDecks,
    }),
  ],
});

function task(
  number: ProbeNumber,
  instruction: string,
  viewport: BlindProbeTask["viewport"],
  fixture: ProbeFixture | null,
  expected: ProbeExpectation,
): BlindProbeTask {
  return {
    number,
    id: `probe-${number}`,
    instruction,
    publicUrl: PRODUCTION_URL,
    viewport,
    fixture,
    expected,
    judgments: allJudgments,
  };
}

export class BlindContractError extends Error {
  constructor(readonly code: "invalid-manifest" | "forbidden-content" | "invalid-probe", message: string) {
    super(message);
    this.name = "BlindContractError";
  }
}

const forbiddenKeys = new Set([
  "baseline", "history", "historicalResults", "originTrial", "originTrialToken",
  "repository", "repositoryPath", "selector", "shell", "source", "transcript",
]);
const forbiddenText = [
  /(?:^|\s)(?:\.\.\/|\.\/|[a-z]:\\|\/home\/|\/users\/)/iu,
  /(?:css\s+selector|origin[- ]trial|repository path|source code)/iu,
  /(?:api[_-]?key|authorization|bearer|client[_-]?secret|password)\s*[:=]/iu,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
];

export function validateBlindCohortManifest(candidate: unknown): BlindCohortManifest {
  assertNoForbiddenContent(candidate, "$", new Set());
  if (!isDeepStrictEqual(candidate, BLIND_COHORT_MANIFEST)) {
    throw new BlindContractError(
      "invalid-manifest",
      "Blind cohort manifest must exactly match the versioned ten-probe contract.",
    );
  }
  return BLIND_COHORT_MANIFEST;
}

export interface SemanticBrowserPort {
  observe(): Promise<unknown>;
  activate(role: string, accessibleName: string): Promise<unknown>;
  enterText(role: string, accessibleName: string, value: string): Promise<unknown>;
  attachFixture(accessibleName: string, fixtureId: ProbeFixture["id"]): Promise<unknown>;
}

export interface PublicWebMcpPort {
  discover(): Promise<readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema?: unknown;
  }[]>;
  invoke(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface RestrictedProbeInput {
  readonly schemaVersion: typeof BLIND_COHORT_SCHEMA_VERSION;
  readonly cohortId: typeof BLIND_COHORT_ID;
  readonly probeId: BlindProbeTask["id"];
  readonly instruction: string;
  readonly publicUrl: typeof PRODUCTION_URL;
  readonly viewport: BlindProbeTask["viewport"];
  readonly fixture: ProbeFixture | null;
  readonly semanticBrowser: SemanticBrowserPort;
  readonly publicWebMcp: PublicWebMcpPort;
}

export interface RestrictedAgentFactory<Result> {
  start(input: RestrictedProbeInput): Promise<Result>;
}

export async function launchRestrictedProbe<Result>(options: {
  manifest: unknown;
  probeNumber: number;
  semanticBrowser: SemanticBrowserPort;
  publicWebMcp: PublicWebMcpPort;
  agentFactory: RestrictedAgentFactory<Result>;
}): Promise<Result> {
  const manifest = validateBlindCohortManifest(options.manifest);
  const task = manifest.tasks[options.probeNumber - 1];
  if (task === undefined || task.number !== options.probeNumber) {
    throw new BlindContractError("invalid-probe", "Probe number must be an integer from 1 through 10.");
  }

  // Freeze the data envelope without freezing stateful adapter instances owned by
  // the controller. Agents cannot replace a port, while browser implementations
  // remain free to maintain their private lifecycle state.
  const input: RestrictedProbeInput = Object.freeze({
    schemaVersion: manifest.schemaVersion,
    cohortId: manifest.cohortId,
    probeId: task.id,
    instruction: task.instruction,
    publicUrl: task.publicUrl,
    viewport: Object.freeze({ ...task.viewport }),
    fixture: task.fixture === null ? null : Object.freeze({ ...task.fixture }),
    semanticBrowser: options.semanticBrowser,
    publicWebMcp: options.publicWebMcp,
  });
  return await options.agentFactory.start(input);
}

function assertNoForbiddenContent(value: unknown, path: string, seen: Set<object>): void {
  if (typeof value === "string") {
    if (forbiddenText.some((pattern) => pattern.test(value))) {
      throw new BlindContractError("forbidden-content", `Forbidden blind-agent content at ${path}.`);
    }
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) {
      throw new BlindContractError("forbidden-content", `Forbidden blind-agent capability at ${path}.${key}.`);
    }
    assertNoForbiddenContent(child, `${path}.${key}`, seen);
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
