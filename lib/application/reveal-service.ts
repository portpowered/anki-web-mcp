import type {
  CardRecord,
  EpochMilliseconds,
  SessionRecord,
} from "../domain/entities";
import type { Clock } from "../domain/ports";
import type { OperationGuard } from "./operation-guard";
import {
  type StudyDatabase,
  type StudyTransaction,
  StudyPersistenceError,
} from "../persistence/db";

export const REVEAL_TRANSACTION_STORES = ["cards", "sessions"] as const;

export type RevealServiceErrorCode =
  | "invalid-input"
  | "session-not-found"
  | "completed-session"
  | "stale-card"
  | "card-not-found"
  | "invalid-session-state"
  | "cancelled"
  | "persistence";

export class RevealServiceError extends Error {
  constructor(
    readonly code: RevealServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RevealServiceError";
  }
}

export interface RevealServiceOptions {
  readonly database: StudyDatabase;
  /** Used only for the persisted session update timestamp. */
  readonly clock: Clock;
}

export interface RevealAnswerRequest {
  readonly sessionId: string;
  /** The caller's expected current card ID. */
  readonly expectedCardId?: string;
  /** Alias accepted by callers that use the persisted field name. */
  readonly cardId?: string;
  readonly canCommit?: OperationGuard;
}

export interface RevealedAnswer {
  readonly status: "revealed";
  readonly kind: "revealed";
  readonly changed: true;
  readonly idempotent: false;
  readonly session: SessionRecord;
  readonly card: CardRecord;
}

export interface AlreadyRevealedAnswer {
  readonly status: "already-revealed";
  readonly kind: "already-revealed";
  readonly changed: false;
  readonly idempotent: true;
  readonly session: SessionRecord;
  readonly card: CardRecord;
}

export type RevealAnswerResult = RevealedAnswer | AlreadyRevealedAnswer;

/**
 * Persists the front-to-back transition for the current presentation.
 *
 * The expected session/card pair is checked after the session is read inside
 * the write transaction. A repeated request is an explicit no-op success;
 * every other invalid state fails before any record is written.
 */
export class RevealService {
  private readonly database: StudyDatabase;
  private readonly clock: Clock;

  constructor(options: RevealServiceOptions) {
    this.database = options.database;
    this.clock = options.clock;
  }

  revealAnswer(
    sessionId: string,
    expectedCardId: string,
  ): Promise<RevealAnswerResult>;
  revealAnswer(request: RevealAnswerRequest): Promise<RevealAnswerResult>;
  revealAnswer(
    sessionIdOrRequest: string | RevealAnswerRequest,
    expectedCardId?: string,
  ): Promise<RevealAnswerResult> {
    return this.execute(sessionIdOrRequest, expectedCardId);
  }

  reveal(
    sessionId: string,
    expectedCardId: string,
  ): Promise<RevealAnswerResult>;
  reveal(request: RevealAnswerRequest): Promise<RevealAnswerResult>;
  reveal(
    sessionIdOrRequest: string | RevealAnswerRequest,
    expectedCardId?: string,
  ): Promise<RevealAnswerResult> {
    return this.execute(sessionIdOrRequest, expectedCardId);
  }

  /** Alias for application callers that name the operation after the card. */
  revealCard(
    sessionId: string,
    expectedCardId: string,
  ): Promise<RevealAnswerResult>;
  revealCard(request: RevealAnswerRequest): Promise<RevealAnswerResult>;
  revealCard(
    sessionIdOrRequest: string | RevealAnswerRequest,
    expectedCardId?: string,
  ): Promise<RevealAnswerResult> {
    return this.execute(sessionIdOrRequest, expectedCardId);
  }

  private async execute(
    sessionIdOrRequest: string | RevealAnswerRequest,
    expectedCardId?: string,
  ): Promise<RevealAnswerResult> {
    const request = normalizeRequest(sessionIdOrRequest, expectedCardId);
    const now = this.clock.now();
    validateEpoch(now, "clock.now()");

    try {
      return await this.database.transaction(
        "readwrite",
        REVEAL_TRANSACTION_STORES,
        (transaction) => this.revealInTransaction(transaction, request, now),
      );
    } catch (error) {
      if (error instanceof RevealServiceError) {
        throw error;
      }
      if (error instanceof StudyPersistenceError) {
        throw new RevealServiceError(
          "persistence",
          "Unable to persist the answer reveal.",
          { cause: error },
        );
      }
      throw new RevealServiceError(
        "persistence",
        "Unable to persist the answer reveal.",
        { cause: error },
      );
    }
  }

  private async revealInTransaction(
    transaction: StudyTransaction,
    request: NormalizedRevealRequest,
    now: EpochMilliseconds,
  ): Promise<RevealAnswerResult> {
    const session = await transaction.getSession(request.sessionId);
    if (session === undefined) {
      throw new RevealServiceError(
        "session-not-found",
        `Session ${request.sessionId} was not found.`,
      );
    }
    if (session.completedAt !== null) {
      throw new RevealServiceError(
        "completed-session",
        `Session ${session.id} is already completed.`,
      );
    }
    if (session.activeCardId !== request.expectedCardId) {
      throw new RevealServiceError(
        "stale-card",
        `Card ${request.expectedCardId} is not the current card for session ${session.id}.`,
      );
    }

    const card = await transaction.getCard(request.expectedCardId);
    if (card === undefined || card.deckId !== session.deckId) {
      throw new RevealServiceError(
        "card-not-found",
        `Card ${request.expectedCardId} is no longer present in session ${session.id}.`,
      );
    }

    if (session.currentSide === "back") {
      return {
        status: "already-revealed",
        kind: "already-revealed",
        changed: false,
        idempotent: true,
        session,
        card,
      };
    }
    if (session.currentSide !== "front") {
      throw new RevealServiceError(
        "invalid-session-state",
        `Session ${session.id} has an unsupported current side.`,
      );
    }

    const revealedSession: SessionRecord = {
      ...session,
      currentSide: "back",
      updatedAt: now,
    };
    await transaction.putSession(revealedSession);
    assertCanCommit(request.canCommit);

    return {
      status: "revealed",
      kind: "revealed",
      changed: true,
      idempotent: false,
      session: revealedSession,
      card,
    };
  }
}

/** Naming aliases for composition roots that use a more explicit class name. */
export {
  RevealService as AnswerRevealService,
  RevealService as RevealAnswerService,
  RevealService as SessionRevealService,
};

interface NormalizedRevealRequest {
  readonly sessionId: string;
  readonly expectedCardId: string;
  readonly canCommit?: OperationGuard;
}

function normalizeRequest(
  sessionIdOrRequest: string | RevealAnswerRequest,
  expectedCardId: string | undefined,
): NormalizedRevealRequest {
  const sessionId = typeof sessionIdOrRequest === "string"
    ? sessionIdOrRequest
    : sessionIdOrRequest?.sessionId;
  const requestCardId = typeof sessionIdOrRequest === "string"
    ? expectedCardId
    : sessionIdOrRequest?.expectedCardId ?? sessionIdOrRequest?.cardId;

  assertIdentifier(sessionId, "sessionId");
  assertIdentifier(requestCardId, "expectedCardId");
  return {
    sessionId,
    expectedCardId: requestCardId,
    ...(typeof sessionIdOrRequest !== "string" && sessionIdOrRequest.canCommit
      ? { canCommit: sessionIdOrRequest.canCommit }
      : {}),
  };
}

function assertCanCommit(guard: OperationGuard | undefined): void {
  if (guard && !guard()) {
    throw new RevealServiceError(
      "cancelled",
      "The reveal became obsolete before it could commit.",
    );
  }
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RevealServiceError(
      "invalid-input",
      `${field} must be a non-empty string.`,
    );
  }
}

function validateEpoch(value: number, field: string): void {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Number.isNaN(new Date(value).getTime())
  ) {
    throw new RevealServiceError(
      "invalid-input",
      `${field} must be a valid epoch-millisecond value.`,
    );
  }
}
