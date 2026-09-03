import type {
  CardRecord,
  EpochMilliseconds,
  Rating,
  ReviewLogRecord,
  ScheduleRecord,
  ScheduleSnapshot,
  SessionQueueEntry,
  SessionRecord,
} from "../domain/entities";
import type { Clock, IdGenerator } from "../domain/ports";
import type { OperationGuard } from "./operation-guard";
import {
  createProductionSchedulerAdapter,
  SchedulerValidationError,
  type AppliedSchedule,
  type SchedulerAdapter,
  type SchedulerLog,
} from "../domain/scheduler";
import type {
  StudyDatabase,
  StudyTransaction,
} from "../persistence/db";
import { StudyPersistenceError } from "../persistence/db";

export const REVIEW_TRANSACTION_STORES = [
  "cards",
  "decks",
  "schedules",
  "sessions",
  "reviewLogs",
] as const;

const MAX_COMMAND_IDS = 64;

export type ReviewServiceErrorCode =
  | "invalid-input"
  | "invalid-rating"
  | "invalid-schedule"
  | "session-not-found"
  | "completed-session"
  | "stale-card"
  | "front-side"
  | "card-not-found"
  | "deck-not-found"
  | "schedule-not-found"
  | "invalid-session-state"
  | "duplicate-command"
  | "conflict"
  | "cancelled"
  | "persistence";

export class ReviewServiceError extends Error {
  constructor(
    readonly code: ReviewServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReviewServiceError";
  }
}

export interface ReviewServiceOptions {
  readonly database: StudyDatabase;
  readonly clock: Clock;
  /** Production is the default; deterministic tests can inject the adapter. */
  readonly scheduler?: SchedulerAdapter;
  readonly idGenerator?: IdGenerator;
}

export interface ReviewRequest {
  readonly sessionId: string;
  /** The caller's expected current card ID. */
  readonly expectedCardId?: string;
  /** Alias accepted by callers that use the persisted field name. */
  readonly cardId?: string;
  readonly rating: Rating;
  readonly commandId: string;
  readonly canCommit?: OperationGuard;
}

export interface ReviewTransition {
  readonly reviewedCardId: string;
  readonly rating: Rating;
  readonly previousDueAt: EpochMilliseconds;
  readonly nextDueAt: EpochMilliseconds;
  readonly nextCardId: string | null;
}

interface ReviewResultBase {
  readonly session: SessionRecord;
  readonly card: CardRecord;
  readonly schedule: ScheduleRecord | null;
  readonly previousSchedule: ScheduleRecord | null;
  readonly reviewLog: ReviewLogRecord | null;
  readonly rating: Rating;
  readonly nextCardId: string | null;
  /** The next ready/delayed occurrence, when one exists. */
  readonly nextPresentationDueAt: EpochMilliseconds | null;
}

export interface RatedReview extends ReviewResultBase {
  readonly status: "rated";
  readonly kind: "rated";
  readonly changed: true;
  readonly idempotent: false;
  readonly schedule: ScheduleRecord;
  readonly previousSchedule: ScheduleRecord;
  readonly reviewLog: ReviewLogRecord;
  readonly transition: ReviewTransition;
}

/**
 * A committed rating that leaves only not-yet-due same-day work in the queue.
 *
 * Waiting is deliberately distinct from completion: the session remains
 * resumable and the returned due time tells callers when to try again.
 */
export interface WaitingReview extends ReviewResultBase {
  readonly status: "waiting";
  readonly kind: "waiting";
  readonly changed: true;
  readonly idempotent: false;
  readonly schedule: ScheduleRecord;
  readonly previousSchedule: ScheduleRecord;
  readonly reviewLog: ReviewLogRecord;
  readonly nextCardId: null;
  readonly nextPresentationDueAt: EpochMilliseconds;
  readonly waitingUntil: EpochMilliseconds;
  readonly transition: ReviewTransition;
}

export interface DuplicateReview extends ReviewResultBase {
  readonly status: "duplicate";
  readonly kind: "duplicate";
  readonly changed: false;
  readonly idempotent: true;
  readonly transition: ReviewTransition | null;
}

export type ReviewResult = RatedReview | WaitingReview | DuplicateReview;
export type RatingResult = ReviewResult;
export type AppliedRating = RatedReview | WaitingReview;

/**
 * Applies one guarded rating as a single durable transaction.
 *
 * The scheduler is called only after the persisted session/card/side and
 * schedule have been validated inside the write transaction. The resulting
 * schedule, review log, queue transition, session counters, and deck timestamp
 * are committed together by the database boundary.
 */
export class ReviewService {
  private readonly database: StudyDatabase;
  private readonly clock: Clock;
  private readonly scheduler: SchedulerAdapter;
  private readonly idGenerator: IdGenerator;

  constructor(options: ReviewServiceOptions) {
    this.database = options.database;
    this.clock = options.clock;
    this.scheduler = options.scheduler ?? createProductionSchedulerAdapter(options.clock);
    this.idGenerator = options.idGenerator ?? new DefaultReviewIdGenerator();
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
    return this.execute(
      sessionIdOrRequest,
      expectedCardId,
      rating,
      commandId,
    );
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
      ? this.rate(sessionIdOrRequest, expectedCardId as string, rating as Rating, commandId as string)
      : this.rate(sessionIdOrRequest);
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
      ? this.rate(sessionIdOrRequest, expectedCardId as string, rating as Rating, commandId as string)
      : this.rate(sessionIdOrRequest);
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
      ? this.rate(sessionIdOrRequest, expectedCardId as string, rating as Rating, commandId as string)
      : this.rate(sessionIdOrRequest);
  }

  private async execute(
    sessionIdOrRequest: string | ReviewRequest,
    expectedCardId: string | undefined,
    rating: Rating | undefined,
    commandId: string | undefined,
  ): Promise<ReviewResult> {
    const request = normalizeRequest(
      sessionIdOrRequest,
      expectedCardId,
      rating,
      commandId,
    );
    const now = this.clock.now();
    validateEpoch(now, "clock.now()");

    try {
      return await this.database.transaction(
        "readwrite",
        REVIEW_TRANSACTION_STORES,
        (transaction) => this.rateInTransaction(transaction, request, now),
      );
    } catch (error) {
      if (error instanceof ReviewServiceError) {
        throw error;
      }
      if (error instanceof SchedulerValidationError) {
        throw new ReviewServiceError(
          error.code === "invalid-rating" ? "invalid-rating" : "invalid-schedule",
          error.message,
          { cause: error },
        );
      }
      if (error instanceof StudyPersistenceError && error.code === "conflict") {
        throw new ReviewServiceError(
          "conflict",
          "Another rating changed this presentation before the command committed.",
          { cause: error },
        );
      }
      throw new ReviewServiceError(
        "persistence",
        "Unable to persist the card rating.",
        { cause: error },
      );
    }
  }

  private async rateInTransaction(
    transaction: StudyTransaction,
    request: NormalizedReviewRequest,
    now: EpochMilliseconds,
  ): Promise<ReviewResult> {
    const session = await transaction.getSession(request.sessionId);
    if (session === undefined) {
      throw new ReviewServiceError(
        "session-not-found",
        `Session ${request.sessionId} was not found.`,
      );
    }

    const committedLog = transaction.getReviewLogByCommandId === undefined
      ? undefined
      : await transaction.getReviewLogByCommandId(request.commandId);
    if (committedLog !== undefined) {
      if (
        committedLog.sessionId !== request.sessionId
        || committedLog.cardId !== request.expectedCardId
        || committedLog.rating !== request.rating
      ) {
        throw new ReviewServiceError(
          "duplicate-command",
          `Command ${request.commandId} was already committed for another rating.`,
        );
      }
      return this.duplicateFromLog(transaction, session, committedLog, now);
    }

    // This fallback protects records written by an older adapter that tracked
    // command IDs before the review-log lookup was available.
    if (session.lastCommandIds.includes(request.commandId)) {
      return this.duplicateLegacyCommand(transaction, session, request, now);
    }

    if (session.completedAt !== null) {
      throw new ReviewServiceError(
        "completed-session",
        `Session ${session.id} is already completed.`,
      );
    }
    if (session.activeCardId !== request.expectedCardId) {
      throw new ReviewServiceError(
        "stale-card",
        `Card ${request.expectedCardId} is not the current card for session ${session.id}.`,
      );
    }
    if (session.currentSide === "front") {
      throw new ReviewServiceError(
        "front-side",
        `Card ${request.expectedCardId} must be revealed before it can be rated.`,
      );
    }
    if (session.currentSide !== "back") {
      throw new ReviewServiceError(
        "invalid-session-state",
        `Session ${session.id} has an unsupported current side.`,
      );
    }

    const currentOccurrence = findCurrentOccurrence(session, now);
    if (currentOccurrence === undefined) {
      throw new ReviewServiceError(
        "invalid-session-state",
        `Session ${session.id} has no ready queue occurrence for its active card.`,
      );
    }

    const card = await transaction.getCard(request.expectedCardId);
    if (card === undefined || card.deckId !== session.deckId) {
      throw new ReviewServiceError(
        "card-not-found",
        `Card ${request.expectedCardId} is no longer present in session ${session.id}.`,
      );
    }
    const deck = await transaction.getDeck(session.deckId);
    if (deck === undefined) {
      throw new ReviewServiceError(
        "deck-not-found",
        `Deck ${session.deckId} was not found.`,
      );
    }
    const schedule = await transaction.getSchedule(request.expectedCardId);
    if (schedule === undefined || schedule.deckId !== session.deckId) {
      throw new ReviewServiceError(
        "schedule-not-found",
        `Schedule for card ${request.expectedCardId} was not found.`,
      );
    }
    if (schedule.suspended) {
      throw new ReviewServiceError(
        "invalid-session-state",
        `Card ${request.expectedCardId} is suspended and cannot be rated.`,
      );
    }

    const before = cloneSchedule(schedule);
    const applied = this.scheduler.apply(schedule, request.rating, new Date(now));
    validateAppliedResult(applied, schedule, request.rating, now);

    const nextQueue = removeOccurrence(session.queueEntries, currentOccurrence);
    const currentDayQueue = nextQueue.filter((entry) => entry.dueAt < session.nextDayAt);
    const removedAfterCutoffCount = nextQueue.length - currentDayQueue.length;
    const shouldRequeueToday = applied.schedule.dueAt < session.nextDayAt;
    if (shouldRequeueToday) {
      currentDayQueue.push({
        cardId: request.expectedCardId,
        dueAt: applied.schedule.dueAt,
        ordinal: nextQueueOrdinal(session.queueEntries),
      });
    }
    const orderedQueue = sortQueueEntries(currentDayQueue);
    const nextReady = orderedQueue.find((entry) => entry.dueAt <= now);
    const nextDelayed = orderedQueue.find((entry) => entry.dueAt > now);
    const nextActiveCardId = nextReady?.cardId ?? null;
    // Completion is a property of the durable occurrence queue, not merely
    // of the card that was just rated. A queue with future same-day work is
    // resumable waiting state; a queue with a ready occurrence is still an
    // active session. Only the empty queue may become an immutable history
    // record.
    const hasPendingPresentation = nextReady !== undefined || nextDelayed !== undefined;
    const updatedSession: SessionRecord = {
      ...session,
      queueEntries: orderedQueue,
      activeCardId: nextActiveCardId,
      plannedPresentationCount: session.plannedPresentationCount
        - removedAfterCutoffCount
        + (shouldRequeueToday ? 1 : 0),
      completedPresentationCount: session.completedPresentationCount + 1,
      currentSide: "front",
      ratingCounts: {
        ...session.ratingCounts,
        [request.rating]: session.ratingCounts[request.rating] + 1,
      },
      updatedAt: now,
      completedAt: hasPendingPresentation ? null : now,
      lastCommandIds: appendCommandId(session.lastCommandIds, request.commandId),
    };

    const reviewLog = await this.createReviewLog(
      transaction,
      session,
      card,
      request.rating,
      before,
      applied.schedule,
      applied.log.reviewedAt,
      request.commandId,
    );
    if (transaction.putReviewLog === undefined) {
      throw new ReviewServiceError(
        "persistence",
        "The configured study transaction cannot store review logs.",
      );
    }

    // Keep these writes in this order so injected failures exercise every
    // boundary; the surrounding database transaction rolls all of them back.
    await transaction.putSchedule(applied.schedule);
    await transaction.putReviewLog(reviewLog);
    await transaction.putSession(updatedSession);
    await transaction.putDeck({ ...deck, lastStudiedAt: now });
    assertCanCommit(request.canCommit);

    const result = {
      status: "rated",
      kind: "rated",
      changed: true,
      idempotent: false,
      session: updatedSession,
      card,
      schedule: applied.schedule,
      previousSchedule: before,
      reviewLog,
      rating: request.rating,
      nextCardId: nextActiveCardId,
      nextPresentationDueAt: nextReady?.dueAt ?? nextDelayed?.dueAt ?? null,
      transition: {
        reviewedCardId: card.id,
        rating: request.rating,
        previousDueAt: before.dueAt,
        nextDueAt: applied.schedule.dueAt,
        nextCardId: nextActiveCardId,
      },
    } as const;

    if (nextReady === undefined && nextDelayed !== undefined) {
      return {
        ...result,
        status: "waiting",
        kind: "waiting",
        nextCardId: null,
        nextPresentationDueAt: nextDelayed.dueAt,
        waitingUntil: nextDelayed.dueAt,
      } satisfies WaitingReview;
    }
    return result satisfies RatedReview;
  }

  private async duplicateFromLog(
    transaction: StudyTransaction,
    session: SessionRecord,
    reviewLog: ReviewLogRecord,
    now: EpochMilliseconds,
  ): Promise<DuplicateReview> {
    const card = await transaction.getCard(reviewLog.cardId);
    if (card === undefined || card.deckId !== session.deckId) {
      throw new ReviewServiceError(
        "card-not-found",
        `Card ${reviewLog.cardId} is no longer present for duplicate command ${reviewLog.commandId}.`,
      );
    }
    const persistedSchedule = await transaction.getSchedule(reviewLog.cardId);
    const schedule = persistedSchedule ?? scheduleFromSnapshot(
      reviewLog.after,
      reviewLog.cardId,
      reviewLog.deckId,
    );
    return {
      status: "duplicate",
      kind: "duplicate",
      changed: false,
      idempotent: true,
      session,
      card,
      schedule,
      previousSchedule: scheduleFromSnapshot(
        reviewLog.before,
        reviewLog.cardId,
        reviewLog.deckId,
      ),
      reviewLog,
      rating: reviewLog.rating,
      nextCardId: session.activeCardId,
      nextPresentationDueAt: nextPresentationDueAt(session, now),
      transition: {
        reviewedCardId: reviewLog.cardId,
        rating: reviewLog.rating,
        previousDueAt: reviewLog.before.dueAt,
        nextDueAt: reviewLog.after.dueAt,
        nextCardId: session.activeCardId,
      },
    };
  }

  private async duplicateLegacyCommand(
    transaction: StudyTransaction,
    session: SessionRecord,
    request: NormalizedReviewRequest,
    now: EpochMilliseconds,
  ): Promise<DuplicateReview> {
    const card = await transaction.getCard(request.expectedCardId);
    if (card === undefined || card.deckId !== session.deckId) {
      throw new ReviewServiceError(
        "card-not-found",
        `Card ${request.expectedCardId} is no longer present for duplicate command.`,
      );
    }
    const schedule = await transaction.getSchedule(request.expectedCardId);
    return {
      status: "duplicate",
      kind: "duplicate",
      changed: false,
      idempotent: true,
      session,
      card,
      schedule: schedule ?? null,
      previousSchedule: null,
      reviewLog: null,
      rating: request.rating,
      nextCardId: session.activeCardId,
      nextPresentationDueAt: nextPresentationDueAt(session, now),
      transition: null,
    };
  }

  private async createReviewLog(
    transaction: StudyTransaction,
    session: SessionRecord,
    card: CardRecord,
    rating: Rating,
    before: ScheduleRecord,
    after: ScheduleRecord,
    reviewedAt: EpochMilliseconds,
    commandId: string,
  ): Promise<ReviewLogRecord> {
    const id = await this.nextReviewLogId(transaction);
    return {
      id,
      sessionId: session.id,
      deckId: session.deckId,
      cardId: card.id,
      rating,
      reviewedAt,
      durationMs: null,
      before: scheduleSnapshot(before),
      after: scheduleSnapshot(after),
      commandId,
    };
  }

  private async nextReviewLogId(transaction: StudyTransaction): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.idGenerator.next("review-log");
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new ReviewServiceError(
          "invalid-input",
          "The review log ID generator returned an empty ID.",
        );
      }
      if (
        transaction.getReviewLog === undefined
        || await transaction.getReviewLog(id) === undefined
      ) {
        return id;
      }
    }
    throw new ReviewServiceError(
      "conflict",
      "The review log ID generator repeatedly returned an existing ID.",
    );
  }
}

/** Naming aliases for composition roots that use rating terminology. */
export {
  ReviewService as RatingService,
  ReviewService as CardReviewService,
};

class DefaultReviewIdGenerator implements IdGenerator {
  private nextValue = 1;

  next(namespace = "id"): string {
    return `${namespace}-${this.nextValue++}`;
  }
}

interface NormalizedReviewRequest {
  readonly sessionId: string;
  readonly expectedCardId: string;
  readonly rating: Rating;
  readonly commandId: string;
  readonly canCommit?: OperationGuard;
}

function normalizeRequest(
  sessionIdOrRequest: string | ReviewRequest,
  expectedCardId: string | undefined,
  rating: Rating | undefined,
  commandId: string | undefined,
): NormalizedReviewRequest {
  const sessionId = typeof sessionIdOrRequest === "string"
    ? sessionIdOrRequest
    : sessionIdOrRequest?.sessionId;
  const requestCardId = typeof sessionIdOrRequest === "string"
    ? expectedCardId
    : sessionIdOrRequest?.expectedCardId ?? sessionIdOrRequest?.cardId;
  const requestRating = typeof sessionIdOrRequest === "string"
    ? rating
    : sessionIdOrRequest?.rating;
  const requestCommandId = typeof sessionIdOrRequest === "string"
    ? commandId
    : sessionIdOrRequest?.commandId;

  assertIdentifier(sessionId, "sessionId");
  assertIdentifier(requestCardId, "expectedCardId");
  assertIdentifier(requestCommandId, "commandId");
  if (!isRating(requestRating)) {
    throw new ReviewServiceError(
      "invalid-rating",
      `Unknown rating: ${String(requestRating)}.`,
    );
  }
  return {
    sessionId,
    expectedCardId: requestCardId,
    rating: requestRating,
    commandId: requestCommandId,
    ...(typeof sessionIdOrRequest !== "string" && sessionIdOrRequest.canCommit
      ? { canCommit: sessionIdOrRequest.canCommit }
      : {}),
  };
}

function assertCanCommit(guard: OperationGuard | undefined): void {
  if (guard && !guard()) {
    throw new ReviewServiceError(
      "cancelled",
      "The rating became obsolete before it could commit.",
    );
  }
}

function findCurrentOccurrence(
  session: SessionRecord,
  now: EpochMilliseconds,
): SessionQueueEntry | undefined {
  const candidates = session.queueEntries
    .filter((entry) => entry.cardId === session.activeCardId && entry.dueAt <= now)
    .sort(compareQueueEntries);
  return candidates[0];
}

function removeOccurrence(
  entries: readonly SessionQueueEntry[],
  occurrence: SessionQueueEntry,
): SessionQueueEntry[] {
  const index = entries.findIndex((entry) => (
    entry.cardId === occurrence.cardId
    && entry.dueAt === occurrence.dueAt
    && entry.ordinal === occurrence.ordinal
  ));
  if (index < 0) {
    throw new ReviewServiceError(
      "invalid-session-state",
      "The active queue occurrence disappeared before rating.",
    );
  }
  return [...entries.slice(0, index), ...entries.slice(index + 1)];
}

function sortQueueEntries(entries: readonly SessionQueueEntry[]): SessionQueueEntry[] {
  return [...entries].sort(compareQueueEntries);
}

function compareQueueEntries(left: SessionQueueEntry, right: SessionQueueEntry): number {
  if (left.dueAt !== right.dueAt) return left.dueAt - right.dueAt;
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return compareIds(left.cardId, right.cardId);
}

function nextQueueOrdinal(entries: readonly SessionQueueEntry[]): number {
  let maximum = 0;
  for (const entry of entries) {
    if (Number.isFinite(entry.ordinal)) {
      maximum = Math.max(maximum, entry.ordinal);
    }
  }
  return maximum + 1;
}

function nextPresentationDueAt(
  session: SessionRecord,
  now: EpochMilliseconds,
): EpochMilliseconds | null {
  return sortQueueEntries(session.queueEntries)
    .find((entry) => entry.dueAt > now)?.dueAt ?? null;
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

function cloneSchedule(schedule: ScheduleRecord): ScheduleRecord {
  return structuredClone(schedule);
}

function scheduleSnapshot(schedule: ScheduleRecord): ScheduleSnapshot {
  return {
    dueAt: schedule.dueAt,
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    elapsedDays: schedule.elapsedDays,
    scheduledDays: schedule.scheduledDays,
    reps: schedule.reps,
    lapses: schedule.lapses,
    state: schedule.state,
    lastReviewAt: schedule.lastReviewAt,
    suspended: schedule.suspended,
    learningSteps: schedule.learningSteps,
    legacyEaseFactor: schedule.legacyEaseFactor,
  };
}

function scheduleFromSnapshot(
  snapshot: ScheduleSnapshot,
  cardId: string,
  deckId: string,
): ScheduleRecord {
  return {
    cardId,
    deckId,
    ...structuredClone(snapshot),
  };
}

function validateAppliedResult(
  applied: AppliedSchedule,
  previous: ScheduleRecord,
  requestedRating: Rating,
  now: EpochMilliseconds,
): void {
  if (typeof applied !== "object" || applied === null) {
    invalidSchedulerOutput("scheduler.result", "an object");
  }
  validateAppliedSchedule(applied.schedule, previous);
  validateSchedulerLog(applied.log, applied.schedule, requestedRating, now);
}

function validateAppliedSchedule(
  schedule: ScheduleRecord,
  previous: ScheduleRecord,
): void {
  if (typeof schedule !== "object" || schedule === null) {
    invalidSchedulerOutput("scheduler.schedule", "an object");
  }
  if (schedule.cardId !== previous.cardId || schedule.deckId !== previous.deckId) {
    throw new ReviewServiceError(
      "invalid-schedule",
      "The scheduler returned a schedule for a different card or deck.",
    );
  }
  validateSchedulerEpoch(schedule.dueAt, "scheduler.schedule.dueAt");
  validateSchedulerNumber(schedule.stability, "scheduler.schedule.stability");
  validateSchedulerNumber(schedule.difficulty, "scheduler.schedule.difficulty");
  validateSchedulerCounter(schedule.elapsedDays, "scheduler.schedule.elapsedDays");
  validateSchedulerCounter(schedule.scheduledDays, "scheduler.schedule.scheduledDays");
  validateSchedulerCounter(schedule.reps, "scheduler.schedule.reps");
  validateSchedulerCounter(schedule.lapses, "scheduler.schedule.lapses");
  if (!isScheduleState(schedule.state)) {
    invalidSchedulerOutput("scheduler.schedule.state", "a known scheduler state");
  }
  if (schedule.lastReviewAt !== null) {
    validateSchedulerEpoch(schedule.lastReviewAt, "scheduler.schedule.lastReviewAt");
  }
  if (typeof schedule.suspended !== "boolean") {
    invalidSchedulerOutput("scheduler.schedule.suspended", "a boolean");
  }
  if (schedule.learningSteps !== undefined) {
    validateSchedulerCounter(schedule.learningSteps, "scheduler.schedule.learningSteps");
  }
  if (schedule.legacyEaseFactor !== undefined && schedule.legacyEaseFactor !== null) {
    validateSchedulerNumber(
      schedule.legacyEaseFactor,
      "scheduler.schedule.legacyEaseFactor",
    );
  }
}

function validateSchedulerLog(
  log: SchedulerLog,
  schedule: ScheduleRecord,
  requestedRating: Rating,
  now: EpochMilliseconds,
): void {
  if (typeof log !== "object" || log === null) {
    invalidSchedulerOutput("scheduler.log", "an object");
  }
  if (log.rating !== requestedRating) {
    invalidSchedulerOutput("scheduler.log.rating", "the requested rating");
  }
  if (!isScheduleState(log.state) || log.state !== schedule.state) {
    invalidSchedulerOutput("scheduler.log.state", "the applied schedule state");
  }
  validateSchedulerEpoch(log.dueAt, "scheduler.log.dueAt");
  validateSchedulerNumber(log.stability, "scheduler.log.stability");
  validateSchedulerNumber(log.difficulty, "scheduler.log.difficulty");
  validateSchedulerCounter(log.elapsedDays, "scheduler.log.elapsedDays");
  validateSchedulerCounter(log.lastElapsedDays, "scheduler.log.lastElapsedDays");
  validateSchedulerCounter(log.scheduledDays, "scheduler.log.scheduledDays");
  validateSchedulerCounter(log.learningSteps, "scheduler.log.learningSteps");
  validateSchedulerEpoch(log.reviewedAt, "scheduler.log.reviewedAt");
  if (log.reviewedAt !== now) {
    invalidSchedulerOutput("scheduler.log.reviewedAt", "the injected rating instant");
  }

  const matchingFields = [
    ["dueAt", log.dueAt, schedule.dueAt],
    ["stability", log.stability, schedule.stability],
    ["difficulty", log.difficulty, schedule.difficulty],
    ["elapsedDays", log.elapsedDays, schedule.elapsedDays],
    ["scheduledDays", log.scheduledDays, schedule.scheduledDays],
    ["learningSteps", log.learningSteps, schedule.learningSteps ?? 0],
  ] as const;
  for (const [field, actual, expected] of matchingFields) {
    if (actual !== expected) {
      invalidSchedulerOutput(`scheduler.log.${field}`, `the applied schedule ${field}`);
    }
  }
}

function validateSchedulerEpoch(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Number.isNaN(new Date(value).getTime())
  ) {
    invalidSchedulerOutput(field, "a valid epoch-millisecond value");
  }
}

function validateSchedulerNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalidSchedulerOutput(field, "a non-negative finite number");
  }
}

function validateSchedulerCounter(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidSchedulerOutput(field, "a non-negative safe integer");
  }
}

function invalidSchedulerOutput(field: string, expectation: string): never {
  throw new ReviewServiceError(
    "invalid-schedule",
    `${field} must be ${expectation}.`,
  );
}

function isScheduleState(value: unknown): value is ScheduleRecord["state"] {
  return value === "new"
    || value === "learning"
    || value === "review"
    || value === "relearning";
}

function isRating(value: unknown): value is Rating {
  return value === "again" || value === "hard" || value === "good" || value === "easy";
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReviewServiceError(
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
    throw new ReviewServiceError(
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
