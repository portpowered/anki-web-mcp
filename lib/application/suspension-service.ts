import type {
  CardRecord,
  EpochMilliseconds,
  MetaRecord,
  ScheduleRecord,
  SessionQueueEntry,
  SessionRecord,
} from "../domain/entities";
import type { Clock } from "../domain/ports";
import type { OperationGuard } from "./operation-guard";
import {
  type StudyDatabase,
  type StudyTransaction,
  StudyPersistenceError,
} from "../persistence/db";

export const SUSPENSION_TRANSACTION_STORES = [
  "cards",
  "meta",
  "schedules",
  "sessions",
] as const;

export const RESTORE_TRANSACTION_STORES = [
  "decks",
  "meta",
  "schedules",
] as const;

const MAX_COMMAND_IDS = 64;
const SUSPEND_COMMAND_KEY_PREFIX = "study.suspend:";
const RESTORE_COMMAND_KEY_PREFIX = "study.restore-suspended:";

export type SuspensionServiceErrorCode =
  | "invalid-input"
  | "session-not-found"
  | "completed-session"
  | "stale-card"
  | "card-not-found"
  | "schedule-not-found"
  | "already-suspended"
  | "invalid-session-state"
  | "deck-not-found"
  | "duplicate-command"
  | "conflict"
  | "cancelled"
  | "persistence";

export class SuspensionServiceError extends Error {
  constructor(
    readonly code: SuspensionServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SuspensionServiceError";
  }
}

export interface SuspensionServiceOptions {
  readonly database: StudyDatabase;
  readonly clock: Clock;
}

export interface SuspendRequest {
  readonly sessionId: string;
  /** The caller's expected current card ID. */
  readonly expectedCardId?: string;
  /** Alias accepted by callers that use the persisted field name. */
  readonly cardId?: string;
  /** Stable idempotency key for this suspension command. */
  readonly commandId: string;
  readonly canCommit?: OperationGuard;
}

export type SessionPresentationState = "active" | "waiting" | "completed";

interface SuspensionResultBase {
  readonly session: SessionRecord;
  readonly card: CardRecord;
  readonly schedule: ScheduleRecord;
  readonly suspendedCardId: string;
  readonly nextCardId: string | null;
  readonly nextPresentationDueAt: EpochMilliseconds | null;
  readonly waitingUntil: EpochMilliseconds | null;
  readonly sessionState: SessionPresentationState;
  /** Alias for callers that describe the post-command session outcome. */
  readonly outcome: SessionPresentationState;
  readonly removedOccurrenceCount: number;
}

export interface SuspendedCard extends SuspensionResultBase {
  readonly status: "suspended";
  readonly kind: "suspended";
  readonly changed: true;
  readonly idempotent: false;
}

export interface DuplicateSuspension extends SuspensionResultBase {
  readonly status: "duplicate";
  readonly kind: "duplicate";
  readonly changed: false;
  readonly idempotent: true;
}

export type SuspensionResult = SuspendedCard | DuplicateSuspension;

export interface RestoreSuspendedRequest {
  readonly deckId: string;
  /** Optional for compatibility with callers that do not yet issue commands. */
  readonly commandId?: string;
  readonly canCommit?: OperationGuard;
}

export interface RestoreSuspendedResult {
  readonly status: "restored" | "already-restored";
  readonly kind: "restored" | "already-restored";
  readonly changed: boolean;
  readonly idempotent: boolean;
  readonly deckId: string;
  readonly restoredCount: number;
  readonly restoredCardIds: readonly string[];
}

interface SuspendCommandValue {
  readonly kind: "suspend";
  readonly sessionId: string;
  readonly cardId: string;
}

interface RestoreCommandValue {
  readonly kind: "restore-suspended";
  readonly deckId: string;
  readonly restoredCardIds: readonly string[];
}

/**
 * Owns suspend and restore transitions so they cannot bypass the durable
 * session boundary. Suspension never invokes the scheduler or writes a review
 * log; restore only changes the suspension marker on schedules in one deck.
 */
export class SuspensionService {
  private readonly database: StudyDatabase;
  private readonly clock: Clock;

  constructor(options: SuspensionServiceOptions) {
    this.database = options.database;
    this.clock = options.clock;
  }

  suspend(
    sessionId: string,
    expectedCardId: string,
    commandId: string,
  ): Promise<SuspensionResult>;
  suspend(request: SuspendRequest): Promise<SuspensionResult>;
  suspend(
    sessionIdOrRequest: string | SuspendRequest,
    expectedCardId?: string,
    commandId?: string,
  ): Promise<SuspensionResult> {
    return this.executeSuspend(sessionIdOrRequest, expectedCardId, commandId);
  }

  suspendCard(
    sessionId: string,
    expectedCardId: string,
    commandId: string,
  ): Promise<SuspensionResult>;
  suspendCard(request: SuspendRequest): Promise<SuspensionResult>;
  suspendCard(
    sessionIdOrRequest: string | SuspendRequest,
    expectedCardId?: string,
    commandId?: string,
  ): Promise<SuspensionResult> {
    return this.executeSuspend(sessionIdOrRequest, expectedCardId, commandId);
  }

  /** Alias used by study-page composition roots. */
  suspendCurrentCard(
    sessionId: string,
    expectedCardId: string,
    commandId: string,
  ): Promise<SuspensionResult>;
  suspendCurrentCard(request: SuspendRequest): Promise<SuspensionResult>;
  suspendCurrentCard(
    sessionIdOrRequest: string | SuspendRequest,
    expectedCardId?: string,
    commandId?: string,
  ): Promise<SuspensionResult> {
    return this.executeSuspend(sessionIdOrRequest, expectedCardId, commandId);
  }

  restoreSuspended(
    deckId: string,
    commandId?: string,
  ): Promise<RestoreSuspendedResult>;
  restoreSuspended(request: RestoreSuspendedRequest): Promise<RestoreSuspendedResult>;
  restoreSuspended(
    deckIdOrRequest: string | RestoreSuspendedRequest,
    commandId?: string,
  ): Promise<RestoreSuspendedResult> {
    return this.executeRestore(deckIdOrRequest, commandId);
  }

  /** Alias used by deck-page composition roots. */
  restore(
    deckId: string,
    commandId?: string,
  ): Promise<RestoreSuspendedResult>;
  restore(request: RestoreSuspendedRequest): Promise<RestoreSuspendedResult>;
  restore(
    deckIdOrRequest: string | RestoreSuspendedRequest,
    commandId?: string,
  ): Promise<RestoreSuspendedResult> {
    return this.executeRestore(deckIdOrRequest, commandId);
  }

  restoreSuspendedCards(
    deckId: string,
    commandId?: string,
  ): Promise<RestoreSuspendedResult>;
  restoreSuspendedCards(request: RestoreSuspendedRequest): Promise<RestoreSuspendedResult>;
  restoreSuspendedCards(
    deckIdOrRequest: string | RestoreSuspendedRequest,
    commandId?: string,
  ): Promise<RestoreSuspendedResult> {
    return this.executeRestore(deckIdOrRequest, commandId);
  }

  private async executeSuspend(
    sessionIdOrRequest: string | SuspendRequest,
    expectedCardId: string | undefined,
    commandId: string | undefined,
  ): Promise<SuspensionResult> {
    const request = normalizeSuspendRequest(
      sessionIdOrRequest,
      expectedCardId,
      commandId,
    );
    const now = this.clock.now();
    validateEpoch(now, "clock.now()");

    try {
      return await this.database.transaction(
        "readwrite",
        SUSPENSION_TRANSACTION_STORES,
        (transaction) => this.suspendInTransaction(transaction, request, now),
      );
    } catch (error) {
      if (error instanceof SuspensionServiceError) {
        throw error;
      }
      if (error instanceof StudyPersistenceError && error.code === "conflict") {
        throw new SuspensionServiceError(
          "conflict",
          "Another suspension changed this presentation before the command committed.",
          { cause: error },
        );
      }
      throw new SuspensionServiceError(
        "persistence",
        "Unable to persist the card suspension.",
        { cause: error },
      );
    }
  }

  private async suspendInTransaction(
    transaction: StudyTransaction,
    request: NormalizedSuspendRequest,
    now: EpochMilliseconds,
  ): Promise<SuspensionResult> {
    const session = await transaction.getSession(request.sessionId);
    if (session === undefined) {
      throw new SuspensionServiceError(
        "session-not-found",
        `Session ${request.sessionId} was not found.`,
      );
    }

    // Check the durable command marker before completed/stale validation so a
    // retry remains a no-op even when the first suspension completed the session.
    if (transaction.getMeta === undefined || transaction.putMeta === undefined) {
      throw new SuspensionServiceError(
        "persistence",
        "The persistence adapter does not support durable suspension commands.",
      );
    }
    const existing = await transaction.getMeta(suspendCommandKey(request.commandId));
    if (existing !== undefined) {
      const previous = parseSuspendCommand(existing, request.commandId);
      if (previous.sessionId !== session.id) {
        throw new SuspensionServiceError(
          "duplicate-command",
          `Command ${request.commandId} was already committed for another session.`,
        );
      }
      const previousCard = await transaction.getCard(previous.cardId);
      if (previousCard === undefined || previousCard.deckId !== session.deckId) {
        throw new SuspensionServiceError(
          "card-not-found",
          `Card ${previous.cardId} is no longer present for duplicate command ${request.commandId}.`,
        );
      }
      const previousSchedule = await transaction.getSchedule(previous.cardId);
      if (previousSchedule === undefined || previousSchedule.deckId !== session.deckId) {
        throw new SuspensionServiceError(
          "schedule-not-found",
          `Schedule for card ${previous.cardId} was not found for duplicate command ${request.commandId}.`,
        );
      }
      return duplicateSuspension(session, previousCard, previousSchedule, now);
    }

    const commandWasApplied = (session.lastCommandIds ?? []).includes(request.commandId);
    const card = await transaction.getCard(request.expectedCardId);
    if (card === undefined || card.deckId !== session.deckId) {
      throw new SuspensionServiceError(
        "card-not-found",
        `Card ${request.expectedCardId} is no longer present in session ${session.id}.`,
      );
    }
    const schedule = await transaction.getSchedule(request.expectedCardId);
    if (schedule === undefined || schedule.deckId !== session.deckId) {
      throw new SuspensionServiceError(
        "schedule-not-found",
        `Schedule for card ${request.expectedCardId} was not found.`,
      );
    }
    if (commandWasApplied) {
      return duplicateSuspension(session, card, schedule, now);
    }
    if (session.completedAt !== null) {
      throw new SuspensionServiceError(
        "completed-session",
        `Session ${session.id} is already completed.`,
      );
    }
    if (session.activeCardId !== request.expectedCardId) {
      throw new SuspensionServiceError(
        "stale-card",
        `Card ${request.expectedCardId} is not the current card for session ${session.id}.`,
      );
    }
    if (session.currentSide !== "front" && session.currentSide !== "back") {
      throw new SuspensionServiceError(
        "invalid-session-state",
        `Session ${session.id} has an unsupported current side.`,
      );
    }
    if (schedule.suspended) {
      throw new SuspensionServiceError(
        "already-suspended",
        `Card ${request.expectedCardId} is already suspended.`,
      );
    }

    const currentOccurrence = findReadyOccurrence(session, request.expectedCardId, now);
    if (currentOccurrence === undefined) {
      throw new SuspensionServiceError(
        "invalid-session-state",
        `Session ${session.id} has no ready queue occurrence for its active card.`,
      );
    }

    const removedOccurrenceCount = session.queueEntries.filter(
      (entry) => entry.cardId === request.expectedCardId,
    ).length;
    if (removedOccurrenceCount === 0) {
      // This is guarded by currentOccurrence, but keeping the invariant check
      // explicit makes malformed imported sessions fail before any write.
      throw new SuspensionServiceError(
        "invalid-session-state",
        `Session ${session.id} has no queue occurrence for its active card.`,
      );
    }
    validateProgressCounters(session, removedOccurrenceCount);

    const remainingQueue = sortQueueEntries(session.queueEntries.filter(
      (entry) => entry.cardId !== request.expectedCardId,
    ));
    const nextReady = remainingQueue.find((entry) => entry.dueAt <= now);
    const nextDelayed = remainingQueue.find((entry) => entry.dueAt > now);
    const nextCardId = nextReady?.cardId ?? null;
    const sessionState: SessionPresentationState = nextReady !== undefined
      ? "active"
      : remainingQueue.length > 0
        ? "waiting"
        : "completed";
    const updatedSession: SessionRecord = {
      ...session,
      queueEntries: remainingQueue,
      activeCardId: nextCardId,
      plannedPresentationCount: session.plannedPresentationCount - removedOccurrenceCount,
      // Suspension abandons pending presentations; it does not count as a rating.
      completedPresentationCount: session.completedPresentationCount,
      currentSide: "front",
      updatedAt: now,
      completedAt: sessionState === "completed" ? now : null,
      lastCommandIds: appendCommandId(session.lastCommandIds ?? [], request.commandId),
    };
    const suspendedSchedule: ScheduleRecord = {
      ...schedule,
      suspended: true,
    };

    // No review-log store is part of this transaction by design. The schedule
    // and session writes still commit or roll back together.
    await transaction.putSchedule(suspendedSchedule);
    await transaction.putSession(updatedSession);
    const value: MetaRecord["value"] = {
      kind: "suspend",
      sessionId: session.id,
      cardId: request.expectedCardId,
    };
    await transaction.putMeta({
      key: suspendCommandKey(request.commandId),
      value,
    });
    assertCanCommit(request.canCommit, "suspension");

    return {
      status: "suspended",
      kind: "suspended",
      changed: true,
      idempotent: false,
      session: updatedSession,
      card,
      schedule: suspendedSchedule,
      suspendedCardId: request.expectedCardId,
      nextCardId,
      nextPresentationDueAt: nextReady?.dueAt ?? nextDelayed?.dueAt ?? null,
      waitingUntil: sessionState === "waiting" ? nextDelayed?.dueAt ?? null : null,
      sessionState,
      outcome: sessionState,
      removedOccurrenceCount,
    };
  }

  private async executeRestore(
    deckIdOrRequest: string | RestoreSuspendedRequest,
    commandId: string | undefined,
  ): Promise<RestoreSuspendedResult> {
    const request = normalizeRestoreRequest(deckIdOrRequest, commandId);

    try {
      return await this.database.transaction(
        "readwrite",
        RESTORE_TRANSACTION_STORES,
        (transaction) => this.restoreInTransaction(transaction, request),
      );
    } catch (error) {
      if (error instanceof SuspensionServiceError) {
        throw error;
      }
      if (error instanceof StudyPersistenceError && error.code === "conflict") {
        throw new SuspensionServiceError(
          "conflict",
          "Another restore command changed the deck before this command committed.",
          { cause: error },
        );
      }
      throw new SuspensionServiceError(
        "persistence",
        "Unable to restore suspended cards.",
        { cause: error },
      );
    }
  }

  private async restoreInTransaction(
    transaction: StudyTransaction,
    request: NormalizedRestoreRequest,
  ): Promise<RestoreSuspendedResult> {
    const deck = await transaction.getDeck(request.deckId);
    if (deck === undefined) {
      throw new SuspensionServiceError(
        "deck-not-found",
        `Deck ${request.deckId} was not found.`,
      );
    }

    if (request.commandId !== null && transaction.getMeta !== undefined) {
      const existing = await transaction.getMeta(restoreCommandKey(request.commandId));
      if (existing !== undefined) {
        const previous = parseRestoreCommand(existing, request.commandId);
        if (previous.deckId !== request.deckId) {
          throw new SuspensionServiceError(
            "duplicate-command",
            `Command ${request.commandId} was already committed for another deck.`,
          );
        }
        return restoreResult(request.deckId, previous.restoredCardIds, false, true);
      }
    }

    const schedules = (await transaction.listSchedules(request.deckId))
      .sort((left, right) => compareIds(left.cardId, right.cardId));
    const suspended = schedules.filter((schedule) => schedule.suspended);
    for (const schedule of suspended) {
      // Spread only changes the suspension marker; all FSRS memory and due
      // fields, including optional learning-step state, remain byte-for-byte.
      await transaction.putSchedule({ ...schedule, suspended: false });
    }

    const restoredCardIds = suspended.map((schedule) => schedule.cardId);
    if (
      request.commandId !== null
      && transaction.putMeta !== undefined
    ) {
      const value: MetaRecord["value"] = {
        kind: "restore-suspended",
        deckId: request.deckId,
        restoredCardIds,
      };
      const record: MetaRecord = {
        key: restoreCommandKey(request.commandId),
        value,
      };
      await transaction.putMeta(record);
    }
    assertCanCommit(request.canCommit, "restore");

    return restoreResult(
      request.deckId,
      restoredCardIds,
      restoredCardIds.length > 0,
      restoredCardIds.length === 0,
    );
  }
}

/** Naming aliases for application composition roots. */
export {
  SuspensionService as CardSuspensionService,
  SuspensionService as RestoreService,
  SuspensionService as SuspendService,
};

interface NormalizedSuspendRequest {
  readonly sessionId: string;
  readonly expectedCardId: string;
  readonly commandId: string;
  readonly canCommit?: OperationGuard;
}

interface NormalizedRestoreRequest {
  readonly deckId: string;
  readonly commandId: string | null;
  readonly canCommit?: OperationGuard;
}

function normalizeSuspendRequest(
  sessionIdOrRequest: string | SuspendRequest,
  expectedCardId: string | undefined,
  commandId: string | undefined,
): NormalizedSuspendRequest {
  const sessionId = typeof sessionIdOrRequest === "string"
    ? sessionIdOrRequest
    : sessionIdOrRequest?.sessionId;
  const requestCardId = typeof sessionIdOrRequest === "string"
    ? expectedCardId
    : sessionIdOrRequest?.expectedCardId ?? sessionIdOrRequest?.cardId;
  const requestCommandId = typeof sessionIdOrRequest === "string"
    ? commandId
    : sessionIdOrRequest?.commandId;

  assertIdentifier(sessionId, "sessionId");
  assertIdentifier(requestCardId, "expectedCardId");
  assertIdentifier(requestCommandId, "commandId");
  return {
    sessionId,
    expectedCardId: requestCardId,
    commandId: requestCommandId,
    ...(typeof sessionIdOrRequest !== "string" && sessionIdOrRequest.canCommit
      ? { canCommit: sessionIdOrRequest.canCommit }
      : {}),
  };
}

function normalizeRestoreRequest(
  deckIdOrRequest: string | RestoreSuspendedRequest,
  commandId: string | undefined,
): NormalizedRestoreRequest {
  const deckId = typeof deckIdOrRequest === "string"
    ? deckIdOrRequest
    : deckIdOrRequest?.deckId;
  const requestCommandId = typeof deckIdOrRequest === "string"
    ? commandId
    : deckIdOrRequest?.commandId;
  assertIdentifier(deckId, "deckId");
  return {
    deckId,
    commandId: optionalIdentifier(requestCommandId, "commandId"),
    ...(typeof deckIdOrRequest !== "string" && deckIdOrRequest.canCommit
      ? { canCommit: deckIdOrRequest.canCommit }
      : {}),
  };
}

function assertCanCommit(
  guard: OperationGuard | undefined,
  operation: "suspension" | "restore",
): void {
  if (guard && !guard()) {
    throw new SuspensionServiceError(
      "cancelled",
      `The ${operation} became obsolete before it could commit.`,
    );
  }
}

function duplicateSuspension(
  session: SessionRecord,
  card: CardRecord,
  schedule: ScheduleRecord,
  now: EpochMilliseconds,
): DuplicateSuspension {
  const nextReady = session.activeCardId === null
    ? undefined
    : session.queueEntries
      .filter((entry) => entry.cardId === session.activeCardId && entry.dueAt <= now)
      .sort(compareQueueEntries)[0];
  const nextDelayed = session.queueEntries
    .filter((entry) => entry.dueAt > now)
    .sort(compareQueueEntries)[0];
  const nextCardId = nextReady?.cardId ?? session.activeCardId;
  const sessionState: SessionPresentationState = session.completedAt !== null
    ? "completed"
    : nextCardId !== null
      ? "active"
      : nextDelayed !== undefined
        ? "waiting"
        : "completed";
  return {
    status: "duplicate",
    kind: "duplicate",
    changed: false,
    idempotent: true,
    session,
    card,
    schedule,
    suspendedCardId: card.id,
    nextCardId,
    nextPresentationDueAt: nextReady?.dueAt ?? nextDelayed?.dueAt ?? null,
    waitingUntil: sessionState === "waiting" ? nextDelayed?.dueAt ?? null : null,
    sessionState,
    outcome: sessionState,
    removedOccurrenceCount: 0,
  };
}

function findReadyOccurrence(
  session: SessionRecord,
  cardId: string,
  now: EpochMilliseconds,
): SessionQueueEntry | undefined {
  return session.queueEntries
    .filter((entry) => entry.cardId === cardId && entry.dueAt <= now)
    .sort(compareQueueEntries)[0];
}

function validateProgressCounters(
  session: SessionRecord,
  removedOccurrenceCount: number,
): void {
  if (
    !Number.isInteger(session.plannedPresentationCount)
    || session.plannedPresentationCount < 0
    || !Number.isInteger(session.completedPresentationCount)
    || session.completedPresentationCount < 0
    || session.completedPresentationCount > session.plannedPresentationCount
  ) {
    throw new SuspensionServiceError(
      "invalid-session-state",
      `Session ${session.id} has invalid presentation counters.`,
    );
  }
  const nextPlanned = session.plannedPresentationCount - removedOccurrenceCount;
  if (
    nextPlanned < session.completedPresentationCount
    || nextPlanned - session.completedPresentationCount
      !== session.queueEntries.length - removedOccurrenceCount
  ) {
    throw new SuspensionServiceError(
      "invalid-session-state",
      `Session ${session.id} counters do not match its pending queue.`,
    );
  }
}

function sortQueueEntries(entries: readonly SessionQueueEntry[]): SessionQueueEntry[] {
  return [...entries].sort(compareQueueEntries);
}

function compareQueueEntries(left: SessionQueueEntry, right: SessionQueueEntry): number {
  if (left.dueAt !== right.dueAt) return left.dueAt - right.dueAt;
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return compareIds(left.cardId, right.cardId);
}

function appendCommandId(commandIds: readonly string[], commandId: string): string[] {
  const retained = commandIds.filter((value, index, values) => (
    typeof value === "string"
    && value.trim().length > 0
    && values.indexOf(value) === index
  ));
  if (!retained.includes(commandId)) retained.push(commandId);
  return retained.slice(-MAX_COMMAND_IDS);
}

function restoreResult(
  deckId: string,
  restoredCardIds: readonly string[],
  changed: boolean,
  idempotent: boolean,
): RestoreSuspendedResult {
  const status = changed ? "restored" : "already-restored";
  return {
    status,
    kind: status,
    changed,
    idempotent,
    deckId,
    restoredCount: restoredCardIds.length,
    restoredCardIds: [...restoredCardIds],
  };
}

function restoreCommandKey(commandId: string): string {
  return `${RESTORE_COMMAND_KEY_PREFIX}${commandId}`;
}

function suspendCommandKey(commandId: string): string {
  return `${SUSPEND_COMMAND_KEY_PREFIX}${commandId}`;
}

function parseSuspendCommand(record: MetaRecord, commandId: string): SuspendCommandValue {
  const value = record.value;
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || value.kind !== "suspend"
    || typeof value.sessionId !== "string"
    || typeof value.cardId !== "string"
  ) {
    throw new SuspensionServiceError(
      "persistence",
      `Suspend command ${commandId} has invalid persisted metadata.`,
    );
  }
  return {
    kind: "suspend",
    sessionId: value.sessionId,
    cardId: value.cardId,
  };
}

function parseRestoreCommand(record: MetaRecord, commandId: string): RestoreCommandValue {
  const value = record.value;
  const restoredCardIds = typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Array.isArray(value.restoredCardIds)
    ? value.restoredCardIds
    : undefined;
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || value.kind !== "restore-suspended"
    || typeof value.deckId !== "string"
    || restoredCardIds === undefined
    || restoredCardIds.some((cardId) => typeof cardId !== "string")
  ) {
    throw new SuspensionServiceError(
      "persistence",
      `Restore command ${commandId} has invalid persisted metadata.`,
    );
  }
  return {
    kind: "restore-suspended",
    deckId: value.deckId,
    restoredCardIds: restoredCardIds.filter(isString),
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SuspensionServiceError(
      "invalid-input",
      `${field} must be a non-empty string.`,
    );
  }
}

function optionalIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  assertIdentifier(value, field);
  return value;
}

function validateEpoch(value: number, field: string): void {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Number.isNaN(new Date(value).getTime())
  ) {
    throw new SuspensionServiceError(
      "invalid-input",
      `${field} must be a valid epoch-millisecond value.`,
    );
  }
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
