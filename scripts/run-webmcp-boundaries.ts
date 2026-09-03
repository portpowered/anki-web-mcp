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
import type {
  DurableHomeSnapshot,
  VisibleHomePageObservation,
} from "./webmcp-home-observation";
import {
  acquireDurableHomeSnapshot,
  observeVisibleHomePage,
  observeDurableDeckMetadata,
  projectDurableHomeDecks,
} from "./webmcp-home-observation";
import {
  assessStudyJourney,
  type StudyJourneyEvidence,
} from "./webmcp-study-journey";
import {
  acquireDurableStudySnapshot,
  observeVisibleStudyCard,
  readVisibleAnswerSemantics,
} from "./webmcp-study-observation";
import {
  assessSuspensionJourney,
  type SuspensionJourneyEvidence,
} from "./webmcp-suspension-journey";
import {
  assessLifecycleJourney,
  type LifecycleJourneyEvidence,
} from "./webmcp-lifecycle-journey";
import {
  assessAdversarialJourney,
  type AdversarialJourneyEvidence,
  type AdversarialRace,
} from "./webmcp-adversarial-journey";
import {
  assessBrowserContextIsolation,
  type BrowserContextIsolationEvidence,
  type ContextIsolationCall,
  type ContextStorageSnapshot,
  type IsolatedContextEvidence,
} from "./webmcp-browser-context-isolation";
import { sanitizeWebMcpEvidence } from "./webmcp-evidence-sanitization";
import { acquireCurrentPageTool } from "./webmcp-tool-acquisition";

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

type ProductionLifecycleEvidence = {
  status: "passed" | "failed" | "not-evaluable";
  evidence: LifecycleJourneyEvidence | null;
  browserErrors: string[];
  failureCode: string | null;
};

type IsolationCaseEvidence = {
  name: "blocked" | "delegated-without-exposure" | "wildcard-exposure" | "explicitly-permitted" | "permission-removed";
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

type ProductionContextIsolationEvidence = {
  status: "passed" | "failed" | "not-evaluable";
  mode: "production-browser-context-isolation";
  evidence: BrowserContextIsolationEvidence | null;
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
    failureDetail: string | null;
  };
  studyJourney: {
    status: "passed" | "failed" | "not-evaluable";
    evidence: StudyJourneyEvidence | null;
    failureCode: string | null;
    failureDetail: string | null;
  };
  suspensionJourney: {
    status: "passed" | "failed" | "not-evaluable";
    evidence: SuspensionJourneyEvidence | null;
    failureCode: string | null;
    failureDetail?: string | null;
  };
  adversarialJourney: {
    status: "passed" | "failed" | "not-evaluable";
    evidence: AdversarialJourneyEvidence | null;
    failureCode: string | null;
  };
  lifecycle: ProductionLifecycleEvidence;
  isolation: IsolationEvidence;
  browserContextIsolation: ProductionContextIsolationEvidence;
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
    evidence: null,
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
    return encoded === undefined
      ? null
      : sanitizeWebMcpEvidence(JSON.parse(encoded), [webMcpOriginTrialToken]);
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
  failureDetail: string | null;
}> {
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  try {
    const response = await page.goto(productionRootUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response?.ok()) {
      return {
        status: "failed",
        evidence: null,
        failureCode: "home-deployment-route-failed",
        failureDetail: null,
      };
    }
    const initial = await page.evaluate(async ({ expectedNames, durableSnapshotSource }) => {
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
      const durableSnapshot = (0, eval)(
        `(${durableSnapshotSource})`,
      ) as () => Promise<DurableHomeSnapshot>;
      const count = (text: string, label: string): number | null => {
        const match = new RegExp(`(?:^|\\s)([\\d,]+)\\s+${label}(?:\\s|$)`).exec(text);
        return match ? Number(match[1]!.replaceAll(",", "")) : null;
      };
      const visibleState = (): VisibleHomePageObservation => {
        const pageState = document.querySelector("[data-deck-page-state]")
          ?.getAttribute("data-deck-page-state") ?? null;
        return {
          state: pageState === "loading" || pageState === "empty" || pageState === "error" ||
              pageState === "populated"
            ? pageState
            : null,
          decks: Array.from(document.querySelectorAll<HTMLElement>("[data-deck-row]")).map((row) => {
            const text = row.textContent?.replace(/\s+/g, " ").trim() ?? "";
            const study = row.querySelector<HTMLButtonElement>('[data-deck-action="study"]');
            const studyLabel = study?.getAttribute("aria-label") ?? "";
            const action = studyLabel.startsWith("Start studying ")
              ? "start" as const
              : studyLabel.startsWith("Resume studying ")
                ? "resume" as const
                : null;
            const recovery = row.querySelector<HTMLButtonElement>(
              '[data-deck-action="restore-suspended"]',
            );
            return {
              id: row.getAttribute("data-deck-id"),
              name: action === "start"
                ? studyLabel.slice("Start studying ".length)
                : action === "resume"
                  ? studyLabel.slice("Resume studying ".length)
                  : null,
              card_count: count(text, "total"),
              new_count: count(text, "new"),
              due_count: count(text, "due"),
              suspended_count: count(text, "suspended"),
              recovery_available: recovery !== null && !recovery.disabled,
              study_action: action,
              study_keyboard_operable: study !== null && !study.disabled,
            };
          }),
        };
      };
      const deadline = Date.now() + 10_000;
      let tools: Tool[] = [];
      while (Date.now() < deadline) {
        tools = await context.getTools();
        const names = tools.map((tool) => tool.name ?? "");
        if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      while (Date.now() < deadline &&
          document.querySelector("[data-deck-page-state]")?.getAttribute("data-deck-page-state") === "loading") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const listTool = tools.find((tool) => tool.name === "list_decks");
      const selectTool = tools.find((tool) => tool.name === "select_deck");
      if (!listTool || !selectTool) throw new Error("home-tool-missing");
      const stateBefore = visibleState();
      const durableBeforeRaw = await durableSnapshot();
      const listCall = await call(listTool, {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stateAfterList = visibleState();
      const durableAfterListRaw = await durableSnapshot();
      const repeatedListCall = await call(listTool, {});
      const malformedListCall = await call(listTool, null);
      const malformedListInput = "null";
      const malformedListInvocation = {
        intendedToolName: "list_decks" as const,
        acquiredToolName: listTool.name ?? null,
        availableToolNames: tools.map((tool) => tool.name ?? ""),
        source: "current-registration",
        executeStarted: true,
      };
      const stateAfterMalformed = visibleState();
      const durableAfterMalformedRaw = await durableSnapshot();
      const extraListCall = await call(listTool, { extra: true });
      const stateAfterExtra = visibleState();
      const durableAfterExtraRaw = await durableSnapshot();
      const listed = decode(listCall.result);
      const data = listed?.data !== null && typeof listed?.data === "object"
        ? listed.data as Record<string, unknown>
        : null;
      const decks = Array.isArray(data?.decks) ? data.decks as Array<Record<string, unknown>> : [];
      const visibleHome = visibleState();
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
        durableBeforeRaw,
        durableAfterListRaw,
        durableAfterMalformedRaw,
        durableAfterExtraRaw,
        visibleHome,
        listCall,
        repeatedListCall,
        malformedListCall,
        malformedListInput,
        malformedListInvocation,
        extraListCall,
        selectedDeckId: typeof decks[0]?.id === "string" ? decks[0].id : null,
      };
    }, {
      expectedNames: [...homeToolNames],
      durableSnapshotSource: acquireDurableHomeSnapshot.toString(),
    });

    const visibleHome = await page.evaluate(observeVisibleHomePage, undefined);
    const {
      durableBeforeRaw,
      durableAfterListRaw,
      durableAfterMalformedRaw,
      durableAfterExtraRaw,
      visibleHome: _inlineVisibleHome,
      ...initialObservation
    } = initial;
    void _inlineVisibleHome;
    const initialWithDurable = {
      ...initialObservation,
      visibleHome,
      durableDeckMetadataBefore: observeDurableDeckMetadata(durableBeforeRaw),
      durableBefore: projectDurableHomeDecks(durableBeforeRaw),
      durableAfterList: projectDurableHomeDecks(durableAfterListRaw),
      durableAfterMalformed: projectDurableHomeDecks(durableAfterMalformedRaw),
      durableAfterExtra: projectDurableHomeDecks(durableAfterExtraRaw),
    };

    if (!initialWithDurable.selectedDeckId) {
      const evidence = {
        ...initialWithDurable,
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
    }, initialWithDurable.selectedDeckId);
    const expectedStudyUrl = `${productionBaseUrl}/study/?deck=${encodeURIComponent(initialWithDurable.selectedDeckId)}`;
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
      ...initialWithDurable,
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
      failureDetail: null,
    };
  }
}

async function inspectProductionStudyJourney(
  page: Page,
): Promise<BoundaryReport["studyJourney"]> {
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  try {
    const response = await page.goto(productionRootUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response?.ok()) {
      return {
        status: "failed",
        evidence: null,
        failureCode: "study-entry-route-failed",
        failureDetail: `http-status:${response?.status() ?? "missing"}`,
      };
    }
    const deckId = await page.evaluate(async (expectedNames) => {
      type Tool = { name?: string };
      type Context = {
        getTools: () => Promise<Tool[]>;
        executeTool: (tool: Tool, input: string) => Promise<unknown>;
      };
      const context = (document as Document & { modelContext?: Context }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const deadline = Date.now() + 10_000;
      let tools: Tool[] = [];
      while (Date.now() < deadline) {
        tools = await context.getTools();
        const names = tools.map((tool) => tool.name ?? "");
        if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const list = tools.find((tool) => tool.name === "list_decks");
      const select = tools.find((tool) => tool.name === "select_deck");
      if (!list || !select) throw new Error("study-entry-home-tool-missing");
      const rawList = await context.executeTool(list, "{}");
      const listed = typeof rawList === "string" ? JSON.parse(rawList) : rawList;
      const decks = listed?.data?.decks;
      const returnedDeckId = Array.isArray(decks) && typeof decks[0]?.id === "string"
        ? decks[0].id
        : null;
      if (!returnedDeckId) throw new Error("study-entry-seed-unavailable");
      const selected = await context.executeTool(select, JSON.stringify({ deck_id: returnedDeckId }));
      const decoded = typeof selected === "string" ? JSON.parse(selected) : selected;
      if (decoded?.ok !== true || decoded?.data?.deck_id !== returnedDeckId) {
        throw new Error("study-entry-selection-failed");
      }
      return returnedDeckId;
    }, [...homeToolNames]);
    const expectedUrl = `${productionBaseUrl}/study/?deck=${encodeURIComponent(deckId)}`;
    await page.waitForURL(expectedUrl, { timeout: 10_000 });
    const evidence = await page.evaluate(async ({
      expectedNames,
      selectedDeckId,
      observerSource,
      answerObserverSource,
      durableSnapshotSource,
    }) => {
      type Tool = { name?: string; inputSchema?: unknown; annotations?: unknown };
      type Call = StudyJourneyEvidence["getStateCall"];
      type Context = {
        getTools: () => Promise<Tool[]>;
        executeTool: (tool: Tool, input: string) => Promise<unknown>;
      };
      const context = (document as Document & { modelContext?: Context }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const observeStudyCard = (0, eval)(`(${observerSource})`) as typeof observeVisibleStudyCard;
      const readAnswerSemantics = (0, eval)(`(${answerObserverSource})`) as typeof readVisibleAnswerSemantics;
      const acquireStudySnapshot = (0, eval)(`(${durableSnapshotSource})`) as typeof acquireDurableStudySnapshot;
      const deadline = Date.now() + 10_000;
      let tools: Tool[] = [];
      while (Date.now() < deadline) {
        tools = await context.getTools();
        const names = tools.map((tool) => tool.name ?? "");
        if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const byName = (name: string) => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`study-tool-missing:${name}`);
        return tool;
      };
      const call = async (name: string, input: unknown): Promise<Call> => {
        try {
          return {
            status: "passed",
            result: (await context.executeTool(byName(name), JSON.stringify(input))) ?? null,
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
      const decode = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;
      const settle = async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      };
      const snapshot = async () => {
        const durable = await acquireStudySnapshot({ selectedDeckId });
        const card = durable.card;
        const progress = document.querySelector("[data-study-progress]");
        let answerSemantic: unknown = null;
        if (typeof card?.answerHtml === "string") {
          const expected = document.createElement("section");
          expected.style.position = "fixed";
          expected.style.left = "-100000px";
          expected.innerHTML = card.answerHtml;
          document.body.append(expected);
          answerSemantic = readAnswerSemantics(expected);
          expected.remove();
        }
        const visibleCard = observeStudyCard(document, readAnswerSemantics);
        return {
          visible: {
            route: document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? null,
            state: document.querySelector("[data-study-state]")?.getAttribute("data-study-state") ?? null,
            cardId: visibleCard.cardId,
            sessionSequence: visibleCard.sessionSequence,
            side: visibleCard.side,
            sideDetail: visibleCard.detail,
            answerState: visibleCard.answerState,
            answerSemantic: visibleCard.answerSemantic,
            content: document.querySelector("[data-flashcard-content]")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
            progressCurrent: Number(progress?.getAttribute("aria-valuenow")),
            progressTotal: Number(progress?.getAttribute("aria-valuemax")),
          },
          durable: { ...durable, answerSemantic },
        };
      };
      const before = await snapshot();
      const getStateCall = await call("get_state", {});
      await settle();
      const afterRead = await snapshot();
      const repeatedGetStateCall = await call("get_state", {});
      await settle();
      const afterRepeatedRead = await snapshot();
      const frontState = decode(getStateCall.result)?.data?.state;
      const cardId = typeof frontState?.current_card?.id === "string" ? frontState.current_card.id : null;
      if (!cardId) throw new Error("study-active-card-unavailable");
      const prematureRatingCall = await call("set_state", {
        card_id: cardId,
        command_id: "evidence-premature-rating",
        rating: "good",
      });
      await settle();
      const afterPrematureRating = await snapshot();
      const flipCommandId = "evidence-flip";
      const flipInput = { card_id: cardId, command_id: flipCommandId };
      const flipCall = await call("flip", flipInput);
      await settle();
      const afterFlip = await snapshot();
      const flipRetryCall = await call("flip", flipInput);
      await settle();
      const afterFlipRetry = await snapshot();
      const ratingCommandId = "evidence-rating";
      const ratingCall = await call("set_state", {
        card_id: cardId,
        command_id: ratingCommandId,
        rating: "good",
      });
      await settle();
      const afterRating = await snapshot();
      return {
        url: location.href,
        deckId: selectedDeckId,
        cardId,
        tools: tools.map((tool) => ({
          name: tool.name ?? null,
          inputSchema: JSON.parse(JSON.stringify(tool.inputSchema ?? null)),
          annotations: JSON.parse(JSON.stringify(tool.annotations ?? null)),
        })),
        before,
        afterRead,
        afterRepeatedRead,
        afterPrematureRating,
        afterFlip,
        afterFlipRetry,
        afterRating,
        getStateCall,
        repeatedGetStateCall,
        prematureRatingCall,
        flipCall,
        flipRetryCall,
        ratingCall,
        flipCommandId,
        ratingCommandId,
        rating: "good" as const,
      };
    }, {
      expectedNames: [...activeStudyToolNames],
      selectedDeckId: deckId,
      observerSource: observeVisibleStudyCard.toString(),
      answerObserverSource: readVisibleAnswerSemantics.toString(),
      durableSnapshotSource: acquireDurableStudySnapshot.toString(),
    });
    const completeEvidence: StudyJourneyEvidence = {
      ...evidence,
      browserErrors: browserErrors(diagnostics),
    };
    const assessment = assessStudyJourney(completeEvidence);
    return { ...assessment, evidence: completeEvidence };
  } catch (error) {
    const message = summarizeError(error);
    return {
      status: /native-unavailable/.test(message) ? "not-evaluable" : "failed",
      evidence: null,
      failureCode: /native-unavailable/.test(message) ? "native-unavailable" : "study-journey-probe-failed",
      failureDetail: message,
    };
  }
}

async function inspectProductionSuspensionJourney(
  page: Page,
): Promise<BoundaryReport["suspensionJourney"]> {
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  try {
    const response = await page.goto(productionRootUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response?.ok()) {
      return { status: "failed", evidence: null, failureCode: "suspension-entry-route-failed" };
    }
    const deckId = await page.evaluate(async (expectedNames) => {
      type Tool = { name?: string };
      type Context = {
        getTools: () => Promise<Tool[]>;
        executeTool: (tool: Tool, input: string) => Promise<unknown>;
      };
      const context = (document as Document & { modelContext?: Context }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const deadline = Date.now() + 10_000;
      let tools: Tool[] = [];
      while (Date.now() < deadline) {
        tools = await context.getTools();
        const names = tools.map((tool) => tool.name ?? "");
        if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const list = tools.find((tool) => tool.name === "list_decks");
      const select = tools.find((tool) => tool.name === "select_deck");
      if (!list || !select) throw new Error("suspension-entry-home-tool-missing");
      const raw = await context.executeTool(list, "{}");
      const listed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const returnedDeckId = Array.isArray(listed?.data?.decks) &&
          typeof listed.data.decks[0]?.id === "string"
        ? listed.data.decks[0].id as string
        : null;
      if (!returnedDeckId) throw new Error("suspension-entry-seed-unavailable");
      const selectedRaw = await context.executeTool(select, JSON.stringify({ deck_id: returnedDeckId }));
      const selected = typeof selectedRaw === "string" ? JSON.parse(selectedRaw) : selectedRaw;
      if (selected?.ok !== true || selected?.data?.deck_id !== returnedDeckId) {
        throw new Error("suspension-entry-selection-failed");
      }
      return returnedDeckId;
    }, [...homeToolNames]);

    const studyUrl = `${productionBaseUrl}/study/?deck=${encodeURIComponent(deckId)}`;
    await page.waitForURL(studyUrl, { timeout: 10_000 });
    const study = await page.evaluate(async ({
      expectedNames,
      homeNames,
      selectedDeckId,
      observerSource,
      answerObserverSource,
      acquisitionSource,
    }) => {
      type Tool = { name?: string };
      type Call = SuspensionJourneyEvidence["suspendCall"];
      type Context = {
        getTools: () => Promise<Tool[]>;
        executeTool: (tool: Tool, input: string) => Promise<unknown>;
      };
      const context = (document as Document & { modelContext?: Context }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const observeStudyCard = (0, eval)(`(${observerSource})`) as typeof observeVisibleStudyCard;
      const readAnswerSemantics = (0, eval)(`(${answerObserverSource})`) as typeof readVisibleAnswerSemantics;
      const acquireCurrentTool = (0, eval)(`(${acquisitionSource})`) as typeof acquireCurrentPageTool<Tool>;
      const request = <T>(operation: IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          operation.onsuccess = () => resolve(operation.result);
          operation.onerror = () => reject(operation.error);
        });
      const settle = async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      };
      const readRouteIdentity = () => `${location.href}|${
        document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? ""
      }`;
      const expectedRouteIdentity = readRouteIdentity();
      const acquire = async (name: string, previousTool?: Tool) => await acquireCurrentTool({
        getTools: context.getTools.bind(context),
        readRouteIdentity,
        expectedRouteIdentity,
        expectedToolNames: expectedNames,
        otherRouteToolNames: homeNames,
        requestedName: name,
        previousTool,
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });
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
      const decode = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;
      const getStateTool = await acquire("get_state");
      const getState = await call(getStateTool.tool, {});
      const currentCardId = decode(getState.result)?.data?.state?.current_card?.id;
      if (typeof currentCardId !== "string") throw new Error("suspension-active-card-unavailable");
      const snapshot = async () => {
        const database = await request(indexedDB.open("anki-web-mcp"));
        try {
          const transaction = database.transaction(
            ["meta", "decks", "sessions", "cards", "schedules", "reviewLogs"],
            "readonly",
          );
          const deck = await request(transaction.objectStore("decks").get(selectedDeckId)) ?? null;
          const sessions = await request(transaction.objectStore("sessions").getAll()) as Array<Record<string, unknown>>;
          const session = sessions.find((candidate) =>
            candidate.deckId === selectedDeckId && candidate.completedAt === null
          ) ?? sessions.find((candidate) => candidate.deckId === selectedDeckId) ?? null;
          const activeCardId = typeof session?.activeCardId === "string"
            ? session.activeCardId
            : currentCardId;
          const card = await request(transaction.objectStore("cards").get(activeCardId)) ?? null;
          const cards = (await request(transaction.objectStore("cards").getAll()) as Array<Record<string, unknown>>)
            .filter((candidate) => candidate.deckId === selectedDeckId)
            .sort((left, right) => String(left.id).localeCompare(String(right.id)));
          const schedule = await request(transaction.objectStore("schedules").get(currentCardId)) ?? null;
          const schedules = (await request(transaction.objectStore("schedules").getAll()) as Array<Record<string, unknown>>)
            .filter((candidate) => candidate.deckId === selectedDeckId)
            .sort((left, right) => String(left.cardId).localeCompare(String(right.cardId)));
          const reviewLogs = (await request(transaction.objectStore("reviewLogs").getAll()) as Array<Record<string, unknown>>)
            .filter((log) => log.deckId === selectedDeckId)
            .sort((left, right) => String(left.id).localeCompare(String(right.id)));
          const commandEvidence = await request(
            transaction.objectStore("meta").get("study.suspend:evidence-suspend"),
          ) ?? null;
          const progress = document.querySelector("[data-study-progress]");
          const visibleCard = observeStudyCard(document, readAnswerSemantics);
          return {
            visible: {
              route: document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? null,
              state: document.querySelector("[data-study-state]")?.getAttribute("data-study-state") ?? null,
              cardId: visibleCard.cardId,
              side: visibleCard.side,
              sideDetail: visibleCard.detail,
              progressCurrent: Number(progress?.getAttribute("aria-valuenow")),
              progressTotal: Number(progress?.getAttribute("aria-valuemax")),
            },
            durable: { deck, session, card, cards, schedule, schedules, commandEvidence, reviewLogs },
          };
        } finally {
          database.close();
        }
      };
      const before = await snapshot();
      const input = { card_id: currentCardId, command_id: "evidence-suspend" };
      const firstSuspend = await acquire("suspend");
      const suspendCall = await call(firstSuspend.tool, input);
      await settle();
      const afterSuspend = await snapshot();
      const retrySuspend = await acquire("suspend", firstSuspend.tool);
      const suspendRetryCall = await call(retrySuspend.tool, input);
      await settle();
      const afterSuspendRetry = await snapshot();
      const collisionSuspend = await acquire("suspend");
      const collisionCall = await call(collisionSuspend.tool, {
        card_id: decode(suspendCall.result)?.data?.suspension?.next_card_id,
        command_id: input.command_id,
      });
      await settle();
      const afterCollision = await snapshot();
      const crossToolCollision = await acquire("flip");
      const crossToolCollisionCall = await call(crossToolCollision.tool, input);
      await settle();
      const afterCrossToolCollision = await snapshot();
      const goHome = await acquire("go_home");
      const goHomeCall = await call(goHome.tool, {});
      return {
        cardId: currentCardId,
        studyToolNames: firstSuspend.toolNames,
        suspendRetryToolNames: retrySuspend.toolNames,
        suspendRegistrationRotated: retrySuspend.tool !== firstSuspend.tool,
        suspendRetryAcquisitionAttempts: retrySuspend.attempts,
        suspendCommandId: input.command_id,
        collisionToolNames: collisionSuspend.toolNames,
        crossToolCollisionToolNames: crossToolCollision.toolNames,
        goHomeToolNames: goHome.toolNames,
        before,
        afterSuspend,
        afterSuspendRetry,
        afterCollision,
        afterCrossToolCollision,
        suspendCall,
        suspendRetryCall,
        collisionCall,
        crossToolCollisionCall,
        goHomeCall,
      };
    }, {
      expectedNames: [...activeStudyToolNames],
      homeNames: [...homeToolNames],
      selectedDeckId: deckId,
      observerSource: observeVisibleStudyCard.toString(),
      answerObserverSource: readVisibleAnswerSemantics.toString(),
      acquisitionSource: acquireCurrentPageTool.toString(),
    });

    await page.waitForURL(productionRootUrl, { timeout: 10_000 });
    const home = await page.evaluate(async ({ expectedNames, studyNames, selectedDeckId, suspendedCardId, acquisitionSource }) => {
      type Tool = { name?: string };
      type Call = SuspensionJourneyEvidence["restoreCall"];
      type Context = {
        getTools: () => Promise<Tool[]>;
        executeTool: (tool: Tool, input: string) => Promise<unknown>;
      };
      const context = (document as Document & { modelContext?: Context }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const acquireCurrentTool = (0, eval)(`(${acquisitionSource})`) as typeof acquireCurrentPageTool<Tool>;
      const request = <T>(operation: IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          operation.onsuccess = () => resolve(operation.result);
          operation.onerror = () => reject(operation.error);
        });
      const settle = async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      };
      const readRouteIdentity = () => `${location.href}|${
        document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? ""
      }`;
      const expectedRouteIdentity = readRouteIdentity();
      const acquire = async (name: string, previousTool?: Tool) => await acquireCurrentTool({
        getTools: context.getTools.bind(context),
        readRouteIdentity,
        expectedRouteIdentity,
        expectedToolNames: expectedNames,
        otherRouteToolNames: studyNames,
        requestedName: name,
        previousTool,
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });
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
      const snapshot = async () => {
        const database = await request(indexedDB.open("anki-web-mcp"));
        try {
          const transaction = database.transaction(
            ["sessions", "schedules", "reviewLogs"],
            "readonly",
          );
          const sessions = await request(transaction.objectStore("sessions").getAll()) as Array<Record<string, unknown>>;
          const session = sessions.find((candidate) => candidate.deckId === selectedDeckId) ?? null;
          const schedule = await request(transaction.objectStore("schedules").get(suspendedCardId)) ?? null;
          const reviewLogs = (await request(transaction.objectStore("reviewLogs").getAll()) as Array<Record<string, unknown>>)
            .filter((log) => log.deckId === selectedDeckId)
            .sort((left, right) => String(left.id).localeCompare(String(right.id)));
          const row = document.querySelector(`[data-deck-row][data-deck-id="${CSS.escape(selectedDeckId)}"]`);
          const text = row?.textContent?.replace(/\s+/g, " ") ?? "";
          const dueMatch = text.match(/(\d+) due/);
          const recovery = row?.querySelector<HTMLButtonElement>(
            '[data-deck-action="restore-suspended"]',
          );
          return {
            visible: {
              deckId: row?.getAttribute("data-deck-id") ?? null,
              recoveryAvailable: recovery != null && !recovery.disabled,
              dueCount: dueMatch ? Number(dueMatch[1]) : null,
            },
            session,
            schedule,
            reviewLogs,
          };
        } finally {
          database.close();
        }
      };
      const homeAfterGo = await snapshot();
      const input = { deck_id: selectedDeckId, command_id: "evidence-restore" };
      const restore = await acquire("restore_suspended");
      const restoreCall = await call(restore.tool, input);
      await settle();
      const homeAfterRestore = await snapshot();
      const restoreRetry = await acquire("restore_suspended");
      const restoreRetryCall = await call(restoreRetry.tool, input);
      await settle();
      const homeAfterRestoreRetry = await snapshot();
      const selectDeck = await acquire("select_deck");
      const selectDeckCall = await call(selectDeck.tool, { deck_id: selectedDeckId });
      return {
        homeUrl: location.href,
        deploymentRoute: document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? null,
        homeToolNames: restore.toolNames,
        restoreRetryToolNames: restoreRetry.toolNames,
        homeAfterGo,
        restoreCall,
        homeAfterRestore,
        restoreRetryCall,
        homeAfterRestoreRetry,
        selectDeckCall,
      };
    }, {
      expectedNames: [...homeToolNames],
      studyNames: [...activeStudyToolNames],
      selectedDeckId: deckId,
      suspendedCardId: study.cardId,
      acquisitionSource: acquireCurrentPageTool.toString(),
    });

    await page.waitForURL(studyUrl, { timeout: 10_000 });
    const finalStudyToolNames = await page.evaluate(async ({ expectedNames, homeNames, acquisitionSource }) => {
      type Tool = { name?: string };
      type Context = { getTools: () => Promise<Tool[]> };
      const context = (document as Document & { modelContext?: Context }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const acquireCurrentTool = (0, eval)(`(${acquisitionSource})`) as typeof acquireCurrentPageTool<Tool>;
      const readRouteIdentity = () => `${location.href}|${
        document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? ""
      }`;
      const acquired = await acquireCurrentTool({
        getTools: context.getTools.bind(context),
        readRouteIdentity,
        expectedRouteIdentity: readRouteIdentity(),
        expectedToolNames: expectedNames,
        otherRouteToolNames: homeNames,
        requestedName: "get_state",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });
      return acquired.toolNames;
    }, {
      expectedNames: [...activeStudyToolNames],
      homeNames: [...homeToolNames],
      acquisitionSource: acquireCurrentPageTool.toString(),
    });

    const evidence: SuspensionJourneyEvidence = {
      deckId,
      studyUrl,
      ...study,
      ...home,
      finalStudyToolNames,
      browserErrors: browserErrors(diagnostics),
    };
    const assessment = assessSuspensionJourney(evidence, productionRootUrl);
    return { ...assessment, evidence };
  } catch (error) {
    const message = summarizeError(error);
    return {
      status: /native-unavailable/.test(message) ? "not-evaluable" : "failed",
      evidence: null,
      failureCode: /native-unavailable/.test(message)
        ? "native-unavailable"
        : message.match(/current-tool-acquisition:([a-z-]+)/)?.[1]
          ? `suspension-${message.match(/current-tool-acquisition:([a-z-]+)/)?.[1]}`
          : "suspension-journey-probe-failed",
      failureDetail: message,
    };
  }
}

type AdversarialStudyKind = "validation" | "review" | "suspend" | "conflict";

async function enterFreshProductionStudy(page: Page): Promise<string> {
  const response = await page.goto(productionRootUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (!response?.ok()) throw new Error("adversarial-entry-route-failed");
  const deckId = await page.evaluate(async (expectedNames) => {
    type Tool = { name?: string };
    type Context = {
      getTools: () => Promise<Tool[]>;
      executeTool: (tool: Tool, input: string) => Promise<unknown>;
    };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context) throw new Error("native-unavailable");
    const deadline = Date.now() + 10_000;
    let tools: Tool[] = [];
    while (Date.now() < deadline) {
      tools = await context.getTools();
      const names = tools.map((tool) => tool.name ?? "");
      if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const list = tools.find((tool) => tool.name === "list_decks");
    const select = tools.find((tool) => tool.name === "select_deck");
    if (!list || !select) throw new Error("adversarial-home-tool-missing");
    const listedRaw = await context.executeTool(list, "{}");
    const listed = typeof listedRaw === "string" ? JSON.parse(listedRaw) : listedRaw;
    const candidate = listed?.data?.decks?.[0]?.id;
    if (typeof candidate !== "string") throw new Error("adversarial-seed-unavailable");
    const selectedRaw = await context.executeTool(select, JSON.stringify({ deck_id: candidate }));
    const selected = typeof selectedRaw === "string" ? JSON.parse(selectedRaw) : selectedRaw;
    if (selected?.ok !== true) throw new Error("adversarial-select-failed");
    return candidate;
  }, [...homeToolNames]);
  await page.waitForURL(
    `${productionBaseUrl}/study/?deck=${encodeURIComponent(deckId)}`,
    { timeout: 10_000 },
  );
  return deckId;
}

async function inspectAdversarialStudyCase(
  page: Page,
  kind: AdversarialStudyKind,
): Promise<{
  validation?: Omit<AdversarialJourneyEvidence["validation"], "browserErrors">;
  race?: AdversarialRace;
  browserErrors: string[];
}> {
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  const deckId = await enterFreshProductionStudy(page);
  const result = await page.evaluate(async ({ expectedNames, selectedDeckId, caseKind, observerSource, answerObserverSource }) => {
    type Tool = { name?: string };
    type Call = StudyJourneyEvidence["getStateCall"];
    type Context = {
      getTools: () => Promise<Tool[]>;
      executeTool: (tool: Tool, input: string) => Promise<unknown>;
    };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context) throw new Error("native-unavailable");
    const observeStudyCard = (0, eval)(`(${observerSource})`) as typeof observeVisibleStudyCard;
    const readAnswerSemantics = (0, eval)(`(${answerObserverSource})`) as typeof readVisibleAnswerSemantics;
    const deadline = Date.now() + 10_000;
    let tools: Tool[] = [];
    while (Date.now() < deadline) {
      tools = await context.getTools();
      const names = tools.map((tool) => tool.name ?? "");
      if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const callRaw = async (name: string, input: string): Promise<Call> => {
      try {
        const tool = (await context.getTools()).find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`adversarial-tool-missing:${name}`);
        return { status: "passed", result: (await context.executeTool(tool, input)) ?? null, error: null };
      } catch (error) {
        return {
          status: "failed",
          result: null,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
      }
    };
    const callCurrentFlip = async (input: string) => {
      let availableToolNames: string[] = [];
      let acquiredToolName: string | null = null;
      let executeStarted = false;
      try {
        const currentTools = await context.getTools();
        availableToolNames = currentTools.map((candidate) => candidate.name ?? "");
        const tool = currentTools.find((candidate) => candidate.name === "flip");
        acquiredToolName = tool?.name ?? null;
        if (!tool) {
          return {
            call: { status: "not-run" as const, result: null, error: "adversarial-tool-missing:flip" },
            invocation: {
              intendedToolName: "flip" as const,
              acquiredToolName,
              availableToolNames,
              source: "current-registration" as const,
              executeStarted,
            },
          };
        }
        executeStarted = true;
        const result = await context.executeTool(tool, input);
        return {
          call: { status: "passed" as const, result: result ?? null, error: null },
          invocation: {
            intendedToolName: "flip" as const,
            acquiredToolName,
            availableToolNames,
            source: "current-registration" as const,
            executeStarted,
          },
        };
      } catch (error) {
        return {
          call: {
            status: "failed" as const,
            result: null,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          },
          invocation: {
            intendedToolName: "flip" as const,
            acquiredToolName,
            availableToolNames,
            source: "current-registration" as const,
            executeStarted,
          },
        };
      }
    };
    const call = (name: string, input: unknown) => callRaw(name, JSON.stringify(input));
    const decode = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;
    const request = <T>(operation: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error);
      });
    const settle = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    };
    const snapshot = async (retainedCardId: string) => {
      const capturedAt = Date.now();
      const database = await request(indexedDB.open("anki-web-mcp"));
      let session: Record<string, unknown> | null = null;
      let card: Record<string, unknown> | null = null;
      let schedule: Record<string, unknown> | null = null;
      let decks: Array<Record<string, unknown>> = [];
      let cards: Array<Record<string, unknown>> = [];
      let sessions: Array<Record<string, unknown>> = [];
      let schedules: Array<Record<string, unknown>> = [];
      let reviewLogs: Array<Record<string, unknown>> = [];
      const stores: Record<string, Array<Record<string, unknown>>> = {};
      try {
        const storeNames = [...database.objectStoreNames].sort();
        const transaction = database.transaction(storeNames, "readonly");
        const valuesByStore = await Promise.all(storeNames.map((storeName) =>
          request(transaction.objectStore(storeName).getAll()) as Promise<Array<Record<string, unknown>>>
        ));
        for (const [index, storeName] of storeNames.entries()) {
          const values = valuesByStore[index]!;
          stores[storeName] = storeName === "media"
            ? await Promise.all(values.map(async ({ blob, ...value }) => {
              if (!(blob instanceof Blob)) return { ...value, blob: null };
              const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
              const bytesSha256 = Array.from(new Uint8Array(digest), (byte) =>
                byte.toString(16).padStart(2, "0")).join("");
              return { ...value, blob: { size: blob.size, type: blob.type, bytesSha256 } };
            }))
            : values;
        }
        decks = (stores.decks ?? [])
          .filter((candidate) => candidate.id === selectedDeckId);
        cards = (stores.cards ?? [])
          .filter((candidate) => candidate.deckId === selectedDeckId)
          .sort((left, right) => String(left.id).localeCompare(String(right.id)));
        sessions = (stores.sessions ?? [])
          .filter((candidate) => candidate.deckId === selectedDeckId)
          .sort((left, right) => String(left.id).localeCompare(String(right.id)));
        session = sessions.find((candidate) => candidate.deckId === selectedDeckId && candidate.completedAt === null) ??
          sessions.find((candidate) => candidate.deckId === selectedDeckId) ?? null;
        card = (stores.cards ?? []).find((candidate) => candidate.id === retainedCardId) ?? null;
        schedule = (stores.schedules ?? []).find((candidate) => candidate.cardId === retainedCardId) ?? null;
        schedules = (stores.schedules ?? [])
          .filter((candidate) => candidate.deckId === selectedDeckId)
          .sort((left, right) => String(left.cardId).localeCompare(String(right.cardId)));
        reviewLogs = (stores.reviewLogs ?? [])
          .filter((candidate) => candidate.deckId === selectedDeckId)
          .sort((left, right) => String(left.id).localeCompare(String(right.id)));
      } finally {
        database.close();
      }
      const progress = document.querySelector("[data-study-progress]");
      const visibleCard = observeStudyCard(document, readAnswerSemantics);
      const normalizedText = (element: Element | null) =>
        element?.textContent?.replace(/\s+/g, " ").trim() ?? null;
      const studyPage = document.querySelector("[data-study-page]");
      const studyContent = document.querySelector("[data-study-content]");
      const studyState = document.querySelector("[data-study-state]");
      return {
        visible: {
          route: document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? null,
          state: studyState?.getAttribute("data-study-state") ?? null,
          cardId: visibleCard.cardId,
          side: visibleCard.side,
          sideDetail: visibleCard.detail,
          content: normalizedText(document.querySelector("[data-flashcard-content]")),
          progressCurrent: Number(progress?.getAttribute("aria-valuenow")),
          progressTotal: Number(progress?.getAttribute("aria-valuemax")),
          busy: studyContent?.getAttribute("aria-busy") ?? null,
          pageText: normalizedText(studyPage),
          stateText: normalizedText(studyState),
          statusMessages: [...(studyPage?.querySelectorAll('[role="status"]') ?? [])].map(normalizedText),
          alertMessages: [...(studyPage?.querySelectorAll('[role="alert"]') ?? [])].map(normalizedText),
        },
        durable: { capturedAt, decks, cards, sessions, session, card, schedule, schedules, reviewLogs, stores },
      };
    };
    const stateCall = await call("get_state", {});
    const cardId = decode(stateCall.result)?.data?.state?.current_card?.id;
    if (typeof cardId !== "string") throw new Error("adversarial-active-card-unavailable");

    if (caseKind === "validation") {
      const before = await snapshot(cardId);
      const definitions = [
        { label: "missing", input: "{}" },
        { label: "malformed", input: "null" },
        { label: "wrong-type", input: JSON.stringify({ card_id: 42, command_id: true }) },
        { label: "extra", input: JSON.stringify({ card_id: cardId, command_id: "invalid-extra", extra: true }) },
      ];
      const invalid = [];
      for (const definition of definitions) {
        const attemptBefore = await snapshot(cardId);
        const attempted = await callCurrentFlip(definition.input);
        await settle();
        invalid.push({
          label: definition.label,
          input: definition.input,
          invocation: attempted.invocation,
          before: attemptBefore,
          call: attempted.call,
          after: await snapshot(cardId),
        });
      }
      const staleCall = await call("flip", { card_id: `${cardId}-wrong`, command_id: "validation-stale" });
      await settle();
      const stale = { label: "wrong-card", call: staleCall, after: await snapshot(cardId) };
      const prematureCall = await call("set_state", {
        card_id: cardId,
        command_id: "validation-collision",
        rating: "good",
      });
      await settle();
      const premature = { label: "before-reveal", call: prematureCall, after: await snapshot(cardId) };
      const collisionCall = await call("flip", { card_id: cardId, command_id: "validation-collision" });
      await settle();
      const collision = { label: "different-fingerprint", call: collisionCall, after: await snapshot(cardId) };
      const controlInput = JSON.stringify({ card_id: cardId, command_id: "validation-control" });
      const control = await callCurrentFlip(controlInput);
      return {
        validation: {
          before,
          invalid,
          control: { input: controlInput, invocation: control.invocation, call: control.call },
          stale,
          premature,
          collision,
        },
      };
    }

    if (caseKind === "review" || caseKind === "conflict") {
      const flip = await call("flip", { card_id: cardId, command_id: `${caseKind}-setup-flip` });
      if (decode(flip.result)?.ok !== true) throw new Error("adversarial-reveal-failed");
      await settle();
    }
    const before = await snapshot(cardId);
    if (caseKind === "review") {
      const input = { card_id: cardId, command_id: "race-review", rating: "good" };
      const calls = await Promise.all([call("set_state", input), call("set_state", input)]);
      await settle();
      return { race: { kind: caseKind, deckId: selectedDeckId, cardId, before, after: await snapshot(cardId), calls, readCalls: [] } };
    }
    if (caseKind === "suspend") {
      const input = { card_id: cardId, command_id: "race-suspend" };
      const calls = await Promise.all([call("suspend", input), call("suspend", input)]);
      await settle();
      return { race: { kind: caseKind, deckId: selectedDeckId, cardId, before, after: await snapshot(cardId), calls, readCalls: [] } };
    }
    const firstRead = await call("get_state", {});
    const firstResult = await call("set_state", {
      card_id: cardId,
      command_id: "race-conflict-review",
      rating: "good",
    });
    // Chrome admits one executeTool call at a time. Observe the legal serialized
    // ordering live; the controller timing test starts this same conflicting pair
    // concurrently at the internal mutation lane.
    const secondRead = await call("get_state", {});
    const secondResult = await call("suspend", {
      card_id: cardId,
      command_id: "race-conflict-suspend",
    });
    await settle();
    return {
      race: {
        kind: "conflict" as const,
        deckId: selectedDeckId,
        cardId,
        before,
        after: await snapshot(cardId),
        calls: [firstResult, secondResult],
        readCalls: [firstRead, secondRead],
      },
    };
  }, {
    expectedNames: [...activeStudyToolNames],
    selectedDeckId: deckId,
    caseKind: kind,
    observerSource: observeVisibleStudyCard.toString(),
    answerObserverSource: readVisibleAnswerSemantics.toString(),
  });
  return { ...result, browserErrors: browserErrors(diagnostics) };
}

async function inspectAdversarialRestoreRace(page: Page): Promise<{
  race: AdversarialRace;
  browserErrors: string[];
}> {
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  const deckId = await enterFreshProductionStudy(page);
  const setup = await page.evaluate(async ({ selectedDeckId, expectedNames }) => {
    type Tool = { name?: string };
    type Context = { getTools: () => Promise<Tool[]>; executeTool: (tool: Tool, input: string) => Promise<unknown> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context) throw new Error("native-unavailable");
    const deadline = Date.now() + 10_000;
    let tools: Tool[] = [];
    while (Date.now() < deadline) {
      tools = await context.getTools();
      const names = tools.map((tool) => tool.name ?? "");
      if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const execute = async (name: string, input: unknown) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`restore-setup-tool-missing:${name}`);
      return await context.executeTool(tool, JSON.stringify(input));
    };
    const rawState = await execute("get_state", {});
    const state = typeof rawState === "string" ? JSON.parse(rawState) : rawState;
    const cardId = state?.data?.state?.current_card?.id;
    if (typeof cardId !== "string") throw new Error("restore-setup-card-missing");
    const suspendedRaw = await execute("suspend", { card_id: cardId, command_id: "restore-race-setup-suspend" });
    const suspended = typeof suspendedRaw === "string" ? JSON.parse(suspendedRaw) : suspendedRaw;
    if (suspended?.ok !== true) throw new Error("restore-race-setup-suspend-failed");
    return { deckId: selectedDeckId, cardId };
  }, { selectedDeckId: deckId, expectedNames: [...activeStudyToolNames] });
  const homeCall = await page.evaluate(async (expectedNames) => {
    type Tool = { name?: string };
    type Context = { getTools: () => Promise<Tool[]>; executeTool: (tool: Tool, input: string) => Promise<unknown> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context) throw new Error("native-unavailable");
    const deadline = Date.now() + 10_000;
    let tools: Tool[] = [];
    while (Date.now() < deadline) {
      tools = await context.getTools();
      const names = tools.map((candidate) => candidate.name ?? "");
      if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const tool = tools.find((candidate) => candidate.name === "go_home");
    if (!tool) throw new Error("restore-race-go-home-tool-missing");
    const raw = await context.executeTool(tool, "{}");
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }, [...activeStudyToolNames]);
  if (homeCall?.ok !== true) throw new Error("restore-race-go-home-failed");
  await page.waitForURL(productionRootUrl, { timeout: 10_000 });
  const race = await page.evaluate(async ({ selectedDeckId, suspendedCardId, expectedNames }) => {
    type Tool = { name?: string };
    type Call = StudyJourneyEvidence["getStateCall"];
    type Context = { getTools: () => Promise<Tool[]>; executeTool: (tool: Tool, input: string) => Promise<unknown> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context) throw new Error("native-unavailable");
    const deadline = Date.now() + 10_000;
    let tools: Tool[] = [];
    while (Date.now() < deadline) {
      tools = await context.getTools();
      const names = tools.map((tool) => tool.name ?? "");
      if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const restore = tools.find((tool) => tool.name === "restore_suspended");
    if (!restore) throw new Error("restore-race-tool-missing");
    const request = <T>(operation: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
    });
    const snapshot = async () => {
      const database = await request(indexedDB.open("anki-web-mcp"));
      try {
        const transaction = database.transaction(["sessions", "cards", "schedules", "reviewLogs"], "readonly");
        const sessions = await request(transaction.objectStore("sessions").getAll()) as Array<Record<string, unknown>>;
        const reviewLogs = (await request(transaction.objectStore("reviewLogs").getAll()) as Array<Record<string, unknown>>)
          .filter((item) => item.deckId === selectedDeckId)
          .sort((left, right) => String(left.id).localeCompare(String(right.id)));
        const row = document.querySelector(`[data-deck-row][data-deck-id="${CSS.escape(selectedDeckId)}"]`);
        return {
          visible: {
            route: document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? null,
            row: row?.textContent?.replace(/\s+/g, " ").trim() ?? null,
            restoreAvailable: row?.querySelector('[data-deck-action="restore-suspended"]') !== null,
          },
          durable: {
            session: sessions.find((item) => item.deckId === selectedDeckId) ?? null,
            card: await request(transaction.objectStore("cards").get(suspendedCardId)) ?? null,
            schedule: await request(transaction.objectStore("schedules").get(suspendedCardId)) ?? null,
            reviewLogs,
          },
        };
      } finally {
        database.close();
      }
    };
    const call = async (): Promise<Call> => {
      try {
        return {
          status: "passed",
          result: (await context.executeTool(restore, JSON.stringify({ deck_id: selectedDeckId, command_id: "race-restore" }))) ?? null,
          error: null,
        };
      } catch (error) {
        return { status: "failed", result: null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
    };
    const before = await snapshot();
    const calls = await Promise.all([call(), call()]);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { kind: "restore" as const, deckId: selectedDeckId, cardId: suspendedCardId, before, after: await snapshot(), calls, readCalls: [] };
  }, { selectedDeckId: setup.deckId, suspendedCardId: setup.cardId, expectedNames: [...homeToolNames] });
  return { race, browserErrors: browserErrors(diagnostics) };
}

async function inspectProductionAdversarialJourney(
  browser: Browser,
): Promise<BoundaryReport["adversarialJourney"]> {
  try {
    const run = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        throw new Error(`${label}: ${summarizeError(error)}`);
      }
    };
    const validation = await run("validation", () =>
      inEphemeralContext(browser, (page) => inspectAdversarialStudyCase(page, "validation")));
    const review = await run("review", () =>
      inEphemeralContext(browser, (page) => inspectAdversarialStudyCase(page, "review")));
    const suspend = await run("suspend", () =>
      inEphemeralContext(browser, (page) => inspectAdversarialStudyCase(page, "suspend")));
    const restore = await run("restore", () =>
      inEphemeralContext(browser, inspectAdversarialRestoreRace));
    const conflict = await run("conflict", () =>
      inEphemeralContext(browser, (page) => inspectAdversarialStudyCase(page, "conflict")));
    if (!validation.validation || !review.race || !suspend.race || !conflict.race) {
      throw new Error("adversarial-case-incomplete");
    }
    const evidence: AdversarialJourneyEvidence = {
      validation: {
        ...validation.validation,
        browserErrors: validation.browserErrors,
      },
      races: [review.race, suspend.race, restore.race, conflict.race],
      browserErrors: [
        ...review.browserErrors,
        ...suspend.browserErrors,
        ...restore.browserErrors,
        ...conflict.browserErrors,
      ],
    };
    return { ...assessAdversarialJourney(evidence), evidence };
  } catch (error) {
    const message = summarizeError(error);
    return {
      status: /native-unavailable/.test(message) ? "not-evaluable" : "failed",
      evidence: null,
      failureCode: /native-unavailable/.test(message)
        ? "native-unavailable"
        : "adversarial-journey-probe-failed",
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
  try {
    const response = await page.goto(rootUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response?.ok()) throw new Error("lifecycle-root-deployment-failed");

    const rootInitial = await captureLifecycleSnapshot(page, homeToolNames);
    const entry = await page.evaluate(async () => {
      type Tool = { name?: string };
      type Context = { getTools: () => Promise<Tool[]>; executeTool: (tool: Tool, input: string) => Promise<unknown> };
      type Stash = { home?: Record<string, Tool>; study?: Record<string, Tool> };
      const context = (document as Document & { modelContext?: Context }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const tools = await context.getTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name ?? "", tool]));
      (window as Window & { __webmcpLifecycle?: Stash }).__webmcpLifecycle = { home: byName };
      const listedRaw = await context.executeTool(byName.list_decks!, "{}");
      const listed = typeof listedRaw === "string" ? JSON.parse(listedRaw) : listedRaw;
      const deckId = typeof listed?.data?.decks?.[0]?.id === "string" ? listed.data.decks[0].id : null;
      if (!deckId) throw new Error("lifecycle-seed-unavailable");
      const selectedRaw = await context.executeTool(byName.select_deck!, JSON.stringify({ deck_id: deckId }));
      const selected = typeof selectedRaw === "string" ? JSON.parse(selectedRaw) : selectedRaw;
      if (selected?.ok !== true) throw new Error("lifecycle-select-failed");
      return { deckId };
    });
    const validStudyUrl = `${productionBaseUrl}/study/?deck=${encodeURIComponent(entry.deckId)}`;
    await page.waitForURL(validStudyUrl, { timeout: 10_000 });
    const studyFirst = await captureLifecycleSnapshot(page, activeStudyToolNames);
    await stashCurrentLifecycleTools(page, "study", activeStudyToolNames);

    const beforeOldHome = await captureLifecycleSnapshot(page, activeStudyToolNames);
    const oldHomeCall = await invokeStashedLifecycleTool(page, "home", "list_decks", {});
    const afterOldHome = await captureLifecycleSnapshot(page, activeStudyToolNames);

    const firstState = await invokeCurrentLifecycleTool(page, "get_state", {});
    const firstCardId = cardIdFromLifecycleCall(firstState);
    if (!firstCardId) throw new Error("lifecycle-first-card-unavailable");
    await invokeCurrentLifecycleTool(page, "flip", {
      card_id: firstCardId,
      command_id: "evidence-lifecycle-flip",
    });
    const rating = await invokeCurrentLifecycleTool(page, "set_state", {
      card_id: firstCardId,
      command_id: "evidence-lifecycle-rating",
      rating: "good",
    });
    const replacementCardId = cardIdFromLifecycleCall(rating);
    if (!replacementCardId || replacementCardId === firstCardId) {
      throw new Error("lifecycle-replacement-card-unavailable");
    }
    await page.waitForFunction((cardId) =>
      document.querySelector("[data-study-card-id]")?.textContent?.trim() === cardId,
    replacementCardId, { timeout: 10_000 });
    const beforeStaleCard = await captureLifecycleSnapshot(page, activeStudyToolNames);
    const staleCardCall = await invokeCurrentLifecycleTool(page, "flip", {
      card_id: firstCardId,
      command_id: "evidence-lifecycle-stale-card",
    });
    const afterStaleCard = await captureLifecycleSnapshot(page, activeStudyToolNames);

    await invokeCurrentLifecycleTool(page, "go_home", {});
    await page.waitForURL(rootUrl, { timeout: 10_000 });
    const rootReturn = await captureLifecycleSnapshot(page, homeToolNames);
    const beforeOldStudy = await captureLifecycleSnapshot(page, homeToolNames);
    const oldStudyCall = await invokeStashedLifecycleTool(page, "study", "get_state", {});
    const afterOldStudy = await captureLifecycleSnapshot(page, homeToolNames);

    await selectLifecycleDeck(page, entry.deckId);
    await page.waitForURL(validStudyUrl, { timeout: 10_000 });
    const studySecond = await captureLifecycleSnapshot(page, activeStudyToolNames);
    const cancellationBefore = studySecond;
    await page.evaluate(async (input) => {
      type Tool = { name?: string };
      type Context = { getTools: () => Promise<Tool[]>; executeTool: (tool: Tool, input: string) => Promise<unknown> };
      const context = (document as Document & { modelContext?: Context }).modelContext;
      if (!context) throw new Error("native-unavailable");
      const tool = (await context.getTools()).find((candidate) => candidate.name === "flip");
      if (!tool) throw new Error("lifecycle-cancellation-tool-missing");
      window.name = "webmcp-lifecycle:pending";
      void context.executeTool(tool, JSON.stringify({
        card_id: input.card_id,
        command_id: input.command_id,
      })).then(
        (result) => { window.name = `webmcp-lifecycle:settled:${JSON.stringify(result)}`; },
        (error) => { window.name = `webmcp-lifecycle:rejected:${String(error)}`; },
      );
      location.assign(input.rootUrl);
    }, {
      card_id: replacementCardId,
      command_id: "evidence-lifecycle-cancelled-flip",
      rootUrl,
    }).catch(() => undefined);
    await page.waitForURL(rootUrl, { timeout: 10_000 });
    await page.waitForTimeout(750);
    const cancellationMarker = await page.evaluate(() =>
      window.name.startsWith("webmcp-lifecycle:") ? window.name.slice("webmcp-lifecycle:".length) : null
    );
    await selectLifecycleDeck(page, entry.deckId);
    await page.waitForURL(validStudyUrl, { timeout: 10_000 });
    const cancellationAfter = await captureLifecycleSnapshot(page, activeStudyToolNames);

    const missingResponse = await page.goto(studyUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!missingResponse?.ok()) throw new Error("lifecycle-missing-study-deployment-failed");
    const missingStudy = await captureLifecycleSnapshot(page, emptyStudyToolNames);
    const missingCardCall = await invokeCurrentLifecycleTool(page, "get_state", {});
    const errors = browserErrors(diagnostics);
    const evidence: LifecycleJourneyEvidence = {
      observations: [
        { step: "root-initial", snapshot: rootInitial },
        { step: "study-first", snapshot: studyFirst },
        { step: "root-return", snapshot: rootReturn },
        { step: "study-second", snapshot: studySecond },
        { step: "study-missing-card", snapshot: missingStudy },
      ],
      deckId: entry.deckId,
      firstCardId,
      replacementCardId,
      missingCardCall,
      oldHomeCall,
      oldStudyCall,
      staleCardCall,
      beforeOldHome,
      afterOldHome,
      beforeOldStudy,
      afterOldStudy,
      beforeStaleCard,
      afterStaleCard,
      cancellation: { marker: cancellationMarker, before: cancellationBefore, after: cancellationAfter },
      browserErrors: errors,
    };
    const assessment = assessLifecycleJourney(evidence);
    return { ...assessment, evidence, browserErrors: errors };
  } catch (error) {
    const message = summarizeError(error);
    const nativeUnavailable = /native-unavailable/.test(message);
    return {
      status: nativeUnavailable ? "not-evaluable" : "failed",
      evidence: null,
      browserErrors: browserErrors(diagnostics),
      failureCode: nativeUnavailable ? "native-unavailable" : `lifecycle-probe-failed:${message}`,
    };
  }
}

async function captureLifecycleSnapshot(
  page: Page,
  expectedToolNames: readonly ProductionToolName[],
): Promise<LifecycleJourneyEvidence["beforeOldHome"]> {
  return await page.evaluate(async ({ expectedNames, observerSource, answerObserverSource }) => {
    type Tool = { name?: string };
    type Context = { getTools: () => Promise<Tool[]> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context) throw new Error("native-unavailable");
    const deadline = Date.now() + 10_000;
    let tools: Tool[] = [];
    while (Date.now() < deadline) {
      tools = await context.getTools();
      const names = tools.map((tool) => tool.name ?? "");
      if (names.length === expectedNames.length && new Set(names).size === names.length &&
          expectedNames.every((name) => names.includes(name))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const request = <T>(operation: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
    });
    const database = await request(indexedDB.open("anki-web-mcp"));
    let durable: unknown;
    try {
      const transaction = database.transaction(["sessions", "schedules", "reviewLogs"], "readonly");
      const sessions = await request(transaction.objectStore("sessions").getAll());
      const schedules = await request(transaction.objectStore("schedules").getAll());
      const reviewLogs = await request(transaction.objectStore("reviewLogs").getAll());
      durable = { sessions, schedules, reviewLogs };
    } finally {
      database.close();
    }
    const observeStudyCard = (0, eval)(`(${observerSource})`) as typeof observeVisibleStudyCard;
    const readAnswerSemantics = (0, eval)(`(${answerObserverSource})`) as typeof readVisibleAnswerSemantics;
    const visibleCard = observeStudyCard(document, readAnswerSemantics);
    return {
      url: location.href,
      route: document.querySelector("[data-deployment-route]")?.getAttribute("data-deployment-route") ?? null,
      toolNames: tools.map((tool) => tool.name ?? ""),
      cardId: visibleCard.cardId,
      side: visibleCard.side,
      sideDetail: visibleCard.detail,
      durable,
    };
  }, {
    expectedNames: [...expectedToolNames],
    observerSource: observeVisibleStudyCard.toString(),
    answerObserverSource: readVisibleAnswerSemantics.toString(),
  });
}

async function stashCurrentLifecycleTools(
  page: Page,
  group: "home" | "study",
  expectedToolNames: readonly ProductionToolName[],
): Promise<void> {
  await page.evaluate(async ({ group, expectedNames }) => {
    type Tool = { name?: string };
    type Context = { getTools: () => Promise<Tool[]> };
    type Stash = { home?: Record<string, Tool>; study?: Record<string, Tool> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context) throw new Error("native-unavailable");
    const tools = await context.getTools();
    const names = tools.map((tool) => tool.name ?? "");
    if (names.length !== expectedNames.length || !expectedNames.every((name) => names.includes(name))) {
      throw new Error("lifecycle-stash-inventory-mismatch");
    }
    const owner = window as Window & { __webmcpLifecycle?: Stash };
    owner.__webmcpLifecycle ??= {};
    owner.__webmcpLifecycle[group] = Object.fromEntries(tools.map((tool) => [tool.name ?? "", tool]));
  }, { group, expectedNames: [...expectedToolNames] });
}

async function invokeStashedLifecycleTool(
  page: Page,
  group: "home" | "study",
  name: string,
  input: unknown,
): Promise<LifecycleJourneyEvidence["oldHomeCall"]> {
  return await page.evaluate(async ({ group, name, input }) => {
    type Tool = { name?: string; execute?: (input: unknown) => Promise<unknown> };
    type Context = { getTools: () => Promise<Tool[]>; executeTool: (tool: Tool, input: string) => Promise<unknown> };
    type Stash = { home?: Record<string, Tool>; study?: Record<string, Tool> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    const tool = (window as Window & { __webmcpLifecycle?: Stash }).__webmcpLifecycle?.[group]?.[name];
    if (!context || !tool) return { status: "not-run" as const, result: null, error: "stashed-tool-unavailable" };
    try {
      const result = typeof tool.execute === "function"
        ? await tool.execute(input)
        : await context.executeTool(tool, JSON.stringify(input));
      return { status: "passed" as const, result, error: null };
    } catch (error) {
      const currentNames = (await context.getTools()).map((candidate) => candidate.name ?? "");
      return {
        status: "failed" as const,
        result: null,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ...(currentNames.includes(name) ? {} : { classification: "NATIVE_HANDLE_UNREGISTERED" as const }),
      };
    }
  }, { group, name, input });
}

async function invokeCurrentLifecycleTool(
  page: Page,
  name: string,
  input: unknown,
): Promise<LifecycleJourneyEvidence["oldHomeCall"]> {
  return await page.evaluate(async ({ name, input }) => {
    type Tool = { name?: string };
    type Context = { getTools: () => Promise<Tool[]>; executeTool: (tool: Tool, input: string) => Promise<unknown> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context) return { status: "not-run" as const, result: null, error: "native-unavailable" };
    const tool = (await context.getTools()).find((candidate) => candidate.name === name);
    if (!tool) return { status: "not-run" as const, result: null, error: `tool-missing:${name}` };
    try {
      return { status: "passed" as const, result: await context.executeTool(tool, JSON.stringify(input)), error: null };
    } catch (error) {
      return { status: "failed" as const, result: null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }, { name, input });
}

function cardIdFromLifecycleCall(call: LifecycleJourneyEvidence["oldHomeCall"]): string | null {
  if (call.status !== "passed") return null;
  try {
    const value = typeof call.result === "string" ? JSON.parse(call.result) : call.result;
    return typeof value?.data?.state?.current_card?.id === "string"
      ? value.data.state.current_card.id
      : null;
  } catch {
    return null;
  }
}

async function selectLifecycleDeck(page: Page, deckId: string): Promise<void> {
  const result = await invokeCurrentLifecycleTool(page, "select_deck", { deck_id: deckId });
  if (result.status !== "passed") throw new Error(`lifecycle-select-call-failed:${result.error}`);
  const decoded = typeof result.result === "string" ? JSON.parse(result.result) : result.result;
  if (decoded?.ok !== true || decoded?.data?.deck_id !== deckId) {
    throw new Error("lifecycle-select-result-mismatch");
  }
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
  if (exposedTo) registration.exposedTo = [exposedTo === '*' ? '*' : new URL(exposedTo).origin];
  context.registerTool(tool, registration).then(
    () => report('registered', { policy: policyState, exposedTo: exposedTo === '*' ? '*' : exposedTo ? new URL(exposedTo).origin : null }),
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
  const exposed = mode === 'explicitly-permitted' ? location.origin : mode === 'wildcard-exposure' ? '*' : '';
  const query = exposed ? '?exposedTo=' + encodeURIComponent(exposed) : '';
  if (mode === 'explicitly-permitted' || mode === 'wildcard-exposure') frame.setAttribute('allow', 'tools');
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
    { name: "wildcard-exposure" as const, mode: "wildcard-exposure" },
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
        snapshot.requestedToolNames.length !== 0 ||
        snapshot.executedResult !== null ||
        (item.name === "wildcard-exposure" && snapshot.childMutationCount !== null && snapshot.childMutationCount !== 0)
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

async function captureContextStorage(page: Page): Promise<ContextStorageSnapshot> {
  return await page.evaluate(async () => {
    const request = <T>(value: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error);
      });
    const databases = typeof indexedDB.databases === "function"
      ? await indexedDB.databases()
      : [{ name: "anki-web-mcp" }];
    const indexedDb: ContextStorageSnapshot["indexedDb"] = [];
    for (const descriptor of databases.filter((candidate) => candidate.name)) {
      const name = descriptor.name as string;
      const database = await request(indexedDB.open(name));
      try {
        const stores: ContextStorageSnapshot["indexedDb"][number]["stores"] = [];
        for (const storeName of [...database.objectStoreNames].sort()) {
          const transaction = database.transaction(storeName, "readonly");
          const store = transaction.objectStore(storeName);
          const [count, keys] = await Promise.all([
            request(store.count()),
            request(store.getAllKeys()),
          ]);
          const canonicalKeys = keys.map((key) => JSON.stringify(key)).sort();
          const bytes = new TextEncoder().encode(JSON.stringify(canonicalKeys));
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const keysSha256 = [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          stores.push({ name: storeName, count, keysSha256 });
        }
        indexedDb.push({ name, stores });
      } finally {
        database.close();
      }
    }
    return {
      indexedDb: indexedDb.sort((left, right) => left.name.localeCompare(right.name)),
      localStorageKeys: Object.keys(localStorage).sort(),
      sessionStorageKeys: Object.keys(sessionStorage).sort(),
    };
  });
}

async function prepareIsolatedContext(
  page: Page,
): Promise<{ seedDecks: unknown; deckId: string; storage: ContextStorageSnapshot }> {
  const response = await page.goto(productionRootUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (!response?.ok()) throw new Error(`context-root-http-${response?.status() ?? "missing"}`);
  const result = await page.evaluate(async (expectedNames) => {
    const context = (document as Document & { modelContext?: {
      getTools: () => Promise<Array<{ name?: string }>>;
      executeTool: (tool: unknown, input: string) => Promise<unknown>;
    } }).modelContext;
    if (!context) throw new Error("context-native-unavailable");
    let tools: Array<{ name?: string }> = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      tools = await context.getTools();
      const names = tools.map((tool) => tool.name).filter(Boolean);
      if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const listDecks = tools.find((tool) => tool.name === "list_decks");
    if (!listDecks) throw new Error("context-home-inventory-mismatch");
    const raw = await context.executeTool(listDecks, "{}");
    const decoded = typeof raw === "string" ? JSON.parse(raw) : raw as Record<string, unknown>;
    const data = decoded && typeof decoded === "object" &&
        (decoded as Record<string, unknown>).data !== null &&
        typeof (decoded as Record<string, unknown>).data === "object"
      ? (decoded as Record<string, Record<string, unknown>>).data
      : null;
    const decks = Array.isArray(data?.decks) ? data.decks : [];
    const deckId = decks[0] && typeof decks[0] === "object" && typeof decks[0].id === "string"
      ? decks[0].id
      : null;
    if (!deckId) throw new Error("context-seed-unavailable");
    return { seedDecks: decks, deckId };
  }, [...homeToolNames]);
  return { ...result, storage: await captureContextStorage(page) };
}

async function enterAndFlipIsolatedContext(
  page: Page,
  deckId: string,
  commandId: string,
): Promise<{
  cardId: string;
  sessionId: string;
  selectCall: ContextIsolationCall;
  flipCall: ContextIsolationCall;
}> {
  return await page.evaluate(async ({ deckId, commandId, expectedNames }) => {
    type Tool = { name?: string };
    const context = (document as Document & { modelContext?: {
      getTools: () => Promise<Tool[]>;
      executeTool: (tool: unknown, input: string) => Promise<unknown>;
    } }).modelContext;
    if (!context) throw new Error("context-native-unavailable");
    const decode = (value: unknown): Record<string, unknown> => {
      const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    };
    const nestedRecord = (value: unknown): Record<string, unknown> | null =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const call = async (tool: Tool, input: unknown): Promise<ContextIsolationCall> => {
      try {
        return { status: "passed", result: await context.executeTool(tool, JSON.stringify(input)), error: null };
      } catch (error) {
        return { status: "failed", result: null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
    };
    let tools = await context.getTools();
    const select = tools.find((tool) => tool.name === "select_deck");
    if (!select) throw new Error("context-select-tool-missing");
    const selectCall = await call(select, { deck_id: deckId });
    const selected = decode(selectCall.result);
    const sessionId = nestedRecord(nestedRecord(selected.data)?.session)?.id;
    if (selectCall.status !== "passed" || typeof sessionId !== "string") {
      throw new Error("context-select-failed");
    }
    const deadline = Date.now() + 10_000;
    do {
      tools = await context.getTools();
      const names = tools.map((tool) => tool.name).filter(Boolean);
      if (names.length === expectedNames.length && expectedNames.every((name) => names.includes(name))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    const getState = tools.find((tool) => tool.name === "get_state");
    if (!getState) throw new Error("context-study-inventory-mismatch");
    const state = decode(await context.executeTool(getState, "{}"));
    const cardId = nestedRecord(nestedRecord(nestedRecord(state.data)?.state)?.current_card)?.id;
    if (typeof cardId !== "string") throw new Error("context-card-unavailable");
    tools = await context.getTools();
    const flip = tools.find((tool) => tool.name === "flip");
    if (!flip) throw new Error("context-flip-tool-missing");
    const flipCall = await call(flip, { card_id: cardId, command_id: commandId });
    return { cardId, sessionId, selectCall, flipCall };
  }, { deckId, commandId, expectedNames: [...activeStudyToolNames] });
}

async function inspectBrowserContextIsolation(
  browser: Browser,
): Promise<ProductionContextIsolationEvidence> {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  const diagnostics = emptyDiagnostics();
  const commandId = "same-command-in-isolated-contexts";
  try {
    for (let index = 0; index < 2; index += 1) {
      const context = await browser.newContext({ serviceWorkers: "block", viewport: desktopViewport });
      const page = await context.newPage();
      attachDiagnostics(page, diagnostics);
      contexts.push(context);
      pages.push(page);
    }
    const [firstSeed, secondSeed] = await Promise.all(pages.map(prepareIsolatedContext));
    const secondBeforePeerMutation = secondSeed.storage;
    const firstMutation = await enterAndFlipIsolatedContext(pages[0], firstSeed.deckId, commandId);
    const secondAfterPeerMutation = await captureContextStorage(pages[1]);
    const firstBeforePeerMutation = await captureContextStorage(pages[0]);
    const secondMutation = await enterAndFlipIsolatedContext(pages[1], secondSeed.deckId, commandId);
    const firstAfterPeerMutation = await captureContextStorage(pages[0]);
    const [firstFinal, secondFinal] = await Promise.all(pages.map(captureContextStorage));
    const trace = (
      label: IsolatedContextEvidence["label"],
      seed: typeof firstSeed,
      mutation: typeof firstMutation,
      beforePeerMutation: ContextStorageSnapshot,
      afterPeerMutation: ContextStorageSnapshot,
      finalStorage: ContextStorageSnapshot,
    ): IsolatedContextEvidence => ({
      label,
      seedDecks: serialize(seed.seedDecks),
      deckId: seed.deckId,
      cardId: mutation.cardId,
      sessionId: mutation.sessionId,
      sharedCommandId: commandId,
      beforePeerMutation,
      afterPeerMutation,
      finalStorage,
      selectCall: { ...mutation.selectCall, result: serialize(mutation.selectCall.result) },
      flipCall: { ...mutation.flipCall, result: serialize(mutation.flipCall.result) },
    });
    const evidence: BrowserContextIsolationEvidence = {
      contexts: [
        trace("first", firstSeed, firstMutation, firstBeforePeerMutation, firstAfterPeerMutation, firstFinal),
        trace("second", secondSeed, secondMutation, secondBeforePeerMutation, secondAfterPeerMutation, secondFinal),
      ],
      browserErrors: browserErrors(diagnostics),
    };
    const assessment = assessBrowserContextIsolation(evidence);
    return { status: assessment.status, mode: "production-browser-context-isolation", evidence, failureCode: assessment.failureCode };
  } catch (error) {
    return {
      status: /native-unavailable/.test(summarizeError(error)) ? "not-evaluable" : "failed",
      mode: "production-browser-context-isolation",
      evidence: null,
      failureCode: /native-unavailable/.test(summarizeError(error))
        ? "native-unavailable"
        : `context-isolation-failed:${summarizeError(error)}`,
    };
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  }
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
    failureDetail: null,
  };
  let studyJourney: BoundaryReport["studyJourney"] = {
    status: "not-evaluable",
    evidence: null,
    failureCode: "not-started",
    failureDetail: null,
  };
  let suspensionJourney: BoundaryReport["suspensionJourney"] = {
    status: "not-evaluable",
    evidence: null,
    failureCode: "not-started",
  };
  let adversarialJourney: BoundaryReport["adversarialJourney"] = {
    status: "not-evaluable",
    evidence: null,
    failureCode: "not-started",
  };
  let lifecycle = emptyProductionLifecycle();
  let browserContextIsolation: ProductionContextIsolationEvidence = {
    status: "not-evaluable",
    mode: "production-browser-context-isolation",
    evidence: null,
    failureCode: "not-started",
  };
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
    studyJourney = await inEphemeralContext(browser, inspectProductionStudyJourney);
    suspensionJourney = await inEphemeralContext(browser, inspectProductionSuspensionJourney);
    adversarialJourney = await inspectProductionAdversarialJourney(browser);
    browserContextIsolation = await inspectBrowserContextIsolation(browser);
    lifecycle = await inEphemeralContext(browser, async (lifecyclePage) =>
      await inspectProductionLifecycle(
        lifecyclePage,
        productionRootUrl,
        productionStudyUrl,
      )
    );
    productionFailureCode = productionPassed(root, study) &&
        homeJourney.status === "passed" && studyJourney.status === "passed" &&
          suspensionJourney.status === "passed" && adversarialJourney.status === "passed" &&
          lifecycle.status === "passed"
      ? null
      : root?.failureCode ?? study?.failureCode ?? homeJourney.failureCode ?? studyJourney.failureCode ??
        suspensionJourney.failureCode ?? adversarialJourney.failureCode ?? lifecycle.failureCode ??
          "production-boundary-failed";
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
    homeJourney.status === "passed" && studyJourney.status === "passed" &&
    suspensionJourney.status === "passed" && adversarialJourney.status === "passed" &&
    lifecycle.status === "passed";
  const overall = productionReady
    ? isolation.status === "passed" && browserContextIsolation.status === "passed"
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
    studyJourney,
    suspensionJourney,
    adversarialJourney,
    lifecycle,
    isolation,
    browserContextIsolation,
    limitations: [
      "The production run is exact-URL evidence only; a local boundary experiment cannot establish GitHub Pages native support.",
      "The cross-origin experiment enables WebMCP solely to exercise browser policy behavior on loopback and is labeled separately from the production run.",
      "An absent native API, inaccessible route, or rejected production registration is recorded as no-go or not-evaluable rather than substituted with a mock or polyfill result.",
      "The runner does not infer support for nearby browser versions, alternate hosts, extensions, flags, or future WebMCP contract revisions.",
    ],
  };
  await mkdir(resolve(evidencePath, ".."), { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify(sanitizeWebMcpEvidence(report, [webMcpOriginTrialToken]), null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify({
    overall,
    production: { status: report.production.status, failureCode: report.production.failureCode },
    isolation: { status: isolation.status, failureCode: isolation.failureCode },
    browserContextIsolation: { status: browserContextIsolation.status, failureCode: browserContextIsolation.failureCode },
    browser: { version: browserIdentity.actualVersion, executablePath },
    evidence: evidencePath,
  }, null, 2));
  if (overall !== "supported" && !allowFailure) {
    process.exitCode = 1;
  }
}

await main();
