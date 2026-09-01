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
  webMcpPermissionsPolicyFeature,
} from "../lib/webmcp";
import {
  webMcpOracleExpectedBrowserName,
  webMcpOracleExpectedBrowserVersion,
} from "../lib/webmcp-oracle";

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
const productionBaseUrl = (process.env.WEBMCP_BOUNDARY_BASE_URL ??
  `${webMcpOrigin}/anki-web-mcp`).replace(/\/$/, "");
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
  requestedVersion: string;
  actualVersion: string | null;
  executablePath: string | null;
  userAgent: string | null;
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
  navigationStatus: number | null;
  capability: Capability;
  secureContext: boolean | null;
  origin: string | null;
  permissionsPolicy: Policy;
  originTrialMetaPresent: boolean;
  discoveredTools: ToolSnapshot[];
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
    requestedVersion: webMcpOracleExpectedBrowserVersion,
    actualVersion: null,
    executablePath,
    userAgent: null,
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
  return {
    ...identity,
    actualVersion: browser.version(),
    userAgent: pageIdentity.userAgent,
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

function productionRouteScript(
  route: "root" | "study",
  expectedToolName: string,
  input: unknown,
): { route: "root" | "study"; expectedToolName: string; input: unknown } {
  return { route, expectedToolName, input };
}

async function inspectProductionRoute(
  page: Page,
  url: string,
  route: "root" | "study",
  expectedToolName: string,
  input: unknown,
): Promise<ProductionRouteEvidence> {
  const diagnostics = emptyDiagnostics();
  attachDiagnostics(page, diagnostics);
  let response: PlaywrightResponse | null = null;
  try {
    response = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    if (!response || !response.ok()) {
      return failedProductionRoute(url, response?.status() ?? null, "deployment-route-failed");
    }
    await page.waitForTimeout(300);
    const result = await page.evaluate<
      ProductionPageResult,
      { route: "root" | "study"; expectedToolName: string; input: unknown }
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
      const state = () => configuration.route === "root"
        ? document.querySelector("[data-diagnostic-counter]")?.textContent?.trim() ?? null
        : {
            side: document.querySelector("[data-diagnostic-side]")?.textContent?.trim() ?? null,
            count: document.querySelector("[data-diagnostic-mutation-count]")?.textContent?.trim() ?? null,
            command: document.querySelector("[data-diagnostic-last-command]")?.textContent?.trim() ?? null,
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
      const metaPresent = Boolean(document.querySelector('meta[http-equiv="origin-trial"]')?.getAttribute("content"));
      const before = state();
      if (capability !== "available") {
        return {
          capability,
          secureContext: window.isSecureContext,
          origin: location.origin,
          permissionsPolicy,
          originTrialMetaPresent: metaPresent,
          discoveredTools: [],
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
        tools = await availableContext.getTools();
      } catch (error) {
        return {
          capability,
          secureContext: window.isSecureContext,
          origin: location.origin,
          permissionsPolicy,
          originTrialMetaPresent: metaPresent,
          discoveredTools: [],
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
        };
      }
      const discoveredTools = tools.map(snapshot);
      const tool = tools.find((candidate) =>
        candidate !== null && typeof candidate === "object" &&
        (candidate as Record<string, unknown>).name === configuration.expectedToolName,
      );
      if (!tool) {
        return {
          capability,
          secureContext: window.isSecureContext,
          origin: location.origin,
          permissionsPolicy,
          originTrialMetaPresent: metaPresent,
          discoveredTools,
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
        };
      }
      const validCall = await call(tool, configuration.input);
      const stateAfter = state();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const duplicateCall = await call(tool, configuration.input);
      const stateAfterDuplicate = state();
      const invalidCall = await call(
        tool,
        configuration.route === "root"
          ? { amount: 1.5, command_id: "boundary-invalid" }
          : { deck: "diagnostic", side: "middle", command_id: "boundary-invalid" },
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
        secureContext: window.isSecureContext,
        origin: location.origin,
        permissionsPolicy,
        originTrialMetaPresent: metaPresent,
        discoveredTools,
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
      };
    }, productionRouteScript(route, expectedToolName, input));

    const expectedToolFound = result.expectedToolFound;
    const failureCode = result.capability === "unavailable"
      ? "native-unavailable"
      : result.capability === "error"
        ? "capability-probe-failed"
        : !expectedToolFound
          ? "expected-tool-missing"
          : null;
    return {
      ...result,
      url,
      navigationStatus: response.status(),
      browserErrors: browserErrors(diagnostics),
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

function failedProductionRoute(
  url: string,
  navigationStatus: number | null,
  failureCode: string,
  errors: string[] = [],
  error: string | null = null,
): ProductionRouteEvidence {
  return {
    url,
    navigationStatus,
    capability: "error",
    secureContext: null,
    origin: null,
    permissionsPolicy: "unknown",
    originTrialMetaPresent: false,
    discoveredTools: [],
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
  return (typeof result?.code === "string" && expectedPattern.test(result.code)) ||
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
  expectedCommand: string,
  expectedBefore: unknown,
  expectedAfter: unknown,
): boolean {
  const validResult = decodedToolResult(route.validCall);
  const expectedRoute = typeof expectedAfter === "string" ? "/" : "/study/";
  return route.capability === "available" &&
    route.expectedToolFound &&
    route.secureContext === true &&
    route.origin === webMcpOrigin &&
    route.origin === new URL(route.url).origin &&
    route.originTrialMetaPresent &&
    route.permissionsPolicy !== "denied" &&
    route.browserErrors.length === 0 &&
    route.failureCode === null &&
    route.validCall.status === "passed" &&
    validResult?.status === "applied" &&
    validResult.code === "ok" &&
    validResult.route === expectedRoute &&
    validResult.command === (
      expectedRoute === "/"
        ? "webmcp_diagnostic_increment"
        : "webmcp_diagnostic_set_side"
    ) &&
    validResult.command_id === expectedCommand &&
    statesEqual(route.stateBefore, expectedBefore) &&
    statesEqual(route.stateAfter, expectedAfter) &&
    rejectedCallIsDeterministic(route.duplicateCall, /duplicate|already/i) &&
    rejectedCallIsDeterministic(route.invalidCall, /invalid|schema|validation/i) &&
    statesEqual(route.stateAfterDuplicate, route.stateAfter) &&
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
  return productionRoutePassed(root, "boundary-root-valid", "0", "1") &&
    productionRoutePassed(study, "boundary-study-valid", {
      side: "front",
      count: "0",
      command: "None",
    }, {
      side: "back",
      count: "1",
      command: "boundary-study-valid",
    });
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  let executablePath: string | null = null;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let browserIdentity = emptyBrowserIdentity(null);
  let root: ProductionRouteEvidence | null = null;
  let study: ProductionRouteEvidence | null = null;
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
    context = await browser.newContext({
      serviceWorkers: "block",
      viewport: desktopViewport,
    });
    page = await context.newPage();
    browserIdentity = await readBrowserIdentity(page, browser, browserIdentity);
    root = await inspectProductionRoute(
      page,
      productionRootUrl,
      "root",
      "webmcp_diagnostic_increment",
      { amount: 1, command_id: "boundary-root-valid" },
    );
    study = await inspectProductionRoute(
      page,
      productionStudyUrl,
      "study",
      "webmcp_diagnostic_set_side",
      { deck: "diagnostic", side: "back", command_id: "boundary-study-valid" },
    );
    productionFailureCode = productionPassed(root, study)
      ? null
      : root?.failureCode ?? study?.failureCode ?? "production-boundary-failed";
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
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
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

  const overall = productionPassed(root, study)
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
      productionWebMcpTestingFlag: "not-supplied",
      productionPolyfill: "none-loaded",
      inspection: "Playwright runtime calls to document.modelContext.getTools and executeTool",
      crossOriginExperiment: "A separate local native-feature run with explicit allow=tools and exposedTo origin gating; never deployed-native evidence.",
    },
    production: {
      status: productionPassed(root, study)
        ? "passed"
        : root?.failureCode === "native-unavailable" && study?.failureCode === "native-unavailable"
          ? "not-evaluable"
          : "failed",
      root,
      study,
      failureCode: productionFailureCode,
    },
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
