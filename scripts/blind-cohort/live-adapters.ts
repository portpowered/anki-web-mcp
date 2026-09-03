import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";

import type {
  BlindProbeTask,
  PublicWebMcpPort,
  RestrictedProbeInput,
  SemanticBrowserPort,
} from "./contract";
import type { FailureCategory, TranscriptEvent, TrustedObservation, TrustedProbeObserver } from "./evidence";
import {
  REQUIRED_BROWSER_VERSION,
  type ProbeAgentContext,
  type ProbeAttemptResult,
  type ProbeBrowserContext,
} from "./runner";

const repositoryRoot = resolve(import.meta.dir, "../..");
const allowedOrigin = new URL("https://portpowered.github.io/anki-web-mcp/").origin;
const fixturePaths = {
  "short-session": join(repositoryRoot, "spikes/apkg-compatibility/fixtures/synthetic/current-anki21b.apkg"),
  "valid-import": join(repositoryRoot, "spikes/apkg-compatibility/fixtures/synthetic/current-anki21b.apkg"),
  "corrupt-import": join(repositoryRoot, "spikes/apkg-compatibility/fixtures/synthetic/invalid-sqlite.apkg"),
} as const;

export interface LiveTranscript {
  readonly events: TranscriptEvent[];
  append(channel: TranscriptEvent["channel"], action: string, result: unknown): void;
}

export interface ObservableProbeBrowser extends ProbeBrowserContext {
  captureRawObservation(): Promise<{ readonly url: string; readonly aria: string; readonly durable: unknown }>;
}

export function createLiveTranscript(): LiveTranscript {
  const events: TranscriptEvent[] = [];
  return {
    events,
    append(channel, action, result) {
      events.push({ sequence: events.length + 1, at: new Date().toISOString(), channel, action, result });
    },
  };
}

export class PlaywrightProbeBrowser implements ProbeBrowserContext {
  readonly profileId = `profile-${randomUUID()}`;
  readonly semanticBrowser: SemanticBrowserPort;
  readonly publicWebMcp: PublicWebMcpPort;

  private constructor(
    readonly userDataDirectory: string,
    readonly browserVersion: string,
    private readonly context: BrowserContext,
    readonly page: Page,
    readonly transcript: LiveTranscript,
  ) {
    this.semanticBrowser = {
      observe: async () => await this.visibleOperation("observe", async () => await this.page.locator("body").ariaSnapshot()),
      activate: async (role, accessibleName) => await this.visibleOperation("activate", async () => {
        await this.page.getByRole(asRole(role), { name: accessibleName, exact: true }).click();
        return { role, accessibleName, url: this.page.url() };
      }),
      enterText: async (role, accessibleName, value) => await this.visibleOperation("enterText", async () => {
        await this.page.getByRole(asRole(role), { name: accessibleName, exact: true }).fill(value);
        return { role, accessibleName, valueLength: value.length };
      }),
      attachFixture: async (accessibleName, fixtureId) => await this.visibleOperation("attachFixture", async () => {
        const fixturePath = fixturePaths[fixtureId];
        await this.page.getByLabel(accessibleName, { exact: true }).setInputFiles(fixturePath);
        return { accessibleName, fixtureId, file: basename(fixturePath) };
      }),
    };
    this.publicWebMcp = {
      discover: async () => {
        try {
          const tools = await readPublicTools(this.page);
          this.transcript.append("webmcp", "discover", tools);
          return tools;
        } catch (error) {
          this.transcript.append("webmcp", "discover", { error: safeCapabilityError(error) });
          throw error;
        }
      },
      invoke: async (name, input) => {
        try {
          const result = await invokePublicTool(this.page, name, input);
          this.transcript.append("webmcp", `invoke:${name}`, result);
          return result;
        } catch (error) {
          this.transcript.append("webmcp", `invoke:${name}`, { error: safeCapabilityError(error) });
          throw error;
        }
      },
    };
  }

  static async create(options: {
    readonly viewport: BlindProbeTask["viewport"];
    readonly transcript: LiveTranscript;
    readonly executablePath?: string;
  }): Promise<PlaywrightProbeBrowser> {
    const userDataDirectory = await mkdtemp(join(tmpdir(), "webmcp-blind-profile-"));
    try {
      const executablePath = options.executablePath ?? await findChromeExecutable();
      const context = await chromium.launchPersistentContext(userDataDirectory, {
        executablePath,
        headless: true,
        viewport: options.viewport,
        serviceWorkers: "block",
        args: [
          "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
          "--disable-component-update", "--disable-extensions", "--disable-sync", "--no-sandbox",
        ],
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === allowedOrigin || url.protocol === "data:" || url.protocol === "blob:") await route.continue();
        else await route.abort("blockedbyclient");
      });
      const page = context.pages()[0] ?? await context.newPage();
      return new PlaywrightProbeBrowser(
        userDataDirectory,
        context.browser()?.version() ?? "unknown",
        context,
        page,
        options.transcript,
      );
    } catch (error) {
      await rm(userDataDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async verifyIndexedDbEmpty(publicUrl: string): Promise<boolean> {
    const session = await this.context.newCDPSession(this.page);
    const usage = await session.send("Storage.getUsageAndQuota", { origin: new URL(publicUrl).origin });
    const initiallyEmpty = usage.usage === 0;
    await session.detach();
    if (!initiallyEmpty) return false;
    const response = await this.page.goto(publicUrl, { waitUntil: "networkidle", timeout: 30_000 });
    if (!response?.ok()) return false;
    return true;
  }

  async captureRawObservation(): Promise<{ readonly url: string; readonly aria: string; readonly durable: unknown }> {
    const [aria, durable] = await Promise.all([
      this.page.locator("body").ariaSnapshot(),
      readSafeIndexedDbProjection(this.page),
    ]);
    return { url: this.page.url(), aria, durable };
  }

  async close(): Promise<void> { await this.context.close(); }
  async removeProfile(): Promise<void> { await rm(this.userDataDirectory, { recursive: true, force: false }); }

  private async visibleOperation(action: string, operation: () => Promise<unknown>): Promise<unknown> {
    try {
      const result = await operation();
      this.transcript.append("visible", action, result);
      return result;
    } catch (error) {
      this.transcript.append("visible", action, { error: safeCapabilityError(error) });
      throw error;
    }
  }
}

type ResponseFunctionCall = { readonly type: "function_call"; readonly call_id: string; readonly name: string; readonly arguments: string };
type ResponseOutput = ResponseFunctionCall | Record<string, unknown>;
type ResponsesPayload = { readonly id: string; readonly output: readonly ResponseOutput[]; readonly output_text?: string };

export class ResponsesProbeAgent implements ProbeAgentContext {
  readonly contextId = `agent-${randomUUID()}`;
  private input: unknown[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async run(
    input: RestrictedProbeInput,
    control: { readonly attempt: 1 | 2; readonly signal: AbortSignal },
  ): Promise<ProbeAttemptResult> {
    if (this.input.length === 0) {
      this.input.push({ role: "user", content: JSON.stringify({
        instruction: input.instruction,
        publicUrl: input.publicUrl,
        viewport: input.viewport,
        fixture: input.fixture,
        boundary: "Use only the supplied semantic browser and public WebMCP tools. Finish with complete_probe.",
      }) });
    } else {
      this.input.push({ role: "user", content: "Retry once after the structured error. Do not repeat an unsafe or stale action." });
    }
    for (let step = 0; step < 48; step += 1) {
      const response = await createResponse(this.apiKey, control.signal, {
        model: this.model,
        store: false,
        parallel_tool_calls: false,
        instructions: "You are a blind acceptance probe. You have no source, shell, filesystem, selectors, hidden hints, prior probes, or secrets. Use only the provided tools and report observable results.",
        input: this.input,
        tools: input.fixture === null ? agentTools.filter((tool) => tool.name !== "semantic_attach_fixture") : agentTools,
      });
      this.input.push(...response.output);
      const calls = response.output.filter(isFunctionCall);
      if (calls.length === 0) throw new Error("Agent ended without complete_probe.");
      for (const call of calls) {
        const args = parseObject(call.arguments);
        if (call.name === "complete_probe") return parseCompletion(args, control.attempt);
        let output: unknown;
        try {
          output = { ok: true, result: await executeAgentTool(call.name, args, input) };
        } catch {
          output = { ok: false, error: { code: "PUBLIC_CAPABILITY_ERROR", message: "The requested public capability failed." } };
        }
        this.input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
      }
    }
    throw new Error("Agent exceeded the 48-step tool limit.");
  }

  async close(): Promise<void> { this.input = []; }
}

export class ResponsesTrustedObserver implements TrustedProbeObserver {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly browser: ObservableProbeBrowser,
    private readonly signal?: AbortSignal,
  ) {}

  async capture(task: BlindProbeTask): Promise<TrustedObservation> {
    const snapshot = await this.browser.captureRawObservation();
    const response = await createResponse(this.apiKey, this.signal, {
      model: this.model,
      store: false,
      instructions: "Act as a strict trusted observer. Compare only the supplied sanitized semantic UI and durable-state projection with every expected item. Never infer missing evidence. Echo an expected string only when directly proved. Failed or unclear evidence is ambiguous.",
      input: [{ role: "user", content: JSON.stringify({ expected: task.expected, snapshot }) }],
      text: { format: observationFormat },
    });
    const parsed = JSON.parse(responseText(response)) as TrustedObservation;
    return parsed;
  }
}

const agentTools = [
  functionTool("semantic_observe", "Read the current semantic accessibility view.", {}, []),
  functionTool("semantic_activate", "Activate a visible semantic control by ARIA role and exact accessible name.", {
    role: { type: "string" }, accessible_name: { type: "string" },
  }, ["role", "accessible_name"]),
  functionTool("semantic_enter_text", "Enter text in a visible semantic control.", {
    role: { type: "string" }, accessible_name: { type: "string" }, value: { type: "string" },
  }, ["role", "accessible_name", "value"]),
  functionTool("semantic_attach_fixture", "Attach the one permitted fixture to a visible labeled file control.", {
    accessible_name: { type: "string" }, fixture_id: { type: "string", enum: ["short-session", "valid-import", "corrupt-import"] },
  }, ["accessible_name", "fixture_id"]),
  functionTool("webmcp_discover", "Discover public WebMCP tools on the current page.", {}, []),
  functionTool("webmcp_invoke", "Invoke a discovered public WebMCP tool.", {
    name: { type: "string" }, input_json: { type: "string", description: "A JSON object encoded as a string." },
  }, ["name", "input_json"]),
  functionTool("complete_probe", "Finish the probe, reporting pass or a clear structured recoverable failure.", {
    status: { type: "string", enum: ["passed", "failed"] },
    detail: { type: ["string", "null"] },
    request_self_recovery: { type: "boolean" },
    error_code: { type: ["string", "null"] },
    error_message: { type: ["string", "null"] },
  }, ["status", "detail", "request_self_recovery", "error_code", "error_message"]),
] as const;

const observationFormat = {
  type: "json_schema",
  name: "trusted_probe_observation",
  strict: true,
  schema: {
    type: "object",
    properties: {
      finalUi: {
        type: "object",
        properties: {
          trusted: { const: true }, route: { type: "string", enum: ["home", "study"] },
          visibleState: { type: "array", items: { type: "string" } }, ambiguous: { type: "boolean" },
          failureCategory: failureCategorySchema(),
        },
        required: ["trusted", "route", "visibleState", "ambiguous", "failureCategory"], additionalProperties: false,
      },
      durableState: {
        type: "object",
        properties: {
          trusted: { const: true }, effects: { type: "array", items: { type: "string" } },
          mutatedDecks: { type: "array", items: { type: "string" } }, ambiguous: { type: "boolean" },
          failureCategory: failureCategorySchema(),
        },
        required: ["trusted", "effects", "mutatedDecks", "ambiguous", "failureCategory"], additionalProperties: false,
      },
      judgments: {
        type: "array",
        items: { type: "object", properties: {
          dimension: { type: "string", enum: ["functionality", "ux", "ui"] },
          status: { type: "string", enum: ["pass", "fail"] }, reason: { type: "string" },
        }, required: ["dimension", "status", "reason"], additionalProperties: false },
      },
      completionBasis: { type: "string", enum: ["expected-effects", "agent-claim", "wrong-reason", "ambiguous"] },
    },
    required: ["finalUi", "durableState", "judgments", "completionBasis"], additionalProperties: false,
  },
} as const;

function failureCategorySchema(): unknown {
  const categories: FailureCategory[] = [
    "tool-discovery", "ambiguous-description-schema", "missing-state", "ui-discoverability", "navigation",
    "stale-state-race", "import-compatibility", "scheduler-state-corruption", "responsive-layout", "test-environment-flake",
  ];
  return { type: ["string", "null"], enum: [null, ...categories] };
}

function functionTool(name: string, description: string, properties: Record<string, unknown>, required: string[]): Record<string, unknown> & { name: string } {
  return { type: "function", name, description, strict: true, parameters: { type: "object", properties, required, additionalProperties: false } };
}

async function executeAgentTool(name: string, args: Record<string, unknown>, input: RestrictedProbeInput): Promise<unknown> {
  switch (name) {
    case "semantic_observe": return await input.semanticBrowser.observe();
    case "semantic_activate": return await input.semanticBrowser.activate(requiredString(args, "role"), requiredString(args, "accessible_name"));
    case "semantic_enter_text": return await input.semanticBrowser.enterText(requiredString(args, "role"), requiredString(args, "accessible_name"), requiredString(args, "value"));
    case "semantic_attach_fixture": {
      const fixtureId = requiredString(args, "fixture_id");
      if (input.fixture?.id !== fixtureId) throw new Error("The requested fixture is not permitted for this probe.");
      return await input.semanticBrowser.attachFixture(requiredString(args, "accessible_name"), input.fixture.id);
    }
    case "webmcp_discover": return await input.publicWebMcp.discover();
    case "webmcp_invoke": {
      const toolInput = parseObject(requiredString(args, "input_json"));
      return await input.publicWebMcp.invoke(requiredString(args, "name"), toolInput);
    }
    default: throw new Error(`Unsupported public capability ${name}.`);
  }
}

function parseCompletion(args: Record<string, unknown>, attempt: 1 | 2): ProbeAttemptResult {
  const status = args.status === "passed" ? "passed" : "failed";
  const requestSelfRecovery = args.request_self_recovery === true;
  const errorCode = typeof args.error_code === "string" ? args.error_code : null;
  const errorMessage = typeof args.error_message === "string" ? args.error_message : null;
  return {
    status,
    detail: typeof args.detail === "string" ? args.detail : undefined,
    requestSelfRecovery,
    structuredError: requestSelfRecovery && attempt === 1 && errorCode && errorMessage
      ? { code: errorCode, message: errorMessage, recoverable: true }
      : undefined,
  };
}

function responseText(response: ResponsesPayload): string {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output) {
    const candidate: unknown = item;
    if (!isRecord(candidate) || candidate.type !== "message" || !Array.isArray(candidate.content)) continue;
    for (const content of candidate.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("Responses API returned no structured observer output.");
}

async function createResponse(apiKey: string, signal: AbortSignal | undefined, body: unknown): Promise<ResponsesPayload> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Responses API failed with HTTP ${response.status}.`);
  const payload = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.output) || typeof payload.id !== "string") {
    throw new Error("Responses API returned a malformed payload.");
  }
  return payload as ResponsesPayload;
}

async function readPublicTools(page: Page): Promise<readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[]> {
  return await page.evaluate(async () => {
    type Tool = { name?: unknown; description?: unknown; inputSchema?: unknown };
    type ModelContext = { getTools(): Promise<Tool[]> };
    const modelContext = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!modelContext) throw new Error("Public WebMCP is unavailable.");
    return (await modelContext.getTools()).map((tool) => ({
      name: typeof tool.name === "string" ? tool.name : "",
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: copyJson(tool.inputSchema),
    }));
    function copyJson(value: unknown): unknown {
      const encoded = JSON.stringify(value ?? null);
      return encoded === undefined ? null : JSON.parse(encoded);
    }
  });
}

async function invokePublicTool(page: Page, name: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
  return await page.evaluate(async ({ toolName, jsonInput }) => {
    type Tool = { name?: unknown };
    type ModelContext = { getTools(): Promise<Tool[]>; executeTool(tool: Tool, input: string): Promise<unknown> };
    const modelContext = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!modelContext) throw new Error("Public WebMCP is unavailable.");
    const tool = (await modelContext.getTools()).find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Public WebMCP tool ${toolName} is unavailable.`);
    return await modelContext.executeTool(tool, jsonInput);
  }, { toolName: name, jsonInput: JSON.stringify(input) });
}

async function readSafeIndexedDbProjection(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const request = indexedDB.open("anki-web-mcp");
    const database = await new Promise<IDBDatabase>((resolveRequest, rejectRequest) => {
      request.onsuccess = () => resolveRequest(request.result);
      request.onerror = () => rejectRequest(request.error);
    });
    try {
      const stores = [...database.objectStoreNames];
      if (stores.length === 0) return { stores: [] };
      const transaction = database.transaction(stores, "readonly");
      const summaries = await Promise.all(stores.map(async (name) => {
        const store = transaction.objectStore(name);
        const countRequest = store.count();
        const recordsRequest = store.getAll();
        const count = await new Promise<number>((resolveCount, rejectCount) => {
          countRequest.onsuccess = () => resolveCount(countRequest.result);
          countRequest.onerror = () => rejectCount(countRequest.error);
        });
        const records = await new Promise<unknown[]>((resolveRecords, rejectRecords) => {
          recordsRequest.onsuccess = () => resolveRecords(recordsRequest.result as unknown[]);
          recordsRequest.onerror = () => rejectRecords(recordsRequest.error);
        });
        const safeKeys = new Set([
          "id", "deckId", "importId", "name", "cardCount", "lastStudiedAt", "sessionIntakeLimit",
          "cardId", "state", "reps", "lapses", "suspended", "sessionId", "rating", "reviewedAt",
          "completedPresentationCount", "plannedPresentationCount", "currentSide", "completedAt", "activeCardId",
          "packageVersion", "fileName", "fileSize", "importedAt",
        ]);
        const safeRecords = records.map((record) => {
          if (record === null || typeof record !== "object") return null;
          return Object.fromEntries(Object.entries(record as Record<string, unknown>)
            .filter(([key, value]) => safeKeys.has(key) && (value === null || ["string", "number", "boolean"].includes(typeof value))));
        });
        return { name, count, records: safeRecords };
      }));
      return { stores: summaries };
    } finally {
      database.close();
    }
  });
}

async function findChromeExecutable(): Promise<string> {
  const candidates = [
    process.env.BLIND_COHORT_CHROME_PATH,
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((path): path is string => Boolean(path));
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try the next explicit location */ }
  }
  throw new Error("Chrome executable was not found; set BLIND_COHORT_CHROME_PATH.");
}

function asRole(role: string): Parameters<Page["getByRole"]>[0] { return role as Parameters<Page["getByRole"]>[0]; }
function isFunctionCall(value: ResponseOutput): value is ResponseFunctionCall { return value.type === "function_call"; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function parseObject(value: string): Record<string, unknown> { const parsed: unknown = JSON.parse(value); if (!isRecord(parsed)) throw new Error("Tool arguments must be an object."); return parsed; }
function requiredString(record: Record<string, unknown>, key: string): string { const value = record[key]; if (typeof value !== "string" || value === "") throw new Error(`Tool argument ${key} is required.`); return value; }
function safeCapabilityError(error: unknown): string { return error instanceof Error ? error.name : "CapabilityError"; }

export function assertLiveBrowserVersion(browser: PlaywrightProbeBrowser): void {
  if (browser.browserVersion !== REQUIRED_BROWSER_VERSION) {
    throw new Error(`Expected Chrome ${REQUIRED_BROWSER_VERSION}, found ${browser.browserVersion}.`);
  }
}
