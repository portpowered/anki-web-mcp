import { describe, expect, test } from "bun:test";

import {
  assessOriginTrial,
  classifyControlCapability,
  classifyOracleObservation,
  sanitizeTool,
  summarizeOriginTrialToken,
  toJsonValue,
  webMcpFeatureName,
} from "./webmcp-oracle";
import { webMcpOriginTrialToken } from "./webmcp";

const passedObservation = {
  actualBrowserVersion: "152.0.7977.64",
  expectedBrowserVersion: "152.0.7977.64",
  navigationStatus: 200,
  polyfillBlocked: true,
  capability: "available" as const,
  discovery: { status: "passed" as const, error: null },
  discoveredTools: [],
  expectedToolFound: true,
  invocation: {
    status: "passed" as const,
    result: "Set pizza size to Small.",
    expectedResult: "Set pizza size to Small.",
    error: null,
  },
  visibleState: {
    before: "Medium",
    after: "Small",
    expectedBefore: "Medium",
    expectedAfter: "Small",
  },
  browserErrors: [],
};

describe("WebMCP oracle evidence contract", () => {
  test("passes only when native runtime behavior and visible mutation agree", () => {
    expect(classifyOracleObservation(passedObservation)).toEqual({
      classification: "oracle-passed",
      failureCode: null,
      downstream: "evaluable",
    });
  });

  test("makes absent native exposure an oracle failure, not support evidence", () => {
    expect(
      classifyOracleObservation({
        ...passedObservation,
        capability: "unavailable",
      }),
    ).toMatchObject({
      classification: "oracle-failed",
      failureCode: "native-unavailable",
      downstream: "not-evaluable",
    });
    expect(classifyControlCapability("unavailable")).toBe("native-unavailable");
    expect(classifyControlCapability("available")).toBe("control-failed");
  });

  test("rejects an unblocked polyfill even when the page appears to work", () => {
    expect(
      classifyOracleObservation({
        ...passedObservation,
        polyfillBlocked: false,
      }).failureCode,
    ).toBe("polyfill-not-blocked");
  });

  test("sanitizes host objects without serializing execution or Window fields", () => {
    const execute = () => "not evidence";
    const windowLike = { location: "not evidence" };
    const tool = sanitizeTool({
      name: "example",
      title: "Example",
      description: "A bounded tool",
      origin: "https://example.test",
      inputSchema: JSON.stringify({
        type: "object",
        properties: { value: { type: "integer" } },
      }),
      annotations: { readOnlyHint: false },
      execute,
      window: windowLike,
    });

    expect(tool).toEqual({
      name: "example",
      title: "Example",
      description: "A bounded tool",
      origin: "https://example.test",
      inputSchema: {
        type: "object",
        properties: { value: { type: "integer" } },
      },
      annotations: { readOnlyHint: false },
    });
    expect(tool).not.toHaveProperty("execute");
    expect(tool).not.toHaveProperty("window");
  });

  test("bounds circular and non-JSON values in evidence", () => {
    const circular: Record<string, unknown> = { bigint: BigInt(2) };
    circular.self = circular;

    expect(toJsonValue(circular)).toEqual({
      bigint: "[unserializable bigint]",
      self: "[circular]",
    });
  });

  test("assesses origin-trial metadata without retaining the token", () => {
    const token = Buffer.concat([
      Buffer.from([2, 68, 178, 240]),
      Buffer.from(
        JSON.stringify({
          origin: "https://example.test:443",
          feature: webMcpFeatureName,
          expiry: 1_800_000_000,
        }),
      ),
    ]).toString("base64");
    const summary = summarizeOriginTrialToken(token);

    expect(summary).toEqual({
      present: true,
      feature: webMcpFeatureName,
      origin: "https://example.test:443",
      expiry: 1_800_000_000,
      parseError: null,
    });
    expect(
      assessOriginTrial(summary, "https://example.test", "available", 1_700_000_000_000),
    ).toBe("accepted");
    expect(
      assessOriginTrial(summary, "https://other.test", "available", 1_700_000_000_000),
    ).toBe("mismatched");
    expect(summarizeOriginTrialToken(token)).not.toHaveProperty("token");
  });

  test("finds metadata after arbitrary binary origin-trial prefix bytes", () => {
    expect(summarizeOriginTrialToken(webMcpOriginTrialToken)).toEqual({
      present: true,
      feature: webMcpFeatureName,
      origin: "https://portpowered.github.io:443",
      expiry: 1_794_873_600,
      parseError: null,
    });
  });
});
