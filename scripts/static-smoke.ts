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
import {
  chromium,
  type BrowserContext,
  type Page as PlaywrightPage,
} from "playwright-core";

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

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).click();
  }

  async press(selector: string, key: string): Promise<void> {
    await this.page.locator(selector).press(key);
  }

  async waitForUrl(url: string): Promise<void> {
    await this.page.waitForURL(url);
  }

  responseFor(url: string): { url: string; status: number } | undefined {
    return this.responses.get(url);
  }

  clearDiagnostics(): void {
    this.errors.length = 0;
    this.failedRequests.length = 0;
    this.responses.clear();
  }

  clearErrors(): void {
    this.errors.length = 0;
    this.failedRequests.length = 0;
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
  newIsolatedPage: () => Promise<BrowserPage>;
  saveTrace: (path: string) => Promise<void>;
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
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await createBrowserPage(context);
    let isolatedContext: BrowserContext | undefined;
    let traceSaved = false;

    return {
      page,
      version: browser.version(),
      newIsolatedPage: async () => {
        isolatedContext = await browser.newContext({ viewport: desktopViewport });
        await isolatedContext.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
        return createBrowserPage(isolatedContext);
      },
      saveTrace: async (path) => {
        if (!traceSaved) {
          await (isolatedContext ?? context).tracing.stop({ path });
          traceSaved = true;
        }
      },
      stop: async () => {
        if (!traceSaved || isolatedContext) {
          await context.tracing.stop().catch(() => undefined);
        }
        if (isolatedContext && !traceSaved) {
          await isolatedContext.tracing.stop().catch(() => undefined);
        }
        await browser.close();
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function createBrowserPage(context: BrowserContext): Promise<BrowserPage> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason instanceof Error
        ? event.reason.message
        : String(event.reason);
      console.error(`unhandledrejection: ${reason}`);
    });
  });
  return new BrowserPage(page);
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
  const unexpectedFailedRequests = page.failedRequests.filter((failure) => {
    // Next can prefetch the app chunk for the route we are leaving. Chromium
    // reports the superseded prefetch as ERR_ABORTED even though the current
    // document loaded the same chunk successfully; assertLoadedResources
    // below still verifies every resource used by the visible document.
    const isSupersededNextPrefetch = failure.startsWith("net::ERR_ABORTED") &&
      (failure.includes("/_next/static/chunks/app/") || /[?&]_rsc=/.test(failure));
    return !isSupersededNextPrefetch;
  });
  assert(
    unexpectedFailedRequests.length === 0,
    `Browser reported failed requests: ${unexpectedFailedRequests.join(" | ")}`,
  );
}

type PersistenceDomState = {
  status: string;
  deckId: string;
  cardCount: number;
  scheduleCount: number;
  sessionCount: number;
  reviewLogCount: number;
  activeSessionId: string | null;
  probeStatus: string;
  pathname: string;
  search: string;
  requestedDeckId: string | null;
};

async function readPersistenceState(page: BrowserPage): Promise<PersistenceDomState> {
  return page.evaluate<PersistenceDomState>(`(() => {
    const persistence = document.querySelector('[data-persistence-status]');
    const records = document.querySelector('[data-persistence-records]');
    const activeSessionText = persistence?.querySelector('[data-persistence-active-session-id]')?.textContent?.trim() ?? '';
    const readNumber = (name) => Number(records?.querySelector('[data-' + name + ']')?.getAttribute('data-' + name) ?? '-1');
    return {
      status: persistence?.getAttribute('data-persistence-status') ?? 'missing',
      deckId: persistence?.querySelector('[data-persistence-seed-deck-id]')?.getAttribute('data-persistence-seed-deck-id') ?? '',
      cardCount: readNumber('persistence-card-count'),
      scheduleCount: readNumber('persistence-schedule-count'),
      sessionCount: readNumber('persistence-session-count'),
      reviewLogCount: readNumber('persistence-review-log-count'),
      activeSessionId: activeSessionText && activeSessionText !== 'none' ? activeSessionText : null,
      probeStatus: persistence?.querySelector('[data-persistence-probe]')?.getAttribute('data-persistence-probe-status') ?? 'missing',
      pathname: location.pathname,
      search: location.search,
      requestedDeckId: persistence?.querySelector('[data-persistence-requested-deck-id]')?.textContent?.trim() || null,
    };
  })()`);
}

async function waitForPersistenceReady(page: BrowserPage): Promise<PersistenceDomState> {
  return waitFor(
    async () => {
      const state = await readPersistenceState(page);
      return state.status === "ready" ? state : false;
    },
    "IndexedDB persistence initialization",
  );
}

function assertDurableState(
  actual: PersistenceDomState,
  expected: PersistenceDomState,
  description: string,
): void {
  assert(actual.deckId === expected.deckId, `${description} changed the seed deck ID`);
  assert(actual.cardCount === expected.cardCount, `${description} changed the card count`);
  assert(actual.scheduleCount === expected.scheduleCount, `${description} changed the schedule count`);
  assert(actual.sessionCount === expected.sessionCount, `${description} changed the session count`);
  assert(actual.reviewLogCount === expected.reviewLogCount, `${description} changed the review-log count`);
}

async function verifyPersistenceRoutes(browser: Browser, origin: string): Promise<void> {
  const page = await browser.newIsolatedPage();
  const rootUrl = `${origin}${basePath}/`;

  const freshContext = await page.evaluate<boolean>("location.href === 'about:blank'");
  assert(freshContext, "Persistence browser context was not a fresh about:blank context");

  page.clearDiagnostics();
  await page.navigate(rootUrl);
  const initial = await waitForPersistenceReady(page);
  assert(initial.deckId === "seed-spanish-basics", "Fresh browser did not expose the Spanish Basics deck");
  assert(initial.cardCount >= 20, "Fresh browser seed contains fewer than 20 cards");
  assert(initial.scheduleCount === initial.cardCount, "Fresh browser seed schedules do not match cards");
  assert(initial.sessionCount === 0, "Fresh browser unexpectedly contains a session");
  assert(initial.reviewLogCount === 0, "Fresh browser unexpectedly contains a review log");

  await page.click('[data-persistence-probe="write"]');
  const committed = await waitFor(
    async () => {
      const state = await readPersistenceState(page);
      return state.probeStatus === "complete" && state.sessionCount === 1 && state.reviewLogCount === 1
        ? state
        : false;
    },
    "the representative study transaction",
  );
  assert(committed.activeSessionId !== null, "Study write did not set the optional active-session pointer");

  page.clearDiagnostics();
  await page.reload();
  const afterReload = await waitForPersistenceReady(page);
  assertDurableState(afterReload, committed, "Reload");
  assert(afterReload.activeSessionId === committed.activeSessionId, "Reload changed the active-session pointer");

  const studyUrl = `${origin}${basePath}/study/?deck=${encodeURIComponent(committed.deckId)}`;
  page.clearDiagnostics();
  await page.navigate(studyUrl);
  const studyState = await waitForPersistenceReady(page);
  assert(studyState.pathname === `${basePath}/study/`, "Study navigation did not preserve the project base path");
  assert(studyState.search === `?deck=${committed.deckId}`, "Study navigation did not preserve the seed deck query");
  assert(studyState.requestedDeckId === committed.deckId, "Study page did not expose the requested seed deck");
  assertDurableState(studyState, committed, "Study navigation");

  page.clearDiagnostics();
  await page.navigate(rootUrl);
  const backHome = await waitForPersistenceReady(page);
  assertDurableState(backHome, committed, "Return navigation");

  const pointerKey = "anki-web-mcp.active-session-id";
  const pointerBeforeChange = await page.evaluate<string | null>(
    `sessionStorage.getItem(${JSON.stringify(pointerKey)})`,
  );
  assert(pointerBeforeChange === committed.activeSessionId, "The active-session pointer was not stored as a session-only value");
  const initialSessionStorage = await page.evaluate<Array<[string, string | null]>>(
    "Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)])",
  );
  assert(
    initialSessionStorage.every(([key, value]) => key === pointerKey && value === pointerBeforeChange),
    "sessionStorage contains a durable record payload instead of only the active-session pointer",
  );

  await page.evaluate(
    `sessionStorage.setItem(${JSON.stringify(pointerKey)}, "changed-session-pointer")`,
  );
  page.clearDiagnostics();
  await page.reload();
  const changedPointer = await waitForPersistenceReady(page);
  assertDurableState(changedPointer, committed, "Changing sessionStorage");
  assert(changedPointer.activeSessionId === "changed-session-pointer", "Changed sessionStorage pointer was not isolated from durable records");
  const changedSessionStorage = await page.evaluate<Array<[string, string | null]>>(
    "Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)])",
  );
  assert(
    changedSessionStorage.length === 1
      && changedSessionStorage[0]?.[0] === pointerKey
      && changedSessionStorage[0]?.[1] === "changed-session-pointer",
    "Changing the session pointer introduced a non-pointer sessionStorage payload",
  );

  await page.evaluate(
    `sessionStorage.removeItem(${JSON.stringify(pointerKey)})`,
  );
  page.clearDiagnostics();
  await page.reload();
  const clearedPointer = await waitForPersistenceReady(page);
  assertDurableState(clearedPointer, committed, "Clearing sessionStorage");
  assert(clearedPointer.activeSessionId === null, "Clearing sessionStorage did not clear the optional pointer");
  const clearedSessionStorage = await page.evaluate<string[]>("Object.keys(sessionStorage)");
  assert(clearedSessionStorage.length === 0, "Clearing the optional pointer left a sessionStorage payload");
  await assertNoBrowserErrors(page);
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

async function assertProductionShell(page: BrowserPage): Promise<void> {
  const shell = await page.evaluate<{
    background: string;
    contentWidth: number;
    contentMarginLeft: number;
    viewportWidth: number;
  }>(`(() => {
    const shell = document.querySelector('[data-production-shell]');
    const content = document.querySelector('[data-shell-content]');
    if (!shell || !content) {
      return { background: '', contentWidth: 0, contentMarginLeft: 0, viewportWidth: window.innerWidth };
    }
    const contentRect = content.getBoundingClientRect();
    return {
      background: getComputedStyle(shell).backgroundColor,
      contentWidth: contentRect.width,
      contentMarginLeft: contentRect.left,
      viewportWidth: window.innerWidth,
    };
  })()`);

  assert(
    shell.background !== "rgba(0, 0, 0, 0)" && shell.background !== "transparent",
    "The production shell did not apply a neutral background",
  );
  assert(shell.contentWidth > 0, "The production shell content is not visible");
  assert(
    shell.contentWidth <= Math.min(shell.viewportWidth, 1216),
    "The production shell content exceeded its responsive maximum width",
  );
  assert(shell.contentMarginLeft >= 0, "The production shell content moved outside the viewport");
}

async function verifyRootRoute(
  page: BrowserPage,
  origin: string,
  browserVersion: string,
): Promise<RootWebMcpEvidence> {
  const url = `${origin}${basePath}/`;
  await assertApplicationDocument(url, "Your Decks");
  await assertApplicationDocument(url, "Static export harness");
  await assertOriginTrialDeliveredInHead(url);
  page.clearDiagnostics();
  await page.navigate(url);
  await assertProductionShell(page);

  const deckHome = await page.evaluate<{
    deckCount: number;
    hasSpanishBasics: boolean;
    hasDiagnostics: boolean;
  }>(`({
    deckCount: document.querySelectorAll('[data-deck-row]').length,
    hasSpanishBasics: Boolean(document.querySelector('[data-deck-row][data-deck-id="seed-spanish-basics"]')),
    hasDiagnostics: Boolean(document.querySelector('[data-phase0-diagnostics]')),
  })`);
  assert(deckHome.deckCount === 1, "Root did not render the persisted seed deck");
  assert(deckHome.hasSpanishBasics, "Root did not render Spanish Basics from IndexedDB");
  assert(deckHome.hasDiagnostics, "Root did not retain the Phase 0 diagnostics region");

  await page.click('[data-deck-action="import"]');
  const importFeedback = await page.evaluate<string>(
    `document.querySelector('[role="status"]')?.textContent?.trim() ?? ''`,
  );
  assert(
    importFeedback.includes("not available in this release"),
    "Import did not expose truthful availability guidance",
  );
  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="remove"]');
  const removeFeedback = await page.evaluate<{ text: string; deckCount: number }>(`({
    text: Array.from(document.querySelectorAll('[role="status"]')).map((element) => element.textContent ?? '').find((text) => text.includes('Deck removal')) ?? '',
    deckCount: document.querySelectorAll('[data-deck-row]').length,
  })`);
  assert(removeFeedback.text.includes("not available in this release"), "Remove did not expose truthful availability guidance");
  assert(removeFeedback.deckCount === 1, "Unavailable remove changed the persisted deck list");

  await page.evaluate<void>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('schedules', 'readwrite');
      const store = transaction.objectStore('schedules');
      const get = store.get('seed-spanish-basics-card-hola');
      get.onerror = () => reject(get.error);
      get.onsuccess = () => store.put({ ...get.result, suspended: true });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
  page.clearDiagnostics();
  await page.reload();
  await waitFor(
    async () => page.evaluate<string>(
      `document.querySelector('[data-deck-action="restore-suspended"]')?.textContent?.trim() ?? ''`,
    ).then((text) => text.includes("Restore suspended cards") ? text : false),
    "the durable suspended-card home action",
  );
  await page.click('[data-deck-action="restore-suspended"]');
  const restoreFeedback = await waitFor(
    async () => page.evaluate<{ text: string; row: string; hasRestore: boolean }>(`({
      text: Array.from(document.querySelectorAll('[role="status"]')).map((element) => element.textContent ?? '').find((text) => text.includes('Restored 1 suspended card')) ?? '',
      row: document.querySelector('[data-deck-row][data-deck-id="seed-spanish-basics"]')?.textContent ?? '',
      hasRestore: Boolean(document.querySelector('[data-deck-action="restore-suspended"]')),
    })`).then((state) => state.text ? state : false),
    "the committed suspended-card restoration",
  );
  assert(restoreFeedback.row.includes("0 suspended"), "Restore did not refresh the visible suspended count");
  assert(!restoreFeedback.hasRestore, "Restore action remained visible after the committed restore");

  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await page.waitForUrl(`${origin}${basePath}/study/?deck=seed-spanish-basics`);
  await page.navigate(url);
  page.clearErrors();
  let evidence: RootWebMcpEvidence | undefined;

  for (const reload of [false, true]) {
    if (reload) {
      page.clearDiagnostics();
      await page.reload();
    }

    await waitForPersistenceReady(page);
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
      state: string | null;
    }>(`({
      pathname: location.pathname,
      search: location.search,
      heading: document.querySelector('[data-deck-header] h1')?.textContent?.trim() ?? '',
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
      state: document.querySelector('[data-deck-page-state]')?.getAttribute('data-deck-page-state') ?? null,
    })`);
    assert(documentState.pathname === `${basePath}/`, "Root navigation did not preserve the project base path");
    assert(documentState.search === "", "Root navigation unexpectedly changed the query string");
    assert(documentState.heading === "Your Decks", "Production deck heading was not rendered");
    assert(documentState.state === "populated", "Root did not render the populated deck state");
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

async function verifyStudyRoute(browser: Browser, origin: string): Promise<void> {
  const page = await browser.newIsolatedPage();
  const url = `${origin}${basePath}/study/?deck=seed-spanish-basics`;
  await assertApplicationDocument(url, "Loading your study");
  await page.navigate(`${origin}${basePath}/`);
  await waitFor(
    async () => page.evaluate<number>("document.querySelectorAll('[data-deck-row]').length")
      .then((count) => count === 1 ? count : false),
    "the seeded deck before study hydration",
  );
  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await page.waitForUrl(url);
  await waitForStudyState(page, "active");

  const controlsBeforeReveal = await page.evaluate<{
    active: string | null;
    disabledRatings: number;
    diagnostic: boolean;
    heading: string;
    session: string;
    cardId: string;
    side: string;
    content: string;
  }>(`({
    active: document.querySelector('[data-study-state]')?.getAttribute('data-study-state') ?? null,
    disabledRatings: document.querySelectorAll('[data-study-action="rate"]:disabled').length,
    diagnostic: Boolean(document.querySelector('[data-phase0-diagnostics]')),
    heading: document.querySelector('[data-study-header] h1')?.textContent?.trim() ?? '',
    session: document.querySelector('[data-study-session]')?.textContent?.trim() ?? '',
    cardId: document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? '',
    side: document.querySelector('[data-flashcard-side]')?.textContent?.trim() ?? '',
    content: document.querySelector('[data-flashcard-content]')?.textContent?.trim() ?? '',
  })`);
  assert(controlsBeforeReveal.active === "active", "Study did not render the durable active state");
  assert(controlsBeforeReveal.disabledRatings === 4, "Study ratings were not disabled before reveal");
  assert(controlsBeforeReveal.diagnostic, "Study did not retain the Phase 0 diagnostics region");
  assert(controlsBeforeReveal.heading === "Spanish Basics", "Study did not render the persisted deck name");
  assert(controlsBeforeReveal.session.includes("Session 1"), "Study did not render the persisted session sequence");
  assert(controlsBeforeReveal.cardId === "seed-spanish-basics-card-hola", "Study did not render the persisted current card ID");
  assert(controlsBeforeReveal.side === "FRONT", "Study did not restore the persisted front side");
  assert(controlsBeforeReveal.content === "hola", "Study did not render the persisted front content");
  const bodyBeforeReveal = await page.evaluate<string>("document.querySelector('[data-production-study]')?.textContent ?? ''");
  assert(!bodyBeforeReveal.includes("hello"), "Front study state disclosed persisted back content");
  const desktopRatingColumns = await page.evaluate<number>(`(() => {
    const group = document.querySelector('[data-rating-group]');
    return group ? getComputedStyle(group).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
  })()`);
  assert(desktopRatingColumns === 4, "Desktop ratings did not remain in one horizontal row");

  await page.press('[data-rating-grid]', "Space");
  const revealed = await waitFor(
    async () => page.evaluate<{ side: string; enabledRatings: number; body: string; focus: string }>(`({
      side: document.querySelector('[data-flashcard-side]')?.textContent?.trim() ?? '',
      enabledRatings: document.querySelectorAll('[data-study-action="rate"]:not(:disabled)').length,
      body: document.querySelector('[data-production-study]')?.textContent ?? '',
      focus: document.activeElement?.getAttribute('data-study-rating') ?? '',
    })`).then((state) => state.side === "BACK" && state.focus === "again" ? state : false),
    "the persisted answer reveal",
  );
  assert(revealed.enabledRatings === 4, "Reveal did not enable all four rating actions");
  assert(revealed.body.includes("hello"), "Reveal did not show the persisted answer");

  await page.click('[data-study-rating="again"]');
  const rated = await waitFor(
    async () => page.evaluate<{ cardId: string; progress: string; side: string; error: string; focus: string }>(`({
      cardId: document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? '',
      progress: document.querySelector('[role="progressbar"]')?.getAttribute('aria-label') ?? '',
      side: document.querySelector('[data-flashcard-side]')?.textContent?.trim() ?? '',
      error: document.querySelector('[role="alert"]')?.textContent?.trim() ?? '',
      focus: document.activeElement?.getAttribute('data-study-action') ?? '',
    })`).then((state) => state.error || (
      state.cardId
      && state.cardId !== "seed-spanish-basics-card-hola"
      && state.focus === "toggle"
    ) ? state : false),
    "the committed Again transition",
  );
  assert(!rated.error, `Rating reported a recoverable error: ${rated.error}`);
  assert(rated.side === "FRONT", "Rating did not advance to the next card front");
  assert(rated.progress === "Study progress: 1 of 21", "Same-day requeue did not grow durable progress");

  page.clearDiagnostics();
  await page.reload();
  await waitForStudyState(page, "active");
  const documentState = await page.evaluate<{
    pathname: string;
    search: string;
    heading: string;
    state: string | null;
  }>(`({
    pathname: location.pathname,
    search: location.search,
    heading: document.querySelector('[data-study-header] h1')?.textContent?.trim() ?? '',
    state: document.querySelector('[data-study-state]')?.getAttribute('data-study-state') ?? null,
  })`);
  assert(documentState.pathname === `${basePath}/study/`, "Study navigation did not preserve the project base path");
  assert(documentState.search === "?deck=seed-spanish-basics", "Study reload did not preserve the deck query");
  assert(documentState.heading === "Spanish Basics", "Production study heading was not rendered");
  assert(documentState.state === "active", "Study did not restore the active state after reload");
  const resumedCardId = await page.evaluate<string>(
    "document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? ''",
  );
  assert(resumedCardId === rated.cardId, "Study reload did not resume the committed current card");
  await assertLoadedResources(page);
  const returnAction = await page.evaluate<{ tabIndex: number; width: number; height: number }>(`(() => {
    const button = document.querySelector('[data-study-action="return"]');
    const rect = button?.getBoundingClientRect();
    return { tabIndex: button?.tabIndex ?? -1, width: rect?.width ?? 0, height: rect?.height ?? 0 };
  })()`);
  assert(returnAction.tabIndex >= 0 && returnAction.width >= 44 && returnAction.height >= 44,
    "Study return action was not visibly keyboard operable");
  await page.click('[data-study-action="suspend"]');
  await waitFor(
    async () => page.evaluate<{ cardId: string; focus: string }>(`({
      cardId: document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? '',
      focus: document.activeElement?.getAttribute('data-study-action') ?? '',
    })`).then((state) => state.cardId && state.cardId !== resumedCardId && state.focus === "toggle" ? state : false),
    "the committed card suspension",
  );
  await page.press('[data-rating-grid]', "Escape");
  await page.waitForUrl(`${origin}${basePath}/`);
  await assertNoBrowserErrors(page);
}

async function waitForStudyState(page: BrowserPage, kind: string): Promise<void> {
  await waitFor(
    async () => page.evaluate<string>(
      "document.querySelector('[data-study-state]')?.getAttribute('data-study-state') ?? ''",
    ).then((value) => value === kind ? value : false),
    `the ${kind} study state`,
  );
}

async function verifyDeckRouteStates(browser: Browser, origin: string): Promise<void> {
  const url = `${origin}${basePath}/`;
  await assertApplicationDocument(url, "Loading your decks");

  const emptyPage = await browser.newIsolatedPage();
  await emptyPage.navigate(url);
  await waitFor(
    async () => emptyPage.evaluate<string>(
      "document.querySelector('[data-deck-page-state]')?.getAttribute('data-deck-page-state') ?? ''",
    ).then((state) => state === "populated" ? state : false),
    "the persisted deck home state",
  );
  await emptyPage.evaluate<void>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('decks', 'readwrite');
      transaction.objectStore('decks').delete('seed-spanish-basics');
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
  await emptyPage.reload();
  const empty = await waitFor(
    async () => emptyPage.evaluate<{ kind: string; body: string }>(`({
      kind: document.querySelector('[data-deck-page-state]')?.getAttribute('data-deck-page-state') ?? '',
      body: document.querySelector('[data-deck-page-state]')?.textContent ?? '',
    })`).then((state) => state.kind === "empty" ? state : false),
    "the durable empty deck state",
  );
  assert(empty.body.includes("No decks yet"), "Empty deck state omitted its heading");
  await assertNoBrowserErrors(emptyPage);

  const errorPage = await browser.newIsolatedPage();
  await errorPage.addInitScript(
    "Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });",
  );
  await errorPage.navigate(url);
  const failed = await waitFor(
    async () => errorPage.evaluate<{ kind: string; body: string }>(`({
      kind: document.querySelector('[data-deck-page-state]')?.getAttribute('data-deck-page-state') ?? '',
      body: document.querySelector('[data-deck-page-state]')?.textContent ?? '',
    })`).then((state) => state.kind === "error" ? state : false),
    "the recoverable deck storage error",
  );
  assert(failed.body.includes("Decks could not be loaded"), "Deck error state omitted its heading");
  assert(failed.body.includes("Try again"), "Deck error state omitted its retry action");
  await assertNoBrowserErrors(errorPage);
}

async function verifyStudyRouteStates(browser: Browser, origin: string): Promise<void> {
  const page = await browser.newIsolatedPage();
  const studyUrl = `${origin}${basePath}/study/?deck=seed-spanish-basics`;
  await page.navigate(`${origin}${basePath}/`);
  await waitFor(
    async () => page.evaluate<number>("document.querySelectorAll('[data-deck-row]').length")
      .then((count) => count === 1 ? count : false),
    "the study-state seed deck",
  );
  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await page.waitForUrl(studyUrl);
  await waitForStudyState(page, "active");

  await mutateCurrentStudySession(page, "back");
  await page.reload();
  await waitForStudyState(page, "active");
  const back = await readStudyPresentation(page);
  assert(back.side === "BACK", "Study did not restore the persisted back side");
  assert(back.body.includes("hello"), "Back study state omitted persisted back content");

  await mutateCurrentStudySession(page, "waiting");
  await page.reload();
  await waitForStudyState(page, "waiting");
  const waiting = await readStudyPresentation(page);
  assert(waiting.body.includes("Waiting for the next card"), "Waiting state omitted its heading");
  assert(waiting.body.includes("Next card in"), "Waiting state omitted its service-provided due time");
  assert(waiting.body.includes("not complete"), "Waiting state was presented as complete");
  assert(waiting.progress === "Study progress: 1 of 2", "Waiting state lost durable progress");

  await mutateCurrentStudySession(page, "completion");
  await page.reload();
  await waitForStudyState(page, "completion");
  const completion = await readStudyPresentation(page);
  assert(completion.body.includes("Study session complete"), "Completion state omitted its heading");
  assert(completion.body.includes("Reviews completed"), "Completion state omitted its statistics");
  assert(completion.body.includes("4"), "Completion state omitted its durable review count");

  const missingPage = await browser.newIsolatedPage();
  await missingPage.navigate(`${origin}${basePath}/study/?deck=does-not-exist`);
  await waitForStudyState(missingPage, "error");
  const missing = await readStudyPresentation(missingPage);
  assert(missing.body.includes("Deck unavailable"), "Missing-deck state omitted its distinct heading");
  assert(missing.body.includes("Return to decks"), "Missing-deck state omitted safe navigation");
  await assertNoBrowserErrors(missingPage);

  const emptyQueryPage = await browser.newIsolatedPage();
  await emptyQueryPage.navigate(`${origin}${basePath}/study/?deck=`);
  await waitForStudyState(emptyQueryPage, "error");
  const emptyQuery = await readStudyPresentation(emptyQueryPage);
  assert(emptyQuery.body.includes("deck query is empty"), "Empty deck query omitted its safe explanation");
  await assertNoBrowserErrors(emptyQueryPage);

  const caughtUpPage = await browser.newIsolatedPage();
  await caughtUpPage.navigate(`${origin}${basePath}/`);
  await waitFor(
    async () => caughtUpPage.evaluate<number>("document.querySelectorAll('[data-deck-row]').length")
      .then((count) => count === 1 ? count : false),
    "the caught-up seed deck",
  );
  await makeSeedDeckCaughtUp(caughtUpPage);
  await caughtUpPage.navigate(studyUrl);
  await waitForStudyState(caughtUpPage, "caught-up");
  const caughtUp = await readStudyPresentation(caughtUpPage);
  assert(caughtUp.body.includes("You are caught up"), "Caught-up state omitted its heading");
  assert(caughtUp.body.includes("no eligible cards"), "Caught-up state omitted its explanation");
  await assertNoBrowserErrors(caughtUpPage);

  const errorPage = await browser.newIsolatedPage();
  await errorPage.addInitScript(
    "Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });",
  );
  await errorPage.navigate(studyUrl);
  await waitForStudyState(errorPage, "error");
  const failed = await readStudyPresentation(errorPage);
  assert(failed.body.includes("Study could not be loaded"), "Study storage error omitted its heading");
  assert(failed.body.includes("Try again"), "Study storage error omitted its retry action");
  await assertNoBrowserErrors(errorPage);
}

async function readStudyPresentation(page: BrowserPage): Promise<{
  body: string;
  progress: string;
  side: string;
}> {
  return page.evaluate(`({
    body: document.querySelector('[data-production-study]')?.textContent ?? '',
    progress: document.querySelector('[role="progressbar"]')?.getAttribute('aria-label') ?? '',
    side: document.querySelector('[data-flashcard-side]')?.textContent?.trim() ?? '',
  })`);
}

async function mutateCurrentStudySession(
  page: BrowserPage,
  mode: "back" | "waiting" | "completion",
): Promise<void> {
  await page.evaluate<void>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('sessions', 'readwrite');
      const store = transaction.objectStore('sessions');
      const all = store.getAll();
      all.onerror = () => reject(all.error);
      all.onsuccess = () => {
        const current = all.result
          .filter((session) => session.deckId === 'seed-spanish-basics')
          .sort((left, right) => left.sequence - right.sequence).at(-1);
        if (!current) { reject(new Error('No current study session')); return; }
        const now = Date.now();
        const next = ${JSON.stringify(mode)} === 'back'
          ? { ...current, currentSide: 'back', updatedAt: now }
          : ${JSON.stringify(mode)} === 'waiting'
            ? {
                ...current,
                activeCardId: null,
                currentSide: 'front',
                completedPresentationCount: 1,
                plannedPresentationCount: 2,
                queueEntries: [{ cardId: current.queueEntries[0].cardId, dueAt: now + 60_000, ordinal: 2 }],
                updatedAt: now,
                completedAt: null,
              }
            : {
                ...current,
                activeCardId: null,
                currentSide: 'front',
                completedPresentationCount: 4,
                plannedPresentationCount: 4,
                queueEntries: [],
                ratingCounts: { again: 1, hard: 1, good: 1, easy: 1 },
                startedAt: now - 240_000,
                updatedAt: now,
                completedAt: now,
              };
        store.put(next);
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
}

async function makeSeedDeckCaughtUp(page: BrowserPage): Promise<void> {
  await page.evaluate<void>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['sessions', 'schedules'], 'readwrite');
      transaction.objectStore('sessions').clear();
      const schedules = transaction.objectStore('schedules');
      const cursor = schedules.openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        current.update({ ...current.value, state: 'review', dueAt: Date.now() + 86_400_000 });
        current.continue();
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
}

async function verifyMobileRoutes(browser: Browser, origin: string): Promise<void> {
  const page = await browser.newIsolatedPage();
  await page.setViewport(mobileViewport);

  await page.navigate(`${origin}${basePath}/`);
  await waitFor(
    async () => page.evaluate<number>("document.querySelectorAll('[data-deck-row]').length")
      .then((count) => count === 1 ? count : false),
    "the mobile seed deck",
  );
  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await page.waitForUrl(`${origin}${basePath}/study/?deck=seed-spanish-basics`);
  await waitForStudyState(page, "active");

  for (const route of [
    { name: "root", path: `${basePath}/`, expectedHref: `${origin}${basePath}/study/?deck=diagnostic` },
    { name: "study", path: `${basePath}/study/?deck=seed-spanish-basics`, expectedHref: `${origin}${basePath}/` },
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
    if (route.name === "root") {
      const deckCount = await page.evaluate<number>(`document.querySelectorAll('[data-deck-row]').length`);
      assert(deckCount === 1, "Mobile root did not render the populated deck surface");
    } else {
      const mobileRatingLayout = await page.evaluate<{ columns: number; touchTargets: boolean }>(`(() => {
        const group = document.querySelector('[data-rating-group]');
        const columns = group ? getComputedStyle(group).gridTemplateColumns.split(' ').length : 0;
        const touchTargets = Array.from(document.querySelectorAll('[data-study-action="rate"], [data-study-action="suspend"]'))
          .every((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          });
        return { columns, touchTargets };
      })()`);
      assert(mobileRatingLayout.columns === 2, "Mobile ratings did not use the 2x2 grid");
      assert(mobileRatingLayout.touchTargets, "Mobile study controls were smaller than 44px");
      const disabledRatings = await page.evaluate<number>(
        `document.querySelectorAll('[data-study-action="rate"]:disabled').length`,
      );
      assert(disabledRatings === 4, "Mobile ratings were not disabled before reveal");
    }
    if (route.name === "root") {
      await assertKeyboardNavigation(page, route.expectedHref);
    }
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

  await page.click('[data-study-header] [data-study-action="return"]');
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

async function writeFailureArtifacts(
  page: BrowserPage | undefined,
  browser: Browser | undefined,
  error: unknown,
): Promise<void> {
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

  await browser?.saveTrace(join(artifactsDirectory, "failure-trace.zip"));
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
    await verifyStudyRoute(browser, staticServer.origin);
    await verifyStudyRouteStates(browser, staticServer.origin);
    await verifyPersistenceRoutes(browser, staticServer.origin);
    await verifyDeckRouteStates(browser, staticServer.origin);
    await verifyMobileRoutes(browser, staticServer.origin);
    await verifyRootProbePresentationControls(browser.page, staticServer.origin);
    console.log("Static browser smoke tests passed for desktop and 320px Chromium.");
  } catch (error) {
    await writeFailureArtifacts(browser?.page, browser, error);
    throw error;
  } finally {
    if (browser) {
      await browser.stop();
    }
    await staticServer.stop();
  }
}

await main();
