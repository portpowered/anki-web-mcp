import type {
  CardRecord,
  DeckRecord,
  EpochMilliseconds,
  Rating,
  SessionRecord,
  SessionQueueEntry,
} from "../domain/entities";
import {
  DEFAULT_SESSION_INTAKE_LIMIT,
  selectEligibleIntake,
  type IntakeCandidate,
  type NoEligibleCardsReason,
} from "../domain/queue-policy";
import {
  getLocalDayBoundary,
  LocalDayValidationError,
  resolveTimeZone,
  type LocalDayBoundary,
} from "../domain/local-day";
import type { Clock, IdGenerator } from "../domain/ports";
import type { SchedulerAdapter } from "../domain/scheduler";
import {
  type StudyDatabase,
  type StudyTransaction,
  StudyPersistenceError,
} from "../persistence/db";
import {
  RevealService,
  type RevealAnswerRequest,
  type RevealAnswerResult,
} from "./reveal-service";
import {
  ReviewService,
  type ReviewRequest,
  type ReviewResult,
} from "./review-service";
import {
  SuspensionService,
  type RestoreSuspendedRequest,
  type RestoreSuspendedResult,
  type SuspendRequest,
  type SuspensionResult,
} from "./suspension-service";

export const SESSION_TRANSACTION_STORES = [
  "decks",
  "cards",
  "schedules",
  "sessions",
] as const;

export type SessionServiceErrorCode =
  | "invalid-input"
  | "deck-not-found"
  | "conflict"
  | "persistence";

export class SessionServiceError extends Error {
  constructor(
    readonly code: SessionServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionServiceError";
  }
}

export interface SessionServiceOptions {
  readonly database: StudyDatabase;
  readonly clock: Clock;
  /** Browser-local IANA timezone. Defaults to the runtime's local timezone. */
  readonly timeZone?: string;
  readonly idGenerator?: IdGenerator;
  readonly scheduler?: SchedulerAdapter;
  /** Optional test/composition override; the deck value remains the default. */
  readonly intakeLimit?: number;
}

export interface CreatedSession {
  readonly status: "created";
  readonly kind: "created";
  readonly session: SessionRecord;
  readonly dayKey: string;
  readonly nextDayAt: EpochMilliseconds;
  readonly timeZone: string;
}

export interface ResumedSession {
  readonly status: "resumed";
  readonly kind: "resumed";
  readonly session: SessionRecord;
  readonly dayKey: string;
  readonly nextDayAt: EpochMilliseconds;
  readonly timeZone: string;
}

export interface NoSession {
  readonly status: "no-session";
  readonly kind: "no-session";
  readonly reason: NoEligibleCardsReason;
  readonly session: null;
  readonly dayKey: string;
  readonly nextDayAt: EpochMilliseconds;
  readonly intakeLimit: number;
  readonly timeZone: string;
}

export type SessionStartResult = CreatedSession | ResumedSession | NoSession;

/**
 * Durable use case for selecting a deck's current local-day session.
 *
 * The complete read/selection/sequence/write operation is deliberately kept
 * inside one read-write transaction. IndexedDB serializes those transactions,
 * and the unique [deckId, dayKey, sequence] index is the final invariant guard.
 */
export class SessionService {
  private readonly database: StudyDatabase;
  private readonly clock: Clock;
  private readonly timeZone: string;
  private readonly idGenerator: IdGenerator;
  private readonly configuredIntakeLimit: number | undefined;
  private readonly revealService: RevealService;
  private readonly reviewService: ReviewService;
  private readonly suspensionService: SuspensionService;

  constructor(options: SessionServiceOptions) {
    this.database = options.database;
    this.clock = options.clock;
    this.timeZone = resolveTimeZone(options.timeZone);
    this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
    this.configuredIntakeLimit = validateOptionalIntakeLimit(options.intakeLimit);
    this.revealService = new RevealService({
      database: this.database,
      clock: this.clock,
    });
    this.reviewService = new ReviewService({
      database: this.database,
      clock: this.clock,
      scheduler: options.scheduler,
      idGenerator: this.idGenerator,
    });
    this.suspensionService = new SuspensionService({
      database: this.database,
      clock: this.clock,
    });
  }

  async startSession(deckId: string): Promise<SessionStartResult> {
    assertDeckId(deckId);
    const now = this.clock.now();
    validateEpoch(now, "clock.now()");
    let boundary: LocalDayBoundary;
    try {
      boundary = getLocalDayBoundary(now, this.timeZone);
    } catch (error) {
      if (error instanceof LocalDayValidationError) {
        throw new SessionServiceError("invalid-input", error.message, { cause: error });
      }
      throw error;
    }

    try {
      return await this.database.transaction(
        "readwrite",
        SESSION_TRANSACTION_STORES,
        async (transaction) => this.selectOrCreate(
          transaction,
          deckId,
          now,
          boundary,
        ),
      );
    } catch (error) {
      if (error instanceof SessionServiceError) {
        throw error;
      }
      if (error instanceof StudyPersistenceError && error.code === "conflict") {
        throw new SessionServiceError(
          "conflict",
          "Another session start won the sequence allocation.",
          { cause: error },
        );
      }
      throw new SessionServiceError(
        "persistence",
        "Unable to select or create a study session.",
        { cause: error },
      );
    }
  }

  /** Naming aliases keep the application boundary easy to compose. */
  start(deckId: string): Promise<SessionStartResult> {
    return this.startSession(deckId);
  }

  createOrResumeSession(deckId: string): Promise<SessionStartResult> {
    return this.startSession(deckId);
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
    return typeof sessionIdOrRequest === "string"
      ? this.revealService.reveal(sessionIdOrRequest, expectedCardId as string)
      : this.revealService.reveal(sessionIdOrRequest);
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
    return typeof sessionIdOrRequest === "string"
      ? this.revealService.revealAnswer(sessionIdOrRequest, expectedCardId as string)
      : this.revealService.revealAnswer(sessionIdOrRequest);
  }

  revealCard(
    sessionId: string,
    expectedCardId: string,
  ): Promise<RevealAnswerResult>;
  revealCard(request: RevealAnswerRequest): Promise<RevealAnswerResult>;
  revealCard(
    sessionIdOrRequest: string | RevealAnswerRequest,
    expectedCardId?: string,
  ): Promise<RevealAnswerResult> {
    return typeof sessionIdOrRequest === "string"
      ? this.revealService.revealCard(sessionIdOrRequest, expectedCardId as string)
      : this.revealService.revealCard(sessionIdOrRequest);
  }

  rate(
    sessionId: string,
    expectedCardId: string,
    rating: Rating,
    commandId: string,
  ): Promise<ReviewResult>;
  rate(request: ReviewRequest): Promise<ReviewResult>;
  rate(
    sessionIdOrRequest: string | ReviewRequest,
    expectedCardId?: string,
    rating?: Rating,
    commandId?: string,
  ): Promise<ReviewResult> {
    return typeof sessionIdOrRequest === "string"
      ? this.reviewService.rate(
        sessionIdOrRequest,
        expectedCardId as string,
        rating as Rating,
        commandId as string,
      )
      : this.reviewService.rate(sessionIdOrRequest);
  }

  review(
    sessionId: string,
    expectedCardId: string,
    rating: Rating,
    commandId: string,
  ): Promise<ReviewResult>;
  review(request: ReviewRequest): Promise<ReviewResult>;
  review(
    sessionIdOrRequest: string | ReviewRequest,
    expectedCardId?: string,
    rating?: Rating,
    commandId?: string,
  ): Promise<ReviewResult> {
    return typeof sessionIdOrRequest === "string"
      ? this.reviewService.review(
        sessionIdOrRequest,
        expectedCardId as string,
        rating as Rating,
        commandId as string,
      )
      : this.reviewService.review(sessionIdOrRequest);
  }

  rateCard(
    sessionId: string,
    expectedCardId: string,
    rating: Rating,
    commandId: string,
  ): Promise<ReviewResult>;
  rateCard(request: ReviewRequest): Promise<ReviewResult>;
  rateCard(
    sessionIdOrRequest: string | ReviewRequest,
    expectedCardId?: string,
    rating?: Rating,
    commandId?: string,
  ): Promise<ReviewResult> {
    return typeof sessionIdOrRequest === "string"
      ? this.reviewService.rateCard(
        sessionIdOrRequest,
        expectedCardId as string,
        rating as Rating,
        commandId as string,
      )
      : this.reviewService.rateCard(sessionIdOrRequest);
  }

  setState(
    sessionId: string,
    expectedCardId: string,
    rating: Rating,
    commandId: string,
  ): Promise<ReviewResult>;
  setState(request: ReviewRequest): Promise<ReviewResult>;
  setState(
    sessionIdOrRequest: string | ReviewRequest,
    expectedCardId?: string,
    rating?: Rating,
    commandId?: string,
  ): Promise<ReviewResult> {
    return typeof sessionIdOrRequest === "string"
      ? this.reviewService.setState(
        sessionIdOrRequest,
        expectedCardId as string,
        rating as Rating,
        commandId as string,
      )
       : this.reviewService.setState(sessionIdOrRequest);
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
    return typeof sessionIdOrRequest === "string"
      ? this.suspensionService.suspend(
        sessionIdOrRequest,
        expectedCardId as string,
        commandId as string,
      )
      : this.suspensionService.suspend(sessionIdOrRequest);
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
    return typeof sessionIdOrRequest === "string"
      ? this.suspensionService.suspendCard(
        sessionIdOrRequest,
        expectedCardId as string,
        commandId as string,
      )
      : this.suspensionService.suspendCard(sessionIdOrRequest);
  }

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
    return typeof sessionIdOrRequest === "string"
      ? this.suspensionService.suspendCurrentCard(
        sessionIdOrRequest,
        expectedCardId as string,
        commandId as string,
      )
      : this.suspensionService.suspendCurrentCard(sessionIdOrRequest);
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
    return typeof deckIdOrRequest === "string"
      ? this.suspensionService.restoreSuspended(deckIdOrRequest, commandId)
      : this.suspensionService.restoreSuspended(deckIdOrRequest);
  }

  restore(
    deckId: string,
    commandId?: string,
  ): Promise<RestoreSuspendedResult>;
  restore(request: RestoreSuspendedRequest): Promise<RestoreSuspendedResult>;
  restore(
    deckIdOrRequest: string | RestoreSuspendedRequest,
    commandId?: string,
  ): Promise<RestoreSuspendedResult> {
    return typeof deckIdOrRequest === "string"
      ? this.suspensionService.restore(deckIdOrRequest, commandId)
      : this.suspensionService.restore(deckIdOrRequest);
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
    return typeof deckIdOrRequest === "string"
      ? this.suspensionService.restoreSuspendedCards(deckIdOrRequest, commandId)
      : this.suspensionService.restoreSuspendedCards(deckIdOrRequest);
  }

  private async selectOrCreate(
    transaction: StudyTransaction,
    deckId: string,
    now: EpochMilliseconds,
    boundary: LocalDayBoundary,
  ): Promise<SessionStartResult> {
    const deck = await transaction.getDeck(deckId);
    if (deck === undefined) {
      throw new SessionServiceError(
        "deck-not-found",
        `Deck ${deckId} was not found.`,
      );
    }

    const sessions = await transaction.listSessions(deckId);
    const incompleteSessions = sessions.filter(isIncompleteSession);
    const incompleteToday = incompleteSessions
      .filter((session) => session.dayKey === boundary.dayKey)
      .sort(compareSessionOrder);
    const latestIncomplete = incompleteToday.at(-1);
    if (latestIncomplete !== undefined) {
      const resumedSession = activateReadyOccurrence(latestIncomplete, now);
      if (resumedSession !== latestIncomplete) {
        await transaction.putSession(resumedSession);
      }
      return {
        status: "resumed",
        kind: "resumed",
        session: resumedSession,
        dayKey: resumedSession.dayKey,
        nextDayAt: resumedSession.nextDayAt,
        timeZone: boundary.timeZone,
      };
    }

    const intakeLimit = resolveIntakeLimit(deck, this.configuredIntakeLimit);
    const [cards, schedules] = await Promise.all([
      transaction.listCards(deckId),
      transaction.listSchedules(deckId),
    ]);
    const candidates = joinCandidates(deckId, cards, schedules);
    const selection = selectEligibleIntake({
      candidates,
      now,
      intakeLimit,
      // Completed sessions are historical records, not reservations. Only
      // occurrences in incomplete sessions can keep a card out of a later
      // same-day sequence.
      incompleteSessions,
    });

    if (selection.status === "no-eligible-cards") {
      return {
        status: "no-session",
        kind: "no-session",
        reason: selection.reason,
        session: null,
        dayKey: boundary.dayKey,
        nextDayAt: boundary.nextDayAt,
        intakeLimit,
        timeZone: boundary.timeZone,
      };
    }

    const sequence = nextSequence(sessions, boundary.dayKey);
    const session = await this.createSession(
      transaction,
      deckId,
      boundary,
      now,
      sequence,
      intakeLimit,
      selection.candidates,
    );
    await transaction.putSession(session);

    return {
      status: "created",
      kind: "created",
      session,
      dayKey: boundary.dayKey,
      nextDayAt: boundary.nextDayAt,
      timeZone: boundary.timeZone,
    };
  }

  private async createSession(
    transaction: StudyTransaction,
    deckId: string,
    boundary: LocalDayBoundary,
    now: EpochMilliseconds,
    sequence: number,
    intakeLimit: number,
    candidates: readonly IntakeCandidate[],
  ): Promise<SessionRecord> {
    const id = await this.nextUnusedSessionId(transaction);
    const queueEntries: SessionQueueEntry[] = candidates.map((candidate, index) => ({
      cardId: candidate.card.id,
      dueAt: candidate.schedule.dueAt,
      ordinal: index + 1,
    }));

    return {
      id,
      deckId,
      dayKey: boundary.dayKey,
      sequence,
      intakeLimit,
      nextDayAt: boundary.nextDayAt,
      queueEntries,
      activeCardId: queueEntries[0]?.cardId ?? null,
      plannedPresentationCount: queueEntries.length,
      completedPresentationCount: 0,
      currentSide: "front",
      ratingCounts: {
        again: 0,
        hard: 0,
        good: 0,
        easy: 0,
      },
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      lastCommandIds: [],
    };
  }

  private async nextUnusedSessionId(transaction: StudyTransaction): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.idGenerator.next("session");
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new SessionServiceError(
          "invalid-input",
          "The session ID generator returned an empty ID.",
        );
      }
      if (await transaction.getSession(id) === undefined) {
        return id;
      }
    }
    throw new SessionServiceError(
      "conflict",
      "The session ID generator repeatedly returned an existing ID.",
    );
  }
}

export class RandomIdGenerator implements IdGenerator {
  private static fallbackCounter = 0;

  next(namespace = "id"): string {
    const randomUuid = globalThis.crypto?.randomUUID;
    const suffix = randomUuid !== undefined
      ? randomUuid.call(globalThis.crypto)
      : `local-${RandomIdGenerator.fallbackCounter++}-${Math.random().toString(36).slice(2)}`;
    return `${namespace}-${suffix}`;
  }
}

function joinCandidates(
  deckId: string,
  cards: readonly CardRecord[],
  schedules: readonly { cardId: string; deckId: string; dueAt: number; state: IntakeCandidate["schedule"]["state"]; suspended: boolean }[],
): IntakeCandidate[] {
  const schedulesByCardId = new Map(
    schedules
      .filter((schedule) => schedule.deckId === deckId)
      .map((schedule) => [schedule.cardId, schedule]),
  );
  return cards
    .filter((card) => card.deckId === deckId)
    .flatMap((card) => {
      const schedule = schedulesByCardId.get(card.id);
      return schedule === undefined
        ? []
        : [{
            card: {
              id: card.id,
              creationOrder: card.creationOrder,
            },
            schedule: {
              cardId: schedule.cardId,
              dueAt: schedule.dueAt,
              state: schedule.state,
              suspended: schedule.suspended,
            },
          }];
    });
}

function nextSequence(sessions: readonly SessionRecord[], dayKey: string): number {
  let highest = 0;
  for (const session of sessions) {
    if (session.dayKey !== dayKey) continue;
    if (!Number.isInteger(session.sequence) || session.sequence < 1) {
      throw new SessionServiceError(
        "persistence",
        `Session ${session.id} has an invalid sequence.`,
      );
    }
    highest = Math.max(highest, session.sequence);
  }
  return highest + 1;
}

function compareSessionOrder(left: SessionRecord, right: SessionRecord): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isIncompleteSession(session: SessionRecord): boolean {
  return session.completedAt === null;
}

/**
 * Rehydrates the active presentation when a waiting session is resumed after
 * its earliest delayed occurrence becomes due. The queue and all progress
 * counters remain untouched; only the transient presentation pointer and
 * side are advanced inside the same transaction as the resume read.
 */
function activateReadyOccurrence(
  session: SessionRecord,
  now: EpochMilliseconds,
): SessionRecord {
  const nextReady = [...session.queueEntries]
    .filter((entry) => entry.dueAt <= now)
    .sort(compareQueueEntries)[0];

  // A non-null active card is an in-progress presentation. Preserve it
  // exactly; only a waiting session (represented by a null active card) may
  // be promoted by a later resume.
  if (session.activeCardId !== null || nextReady === undefined) {
    return session;
  }

  return {
    ...session,
    activeCardId: nextReady.cardId,
    currentSide: "front",
    updatedAt: now,
  };
}

function compareQueueEntries(left: SessionQueueEntry, right: SessionQueueEntry): number {
  if (left.dueAt !== right.dueAt) return left.dueAt - right.dueAt;
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0;
}

function resolveIntakeLimit(
  deck: DeckRecord,
  configuredLimit: number | undefined,
): number {
  const value = configuredLimit ?? deck.sessionIntakeLimit ?? DEFAULT_SESSION_INTAKE_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    throw new SessionServiceError(
      "invalid-input",
      "The session intake limit must be a positive integer.",
    );
  }
  return value;
}

function validateOptionalIntakeLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new SessionServiceError(
      "invalid-input",
      "The session intake limit must be a positive integer.",
    );
  }
  return value;
}

function assertDeckId(deckId: string): void {
  if (typeof deckId !== "string" || deckId.trim().length === 0) {
    throw new SessionServiceError(
      "invalid-input",
      "A non-empty deck ID is required.",
    );
  }
}

function validateEpoch(value: number, field: string): void {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Number.isNaN(new Date(value).getTime())
  ) {
    throw new SessionServiceError(
      "invalid-input",
      `${field} must be a valid epoch-millisecond value.`,
    );
  }
}
