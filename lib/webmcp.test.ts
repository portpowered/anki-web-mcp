import { describe, expect, test } from "bun:test";

import {
  detectWebMcpCapability,
  webMcpOrigin,
  webMcpOriginTrialToken,
} from "./webmcp";

describe("WebMCP capability diagnostics", () => {
  test("recognizes the absent native API without mutating the document", () => {
    const documentLike = {};

    expect(detectWebMcpCapability(documentLike)).toEqual({
      kind: "unavailable",
    });
    expect(documentLike).toEqual({});
  });

  test("recognizes an exposed native modelContext surface", () => {
    expect(
      detectWebMcpCapability({
        modelContext: { registerTool() {} },
      }),
    ).toEqual({ kind: "available" });
  });

  test("reports a capability getter failure separately", () => {
    const documentLike = Object.defineProperty({}, "modelContext", {
      get() {
        throw new Error("browser capability probe failed");
      },
    });

    expect(detectWebMcpCapability(documentLike)).toEqual({ kind: "error" });
  });

  test("keeps the customer origin and origin-trial token exact", () => {
    expect(webMcpOrigin).toBe("https://portpowered.github.io");
    expect(webMcpOriginTrialToken).toBe(
      "A/MXFu/smsk8zDkOidDtDxnHQbr502frxTfbhB94iRy6Tc8m6BzqVCh3DibOCvEGdPiGm4+ww+AZkNN77vNnTgkAAABpeyJvcmlnaW4iOiJodHRwczovL3BvcnRwb3dlcmVkLmdpdGh1Yi5pbzo0NDMiLCJmZWF0dXJlIjoiV2ViTUNQIiwiZXhwaXJ5IjoxNzk0ODczNjAwLCJpc1RoaXJkUGFydHkiOnRydWV9",
    );
  });
});
