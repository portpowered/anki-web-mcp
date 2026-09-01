import { describe, expect, test } from "bun:test";

import { readDeckQuery } from "./diagnostic";

describe("study deck query diagnostics", () => {
  test("reports a missing deck query", () => {
    expect(readDeckQuery(new URLSearchParams())).toEqual({
      kind: "missing",
      value: null,
    });
  });

  test("reports an empty deck query as recoverable input", () => {
    expect(readDeckQuery(new URLSearchParams("deck="))).toEqual({
      kind: "empty",
      value: "",
    });
  });

  test("preserves provided and untrusted query text without interpreting it", () => {
    const value = "<b>diagnostic</b> & review";

    expect(readDeckQuery(new URLSearchParams({ deck: value }))).toEqual({
      kind: "provided",
      value,
    });
  });
});
