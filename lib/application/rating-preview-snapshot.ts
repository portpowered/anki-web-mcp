import type {
  EpochMilliseconds,
  Rating,
  ScheduleRecord,
} from "../domain/entities";
import type {
  RatingCalculation,
  RatingCalculationMap,
  RatingPreviewMap,
  SchedulerAdapter,
} from "../domain/scheduler";

const RATINGS = ["again", "hard", "good", "easy"] as const satisfies readonly Rating[];

/** Small acquisition drift is observation, not a new presentation. */
export const RATING_PREVIEW_MEANINGFUL_TIME_MS = 60_000;
/** Returning after this much time without an active presentation resamples. */
export const RATING_PREVIEW_LONG_ABSENCE_MS = 60_000;

export type RatingPreviewSnapshotErrorCode =
  | "invalid-input"
  | "invalid-scheduler-output";

export class RatingPreviewSnapshotError extends Error {
  constructor(
    readonly code: RatingPreviewSnapshotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RatingPreviewSnapshotError";
  }
}

export interface RatingPreviewPresentationIdentity {
  readonly deckId: string;
  readonly sessionId: string;
  readonly cardId: string;
  readonly scheduleRevision: string;
  readonly schedulerPolicyId: string;
  readonly clockIdentity: string;
}

export interface RatingPreviewPresentationSnapshot {
  readonly identity: RatingPreviewPresentationIdentity;
  readonly calculatedAt: EpochMilliseconds;
  readonly validUntil: EpochMilliseconds;
  readonly sourceSchedule: ScheduleRecord;
  readonly outcomes: RatingCalculationMap;
  readonly previews: RatingPreviewMap;
}

export interface RatingPreviewPresentationInput {
  readonly deckId: string;
  readonly sessionId: string;
  readonly cardId: string;
  readonly schedule: ScheduleRecord;
  readonly schedulerPolicyId: string;
  readonly capturedAt: EpochMilliseconds;
}

/**
 * Owns the ephemeral scheduler result for the currently displayed card.
 * Durable identity fields decide correctness; capturedAt remains independent
 * and advances on every route read.
 */
export class RatingPreviewSnapshotStore {
  private snapshot: RatingPreviewPresentationSnapshot | undefined;
  private unavailableSince: EpochMilliseconds | undefined;

  constructor(private readonly scheduler: SchedulerAdapter) {}

  getOrCreate(input: RatingPreviewPresentationInput): RatingPreviewPresentationSnapshot {
    validateInput(input);
    const revision = scheduleRevision(input.schedule);
    const longAbsence = this.unavailableSince !== undefined
      && input.capturedAt - this.unavailableSince >= RATING_PREVIEW_LONG_ABSENCE_MS;
    this.unavailableSince = undefined;

    if (
      !longAbsence
      && this.snapshot
      && sameStableIdentity(this.snapshot.identity, input, revision)
      && input.capturedAt >= this.snapshot.calculatedAt
      && input.capturedAt < this.snapshot.validUntil
    ) {
      return this.snapshot;
    }

    const calculate = this.scheduler.calculate;
    if (typeof calculate !== "function") {
      throw new RatingPreviewSnapshotError(
        "invalid-scheduler-output",
        "The scheduler must provide one complete four-rating calculation.",
      );
    }
    const outcomes = calculate.call(
      this.scheduler,
      structuredClone(input.schedule),
      new Date(input.capturedAt),
    );
    validateOutcomes(outcomes, input);
    const snapshot: RatingPreviewPresentationSnapshot = deepFreeze({
      identity: {
        deckId: input.deckId,
        sessionId: input.sessionId,
        cardId: input.cardId,
        scheduleRevision: revision,
        schedulerPolicyId: input.schedulerPolicyId,
        clockIdentity: `${input.capturedAt}:${input.capturedAt + RATING_PREVIEW_MEANINGFUL_TIME_MS}`,
      },
      calculatedAt: input.capturedAt,
      validUntil: input.capturedAt + RATING_PREVIEW_MEANINGFUL_TIME_MS,
      sourceSchedule: structuredClone(input.schedule),
      outcomes: structuredClone(outcomes),
      previews: previewsFrom(outcomes),
    });
    this.snapshot = snapshot;
    return snapshot;
  }

  notePresentationUnavailable(capturedAt: EpochMilliseconds): void {
    validateEpoch(capturedAt, "capturedAt");
    this.unavailableSince ??= capturedAt;
  }

  clear(): void {
    this.snapshot = undefined;
    this.unavailableSince = undefined;
  }
}

export function scheduleRevision(schedule: ScheduleRecord): string {
  return JSON.stringify([
    schedule.cardId,
    schedule.deckId,
    schedule.dueAt,
    schedule.stability,
    schedule.difficulty,
    schedule.elapsedDays,
    schedule.scheduledDays,
    schedule.reps,
    schedule.lapses,
    schedule.state,
    schedule.lastReviewAt,
    schedule.suspended,
    schedule.learningSteps ?? null,
    schedule.legacyEaseFactor ?? null,
  ]);
}

function sameStableIdentity(
  identity: RatingPreviewPresentationIdentity,
  input: RatingPreviewPresentationInput,
  revision: string,
): boolean {
  return identity.deckId === input.deckId
    && identity.sessionId === input.sessionId
    && identity.cardId === input.cardId
    && identity.scheduleRevision === revision
    && identity.schedulerPolicyId === input.schedulerPolicyId;
}

function previewsFrom(outcomes: RatingCalculationMap): RatingPreviewMap {
  return {
    again: structuredClone(outcomes.again.preview),
    hard: structuredClone(outcomes.hard.preview),
    good: structuredClone(outcomes.good.preview),
    easy: structuredClone(outcomes.easy.preview),
  };
}

function validateInput(input: RatingPreviewPresentationInput): void {
  for (const [field, value] of [
    ["deckId", input.deckId],
    ["sessionId", input.sessionId],
    ["cardId", input.cardId],
    ["schedulerPolicyId", input.schedulerPolicyId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RatingPreviewSnapshotError("invalid-input", `${field} must be non-empty.`);
    }
  }
  validateEpoch(input.capturedAt, "capturedAt");
  if (input.schedule.cardId !== input.cardId || input.schedule.deckId !== input.deckId) {
    throw new RatingPreviewSnapshotError(
      "invalid-input",
      "The schedule must belong to the presentation card and deck.",
    );
  }
}

function validateOutcomes(
  value: RatingCalculationMap,
  input: RatingPreviewPresentationInput,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidOutput("The scheduler calculation must be a rating map.");
  }
  const keys = Object.keys(value);
  if (keys.length !== RATINGS.length || RATINGS.some((rating) => !keys.includes(rating))) {
    invalidOutput("The scheduler calculation must contain exactly Again, Hard, Good, and Easy.");
  }
  for (const rating of RATINGS) {
    validateOutcome(value[rating], rating, input);
  }
}

function validateOutcome(
  outcome: RatingCalculation,
  rating: Rating,
  input: RatingPreviewPresentationInput,
): void {
  if (typeof outcome !== "object" || outcome === null) invalidOutput(`${rating} is missing.`);
  if (outcome.preview?.rating !== rating || outcome.log?.rating !== rating) {
    invalidOutput(`${rating} has a mismatched rating identity.`);
  }
  if (
    outcome.schedule?.cardId !== input.cardId
    || outcome.schedule?.deckId !== input.deckId
  ) {
    invalidOutput(`${rating} has a cross-presentation schedule.`);
  }
  const matching = [
    [outcome.preview.dueAt, outcome.schedule.dueAt],
    [outcome.log.dueAt, outcome.schedule.dueAt],
    [outcome.preview.scheduledDays, outcome.schedule.scheduledDays],
    [outcome.log.scheduledDays, outcome.schedule.scheduledDays],
  ] as const;
  if (matching.some(([left, right]) => left !== right)) {
    invalidOutput(`${rating} contains inconsistent scheduling fields.`);
  }
  if (
    outcome.preview.state !== outcome.schedule.state
    || outcome.log.state !== outcome.schedule.state
  ) {
    invalidOutput(`${rating} contains inconsistent scheduling states.`);
  }
  if (
    typeof outcome.preview.interval !== "string"
    || outcome.preview.interval.length === 0
    || typeof outcome.preview.intervalLabel !== "string"
    || outcome.preview.intervalLabel.length === 0
    || typeof outcome.schedule.suspended !== "boolean"
  ) {
    invalidOutput(`${rating} contains an invalid scheduling field.`);
  }
  for (const value of [
    outcome.preview.dueAt,
    outcome.preview.intervalMinutes,
    outcome.preview.intervalDays,
    outcome.schedule.stability,
    outcome.schedule.difficulty,
    outcome.log.reviewedAt,
  ]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      invalidOutput(`${rating} contains an invalid numeric scheduling field.`);
    }
  }
  if (outcome.log.reviewedAt !== input.capturedAt) {
    invalidOutput(`${rating} was not calculated at the presentation instant.`);
  }
  for (const value of [
    outcome.preview.scheduledDays,
    outcome.schedule.elapsedDays,
    outcome.schedule.scheduledDays,
    outcome.schedule.reps,
    outcome.schedule.lapses,
    outcome.schedule.learningSteps ?? 0,
    outcome.log.elapsedDays,
    outcome.log.lastElapsedDays,
    outcome.log.scheduledDays,
    outcome.log.learningSteps,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      invalidOutput(`${rating} contains an invalid scheduling counter.`);
    }
  }
}

function validateEpoch(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(new Date(value).getTime())) {
    throw new RatingPreviewSnapshotError("invalid-input", `${field} must be a valid epoch millisecond.`);
  }
}

function invalidOutput(message: string): never {
  throw new RatingPreviewSnapshotError("invalid-scheduler-output", message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
