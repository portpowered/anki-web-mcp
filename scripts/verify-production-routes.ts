export type DeploymentRoute = "deck-home" | "study";

export type ProductionRouteTarget = {
  url: string;
  expectedRoute: DeploymentRoute;
  forbiddenRoute: DeploymentRoute;
};

type RouteResponse = {
  status: number;
  text(): Promise<string>;
};

type RouteFetch = (
  url: string,
  init: { redirect: "follow" },
) => Promise<RouteResponse>;

export const productionRouteTargets: readonly ProductionRouteTarget[] = [
  {
    url: "https://portpowered.github.io/anki-web-mcp/",
    expectedRoute: "deck-home",
    forbiddenRoute: "study",
  },
  {
    url: "https://portpowered.github.io/anki-web-mcp/study/?deck=diagnostic",
    expectedRoute: "study",
    forbiddenRoute: "deck-home",
  },
];

const stockPagesDocument = "There isn't a GitHub Pages site here";

export function verifyProductionRouteResponse(
  target: ProductionRouteTarget,
  status: number,
  body: string,
): void {
  if (status !== 200) {
    throw new Error(`${target.url} returned HTTP ${status}`);
  }

  const expectedMarker = `data-deployment-route="${target.expectedRoute}"`;
  const forbiddenMarker = `data-deployment-route="${target.forbiddenRoute}"`;
  const identityCount = body.match(/data-deployment-route=/g)?.length ?? 0;

  if (!body.includes(expectedMarker)) {
    throw new Error(
      `${target.url} did not contain route identity ${target.expectedRoute}`,
    );
  }
  if (body.includes(forbiddenMarker)) {
    throw new Error(
      `${target.url} contained forbidden route identity ${target.forbiddenRoute}`,
    );
  }
  if (identityCount !== 1) {
    throw new Error(
      `${target.url} contained ${identityCount} route identities instead of exactly one`,
    );
  }
  if (body.includes(stockPagesDocument)) {
    throw new Error(`${target.url} returned GitHub's stock 404 document`);
  }
}

export async function verifyProductionRoutes(
  routeFetch: RouteFetch = (url, init) => fetch(url, init),
  targets: readonly ProductionRouteTarget[] = productionRouteTargets,
): Promise<void> {
  for (const target of targets) {
    const response = await routeFetch(target.url, { redirect: "follow" });
    const body = await response.text();
    verifyProductionRouteResponse(target, response.status, body);
    console.log(`Verified ${target.url} as ${target.expectedRoute}`);
  }
}

if (import.meta.main) {
  await verifyProductionRoutes();
}
