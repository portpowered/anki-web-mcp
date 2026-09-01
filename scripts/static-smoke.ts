import { createServer, type AddressInfo } from "node:net";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page as PlaywrightPage } from "playwright-core";

const projectRoot = resolve(import.meta.dir, "..");
const exportDirectory = resolve(projectRoot, "out");
const artifactsDirectory = resolve(projectRoot, "test-results", "static-smoke");
const basePath = "/anki-web-mcp";
const desktopViewport = { width: 1280, height: 900 };
const mobileViewport = { width: 320, height: 800 };

class BrowserPage {
  readonly errors: string[] = [];
  readonly failedRequests: string[] = [];
  private readonly responses = new Map<string, { url: string; status: number }>();

  constructor(private readonly page: PlaywrightPage) {
    page.on("pageerror", (error) => {
      this.errors.push(error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        this.errors.push(`console.error: ${message.text()}`);
      }
    });
    page.on("requestfailed", (request) => {
      this.failedRequests.push(
        `${request.failure()?.errorText ?? "Network request failed"} (${request.url()})`,
      );
    });
    page.on("response", (response) => {
      this.responses.set(response.url(), {
        url: response.url(),
        status: response.status(),
      });
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    return await this.page.evaluate(expression) as T;
  }

  async navigate(url: string): Promise<void> {
    const response = await this.page.goto(url, { waitUntil: "networkidle" });
    if (!response) {
      throw new Error(`Could not navigate to ${url}: no document response`);
    }
    if (!response.ok()) {
      throw new Error(`Could not navigate to ${url}: HTTP ${response.status()}`);
    }
    await this.page.waitForTimeout(150);
  }

  async reload(): Promise<void> {
    const response = await this.page.reload({ waitUntil: "networkidle" });
    if (!response) {
      throw new Error("Could not reload the current page: no document response");
    }
    if (!response.ok()) {
      throw new Error(`Could not reload the current page: HTTP ${response.status()}`);
    }
    await this.page.waitForTimeout(150);
  }

  async setViewport(viewport: { width: number; height: number }): Promise<void> {
    await this.page.setViewportSize(viewport);
  }

  async addInitScript(script: string): Promise<void> {
    await this.page.addInitScript({ content: script });
  }

  responseFor(url: string): { url: string; status: number } | undefined {
    return this.responses.get(url);
  }

  clearDiagnostics(): void {
    this.errors.length = 0;
    this.failedRequests.length = 0;
    this.responses.clear();
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true });
  }
}

type StaticServer = {
  origin: string;
  rootDirectory: string;
  process: Bun.Subprocess;
  stop: () => Promise<void>;
};

type Browser = {
  page: BrowserPage;
  version: string;
  stop: () => Promise<void>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function getFreePort(): Promise<number> {
  const server = createServer();

  return new Promise<number>((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        rejectPort(new Error("Could not determine a free local port"));
        return;
      }

      const port = (address as AddressInfo).port;
      server.close((error) => {
        if (error) {
          rejectPort(error);
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

async function waitFor<T>(
  operation: () => Promise<T | false>,
  description: string,
  timeoutMilliseconds = 15_000,
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

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

function findExecutable(command: string): string | undefined {
  try {
    return Bun.which(command) ?? undefined;
  } catch {
    return undefined;
  }
}

async function findBrowserExecutable(): Promise<string> {
  const configuredPath = process.env.CHROME_PATH ?? process.env.CHROME_BIN;

  if (configuredPath) {
    await access(configuredPath);
    return configuredPath;
  }

  const windowsCandidates = [
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

  for (const candidate of windowsCandidates) {
    if (candidate && candidate !== "chrome.exe") {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next installation location.
      }
    }
  }

  for (const command of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
  ]) {
    const executable = findExecutable(command);

    if (executable) {
      return executable;
    }
  }

  throw new Error(
    "Static browser smoke tests need Chromium. Set CHROME_PATH to a Chromium executable or install Google Chrome.",
  );
}

async function runBuild(): Promise<void> {
  console.log("Building the production static export...");
  const build = Bun.spawn([process.execPath, "run", "build"], {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await build.exited;

  assert(exitCode === 0, `Production build failed with exit code ${exitCode}`);
}

async function startStaticServer(): Promise<StaticServer> {
  const rootDirectory = await mkdtemp(join(tmpdir(), "anki-web-mcp-static-"));
  const stagedBasePath = join(rootDirectory, basePath.slice(1));
  await mkdir(rootDirectory, { recursive: true });
  await cp(exportDirectory, stagedBasePath, { recursive: true });

  const port = await getFreePort();
  const pythonCommand = process.platform === "win32" ? "python" : "python3";
  const staticServer = Bun.spawn(
    [
      pythonCommand,
      "-m",
      "http.server",
      String(port),
      "--bind",
      "127.0.0.1",
    ],
    {
      cwd: rootDirectory,
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  try {
    const origin = `http://127.0.0.1:${port}`;

    await waitFor(
      async () => {
        const response = await fetch(`${origin}${basePath}/`);
        return response.ok;
      },
      "the static server",
    );

    return {
      origin,
      rootDirectory,
      process: staticServer,
      stop: async () => {
        staticServer.kill();
        await staticServer.exited;
        await rm(rootDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    staticServer.kill();
    await staticServer.exited;
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function startBrowser(): Promise<Browser> {
  const executable = await findBrowserExecutable();
  const browser = await chromium.launch({
    executablePath: executable,
    headless: true,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const context = await browser.newContext({ viewport: desktopViewport });
    const page = new BrowserPage(await context.newPage());

    return {
      page,
      version: browser.version(),
      stop: async () => {
        await browser.close();
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function assertApplicationDocument(
  url: string,
  marker: string,
): Promise<void> {
  const response = await fetch(url);
  const body = await response.text();

  assert(response.status === 200, `${url} returned HTTP ${response.status}`);
  assert(body.includes(marker), `${url} did not contain application marker ${marker}`);
  assert(
    !body.includes("There isn't a GitHub Pages site here"),
    `${url} returned GitHub's stock 404 document`,
  );
}

async function assertOriginTrialDeliveredInHead(url: string): Promise<void> {
  const response = await fetch(url);
  const body = await response.text();
  const headEnd = body.indexOf("</head>");
  const tokenMeta = body.indexOf('http-equiv="origin-trial"');

  assert(headEnd >= 0, `${url} did not contain a document head`);
  assert(
    tokenMeta >= 0 && tokenMeta < headEnd,
    `${url} did not deliver the origin-trial meta tag in the initial head`,
  );
}

type VisibleResource = { kind: string; url: string };
type LinkDetails = {
  href: string;
  tabIndex: number;
  text: string;
  width: number;
  height: number;
};

async function assertLoadedResources(page: BrowserPage): Promise<void> {
  const resources = await page.evaluate<VisibleResource[]>(`(() => [
    ...Array.from(document.querySelectorAll('script[src]'))
      .filter((element) => !element.noModule)
      .map((element) => ({
        kind: 'script',
        url: element.src,
      })),
    ...Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).map((element) => ({
      kind: 'style',
      url: element.href,
    })),
    ...Array.from(document.querySelectorAll('img[src]')).map((element) => ({
      kind: 'image',
      url: element.src,
    })),
  ])()`);

  assert(resources.some((resource) => resource.kind === "script"), "No application script was requested");
  assert(resources.some((resource) => resource.kind === "style"), "No application stylesheet was requested");
  assert(resources.some((resource) => resource.kind === "image"), "No visible diagnostic asset was requested");

  for (const resource of resources) {
    const response = page.responseFor(resource.url);
    assert(response, `No network response was observed for ${resource.kind} ${resource.url}`);
    assert(
      (response.status >= 200 && response.status < 300) || response.status === 304,
      `${resource.kind} ${resource.url} returned HTTP ${response.status}`,
    );
  }

  const imagesLoaded = await page.evaluate<boolean>(`Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0)`);
  assert(imagesLoaded, "A visible application image did not finish loading");
}

async function assertKeyboardNavigation(page: BrowserPage, expectedHref: string): Promise<void> {
  const links = await page.evaluate<LinkDetails[]>(`Array.from(document.querySelectorAll('a')).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      href: element.href,
      tabIndex: element.tabIndex,
      text: element.textContent?.trim() ?? '',
      width: rect.width,
      height: rect.height,
    };
  })`);

  assert(links.length >= 2, "The diagnostic document did not expose keyboard navigation links");
  assert(
    links.every((link) => link.tabIndex >= 0 && link.width > 0 && link.height > 0),
    "A diagnostic navigation link is not visible and keyboard focusable",
  );
  assert(
    links.some((link) => link.href === expectedHref),
    `The diagnostic navigation did not expose ${expectedHref}`,
  );

  const focusResult = await page.evaluate<{ active: boolean; outlineWidth: string }>(`(() => {
    const link = Array.from(document.querySelectorAll('a')).find((element) =>
      element.href === ${JSON.stringify(expectedHref)},
    );
    link?.focus({ focusVisible: true });
    const style = link ? getComputedStyle(link) : null;
    return {
      active: document.activeElement === link,
      outlineWidth: style?.outlineWidth ?? '0px',
    };
  })()`);
  assert(focusResult.active, "The diagnostic navigation link could not receive focus");
  assert(focusResult.outlineWidth !== "0px", "Focused navigation has no visible focus indicator");
}

async function assertNoBrowserErrors(page: BrowserPage): Promise<void> {
  assert(page.errors.length === 0, `Browser reported errors: ${page.errors.join(" | ")}`);
  assert(
    page.failedRequests.length === 0,
    `Browser reported failed requests: ${page.failedRequests.join(" | ")}`,
  );
}

type RootWebMcpEvidence = {
  schemaVersion: 1;
  generatedAt: string;
  browser: { engine: "Chromium"; version: string };
  url: string;
  runtimeMode: string;
  originTrial: string;
  context: string;
  permissionsPolicy: string;
  failureCode: string;
  originTrialMetaPresent: boolean;
  counter: number;
  toolName: string | null;
  reloadVerified: boolean;
};

async function verifyRootRoute(
  page: BrowserPage,
  origin: string,
  browserVersion: string,
): Promise<RootWebMcpEvidence> {
  const url = `${origin}${basePath}/`;
  await assertApplicationDocument(url, "Static export harness");
  await assertOriginTrialDeliveredInHead(url);
  page.clearDiagnostics();
  await page.navigate(url);
  let evidence: RootWebMcpEvidence | undefined;

  for (const reload of [false, true]) {
    if (reload) {
      page.clearDiagnostics();
      await page.reload();
    }

    const documentState = await page.evaluate<{
      pathname: string;
      search: string;
      heading: string;
      capability: string | null;
      runtimeMode: string | null;
      originTrial: string | null;
      context: string | null;
      permissionsPolicy: string | null;
      failureCode: string | null;
      originTrialMetaLength: number;
      counter: number | null;
      toolName: string | null;
      statusText: string;
    }>(`({
      pathname: location.pathname,
      search: location.search,
      heading: document.querySelector('h1')?.textContent?.trim() ?? '',
      capability: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? null,
      runtimeMode: document.querySelector('[data-webmcp-runtime-mode]')?.getAttribute('data-webmcp-runtime-mode') ?? null,
      originTrial: document.querySelector('[data-webmcp-origin-trial-value]')?.textContent?.trim() ?? null,
      context: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-context') ?? null,
      permissionsPolicy: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-permissions-policy') ?? null,
      failureCode: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-failure-code') ?? null,
      originTrialMetaLength: document.querySelector('meta[http-equiv="origin-trial"]')?.getAttribute('content')?.length ?? 0,
      counter: Number(document.querySelector('[data-diagnostic-counter]')?.textContent ?? 'NaN'),
      toolName: document.querySelector('[data-webmcp-tool-name]')?.getAttribute('data-webmcp-tool-name') || null,
      statusText: document.querySelector('[data-webmcp-capability] .status')?.textContent?.trim() ?? '',
    })`);
    assert(documentState.pathname === `${basePath}/`, "Root navigation did not preserve the project base path");
    assert(documentState.search === "", "Root navigation unexpectedly changed the query string");
    assert(documentState.heading === "Static export harness", "Root heading was not rendered");
    assert(documentState.capability === "native-unavailable", "Root did not report absent native WebMCP");
    assert(documentState.runtimeMode === "native-unavailable", "Root runtime mode was not classified");
    assert(documentState.context === "secure-non-production", "Root context was not classified");
    assert(["allowed", "denied", "unknown"].includes(documentState.permissionsPolicy ?? ""), "Root Permissions Policy was not classified");
    assert(documentState.failureCode === "native-unavailable", "Root absence was not classified");
    assert(
      documentState.originTrial !== null &&
        ["accepted", "rejected", "expired", "mismatched", "not-required", "unknown"].includes(documentState.originTrial),
      "Root did not report a classified origin-trial status",
    );
    assert(documentState.originTrialMetaLength > 0, "Root did not deliver an origin-trial token in the document head");
    assert(documentState.counter === 0, "Unavailable root changed the diagnostic counter");
    assert(documentState.toolName === null, "Unavailable root exposed a diagnostic tool name");
    assert(documentState.statusText.includes("usable"), "Unavailable root omitted recovery guidance");
    await assertLoadedResources(page);
    await assertKeyboardNavigation(page, `${origin}${basePath}/study/?deck=diagnostic`);
    await assertNoBrowserErrors(page);

    evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      browser: { engine: "Chromium", version: browserVersion },
      url,
      runtimeMode: documentState.runtimeMode,
      originTrial: documentState.originTrial,
      context: documentState.context ?? "unknown",
      permissionsPolicy: documentState.permissionsPolicy ?? "unknown",
      failureCode: documentState.failureCode ?? "unknown",
      originTrialMetaPresent: documentState.originTrialMetaLength > 0,
      counter: documentState.counter,
      toolName: documentState.toolName,
      reloadVerified: reload,
    };
  }

  if (!evidence) {
    throw new Error("Root WebMCP evidence was not captured");
  }
  return evidence;
}

async function verifyStudyRoute(page: BrowserPage, origin: string): Promise<void> {
  const url = `${origin}${basePath}/study/?deck=diagnostic`;
  await assertApplicationDocument(url, "Study route diagnostics");
  page.clearDiagnostics();
  await page.navigate(url);

  for (const reload of [false, true]) {
    if (reload) {
      page.clearDiagnostics();
      await page.reload();
    }

    const documentState = await page.evaluate<{
      pathname: string;
      search: string;
      heading: string;
      deck: string;
      capability: string | null;
      runtimeMode: string | null;
      context: string | null;
      permissionsPolicy: string | null;
      failureCode: string | null;
    }>(`({
      pathname: location.pathname,
      search: location.search,
      heading: document.querySelector('h1')?.textContent?.trim() ?? '',
      deck: document.querySelector('.query-details dd code')?.textContent?.trim() ?? '',
      capability: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? null,
      runtimeMode: document.querySelector('[data-webmcp-runtime-mode]')?.getAttribute('data-webmcp-runtime-mode') ?? null,
      context: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-context') ?? null,
      permissionsPolicy: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-permissions-policy') ?? null,
      failureCode: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-failure-code') ?? null,
    })`);
    assert(documentState.pathname === `${basePath}/study/`, "Study navigation did not preserve the project base path");
    assert(documentState.search === "?deck=diagnostic", "Study reload did not preserve the deck query");
    assert(documentState.heading === "Study route diagnostics", "Study heading was not rendered");
    assert(documentState.deck === "diagnostic", "Study route did not render the deck query");
    assert(documentState.capability === "native-unavailable", "Study did not report absent native WebMCP");
    assert(documentState.runtimeMode === "native-unavailable", "Study runtime mode was not classified");
    assert(documentState.context === "secure-non-production", "Study context was not classified");
    assert(["allowed", "denied", "unknown"].includes(documentState.permissionsPolicy ?? ""), "Study Permissions Policy was not classified");
    assert(documentState.failureCode === "native-unavailable", "Study absence was not classified");
    await assertLoadedResources(page);
    await assertKeyboardNavigation(page, `${origin}${basePath}/`);
    await assertNoBrowserErrors(page);
  }
}

async function verifyMobileRoutes(page: BrowserPage, origin: string): Promise<void> {
  await page.setViewport(mobileViewport);

  for (const route of [
    { name: "root", path: `${basePath}/`, expectedHref: `${origin}${basePath}/study/?deck=diagnostic` },
    { name: "study", path: `${basePath}/study/?deck=diagnostic`, expectedHref: `${origin}${basePath}/` },
  ]) {
    page.clearDiagnostics();
    await page.navigate(`${origin}${route.path}`);
    const layout = await page.evaluate<{ viewport: number; scrollWidth: number; clientWidth: number }>(`({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    })`);
    assert(layout.viewport === mobileViewport.width, `${route.name} did not use the 320px viewport`);
    assert(
      layout.scrollWidth <= layout.clientWidth,
      `${route.name} has horizontal overflow (${layout.scrollWidth}px > ${layout.clientWidth}px)`,
    );
    await assertKeyboardNavigation(page, route.expectedHref);
    await assertNoBrowserErrors(page);
  }
}

async function verifyRootProbePresentationControls(
  page: BrowserPage,
  origin: string,
): Promise<void> {
  // These controls deliberately install a page-local test double. They only
  // exercise rendering and handler behavior; the native oracle and deployed
  // acceptance run never use this path as WebMCP support evidence.
  await page.addInitScript(`(() => {
    const mode = new URL(location.href).searchParams.get('__webmcp_probe');
    const isRootPresentation = mode === 'ready' || mode === 'error';
    const isStudyPresentation = mode === 'study-ready' || mode === 'study-error';
    if (!isRootPresentation && !isStudyPresentation) {
      return;
    }

    const registeredTools = [];
    const modelContext = {
      registerTool(tool, options) {
        if (mode === 'error' || mode === 'study-error') {
          return Promise.reject(new DOMException('Blocked by presentation control', 'NotAllowedError'));
        }
        registeredTools.push(tool);
        registration.tool = tool;
        registration.options = options || null;
        const signal = options?.signal;
        const remove = () => {
          const index = registeredTools.indexOf(tool);
          if (index >= 0) {
            registeredTools.splice(index, 1);
          }
        };
        signal?.addEventListener('abort', remove, { once: true });
        return Promise.resolve();
      },
      getTools() {
        return Promise.resolve([...registeredTools]);
      },
      executeTool(tool, input) {
        return tool.execute(JSON.parse(input));
      },
    };
    const registration = { tool: null, options: null, modelContext };
    window.__webmcpPresentationContext = modelContext;
    if (isStudyPresentation) {
      window.__studyWebMcpPresentation = registration;
    } else {
      window.__rootWebMcpPresentation = registration;
    }
    Object.defineProperty(Document.prototype, 'modelContext', {
      configurable: true,
      get() {
        return modelContext;
      },
    });
    try {
      Object.defineProperty(Document.prototype, 'permissionsPolicy', {
        configurable: true,
        get() {
          return { allowsFeature: (feature) => feature === 'tools' };
        },
      });
    } catch {
      // Older Chromium builds may expose a non-configurable policy object.
    }
  })()`);

  await page.setViewport(desktopViewport);
  page.clearDiagnostics();
  await page.navigate(`${origin}${basePath}/?__webmcp_probe=ready`);
  await waitFor(
    async () => page.evaluate<string>(
      "document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? ''",
    ).then((status) => status === "native-ready" ? status : false),
    "the root ready presentation control",
  );

  const readyResult = await page.evaluate<{
    status: string;
    context: string;
    permissionsPolicy: string;
    failureCode: string;
    toolName: string | null;
    registrationOptionNames: string[];
    valid: Record<string, unknown> | null;
    duplicate: Record<string, unknown> | null;
    invalid: Record<string, unknown> | null;
  }>(`(async () => {
    const registration = window.__rootWebMcpPresentation;
    const tool = registration?.tool;
    const valid = tool
      ? await tool.execute({ amount: 2, command_id: 'presentation-valid' })
      : null;
    const duplicate = tool
      ? await tool.execute({ amount: 2, command_id: 'presentation-valid' })
      : null;
    const invalid = tool
      ? await tool.execute({ amount: 1.5, command_id: 'presentation-invalid' })
      : null;
    return {
      status: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? '',
      context: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-context') ?? '',
      permissionsPolicy: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-permissions-policy') ?? '',
      failureCode: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-failure-code') ?? '',
      toolName: tool?.name ?? null,
      registrationOptionNames: Object.keys(registration?.options ?? {}).sort(),
      valid,
      duplicate,
      invalid,
    };
  })()`);
  assert(readyResult.status === "native-ready", "Ready presentation did not settle");
  assert(readyResult.context === "secure-non-production", "Ready presentation did not identify its non-production context");
  assert(["allowed", "denied", "unknown"].includes(readyResult.permissionsPolicy), "Ready presentation did not classify Permissions Policy");
  assert(readyResult.failureCode === "", "Ready presentation reported a failure classification");
  assert(readyResult.toolName === "webmcp_diagnostic_increment", "Ready presentation did not capture the native tool");
  assert(readyResult.registrationOptionNames.length === 1 && readyResult.registrationOptionNames[0] === "signal", "Production registration exposed cross-origin options");
  assert(readyResult.valid?.status === "applied", "Ready presentation rejected a valid call");
  assert(readyResult.valid?.counter === 2, "Ready presentation returned the wrong counter");
  assert(readyResult.duplicate?.code === "duplicate-command", "Ready presentation did not classify a duplicate command");
  assert(readyResult.invalid?.code === "invalid-input", "Ready presentation did not classify invalid input");
  const visibleCounter = await waitFor(
    async () => page.evaluate<string>(
      "document.querySelector('[data-diagnostic-counter]')?.textContent?.trim() ?? ''",
    ).then((counter) => counter === "2" ? counter : false),
    "the ready presentation counter mutation",
  );
  assert(visibleCounter === "2", "Ready presentation did not visibly mutate the counter once");
  await assertNoBrowserErrors(page);

  await page.setViewport(mobileViewport);
  page.clearDiagnostics();
  await page.navigate(`${origin}${basePath}/?__webmcp_probe=ready`);
  const readyMobileLayout = await page.evaluate<{ scrollWidth: number; clientWidth: number }>(`({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  })`);
  assert(
    readyMobileLayout.scrollWidth <= readyMobileLayout.clientWidth,
    `Ready presentation has horizontal overflow (${readyMobileLayout.scrollWidth}px > ${readyMobileLayout.clientWidth}px)`,
  );
  await assertNoBrowserErrors(page);

  page.clearDiagnostics();
  await page.navigate(`${origin}${basePath}/?__webmcp_probe=error`);
  await waitFor(
    async () => page.evaluate<string>(
      "document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? ''",
    ).then((status) => status === "native-error" ? status : false),
    "the root registration-error presentation control",
  );
  const errorResult = await page.evaluate<{ status: string; toolName: string | null; counter: string; text: string }>(`({
    status: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? '',
    toolName: document.querySelector('[data-webmcp-tool-name]')?.getAttribute('data-webmcp-tool-name') || null,
    counter: document.querySelector('[data-diagnostic-counter]')?.textContent?.trim() ?? '',
    text: document.querySelector('[data-webmcp-capability] .status')?.textContent?.trim() ?? '',
  })`);
  assert(errorResult.status === "native-error", "Error presentation did not settle");
  assert(errorResult.toolName === null, "Error presentation exposed a rejected tool");
  assert(errorResult.counter === "0", "Error presentation mutated the counter");
  assert(errorResult.text.includes("Human navigation remains available"), "Error presentation omitted recovery guidance");
  const errorFailureCode = await page.evaluate<string>(
    "document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-failure-code') ?? ''",
  );
  assert(errorFailureCode === "permissions-policy-denied", "Error presentation did not classify the rejected registration");

  page.clearDiagnostics();
  await page.navigate(`${origin}${basePath}/?__webmcp_probe=ready`);
  await waitFor(
    async () => page.evaluate<string>(
      "document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? ''",
    ).then((status) => status === "native-ready" ? status : false),
    "root registration recovery after an error",
  );
  const recoveredRoot = await page.evaluate<{ status: string; toolName: string | null; counter: string }>(`({
    status: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? '',
    toolName: document.querySelector('[data-webmcp-tool-name]')?.getAttribute('data-webmcp-tool-name') || null,
    counter: document.querySelector('[data-diagnostic-counter]')?.textContent?.trim() ?? '',
  })`);
  assert(recoveredRoot.status === "native-ready", "Root did not recover after registration error");
  assert(recoveredRoot.toolName === "webmcp_diagnostic_increment", "Root recovery did not register its tool");
  assert(recoveredRoot.counter === "0", "Root recovery retained state from the failed route");
  await assertNoBrowserErrors(page);

  const errorMobileLayout = await page.evaluate<{ scrollWidth: number; clientWidth: number }>(`({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  })`);
  assert(
    errorMobileLayout.scrollWidth <= errorMobileLayout.clientWidth,
    `Error presentation has horizontal overflow (${errorMobileLayout.scrollWidth}px > ${errorMobileLayout.clientWidth}px)`,
  );
  await assertNoBrowserErrors(page);

  await page.setViewport(desktopViewport);
  page.clearDiagnostics();
  await page.navigate(`${origin}${basePath}/study/?deck=diagnostic&__webmcp_probe=study-ready`);
  await waitFor(
    async () => page.evaluate<string>(
      "document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? ''",
    ).then((status) => status === "native-ready" ? status : false),
    "the study ready presentation control",
  );

  const studyReadyResult = await page.evaluate<{
    status: string;
    toolName: string | null;
    valid: Record<string, unknown> | null;
    duplicate: Record<string, unknown> | null;
    invalid: Record<string, unknown> | null;
    cancelled: Record<string, unknown> | null;
  }>(`(async () => {
    const registration = window.__studyWebMcpPresentation;
    const tool = registration?.tool;
    const valid = tool
      ? await tool.execute({ deck: 'diagnostic', side: 'back', command_id: 'study-presentation-valid' })
      : null;
    const duplicate = tool
      ? await tool.execute({ deck: 'diagnostic', side: 'front', command_id: 'study-presentation-valid' })
      : null;
    const invalid = tool
      ? await tool.execute({ deck: 'diagnostic', side: 'middle', command_id: 'study-presentation-invalid' })
      : null;
    const abortController = new AbortController();
    abortController.abort();
    const cancelled = tool
      ? await tool.execute(
        { deck: 'diagnostic', side: 'front', command_id: 'study-presentation-cancelled' },
        { signal: abortController.signal },
      )
      : null;
    return {
      status: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? '',
      toolName: tool?.name ?? null,
      valid,
      duplicate,
      invalid,
      cancelled,
    };
  })()`);
  assert(studyReadyResult.status === "native-ready", "Study ready presentation did not settle");
  assert(studyReadyResult.toolName === "webmcp_diagnostic_set_side", "Study presentation did not capture the native tool");
  assert(studyReadyResult.valid?.status === "applied", "Study presentation rejected a valid call");
  assert(studyReadyResult.valid?.route === "/study/", "Study presentation returned the wrong route");
  assert(studyReadyResult.valid?.deck === "diagnostic", "Study presentation returned the wrong deck");
  assert(studyReadyResult.valid?.side === "back", "Study presentation returned the wrong side");
  assert(studyReadyResult.valid?.mutation_count === 1, "Study presentation returned the wrong mutation count");
  assert(studyReadyResult.duplicate?.code === "duplicate-command", "Study presentation did not classify a duplicate command");
  assert(studyReadyResult.invalid?.code === "invalid-input", "Study presentation did not classify invalid input");
  assert(studyReadyResult.cancelled?.code === "execution-cancelled", "Study presentation did not classify an aborted call");
  const visibleStudyState = await waitFor(
    async () => page.evaluate<{ side: string; count: string; command: string }>(`({
      side: document.querySelector('[data-diagnostic-side]')?.textContent?.trim() ?? '',
      count: document.querySelector('[data-diagnostic-mutation-count]')?.textContent?.trim() ?? '',
      command: document.querySelector('[data-diagnostic-last-command]')?.textContent?.trim() ?? '',
    })`).then((visible) => visible.side === "back" && visible.count === "1" ? visible : false),
    "the study ready presentation mutation",
  );
  assert(visibleStudyState.side === "back", "Study presentation did not visibly change the side");
  assert(visibleStudyState.count === "1", "Study presentation mutated the side more than once");
  assert(visibleStudyState.command === "study-presentation-valid", "Study presentation lost the command identifier");
  await assertNoBrowserErrors(page);

  const studyToolsBeforeNavigation = await page.evaluate<string[]>(
    "window.__webmcpPresentationContext ? window.__webmcpPresentationContext.getTools().then((tools) => tools.map((tool) => tool.name)) : []",
  );
  assert(
    studyToolsBeforeNavigation.length === 1 &&
      studyToolsBeforeNavigation[0] === "webmcp_diagnostic_set_side",
    "Study presentation did not expose only the study tool",
  );

  await page.evaluate("document.querySelector('a[href$=\"/anki-web-mcp/\"]')?.click()");
  await waitFor(
    async () => page.evaluate<string>("location.pathname").then((pathname) => pathname === `${basePath}/` ? pathname : false),
    "navigation from study to root",
  );
  const rootToolsAfterNavigation = await page.evaluate<string[]>(
    "window.__webmcpPresentationContext ? window.__webmcpPresentationContext.getTools().then((tools) => tools.map((tool) => tool.name)) : []",
  );
  assert(
    rootToolsAfterNavigation.length === 1 &&
      rootToolsAfterNavigation[0] === "webmcp_diagnostic_increment",
    "Study tool remained discoverable after navigating to root",
  );

  await page.evaluate("document.querySelector('a[href*=\"/study/?deck=diagnostic\"]')?.click()");
  await waitFor(
    async () => page.evaluate<string>("location.pathname + location.search").then((locationValue) => locationValue === `${basePath}/study/?deck=diagnostic` ? locationValue : false),
    "navigation from root back to study",
  );
  const studyToolsAfterNavigation = await page.evaluate<string[]>(
    "window.__webmcpPresentationContext ? window.__webmcpPresentationContext.getTools().then((tools) => tools.map((tool) => tool.name)) : []",
  );
  assert(
    studyToolsAfterNavigation.length === 1 &&
      studyToolsAfterNavigation[0] === "webmcp_diagnostic_set_side",
    "Root tool remained discoverable after navigating back to study",
  );
  await assertNoBrowserErrors(page);

  await page.setViewport(mobileViewport);
  page.clearDiagnostics();
  await page.navigate(`${origin}${basePath}/study/?deck=diagnostic&__webmcp_probe=study-ready`);
  const studyReadyMobileLayout = await page.evaluate<{ scrollWidth: number; clientWidth: number }>(`({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  })`);
  assert(
    studyReadyMobileLayout.scrollWidth <= studyReadyMobileLayout.clientWidth,
    `Study ready presentation has horizontal overflow (${studyReadyMobileLayout.scrollWidth}px > ${studyReadyMobileLayout.clientWidth}px)`,
  );
  await assertNoBrowserErrors(page);

  page.clearDiagnostics();
  await page.navigate(`${origin}${basePath}/study/?deck=diagnostic&__webmcp_probe=study-error`);
  await waitFor(
    async () => page.evaluate<string>(
      "document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? ''",
    ).then((status) => status === "native-error" ? status : false),
    "the study registration-error presentation control",
  );
  const studyErrorResult = await page.evaluate<{ status: string; toolName: string | null; side: string; count: string; text: string }>(`({
    status: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? '',
    toolName: document.querySelector('[data-webmcp-tool-name]')?.getAttribute('data-webmcp-tool-name') || null,
    side: document.querySelector('[data-diagnostic-side]')?.textContent?.trim() ?? '',
    count: document.querySelector('[data-diagnostic-mutation-count]')?.textContent?.trim() ?? '',
    text: document.querySelector('[data-webmcp-capability] .status')?.textContent?.trim() ?? '',
  })`);
  assert(studyErrorResult.status === "native-error", "Study error presentation did not settle");
  assert(studyErrorResult.toolName === null, "Study error presentation exposed a rejected tool");
  assert(studyErrorResult.side === "front", "Study error presentation changed the side");
  assert(studyErrorResult.count === "0", "Study error presentation changed the mutation count");
  assert(studyErrorResult.text.includes("Human navigation remains available"), "Study error presentation omitted recovery guidance");
  const studyErrorFailureCode = await page.evaluate<string>(
    "document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-failure-code') ?? ''",
  );
  assert(studyErrorFailureCode === "permissions-policy-denied", "Study error presentation did not classify the rejected registration");
  await assertNoBrowserErrors(page);
}

async function writeFailureArtifacts(page: BrowserPage | undefined, error: unknown): Promise<void> {
  await mkdir(artifactsDirectory, { recursive: true });
  const details = {
    message: error instanceof Error ? error.message : String(error),
    currentUrl: page ? await page.evaluate<string>("location.href").catch(() => "unknown") : "unknown",
    browserErrors: page?.errors ?? [],
    failedRequests: page?.failedRequests ?? [],
  };
  await Bun.write(
    join(artifactsDirectory, "failure.json"),
    JSON.stringify(details, null, 2) + "\n",
  );

  if (page) {
    await page.screenshot(join(artifactsDirectory, "failure.png")).catch(() => undefined);
    const html = await page.evaluate<string>("document.documentElement.outerHTML").catch(() => "");
    await Bun.write(join(artifactsDirectory, "failure.html"), html);
  }
}

async function writeRootWebMcpEvidence(
  evidence: RootWebMcpEvidence,
): Promise<void> {
  await mkdir(artifactsDirectory, { recursive: true });
  await Bun.write(
    join(artifactsDirectory, "root-webmcp.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  await runBuild();
  const staticServer = await startStaticServer();
  let browser: Browser | undefined;

  try {
    browser = await startBrowser();
    await browser.page.setViewport(desktopViewport);
    const rootEvidence = await verifyRootRoute(
      browser.page,
      staticServer.origin,
      browser.version,
    );
    await writeRootWebMcpEvidence(rootEvidence);
    await verifyStudyRoute(browser.page, staticServer.origin);
    await verifyMobileRoutes(browser.page, staticServer.origin);
    await verifyRootProbePresentationControls(browser.page, staticServer.origin);
    console.log("Static browser smoke tests passed for desktop and 320px Chromium.");
  } catch (error) {
    await writeFailureArtifacts(browser?.page, error);
    throw error;
  } finally {
    if (browser) {
      await browser.stop();
    }
    await staticServer.stop();
  }
}

await main();
