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

async function verifyRootRoute(page: BrowserPage, origin: string): Promise<void> {
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
