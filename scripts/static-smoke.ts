import { createServer, type AddressInfo } from "node:net";
import {
  access,
  cp,
  readFile,
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
import {
  observeVisibleHomePage,
  type VisibleHomePageObservation,
} from "./webmcp-home-observation";
import {
  observeVisibleStudyCard,
  type VisibleStudyCardObservation,
} from "./webmcp-study-observation";

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

  async observeVisibleHomePage(): Promise<VisibleHomePageObservation> {
    return await this.page.evaluate(observeVisibleHomePage, undefined);
  }

  async observeVisibleStudyCard(): Promise<VisibleStudyCardObservation> {
    return await this.page.evaluate(observeVisibleStudyCard, undefined);
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

  async installClock(time: number): Promise<void> {
    await this.page.clock.install({ time });
  }

  async fastForward(milliseconds: number): Promise<void> {
    await this.page.clock.fastForward(milliseconds);
  }

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).click();
  }

  async chooseFile(selector: string, path: string): Promise<void> {
    const chooser = this.page.waitForEvent("filechooser");
    await this.page.locator(selector).click();
    await (await chooser).setFiles(path);
  }

  async setInputFile(selector: string, path: string): Promise<void> {
    await this.page.locator(selector).setInputFiles(path);
  }

  async dispatchFiles(
    selector: string,
    eventType: "dragenter" | "dragleave" | "drop",
    files: readonly { path: string; name?: string }[],
  ): Promise<void> {
    const payload = await Promise.all(files.map(async (file) => ({
      bytes: [...await readFile(file.path)],
      name: file.name ?? file.path.split(/[\\/]/).at(-1) ?? "fixture.apkg",
    })));
    await this.page.evaluate(
      ({ targetSelector, type, filePayload }) => {
        const target = document.querySelector(targetSelector);
        if (!target) throw new Error(`Missing drag target: ${targetSelector}`);
        const transfer = new DataTransfer();
        for (const file of filePayload) {
          transfer.items.add(new File(
            [new Uint8Array(file.bytes)],
            file.name,
            { type: "application/octet-stream" },
          ));
        }
        target.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }));
      },
      { targetSelector: selector, type: eventType, filePayload: payload },
    );
  }

  async dispatchTextDrag(selector: string): Promise<void> {
    await this.page.evaluate((targetSelector) => {
      const target = document.querySelector(targetSelector);
      if (!target) throw new Error(`Missing drag target: ${targetSelector}`);
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "not a file");
      target.dispatchEvent(new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
    }, selector);
  }

  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
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

async function assertStaticRouteIdentity(
  url: string,
  expectedRoute: "deck-home" | "study",
  forbiddenRoute: "deck-home" | "study",
): Promise<void> {
  const response = await fetch(url);
  const body = await response.text();
  const expectedMarker = `data-deployment-route="${expectedRoute}"`;
  const forbiddenMarker = `data-deployment-route="${forbiddenRoute}"`;
  const identityCount = body.match(/data-deployment-route=/g)?.length ?? 0;

  assert(response.status === 200, `${url} returned HTTP ${response.status}`);
  assert(
    body.includes(expectedMarker),
    `${url} did not contain route identity ${expectedRoute}`,
  );
  assert(
    !body.includes(forbiddenMarker),
    `${url} contained forbidden route identity ${forbiddenRoute}`,
  );
  assert(
    identityCount === 1,
    `${url} contained ${identityCount} route identities instead of exactly one`,
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

async function assertFreshSeedObservation(page: BrowserPage, width: number): Promise<void> {
  const observation = await page.observeVisibleHomePage();
  const normalizedRowText = await page.evaluate<string>(
    `document.querySelector('[data-deck-row][data-deck-id="seed-spanish-basics"]')?.textContent?.replace(/\\s+/g, '') ?? ''`,
  );
  assert(observation.state === "populated", `${width}px observer did not see populated state`);
  assert(observation.decks.length === 1, `${width}px observer did not bind exactly one deck row`);
  assert(
    JSON.stringify(observation.decks[0]) === JSON.stringify({
      id: "seed-spanish-basics",
      name: "Spanish Basics",
      card_count: 24,
      new_count: 24,
      due_count: 0,
      suspended_count: null,
      recovery_available: false,
      study_action: "start",
      study_keyboard_operable: true,
    }),
    `${width}px observer did not report the fresh seed counts from its deck row`,
  );
  assert(
    normalizedRowText.includes("24new•0due•24total"),
    `${width}px deck row did not expose the production no-whitespace bullet shape`,
  );

  await page.evaluate<void>(`(() => {
    const count = document.querySelector('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-count="due"]');
    if (count) count.textContent = '0due';
  })()`);
  const malformed = await page.observeVisibleHomePage();
  assert(
    malformed.decks[0]?.due_count === null && malformed.decks[0]?.card_count === 24 &&
      malformed.decks[0]?.new_count === 24,
    `${width}px observer accepted a concatenated due label or coupled independent counts`,
  );
  await page.evaluate<void>(`(() => {
    const count = document.querySelector('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-count="due"]');
    if (count) count.textContent = '0 due';
  })()`);
}

async function verifyRootRoute(
  page: BrowserPage,
  origin: string,
  browserVersion: string,
): Promise<RootWebMcpEvidence> {
  const url = `${origin}${basePath}/`;
  await assertStaticRouteIdentity(url, "deck-home", "study");
  await assertApplicationDocument(url, "Anki Decks");
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
  assert(!deckHome.hasDiagnostics, "Root still exposed the Phase 0 diagnostics region");
  await assertFreshSeedObservation(page, desktopViewport.width);

  const importIntake = await page.evaluate<{
    accept: string | null;
    inputCount: number;
    actionsTargetInput: boolean;
  }>(`(() => {
    const input = document.querySelector('[data-deck-import-input]');
    const actions = Array.from(document.querySelectorAll('[data-deck-action^="import"]'));
    return {
      accept: input?.getAttribute('accept') ?? null,
      inputCount: document.querySelectorAll('[data-deck-import-input]').length,
      actionsTargetInput: Boolean(input?.id)
        && actions.length > 0
        && actions.every((action) => action.getAttribute('aria-controls') === input.id),
    };
  })()`);
  assert(importIntake.inputCount === 1, "Root did not expose one shared import input");
  assert(importIntake.accept === ".apkg", "Import input did not restrict the chooser to .apkg");
  assert(
    importIntake.actionsTargetInput,
    "Visible import actions did not target the shared chooser",
  );
  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="remove"]');
  await waitForRemovalDialog(page, "ready");
  const safeRemovalFocus = await page.evaluate<string>(
    "document.activeElement?.getAttribute('data-deck-action') ?? ''",
  );
  assert(safeRemovalFocus === "cancel-removal", "Removal dialog did not focus Cancel first");
  await page.click('[data-deck-action="cancel-removal"]');
  assert((await waitForDeckRows(page, 1)).length === 1, "Cancelled removal changed the deck list");

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
  const suspendedObservation = await page.observeVisibleHomePage();
  assert(
    suspendedObservation.decks[0]?.card_count === 24 &&
      suspendedObservation.decks[0]?.new_count === 23 &&
      suspendedObservation.decks[0]?.due_count === 0 &&
      suspendedObservation.decks[0]?.suspended_count === null &&
      suspendedObservation.decks[0]?.recovery_available === true,
    "Suspension did not preserve independent visible counts and recovery semantics",
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
  assert(!restoreFeedback.hasRestore, "Restore action remained visible after the committed restore");
  const restoredObservation = await page.observeVisibleHomePage();
  assert(
    restoredObservation.decks[0]?.card_count === 24 &&
      restoredObservation.decks[0]?.new_count === 24 &&
      restoredObservation.decks[0]?.due_count === 0 &&
      restoredObservation.decks[0]?.suspended_count === null &&
      restoredObservation.decks[0]?.recovery_available === false,
    "Restoration did not restore independent visible counts or remove recovery",
  );

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

    await waitFor(
      async () => page.evaluate<string>(
        `document.querySelector('[data-deck-page-state]')?.getAttribute('data-deck-page-state') ?? ''`,
      ).then((state) => state === "populated" ? state : false),
      "the populated production deck state",
    );
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
      statusText: document.querySelector('[data-webmcp-capability] [role="status"]')?.textContent?.trim() ?? '',
      state: document.querySelector('[data-deck-page-state]')?.getAttribute('data-deck-page-state') ?? null,
    })`);
    assert(documentState.pathname === `${basePath}/`, "Root navigation did not preserve the project base path");
    assert(documentState.search === "", "Root navigation unexpectedly changed the query string");
    assert(documentState.heading === "Anki Decks", "Production deck heading was not rendered");
    assert(documentState.state === "populated", "Root did not render the populated deck state");
    assert(documentState.capability === null, "Root still rendered the removed WebMCP diagnostics");
    assert(documentState.runtimeMode === null, "Root still rendered the removed runtime diagnostics");
    assert(documentState.context === null, "Root still rendered the removed context diagnostics");
    assert(documentState.permissionsPolicy === null, "Root still rendered the removed Permissions Policy diagnostics");
    assert(documentState.failureCode === null, "Root still rendered the removed failure diagnostics");
    assert(documentState.originTrial === null, "Root still rendered the removed origin-trial diagnostics");
    assert(documentState.originTrialMetaLength > 0, "Root did not deliver an origin-trial token in the document head");
    assert(Number.isNaN(documentState.counter), "Unavailable root exposed the removed diagnostic counter");
    assert(documentState.toolName === null, "Unavailable root exposed a diagnostic tool name");
    assert(documentState.statusText === "", "Root still rendered removed diagnostic status text");
    await assertLoadedResources(page);
    await assertNoBrowserErrors(page);

    evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      browser: { engine: "Chromium", version: browserVersion },
      url,
      runtimeMode: "unavailable",
      originTrial: "unknown",
      context: "secure-non-production",
      permissionsPolicy: "unknown",
      failureCode: "native-unavailable",
      originTrialMetaPresent: documentState.originTrialMetaLength > 0,
      counter: 0,
      toolName: documentState.toolName,
      reloadVerified: reload,
    };
  }

  if (!evidence) {
    throw new Error("Root WebMCP evidence was not captured");
  }
  return evidence;
}

type ImportDurableState = {
  readonly imports: number;
  readonly decks: number;
  readonly notes: number;
  readonly cards: number;
  readonly schedules: number;
  readonly media: number;
};

const importFixtures = resolve(
  projectRoot,
  "spikes",
  "apkg-compatibility",
  "fixtures",
  "synthetic",
);

async function waitForDeckRows(page: BrowserPage, count: number): Promise<string[]> {
  return waitFor(
    async () => page.evaluate<string[]>(`Array.from(document.querySelectorAll('[data-deck-row]')).map((row) => row.textContent?.replace(/\\s+/g, ' ').trim() ?? '')`)
      .then((rows) => rows.length === count ? rows : false),
    `${count} visible deck rows`,
    30_000,
  );
}

async function waitForImportResult(page: BrowserPage, result: string): Promise<string> {
  return waitFor(
    async () => page.evaluate<string>(`document.querySelector('[data-import-result="${result}"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`)
      .then((text) => text ? text : false),
    `the ${result} import report`,
    30_000,
  );
}

type RemovalGraphState = {
  readonly counts: Record<string, number>;
  readonly decks: readonly { id: string; importId: string; name: string }[];
  readonly cards: readonly {
    id: string;
    deckId: string;
    noteId: string;
    mediaRefs: readonly string[];
  }[];
  readonly notes: readonly { id: string; importId: string }[];
  readonly media: readonly { importId: string; name: string }[];
  readonly sessions: readonly { id: string; deckId: string }[];
  readonly seedInstalled: unknown;
  readonly activeSessionId: string | null;
};

const removalBoundaryFailures = [
  "read:imports", "read:decks", "read:notes", "read:cards",
  "read:schedules", "read:sessions", "read:reviewLogs", "read:media",
  "delete:imports", "delete:decks", "delete:notes", "delete:cards",
  "delete:schedules", "delete:sessions", "delete:reviewLogs", "delete:media",
  "transaction-abort",
] as const;

async function readRemovalGraph(page: BrowserPage): Promise<RemovalGraphState> {
  return page.evaluate<RemovalGraphState>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const names = ['imports', 'decks', 'notes', 'cards', 'schedules', 'sessions', 'reviewLogs', 'media', 'meta'];
      const transaction = database.transaction(names, 'readonly');
      const records = {};
      for (const name of names) {
        const getAll = transaction.objectStore(name).getAll();
        getAll.onsuccess = () => { records[name] = getAll.result; };
      }
      transaction.oncomplete = () => {
        database.close();
        const selected = {
          counts: Object.fromEntries(names.map((name) => [name, records[name].length])),
          decks: records.decks.map(({ id, importId, name }) => ({ id, importId, name })),
          cards: records.cards.map(({ id, deckId, noteId, mediaRefs }) => ({ id, deckId, noteId, mediaRefs })),
          notes: records.notes.map(({ id, importId }) => ({ id, importId })),
          media: records.media.map(({ importId, name }) => ({ importId, name })),
          sessions: records.sessions.map(({ id, deckId }) => ({ id, deckId })),
          seedInstalled: records.meta.find((record) => record.key === 'seedInstalled')?.value,
          activeSessionId: sessionStorage.getItem('anki-web-mcp.active-session-id'),
        };
        resolve(selected);
      };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
}

async function installRemovalFixture(
  page: BrowserPage,
  includeSiblingSentinels: boolean,
): Promise<void> {
  await page.evaluate<void>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const names = ['imports', 'decks', 'notes', 'cards', 'schedules', 'sessions', 'reviewLogs', 'media'];
      const transaction = database.transaction(names, 'readwrite');
      const now = 1_700_000_000_000;
      const schedule = (cardId, deckId) => ({
        cardId, deckId, dueAt: now, stability: 0, difficulty: 0,
        elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0,
        state: 'new', lastReviewAt: null, suspended: false,
      });
      const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
      stores.imports.add({
        id: 'single-removal-import', sha256: 'single-removal-sha', fileName: 'single.apkg',
        fileSize: 128, packageVersion: '2', importedAt: now, warnings: [],
      });
      stores.decks.add({
        id: 'single-removal-deck', importId: 'single-removal-import', sourceDeckId: '1',
        name: 'Single Import Removal', cardCount: 1, createdAt: now, lastStudiedAt: now,
        sessionIntakeLimit: 20, schedulerConfigId: 'default',
      });
      stores.notes.add({
        id: 'single-removal-note', importId: 'single-removal-import', sourceNoteId: '1',
        guid: 'single-removal-guid', modelId: '1', fields: { Front: 'Front', Back: 'Back' }, tags: [],
      });
      stores.cards.add({
        id: 'single-removal-card', deckId: 'single-removal-deck', noteId: 'single-removal-note',
        sourceCardId: '1', templateOrdinal: 0, frontText: 'Front', backText: 'Back', css: '',
        frontHtml: 'Front', backHtml: 'Back', mediaRefs: ['single-removal-import/media/only.png'],
        creationOrder: 1, contentWarnings: [],
      });
      stores.schedules.add(schedule('single-removal-card', 'single-removal-deck'));
      stores.sessions.add({
        id: 'single-removal-session', deckId: 'single-removal-deck', dayKey: '2026-09-02',
        sequence: 1, intakeLimit: 20, nextDayAt: now + 86_400_000,
        queueEntries: [{ cardId: 'single-removal-card', dueAt: now, ordinal: 0 }],
        activeCardId: 'single-removal-card', plannedPresentationCount: 1,
        completedPresentationCount: 0, currentSide: 'front',
        ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
        startedAt: now, updatedAt: now, completedAt: null, lastCommandIds: [],
      });
      stores.reviewLogs.add({
        id: 'single-removal-log', sessionId: 'single-removal-session',
        deckId: 'single-removal-deck', cardId: 'single-removal-card', rating: 'good',
        reviewedAt: now, durationMs: 100,
        before: schedule('single-removal-card', 'single-removal-deck'),
        after: { ...schedule('single-removal-card', 'single-removal-deck'), reps: 1 },
      });
      stores.media.add({
        importId: 'single-removal-import', name: 'only.png', blob: new Blob(['only']),
        mimeType: 'image/png', byteLength: 4, sha256: 'single-media-sha',
      });

      if (${includeSiblingSentinels}) {
        stores.imports.add({
          id: 'sibling-sentinel-import', sha256: 'sibling-sentinel-sha', fileName: 'siblings.apkg',
          fileSize: 256, packageVersion: '2', importedAt: now, warnings: [],
        });
        for (const [id, name] of [['sibling-sentinel-a', 'Sibling Sentinel A'], ['sibling-sentinel-b', 'Sibling Sentinel B']]) {
          stores.decks.add({
            id, importId: 'sibling-sentinel-import', sourceDeckId: id, name, cardCount: 1,
            createdAt: now, lastStudiedAt: null, sessionIntakeLimit: 20, schedulerConfigId: 'default',
          });
          stores.cards.add({
            id: id + '-card', deckId: id, noteId: 'sibling-sentinel-note', sourceCardId: id,
            templateOrdinal: 0, frontText: name, backText: 'Shared', css: '',
            frontHtml: name, backHtml: 'Shared',
            mediaRefs: ['sibling-sentinel-import/media/shared.png'], creationOrder: 1,
            contentWarnings: [],
          });
          stores.schedules.add(schedule(id + '-card', id));
        }
        stores.notes.add({
          id: 'sibling-sentinel-note', importId: 'sibling-sentinel-import', sourceNoteId: 'shared',
          guid: 'sibling-sentinel-guid', modelId: '1', fields: { Front: 'Shared', Back: 'Shared' }, tags: [],
        });
        stores.media.add({
          importId: 'sibling-sentinel-import', name: 'shared.png', blob: new Blob(['shared']),
          mimeType: 'image/png', byteLength: 6, sha256: 'sibling-media-sha',
        });
      }
      transaction.oncomplete = () => {
        database.close();
        sessionStorage.setItem('anki-web-mcp.active-session-id', 'single-removal-session');
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    };
  })`);
}

async function installOneShotRemovalBoundaryFailure(
  page: BrowserPage,
  boundary: (typeof removalBoundaryFailures)[number],
): Promise<void> {
  const [operation, storeName] = boundary.split(":");
  await page.evaluate<void>(`(() => {
    const operation = ${JSON.stringify(operation)};
    const storeName = ${JSON.stringify(storeName ?? "imports")};
    if (operation === 'read') {
      const original = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function(...args) {
        if (this.transaction.mode === 'readwrite' && this.name === storeName) {
          IDBObjectStore.prototype.getAll = original;
          throw new DOMException('Injected raw read failure', 'UnknownError');
        }
        return original.apply(this, args);
      };
      return;
    }
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function(...args) {
      if (this.transaction.mode === 'readwrite' && this.name === storeName) {
        IDBObjectStore.prototype.delete = original;
        if (operation === 'transaction-abort') {
          const transaction = this.transaction;
          const request = original.apply(this, args);
          request.addEventListener('success', () => transaction.abort(), { once: true });
          return request;
        }
        throw new DOMException('Injected raw delete failure', 'UnknownError');
      }
      return original.apply(this, args);
    };
  })()`);
}

async function waitForRemovalDialog(
  page: BrowserPage,
  state: "ready" | "commit-error" | "success",
): Promise<string> {
  return waitFor(
    async () => page.evaluate<string>(`document.querySelector('[data-deck-removal-dialog="${state}"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`)
      .then((text) => text ? text : false),
    `the ${state} deck removal dialog`,
    30_000,
  );
}

async function requestRemoval(page: BrowserPage, deckId: string): Promise<string> {
  await page.click(`[data-deck-row][data-deck-id="${deckId}"] [data-deck-action="remove"]`);
  return waitForRemovalDialog(page, "ready");
}

async function confirmRemoval(page: BrowserPage): Promise<string> {
  await page.click('[data-deck-action="confirm-removal"]');
  return waitForRemovalDialog(page, "success");
}

async function assertRemovalLayout(page: BrowserPage, expectedWidth: number): Promise<void> {
  const layout = await page.evaluate<{
    width: number;
    scrollWidth: number;
    clientWidth: number;
    dialogVisible: boolean;
  }>(`(() => {
    const dialog = document.querySelector('[data-deck-removal-dialog]');
    const rect = dialog?.getBoundingClientRect();
    return {
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      dialogVisible: Boolean(rect && rect.width > 0 && rect.height > 0),
    };
  })()`);
  assert(layout.width === expectedWidth, `Removal journey did not use the ${expectedWidth}px viewport`);
  assert(layout.scrollWidth <= layout.clientWidth, `Removal UI overflows at ${expectedWidth}px`);
  assert(layout.dialogVisible, `Removal dialog is obscured at ${expectedWidth}px`);
}

async function readImportDurableState(page: BrowserPage): Promise<ImportDurableState> {
  return page.evaluate<ImportDurableState>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const names = ['imports', 'decks', 'notes', 'cards', 'schedules', 'media'];
      const transaction = database.transaction(names, 'readonly');
      const counts = {};
      for (const name of names) {
        const count = transaction.objectStore(name).count();
        count.onsuccess = () => { counts[name] = count.result; };
      }
      transaction.oncomplete = () => { database.close(); resolve(counts); };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
}

async function observeImportPresentation(page: BrowserPage): Promise<void> {
  await page.evaluate<void>(`(() => {
    const evidence = { stages: [], texts: [], commitCancelDisabled: false };
    window.__importUiEvidence = evidence;
    const sample = () => {
      const panel = document.querySelector('[data-import-progress]');
      const stage = panel?.getAttribute('data-import-progress');
      const text = document.querySelector('[data-import-progress-text]')?.textContent?.trim();
      if (stage && !evidence.stages.includes(stage)) evidence.stages.push(stage);
      if (text && !evidence.texts.includes(text)) evidence.texts.push(text);
      if (stage === 'committing') {
        const cancel = document.querySelector('[data-deck-action="cancel-import"]');
        evidence.commitCancelDisabled = cancel instanceof HTMLButtonElement && cancel.disabled;
      }
    };
    new MutationObserver(sample).observe(document.body, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    sample();
  })()`);
}

async function installOneShotImportWriteFailure(
  page: BrowserPage,
  storeName: "decks" | "notes",
): Promise<void> {
  await page.evaluate<void>(`(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    let armed = true;
    IDBObjectStore.prototype.add = function(value, key) {
      if (armed && this.name === '${storeName}') {
        armed = false;
        throw new DOMException('Injected browser storage failure', 'QuotaExceededError');
      }
      return originalAdd.call(this, value, key);
    };
  })()`);
}

async function installOneShotImportDeleteFailure(page: BrowserPage): Promise<void> {
  await page.evaluate<void>(`(() => {
    const originalDelete = IDBObjectStore.prototype.delete;
    let armed = true;
    IDBObjectStore.prototype.delete = function(key) {
      if (armed && this.name === 'schedules') {
        armed = false;
        throw new DOMException('Injected replacement failure', 'UnknownError');
      }
      return originalDelete.call(this, key);
    };
  })()`);
}

async function installSlowNextDigest(page: BrowserPage): Promise<void> {
  await page.evaluate<void>(`(() => {
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let delayed = false;
    crypto.subtle.digest = async (...args) => {
      if (!delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return originalDigest(...args);
    };
  })()`);
}

async function assertImportLayout(page: BrowserPage, expectedWidth: number): Promise<void> {
  const layout = await page.evaluate<{ width: number; scrollWidth: number; clientWidth: number; actionsVisible: boolean }>(`(() => {
    const actions = Array.from(document.querySelectorAll('[data-import-result] button, [data-import-duplicate-dialog] button'));
    return {
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      actionsVisible: actions.every((action) => {
        const rect = action.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
    };
  })()`);
  assert(layout.width === expectedWidth, `Import journey did not use the ${expectedWidth}px viewport`);
  assert(layout.scrollWidth <= layout.clientWidth, `Import UI overflows at ${expectedWidth}px`);
  assert(layout.actionsVisible, `An import action is obscured at ${expectedWidth}px`);
}

async function verifyProductionImportJourneys(browser: Browser, origin: string): Promise<void> {
  const url = `${origin}${basePath}/`;
  const legacyFixture = join(importFixtures, "legacy-anki2.apkg");
  const warningFixture = join(importFixtures, "sanitization-warning.apkg");
  const unsupportedFixture = join(importFixtures, "unknown-layout.apkg");
  const corruptFixture = join(importFixtures, "invalid-sqlite.apkg");

  const chooserPage = await browser.newIsolatedPage();
  await chooserPage.setViewport(desktopViewport);
  await chooserPage.navigate(url);
  await waitForDeckRows(chooserPage, 1);
  await observeImportPresentation(chooserPage);
  await chooserPage.chooseFile('[data-deck-action="import"]', legacyFixture);
  const successText = await waitForImportResult(chooserPage, "success");
  const importedRows = await waitForDeckRows(chooserPage, 3);
  assert(successText.includes("P0B Fixture"), "Success report omitted the imported parent deck");
  assert(successText.includes("P0B Fixture::子 deck"), "Success report omitted the imported child deck");
  assert(successText.includes("2 decks, 2 notes, 4 cards, and 2 media files"), "Success report omitted service-derived counts");
  assert(
    importedRows.some(
      (row) =>
        row.includes("P0B Fixture") &&
        row.includes("2 new") &&
        row.includes("0 due") &&
        row.includes("2 total"),
    ),
    "Imported metadata was not visible immediately",
  );
  const chooserEvidence = await chooserPage.evaluate<{ stages: string[]; texts: string[]; commitCancelDisabled: boolean }>("window.__importUiEvidence");
  assert(chooserEvidence.stages.includes("preflight"), "Chooser journey did not expose preflight progress");
  assert(chooserEvidence.stages.some((stage) => stage !== "preflight"), "Chooser journey did not expose Worker progress");
  assert(chooserEvidence.texts.some((text) => /\d+ of \d+/.test(text)), "Chooser journey did not expose available counts");
  const reportFocus = await chooserPage.evaluate<string>("document.activeElement?.id ?? ''");
  assert(reportFocus === "import-result-heading", "Success did not move focus to the result heading");
  await chooserPage.reload();
  const reloadedRows = await waitForDeckRows(chooserPage, 3);
  assert(reloadedRows.some((row) => row.includes("P0B Fixture::子 deck")), "Imported decks did not survive reload");
  await chooserPage.setViewport(mobileViewport);
  await assertImportLayout(chooserPage, mobileViewport.width);
  await assertNoBrowserErrors(chooserPage);

  const dropPage = await browser.newIsolatedPage();
  await dropPage.setViewport(desktopViewport);
  await dropPage.navigate(url);
  await waitForDeckRows(dropPage, 1);
  await dropPage.dispatchTextDrag("[data-deck-page]");
  const nonFileOverlay = await dropPage.evaluate<boolean>("Boolean(document.querySelector('[data-import-drop-overlay]'))");
  assert(!nonFileOverlay, "A non-file drag activated the import overlay");
  await dropPage.dispatchFiles("[data-deck-page]", "dragenter", [{ path: warningFixture }]);
  await dropPage.dispatchFiles("[data-deck-page]", "dragenter", [{ path: warningFixture }]);
  await dropPage.dispatchFiles("[data-deck-page]", "dragleave", [{ path: warningFixture }]);
  const nestedOverlay = await dropPage.evaluate<boolean>("Boolean(document.querySelector('[data-import-drop-overlay]'))");
  assert(nestedOverlay, "Nested drag leave incorrectly hid the import overlay");
  await dropPage.pressKey("Escape");
  const dismissedOverlay = await dropPage.evaluate<boolean>("Boolean(document.querySelector('[data-import-drop-overlay]'))");
  assert(!dismissedOverlay, "Escape did not dismiss the import overlay");
  await dropPage.dispatchFiles("[data-deck-page]", "drop", [{ path: corruptFixture, name: "notes.txt" }]);
  const invalidText = await waitFor(
    async () => dropPage.evaluate<string>("document.querySelector('[data-import-intake-message]')?.textContent?.trim() ?? ''")
      .then((text) => text ? text : false),
    "invalid extension guidance",
  );
  assert(invalidText === "Choose exactly one .apkg file to import.", "Invalid extension guidance was not actionable");
  await dropPage.dispatchFiles("[data-deck-page]", "drop", [
    { path: legacyFixture },
    { path: warningFixture },
  ]);
  const multipleText = await dropPage.evaluate<string>("document.querySelector('[data-import-intake-message]')?.textContent?.trim() ?? ''");
  assert(multipleText === "Choose exactly one .apkg file to import.", "Multiple-file rejection was not announced");
  await observeImportPresentation(dropPage);
  await dropPage.dispatchFiles("[data-deck-page]", "drop", [{ path: warningFixture }]);
  const warningText = await waitForImportResult(dropPage, "success-with-warnings");
  assert(warningText.includes("Import warnings"), "Warning-bearing success was not visibly grouped");
  assert(warningText.includes("UNSAFE_CONTENT_REMOVED"), "Warning report omitted a safe diagnostic code");
  assert(!/evil\.invalid|onerror|<script/i.test(warningText), "Warning report exposed imported active content");
  await waitForDeckRows(dropPage, 3);
  await dropPage.setViewport(mobileViewport);
  await assertImportLayout(dropPage, mobileViewport.width);
  await assertNoBrowserErrors(dropPage);

  const cancelPage = await browser.newIsolatedPage();
  await cancelPage.navigate(url);
  await waitForDeckRows(cancelPage, 1);
  const beforeCancel = await readImportDurableState(cancelPage);
  await installSlowNextDigest(cancelPage);
  await cancelPage.setInputFile("[data-deck-import-input]", legacyFixture);
  await waitFor(
    async () => cancelPage.evaluate<boolean>("!document.querySelector('[data-deck-action=\"cancel-import\"]')?.hasAttribute('disabled')"),
    "a cancellable pre-commit import",
  );
  await cancelPage.click('[data-deck-action="cancel-import"]');
  const cancelledText = await waitForImportResult(cancelPage, "cancelled");
  assert(cancelledText.includes("saved decks were not changed"), "Cancellation omitted no-write guidance");
  assert(JSON.stringify(await readImportDurableState(cancelPage)) === JSON.stringify(beforeCancel), "Cancelled import changed durable state");
  assert((await waitForDeckRows(cancelPage, 1)).length === 1, "Cancelled import added a phantom deck row");
  await assertNoBrowserErrors(cancelPage);

  await verifyDuplicateAndReplacement(browser, url, legacyFixture);
  await verifyFailedImports(browser, url, legacyFixture, corruptFixture, unsupportedFixture);
}

async function verifyDuplicateAndReplacement(
  browser: Browser,
  url: string,
  legacyFixture: string,
): Promise<void> {
  const page = await browser.newIsolatedPage();
  await page.navigate(url);
  await waitForDeckRows(page, 1);
  await page.setInputFile("[data-deck-import-input]", legacyFixture);
  await waitForImportResult(page, "success");
  await waitForDeckRows(page, 3);
  const originalGraph = await readImportDurableState(page);
  await page.click('[data-deck-action="dismiss-import-report"]');
  await page.setInputFile("[data-deck-import-input]", legacyFixture);
  await waitFor(
    async () => page.evaluate<boolean>("Boolean(document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]'))")
      .then((visible) => visible || false),
    "the duplicate choice dialog",
  );
  const duplicateFocus = await page.evaluate<string>("document.activeElement?.getAttribute('data-deck-action') ?? ''");
  assert(duplicateFocus === "cancel-duplicate", "Duplicate dialog did not focus the safe default action");
  assert(JSON.stringify(await readImportDurableState(page)) === JSON.stringify(originalGraph), "Duplicate detection wrote before confirmation");
  await page.pressKey("Escape");
  await waitForImportResult(page, "duplicate-cancelled");
  assert(JSON.stringify(await readImportDurableState(page)) === JSON.stringify(originalGraph), "Duplicate cancellation changed durable state");
  await page.click('[data-deck-action="dismiss-import-report"]');
  await observeImportPresentation(page);
  await page.setInputFile("[data-deck-import-input]", legacyFixture);
  await waitFor(
    async () => page.evaluate<boolean>("Boolean(document.querySelector('[data-import-duplicate-dialog]'))")
      .then((visible) => visible || false),
    "the replacement confirmation",
  );
  await page.click('[data-deck-action="replace-duplicate"]');
  await waitForImportResult(page, "success");
  assert(JSON.stringify(await readImportDurableState(page)) === JSON.stringify(originalGraph), "Atomic replacement duplicated or removed records");
  const replacementEvidence = await page.evaluate<{ stages: string[]; texts: string[]; commitCancelDisabled: boolean }>("window.__importUiEvidence");
  assert(replacementEvidence.commitCancelDisabled, "Commit stage did not disable cancellation");
  await page.click('[data-deck-action="dismiss-import-report"]');
  await page.setInputFile("[data-deck-import-input]", legacyFixture);
  await waitFor(
    async () => page.evaluate<boolean>("Boolean(document.querySelector('[data-import-duplicate-dialog]'))")
      .then((visible) => visible || false),
    "the replacement failure confirmation",
  );
  await installOneShotImportDeleteFailure(page);
  await page.click('[data-deck-action="replace-duplicate"]');
  const replacementFailure = await waitForImportResult(page, "failed");
  assert(replacementFailure.includes("replacement failed safely"), "Replacement failure omitted preservation guidance");
  assert(replacementFailure.includes("Retry replacement"), "Replacement failure omitted retry guidance");
  assert(JSON.stringify(await readImportDurableState(page)) === JSON.stringify(originalGraph), "Failed replacement did not roll back its transaction");
  assert((await waitForDeckRows(page, 3)).length === 3, "Failed replacement changed visible deck rows");
  await assertNoBrowserErrors(page);
}

async function verifyFailedImports(
  browser: Browser,
  url: string,
  legacyFixture: string,
  corruptFixture: string,
  unsupportedFixture: string,
): Promise<void> {
  const page = await browser.newIsolatedPage();
  await page.navigate(url);
  await waitForDeckRows(page, 1);
  const cleanState = await readImportDurableState(page);
  await page.setInputFile("[data-deck-import-input]", corruptFixture);
  const corruptText = await waitForImportResult(page, "failed");
  assert(corruptText.includes("invalid or corrupt"), "Corrupt package did not render recoverable guidance");
  assert(JSON.stringify(await readImportDurableState(page)) === JSON.stringify(cleanState), "Corrupt package left partial durable state");
  await page.click('[data-deck-action="choose-another-import"]');
  await page.setInputFile("[data-deck-import-input]", unsupportedFixture);
  const unsupportedText = await waitForImportResult(page, "failed");
  assert(unsupportedText.includes("format is not supported"), "Unsupported package did not render distinct guidance");
  await page.click('[data-deck-action="choose-another-import"]');
  await installOneShotImportWriteFailure(page, "decks");
  await page.setInputFile("[data-deck-import-input]", legacyFixture);
  const storageText = await waitForImportResult(page, "failed");
  assert(storageText.includes("Not enough storage"), "Quota failure did not render the storage report");
  assert(storageText.includes("Retry import"), "Recoverable commit failure omitted retry guidance");
  assert(JSON.stringify(await readImportDurableState(page)) === JSON.stringify(cleanState), "Failed commit left partial durable state");
  assert((await waitForDeckRows(page, 1)).length === 1, "Failed commit added a phantom row");
  await page.setViewport(mobileViewport);
  await assertImportLayout(page, mobileViewport.width);
  await assertNoBrowserErrors(page);
}

async function verifyProductionRemovalJourneys(browser: Browser, origin: string): Promise<void> {
  const url = `${origin}${basePath}/`;
  const legacyFixture = join(importFixtures, "legacy-anki2.apkg");

  const seedPage = await browser.newIsolatedPage();
  await seedPage.setViewport(desktopViewport);
  await seedPage.navigate(url);
  await waitForDeckRows(seedPage, 1);
  const seedBeforeCancel = await readRemovalGraph(seedPage);
  const seedRemoveName = await seedPage.evaluate<string>(`(() => {
    const button = document.querySelector('[data-deck-id="seed-spanish-basics"] [data-deck-action="remove"]');
    button?.focus();
    return button?.getAttribute('aria-label') ?? '';
  })()`);
  assert(seedRemoveName === "Remove Spanish Basics", "Seed remove control omitted the full deck name");
  await seedPage.pressKey("Enter");
  const seedPreview = await waitForRemovalDialog(seedPage, "ready");
  assert(seedPreview.includes("Spanish Basics"), "Seed preview omitted the service-returned deck name");
  assert(!seedPreview.includes("media record"), "Seed removal preview still exposed removal statistics");
  assert(new URL(await seedPage.evaluate<string>("location.href")).pathname === `${basePath}/`, "Remove activation navigated into study");
  assert(
    await seedPage.evaluate<string>("document.activeElement?.getAttribute('data-deck-action') ?? ''") === "cancel-removal",
    "Removal preview did not focus the safe Cancel action",
  );
  await seedPage.pressKey("Tab");
  await seedPage.pressKey("Tab");
  assert(
    await seedPage.evaluate<boolean>("Boolean(document.querySelector('[data-deck-removal-dialog]')?.contains(document.activeElement))"),
    "Removal dialog did not contain keyboard focus",
  );
  await seedPage.pressKey("Escape");
  assert(JSON.stringify(await readRemovalGraph(seedPage)) === JSON.stringify(seedBeforeCancel), "Escape changed the seed graph");
  assert(
    await seedPage.evaluate<string>("document.activeElement?.getAttribute('aria-label') ?? ''") === "Remove Spanish Basics",
    "Escape did not return focus to the originating remove control",
  );

  await seedPage.click('[data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await seedPage.waitForUrl(`${origin}${basePath}/study/?deck=seed-spanish-basics`);
  await waitForStudyState(seedPage, "active");
  const studyingSeed = await readRemovalGraph(seedPage);
  assert(studyingSeed.sessions.length === 1, "Study did not create the seed session used by removal");
  const seedSessionId = studyingSeed.sessions[0]!.id;
  await seedPage.evaluate<void>(
    `sessionStorage.setItem('anki-web-mcp.active-session-id', ${JSON.stringify(seedSessionId)})`,
  );
  await seedPage.navigate(url);
  await waitForDeckRows(seedPage, 1);
  await requestRemoval(seedPage, "seed-spanish-basics");
  await seedPage.evaluate<void>(`(() => {
    window.__removalCommitCount = 0;
    window.__removalCommitPresentation = { cancelDisabled: false, rowDisabled: false };
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(storeNames, mode, options) {
      const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
      if (mode === 'readwrite' && names.includes('decks') && names.includes('reviewLogs')) {
        window.__removalCommitCount += 1;
      }
      return original.call(this, storeNames, mode, options);
    };
    const sample = () => {
      if (document.querySelector('[data-deck-removal-dialog="committing"]')) {
        window.__removalCommitPresentation.cancelDisabled ||= Boolean(document.querySelector('[data-deck-action="cancel-removal"]')?.disabled);
        window.__removalCommitPresentation.rowDisabled ||= Array.from(document.querySelectorAll('[data-deck-action="remove"]')).every((button) => button.disabled);
      }
    };
    new MutationObserver(sample).observe(document.body, { attributes: true, childList: true, subtree: true });
  })()`);
  await seedPage.evaluate<void>(`(() => {
    const confirm = document.querySelector('[data-deck-action="confirm-removal"]');
    confirm?.click();
    confirm?.click();
  })()`);
  await waitForRemovalDialog(seedPage, "success");
  await waitForDeckRows(seedPage, 0);
  const seedCommitEvidence = await seedPage.evaluate<{
    count: number;
    cancelDisabled: boolean;
    rowDisabled: boolean;
  }>(`({
    count: window.__removalCommitCount,
    cancelDisabled: window.__removalCommitPresentation.cancelDisabled,
    rowDisabled: window.__removalCommitPresentation.rowDisabled,
  })`);
  assert(seedCommitEvidence.count === 1, "Repeated confirmation started more than one removal transaction");
  assert(seedCommitEvidence.cancelDisabled, "Removal cancellation was not disabled during commit");
  assert(seedCommitEvidence.rowDisabled, "Deck row remove actions were not disabled during commit");
  const removedSeed = await readRemovalGraph(seedPage);
  assert(
    removedSeed.counts.decks === 0 && removedSeed.counts.cards === 0 && removedSeed.counts.media === 0,
    "Seed removal left deck, card, or media records",
  );
  assert(removedSeed.counts.sessions === 0 && removedSeed.counts.reviewLogs === 0, "Seed removal left study records");
  assert(removedSeed.seedInstalled === true, "Seed removal changed the seed-installed marker");
  assert(removedSeed.activeSessionId === null, "Seed removal retained its deleted active-session pointer");
  await seedPage.click('[data-deck-action="close-removal"]');
  assert(
    await seedPage.evaluate<string>("document.querySelector('[data-deck-page-state]')?.getAttribute('data-deck-page-state') ?? ''") === "empty",
    "Removing the final deck did not render the Import Deck empty state",
  );
  await seedPage.reload();
  await waitForDeckRows(seedPage, 0);
  assert((await readRemovalGraph(seedPage)).counts.decks === 0, "The removed seed deck returned after reload");
  await assertNoBrowserErrors(seedPage);

  const singlePage = await browser.newIsolatedPage();
  await singlePage.navigate(url);
  await waitForDeckRows(singlePage, 1);
  await installRemovalFixture(singlePage, false);
  await singlePage.reload();
  await waitForDeckRows(singlePage, 2);
  const singlePreview = await requestRemoval(singlePage, "single-removal-deck");
  assert(singlePreview.includes("Single Import Removal"), "Single-import preview omitted the durable deck name");
  assert(!singlePreview.includes("media record"), "Single-import removal preview still exposed removal statistics");
  await confirmRemoval(singlePage);
  await waitForDeckRows(singlePage, 1);
  const singleRemoved = await readRemovalGraph(singlePage);
  assert(!singleRemoved.decks.some((deck) => deck.id === "single-removal-deck"), "Single-import removal left its deck");
  assert(!singleRemoved.notes.some((note) => note.importId === "single-removal-import"), "Single-import removal left its note");
  assert(!singleRemoved.media.some((record) => record.importId === "single-removal-import"), "Single-import removal left its media");
  assert(singleRemoved.counts.imports === 0, "Single-import removal left import metadata");
  assert(singleRemoved.counts.sessions === 0 && singleRemoved.counts.reviewLogs === 0, "Single-import removal left study records");
  assert(singleRemoved.seedInstalled === true, "Single-import removal changed the seed-installed marker");
  assert(singleRemoved.activeSessionId === null, "Single-import removal retained its deleted session pointer");
  await singlePage.reload();
  const singleReload = await waitForDeckRows(singlePage, 1);
  assert(singleReload[0]?.includes("Spanish Basics"), "Single-import removal did not persist after reload");
  await assertNoBrowserErrors(singlePage);

  const boundaryPage = await browser.newIsolatedPage();
  await boundaryPage.navigate(url);
  await waitForDeckRows(boundaryPage, 1);
  await installRemovalFixture(boundaryPage, true);
  await boundaryPage.reload();
  await waitForDeckRows(boundaryPage, 4);
  const boundaryOriginal = await readRemovalGraph(boundaryPage);
  for (const [index, boundary] of removalBoundaryFailures.entries()) {
    const boundaryPreview = await requestRemoval(boundaryPage, "single-removal-deck");
    assert(!boundaryPreview.includes("media record"), `${boundary} still exposed removal statistics`);
    await installOneShotRemovalBoundaryFailure(boundaryPage, boundary);
    await boundaryPage.click('[data-deck-action="confirm-removal"]');
    const boundaryFailure = await waitForRemovalDialog(boundaryPage, "commit-error");
    assert(
      boundaryFailure.includes("Nothing was changed") && boundaryFailure.includes("Try again"),
      `${boundary} omitted application-owned retry/cancel guidance`,
    );
    assert(
      !/Injected|UnknownError|DOMException|IndexedDB/i.test(boundaryFailure),
      `${boundary} exposed raw storage text`,
    );
    assert(
      JSON.stringify(await readRemovalGraph(boundaryPage)) === JSON.stringify(boundaryOriginal),
      `${boundary} changed the public durable graph or active-session pointer`,
    );
    assert((await waitForDeckRows(boundaryPage, 4)).length === 4, `${boundary} hid a visible deck row`);
    await boundaryPage.click('[data-deck-action="retry-removal"]');
    await waitForRemovalDialog(boundaryPage, "ready");
    if (index + 1 < removalBoundaryFailures.length) {
      await boundaryPage.click('[data-deck-action="cancel-removal"]');
    } else {
      await confirmRemoval(boundaryPage);
    }
  }
  await waitForDeckRows(boundaryPage, 3);
  const boundaryRecovered = await readRemovalGraph(boundaryPage);
  assert(
    !boundaryRecovered.decks.some((deck) => deck.id === "single-removal-deck"),
    "The final boundary retry did not remove the selected deck",
  );
  assert(
    boundaryRecovered.decks.some((deck) => deck.id === "seed-spanish-basics")
      && boundaryRecovered.decks.filter((deck) => deck.importId === "sibling-sentinel-import").length === 2,
    "Boundary recovery changed the seed or sibling decks",
  );
  assert(
    boundaryRecovered.notes.some((note) => note.id === "sibling-sentinel-note")
      && boundaryRecovered.media.some((record) => record.importId === "sibling-sentinel-import"),
    "Boundary recovery changed sibling-shared notes or media",
  );
  assert(boundaryRecovered.seedInstalled === true, "Boundary recovery changed the seed-installed marker");
  assert(boundaryRecovered.activeSessionId === null, "Boundary recovery retained the deleted session pointer");
  await boundaryPage.reload();
  await waitForDeckRows(boundaryPage, 3);
  await assertNoBrowserErrors(boundaryPage);

  const siblingPage = await browser.newIsolatedPage();
  await siblingPage.navigate(url);
  await waitForDeckRows(siblingPage, 1);
  await siblingPage.setInputFile("[data-deck-import-input]", legacyFixture);
  await waitForImportResult(siblingPage, "success");
  await waitForDeckRows(siblingPage, 3);
  const importedGraph = await readRemovalGraph(siblingPage);
  const child = importedGraph.decks.find((deck) => deck.name === "P0B Fixture::子 deck");
  const parent = importedGraph.decks.find((deck) => deck.name === "P0B Fixture");
  assert(child && parent, "Multi-deck fixture did not expose both imported siblings");
  const childBeforeDismiss = await requestRemoval(siblingPage, child.id);
  assert(!childBeforeDismiss.includes("media record"), "Child preview still exposed removal statistics");
  await siblingPage.evaluate<void>(`document.querySelector('[data-deck-removal-dialog]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  assert(JSON.stringify(await readRemovalGraph(siblingPage)) === JSON.stringify(importedGraph), "Backdrop dismissal changed the import graph");
  assert(
    await siblingPage.evaluate<string>("document.activeElement?.getAttribute('aria-label') ?? ''") === "Remove P0B Fixture::子 deck",
    "Backdrop dismissal did not restore row focus",
  );

  await requestRemoval(siblingPage, child.id);
  await siblingPage.evaluate<void>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('decks', 'readwrite');
      const store = transaction.objectStore('decks');
      const get = store.get(${JSON.stringify(child.id)});
      get.onsuccess = () => store.put({ ...get.result, name: 'P0B Fixture::子 deck refreshed' });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
  await siblingPage.click('[data-deck-action="confirm-removal"]');
  const staleText = await waitForRemovalDialog(siblingPage, "commit-error");
  assert(staleText.includes("changed after the details were loaded"), "Stale preview did not request refreshed details");
  assert((await waitForDeckRows(siblingPage, 3)).length === 3, "Stale confirmation removed a visible row");
  await siblingPage.click('[data-deck-action="retry-removal"]');
  const refreshedPreview = await waitForRemovalDialog(siblingPage, "ready");
  assert(refreshedPreview.includes("子 deck refreshed"), "Stale retry did not load the current durable deck name");
  await siblingPage.evaluate<void>("sessionStorage.setItem('anki-web-mcp.active-session-id', 'newer-unrelated-session')");
  await confirmRemoval(siblingPage);
  await waitForDeckRows(siblingPage, 2);
  const afterChild = await readRemovalGraph(siblingPage);
  assert(afterChild.decks.some((deck) => deck.id === parent.id), "Removing a child removed its sibling deck");
  assert(afterChild.counts.imports === 1 && afterChild.counts.media === 3, "Removing a child removed shared import metadata or media");
  assert(afterChild.notes.filter((note) => note.importId === parent.importId).length === 1, "Removing a child did not garbage-collect only its orphan note");
  assert(afterChild.activeSessionId === "newer-unrelated-session", "Removing a child cleared an unrelated newer session pointer");
  await siblingPage.click('[data-deck-action="close-removal"]');
  const parentPreview = await requestRemoval(siblingPage, parent.id);
  assert(!parentPreview.includes("media record"), "Parent preview still exposed removal statistics");
  await siblingPage.setViewport(mobileViewport);
  await assertRemovalLayout(siblingPage, mobileViewport.width);
  await confirmRemoval(siblingPage);
  await waitForDeckRows(siblingPage, 1);
  const afterImport = await readRemovalGraph(siblingPage);
  assert(!afterImport.decks.some((deck) => deck.importId === parent.importId), "Final sibling removal left an imported deck");
  assert(!afterImport.notes.some((note) => note.importId === parent.importId), "Final sibling removal left imported notes");
  assert(!afterImport.media.some((record) => record.importId === parent.importId), "Final sibling removal left imported media");
  assert(afterImport.counts.imports === 0, "Final sibling removal left import metadata");
  await siblingPage.reload();
  const siblingReload = await waitForDeckRows(siblingPage, 1);
  assert(siblingReload[0]?.includes("Spanish Basics"), "Sibling cleanup did not persist after reload");
  await assertNoBrowserErrors(siblingPage);

  const failurePage = await browser.newIsolatedPage();
  await failurePage.navigate(url);
  await waitForDeckRows(failurePage, 1);
  await failurePage.setInputFile("[data-deck-import-input]", legacyFixture);
  await waitForImportResult(failurePage, "success");
  await waitForDeckRows(failurePage, 3);
  const beforeFailure = await readRemovalGraph(failurePage);
  const failedDeck = beforeFailure.decks.find((deck) => deck.name === "P0B Fixture::子 deck");
  assert(failedDeck, "Failure fixture did not expose its child deck");
  await requestRemoval(failurePage, failedDeck.id);
  await failurePage.evaluate<void>(`(() => {
    const originalDelete = IDBObjectStore.prototype.delete;
    let armed = true;
    IDBObjectStore.prototype.delete = function(key) {
      if (armed && this.name === 'cards') {
        armed = false;
        throw new DOMException('Injected raw browser storage failure', 'UnknownError');
      }
      return originalDelete.call(this, key);
    };
  })()`);
  await failurePage.click('[data-deck-action="confirm-removal"]');
  const failureText = await waitForRemovalDialog(failurePage, "commit-error");
  assert(failureText.includes("Nothing was changed") && failureText.includes("Try again"), "Removal failure omitted retry/cancel guidance");
  assert(!/Injected|UnknownError|DOMException|IndexedDB/i.test(failureText), "Removal failure exposed raw storage text");
  assert(JSON.stringify(await readRemovalGraph(failurePage)) === JSON.stringify(beforeFailure), "Failed removal changed the durable graph");
  assert((await waitForDeckRows(failurePage, 3)).length === 3, "Failed removal hid a visible deck row");
  await failurePage.click('[data-deck-action="retry-removal"]');
  await waitForRemovalDialog(failurePage, "ready");
  await confirmRemoval(failurePage);
  await waitForDeckRows(failurePage, 2);
  await failurePage.reload();
  await waitForDeckRows(failurePage, 2);
  await assertNoBrowserErrors(failurePage);
}

async function verifyStudyRoute(browser: Browser, origin: string): Promise<void> {
  const page = await browser.newIsolatedPage();
  const diagnosticUrl = `${origin}${basePath}/study/?deck=diagnostic`;
  const url = `${origin}${basePath}/study/?deck=seed-spanish-basics`;
  await assertStaticRouteIdentity(diagnosticUrl, "study", "deck-home");
  await assertApplicationDocument(url, "Loading your study");
  await page.navigate(diagnosticUrl);
  const diagnosticRoute = await page.evaluate<{ identity: string | null; search: string }>(`({
    identity: document.querySelector('[data-deployment-route]')?.getAttribute('data-deployment-route') ?? null,
    search: location.search,
  })`);
  assert(diagnosticRoute.identity === "study", "Direct study navigation exposed the wrong route identity");
  assert(diagnosticRoute.search === "?deck=diagnostic", "Direct study navigation changed the diagnostic query");
  await page.navigate(`${origin}${basePath}/`);
  await waitFor(
    async () => page.evaluate<number>("document.querySelectorAll('[data-deck-row]').length")
      .then((count) => count === 1 ? count : false),
    "the seeded deck before study hydration",
  );
  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await page.waitForUrl(url);
  await waitForStudyState(page, "active");
  await assertHostileStudySideEvidence(page, desktopViewport.width);

  const controlsBeforeReveal = await page.evaluate<{
    active: string | null;
    disabledRatings: number;
    diagnostic: boolean;
    heading: string;
    sessionHidden: boolean;
    cardIdHidden: boolean;
    side: string;
    content: string;
  }>(`({
    active: document.querySelector('[data-study-state]')?.getAttribute('data-study-state') ?? null,
    disabledRatings: document.querySelectorAll('[data-study-action="rate"]:disabled').length,
    diagnostic: Boolean(document.querySelector('[data-phase0-diagnostics]')),
    heading: document.querySelector('[data-study-header] h1')?.textContent?.trim() ?? '',
    sessionHidden: (() => {
      const element = document.querySelector('[data-study-session]');
      return !element || element.getClientRects().length === 0;
    })(),
    cardIdHidden: (() => {
      const element = document.querySelector('[data-study-card-id]');
      return !element || element.getClientRects().length === 0;
    })(),
    side: document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? '',
    content: document.querySelector('[data-card-html]')?.textContent?.trim() ?? '',
  })`);
  assert(controlsBeforeReveal.active === "active", "Study did not render the durable active state");
  assert(controlsBeforeReveal.disabledRatings === 0, "Study ratings were not available before reveal");
  assert(!controlsBeforeReveal.diagnostic, "Study still exposed the Phase 0 diagnostics region");
  assert(controlsBeforeReveal.heading === "Spanish Basics", "Study did not render the persisted deck name");
  assert(controlsBeforeReveal.sessionHidden, "Study exposed the session ID in the visible UI");
  assert(controlsBeforeReveal.cardIdHidden, "Study exposed the card ID in the visible UI");
  assert(controlsBeforeReveal.side === "front", "Study did not restore the persisted front side");
  assert(controlsBeforeReveal.content === "hola", "Study did not render the persisted front content");
  const renderedImage = await waitFor(
    async () => page.evaluate<boolean>(
      `Boolean(document.querySelector('[data-flashcard-front-context] img[src^="blob:"]'))`,
    ),
    "the local image-bearing card template",
  );
  assert(renderedImage, "The image-bearing card did not resolve its local media blob");
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
      side: document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? '',
      enabledRatings: document.querySelectorAll('[data-study-action="rate"]:not(:disabled)').length,
      body: document.querySelector('[data-production-study]')?.textContent ?? '',
      focus: document.activeElement?.getAttribute('data-study-rating') ?? '',
    })`).then((state) => state.side === "back" && state.focus === "again" ? state : false),
    "the persisted answer reveal",
  );
  assert(revealed.enabledRatings === 4, "Reveal did not enable all four rating actions");
  assert(revealed.body.includes("hello"), "Reveal did not show the persisted answer");
  assert(
    await page.evaluate<boolean>(`!document.querySelector('[data-flashcard-front-context]') && Boolean(document.querySelector('[data-flashcard-answer]'))`),
    "Reveal did not replace the front with the answer surface",
  );
  await page.click('[data-study-action="toggle"]');
  await waitFor(
    async () => page.evaluate<string>(
      `document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? ''`,
    ).then((side) => side === "front" ? side : false),
    "the reversible front side",
  );
  await page.click('[data-study-action="toggle"]');
  await waitFor(
    async () => page.evaluate<string>(
      `document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? ''`,
    ).then((side) => side === "back" ? side : false),
    "the reversible answer side",
  );

  await page.click('[data-study-rating="again"]');
  const rated = await waitFor(
    async () => page.evaluate<{ cardId: string; progress: string; side: string; error: string; focus: string }>(`({
      cardId: document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? '',
      progress: document.querySelector('[role="progressbar"]')?.getAttribute('aria-label') ?? '',
      side: document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? '',
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
  assert(rated.side === "front", "Rating did not advance to the next card front");
  assert(/^Study progress: \d+ of \d+$/.test(rated.progress), "Rating did not refresh durable progress");

  await page.click('[data-study-rating="good"]');
  const ratedBeforeFlip = await waitFor(
    async () => page.evaluate<{ cardId: string; progress: string; side: string; error: string }>(`({
      cardId: document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? '',
      progress: document.querySelector('[role="progressbar"]')?.getAttribute('aria-label') ?? '',
      side: document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? '',
      error: document.querySelector('[role="alert"]')?.textContent?.trim() ?? '',
    })`).then((state) => state.error || (
      state.cardId && state.cardId !== rated.cardId
    ) ? state : false),
    "the pre-flip rating transition",
  );
  assert(!ratedBeforeFlip.error, `Pre-flip rating reported a recoverable error: ${ratedBeforeFlip.error}`);
  assert(ratedBeforeFlip.side === "front", "Pre-flip rating did not advance to the next card front");
  assert(
    /^Study progress: \d+ of \d+$/.test(ratedBeforeFlip.progress),
    "Pre-flip rating did not refresh durable daily progress",
  );

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
  assert(resumedCardId === ratedBeforeFlip.cardId, "Study reload did not resume the committed current card");
  await assertLoadedResources(page);
  const returnAction = await page.evaluate<{ tabIndex: number; width: number; height: number }>(`(() => {
    const button = document.querySelector('[data-study-action="return"]');
    const rect = button?.getBoundingClientRect();
    return { tabIndex: button?.tabIndex ?? -1, width: rect?.width ?? 0, height: rect?.height ?? 0 };
  })()`);
  assert(returnAction.tabIndex >= 0 && returnAction.width >= 44 && returnAction.height >= 44,
    "Study return action was not visibly keyboard operable");
  const visibleSuspendButton = await page.evaluate<boolean>(
    `Boolean(document.querySelector('[data-study-action="suspend"]'))`,
  );
  assert(!visibleSuspendButton, "Study card still displayed a Suspend button");
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

async function waitForCardSide(page: BrowserPage, side: "FRONT" | "BACK"): Promise<void> {
  await waitFor(
    async () => page.evaluate<string>(
      "document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? ''",
    ).then((value) => value === side.toLowerCase() ? value : false),
    `the ${side.toLowerCase()} card side`,
  );
}

type BrowserRatingEvidence = {
  session: {
    activeCardId: string | null;
    plannedPresentationCount: number;
    completedPresentationCount: number;
    nextDayAt: number;
  };
  log: {
    cardId: string;
    rating: string;
    reviewedAt: number;
    after: { dueAt: number };
  };
};

async function readLatestRatingEvidence(page: BrowserPage): Promise<BrowserRatingEvidence> {
  return page.evaluate<BrowserRatingEvidence>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['sessions', 'reviewLogs'], 'readonly');
      const sessions = transaction.objectStore('sessions').getAll();
      const logs = transaction.objectStore('reviewLogs').getAll();
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        database.close();
        const session = sessions.result
          .filter((value) => value.deckId === 'seed-spanish-basics')
          .sort((left, right) => left.startedAt - right.startedAt).at(-1);
        const log = logs.result.sort((left, right) => left.reviewedAt - right.reviewedAt).at(-1);
        if (!session || !log) reject(new Error('Rating evidence is incomplete'));
        else resolve({ session, log });
      };
    };
  })`);
}

async function prepareSinglePresentation(
  page: BrowserPage,
  completeAtCutoff = false,
  deferOtherIntake = false,
): Promise<void> {
  await page.evaluate<void>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['sessions', 'schedules'], 'readwrite');
      const sessionStore = transaction.objectStore('sessions');
      const sessions = sessionStore.getAll();
      sessions.onerror = () => reject(sessions.error);
      sessions.onsuccess = () => {
        const current = sessions.result
          .filter((value) => value.deckId === 'seed-spanish-basics')
          .sort((left, right) => left.startedAt - right.startedAt).at(-1);
        if (!current || !current.activeCardId) {
          reject(new Error('No active session to prepare'));
          return;
        }
        const retained = current.queueEntries.find((entry) => entry.cardId === current.activeCardId);
        if (!retained) {
          reject(new Error('The active queue occurrence is missing'));
          return;
        }
        sessionStore.put({
          ...current,
          queueEntries: [{ ...retained, dueAt: Date.now() }],
          activeCardId: retained.cardId,
          currentSide: 'front',
          plannedPresentationCount: 1,
          completedPresentationCount: 0,
          ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
          completedAt: null,
          nextDayAt: ${completeAtCutoff ? "Date.now() - 1" : "current.nextDayAt"},
          updatedAt: Date.now(),
        });
        if (${deferOtherIntake}) {
          const removedIds = new Set(current.queueEntries
            .map((entry) => entry.cardId)
            .filter((cardId) => cardId !== retained.cardId));
          const schedules = transaction.objectStore('schedules').openCursor();
          schedules.onerror = () => reject(schedules.error);
          schedules.onsuccess = () => {
            const cursor = schedules.result;
            if (!cursor) return;
            if (removedIds.has(cursor.value.cardId)) {
              cursor.update({
                ...cursor.value,
                state: 'review',
                dueAt: Date.now() + 7 * 86_400_000,
              });
            }
            cursor.continue();
          };
        }
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
  await page.reload();
  await waitForStudyState(page, "active");
}

async function startFreshSeedSession(page: BrowserPage, origin: string): Promise<void> {
  await page.navigate(`${origin}${basePath}/`);
  await waitFor(
    async () => page.evaluate<number>("document.querySelectorAll('[data-deck-row]').length")
      .then((count) => count === 1 ? count : false),
    "the isolated Spanish Basics seed",
  );
  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await page.waitForUrl(`${origin}${basePath}/study/?deck=seed-spanish-basics`);
  await waitForStudyState(page, "active");
}

async function verifyIsolatedProductionJourneys(browser: Browser, origin: string): Promise<void> {
  for (const rating of ["again", "hard", "good", "easy"] as const) {
    const page = await browser.newIsolatedPage();
    await startFreshSeedSession(page, origin);
    const firstCardId = await page.evaluate<string>(
      "document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? ''",
    );
    await page.click('[data-study-action="toggle"]');
    await waitForCardSide(page, "BACK");
    await page.click(`[data-study-rating="${rating}"]`);
    const evidence = await waitFor(
      async () => readLatestRatingEvidence(page).then((result) =>
        result.session.completedPresentationCount === 1 ? result : false),
      `the isolated ${rating} transition`,
    );
    assert(evidence.log.cardId === firstCardId, `${rating} reviewed the wrong durable card`);
    assert(evidence.log.rating === rating, `${rating} wrote the wrong review-log rating`);
    assert(evidence.session.completedPresentationCount === 1, `${rating} did not advance completed progress`);
    assert(evidence.log.after.dueAt > evidence.log.reviewedAt, `${rating} did not create delayed work`);
    const remainsToday = evidence.log.after.dueAt < evidence.session.nextDayAt;
    assert(
      evidence.session.plannedPresentationCount === (remainsToday ? 21 : 20),
      `${rating} did not apply the persisted day-cutoff rule`,
    );
    const nextCardId = evidence.session.activeCardId;
    await page.reload();
    await waitForStudyState(page, "active");
    const resumedCardId = await page.evaluate<string>(
      "document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? ''",
    );
    assert(resumedCardId === nextCardId, `${rating} did not resume the committed next card`);
    await assertNoBrowserErrors(page);
  }

  const waitingPage = await browser.newIsolatedPage();
  await waitingPage.installClock(Date.now());
  await startFreshSeedSession(waitingPage, origin);
  await prepareSinglePresentation(waitingPage);
  const waitingCardId = await waitingPage.evaluate<string>(
    "document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? ''",
  );
  await waitingPage.click('[data-study-action="toggle"]');
  await waitForCardSide(waitingPage, "BACK");
  await waitingPage.click('[data-study-rating="again"]');
  await waitForStudyState(waitingPage, "waiting");
  const waitingEvidence = await readLatestRatingEvidence(waitingPage);
  assert(waitingEvidence.session.activeCardId === null, "Delayed work remained active before its due time");
  assert(waitingEvidence.session.plannedPresentationCount === 2, "Waiting did not retain the grown denominator");
  await waitingPage.fastForward(waitingEvidence.log.after.dueAt - waitingEvidence.log.reviewedAt + 1);
  await waitForStudyState(waitingPage, "active");
  const readyCardId = await waitingPage.evaluate<string>(
    "document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? ''",
  );
  assert(readyCardId === waitingCardId, "Delayed work did not become ready at its due instant");
  await assertNoBrowserErrors(waitingPage);

  const completionPage = await browser.newIsolatedPage();
  await startFreshSeedSession(completionPage, origin);
  await prepareSinglePresentation(completionPage, true, true);
  await completionPage.click('[data-study-action="toggle"]');
  await waitForCardSide(completionPage, "BACK");
  await completionPage.click('[data-study-rating="easy"]');
  await waitForStudyState(completionPage, "completion");
  const completed = await readLatestRatingEvidence(completionPage);
  assert(completed.session.plannedPresentationCount === 1, "Cutoff rating incorrectly grew the session");
  const completedAt = await readFirstSessionCompletion(completionPage);
  await completionPage.reload();
  await waitForStudyState(completionPage, "completion");
  await completionPage.click('[data-study-state="completion"] [data-study-action="return"]');
  await completionPage.waitForUrl(`${origin}${basePath}/`);
  await completionPage.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await completionPage.waitForUrl(`${origin}${basePath}/study/?deck=seed-spanish-basics`);
  await waitForStudyState(completionPage, "active");
  const secondSession = await completionPage.evaluate<{ label: string }>(`({
    label: document.querySelector('[data-study-session]')?.textContent?.trim() ?? '',
  })`);
  assert(secondSession.label.includes("Session 2"), "Later eligible cards did not start session 2");
  const secondSessionQueueCount = await completionPage.evaluate<number>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const get = database.transaction('sessions').objectStore('sessions').getAll();
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        database.close();
        resolve(get.result.find((session) => session.sequence === 2)?.queueEntries.length ?? -1);
      };
    };
  })`);
  assert(secondSessionQueueCount === 4, "Session 2 did not contain only omitted eligible cards");
  assert(await readFirstSessionCompletion(completionPage) === completedAt, "Starting session 2 mutated completed history");
  await assertNoBrowserErrors(completionPage);
}

async function readFirstSessionCompletion(page: BrowserPage): Promise<number> {
  return page.evaluate<number>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const get = database.transaction('sessions').objectStore('sessions').getAll();
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        database.close();
        resolve(get.result.find((session) => session.sequence === 1)?.completedAt ?? 0);
      };
    };
  })`);
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
  assert(back.side === "back", "Study did not restore the persisted back side");
  assert(back.body.includes("hello"), "Back study state omitted persisted back content");

  await mutateCurrentStudySession(page, "waiting");
  await page.reload();
  await waitForStudyState(page, "waiting");
  const waiting = await readStudyPresentation(page);
  assert(waiting.body.includes("Waiting for the next card"), "Waiting state omitted its heading");
  assert(waiting.body.includes("Next card in"), "Waiting state omitted its service-provided due time");
  assert(waiting.body.includes("not complete"), "Waiting state was presented as complete");
  const waitingSessionProgress = await page.evaluate<{ completed: number; planned: number }>(`new Promise((resolve, reject) => {
    const request = indexedDB.open('anki-web-mcp');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const get = database.transaction('sessions').objectStore('sessions').getAll();
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        database.close();
        const session = get.result.filter((item) => item.deckId === 'seed-spanish-basics')
          .sort((left, right) => left.sequence - right.sequence).at(-1);
        resolve({ completed: session?.completedPresentationCount ?? -1, planned: session?.plannedPresentationCount ?? -1 });
      };
    };
  })`);
  assert(
    waitingSessionProgress.completed === 1 && waitingSessionProgress.planned === 2,
    "Waiting state lost durable session progress",
  );

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
    side: document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? '',
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

async function assertHostileStudySideEvidence(page: BrowserPage, width: number): Promise<void> {
  const initial = await page.observeVisibleStudyCard();
  assert(initial.side === "front" && initial.detail === null, `${width}px study observer missed the real front side`);

  await page.evaluate<void>(`document.querySelector('[data-flashcard]')?.setAttribute('data-flashcard-side', 'copied-front')`);
  assert(
    (await page.observeVisibleStudyCard()).detail === "study-side-invalid:copied-front",
    `${width}px study observer accepted malformed or copied side evidence`,
  );
  await page.evaluate<void>(`document.querySelector('[data-flashcard]')?.setAttribute('data-flashcard-side', 'front')`);

  await page.evaluate<void>(`(() => {
    const duplicate = document.createElement('span');
    duplicate.setAttribute('data-flashcard-side', 'back');
    duplicate.setAttribute('data-observer-lookalike', 'duplicate');
    document.querySelector('[data-study-state]')?.append(duplicate);
  })()`);
  assert(
    (await page.observeVisibleStudyCard()).detail === "study-side-count:2",
    `${width}px study observer accepted conflicting side candidates`,
  );
  await page.evaluate<void>(`document.querySelector('[data-observer-lookalike="duplicate"]')?.remove()`);

  await page.evaluate<void>(`(() => {
    const stale = document.querySelector('[data-flashcard]')?.cloneNode(true);
    if (!(stale instanceof HTMLElement)) return;
    stale.hidden = true;
    stale.setAttribute('data-observer-lookalike', 'stale');
    document.body.append(stale);
  })()`);
  assert(
    (await page.observeVisibleStudyCard()).detail === "study-card-count:2",
    `${width}px study observer accepted a hidden stale card`,
  );
  await page.evaluate<void>(`document.querySelector('[data-observer-lookalike="stale"]')?.remove()`);

  await page.evaluate<void>(`document.querySelector('[data-study-page]')?.setAttribute('hidden', '')`);
  assert(
    (await page.observeVisibleStudyCard()).detail === "study-card-hidden",
    `${width}px study observer accepted a card inside a hidden study page`,
  );
  await page.evaluate<void>(`document.querySelector('[data-study-page]')?.removeAttribute('hidden')`);

  await page.evaluate<void>(`(() => {
    const identity = document.querySelector('[data-study-card-id]');
    if (identity) document.body.append(identity);
  })()`);
  assert(
    (await page.observeVisibleStudyCard()).detail === "study-card-identity-outside-page",
    `${width}px study observer combined identity and card evidence across page containers`,
  );
  await page.evaluate<void>(`(() => {
    const identity = document.querySelector('[data-study-card-id]');
    const session = document.querySelector('[data-study-session]');
    if (identity && session) session.append(identity);
  })()`);

  assert(
    (await page.observeVisibleStudyCard()).side === "front",
    `${width}px study observer did not recover after hostile DOM checks`,
  );
}

async function assertObservedStudyCard(
  page: BrowserPage,
  width: number,
  step: string,
  side: "front" | "back",
  expectedCardId?: string,
): Promise<VisibleStudyCardObservation> {
  const observation = await page.observeVisibleStudyCard();
  assert(
    observation.state === "active"
      && observation.side === side
      && observation.detail === null
      && (expectedCardId === undefined || observation.cardId === expectedCardId),
    `${width}px study observer did not report the authoritative ${side} card at ${step}: ${JSON.stringify(observation)}`,
  );
  return observation;
}

async function verifyMobileStudyObserverSequence(
  browser: Browser,
  origin: string,
): Promise<void> {
  const page = await browser.newIsolatedPage();
  await page.setViewport(mobileViewport);
  await startFreshSeedSession(page, origin);

  const initial = await assertObservedStudyCard(
    page,
    mobileViewport.width,
    "initial study",
    "front",
  );
  assert(initial.cardId !== null, "320px observer omitted the initial selected card identity");

  await page.click('[data-study-action="toggle"]');
  await waitForCardSide(page, "BACK");
  await assertObservedStudyCard(
    page,
    mobileViewport.width,
    "reveal",
    "back",
    initial.cardId,
  );

  await page.click('[data-study-rating="good"]');
  const rated = await waitFor(
    async () => page.observeVisibleStudyCard().then((observation) =>
      observation.side === "front" && observation.cardId !== initial.cardId
        ? observation
        : false
    ),
    "the 320px observed post-rating card",
  );
  assert(rated.detail === null, `320px post-rating observer failed closed: ${rated.detail}`);
  assert(rated.cardId !== null, "320px observer omitted the post-rating selected card identity");

  await page.click('[data-study-action="suspend"]');
  const suspended = await waitFor(
    async () => page.observeVisibleStudyCard().then((observation) =>
      observation.side === "front" && observation.cardId !== rated.cardId
        ? observation
        : false
    ),
    "the 320px observed post-suspension card",
  );
  assert(suspended.detail === null, `320px post-suspension observer failed closed: ${suspended.detail}`);
  assert(suspended.cardId !== null, "320px observer omitted the post-suspension selected card identity");

  await page.press('[data-rating-grid]', "Escape");
  await page.waitForUrl(`${origin}${basePath}/`);
  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await page.waitForUrl(`${origin}${basePath}/study/?deck=seed-spanish-basics`);
  await waitForStudyState(page, "active");
  const resumed = await assertObservedStudyCard(
    page,
    mobileViewport.width,
    "route resume",
    "front",
    suspended.cardId,
  );

  // The production lifecycle probe starts navigation cancellation from this
  // exact ready/front snapshot. Assert it independently at mobile width so a
  // copied durable/tool side cannot stand in for the rendered Flashcard.
  await assertObservedStudyCard(
    page,
    mobileViewport.width,
    "navigation-cancellation setup",
    "front",
    resumed.cardId ?? undefined,
  );
  await assertNoBrowserErrors(page);
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
  await assertFreshSeedObservation(page, mobileViewport.width);
  await page.click('[data-deck-row][data-deck-id="seed-spanish-basics"] [data-deck-action="study"]');
  await page.waitForUrl(`${origin}${basePath}/study/?deck=seed-spanish-basics`);
  await waitForStudyState(page, "active");
  await assertHostileStudySideEvidence(page, mobileViewport.width);

  for (const route of [
    { name: "root", path: `${basePath}/` },
    { name: "study", path: `${basePath}/study/?deck=seed-spanish-basics` },
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
      const mobileRatingLayout = await page.evaluate<{ columns: number; touchTargets: boolean; hasSuspend: boolean }>(`(() => {
        const group = document.querySelector('[data-rating-group]');
        const suspend = document.querySelector('[data-study-action="suspend"]');
        const columns = group ? getComputedStyle(group).gridTemplateColumns.split(' ').length : 0;
        const touchTargets = Array.from(document.querySelectorAll('[data-study-action="rate"]'))
          .every((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          });
        return { columns, touchTargets, hasSuspend: Boolean(suspend) };
      })()`);
      assert(mobileRatingLayout.columns === 4, "Mobile ratings did not stay on one row");
      assert(mobileRatingLayout.touchTargets, "Mobile study controls were smaller than 44px");
      assert(!mobileRatingLayout.hasSuspend, "Mobile study still displayed Suspend");
      const frontCardHeight = await page.evaluate<number>(
        `document.querySelector('[data-flashcard-surface]')?.getBoundingClientRect().height ?? 0`,
      );
      await page.click('[data-study-action="toggle"]');
      await waitFor(
        async () => page.evaluate<string>(
          `document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? ''`,
        ).then((side) => side === "back" ? side : false),
        "the mobile answer side",
      );
      const cardLayout = await page.evaluate<{
        answerFillsCard: boolean;
        horizontalOverflow: boolean;
        mobileShowsOneSide: boolean;
        stableHeight: boolean;
        toggleSeparated: boolean;
      }>(`(() => {
        const surface = document.querySelector('[data-flashcard-surface]');
        const back = document.querySelector('[data-flashcard-answer]');
        const toggle = document.querySelector('[data-flashcard-toggle-control]');
        if (!surface || !back || !toggle) return {
          answerFillsCard: false, horizontalOverflow: true, mobileShowsOneSide: false,
          stableHeight: false, toggleSeparated: false,
        };
        const surfaceRect = surface.getBoundingClientRect();
        const backRect = back.getBoundingClientRect();
        const toggleRect = toggle.getBoundingClientRect();
        return {
          answerFillsCard: Math.abs(backRect.width - surfaceRect.width) <= 2
            && Math.abs(backRect.height - surfaceRect.height) <= 2,
          horizontalOverflow: back.scrollWidth > back.clientWidth,
          mobileShowsOneSide: !document.querySelector('[data-flashcard-front-context]')
            && getComputedStyle(back).display !== 'none',
          stableHeight: Math.abs(surfaceRect.height - ${frontCardHeight}) <= 1,
          toggleSeparated: toggleRect.top >= surfaceRect.bottom,
        };
      })()`);
      assert(cardLayout.mobileShowsOneSide, "Mobile study did not replace the prompt with the answer");
      assert(cardLayout.answerFillsCard, "Mobile answer did not fill the card surface");
      assert(cardLayout.stableHeight, "Mobile card height changed while revealing the answer");
      assert(!cardLayout.horizontalOverflow, "Study pane created horizontal scrolling");
      assert(cardLayout.toggleSeparated, "Flip control was not separated from resizable card content");
      await page.click('[data-study-action="toggle"]');
      await waitFor(
        async () => page.evaluate<string>(
          `document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? ''`,
        ).then((side) => side === "front" ? side : false),
        "the restored mobile front side",
      );
      const disabledRatings = await page.evaluate<number>(
        `document.querySelectorAll('[data-study-action="rate"]:disabled').length`,
      );
      assert(disabledRatings === 0, "Mobile ratings were not available before reveal");
    }
    await assertNoBrowserErrors(page);
  }

  await verifyMobileStudyObserverSequence(browser, origin);
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
    async () => page.evaluate<string[]>(
      "window.__webmcpPresentationContext.getTools().then((tools) => tools.map((tool) => tool.name))",
    ).then((names) => names.length === 3 ? names : false),
    "the production home tools",
  );

  const readyResult = await page.evaluate<{
    toolNames: string[];
    registrationOptionNames: string[];
    listed: Record<string, unknown> | null;
    restored: Record<string, unknown> | null;
    invalid: Record<string, unknown> | null;
  }>(`(async () => {
    const registration = window.__rootWebMcpPresentation;
    const tools = await registration.modelContext.getTools();
    const list = tools.find((tool) => tool.name === 'list_decks');
    const restore = tools.find((tool) => tool.name === 'restore_suspended');
    const listed = list ? await list.execute({}) : null;
    const restored = restore
      ? await restore.execute({ deck_id: 'seed-spanish-basics', command_id: 'browser-restore' })
      : null;
    const invalid = restore ? await restore.execute({ deck_id: '' }) : null;
    return {
      toolNames: tools.map((tool) => tool.name),
      registrationOptionNames: Object.keys(registration?.options ?? {}).sort(),
      listed,
      restored,
      invalid,
    };
  })()`);
  assert(
    JSON.stringify(readyResult.toolNames) === JSON.stringify(["list_decks", "select_deck", "restore_suspended"]),
    `Home exposed the wrong production tools: ${readyResult.toolNames.join(", ")}`,
  );
  assert(readyResult.registrationOptionNames.length === 1 && readyResult.registrationOptionNames[0] === "signal", "Production registration exposed cross-origin options");
  assert(readyResult.listed?.ok === true, "list_decks rejected an empty input");
  const listedData = readyResult.listed?.data as { page?: unknown; decks?: unknown[] } | undefined;
  assert(listedData?.page === "decks" && listedData.decks?.length === 1, "list_decks did not match the visible seeded row");
  assert(readyResult.restored?.ok === true, "restore_suspended rejected a valid command");
  assert(readyResult.invalid?.ok === false, "restore_suspended accepted invalid input");
  const invalidError = readyResult.invalid?.error as { code?: unknown } | undefined;
  assert(invalidError?.code === "INVALID_INPUT", "restore_suspended returned the wrong invalid-input envelope");
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
      "document.querySelector('[data-deck-page-state]')?.getAttribute('data-deck-page-state') ?? ''",
    ).then((status) => status === "populated" ? status : false),
    "the usable home route after registration rejection",
  );
  const rejectedTools = await page.evaluate<string[]>(
    "window.__webmcpPresentationContext.getTools().then((tools) => tools.map((tool) => tool.name))",
  );
  assert(rejectedTools.length === 0, "Rejected registration left a partially exposed home tool set");
  await assertNoBrowserErrors(page);

  await page.setViewport(desktopViewport);
  page.clearDiagnostics();
  await page.navigate(`${origin}${basePath}/study/?deck=seed-spanish-basics&__webmcp_probe=study-ready`);
  await waitFor(
    async () => page.evaluate<string[]>(
      "window.__webmcpPresentationContext.getTools().then((tools) => tools.map((tool) => tool.name))",
    ).then((names) => names.length === 5 ? names : false),
    "the production study tools",
  );

  const studyReadyResult = await page.evaluate<{
    toolNames: string[];
    front: Record<string, unknown> | null;
    flipped: Record<string, unknown> | null;
    rated: Record<string, unknown> | null;
    invalid: Record<string, unknown> | null;
    cancelled: Record<string, unknown> | null;
  }>(`(async () => {
    const tools = await window.__webmcpPresentationContext.getTools();
    const getState = tools.find((tool) => tool.name === 'get_state');
    const flip = tools.find((tool) => tool.name === 'flip');
    const setState = tools.find((tool) => tool.name === 'set_state');
    const front = getState ? await getState.execute({}) : null;
    const cardId = front?.data?.state?.current_card?.id;
    const invalid = setState
      ? await setState.execute({ card_id: cardId, command_id: 'browser-invalid', rating: 'best' })
      : null;
    const abortController = new AbortController();
    abortController.abort();
    const cancelled = flip
      ? await flip.execute(
        { card_id: cardId, command_id: 'browser-cancelled' },
        { signal: abortController.signal },
      )
      : null;
    const flipped = flip
      ? await flip.execute({ card_id: cardId, command_id: 'browser-flip' })
      : null;
    const rated = setState
      ? await setState.execute({ card_id: cardId, command_id: 'browser-rate', rating: 'good' })
      : null;
    return {
      toolNames: tools.map((tool) => tool.name),
      front,
      flipped,
      rated,
      invalid,
      cancelled,
    };
  })()`);
  assert(
    JSON.stringify(studyReadyResult.toolNames) ===
      JSON.stringify(["get_state", "flip", "set_state", "suspend", "go_home"]),
    `Study exposed the wrong production tools: ${studyReadyResult.toolNames.join(", ")}`,
  );
  const frontState = studyReadyResult.front?.data as { state?: { current_card?: Record<string, unknown> } } | undefined;
  assert(studyReadyResult.front?.ok === true, "get_state rejected an empty input");
  assert(frontState?.state?.current_card?.side === "front", "get_state did not return the visible front side");
  assert(!Object.hasOwn(frontState?.state?.current_card ?? {}, "back_text"), "get_state disclosed the back before reveal");
  assert(studyReadyResult.flipped?.ok === true, "flip rejected the current card");
  assert(studyReadyResult.rated?.ok === true, "set_state rejected the revealed current card");
  assert(studyReadyResult.invalid?.ok === false, "set_state accepted an invalid rating");
  assert((studyReadyResult.invalid?.error as { code?: string } | undefined)?.code === "INVALID_INPUT", "set_state returned the wrong invalid-input envelope");
  assert(studyReadyResult.cancelled?.ok === false, "An aborted study call was accepted");
  assert((studyReadyResult.cancelled?.error as { code?: string } | undefined)?.code === "WRONG_PAGE", "An aborted study call returned the wrong envelope");
  const ratedState = (studyReadyResult.rated?.data as {
    state?: {
      current_card?: { id?: string; side?: string } | null;
      session?: { completed_presentations?: number; planned_presentations?: number };
    };
  } | undefined)?.state;
  const expectedCardId = ratedState?.current_card?.id;
  assert(Boolean(expectedCardId), "Tool rating did not return the next current card");
  const visibleStudyState = await waitFor(
    async () => page.evaluate<{ cardId: string; side: string }>(`({
      cardId: document.querySelector('[data-study-card-id]')?.textContent?.trim() ?? '',
      side: document.querySelector('[data-flashcard-side]')?.getAttribute('data-flashcard-side') ?? '',
    })`).then((visible) => visible.cardId === expectedCardId ? visible : false),
    "the tool-committed visible study state",
  );
  assert(visibleStudyState.side === "front", "Tool rating did not advance the visible UI to the next front");
  await assertNoBrowserErrors(page);

  const studyToolsBeforeNavigation = await page.evaluate<string[]>(
    "window.__webmcpPresentationContext ? window.__webmcpPresentationContext.getTools().then((tools) => tools.map((tool) => tool.name)) : []",
  );
  assert(
    JSON.stringify(studyToolsBeforeNavigation) ===
      JSON.stringify(["get_state", "flip", "set_state", "suspend", "go_home"]),
    "Study presentation did not expose only the production study tools",
  );

  await page.click('[data-study-header] [data-study-action="return"]');
  await waitFor(
    async () => page.evaluate<string>("location.pathname").then((pathname) => pathname === `${basePath}/` ? pathname : false),
    "navigation from study to root",
  );
  const rootToolsAfterNavigation = await waitFor(
    async () => page.evaluate<string[]>(
      "window.__webmcpPresentationContext ? window.__webmcpPresentationContext.getTools().then((tools) => tools.map((tool) => tool.name)) : []",
    ).then((tools) => JSON.stringify(tools) ===
      JSON.stringify(["list_decks", "select_deck", "restore_suspended"])
      ? tools
      : false),
    "the root production tools after study navigation",
  );
  assert(
    JSON.stringify(rootToolsAfterNavigation) ===
      JSON.stringify(["list_decks", "select_deck", "restore_suspended"]),
    "Study tool remained discoverable after navigating to root",
  );

  await assertNoBrowserErrors(page);

  await page.setViewport(mobileViewport);
  page.clearDiagnostics();
  await page.navigate(`${origin}${basePath}/study/?deck=seed-spanish-basics&__webmcp_probe=study-ready`);
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
  await page.navigate(`${origin}${basePath}/study/?deck=seed-spanish-basics&__webmcp_probe=study-error`);
  await waitFor(
    async () => page.evaluate<string>(
      "document.querySelector('[data-study-page]')?.getAttribute('data-study-page') ?? 'ready'",
    ).then((status) => status ? status : false),
    "the usable study route after registration rejection",
  );
  const rejectedStudyTools = await page.evaluate<string[]>(
    "window.__webmcpPresentationContext.getTools().then((tools) => tools.map((tool) => tool.name))",
  );
  assert(rejectedStudyTools.length === 0, "Rejected registration left a partially exposed study tool set");
  const usableStudy = await page.evaluate<boolean>(
    "document.querySelector('[data-study-state=\"active\"]') !== null",
  );
  assert(usableStudy, "Study registration rejection broke the human study UI");
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
    await verifyProductionImportJourneys(browser, staticServer.origin);
    await verifyProductionRemovalJourneys(browser, staticServer.origin);
    await verifyStudyRoute(browser, staticServer.origin);
    await verifyIsolatedProductionJourneys(browser, staticServer.origin);
    await verifyStudyRouteStates(browser, staticServer.origin);
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
