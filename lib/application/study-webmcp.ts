import type { Rating } from "../domain/entities";
import type { WebMcpTool, WebMcpToolClient } from "../webmcp";
import { RevealServiceError, type RevealAnswerResult } from "./reveal-service";
import { ReviewServiceError, type ReviewResult } from "./review-service";
import type {
  BrowserStudyRouteService,
  StudyRouteSnapshot,
} from "./study-route-service";
import {
  SuspensionServiceError,
  type SuspensionResult,
} from "./suspension-service";

export const STUDY_TOOL_NAMES = [
  "get_state",
  "flip",
  "set_state",
  "suspend",
  "go_home",
] as const;

export type StudyToolName = (typeof STUDY_TOOL_NAMES)[number];
export type StudyToolErrorCode =
  | "INVALID_INPUT"
  | "WRONG_PAGE"
  | "NO_ACTIVE_CARD"
  | "SESSION_NOT_FOUND"
  | "SESSION_COMPLETED"
  | "STALE_CARD"
  | "ANSWER_NOT_REVEALED"
  | "DUPLICATE_COMMAND"
  | "STORAGE_ERROR"
  | "NAVIGATION_ERROR";

export type StudyToolResult =
  | { readonly ok: true; readonly data: StudyToolData }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: StudyToolErrorCode;
        readonly message: string;
        readonly recoverable: boolean;
        readonly suggested_action?: string;
      };
    };

export type StudyToolState = {
  readonly page: "study";
  readonly status: StudyRouteSnapshot["kind"];
  readonly captured_at: string;
  readonly deck: { readonly id: string; readonly name: string | null };
  readonly session: null | {
    readonly id: string;
    readonly sequence: number;
    readonly completed_presentations: number;
    readonly planned_presentations: number;
  };
  readonly current_card: null | {
    readonly id: string;
    readonly front_text: string;
    readonly side: "front" | "back";
    readonly back_text?: string;
    readonly rating_previews: Readonly<Record<Rating, {
      readonly interval: string;
      readonly due_at: string;
    }>>;
  };
  readonly next_due_at?: string | null;
  readonly rating_counts?: Readonly<Record<Rating, number>>;
  readonly allowed_actions: readonly StudyToolName[];
};

export type StudyToolData =
  | { readonly state: StudyToolState }
  | {
      readonly state: StudyToolState;
      readonly command_id: string;
      readonly reveal: { readonly changed: boolean; readonly idempotent: boolean };
    }
  | {
      readonly state: StudyToolState;
      readonly command_id: string;
      readonly transition: {
        readonly rating: Rating;
        readonly reviewed_card_id: string;
        readonly previous_due_at: string | null;
        readonly next_due_at: string | null;
        readonly next_card_id: string | null;
        readonly idempotent: boolean;
      };
    }
  | {
      readonly state: StudyToolState;
      readonly command_id: string;
      readonly suspension: {
        readonly suspended_card_id: string;
        readonly removed_occurrence_count: number;
        readonly outcome: "active" | "waiting" | "completed";
        readonly next_card_id: string | null;
        readonly idempotent: boolean;
      };
    }
  | { readonly page: "decks"; readonly deck_count: number };

export interface StudyToolControllerOptions {
  readonly service: Pick<BrowserStudyRouteService, "load" | "reveal" | "rate" | "suspend">;
  readonly deckId: string;
  readonly publishSnapshot: (snapshot: StudyRouteSnapshot) => void;
  readonly navigateHome: () => void;
  readonly readHomeDeckCount: () => Promise<number>;
  readonly isActive?: () => boolean;
}

export interface StudyToolController {
  readonly tools: readonly WebMcpTool<StudyToolResult>[];
  execute(name: StudyToolName, input: unknown, client?: WebMcpToolClient): Promise<StudyToolResult>;
}

export const getStudyStateInputSchema = emptyInputSchema();
export const goHomeInputSchema = emptyInputSchema();
export const flipInputSchema = commandInputSchema(false);
export const suspendInputSchema = commandInputSchema(false);
export const setStudyStateInputSchema = commandInputSchema(true);

export function createStudyToolController(
  options: StudyToolControllerOptions,
): StudyToolController {
  const isActive = options.isActive ?? (() => true);
  const commands = new Map<string, string>();
  const inFlight = new Map<string, Promise<StudyToolResult>>();
  let mutationLane = Promise.resolve();

  const current = (client: WebMcpToolClient) =>
    isActive() && client.signal?.aborted !== true;

  const loadAndPublish = async (client: WebMcpToolClient) => {
    const snapshot = await options.service.load(options.deckId);
    if (!current(client)) throw new WrongPageError();
    options.publishSnapshot(snapshot);
    return snapshot;
  };

  const execute = async (
    name: StudyToolName,
    input: unknown,
    client: WebMcpToolClient = {},
  ): Promise<StudyToolResult> => {
    if (!current(client)) return wrongPage();

    if (name === "get_state") {
      if (!isExactObject(input, [])) return invalidInput("get_state accepts an empty object.");
      try {
        return { ok: true, data: { state: serializeStudyState(await loadAndPublish(client)) } };
      } catch (error) {
        return mapError(error);
      }
    }

    if (name === "go_home") {
      if (!isExactObject(input, [])) return invalidInput("go_home accepts an empty object.");
      let deckCount: number;
      try {
        await loadAndPublish(client);
        deckCount = await options.readHomeDeckCount();
      } catch (error) {
        return mapError(error);
      }
      if (!current(client)) return wrongPage();
      try {
        options.navigateHome();
        return { ok: true, data: { page: "decks", deck_count: deckCount } };
      } catch {
        return toolError(
          "NAVIGATION_ERROR",
          "The decks page could not be opened.",
          true,
          "Retry go_home.",
        );
      }
    }

    const keys = name === "set_state"
      ? ["card_id", "command_id", "rating"] as const
      : ["card_id", "command_id"] as const;
    const parsed = parseCommand(input, keys, name === "set_state");
    if (!parsed.ok) return invalidInput(parsed.message);

    const commandId = parsed.values.command_id;
    const fingerprint = `${name}:${parsed.values.card_id}:${parsed.values.rating ?? ""}`;
    const priorFingerprint = commands.get(commandId);
    if (priorFingerprint) {
      if (priorFingerprint !== fingerprint) {
        return toolError(
          "DUPLICATE_COMMAND",
          "The command_id was already used for a different study action.",
          true,
          "Use a new command_id for a different action.",
        );
      }
      const pending = inFlight.get(commandId);
      if (pending) return pending;
    }

    const result = mutationLane.then(async (): Promise<StudyToolResult> => {
      if (!current(client)) return wrongPage();
      try {
        const before = await options.service.load(options.deckId);
        if (!current(client)) return wrongPage();
        if (before.kind !== "active" || !before.sessionId) return noActiveCard(before);
        const cardId = parsed.values.card_id;
        let data: StudyToolData;

        if (name === "flip") {
          const reveal = await options.service.reveal(before.sessionId, cardId);
          const state = serializeStudyState(await loadAndPublish(client));
          data = { state, command_id: commandId, reveal: serializeReveal(reveal) };
        } else if (name === "set_state") {
          const review = await options.service.rate(
            before.sessionId,
            cardId,
            parsed.values.rating as Rating,
            commandId,
          );
          const state = serializeStudyState(await loadAndPublish(client));
          data = {
            state,
            command_id: commandId,
            transition: serializeTransition(review),
          };
        } else {
          const suspension = await options.service.suspend(before.sessionId, cardId, commandId);
          const state = serializeStudyState(await loadAndPublish(client));
          data = {
            state,
            command_id: commandId,
            suspension: serializeSuspension(suspension),
          };
        }
        return { ok: true, data };
      } catch (error) {
        return mapError(error);
      }
    });
    commands.set(commandId, fingerprint);
    inFlight.set(commandId, result);
    void result.finally(() => inFlight.delete(commandId));
    mutationLane = result.then(() => undefined, () => undefined);
    return result;
  };

  const definitions: Array<{
    name: StudyToolName;
    title: string;
    description: string;
    inputSchema: object;
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  }> = [
    {
      name: "get_state",
      title: "Get study state",
      description: "Read the durable study state currently shown on this page.",
      inputSchema: getStudyStateInputSchema,
      readOnlyHint: true,
      untrustedContentHint: true,
    },
    {
      name: "flip",
      title: "Show answer",
      description: "Reveal the answer for the expected current card. Reuse command_id when retrying.",
      inputSchema: flipInputSchema,
      readOnlyHint: false,
      untrustedContentHint: false,
    },
    {
      name: "set_state",
      title: "Rate card",
      description: "Apply Again, Hard, Good, or Easy to the revealed expected card. Reuse command_id when retrying.",
      inputSchema: setStudyStateInputSchema,
      readOnlyHint: false,
      untrustedContentHint: false,
    },
    {
      name: "suspend",
      title: "Suspend card",
      description: "Suspend the expected current card without changing its scheduling memory. Reuse command_id when retrying.",
      inputSchema: suspendInputSchema,
      readOnlyHint: false,
      untrustedContentHint: false,
    },
    {
      name: "go_home",
      title: "Return to decks",
      description: "Open the decks page after reading its durable visible count.",
      inputSchema: goHomeInputSchema,
      readOnlyHint: false,
      untrustedContentHint: false,
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
        untrustedContentHint: definition.untrustedContentHint,
      },
      execute: (input, client) => execute(definition.name, input, client),
    })),
    execute,
  };
}

export function serializeStudyState(snapshot: StudyRouteSnapshot): StudyToolState {
  const session = snapshot.kind === "missing-deck" || snapshot.kind === "caught-up"
    ? null
    : {
        id: snapshot.sessionId,
        sequence: snapshot.sequence,
        completed_presentations: snapshot.completedPresentationCount,
        planned_presentations: snapshot.plannedPresentationCount,
      };
  const currentCard = snapshot.kind !== "active" ? null : {
    id: snapshot.cardId,
    front_text: snapshot.frontText,
    side: snapshot.side,
    ...(snapshot.side === "back" ? { back_text: snapshot.backText ?? "" } : {}),
    rating_previews: Object.fromEntries(
      (["again", "hard", "good", "easy"] as const).map((rating) => [rating, {
        interval: snapshot.ratingPreviews[rating].intervalLabel,
        due_at: toIso(snapshot.ratingPreviews[rating].dueAt),
      }]),
    ) as Readonly<Record<Rating, {
      interval: string;
      due_at: string;
    }>>,
  };
  const allowed: StudyToolName[] = ["get_state"];
  if (snapshot.kind === "active") {
    if (snapshot.side === "front") allowed.push("flip");
    else allowed.push("set_state");
    allowed.push("suspend");
  }
  allowed.push("go_home");

  return {
    page: "study",
    status: snapshot.kind,
    captured_at: toIso(snapshot.capturedAt),
    deck: {
      id: snapshot.deckId,
      name: snapshot.kind === "missing-deck" ? null : snapshot.deckName,
    },
    session,
    current_card: currentCard,
    ...(snapshot.kind === "waiting" ? { next_due_at: toIso(snapshot.nextDueAt) } : {}),
    ...(snapshot.kind === "completion" ? {
      next_due_at: snapshot.nextDueAt === null ? null : toIso(snapshot.nextDueAt),
      rating_counts: snapshot.ratingCounts,
    } : {}),
    allowed_actions: allowed,
  };
}

function serializeReveal(result: RevealAnswerResult) {
  return { changed: result.changed, idempotent: result.idempotent };
}

function serializeTransition(result: ReviewResult) {
  return {
    rating: result.rating,
    reviewed_card_id: result.card.id,
    previous_due_at: result.previousSchedule ? toIso(result.previousSchedule.dueAt) : null,
    next_due_at: result.schedule ? toIso(result.schedule.dueAt) : null,
    next_card_id: result.nextCardId,
    idempotent: result.idempotent,
  };
}

function serializeSuspension(result: SuspensionResult) {
  return {
    suspended_card_id: result.suspendedCardId,
    removed_occurrence_count: result.removedOccurrenceCount,
    outcome: result.outcome,
    next_card_id: result.nextCardId,
    idempotent: result.idempotent,
  };
}

function noActiveCard(snapshot: StudyRouteSnapshot): StudyToolResult {
  if (snapshot.kind === "completion") {
    return toolError("SESSION_COMPLETED", "The current session is already complete.", false);
  }
  return toolError(
    "NO_ACTIVE_CARD",
    "There is no current card to mutate.",
    true,
    "Call get_state and wait for or start an active card.",
  );
}

function mapError(error: unknown): StudyToolResult {
  if (error instanceof WrongPageError) return wrongPage();
  if (error instanceof RevealServiceError || error instanceof ReviewServiceError || error instanceof SuspensionServiceError) {
    switch (error.code) {
      case "invalid-input":
      case "invalid-rating":
        return invalidInput(error.message);
      case "session-not-found":
        return toolError("SESSION_NOT_FOUND", "The saved session no longer exists.", true, "Call get_state.");
      case "completed-session":
        return toolError("SESSION_COMPLETED", "The current session is already complete.", false);
      case "stale-card":
      case "card-not-found":
      case "schedule-not-found":
        return toolError("STALE_CARD", "The expected card is no longer current.", true, "Call get_state and use its current card id.");
      case "front-side":
        return toolError("ANSWER_NOT_REVEALED", "Reveal the answer before rating this card.", true, "Call flip for the current card.");
      case "duplicate-command":
        return toolError("DUPLICATE_COMMAND", "The command_id was already used for a different study action.", true, "Use a new command_id.");
      default:
        return storageError();
    }
  }
  return storageError();
}

function parseCommand(
  input: unknown,
  keys: readonly string[],
  expectsRating: boolean,
): { ok: true; values: { card_id: string; command_id: string; rating?: Rating } }
  | { ok: false; message: string } {
  if (!isExactObject(input, keys)) {
    return { ok: false, message: `Input must contain exactly ${keys.join(", ")}.` };
  }
  const values = input as Record<string, unknown>;
  if (typeof values.card_id !== "string" || values.card_id.trim().length === 0
    || typeof values.command_id !== "string" || values.command_id.trim().length === 0) {
    return { ok: false, message: "card_id and command_id must be non-empty strings." };
  }
  if (expectsRating && !(["again", "hard", "good", "easy"] as const).includes(values.rating as Rating)) {
    return { ok: false, message: "rating must be again, hard, good, or easy." };
  }
  return {
    ok: true,
    values: {
      card_id: values.card_id,
      command_id: values.command_id,
      ...(expectsRating ? { rating: values.rating as Rating } : {}),
    },
  };
}

function emptyInputSchema() {
  return { type: "object", properties: {}, additionalProperties: false } as const;
}

function commandInputSchema(rating: boolean) {
  return {
    type: "object",
    properties: {
      card_id: { type: "string", minLength: 1 },
      command_id: { type: "string", minLength: 1 },
      ...(rating ? { rating: { type: "string", enum: ["again", "hard", "good", "easy"] } } : {}),
    },
    required: rating ? ["card_id", "command_id", "rating"] : ["card_id", "command_id"],
    additionalProperties: false,
  } as const;
}

function isExactObject(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    && Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key));
}

function invalidInput(message: string): StudyToolResult {
  return toolError("INVALID_INPUT", message, true, "Use the tool's declared input schema.");
}

function wrongPage(): StudyToolResult {
  return toolError("WRONG_PAGE", "The study page is no longer active.", false);
}

function storageError(): StudyToolResult {
  return toolError("STORAGE_ERROR", "The saved study state is temporarily unavailable.", true, "Retry after local storage is available.");
}

function toolError(
  code: StudyToolErrorCode,
  message: string,
  recoverable: boolean,
  suggested_action?: string,
): StudyToolResult {
  return {
    ok: false,
    error: { code, message, recoverable, ...(suggested_action ? { suggested_action } : {}) },
  };
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

class WrongPageError extends Error {}
