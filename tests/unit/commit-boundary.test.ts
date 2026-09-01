import { expect, test } from "bun:test";
import { commitIfReady } from "../../spikes/apkg-compatibility/src/commit-boundary";
import type {
  NormalizedStagedResult,
  ParserTerminalMessage,
} from "../../spikes/apkg-compatibility/src/protocol";

const stagedResult: NormalizedStagedResult = {
  packageSha256: "a".repeat(64),
  layout: "legacy-anki2",
  collectionMember: "collection.anki2",
  archiveMembers: [],
  normalized: {
    decks: [],
    notetypes: [],
    notes: [],
    cards: [],
    cardTemplates: [],
    fields: [],
    media: [],
    css: "",
  },
  validation: {
    collectionBytes: 512,
    sqliteTables: ["col", "notes", "cards"],
    expandedBytes: 512,
    peakMemoryBytes: 512,
    sanitizer: "worker-whitelist",
  },
  warnings: [],
};

test("only a complete success terminal reaches the commit callback", () => {
  let commitCalls = 0;
  const committed: NormalizedStagedResult[] = [];
  const commit = (result: NormalizedStagedResult): void => {
    commitCalls += 1;
    committed.push(result);
  };

  const success: ParserTerminalMessage = {
    kind: "terminal",
    operationId: "success",
    status: "success",
    commitReady: true,
    stagedResult,
    elapsedMs: 1,
    workerRuntime: "dedicated-worker",
  };
  expect(commitIfReady(success, commit)).toBe(true);
  expect(commitCalls).toBe(1);
  expect(committed).toEqual([stagedResult]);

  const nonSuccess: ParserTerminalMessage[] = [
    {
      kind: "terminal",
      operationId: "cancelled",
      status: "cancelled",
      commitReady: false,
      stagedResult: null,
      diagnostic: {
        code: "CANCELLED",
        stage: "database",
        message: "Parser operation cancelled at a cooperative checkpoint",
      },
    },
    {
      kind: "terminal",
      operationId: "unsupported",
      status: "unsupported",
      commitReady: false,
      stagedResult: null,
      diagnostic: {
        code: "UNSUPPORTED_LAYOUT",
        stage: "collection",
        message: "Unsupported collection",
      },
    },
    {
      kind: "terminal",
      operationId: "invalid",
      status: "error",
      commitReady: false,
      stagedResult: null,
      diagnostic: {
        code: "INVALID_SQLITE",
        stage: "database",
        message: "Invalid collection",
      },
    },
  ];

  for (const terminal of nonSuccess) {
    expect(commitIfReady(terminal, commit)).toBe(false);
  }
  expect(commitCalls).toBe(1);
  expect(committed).toEqual([stagedResult]);
});
