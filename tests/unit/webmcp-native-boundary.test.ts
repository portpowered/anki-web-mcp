import { describe, expect, test } from "bun:test";

import {
  classifyNativeBoundary,
  findForbiddenBrowserInfluences,
  type NativeBoundaryObservation,
} from "../../scripts/webmcp-native-boundary";

const accepted: NativeBoundaryObservation = {
  browserProduct: "Google Chrome",
  expectedBrowserProduct: "Google Chrome",
  browserVersion: "152.0.7977.65",
  expectedBrowserVersion: "152.0.7977.65",
  forbiddenBrowserInfluences: [],
  navigationStatus: 200,
  url: "https://portpowered.github.io/anki-web-mcp/",
  expectedUrl: "https://portpowered.github.io/anki-web-mcp/",
  origin: "https://portpowered.github.io",
  expectedOrigin: "https://portpowered.github.io",
  deploymentRoute: "deck-home",
  expectedDeploymentRoute: "deck-home",
  deploymentRouteCount: 1,
  secureContext: true,
  originTrialMetaCount: 1,
  originTrialTokenExact: true,
  originTrialStatus: "accepted",
  permissionsPolicy: "allowed",
  capability: "available",
  browserErrors: [],
};

describe("native production boundary classification", () => {
  test("supports only the exact clean pinned production document", () => {
    expect(classifyNativeBoundary(accepted)).toEqual({
      status: "passed",
      overall: "supported",
      failureCode: null,
    });
  });

  test.each([
    ["wrong browser product", { browserProduct: "Chromium" }, "browser-product-mismatch"],
    ["wrong browser build", { browserVersion: "152.0.7977.64" }, "browser-version-mismatch"],
    ["alternate document", { url: "https://portpowered.github.io/" }, "document-url-mismatch"],
    ["fallback document", { deploymentRoute: null }, "document-identity-mismatch"],
    ["insecure document", { secureContext: false }, "insecure-context"],
    ["missing token", { originTrialMetaCount: 0 }, "origin-trial-token-missing"],
    ["changed token", { originTrialTokenExact: false }, "origin-trial-token-mismatch"],
    ["rejected token", { originTrialStatus: "rejected" }, "origin-trial-rejected"],
    ["unknown policy", { permissionsPolicy: "unknown" }, "permissions-policy-unknown"],
    ["browser error", { browserErrors: ["pageerror: boom"] }, "browser-errors"],
  ] as const)("rejects %s", (_name, change, failureCode) => {
    expect(classifyNativeBoundary({ ...accepted, ...change })).toMatchObject({
      status: "failed",
      overall: "no-go",
      failureCode,
    });
  });

  test("makes absent native capability not-evaluable", () => {
    expect(
      classifyNativeBoundary({ ...accepted, capability: "unavailable" }),
    ).toEqual({
      status: "not-evaluable",
      overall: "not-evaluable",
      failureCode: "native-unavailable",
    });
  });

  test("detects flags, proxies, and extensions without retaining profile paths", () => {
    expect(findForbiddenBrowserInfluences([
      "--user-data-dir=C:/temporary/profile",
      "--enable-features=OtherFeature,WebMCP",
      "--proxy-server=http://localhost:8080",
      "--load-extension=C:/extension",
      "--enable-webmcp-testing",
    ])).toEqual([
      "--enable-features=WebMCP",
      "--proxy-server",
      "--load-extension",
      "--enable-webmcp-testing",
    ]);
  });
});
