import { describe, expect, test } from "bun:test";
import {
  productionRouteTargets,
  verifyProductionRouteResponse,
  verifyProductionRoutes,
  type ProductionRouteTarget,
} from "../../scripts/verify-production-routes";

const [rootTarget, studyTarget] = productionRouteTargets as readonly [
  ProductionRouteTarget,
  ProductionRouteTarget,
];
const rootDocument = '<main data-deployment-route="deck-home">Decks</main>';
const studyDocument = '<main data-deployment-route="study">Study</main>';

describe("production route response verification", () => {
  test("accepts the two distinct route documents without relying on visible copy", () => {
    expect(() =>
      verifyProductionRouteResponse(rootTarget, 200, rootDocument),
    ).not.toThrow();
    expect(() =>
      verifyProductionRouteResponse(studyTarget, 200, studyDocument),
    ).not.toThrow();
  });

  test.each([
    ["non-200 response", rootTarget, 404, rootDocument],
    ["study document at root", rootTarget, 200, studyDocument],
    ["root fallback at study", studyTarget, 200, rootDocument],
    [
      "generic shared marker",
      rootTarget,
      200,
      '<main data-deployment-route="application">Decks</main>',
    ],
    ["missing root marker", rootTarget, 200, "<main>Decks</main>"],
    ["missing study marker", studyTarget, 200, "<main>Study</main>"],
    [
      "stale diagnostic copy without identity",
      studyTarget,
      200,
      "<main>Study route diagnostics</main>",
    ],
    [
      "misleading successful stock Pages document",
      rootTarget,
      200,
      `${rootDocument}<p>There isn't a GitHub Pages site here</p>`,
    ],
    [
      "duplicated route marker",
      rootTarget,
      200,
      `${rootDocument}${rootDocument}`,
    ],
  ])("rejects %s", (_name, target, status, body) => {
    expect(() =>
      verifyProductionRouteResponse(target, status, body),
    ).toThrow();
  });

  test("requests the exact root and query-bearing study URLs", async () => {
    const requestedUrls: string[] = [];
    const redirectModes: string[] = [];
    const documents = new Map([
      [rootTarget.url, rootDocument],
      [studyTarget.url, studyDocument],
    ]);

    await verifyProductionRoutes(async (url, init) => {
      requestedUrls.push(url);
      redirectModes.push(init.redirect);
      return {
        status: 200,
        async text() {
          return documents.get(url) ?? "";
        },
      };
    });

    expect(requestedUrls).toEqual([
      "https://portpowered.github.io/anki-web-mcp/",
      "https://portpowered.github.io/anki-web-mcp/study/?deck=diagnostic",
    ]);
    expect(redirectModes).toEqual(["follow", "follow"]);
  });
});
