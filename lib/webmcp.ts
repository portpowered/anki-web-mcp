export const webMcpOrigin = "https://portpowered.github.io";

export const webMcpOriginTrialToken =
  "A/MXFu/smsk8zDkOidDtDxnHQbr502frxTfbhB94iRy6Tc8m6BzqVCh3DibOCvEGdPiGm4+ww+AZkNN77vNnTgkAAABpeyJvcmlnaW4iOiJodHRwczovL3BvcnRwb3dlcmVkLmdpdGh1Yi5pbzo0NDMiLCJmZWF0dXJlIjoiV2ViTUNQIiwiZXhwaXJ5IjoxNzk0ODczNjAwLCJpc1RoaXJkUGFydHkiOnRydWV9";

export const diagnosticToolName = "webmcp_diagnostic_increment";
export const diagnosticToolRoute = "/";
export const diagnosticCounterMinimumIncrement = 1;
export const diagnosticCounterMaximumIncrement = 10;
export const diagnosticCommandIdMaximumLength = 64;

export const diagnosticToolInputSchema = {
  type: "object",
  properties: {
    amount: {
      type: "integer",
      minimum: diagnosticCounterMinimumIncrement,
      maximum: diagnosticCounterMaximumIncrement,
      description: "Whole-number increment from 1 through 10.",
    },
    command_id: {
      type: "string",
      minLength: 1,
      maxLength: diagnosticCommandIdMaximumLength,
      description: "Unique identifier for this command; retries reuse the same identifier.",
    },
  },
  required: ["amount", "command_id"],
  additionalProperties: false,
} as const;

export type WebMcpCapability =
  | { kind: "available" }
  | { kind: "unavailable" }
  | { kind: "error" };

export type WebMcpDocument = {
  readonly modelContext?: unknown;
  readonly location?: { readonly origin?: string };
  readonly querySelector?: (
    selectors: string,
  ) => WebMcpMetaElementLike | null;
};

export type WebMcpMetaElementLike = {
  getAttribute?: (name: string) => string | null;
  content?: string;
};

export type WebMcpToolClient = {
  readonly signal?: AbortSignal;
};

export type WebMcpTool = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: typeof diagnosticToolInputSchema;
  readonly annotations: {
    readonly readOnlyHint: false;
    readonly untrustedContentHint: false;
  };
  readonly execute: (
    input: unknown,
    client?: WebMcpToolClient,
  ) => Promise<DiagnosticToolResult>;
};

export type WebMcpModelContext = {
  registerTool: (
    tool: WebMcpTool,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<void> | void;
};

export type WebMcpSurfaceProbe =
  | { kind: "available"; modelContext: WebMcpModelContext }
  | { kind: "unavailable" }
  | { kind: "error"; error: string };

export type WebMcpOriginTrialStatus =
  | "accepted"
  | "rejected"
  | "expired"
  | "mismatched"
  | "not-required"
  | "unknown";

export type DiagnosticToolResult =
  | {
      status: "applied";
      code: "ok";
      route: typeof diagnosticToolRoute;
      command: typeof diagnosticToolName;
      command_id: string;
      amount: number;
      counter: number;
    }
  | {
      status: "rejected";
      code: "invalid-input" | "duplicate-command";
      route: typeof diagnosticToolRoute;
      command: typeof diagnosticToolName;
      command_id: string | null;
      amount: number | null;
      counter: number;
      message: string;
    }
  | {
      status: "cancelled";
      code: "execution-cancelled";
      route: typeof diagnosticToolRoute;
      command: typeof diagnosticToolName;
      command_id: string | null;
      amount: number | null;
      counter: number;
      message: string;
    };

export type DiagnosticCounterController = {
  readonly tool: WebMcpTool;
  readonly execute: (
    input: unknown,
    client?: WebMcpToolClient,
  ) => Promise<DiagnosticToolResult>;
  readonly getCounter: () => number;
};

export function probeWebMcpSurface(
  documentLike: object,
): WebMcpSurfaceProbe {
  try {
    const modelContext = (documentLike as WebMcpDocument).modelContext;

    if (modelContext == null) {
      return { kind: "unavailable" };
    }

    if (
      typeof modelContext !== "object" ||
      typeof (modelContext as { registerTool?: unknown }).registerTool !==
        "function"
    ) {
      return {
        kind: "error",
        error: "The native modelContext surface has no registerTool method.",
      };
    }

    return {
      kind: "available",
      modelContext: modelContext as WebMcpModelContext,
    };
  } catch (error) {
    return { kind: "error", error: describeWebMcpError(error) };
  }
}

/**
 * Read the browser's native WebMCP surface without installing or mutating it.
 * A throwing browser getter is reported separately from an absent API so the
 * human diagnostic remains useful in both cases.
 */
export function detectWebMcpCapability(
  documentLike: object,
): WebMcpCapability {
  const probe = probeWebMcpSurface(documentLike);

  if (probe.kind === "available") {
    return { kind: "available" };
  }

  return { kind: probe.kind };
}

export function createDiagnosticCounterController(
  onCounterChange: (counter: number) => void,
  isActive: () => boolean = () => true,
): DiagnosticCounterController {
  let counter = 0;
  const commandIds = new Set<string>();

  const execute = async (
    input: unknown,
    client: WebMcpToolClient = {},
  ): Promise<DiagnosticToolResult> => {
    const parsed = parseDiagnosticInput(input);

    if (!isActive() || client.signal?.aborted) {
      return {
        status: "cancelled",
        code: "execution-cancelled",
        route: diagnosticToolRoute,
        command: diagnosticToolName,
        command_id: parsed.commandId,
        amount: parsed.amount,
        counter,
        message: "The root diagnostic is no longer active or the command was aborted.",
      };
    }

    if (!parsed.valid) {
      return {
        status: "rejected",
        code: "invalid-input",
        route: diagnosticToolRoute,
        command: diagnosticToolName,
        command_id: parsed.commandId,
        amount: parsed.amount,
        counter,
        message: parsed.message,
      };
    }

    if (commandIds.has(parsed.commandId)) {
      return {
        status: "rejected",
        code: "duplicate-command",
        route: diagnosticToolRoute,
        command: diagnosticToolName,
        command_id: parsed.commandId,
        amount: parsed.amount,
        counter,
        message: "The command_id was already applied; no second mutation occurred.",
      };
    }

    commandIds.add(parsed.commandId);
    counter += parsed.amount;
    onCounterChange(counter);

    return {
      status: "applied",
      code: "ok",
      route: diagnosticToolRoute,
      command: diagnosticToolName,
      command_id: parsed.commandId,
      amount: parsed.amount,
      counter,
    };
  };

  return {
    tool: {
      name: diagnosticToolName,
      title: "Increment the root diagnostic counter",
      description:
        "Non-production diagnostic only. Increase the current root route's in-memory counter by a whole number from 1 through 10. Supply a unique command_id for a new command and reuse it for retries. Returns a structured object with status, code, route, command, command_id, amount, and counter; invalid or duplicate commands never mutate the counter.",
      inputSchema: diagnosticToolInputSchema,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: false,
      },
      execute,
    },
    execute,
    getCounter: () => counter,
  };
}

type ParsedDiagnosticInput =
  | {
      valid: true;
      commandId: string;
      amount: number;
      message: string;
    }
  | {
      valid: false;
      commandId: string | null;
      amount: number | null;
      message: string;
    };

function parseDiagnosticInput(input: unknown): ParsedDiagnosticInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      commandId: null,
      amount: null,
      message: "Input must be an object with amount and command_id.",
    };
  }

  const candidate = input as Record<string, unknown>;
  const commandId = typeof candidate.command_id === "string"
    ? candidate.command_id
    : null;
  const amount = typeof candidate.amount === "number" ? candidate.amount : null;
  const allowedKeys = new Set(["amount", "command_id"]);
  const unexpectedKey = Object.keys(candidate).find(
    (key) => !allowedKeys.has(key),
  );

  if (unexpectedKey) {
    return {
      valid: false,
      commandId,
      amount,
      message: `Unexpected input property: ${unexpectedKey}.`,
    };
  }

  if (
    amount === null ||
    !Number.isInteger(amount) ||
    amount < diagnosticCounterMinimumIncrement ||
    amount > diagnosticCounterMaximumIncrement
  ) {
    return {
      valid: false,
      commandId,
      amount,
      message: "amount must be an integer from 1 through 10.",
    };
  }

  if (
    commandId === null ||
    commandId.length === 0 ||
    commandId.length > diagnosticCommandIdMaximumLength
  ) {
    return {
      valid: false,
      commandId,
      amount,
      message: "command_id must be a non-empty string of at most 64 characters.",
    };
  }

  return { valid: true, commandId, amount, message: "" };
}

export function inspectWebMcpOriginTrial(
  documentLike: object,
  capability: WebMcpCapability,
  nowMilliseconds = Date.now(),
): WebMcpOriginTrialStatus {
  let token: string | null = null;
  let currentOrigin = webMcpOrigin;

  try {
    const documentValue = documentLike as WebMcpDocument;
    const meta = documentValue.querySelector?.(
      'meta[http-equiv="origin-trial"]',
    );
    token = meta?.getAttribute?.("content") ?? meta?.content ?? null;
    currentOrigin = documentValue.location?.origin ?? webMcpOrigin;
  } catch {
    return "unknown";
  }

  if (!token) {
    return capability.kind === "available" ? "not-required" : "unknown";
  }

  const metadata = decodeOriginTrialMetadata(token);
  if (!metadata || metadata.feature !== "WebMCP") {
    return "mismatched";
  }

  if (metadata.expiry !== null && metadata.expiry * 1000 <= nowMilliseconds) {
    return "expired";
  }

  if (metadata.origin !== null && !sameOrigin(metadata.origin, currentOrigin)) {
    return "mismatched";
  }

  return capability.kind === "available" ? "accepted" : "rejected";
}

type OriginTrialMetadata = {
  feature: string | null;
  origin: string | null;
  expiry: number | null;
};

function decodeOriginTrialMetadata(token: string): OriginTrialMetadata | null {
  try {
    const binary = atob(token);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const jsonEnd = decoded.lastIndexOf("}");

    if (jsonEnd < 0) {
      return null;
    }

    let jsonStart = decoded.indexOf("{");
    while (jsonStart >= 0 && jsonStart < jsonEnd) {
      try {
        const payload = JSON.parse(
          decoded.slice(jsonStart, jsonEnd + 1),
        ) as Record<string, unknown>;
        return {
          feature: typeof payload.feature === "string" ? payload.feature : null,
          origin: typeof payload.origin === "string" ? payload.origin : null,
          expiry: typeof payload.expiry === "number" ? payload.expiry : null,
        };
      } catch {
        jsonStart = decoded.indexOf("{", jsonStart + 1);
      }
    }

    return null;
  } catch {
    return null;
  }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function describeWebMcpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}
