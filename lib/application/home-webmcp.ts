import type {
  BrowserDeckHomeService,
  DeckHomeSnapshot,
} from "./deck-home-service";
import { SessionServiceError } from "./session-service";
import { SuspensionServiceError } from "./suspension-service";
import type { WebMcpTool, WebMcpToolClient } from "../webmcp";

export const HOME_TOOL_NAMES = [
  "list_decks",
  "select_deck",
  "restore_suspended",
] as const;

export type HomeToolName = (typeof HOME_TOOL_NAMES)[number];
export type HomeToolErrorCode =
  | "INVALID_INPUT"
  | "WRONG_PAGE"
  | "DECK_NOT_FOUND"
  | "DUPLICATE_COMMAND"
  | "STORAGE_ERROR"
  | "NAVIGATION_ERROR";

export type ToolResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: HomeToolErrorCode;
        readonly message: string;
        readonly recoverable: boolean;
        readonly suggested_action?: string;
      };
    };

export interface HomeToolDeck {
  readonly id: string;
  readonly name: string;
  readonly card_count: number;
  readonly due_count: number;
  readonly suspended_count: number;
  readonly last_studied_at: string | null;
  readonly can_start_session: boolean;
}

export interface ListDecksData {
  readonly page: "decks";
  readonly decks: readonly HomeToolDeck[];
}

export interface SelectDeckData {
  readonly page: "study";
  readonly deck_id: string;
  readonly session: null | {
    readonly id: string;
    readonly sequence: number;
    readonly status: "created" | "resumed";
  };
  readonly caught_up: boolean;
}

export interface RestoreSuspendedData extends ListDecksData {
  readonly deck_id: string;
  readonly command_id: string;
  readonly restored_count: number;
  readonly idempotent: boolean;
}

export type HomeToolResult = ToolResult<
  ListDecksData | SelectDeckData | RestoreSuspendedData
>;

export interface HomeToolController {
  readonly tools: readonly WebMcpTool<HomeToolResult>[];
  execute(name: HomeToolName, input: unknown, client?: WebMcpToolClient): Promise<HomeToolResult>;
}

export interface HomeToolControllerOptions {
  readonly service: Pick<
    BrowserDeckHomeService,
    "readSnapshot" | "selectDeck" | "restoreSuspended"
  >;
  readonly navigate: (href: string) => void;
  readonly publishSnapshot: (snapshot: DeckHomeSnapshot) => void;
  readonly isActive?: () => boolean;
}

export class HomeNavigationError extends Error {
  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? `The prepared study session could not be opened: ${cause.message}`
        : "The prepared study session could not be opened.",
      { cause },
    );
    this.name = "HomeNavigationError";
  }
}

export async function selectDeckAndNavigate(
  service: Pick<BrowserDeckHomeService, "selectDeck">,
  deckId: string,
  navigate: (href: string) => void,
) {
  const result = await service.selectDeck(deckId);
  try {
    navigate(`/study/?deck=${encodeURIComponent(deckId)}`);
  } catch (error) {
    throw new HomeNavigationError(error);
  }
  return result;
}

export async function restoreSuspendedAndReadSnapshot(
  service: Pick<BrowserDeckHomeService, "restoreSuspended" | "readSnapshot">,
  deckId: string,
  commandId: string,
  canCommit?: () => boolean,
) {
  const result = await service.restoreSuspended(deckId, commandId, canCommit);
  const snapshot = await service.readSnapshot();
  if (!snapshot.ok) throw new Error("The committed deck snapshot is unavailable.");
  return { result, snapshot: snapshot.value };
}

export const listDecksInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const selectDeckInputSchema = {
  type: "object",
  properties: {
    deck_id: { type: "string", minLength: 1 },
  },
  required: ["deck_id"],
  additionalProperties: false,
} as const;

export const restoreSuspendedInputSchema = {
  type: "object",
  properties: {
    deck_id: { type: "string", minLength: 1 },
    command_id: { type: "string", minLength: 1 },
  },
  required: ["deck_id", "command_id"],
  additionalProperties: false,
} as const;

export function createHomeToolController(
  options: HomeToolControllerOptions,
): HomeToolController {
  const isActive = options.isActive ?? (() => true);

  const execute = async (
    name: HomeToolName,
    input: unknown,
    client: WebMcpToolClient = {},
  ): Promise<HomeToolResult> => {
    if (!isActive() || client.signal?.aborted) {
      return toolError(
        "WRONG_PAGE",
        "The decks page is no longer active.",
        false,
      );
    }

    if (name === "list_decks") {
      if (!isExactObject(input, [])) return invalidInput("list_decks accepts an empty object.");
      return readDecks(
        options.service,
        (snapshot) => {
          if (isActive() && !client.signal?.aborted) options.publishSnapshot(snapshot);
        },
      );
    }

    const parsed = parseStrings(
      input,
      name === "select_deck" ? ["deck_id"] : ["deck_id", "command_id"],
    );
    if (!parsed.ok) return invalidInput(parsed.message);

    try {
      if (name === "select_deck") {
        const selected = await selectDeckAndNavigate(
          options.service,
          parsed.values.deck_id!,
          (href) => {
            if (!isActive() || client.signal?.aborted) {
              throw new HomeNavigationError();
            }
            options.navigate(href);
          },
        );
        if (!isActive() || client.signal?.aborted) {
          return toolError("WRONG_PAGE", "The decks page changed before navigation.", false);
        }
        return {
          ok: true,
          data: {
            page: "study",
            deck_id: parsed.values.deck_id!,
            session: selected.session === null
              ? null
              : {
                  id: selected.session.id,
                  sequence: selected.session.sequence,
                  status: selected.status,
                },
            caught_up: selected.session === null,
          },
        };
      }

      const restored = await restoreSuspendedAndReadSnapshot(
        options.service,
        parsed.values.deck_id!,
        parsed.values.command_id!,
        () => isActive() && !client.signal?.aborted,
      );
      if (!isActive() || client.signal?.aborted) {
        return toolError("WRONG_PAGE", "The decks page changed before the result was published.", false);
      }
      options.publishSnapshot(restored.snapshot);
      return {
        ok: true,
        data: {
          ...serializeSnapshot(restored.snapshot),
          deck_id: restored.result.deckId,
          command_id: parsed.values.command_id!,
          restored_count: restored.result.restoredCount,
          idempotent: restored.result.idempotent,
        },
      };
    } catch (error) {
      return mapServiceError(error);
    }
  };

  const definitions: Array<{
    name: HomeToolName;
    title: string;
    description: string;
    inputSchema: object;
    readOnlyHint: boolean;
  }> = [
    {
      name: "list_decks",
      title: "List decks",
      description: "List the decks and study availability currently shown on the decks page.",
      inputSchema: listDecksInputSchema,
      readOnlyHint: true,
    },
    {
      name: "select_deck",
      title: "Select a deck",
      description: "Start or resume a durable session for a deck, then open its study page.",
      inputSchema: selectDeckInputSchema,
      readOnlyHint: false,
    },
    {
      name: "restore_suspended",
      title: "Restore suspended cards",
      description: "Restore all suspended schedules in one deck without changing their scheduling memory or due time. Reuse command_id when retrying.",
      inputSchema: restoreSuspendedInputSchema,
      readOnlyHint: false,
    },
  ];

  return {
    tools: definitions.map((definition) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: {
        readOnlyHint: definition.readOnlyHint,
        untrustedContentHint: false,
      },
      execute: (input, client) => execute(definition.name, input, client),
    })),
    execute,
  };
}

async function readDecks(
  service: Pick<BrowserDeckHomeService, "readSnapshot">,
  publishSnapshot: (snapshot: DeckHomeSnapshot) => void,
): Promise<ToolResult<ListDecksData>> {
  try {
    const snapshot = await service.readSnapshot();
    if (!snapshot.ok) return storageError();
    publishSnapshot(snapshot.value);
    return { ok: true, data: serializeSnapshot(snapshot.value) };
  } catch {
    return storageError();
  }
}

function serializeSnapshot(snapshot: DeckHomeSnapshot): ListDecksData {
  return {
    page: "decks",
    decks: snapshot.decks.map((deck) => ({
      id: deck.id,
      name: deck.name,
      card_count: deck.cardCount,
      due_count: deck.dueCount,
      suspended_count: deck.suspendedCount,
      last_studied_at: deck.lastStudiedAt === null
        ? null
        : new Date(deck.lastStudiedAt).toISOString(),
      can_start_session: deck.canStartSession,
    })),
  };
}

function parseStrings(
  input: unknown,
  keys: readonly string[],
): { ok: true; values: Record<string, string> } | { ok: false; message: string } {
  if (!isExactObject(input, keys)) {
    return { ok: false, message: `Input must contain exactly ${keys.join(" and ")}.` };
  }
  const values = input as Record<string, unknown>;
  if (keys.some((key) => typeof values[key] !== "string" || values[key]!.length === 0)) {
    return { ok: false, message: `${keys.join(" and ")} must be non-empty strings.` };
  }
  return { ok: true, values: values as Record<string, string> };
}

function isExactObject(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  return input !== null
    && typeof input === "object"
    && !Array.isArray(input)
    && Object.keys(input).length === keys.length
    && keys.every((key) => Object.hasOwn(input, key));
}

function mapServiceError(error: unknown): HomeToolResult {
  if (error instanceof HomeNavigationError) {
    return toolError(
      "NAVIGATION_ERROR",
      "The study session was prepared, but the study page could not be opened.",
      true,
      "Retry select_deck with the same deck_id.",
    );
  }
  if (
    (error instanceof SessionServiceError && error.code === "deck-not-found")
    || (error instanceof SuspensionServiceError && error.code === "deck-not-found")
  ) {
    return toolError(
      "DECK_NOT_FOUND",
      "The requested deck does not exist.",
      true,
      "Call list_decks and use a returned deck id.",
    );
  }
  if (error instanceof SuspensionServiceError && error.code === "duplicate-command") {
    return toolError(
      "DUPLICATE_COMMAND",
      "The command_id belongs to a different restore operation.",
      true,
      "Use a new command_id for a different deck.",
    );
  }
  if (error instanceof SuspensionServiceError && error.code === "cancelled") {
    return toolError("WRONG_PAGE", "The decks page changed before the restore committed.", false);
  }
  if (
    (error instanceof SessionServiceError && error.code === "invalid-input")
    || (error instanceof SuspensionServiceError && error.code === "invalid-input")
  ) {
    return invalidInput(error.message);
  }
  return storageError();
}

function invalidInput<T = never>(message: string): ToolResult<T> {
  return toolError("INVALID_INPUT", message, true, "Use the tool's declared input schema.");
}

function storageError<T = never>(): ToolResult<T> {
  return toolError(
    "STORAGE_ERROR",
    "The saved deck state is temporarily unavailable.",
    true,
    "Retry the command after local storage is available.",
  );
}

function toolError<T = never>(
  code: HomeToolErrorCode,
  message: string,
  recoverable: boolean,
  suggested_action?: string,
): ToolResult<T> {
  return {
    ok: false,
    error: { code, message, recoverable, ...(suggested_action ? { suggested_action } : {}) },
  };
}
