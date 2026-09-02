import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { arch, platform, release, version as osVersion } from "node:os";
import { join, resolve } from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response as PlaywrightResponse,
} from "playwright-core";

import {
  webMcpOrigin,
  webMcpOriginTrialToken,
  webMcpPermissionsPolicyFeature,
  type WebMcpOriginTrialStatus,
} from "../lib/webmcp";
import {
  assessOriginTrial,
  summarizeOriginTrialToken,
  webMcpOracleExpectedBrowserName,
  webMcpOracleExpectedBrowserVersion,
} from "../lib/webmcp-oracle";
import {
  activeStudyToolNames,
  assessProductionInventory,
  emptyStudyToolNames,
  homeToolNames,
  type ProductionToolName,
} from "./webmcp-production-contract";
import {
  classifyNativeBoundary,
  findForbiddenBrowserInfluences,
} from "./webmcp-native-boundary";
import {
  assessHomeJourney,
  type HomeJourneyEvidence,
} from "./webmcp-home-journey";

const repositoryRoot = resolve(import.meta.dir, "..");
const defaultEvidencePath = join(
  repositoryRoot,
  ".artifacts",
  "webmcp-boundaries",
  "report.json",
);
const evidencePath = resolve(
  process.env.WEBMCP_BOUNDARY_EVIDENCE ?? defaultEvidencePath,
);
const productionBaseUrl = `${webMcpOrigin}/anki-web-mcp`;
const productionRootUrl = `${productionBaseUrl}/`;
const productionStudyUrl = `${productionBaseUrl}/study/?deck=diagnostic`;
const allowFailure = process.env.WEBMCP_BOUNDARY_ALLOW_FAILURE === "1";
const desktopViewport = { width: 1280, height: 900 };

const launchArgs = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-extensions",
  "--disable-sync",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-sandbox",
] as const;

type Capability = "available" | "unavailable" | "error";
type Policy = "allowed" | "denied" | "unknown";

type BrowserIdentity = {
  name: string;
  actualName: string | null;
  requestedVersion: string;
  actualVersion: string | null;
  executablePath: string | null;
  userAgent: string | null;
  forbiddenInfluences: string[];
  operatingSystem: {
    platform: string;
    release: string;
    version: string;
    architecture: string;
  };
};

type BrowserDiagnostics = {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
};

type ToolSnapshot = {
  name: string | null;
  title: string | null;
  description: string | null;
  origin: string | null;
  inputSchema: unknown;
  annotations: unknown;
};

type ToolCall = {
  status: "passed" | "failed" | "not-run";
  result: unknown;
  error: string | null;
};

type ProductionRouteEvidence = {
  url: string;
  documentUrl: string | null;
  navigationStatus: number | null;
  capability: Capability;
  secureContext: boolean | null;
  origin: string | null;
  permissionsPolicy: Policy;
  deploymentRoute: string | null;
  deploymentRouteCount: number;
  originTrialMetaPresent: boolean;
  originTrialMetaCount: number;
  originTrialTokenExact: boolean;
  originTrialTokenLength: number;
  originTrialTokenSha256: string | null;
  forbiddenInfluences: string[];
  originTrialStatus: WebMcpOriginTrialStatus | null;
  originTrialFeature: string | null;
  originTrialOrigin: string | null;
  originTrialExpiry: number | null;
  originTrialParseError: string | null;
  discoveredTools: ToolSnapshot[];
  expectedToolNames: string[];
  expectedToolFound: boolean;
  validCall: ToolCall;
  duplicateCall: ToolCall;
  invalidCall: ToolCall;
  cancelledCall: ToolCall;
  stateBefore: unknown;
  stateAfter: unknown;
  stateAfterDuplicate: unknown;
  stateAfterInvalid: unknown;
  stateAfterCancelled: unknown;
  browserErrors: string[];
  failureCode: string | null;
};

type ProductionPageResult = Omit<
  ProductionRouteEvidence,
  "url" | "navigationStatus" | "browserErrors" | "failureCode"
>;

type RawProductionPageResult = ProductionPageResult & {
  originTrialToken: string | null;
  forbiddenInfluences: string[];
};

type RouteLifecycleObservation = {
  step: "root-initial" | "study-after-root" | "root-after-study" | "study-reload";
  url: string;
  navigationStatus: number | null;
  capability: Capability;
  discoveredToolNames: string[];
  expectedToolNames: string[];
  oldRouteToolPresent: boolean;
  queryPreserved: boolean | null;
  failureCode: string | null;
};

type ProductionLifecycleEvidence = {
  status: "passed" | "failed" | "not-evaluable";
  observations: RouteLifecycleObservation[];
  browserErrors: string[];
  failureCode: string | null;
};

type IsolationCaseEvidence = {
  name: "blocked" | "delegated-without-exposure" | "explicitly-permitted" | "permission-removed";
  url: string;
  trustedOrigin: string;
  childOrigin: string;
  hostPermissionsPolicy: Policy;
  childPermissionsPolicy: Policy | null;
  childRegistration: string | null;
  childRegistrationError: string | null;
  defaultToolNames: string[];
  requestedToolNames: string[];
  execution: ToolCall;
  childMutationCount: number | null;
  failureCode: string | null;
};

type IsolationEvidence = {
  status: "passed" | "failed" | "not-evaluable";
  mode: "local-native-boundary-experiment";
  launchArgs: string[];
  trustedOrigin: string;
  childOrigin: string;
  cases: IsolationCaseEvidence[];
  browserErrors: string[];
  failureCode: string | null;
};

type BoundaryReport = {
  schemaVersion: 1;
  generatedAt: string;
  runtimeOnly: true;
  overall: "supported" | "no-go" | "not-evaluable";
  browser: BrowserIdentity;
  procedure: {
    productionUrls: { root: string; study: string };
    productionLaunchArgs: string[];
    profile: "isolated-ephemeral";
    contextPerCase: true;
    serviceWorkers: "blocked";
    extensions: "disabled";
    proxy: "none";
    productionWebMcpTestingFlag: "not-supplied";
    productionPolyfill: "none-loaded";
    inspection: string;
    crossOriginExperiment: string;
  };
  production: {
    status: "passed" | "failed" | "not-evaluable";
    root: ProductionRouteEvidence | null;
    study: ProductionRouteEvidence | null;
    failureCode: string | null;
  };
  homeJourney: {
    status: "passed" | "failed" | "not-evaluable";
    evidence: HomeJourneyEvidence | null;
    failureCode: string | null;
  };
  lifecycle: ProductionLifecycleEvidence;
  isolation: IsolationEvidence;
  limitations: string[];
};

type RunningHtmlServer = {
  origin: string;
  stop: () => Promise<void>;
};

type IsolationSnapshot = {
  hostCapability: Capability;
  hostPermissionsPolicy: Policy;
  childPermissionsPolicy: Policy | null;
  childRegistration: string | null;
  childRegistrationError: string | null;
  defaultToolNames: string[];
  requestedToolNames: string[];
  executedResult: unknown;
  executionError: string | null;
  childMutationCount: number | null;
};

function emptyBrowserIdentity(executablePath: string | null): BrowserIdentity {
  return {
    name: webMcpOracleExpectedBrowserName,
    actualName: null,
    requestedVersion: webMcpOracleExpectedBrowserVersion,
    actualVersion: null,
    executablePath,
    userAgent: null,
    forbiddenInfluences: [],
    operatingSystem: {
      platform: platform(),
      release: release(),
      version: osVersion(),
      architecture: arch(),
    },
  };
}

function emptyDiagnostics(): BrowserDiagnostics {
  return { consoleErrors: [], pageErrors: [], failedRequests: [] };
}

function emptyProductionLifecycle(): ProductionLifecycleEvidence {
  return {
    status: "not-evaluable",
    observations: [],
    browserErrors: [],
    failureCode: "not-started",
  };
}

function summarizeError(error: unknown): string {
  const candidate = error as { name?: unknown; message?: unknown } | null;
  const name = typeof candidate?.name === "string" ? candidate.name : "Error";
  const message = typeof candidate?.message === "string"
    ? candidate.message
    : String(error);
  const value = `${name}: ${message}`;
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function serialize(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value ?? null);
    return encoded === undefined ? null : JSON.parse(encoded);
  } catch (error) {
    return `[unserializable: ${summarizeError(error)}]`;
  }
}

function attachDiagnostics(page: Page, diagnostics: BrowserDiagnostics): void {
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.consoleErrors.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    diagnostics.failedRequests.push(
      `${request.failure()?.errorText ?? "Network request failed"} (${request.url()})`,
    );
  });
}

function browserErrors(diagnostics: BrowserDiagnostics): string[] {
  return [
    ...diagnostics.consoleErrors,
    ...diagnostics.pageErrors,
    ...diagnostics.failedRequests,
  ];
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("Could not determine a free local port"));
        return;
      }
      const port = (address as AddressInfo).port;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

async function findBrowserExecutable(): Promise<string> {
  const configuredPath = process.env.WEBMCP_BOUNDARY_BROWSER_PATH ??
    process.env.CHROME_PATH ?? process.env.CHROME_BIN;
  if (configuredPath) {
    await access(configuredPath);
    return configuredPath;
  }

  const candidates = [
    join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  for (const command of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
  ]) {
    const executable = Bun.which(command);
    if (executable) {
      candidates.push(executable);
    }
  }
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the known installation locations.
    }
  }
  throw new Error(
    "No Chrome executable found. Set WEBMCP_BOUNDARY_BROWSER_PATH or CHROME_PATH.",
  );
}

async function readBrowserIdentity(
  page: Page,
  browser: Browser,
  identity: BrowserIdentity,
): Promise<BrowserIdentity> {
  const pageIdentity = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
  }));
  const session = await page.context().newCDPSession(page);
  const [version, commandLine] = await Promise.all([
    session.send("Browser.getVersion") as Promise<{ product?: string }>,
    session.send("Browser.getBrowserCommandLine") as Promise<{ arguments?: string[] }>,
  ]);
  await session.detach();
  const [productName] = version.product?.split("/", 1) ?? [];
  return {
    ...identity,
    actualName: productName === "Chrome" ? "Google Chrome" : productName ?? null,
    actualVersion: browser.version(),
    userAgent: pageIdentity.userAgent,
    forbiddenInfluences: findForbiddenBrowserInfluences(
      commandLine.arguments ?? [],
    ),
  };
}

async function waitFor<T>(
  operation: () => Promise<T | false>,
  description: string,
  timeoutMilliseconds = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== false) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${summarizeError(lastError)}` : ""}`,
  );
}

async function inEphemeralContext<T>(
  browser: Browser,
  operation: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: desktopViewport,
  });
  const page = await context.newPage();
  try {
    return await operation(page);
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

function productionRouteScript(
  route: "root" | "study",
  expectedToolNames: readonly ProductionToolName[],
  invokedToolName: ProductionToolName,
  input: unknown,
): {
  route: "root" | "study";
  expectedToolNames: string[];
  invokedToolName: string;
  input: unknown;
  expectedToken: string;
  expectedDeploymentRoute: "deck-home" | "study";
} {
  return {
    route,
    expectedToolNames: [...expectedToolNames],
    invokedToolName,
    input,
    expectedToken: webMcpOriginTrialToken,
    expectedDeploymentRoute: route === "root" ? "deck-home" : "study",
  };
}

async function inspectProductionRoute(
  page: Page,
  browserIdentity: BrowserIdentity,
  url: string,
  route: "root" | "study",
  expectedToolNames: readonly ProductionToolName[],
  invokedToolName: ProductionToolName,
  input: unknown,
): Promise<ProductionRouteEvidence> {
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  let response: PlaywrightResponse | null = null;
  try {
    // Hosted Pages can keep speculative/prefetch requests open after the
    // document is usable. DOMContentLoaded gives the bounded probe a stable
    // document without making the exact-production check wait indefinitely
    // for unrelated network quiescence.
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!response || !response.ok()) {
      return failedProductionRoute(url, response?.status() ?? null, "deployment-route-failed");
    }
    await page.waitForTimeout(300);
    const result = await page.evaluate<
      RawProductionPageResult,
      ReturnType<typeof productionRouteScript>
    >(async (configuration) => {
      type ModelContext = {
        getTools?: (options?: { fromOrigins?: string[] }) => Promise<unknown[]>;
        executeTool?: (
          tool: unknown,
          input: string,
          options?: { signal?: AbortSignal },
        ) => Promise<unknown>;
      };
      const context = (document as Document & { modelContext?: ModelContext }).modelContext;
      const policy = (document as Document & {
        permissionsPolicy?: { allowsFeature?: (feature: string) => boolean };
        featurePolicy?: { allowsFeature?: (feature: string) => boolean };
      }).permissionsPolicy ?? (document as Document & {
        featurePolicy?: { allowsFeature?: (feature: string) => boolean };
      }).featurePolicy;
      const permissionsPolicy: Policy = policy && typeof policy.allowsFeature === "function"
        ? (() => {
            try {
              return policy.allowsFeature("tools") ? "allowed" : "denied";
            } catch {
              return "unknown";
            }
          })()
        : "unknown";
      const state = () => ({
        route: document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? null,
        text: document.querySelector("main")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      });
      const waitForStateChange = async (previous: unknown): Promise<unknown> => {
        const previousSerialized = JSON.stringify(previous);
        const deadline = Date.now() + 2_000;
        let current = state();
        while (JSON.stringify(current) === previousSerialized && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          current = state();
        }
        return current;
      };
      const snapshot = (tool: unknown): ToolSnapshot => {
        if (tool === null || typeof tool !== "object") {
          return {
            name: null,
            title: null,
            description: null,
            origin: null,
            inputSchema: null,
            annotations: null,
          };
        }
        const candidate = tool as Record<string, unknown>;
        const json = (value: unknown) => {
          try {
            const encoded = JSON.stringify(value ?? null);
            return encoded === undefined ? null : JSON.parse(encoded);
          } catch {
            return null;
          }
        };
        return {
          name: typeof candidate.name === "string" ? candidate.name : null,
          title: typeof candidate.title === "string" ? candidate.title : null,
          description: typeof candidate.description === "string" ? candidate.description : null,
          origin: typeof candidate.origin === "string" ? candidate.origin : null,
          inputSchema: json(candidate.inputSchema),
          annotations: json(candidate.annotations),
        };
      };
      const capability: Capability = !context
        ? "unavailable"
        : typeof context.getTools !== "function" || typeof context.executeTool !== "function"
          ? "error"
          : "available";
      const originTrialToken = document.querySelector('meta[http-equiv="origin-trial"]')?.getAttribute("content") ?? null;
      const originTrialMetaCount = document.querySelectorAll('meta[http-equiv="origin-trial"]').length;
      const metaPresent = originTrialMetaCount > 0;
      const originTrialStatus = (value: string | null): WebMcpOriginTrialStatus | null =>
        value === "accepted" ||
          value === "rejected" ||
          value === "expired" ||
          value === "mismatched" ||
          value === "not-required" ||
          value === "unknown"
          ? value
          : null;
      const observedOriginTrialStatus = originTrialStatus(
        document.querySelector("[data-webmcp-capability]")?.getAttribute("data-webmcp-origin-trial") ?? null,
      ) ?? (metaPresent ? "unknown" : null);
      const deploymentRoutes = [...document.querySelectorAll("[data-deployment-route]")]
        .map((element) => element.getAttribute("data-deployment-route"));
      const serviceWorkerRegistrations = navigator.serviceWorker
        ? await navigator.serviceWorker.getRegistrations().catch(() => [])
        : [];
      const forbiddenInfluences = [
        ...(navigator.serviceWorker?.controller || serviceWorkerRegistrations.length > 0
          ? ["service-worker-registration"]
          : []),
        ...([...document.scripts].some((script) => /(?:polyfill|mock).*webmcp|webmcp.*(?:polyfill|mock)/i.test(script.src))
          ? ["webmcp-polyfill-or-mock-script"]
          : []),
        ...(performance.getEntriesByType("resource").some((entry) => entry.name.startsWith("chrome-extension:"))
          ? ["extension-resource"]
          : []),
      ];
      const boundary = {
        documentUrl: location.href,
        secureContext: window.isSecureContext,
        origin: location.origin,
        permissionsPolicy,
        deploymentRoute: deploymentRoutes.length === 1 ? deploymentRoutes[0] : null,
        deploymentRouteCount: deploymentRoutes.length,
        originTrialMetaPresent: metaPresent,
        originTrialMetaCount,
        originTrialTokenExact: originTrialToken === configuration.expectedToken,
        originTrialTokenLength: originTrialToken?.length ?? 0,
        originTrialTokenSha256: null,
        forbiddenInfluences,
      };
      const before = state();
      if (capability !== "available") {
        return {
          capability,
          ...boundary,
          originTrialStatus: observedOriginTrialStatus,
          originTrialFeature: null,
          originTrialOrigin: null,
          originTrialExpiry: null,
          originTrialParseError: null,
          discoveredTools: [],
          expectedToolNames: configuration.expectedToolNames,
          expectedToolFound: false,
          validCall: { status: "not-run", result: null, error: null },
          duplicateCall: { status: "not-run", result: null, error: null },
          invalidCall: { status: "not-run", result: null, error: null },
          cancelledCall: { status: "not-run", result: null, error: null },
          stateBefore: before,
          stateAfter: before,
          stateAfterDuplicate: before,
          stateAfterInvalid: before,
          stateAfterCancelled: before,
          originTrialToken,
        };
      }
      const availableContext = context as {
        getTools: (options?: { fromOrigins?: string[] }) => Promise<unknown[]>;
        executeTool: (
          tool: unknown,
          input: string,
          options?: { signal?: AbortSignal },
        ) => Promise<unknown>;
      };
      const call = async (
        tool: unknown,
        value: unknown,
        signal?: AbortSignal,
      ): Promise<ToolCall> => {
        try {
          const result = await availableContext.executeTool(tool, JSON.stringify(value), signal
            ? { signal }
            : undefined);
          return { status: "passed", result: result ?? null, error: null };
        } catch (error) {
          return {
            status: "failed",
            result: null,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          };
        }
      };
      let tools: unknown[];
      try {
        const deadline = Date.now() + 10_000;
        tools = [];
        while (Date.now() < deadline) {
          tools = await availableContext.getTools();
          const names = tools.map((candidate) =>
            candidate !== null && typeof candidate === "object" &&
                typeof (candidate as Record<string, unknown>).name === "string"
              ? (candidate as Record<string, string>).name
              : ""
          );
          const complete = names.length === configuration.expectedToolNames.length &&
            new Set(names).size === names.length &&
            configuration.expectedToolNames.every((name) => names.includes(name));
          const unexpected = names.some((name) =>
            !configuration.expectedToolNames.includes(name)
          );
          if (complete || unexpected) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } catch (error) {
        return {
          capability,
          ...boundary,
          originTrialStatus: observedOriginTrialStatus,
          originTrialFeature: null,
          originTrialOrigin: null,
          originTrialExpiry: null,
          originTrialParseError: null,
          discoveredTools: [],
          expectedToolNames: configuration.expectedToolNames,
          expectedToolFound: false,
          validCall: { status: "failed", result: null, error: String(error) },
          duplicateCall: { status: "not-run", result: null, error: null },
          invalidCall: { status: "not-run", result: null, error: null },
          cancelledCall: { status: "not-run", result: null, error: null },
          stateBefore: before,
          stateAfter: before,
          stateAfterDuplicate: before,
          stateAfterInvalid: before,
          stateAfterCancelled: before,
          originTrialToken,
        };
      }
      const discoveredTools = tools.map(snapshot);
      const discoveredToolNames = discoveredTools.map((candidate) => candidate.name ?? "");
      const inventoryMatches = discoveredToolNames.length === configuration.expectedToolNames.length &&
        new Set(discoveredToolNames).size === discoveredToolNames.length &&
        configuration.expectedToolNames.every((name) => discoveredToolNames.includes(name));
      if (!inventoryMatches) {
        return {
          capability,
          ...boundary,
          originTrialStatus: observedOriginTrialStatus,
          originTrialFeature: null,
          originTrialOrigin: null,
          originTrialExpiry: null,
          originTrialParseError: null,
          discoveredTools,
          expectedToolNames: configuration.expectedToolNames,
          expectedToolFound: false,
          validCall: { status: "not-run", result: null, error: null },
          duplicateCall: { status: "not-run", result: null, error: null },
          invalidCall: { status: "not-run", result: null, error: null },
          cancelledCall: { status: "not-run", result: null, error: null },
          stateBefore: before,
          stateAfter: before,
          stateAfterDuplicate: before,
          stateAfterInvalid: before,
          stateAfterCancelled: before,
          originTrialToken,
        };
      }
      const tool = tools.find((candidate) =>
        candidate !== null && typeof candidate === "object" &&
        (candidate as Record<string, unknown>).name === configuration.invokedToolName,
      );
      if (!tool) {
        return {
          capability,
          ...boundary,
          originTrialStatus: observedOriginTrialStatus,
          originTrialFeature: null,
          originTrialOrigin: null,
          originTrialExpiry: null,
          originTrialParseError: null,
          discoveredTools,
          expectedToolNames: configuration.expectedToolNames,
          expectedToolFound: false,
          validCall: { status: "not-run", result: null, error: null },
          duplicateCall: { status: "not-run", result: null, error: null },
          invalidCall: { status: "not-run", result: null, error: null },
          cancelledCall: { status: "not-run", result: null, error: null },
          stateBefore: before,
          stateAfter: before,
          stateAfterDuplicate: before,
          stateAfterInvalid: before,
          stateAfterCancelled: before,
          originTrialToken,
        };
      }
      const validCall = await call(tool, configuration.input);
      const stateAfter = validCall.status === "passed"
        ? await waitForStateChange(before)
        : state();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const duplicateCall = await call(tool, configuration.input);
      const stateAfterDuplicate = state();
      const invalidCall = await call(
        tool,
        { unexpected: true },
      );
      const stateAfterInvalid = state();
      const abortController = new AbortController();
      abortController.abort();
      const cancelledCall = await call(
        tool,
        configuration.route === "root"
          ? { amount: 1, command_id: "boundary-cancelled" }
          : { deck: "diagnostic", side: "front", command_id: "boundary-cancelled" },
        abortController.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stateAfterCancelled = state();
      return {
        capability,
        ...boundary,
        originTrialStatus: observedOriginTrialStatus,
        originTrialFeature: null,
        originTrialOrigin: null,
        originTrialExpiry: null,
        originTrialParseError: null,
        discoveredTools,
        expectedToolNames: configuration.expectedToolNames,
        expectedToolFound: true,
        validCall,
        duplicateCall,
        invalidCall,
        cancelledCall,
        stateBefore: before,
        stateAfter,
        stateAfterDuplicate,
        stateAfterInvalid,
        stateAfterCancelled,
        originTrialToken,
      };
    }, productionRouteScript(route, expectedToolNames, invokedToolName, input));

    const token = summarizeOriginTrialToken(result.originTrialToken);
    const originTrialStatus = assessOriginTrial(
      token,
      result.origin ?? new URL(url).origin,
      result.capability,
      Date.now(),
    );
    const errors = browserErrors(diagnostics);
    const inventory = assessProductionInventory(
      result.discoveredTools.map((tool) => tool.name ?? ""),
      expectedToolNames,
    );
    const expectedToolFound = result.expectedToolFound && inventory.status === "passed";
    const boundary = classifyNativeBoundary({
      browserProduct: browserIdentity.actualName,
      expectedBrowserProduct: webMcpOracleExpectedBrowserName,
      browserVersion: browserIdentity.actualVersion,
      expectedBrowserVersion: webMcpOracleExpectedBrowserVersion,
      forbiddenBrowserInfluences: [
        ...browserIdentity.forbiddenInfluences,
        ...result.forbiddenInfluences,
      ],
      navigationStatus: response.status(),
      url: result.documentUrl,
      expectedUrl: url,
      origin: result.origin,
      expectedOrigin: webMcpOrigin,
      deploymentRoute: result.deploymentRoute,
      expectedDeploymentRoute: route === "root" ? "deck-home" : "study",
      deploymentRouteCount: result.deploymentRouteCount,
      secureContext: result.secureContext,
      originTrialMetaCount: result.originTrialMetaCount,
      originTrialTokenExact: result.originTrialTokenExact,
      originTrialStatus,
      permissionsPolicy: result.permissionsPolicy,
      capability: result.capability,
      browserErrors: errors,
    });
    const failureCode = boundary.failureCode ?? (
      !expectedToolFound
        ? inventory.failureCode ?? "expected-tool-missing"
        : null
    );
    const {
      originTrialToken: _originTrialToken,
      ...sanitizedResult
    } = result;
    void _originTrialToken;
    return {
      ...sanitizedResult,
      originTrialStatus,
      originTrialFeature: token.feature,
      originTrialOrigin: token.origin,
      originTrialExpiry: token.expiry,
      originTrialParseError: token.parseError,
      originTrialTokenSha256: result.originTrialToken
        ? createHash("sha256").update(result.originTrialToken).digest("hex")
        : null,
      url,
      navigationStatus: response.status(),
      browserErrors: errors,
      failureCode,
    };
  } catch (error) {
    return failedProductionRoute(
      url,
      response?.status() ?? null,
      response ? "runtime-probe-failed" : "deployment-route-failed",
      browserErrors(diagnostics),
      summarizeError(error),
    );
  }
}

async function inspectProductionHomeJourney(
  page: Page,
): Promise<{
  status: "passed" | "failed" | "not-evaluable";
  evidence: HomeJourneyEvidence | null;
  failureCode: string | null;
}> {
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  try {
    const response = await page.goto(productionRootUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response?.ok()) {
      return { status: "failed", evidence: null, failureCode: "home-deployment-route-failed" };
    }
    const initial = await page.evaluate(async (expectedNames) => {
      type Tool = { name?: string; inputSchema?: unknown; annotations?: unknown };
      type ModelContext = {
        getTools: () => Promise<Tool[]>;
        executeTool: (tool: Tool, input: string) => Promise<unknown>;
      };
      type Call = HomeJourneyEvidence["listCall"];
      const context = (document as Document & { modelContext?: ModelContext }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const call = async (tool: Tool, input: unknown): Promise<Call> => {
        try {
          return {
            status: "passed",
            result: (await context.executeTool(tool, JSON.stringify(input))) ?? null,
            error: null,
          };
        } catch (error) {
          return {
            status: "failed",
            result: null,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          };
        }
      };
      const decode = (value: unknown): Record<string, unknown> | null => {
        const decoded = typeof value === "string" ? JSON.parse(value) : value;
        return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
          ? decoded as Record<string, unknown>
          : null;
      };
      const request = <T>(operation: IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          operation.onsuccess = () => resolve(operation.result);
          operation.onerror = () => reject(operation.error);
        });
      const durableDecks = async () => {
        const opened = indexedDB.open("anki-web-mcp");
        const database = await request(opened);
        try {
          const transaction = database.transaction(
            ["decks", "cards", "schedules", "sessions"],
            "readonly",
          );
          const [decks, cards, schedules, sessions] = await Promise.all([
            request(transaction.objectStore("decks").getAll()),
            request(transaction.objectStore("cards").getAll()),
            request(transaction.objectStore("schedules").getAll()),
            request(transaction.objectStore("sessions").getAll()),
          ]) as Array<Array<Record<string, unknown>>>;
          const now = Date.now();
          return decks
            .sort((left, right) => Number(left.createdAt) - Number(right.createdAt) ||
              String(left.name).localeCompare(String(right.name)) ||
              String(left.id).localeCompare(String(right.id)))
            .map((deck) => {
              const deckSchedules = schedules.filter((schedule) => schedule.deckId === deck.id);
              return {
                id: deck.id,
                name: deck.name,
                card_count: cards.filter((card) => card.deckId === deck.id).length,
                due_count: deckSchedules.filter((schedule) =>
                  schedule.suspended !== true && Number(schedule.dueAt) <= now
                ).length,
                suspended_count: deckSchedules.filter((schedule) => schedule.suspended === true).length,
                last_studied_at: deck.lastStudiedAt === null
                  ? null
                  : new Date(Number(deck.lastStudiedAt)).toISOString(),
                can_start_session: sessions.some((session) =>
                  session.deckId === deck.id && session.completedAt === null
                ) || deckSchedules.some((schedule) =>
                  schedule.suspended !== true &&
                  (schedule.state === "new" || Number(schedule.dueAt) <= now)
                ),
              };
            });
        } finally {
          database.close();
        }
      };
      const visibleState = () => ({
        route: document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? null,
        pageState: document.querySelector("[data-deck-page-state]")?.getAttribute("data-deck-page-state") ?? null,
        text: document.querySelector("[data-deck-list]")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      });
      const deadline = Date.now() + 10_000;
      let tools: Tool[] = [];
      while (Date.now() < deadline) {
        tools = await context.getTools();
        const names = tools.map((tool) => tool.name ?? "");
        if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const listTool = tools.find((tool) => tool.name === "list_decks");
      const selectTool = tools.find((tool) => tool.name === "select_deck");
      if (!listTool || !selectTool) throw new Error("home-tool-missing");
      const stateBefore = visibleState();
      const durableBefore = await durableDecks();
      const listCall = await call(listTool, {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stateAfterList = visibleState();
      const durableAfterList = await durableDecks();
      const repeatedListCall = await call(listTool, {});
      const malformedListCall = await call(listTool, null);
      const stateAfterMalformed = visibleState();
      const durableAfterMalformed = await durableDecks();
      const extraListCall = await call(listTool, { extra: true });
      const stateAfterExtra = visibleState();
      const durableAfterExtra = await durableDecks();
      const listed = decode(listCall.result);
      const data = listed?.data !== null && typeof listed?.data === "object"
        ? listed.data as Record<string, unknown>
        : null;
      const decks = Array.isArray(data?.decks) ? data.decks as Array<Record<string, unknown>> : [];
      const visibleDecks = decks.every((deck) => {
        const row = document.querySelector(`[data-deck-row][data-deck-id="${CSS.escape(String(deck.id))}"]`);
        const text = row?.textContent?.replace(/\s+/g, " ") ?? "";
        return row !== null && text.includes(String(deck.name)) &&
          text.includes(`${deck.card_count} cards`) && text.includes(`${deck.due_count} due`) &&
          text.includes(`${deck.suspended_count} suspended`);
      }) ? decks : [{ parity: "visible-deck-mismatch" }];
      return {
        initialUrl: location.href,
        homeTools: tools.map((tool) => ({
          name: tool.name ?? null,
          inputSchema: JSON.parse(JSON.stringify(tool.inputSchema ?? null)),
          annotations: JSON.parse(JSON.stringify(tool.annotations ?? null)),
        })),
        stateBefore,
        stateAfterList,
        stateAfterMalformed,
        stateAfterExtra,
        durableBefore,
        durableAfterList,
        durableAfterMalformed,
        durableAfterExtra,
        visibleDecks,
        listCall,
        repeatedListCall,
        malformedListCall,
        extraListCall,
        selectedDeckId: typeof decks[0]?.id === "string" ? decks[0].id : null,
      };
    }, [...homeToolNames]);

    if (!initial.selectedDeckId) {
      const evidence = {
        ...initial,
        finalUrl: null,
        deploymentRoute: null,
        studyToolNames: [],
        selectCall: { status: "not-run" as const, result: null, error: null },
        durableAfterSelect: null,
        visibleStudy: null,
        browserErrors: browserErrors(diagnostics),
      };
      const assessment = assessHomeJourney(evidence, productionRootUrl, `${productionBaseUrl}/study/`);
      return { ...assessment, evidence };
    }

    const selectCall = await page.evaluate(async (deckId) => {
      const context = (document as Document & {
        modelContext?: {
          getTools: () => Promise<Array<{ name?: string }>>;
          executeTool: (tool: unknown, input: string) => Promise<unknown>;
        };
      }).modelContext;
      if (!context) return { status: "failed" as const, result: null, error: "native-unavailable" };
      const tool = (await context.getTools()).find((candidate) => candidate.name === "select_deck");
      if (!tool) return { status: "failed" as const, result: null, error: "select-deck-missing" };
      try {
        return {
          status: "passed" as const,
          result: (await context.executeTool(tool, JSON.stringify({ deck_id: deckId }))) ?? null,
          error: null,
        };
      } catch (error) {
        return {
          status: "failed" as const,
          result: null,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
      }
    }, initial.selectedDeckId);
    const expectedStudyUrl = `${productionBaseUrl}/study/?deck=${encodeURIComponent(initial.selectedDeckId)}`;
    await page.waitForURL(expectedStudyUrl, { timeout: 10_000 });
    const final = await page.evaluate(async (expectedNames) => {
      const context = (document as Document & {
        modelContext?: { getTools: () => Promise<Array<{ name?: string }>> };
      }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const deadline = Date.now() + 10_000;
      let names: string[] = [];
      while (Date.now() < deadline) {
        names = (await context.getTools()).map((tool) => tool.name ?? "");
        if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const request = <T>(operation: IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          operation.onsuccess = () => resolve(operation.result);
          operation.onerror = () => reject(operation.error);
        });
      const database = await request(indexedDB.open("anki-web-mcp"));
      let sessions: Array<Record<string, unknown>>;
      try {
        sessions = await request(database.transaction("sessions", "readonly").objectStore("sessions").getAll());
      } finally {
        database.close();
      }
      const params = new URL(location.href).searchParams;
      const deckId = params.get("deck");
      const durableSession = sessions.find((session) =>
        session.deckId === deckId && session.completedAt === null
      ) ?? null;
      const sessionText = document.querySelector("[data-study-session]")?.textContent ?? "";
      const sequenceMatch = /Session\s+(\d+)/.exec(sessionText);
      return {
        finalUrl: location.href,
        deploymentRoute: document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? null,
        studyToolNames: names,
        durableAfterSelect: durableSession,
        visibleStudy: {
          deck_id: deckId,
          session_sequence: sequenceMatch ? Number(sequenceMatch[1]) : null,
          current_card_id: document.querySelector("[data-study-card-id]")?.textContent ?? null,
        },
      };
    }, [...activeStudyToolNames]);
    const evidence: HomeJourneyEvidence = {
      ...initial,
      ...final,
      selectCall,
      browserErrors: browserErrors(diagnostics),
    };
    const assessment = assessHomeJourney(evidence, productionRootUrl, `${productionBaseUrl}/study/`);
    return { ...assessment, evidence };
  } catch (error) {
    const message = summarizeError(error);
    return {
      status: /native-unavailable/.test(message) ? "not-evaluable" : "failed",
      evidence: null,
      failureCode: /native-unavailable/.test(message) ? "native-unavailable" : "home-journey-probe-failed",
    };
  }
}

async function inspectProductionLifecycle(
  page: Page,
  rootUrl: string,
  studyUrl: string,
): Promise<ProductionLifecycleEvidence> {
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  const steps: Array<{
    step: RouteLifecycleObservation["step"];
    url: string;
    expectedToolNames: readonly ProductionToolName[];
  }> = [
    {
      step: "root-initial",
      url: rootUrl,
      expectedToolNames: homeToolNames,
    },
    {
      step: "study-after-root",
      url: studyUrl,
      expectedToolNames: emptyStudyToolNames,
    },
    {
      step: "root-after-study",
      url: rootUrl,
      expectedToolNames: homeToolNames,
    },
    {
      step: "study-reload",
      url: studyUrl,
      expectedToolNames: emptyStudyToolNames,
    },
  ];
  const observations: RouteLifecycleObservation[] = [];

  for (const item of steps) {
    observations.push(await inspectLifecycleStep(page, item));
  }

  const errors = browserErrors(diagnostics);
  const nativeUnavailable = observations.some(
    (observation) => observation.capability === "unavailable",
  );
  const passed = observations.length > 0 &&
    observations.every((observation) => observation.failureCode === null) &&
    errors.length === 0;
  return {
    status: nativeUnavailable ? "not-evaluable" : passed ? "passed" : "failed",
    observations,
    browserErrors: errors,
    failureCode: nativeUnavailable
      ? "native-unavailable"
      : passed
        ? null
        : observations.find((observation) => observation.failureCode)?.failureCode ??
          (errors.length > 0 ? "browser-errors" : "lifecycle-failed"),
  };
}

async function inspectLifecycleStep(
  page: Page,
  item: {
    step: RouteLifecycleObservation["step"];
    url: string;
    expectedToolNames: readonly ProductionToolName[];
  },
): Promise<RouteLifecycleObservation> {
  let response: PlaywrightResponse | null = null;
  let capability: Capability = "error";
  let discoveredToolNames: string[] = [];
  const isStudyStep = item.step === "study-after-root" ||
    item.step === "study-reload";
  let queryPreserved: boolean | null = isStudyStep
    ? false
    : null;
  try {
    response = await page.goto(item.url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response || !response.ok()) {
      return {
        step: item.step,
        url: item.url,
        navigationStatus: response?.status() ?? null,
        capability: "error",
        discoveredToolNames,
        expectedToolNames: [...item.expectedToolNames],
        oldRouteToolPresent: false,
        queryPreserved,
        failureCode: "deployment-route-failed",
      };
    }
    await page.waitForTimeout(300);
    const snapshot = await page.evaluate<{
      capability: Capability;
      toolNames: string[];
    }, string[]>(async (expectedToolNames) => {
      const context = (document as Document & {
        modelContext?: {
          getTools?: () => Promise<unknown[]>;
        };
      }).modelContext;
      if (!context) {
        return { capability: "unavailable", toolNames: [] };
      }
      if (typeof context.getTools !== "function") {
        return { capability: "error", toolNames: [] };
      }
      try {
        const deadline = Date.now() + 10_000;
        let tools: unknown[] = [];
        while (Date.now() < deadline) {
          tools = await context.getTools();
          const names = tools
            .filter((tool): tool is Record<string, unknown> =>
              tool !== null && typeof tool === "object",
            )
            .map((tool) => typeof tool.name === "string" ? tool.name : "")
            .filter((name) => name.length > 0);
          const complete = names.length === expectedToolNames.length &&
            new Set(names).size === names.length &&
            expectedToolNames.every((name) => names.includes(name));
          const unexpected = names.some((name) => !expectedToolNames.includes(name));
          if (complete || unexpected) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return {
          capability: "available",
          toolNames: tools
            .filter((tool): tool is Record<string, unknown> =>
              tool !== null && typeof tool === "object",
            )
            .map((tool) => typeof tool.name === "string" ? tool.name : "")
            .filter((name) => name.length > 0),
        };
      } catch {
        return { capability: "error", toolNames: [] };
      }
    }, [...item.expectedToolNames]);
    capability = snapshot.capability;
    discoveredToolNames = snapshot.toolNames;
    if (isStudyStep) {
      const actual = new URL(page.url());
      const expected = new URL(item.url);
      queryPreserved = actual.pathname === expected.pathname && actual.search === expected.search;
    }
  } catch {
    return {
      step: item.step,
      url: item.url,
      navigationStatus: response?.status() ?? null,
      capability,
      discoveredToolNames,
      expectedToolNames: [...item.expectedToolNames],
      oldRouteToolPresent: false,
      queryPreserved,
      failureCode: response ? "runtime-probe-failed" : "deployment-route-failed",
    };
  }

  const inventory = assessProductionInventory(discoveredToolNames, item.expectedToolNames);
  const oldRouteToolPresent = inventory.failureCode === "mixed-route-inventory";
  const failureCode = capability === "unavailable"
    ? "native-unavailable"
    : capability === "error"
      ? "capability-probe-failed"
      : inventory.failureCode
        ? inventory.failureCode
          : isStudyStep && !queryPreserved
            ? "study-query-not-preserved"
            : null;
  return {
    step: item.step,
    url: item.url,
    navigationStatus: response.status(),
    capability,
    discoveredToolNames,
    expectedToolNames: [...item.expectedToolNames],
    oldRouteToolPresent,
    queryPreserved,
    failureCode,
  };
}

function failedProductionRoute(
  url: string,
  navigationStatus: number | null,
  failureCode: string,
  errors: string[] = [],
  error: string | null = null,
): ProductionRouteEvidence {
  return {
    url,
    documentUrl: null,
    navigationStatus,
    capability: "error",
    secureContext: null,
    origin: null,
    permissionsPolicy: "unknown",
    deploymentRoute: null,
    deploymentRouteCount: 0,
    originTrialMetaPresent: false,
    originTrialMetaCount: 0,
    originTrialTokenExact: false,
    originTrialTokenLength: 0,
    originTrialTokenSha256: null,
    forbiddenInfluences: [],
    originTrialStatus: null,
    originTrialFeature: null,
    originTrialOrigin: null,
    originTrialExpiry: null,
    originTrialParseError: null,
    discoveredTools: [],
    expectedToolNames: [],
    expectedToolFound: false,
    validCall: { status: "not-run", result: null, error },
    duplicateCall: { status: "not-run", result: null, error: null },
    invalidCall: { status: "not-run", result: null, error: null },
    cancelledCall: { status: "not-run", result: null, error: null },
    stateBefore: null,
    stateAfter: null,
    stateAfterDuplicate: null,
    stateAfterInvalid: null,
    stateAfterCancelled: null,
    browserErrors: errors,
    failureCode,
  };
}

function childHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>WebMCP boundary child</title></head>
<body><main><h1>WebMCP boundary child</h1><p id="status">checking</p><output id="mutations">0</output>
<script>
(() => {
  const params = new URL(location.href).searchParams;
  const exposedTo = params.get('exposedTo');
  const status = document.querySelector('#status');
  const mutations = document.querySelector('#mutations');
  let mutationCount = 0;
  const report = (kind, details = {}) => {
    status.textContent = kind;
    parent.postMessage({ source: 'webmcp-boundary-child', kind, mutationCount, ...details }, '*');
  };
  const policy = document.permissionsPolicy || document.featurePolicy;
  let policyState = 'unknown';
  try {
    if (policy && typeof policy.allowsFeature === 'function') {
      policyState = policy.allowsFeature(${JSON.stringify(webMcpPermissionsPolicyFeature)}) ? 'allowed' : 'denied';
    }
  } catch {}
  const context = document.modelContext;
  if (!context || typeof context.registerTool !== 'function') {
    report('native-unavailable', { policy: policyState });
    return;
  }
  const tool = {
    name: 'webmcp_isolation_child',
    title: 'Boundary experiment child tool',
    description: 'Non-production boundary experiment. Increment only local child memory.',
    inputSchema: {
      type: 'object', properties: { command_id: { type: 'string', minLength: 1 } },
      required: ['command_id'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: async ({ command_id }) => {
      mutationCount += 1;
      mutations.textContent = String(mutationCount);
      return { status: 'applied', command: 'webmcp_isolation_child', command_id, mutation_count: mutationCount };
    },
  };
  const registration = { signal: new AbortController().signal };
  if (exposedTo) registration.exposedTo = [new URL(exposedTo).origin];
  context.registerTool(tool, registration).then(
    () => report('registered', { policy: policyState, exposedTo: exposedTo ? new URL(exposedTo).origin : null }),
    (error) => report('registration-error', { policy: policyState, error: error && error.name ? error.name + ': ' + error.message : String(error) }),
  );
})();
</script></main></body></html>`;
}

function hostHtml(childOrigin: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>WebMCP boundary host</title></head>
<body><main><h1>WebMCP boundary host</h1><p id="status">checking</p><iframe id="child" title="Boundary child"></iframe>
<script>
(() => {
  const childOrigin = ${JSON.stringify(childOrigin)};
  const params = new URL(location.href).searchParams;
  const mode = params.get('mode') || 'blocked';
  const frame = document.querySelector('#child');
  const status = document.querySelector('#status');
  const exposed = mode === 'explicitly-permitted' ? location.origin : '';
  const query = exposed ? '?exposedTo=' + encodeURIComponent(exposed) : '';
  if (mode === 'explicitly-permitted') frame.setAttribute('allow', 'tools');
  if (mode === 'delegated-without-exposure') frame.setAttribute('allow', 'tools');
  frame.src = childOrigin + '/child.html' + query;
  let childState = null;
  let executedResult = null;
  let executionError = null;
  let executionAttempted = false;
  let snapshotRunning = false;
  const policy = document.permissionsPolicy || document.featurePolicy;
  let hostPolicy = 'unknown';
  try {
    if (policy && typeof policy.allowsFeature === 'function') hostPolicy = policy.allowsFeature(${JSON.stringify(webMcpPermissionsPolicyFeature)}) ? 'allowed' : 'denied';
  } catch {}
  const capability = document.modelContext && typeof document.modelContext.getTools === 'function' && typeof document.modelContext.executeTool === 'function' ? 'available' : document.modelContext ? 'error' : 'unavailable';
  const snapshot = async () => {
    if (snapshotRunning) return;
    snapshotRunning = true;
    const result = { hostCapability: capability, hostPermissionsPolicy: hostPolicy, childPermissionsPolicy: childState && childState.policy || null, childRegistration: childState && childState.kind || null, childRegistrationError: childState && childState.error || null, executedResult, executionError, childMutationCount: childState && childState.mutationCount || (executedResult && executedResult.mutation_count) || null };
    try {
      if (capability !== 'available') {
        window.__webmcpIsolationSnapshot = result;
        status.textContent = capability;
        snapshotRunning = false;
        return;
      }
      const defaultTools = await document.modelContext.getTools();
      result.defaultToolNames = defaultTools.map((tool) => tool && tool.name).filter(Boolean);
      const requestedTools = await document.modelContext.getTools({ fromOrigins: [childOrigin] });
      result.requestedToolNames = requestedTools.map((tool) => tool && tool.name).filter(Boolean);
      const childTool = requestedTools.find((tool) => tool && tool.name === 'webmcp_isolation_child');
      if (mode === 'explicitly-permitted' && childTool && !executionAttempted) {
        executionAttempted = true;
        try {
          const rawResult = await document.modelContext.executeTool(childTool, JSON.stringify({ command_id: 'cross-origin-command' }));
          executedResult = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
        }
        catch (error) { executionError = error && error.name ? error.name + ': ' + error.message : String(error); }
        result.executedResult = executedResult;
        result.executionError = executionError;
        await new Promise((resolve) => setTimeout(resolve, 50));
        result.childMutationCount = childState && childState.mutationCount || (executedResult && executedResult.mutation_count) || null;
      }
    } catch (error) { result.executionError = error && error.name ? error.name + ': ' + error.message : String(error); }
    window.__webmcpIsolationSnapshot = result;
    status.textContent = JSON.stringify(result);
    snapshotRunning = false;
  };
  window.addEventListener('message', (event) => {
    if (event.origin !== childOrigin || !event.data || event.data.source !== 'webmcp-boundary-child') return;
    childState = event.data;
    void snapshot();
  });
  window.addEventListener('load', () => setTimeout(() => void snapshot(), 100));
  setTimeout(() => void snapshot(), 500);
})();
</script></main></body></html>`;
}

async function startHtmlServer(
  handler: (request: Request, origin: string) => Response,
): Promise<RunningHtmlServer> {
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      return handler(request, origin);
    },
  });
  return {
    origin,
    stop: async () => {
      server.stop(true);
    },
  };
}

async function runIsolationExperiment(executablePath: string): Promise<IsolationEvidence> {
  const childServer = await startHtmlServer(() =>
    new Response(childHtml(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
  const hostServer = await startHtmlServer(() =>
    new Response(hostHtml(childServer.origin), {
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [...launchArgs, "--enable-features=WebMCP"],
  });
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: desktopViewport,
  });
  const page = await context.newPage();
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  const cases: IsolationCaseEvidence[] = [];
  const modes = [
    { name: "blocked" as const, mode: "blocked" },
    { name: "delegated-without-exposure" as const, mode: "delegated-without-exposure" },
    { name: "explicitly-permitted" as const, mode: "explicitly-permitted" },
    { name: "permission-removed" as const, mode: "blocked" },
  ];
  try {
    for (const item of modes) {
      const url = `${hostServer.origin}/host.html?mode=${item.mode}&run=${item.name}`;
      await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
      const snapshot = await waitFor(
        async () => page.evaluate<IsolationSnapshot | false>("window.__webmcpIsolationSnapshot ?? false"),
        `${item.name} cross-origin boundary snapshot`,
      );
      const childRegistration = snapshot.childRegistration;
      const caseEvidence: IsolationCaseEvidence = {
        name: item.name,
        url,
        trustedOrigin: hostServer.origin,
        childOrigin: childServer.origin,
        hostPermissionsPolicy: snapshot.hostPermissionsPolicy,
        childPermissionsPolicy: snapshot.childPermissionsPolicy,
        childRegistration,
        childRegistrationError: snapshot.childRegistrationError,
        defaultToolNames: snapshot.defaultToolNames,
        requestedToolNames: snapshot.requestedToolNames,
        execution: {
          status: snapshot.executionError
            ? "failed"
            : snapshot.executedResult === null
              ? "not-run"
              : "passed",
          result: serialize(snapshot.executedResult),
          error: snapshot.executionError,
        },
        childMutationCount: snapshot.childMutationCount,
        failureCode: null,
      };
      const nativeUnavailable = snapshot.hostCapability !== "available" ||
        childRegistration === "native-unavailable";
      if (nativeUnavailable) {
        caseEvidence.failureCode = "native-unavailable";
      } else if (item.name === "explicitly-permitted") {
        if (
          childRegistration !== "registered" ||
          snapshot.defaultToolNames.length !== 0 ||
          snapshot.requestedToolNames.length !== 1 ||
          snapshot.requestedToolNames[0] !== "webmcp_isolation_child" ||
          snapshot.executionError !== null ||
          snapshot.childMutationCount !== 1
        ) {
          caseEvidence.failureCode = "explicit-permission-failed";
        }
      } else if (
        snapshot.defaultToolNames.length !== 0 ||
        snapshot.requestedToolNames.length !== 0
      ) {
        caseEvidence.failureCode = "cross-origin-tool-leaked";
      }
      cases.push(caseEvidence);
    }
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await hostServer.stop();
    await childServer.stop();
  }
  const evaluated = cases.every((item) => item.failureCode === null);
  const notEvaluated = cases.some((item) => item.failureCode === "native-unavailable");
  return {
    status: notEvaluated ? "not-evaluable" : evaluated ? "passed" : "failed",
    mode: "local-native-boundary-experiment",
    launchArgs: [...launchArgs, "--enable-features=WebMCP"],
    trustedOrigin: hostServer.origin,
    childOrigin: childServer.origin,
    cases,
    browserErrors: browserErrors(diagnostics),
    failureCode: notEvaluated
      ? "native-unavailable"
      : evaluated
        ? null
        : cases.find((item) => item.failureCode)?.failureCode ?? "boundary-failed",
  };
}

function decodedToolResult(call: ToolCall): Record<string, unknown> | null {
  if (call.status !== "passed") {
    return null;
  }
  const value = typeof call.result === "string"
    ? (() => {
        try {
          return JSON.parse(call.result);
        } catch {
          return null;
        }
      })()
    : call.result;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function callHasCode(call: ToolCall, code: string): boolean {
  return decodedToolResult(call)?.code === code;
}

function rejectedCallIsDeterministic(
  call: ToolCall,
  expectedPattern: RegExp,
): boolean {
  const result = decodedToolResult(call);
  const nestedError = result?.error !== null && typeof result?.error === "object"
    ? result.error as Record<string, unknown>
    : null;
  return (typeof result?.code === "string" && expectedPattern.test(result.code)) ||
    (typeof nestedError?.code === "string" && expectedPattern.test(nestedError.code)) ||
    (call.status === "failed" && expectedPattern.test(call.error ?? ""));
}

function cancellationIsDeterministic(call: ToolCall): boolean {
  return callHasCode(call, "execution-cancelled") ||
    (call.status === "failed" && /abort|cancel|stale/i.test(call.error ?? ""));
}

function statesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function productionRoutePassed(
  route: ProductionRouteEvidence,
): boolean {
  return route.capability === "available" &&
    route.expectedToolFound &&
    route.documentUrl === route.url &&
    route.deploymentRouteCount === 1 &&
    route.secureContext === true &&
    route.origin === webMcpOrigin &&
    route.origin === new URL(route.url).origin &&
    route.originTrialMetaPresent &&
    route.originTrialMetaCount === 1 &&
    route.originTrialTokenExact &&
    route.originTrialTokenLength === webMcpOriginTrialToken.length &&
    route.originTrialStatus === "accepted" &&
    route.permissionsPolicy === "allowed" &&
    route.forbiddenInfluences.length === 0 &&
    route.browserErrors.length === 0 &&
    route.failureCode === null &&
    route.validCall.status === "passed" &&
    route.duplicateCall.status === "passed" &&
    rejectedCallIsDeterministic(route.invalidCall, /invalid|schema|validation/i) &&
    statesEqual(route.stateAfter, route.stateBefore) &&
    statesEqual(route.stateAfterDuplicate, route.stateBefore) &&
    statesEqual(route.stateAfterInvalid, route.stateAfter) &&
    cancellationIsDeterministic(route.cancelledCall) &&
    statesEqual(route.stateAfterCancelled, route.stateAfter);
}

function productionPassed(
  root: ProductionRouteEvidence | null,
  study: ProductionRouteEvidence | null,
): boolean {
  if (!root || !study) {
    return false;
  }
  return productionRoutePassed(root) && productionRoutePassed(study);
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  let executablePath: string | null = null;
  let browser: Browser | undefined;
  let browserIdentity = emptyBrowserIdentity(null);
  let root: ProductionRouteEvidence | null = null;
  let study: ProductionRouteEvidence | null = null;
  let homeJourney: BoundaryReport["homeJourney"] = {
    status: "not-evaluable",
    evidence: null,
    failureCode: "not-started",
  };
  let lifecycle = emptyProductionLifecycle();
  let productionFailureCode: string | null = null;
  let isolation: IsolationEvidence = {
    status: "not-evaluable",
    mode: "local-native-boundary-experiment",
    launchArgs: [...launchArgs, "--enable-features=WebMCP"],
    trustedOrigin: "not-started",
    childOrigin: "not-started",
    cases: [],
    browserErrors: [],
    failureCode: "not-started",
  };
  try {
    executablePath = await findBrowserExecutable();
    browserIdentity = emptyBrowserIdentity(executablePath);
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [...launchArgs],
    });
    browserIdentity.actualVersion = browser.version();
    root = await inEphemeralContext(browser, async (rootPage) => {
      browserIdentity = await readBrowserIdentity(
        rootPage,
        browser as Browser,
        browserIdentity,
      );
      return await inspectProductionRoute(
        rootPage,
        browserIdentity,
        productionRootUrl,
        "root",
        homeToolNames,
        "list_decks",
        {},
      );
    });
    study = await inEphemeralContext(browser, async (studyPage) =>
      await inspectProductionRoute(
        studyPage,
        browserIdentity,
        productionStudyUrl,
        "study",
        emptyStudyToolNames,
        "get_state",
        {},
      )
    );
    homeJourney = await inEphemeralContext(browser, inspectProductionHomeJourney);
    lifecycle = await inEphemeralContext(browser, async (lifecyclePage) =>
      await inspectProductionLifecycle(
        lifecyclePage,
        productionRootUrl,
        productionStudyUrl,
      )
    );
    productionFailureCode = productionPassed(root, study) &&
        homeJourney.status === "passed" && lifecycle.status === "passed"
      ? null
      : root?.failureCode ?? study?.failureCode ?? homeJourney.failureCode ??
        lifecycle.failureCode ?? "production-boundary-failed";
  } catch (error) {
    productionFailureCode = executablePath
      ? "production-probe-failed"
      : "browser-launch-failed";
    if (!root) {
      root = failedProductionRoute(productionRootUrl, null, productionFailureCode, [], summarizeError(error));
    }
    if (!study) {
      study = failedProductionRoute(productionStudyUrl, null, productionFailureCode, [], summarizeError(error));
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  if (executablePath) {
    try {
      isolation = await runIsolationExperiment(executablePath);
    } catch (error) {
      isolation = {
        ...isolation,
        status: "failed",
        failureCode: "boundary-experiment-failed",
        browserErrors: [summarizeError(error)],
      };
    }
  }

  const productionReady = productionPassed(root, study) &&
    homeJourney.status === "passed" && lifecycle.status === "passed";
  const overall = productionReady
    ? isolation.status === "passed"
      ? "supported"
      : "no-go"
    : root?.failureCode === "native-unavailable" && study?.failureCode === "native-unavailable"
      ? "not-evaluable"
      : "no-go";
  const report: BoundaryReport = {
    schemaVersion: 1,
    generatedAt,
    runtimeOnly: true,
    overall,
    browser: browserIdentity,
    procedure: {
      productionUrls: { root: productionRootUrl, study: productionStudyUrl },
      productionLaunchArgs: [...launchArgs],
      profile: "isolated-ephemeral",
      contextPerCase: true,
      serviceWorkers: "blocked",
      extensions: "disabled",
      proxy: "none",
      productionWebMcpTestingFlag: "not-supplied",
      productionPolyfill: "none-loaded",
      inspection: "Playwright runtime calls to document.modelContext.getTools and executeTool",
      crossOriginExperiment: "A separate local native-feature run with explicit allow=tools and exposedTo origin gating; never deployed-native evidence.",
    },
    production: {
      status: productionReady
        ? "passed"
        : root?.failureCode === "native-unavailable" && study?.failureCode === "native-unavailable"
          ? "not-evaluable"
          : "failed",
      root,
      study,
      failureCode: productionFailureCode,
    },
    homeJourney,
    lifecycle,
    isolation,
    limitations: [
      "The production run is exact-URL evidence only; a local boundary experiment cannot establish GitHub Pages native support.",
      "The cross-origin experiment enables WebMCP solely to exercise browser policy behavior on loopback and is labeled separately from the production run.",
      "An absent native API, inaccessible route, or rejected production registration is recorded as no-go or not-evaluable rather than substituted with a mock or polyfill result.",
      "The runner does not infer support for nearby browser versions, alternate hosts, extensions, flags, or future WebMCP contract revisions.",
    ],
  };
  await mkdir(resolve(evidencePath, ".."), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    overall,
    production: { status: report.production.status, failureCode: report.production.failureCode },
    isolation: { status: isolation.status, failureCode: isolation.failureCode },
    browser: { version: browserIdentity.actualVersion, executablePath },
    evidence: evidencePath,
  }, null, 2));
  if (overall !== "supported" && !allowFailure) {
    process.exitCode = 1;
  }
}

await main();
