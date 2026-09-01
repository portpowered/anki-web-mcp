import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release, version as osVersion } from "node:os";
import { join, resolve } from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright-core";

import {
  assessOriginTrial,
  classifyControlCapability,
  classifyOracleObservation,
  sanitizeTool,
  summarizeError,
  summarizeOriginTrialToken,
  toJsonValue,
  webMcpFeatureName,
  webMcpOracleExpectedAfter,
  webMcpOracleExpectedBefore,
  webMcpOracleExpectedBrowserVersion,
  webMcpOracleExpectedResult,
  webMcpOracleRepositoryUrl,
  webMcpOracleToolInput,
  webMcpOracleToolName,
  webMcpOracleUrl,
  webMcpTestingFlag,
  type JsonValue,
  type OracleFailureCode,
  type WebMcpCapabilityKind,
} from "../lib/webmcp-oracle";

const repositoryRoot = resolve(import.meta.dir, "..");
const defaultEvidencePath = join(
  repositoryRoot,
  ".artifacts",
  "webmcp-oracle",
  "report.json",
);
const evidencePath = resolve(
  process.env.WEBMCP_ORACLE_EVIDENCE ?? defaultEvidencePath,
);
const expectedBrowserVersion =
  process.env.WEBMCP_ORACLE_EXPECTED_VERSION ??
  webMcpOracleExpectedBrowserVersion;
const expectedChannel = process.env.WEBMCP_ORACLE_CHANNEL ?? "stable";
const configuredExpectedOs = process.env.WEBMCP_ORACLE_EXPECTED_OS ?? null;
const allowFailure = process.env.WEBMCP_ORACLE_ALLOW_FAILURE === "1";
const desktopViewport = { width: 1280, height: 900 };
const oracleOrigin = new URL(webMcpOracleUrl).origin;

const baseLaunchArgs = [
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

type ScenarioMode = "native-oracle" | "no-native-control";

type BrowserIdentity = {
  name: "Chrome for Testing";
  channel: string;
  requestedVersion: string;
  actualVersion: string | null;
  executablePath: string | null;
  userAgent: string | null;
  userAgentData: JsonValue | null;
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
  blockedRequests: Array<{
    url: string;
    resourceType: string;
    reason: "polyfill" | "external-script";
  }>;
};

type PageSnapshot = {
  url: string | null;
  origin: string | null;
  title: string | null;
  secureContext: boolean | null;
  originTrialMetaToken: string | null;
  sizeText: string | null;
};

type OriginTrialEvidence = {
  assessment:
    | "accepted"
    | "rejected"
    | "expired"
    | "mismatched"
    | "not-required"
    | "unknown";
  meta: TokenEvidence;
  responseHeader: TokenEvidence;
  source: "meta" | "response-header" | "none";
};

type TokenEvidence = {
  present: boolean;
  length: number;
  sha256: string | null;
  feature: string | null;
  origin: string | null;
  expiry: number | null;
  parseError: string | null;
};

type RuntimeEvidence = {
  status: "passed" | "failed" | "not-run";
  error: string | null;
  tools: ReturnType<typeof sanitizeTool>[];
  expectedToolFound: boolean;
  result: JsonValue | null;
  expectedResult: JsonValue;
  before: string | null;
  after: string | null;
};

type ScenarioEvidence = {
  mode: ScenarioMode;
  classification:
    | "oracle-passed"
    | "oracle-failed"
    | "native-unavailable"
    | "control-failed";
  failureCode: string | null;
  downstream: "evaluable" | "not-evaluable" | "not-applicable";
  browser: BrowserIdentity;
  launch: {
    headless: true;
    args: readonly string[];
    profile: "isolated-ephemeral";
    extensions: "disabled";
    proxy: "none";
    webmcpTestingFlag: "not-supplied" | "disabled-for-control";
    polyfill: "blocked";
    serviceWorkers: "blocked";
  };
  page: PageSnapshot & {
    navigationStatus: number | null;
  };
  originTrial: OriginTrialEvidence;
  capability: WebMcpCapabilityKind;
  discovery: {
    status: "passed" | "failed" | "not-run";
    error: string | null;
  };
  runtime: RuntimeEvidence;
  diagnostics: BrowserDiagnostics;
};

type OracleReport = {
  schemaVersion: 1;
  generatedAt: string;
  overall: "passed" | "oracle-failed" | "control-failed";
  downstream: "evaluable" | "not-evaluable";
  runtimeOnly: true;
  procedure: {
    oracleUrl: string;
    repositoryUrl: string;
    retrievalDate: string;
    expectedBrowser: {
      name: "Chrome for Testing";
      version: string;
      channel: string;
      operatingSystem: string;
    };
    launch: ScenarioEvidence["launch"];
    inspection:
      | "Playwright page.evaluate using document.modelContext.getTools and executeTool"
      | "not-run";
    localTestingFlag: "disabled/not-supplied";
    polyfill: "blocked before navigation";
    runtimeProof: "browser behavior only; source inspection is not used";
  };
  oracle: ScenarioEvidence;
  control: ScenarioEvidence;
  limitations: string[];
};

function emptyDiagnostics(): BrowserDiagnostics {
  return {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    blockedRequests: [],
  };
}

function emptyBrowserIdentity(
  executablePath: string | null,
): BrowserIdentity {
  return {
    name: "Chrome for Testing",
    channel: expectedChannel,
    requestedVersion: expectedBrowserVersion,
    actualVersion: null,
    executablePath,
    userAgent: null,
    userAgentData: null,
    operatingSystem: {
      platform: platform(),
      release: release(),
      version: osVersion(),
      architecture: arch(),
    },
  };
}

function emptyPageSnapshot(): PageSnapshot {
  return {
    url: null,
    origin: null,
    title: null,
    secureContext: null,
    originTrialMetaToken: null,
    sizeText: null,
  };
}

function emptyRuntimeEvidence(): RuntimeEvidence {
  return {
    status: "not-run",
    error: null,
    tools: [],
    expectedToolFound: false,
    result: null,
    expectedResult: webMcpOracleExpectedResult,
    before: null,
    after: null,
  };
}

function limitText(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function recordConsoleError(diagnostics: BrowserDiagnostics, value: string): void {
  diagnostics.consoleErrors.push(limitText(value));
}

function attachDiagnostics(page: Page, diagnostics: BrowserDiagnostics): void {
  page.on("console", (message) => {
    if (message.type() === "error") {
      recordConsoleError(diagnostics, `console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(limitText(error.message));
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (isBlockedUrl(url)) {
      return;
    }
    diagnostics.failedRequests.push(
      limitText(
        `${request.failure()?.errorText ?? "Network request failed"} (${url})`,
      ),
    );
  });
}

function isBlockedUrl(value: string): boolean {
  try {
    return /webmcp-polyfill/i.test(new URL(value).pathname);
  } catch {
    return /webmcp-polyfill/i.test(value);
  }
}

async function installNetworkGuards(
  context: BrowserContext,
  diagnostics: BrowserDiagnostics,
): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (isBlockedUrl(request.url())) {
      diagnostics.blockedRequests.push({
        url: request.url(),
        resourceType: request.resourceType(),
        reason: "polyfill",
      });
      await route.abort();
      return;
    }

    if (request.resourceType() === "script" && url.origin !== oracleOrigin) {
      diagnostics.blockedRequests.push({
        url: request.url(),
        resourceType: request.resourceType(),
        reason: "external-script",
      });
      await route.abort();
      return;
    }

    await route.continue();
  });
}

async function findBrowserExecutable(
  configuredPath: string | undefined,
): Promise<string> {
  if (configuredPath) {
    await access(configuredPath);
    return configuredPath;
  }

  const candidates = [
    join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(
      process.env["PROGRAMFILES(X86)"] ?? "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    join(
      process.env.LOCALAPPDATA ?? "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
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
    if (!candidate || candidate === "chrome.exe") {
      continue;
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known installation location.
    }
  }

  throw new Error(
    "No Chrome executable found. Set WEBMCP_ORACLE_BROWSER_PATH or CHROME_PATH to Chrome for Testing.",
  );
}

function browserPathFor(mode: ScenarioMode): string | undefined {
  if (mode === "no-native-control") {
    return (
      process.env.WEBMCP_ORACLE_CONTROL_BROWSER_PATH ??
      process.env.WEBMCP_ORACLE_BROWSER_PATH ??
      process.env.CHROME_PATH ??
      process.env.CHROME_BIN
    );
  }

  return (
    process.env.WEBMCP_ORACLE_BROWSER_PATH ??
    process.env.CHROME_PATH ??
    process.env.CHROME_BIN
  );
}

function launchArgsFor(mode: ScenarioMode): readonly string[] {
  return mode === "no-native-control"
    ? [...baseLaunchArgs, "--disable-features=WebMCP"]
    : baseLaunchArgs;
}

async function readBrowserIdentity(
  page: Page,
  browser: Browser,
  identity: BrowserIdentity,
): Promise<BrowserIdentity> {
  const pageIdentity = await page.evaluate(async () => {
    const userAgentData = (
      navigator as Navigator & {
        userAgentData?: {
          getHighEntropyValues?: (
            hints: string[],
          ) => Promise<Record<string, unknown>>;
        };
      }
    ).userAgentData;
    const highEntropyValues = userAgentData?.getHighEntropyValues
      ? await userAgentData.getHighEntropyValues([
          "architecture",
          "bitness",
          "fullVersionList",
          "model",
          "platform",
          "platformVersion",
        ])
      : null;
    return {
      userAgent: navigator.userAgent,
      userAgentData: highEntropyValues,
    };
  });

  return {
    ...identity,
    actualVersion: browser.version(),
    userAgent: pageIdentity.userAgent,
    userAgentData: toJsonValue(pageIdentity.userAgentData),
  };
}

async function readPageSnapshot(page: Page): Promise<PageSnapshot> {
  return await page.evaluate(() => ({
    url: location.href,
    origin: location.origin,
    title: document.title,
    secureContext: window.isSecureContext,
    originTrialMetaToken:
      document
        .querySelector('meta[http-equiv="origin-trial"]')
        ?.getAttribute("content") ?? null,
    sizeText: document.querySelector("#size-text")?.textContent?.trim() ?? null,
  }));
}

async function readCapability(page: Page): Promise<WebMcpCapabilityKind> {
  return await page.evaluate(() => {
    try {
      const modelContext = (
        document as Document & {
          modelContext?: {
            getTools?: unknown;
            executeTool?: unknown;
          };
        }
      ).modelContext;
      if (modelContext == null) {
        return "unavailable";
      }
      if (
        typeof modelContext.getTools !== "function" ||
        typeof modelContext.executeTool !== "function"
      ) {
        return "error";
      }
      return "available";
    } catch {
      return "error";
    }
  });
}

type RuntimePageResult = {
  discovery: {
    status: "passed" | "failed";
    error: string | null;
  };
  tools: unknown[];
  expectedToolFound: boolean;
  invocation: {
    status: "passed" | "failed" | "not-run";
    result: unknown;
    error: string | null;
  };
  before: string | null;
  after: string | null;
};

async function readToolsAndExecute(
  page: Page,
): Promise<RuntimePageResult> {
  return await page.evaluate(async ({ toolName, input }) => {
    type ModelContext = {
      getTools(): Promise<unknown[]>;
      executeTool(tool: unknown, input: string): Promise<unknown>;
    };
    const modelContext = (
      document as Document & { modelContext?: ModelContext }
    ).modelContext;

    if (!modelContext) {
      return {
        discovery: { status: "failed", error: "modelContext is absent" },
        tools: [],
        expectedToolFound: false,
        invocation: { status: "not-run", result: null, error: null },
        before: null,
        after: null,
      };
    }

    const snapshotTool = (tool: unknown): Record<string, unknown> => {
      if (tool === null || typeof tool !== "object") {
        return {};
      }
      const candidate = tool as Record<string, unknown>;
      const copyJson = (value: unknown): unknown => {
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
        description:
          typeof candidate.description === "string"
            ? candidate.description
            : null,
        origin: typeof candidate.origin === "string" ? candidate.origin : null,
        inputSchema: copyJson(candidate.inputSchema),
        annotations: copyJson(candidate.annotations),
      };
    };

    let tools: unknown[];
    try {
      tools = await modelContext.getTools();
    } catch (error) {
      return {
        discovery: {
          status: "failed",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        tools: [],
        expectedToolFound: false,
        invocation: { status: "not-run", result: null, error: null },
        before: null,
        after: null,
      };
    }

    const snapshots = tools.map(snapshotTool);
    const expectedTool = tools.find(
      (tool) =>
        tool !== null &&
        typeof tool === "object" &&
        (tool as Record<string, unknown>).name === toolName,
    );
    if (!expectedTool) {
      return {
        discovery: { status: "passed", error: null },
        tools: snapshots,
        expectedToolFound: false,
        invocation: { status: "not-run", result: null, error: null },
        before: document.querySelector("#size-text")?.textContent?.trim() ?? null,
        after: document.querySelector("#size-text")?.textContent?.trim() ?? null,
      };
    }

    const before = document.querySelector("#size-text")?.textContent?.trim() ?? null;
    try {
      const result = await modelContext.executeTool(
        expectedTool,
        JSON.stringify(input),
      );
      let serializableResult: unknown;
      try {
        const encoded = JSON.stringify(result ?? null);
        serializableResult = encoded === undefined ? null : JSON.parse(encoded);
      } catch (error) {
        return {
          discovery: { status: "passed", error: null },
          tools: snapshots,
          expectedToolFound: true,
          invocation: {
            status: "failed",
            result: null,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          },
          before,
          after: document.querySelector("#size-text")?.textContent?.trim() ?? null,
        };
      }
      return {
        discovery: { status: "passed", error: null },
        tools: snapshots,
        expectedToolFound: true,
        invocation: { status: "passed", result: serializableResult, error: null },
        before,
        after: document.querySelector("#size-text")?.textContent?.trim() ?? null,
      };
    } catch (error) {
      return {
        discovery: { status: "passed", error: null },
        tools: snapshots,
        expectedToolFound: true,
        invocation: {
          status: "failed",
          result: null,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        before,
        after: document.querySelector("#size-text")?.textContent?.trim() ?? null,
      };
    }
  }, { toolName: webMcpOracleToolName, input: webMcpOracleToolInput });
}

function tokenEvidence(token: string | null): TokenEvidence {
  const summary = summarizeOriginTrialToken(token);
  return {
    ...summary,
    length: token?.length ?? 0,
    sha256: token ? createHash("sha256").update(token).digest("hex") : null,
  };
}

function originTrialEvidence(
  pageSnapshot: PageSnapshot,
  response: Response | null,
  capability: WebMcpCapabilityKind,
  nowMilliseconds: number,
): OriginTrialEvidence {
  const meta = tokenEvidence(pageSnapshot.originTrialMetaToken);
  const headerToken = response?.headers()["origin-trial"] ?? null;
  const responseHeader = tokenEvidence(headerToken);
  const selected = meta.present ? meta : responseHeader;
  const source: OriginTrialEvidence["source"] = meta.present
    ? "meta"
    : responseHeader.present
      ? "response-header"
      : "none";
  return {
    assessment: assessOriginTrial(
      selected,
      pageSnapshot.origin ?? "",
      capability,
      nowMilliseconds,
    ),
    meta,
    responseHeader,
    source,
  };
}

function launchDetails(mode: ScenarioMode): ScenarioEvidence["launch"] {
  return {
    headless: true,
    args: launchArgsFor(mode),
    profile: "isolated-ephemeral",
    extensions: "disabled",
    proxy: "none",
    webmcpTestingFlag:
      mode === "native-oracle" ? "not-supplied" : "disabled-for-control",
    polyfill: "blocked",
    serviceWorkers: "blocked",
  };
}

function failedScenario(
  mode: ScenarioMode,
  identity: BrowserIdentity,
  diagnostics: BrowserDiagnostics,
  error: unknown,
  code: string,
): ScenarioEvidence {
  return {
    mode,
    classification: mode === "native-oracle" ? "oracle-failed" : "control-failed",
    failureCode: code,
    downstream: mode === "native-oracle" ? "not-evaluable" : "not-applicable",
    browser: identity,
    launch: launchDetails(mode),
    page: { ...emptyPageSnapshot(), navigationStatus: null },
    originTrial: {
      assessment: "unknown",
      meta: tokenEvidence(null),
      responseHeader: tokenEvidence(null),
      source: "none",
    },
    capability: "error",
    discovery: { status: "not-run", error: null },
    runtime: emptyRuntimeEvidence(),
    diagnostics: {
      ...diagnostics,
      pageErrors: [...diagnostics.pageErrors, summarizeError(error)],
    },
  };
}

async function runScenario(mode: ScenarioMode): Promise<ScenarioEvidence> {
  const configuredPath = browserPathFor(mode);
  let executablePath: string | null = configuredPath ?? null;
  const identity = emptyBrowserIdentity(executablePath);
  const diagnostics = emptyDiagnostics();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let response: Response | null = null;

  try {
    executablePath = await findBrowserExecutable(configuredPath);
    identity.executablePath = executablePath;
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [...launchArgsFor(mode)],
    });
    identity.actualVersion = browser.version();

    if (
      mode === "native-oracle" &&
      identity.actualVersion !== expectedBrowserVersion
    ) {
      return failedScenario(
        mode,
        identity,
        diagnostics,
        `Expected Chrome for Testing ${expectedBrowserVersion}, found ${identity.actualVersion}`,
        "browser-version-mismatch",
      );
    }

    context = await browser.newContext({
      serviceWorkers: "block",
      viewport: desktopViewport,
    });
    page = await context.newPage();
    attachDiagnostics(page, diagnostics);
    await installNetworkGuards(context, diagnostics);
    response = await page.goto(webMcpOracleUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    if (!response || !response.ok()) {
      return failedScenario(
        mode,
        identity,
        diagnostics,
        `Oracle navigation returned HTTP ${response?.status() ?? "no response"}`,
        "navigation-failed",
      );
    }
    await page.waitForTimeout(500);

    const pageSnapshot = await readPageSnapshot(page);
    const pageIdentity = await readBrowserIdentity(page, browser, identity);
    const capability = await readCapability(page);
    const trial = originTrialEvidence(
      pageSnapshot,
      response,
      capability,
      Date.now(),
    );
    const baseScenario = {
      mode,
      browser: pageIdentity,
      launch: launchDetails(mode),
      page: {
        ...pageSnapshot,
        navigationStatus: response.status(),
      },
      originTrial: trial,
      capability,
      diagnostics,
    };

    if (mode === "no-native-control") {
      const classification = classifyControlCapability(capability);
      return {
        ...baseScenario,
        classification,
        failureCode: classification === "control-failed" ? "native-exposed" : null,
        downstream: "not-applicable",
        discovery: { status: "not-run", error: null },
        runtime: emptyRuntimeEvidence(),
      };
    }

    if (capability !== "available") {
      const observation = {
        actualBrowserVersion: pageIdentity.actualVersion,
        expectedBrowserVersion,
        navigationStatus: response.status(),
        polyfillBlocked: diagnostics.blockedRequests.some(
          (request) => request.reason === "polyfill",
        ),
        capability,
        discovery: { status: "not-run" as const, error: null },
        discoveredTools: [],
        expectedToolFound: false,
        invocation: {
          status: "not-run" as const,
          result: null,
          expectedResult: webMcpOracleExpectedResult,
          error: null,
        },
        visibleState: {
          before: pageSnapshot.sizeText,
          after: pageSnapshot.sizeText,
          expectedBefore: webMcpOracleExpectedBefore,
          expectedAfter: webMcpOracleExpectedAfter,
        },
        browserErrors: [...diagnostics.consoleErrors, ...diagnostics.pageErrors],
      };
      const decision = classifyOracleObservation(observation);
      return {
        ...baseScenario,
        classification: decision.classification,
        failureCode: decision.failureCode,
        downstream: decision.downstream,
        discovery: observation.discovery,
        runtime: emptyRuntimeEvidence(),
      };
    }

    const runtimeResult = await readToolsAndExecute(page);
    const tools = runtimeResult.tools
      .map((tool) => sanitizeTool(tool))
      .filter((tool): tool is NonNullable<ReturnType<typeof sanitizeTool>> => tool !== null);
    const runtime: RuntimeEvidence = {
      status: runtimeResult.invocation.status === "passed" ? "passed" : "failed",
      error: runtimeResult.invocation.error,
      tools,
      expectedToolFound: runtimeResult.expectedToolFound,
      result: toJsonValue(runtimeResult.invocation.result),
      expectedResult: webMcpOracleExpectedResult,
      before: runtimeResult.before,
      after: runtimeResult.after,
    };
    const observation = {
      actualBrowserVersion: pageIdentity.actualVersion,
      expectedBrowserVersion,
      navigationStatus: response.status(),
      polyfillBlocked: diagnostics.blockedRequests.some(
        (request) => request.reason === "polyfill",
      ),
      capability,
      discovery: runtimeResult.discovery,
      discoveredTools: tools,
      expectedToolFound: runtimeResult.expectedToolFound,
      invocation: {
        status: runtimeResult.invocation.status,
        result: runtime.result,
        expectedResult: webMcpOracleExpectedResult,
        error: runtimeResult.invocation.error,
      },
      visibleState: {
        before: runtime.before,
        after: runtime.after,
        expectedBefore: webMcpOracleExpectedBefore,
        expectedAfter: webMcpOracleExpectedAfter,
      },
      browserErrors: [...diagnostics.consoleErrors, ...diagnostics.pageErrors],
    };
    const decision = classifyOracleObservation(observation);
    return {
      ...baseScenario,
      classification: decision.classification,
      failureCode: decision.failureCode,
      downstream: decision.downstream,
      discovery: runtimeResult.discovery,
      runtime,
    };
  } catch (error) {
    const code: OracleFailureCode | "control-launch-failed" = browser
      ? "navigation-failed"
      : mode === "native-oracle"
        ? "browser-launch-failed"
        : "control-launch-failed";
    return failedScenario(mode, identity, diagnostics, error, code);
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

function overallClassification(
  oracle: ScenarioEvidence,
  control: ScenarioEvidence,
): OracleReport["overall"] {
  if (oracle.classification !== "oracle-passed") {
    return "oracle-failed";
  }
  return control.classification === "native-unavailable"
    ? "passed"
    : "control-failed";
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const oracle = await runScenario("native-oracle");
  const control = await runScenario("no-native-control");
  const overall = overallClassification(oracle, control);
  const report: OracleReport = {
    schemaVersion: 1,
    generatedAt,
    overall,
    downstream: overall === "passed" ? "evaluable" : "not-evaluable",
    runtimeOnly: true,
    procedure: {
      oracleUrl: webMcpOracleUrl,
      repositoryUrl: webMcpOracleRepositoryUrl,
      retrievalDate: generatedAt,
      expectedBrowser: {
        name: "Chrome for Testing",
        version: expectedBrowserVersion,
        channel: expectedChannel,
        operatingSystem:
          configuredExpectedOs ??
          `${platform()} ${release()} ${arch()} (runtime-recorded; set WEBMCP_ORACLE_EXPECTED_OS to enforce the pin)`,
      },
      launch: launchDetails("native-oracle"),
      inspection:
        oracle.classification === "oracle-failed" &&
        oracle.failureCode === "browser-launch-failed"
          ? "not-run"
          : "Playwright page.evaluate using document.modelContext.getTools and executeTool",
      localTestingFlag: "disabled/not-supplied",
      polyfill: "blocked before navigation",
      runtimeProof: "browser behavior only; source inspection is not used",
    },
    oracle,
    control,
    limitations: [
      "The oracle is an exact claim for the recorded Chrome for Testing version, channel, operating system, origin, and retrieval date; it does not infer support for nearby browser builds or alternate hosts.",
      "The live pizza-maker page imports a polyfill in its HTML. The runner aborts that known script before navigation and treats any unblocked polyfill as a failed native proof.",
      "Origin-trial metadata is decoded only for feature, origin, and expiry. A valid token assessment is not a substitute for observing the native API and a passing call.",
      "The control uses the same isolated browser executable with Chrome's WebMCP kill switch (`--disable-features=WebMCP`) unless WEBMCP_ORACLE_CONTROL_BROWSER_PATH is supplied; it is labeled as a control, never as native acceptance evidence.",
      "No source file, repository checkout, extension, WebMCP inspector, or polyfill result is used as runtime proof.",
    ],
  };

  await mkdir(resolve(evidencePath, ".."), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    overall,
    oracle: {
      classification: oracle.classification,
      failureCode: oracle.failureCode,
    },
    control: {
      classification: control.classification,
      failureCode: control.failureCode,
    },
    downstream: report.downstream,
    evidence: evidencePath,
  }, null, 2));

  if (overall !== "passed" && !allowFailure) {
    process.exitCode = 1;
  }
}

await main();
