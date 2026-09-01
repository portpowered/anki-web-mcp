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
import WebSocket from "ws";

const projectRoot = resolve(import.meta.dir, "..");
const exportDirectory = resolve(projectRoot, "out");
const artifactsDirectory = resolve(projectRoot, "test-results", "static-smoke");
const basePath = "/anki-web-mcp";
const desktopViewport = { width: 1280, height: 900 };
const mobileViewport = { width: 320, height: 800 };

type CdpParams = Record<string, unknown>;

type CdpMessage = {
  id?: number;
  method?: string;
  params?: CdpParams;
  result?: CdpParams;
  error?: { message?: string };
  sessionId?: string;
};

type CdpListener = (params: CdpParams, sessionId?: string) => void;

type CdpResponse<T extends CdpParams> = T;

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: CdpParams) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<CdpListener>>();

  private constructor(socket: WebSocket) {
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      const message = JSON.parse(event.data) as CdpMessage;

      if (message.id !== undefined) {
        const request = this.pending.get(message.id);

        if (!request) {
          return;
        }

        this.pending.delete(message.id);

        if (message.error) {
          request.reject(
            new Error(message.error.message ?? "Chrome DevTools command failed"),
          );
        } else {
          request.resolve(message.result ?? {});
        }

        return;
      }

      if (!message.method) {
        return;
      }

      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {}, message.sessionId);
      }
    });

    socket.addEventListener("close", () => {
      const error = new Error("Chrome DevTools connection closed");

      for (const request of this.pending.values()) {
        request.reject(error);
      }

      this.pending.clear();
    });
  }

  static async connect(webSocketUrl: string): Promise<CdpClient> {
    const socket = new WebSocket(webSocketUrl);

    try {
      await new Promise<void>((resolveConnection, rejectConnection) => {
        const onOpen = () => {
          socket.removeEventListener("error", onError);
          resolveConnection();
        };
        const onError = () => {
          socket.removeEventListener("open", onOpen);
          rejectConnection(new Error("Could not connect to Chrome DevTools"));
        };

        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
      });
    } catch (error) {
      socket.close();
      throw error;
    }

    return new CdpClient(socket);
  }

  send<T extends CdpParams>(
    method: string,
    params: CdpParams = {},
    sessionId?: string,
  ): Promise<CdpResponse<T>> {
    const id = this.nextId++;

    return new Promise<CdpResponse<T>>((resolveResponse, rejectResponse) => {
      this.pending.set(id, {
        resolve: (value) => resolveResponse(value as CdpResponse<T>),
        reject: rejectResponse,
      });

      const message: CdpMessage = { id, method, params };

      if (sessionId) {
        message.sessionId = sessionId;
      }

      this.socket.send(JSON.stringify(message));
    });
  }

  on(method: string, listener: CdpListener): () => void {
    const listeners = this.listeners.get(method) ?? new Set<CdpListener>();
    listeners.add(listener);
    this.listeners.set(method, listeners);

    return () => {
      listeners.delete(listener);

      if (listeners.size === 0) {
        this.listeners.delete(method);
      }
    };
  }

  waitFor(
    method: string,
    sessionId: string,
    timeoutMilliseconds = 15_000,
  ): Promise<CdpParams> {
    return new Promise<CdpParams>((resolveEvent, rejectEvent) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        rejectEvent(
          new Error(
            `Timed out waiting for ${method} after ${timeoutMilliseconds}ms`,
          ),
        );
      }, timeoutMilliseconds);
      const unsubscribe = this.on(method, (params, eventSessionId) => {
        if (eventSessionId !== sessionId) {
          return;
        }

        clearTimeout(timeout);
        unsubscribe();
        resolveEvent(params);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

class CdpPage {
  readonly errors: string[] = [];
  readonly failedRequests: string[] = [];
  private readonly responses = new Map<string, { url: string; status: number }>();

  constructor(
    private readonly client: CdpClient,
    private readonly sessionId: string,
  ) {
    client.on("Runtime.exceptionThrown", (params, eventSessionId) => {
      if (eventSessionId !== sessionId) {
        return;
      }

      const details = params.exceptionDetails as CdpParams | undefined;
      const description = details?.text ?? "Uncaught page exception";
      this.errors.push(String(description));
    });

    client.on("Runtime.consoleAPICalled", (params, eventSessionId) => {
      if (eventSessionId !== sessionId || params.type !== "error") {
        return;
      }

      const args = Array.isArray(params.args)
        ? params.args
            .map((argument) => {
              const value = argument as CdpParams;
              return String(value.value ?? value.description ?? "");
            })
            .join(" ")
        : "";
      this.errors.push(`console.error: ${args}`.trim());
    });

    client.on("Log.entryAdded", (params, eventSessionId) => {
      if (eventSessionId !== sessionId) {
        return;
      }

      const entry = params.entry as CdpParams | undefined;

      if (entry?.level === "error") {
        this.errors.push(`browser log: ${String(entry.text ?? "")}`);
      }
    });

    client.on("Network.responseReceived", (params, eventSessionId) => {
      if (eventSessionId !== sessionId) {
        return;
      }

      const response = params.response as CdpParams | undefined;
      const requestId = String(params.requestId ?? "");

      if (response && requestId) {
        this.responses.set(requestId, {
          url: String(response.url ?? ""),
          status: Number(response.status ?? 0),
        });
      }
    });

    client.on("Network.loadingFailed", (params, eventSessionId) => {
      if (eventSessionId !== sessionId) {
        return;
      }

      this.failedRequests.push(
        `${String(params.errorText ?? "Network request failed")} (${String(params.requestId ?? "unknown")})`,
      );
    });
  }

  async initialize(): Promise<void> {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    await this.send("Log.enable");
  }

  async send<T extends CdpParams>(
    method: string,
    params: CdpParams = {},
  ): Promise<CdpResponse<T>> {
    return this.client.send<T>(method, params, this.sessionId);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{
      result?: CdpParams;
      exceptionDetails?: CdpParams;
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (response.exceptionDetails) {
      throw new Error(
        String(
          response.exceptionDetails.description ??
            response.exceptionDetails.text ??
            "Browser evaluation failed",
        ),
      );
    }

    return response.result?.value as T;
  }

  async navigate(url: string): Promise<void> {
    const loadEvent = this.client.waitFor("Page.loadEventFired", this.sessionId);
    const response = await this.send<{ errorText?: string }>("Page.navigate", {
      url,
    });

    if (response.errorText) {
      throw new Error(`Could not navigate to ${url}: ${response.errorText}`);
    }

    await loadEvent;
    await Bun.sleep(150);
  }

  async reload(): Promise<void> {
    const loadEvent = this.client.waitFor("Page.loadEventFired", this.sessionId);
    await this.send("Page.reload", { ignoreCache: true });
    await loadEvent;
    await Bun.sleep(150);
  }

  async setViewport(viewport: { width: number; height: number }): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  responseFor(url: string): { url: string; status: number } | undefined {
    return [...this.responses.values()].find((response) => response.url === url);
  }

  clearDiagnostics(): void {
    this.errors.length = 0;
    this.failedRequests.length = 0;
    this.responses.clear();
  }

  async screenshot(path: string): Promise<void> {
    const response = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    await Bun.write(path, Uint8Array.from(atob(response.data), (character) =>
      character.charCodeAt(0),
    ));
  }
}

type StaticServer = {
  origin: string;
  rootDirectory: string;
  process: Bun.Subprocess;
  stop: () => Promise<void>;
};

type Browser = {
  client: CdpClient;
  page: CdpPage;
  process: Bun.Subprocess;
  profileDirectory: string;
  targetId: string;
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
  const profileDirectory = await mkdtemp(join(tmpdir(), "anki-web-mcp-chrome-"));
  const port = await getFreePort();
  const browserProcess = Bun.spawn(
    [
      executable,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--disable-gpu-sandbox",
      "--in-process-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-allow-origins=*",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDirectory}`,
      "about:blank",
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  let client: CdpClient | undefined;

  try {
    client = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);

      if (!response.ok) {
        return false;
      }

      const version = (await response.json()) as {
        webSocketDebuggerUrl?: string;
      };

      if (!version.webSocketDebuggerUrl) {
        return false;
      }

      try {
        return await CdpClient.connect(version.webSocketDebuggerUrl);
      } catch {
        return false;
      }
    }, "Chromium DevTools WebSocket");

    const target = await client.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const attached = await client.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: target.targetId, flatten: true },
    );
    const page = new CdpPage(client, attached.sessionId);
    await page.initialize();

    return {
      client,
      page,
      process: browserProcess,
      profileDirectory,
      targetId: target.targetId,
      stop: async () => {
        try {
          await client?.send("Target.closeTarget", { targetId: target.targetId });
        } catch {
          // The browser may already have closed the target after a failure.
        }
        client?.close();
        browserProcess.kill();
        await browserProcess.exited;
        await rm(profileDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    client?.close();
    browserProcess.kill();
    await browserProcess.exited;
    await rm(profileDirectory, { recursive: true, force: true });
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

type VisibleResource = { kind: string; url: string };
type LinkDetails = {
  href: string;
  tabIndex: number;
  text: string;
  width: number;
  height: number;
};

async function assertLoadedResources(page: CdpPage): Promise<void> {
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

async function assertKeyboardNavigation(page: CdpPage, expectedHref: string): Promise<void> {
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

async function assertNoBrowserErrors(page: CdpPage): Promise<void> {
  assert(page.errors.length === 0, `Browser reported errors: ${page.errors.join(" | ")}`);
  assert(
    page.failedRequests.length === 0,
    `Browser reported failed requests: ${page.failedRequests.join(" | ")}`,
  );
}

async function verifyRootRoute(page: CdpPage, origin: string): Promise<void> {
  const url = `${origin}${basePath}/`;
  await assertApplicationDocument(url, "Static export harness");
  page.clearDiagnostics();
  await page.navigate(url);

  for (const reload of [false, true]) {
    if (reload) {
      page.clearDiagnostics();
      await page.reload();
    }

    const documentState = await page.evaluate<{ pathname: string; search: string; heading: string; capability: string | null }>(`({
      pathname: location.pathname,
      search: location.search,
      heading: document.querySelector('h1')?.textContent?.trim() ?? '',
      capability: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? null,
    })`);
    assert(documentState.pathname === `${basePath}/`, "Root navigation did not preserve the project base path");
    assert(documentState.search === "", "Root navigation unexpectedly changed the query string");
    assert(documentState.heading === "Static export harness", "Root heading was not rendered");
    assert(documentState.capability === "unavailable", "Root did not report absent native WebMCP");
    await assertLoadedResources(page);
    await assertKeyboardNavigation(page, `${origin}${basePath}/study/?deck=diagnostic`);
    await assertNoBrowserErrors(page);
  }
}

async function verifyStudyRoute(page: CdpPage, origin: string): Promise<void> {
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
    }>(`({
      pathname: location.pathname,
      search: location.search,
      heading: document.querySelector('h1')?.textContent?.trim() ?? '',
      deck: document.querySelector('.query-details dd code')?.textContent?.trim() ?? '',
      capability: document.querySelector('[data-webmcp-capability]')?.getAttribute('data-webmcp-capability') ?? null,
    })`);
    assert(documentState.pathname === `${basePath}/study/`, "Study navigation did not preserve the project base path");
    assert(documentState.search === "?deck=diagnostic", "Study reload did not preserve the deck query");
    assert(documentState.heading === "Study route diagnostics", "Study heading was not rendered");
    assert(documentState.deck === "diagnostic", "Study route did not render the deck query");
    assert(documentState.capability === "unavailable", "Study did not report absent native WebMCP");
    await assertLoadedResources(page);
    await assertKeyboardNavigation(page, `${origin}${basePath}/`);
    await assertNoBrowserErrors(page);
  }
}

async function verifyMobileRoutes(page: CdpPage, origin: string): Promise<void> {
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

async function writeFailureArtifacts(page: CdpPage | undefined, error: unknown): Promise<void> {
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

async function main(): Promise<void> {
  await runBuild();
  const staticServer = await startStaticServer();
  let browser: Browser | undefined;

  try {
    browser = await startBrowser();
    await browser.page.setViewport(desktopViewport);
    await verifyRootRoute(browser.page, staticServer.origin);
    await verifyStudyRoute(browser.page, staticServer.origin);
    await verifyMobileRoutes(browser.page, staticServer.origin);
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
