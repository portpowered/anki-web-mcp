import {
  createEmptyCard,
  fsrs,
  Rating as FsrsRating,
  State as FsrsState,
  type Card as FsrsCard,
  type Grade,
  type FSRSParameters,
  type ReviewLog as FsrsReviewLog,
  type StepUnit,
} from "ts-fsrs";

import type {
  CardRecord,
  EpochMilliseconds,
  Rating,
  ScheduleRecord,
  ScheduleState as CardState,
} from "./entities";
import type { Clock } from "./ports";
import { systemClock } from "../platform/clock";

export const TS_FSRS_VERSION = "5.4.1" as const;
export const DEFAULT_MAXIMUM_INTERVAL = 36_500;

export interface SchedulerConfig {
  readonly requestRetention: number;
  readonly maximumInterval: number;
  readonly enableFuzz: boolean;
  readonly enableShortTerm: boolean;
  readonly learningSteps: readonly StepUnit[];
  readonly relearningSteps: readonly StepUnit[];
}

/** Production policy: fuzz is deliberately enabled for long review intervals. */
export const PRODUCTION_SCHEDULER_CONFIG: SchedulerConfig = Object.freeze({
  requestRetention: 0.9,
  maximumInterval: DEFAULT_MAXIMUM_INTERVAL,
  enableFuzz: true,
  enableShortTerm: true,
  learningSteps: Object.freeze(["1m", "10m"] as const),
  relearningSteps: Object.freeze(["10m"] as const),
});

/** Test policy: identical scheduling parameters with fuzz disabled. */
export const DETERMINISTIC_SCHEDULER_CONFIG: SchedulerConfig = Object.freeze({
  ...PRODUCTION_SCHEDULER_CONFIG,
  enableFuzz: false,
});

export const productionSchedulerConfig = PRODUCTION_SCHEDULER_CONFIG;
export const deterministicSchedulerConfig = DETERMINISTIC_SCHEDULER_CONFIG;

export type SchedulerErrorCode =
  | "invalid-date"
  | "invalid-rating"
  | "invalid-schedule";

export class SchedulerValidationError extends Error {
  readonly code: SchedulerErrorCode;
  readonly field?: string;

  constructor(
    code: SchedulerErrorCode,
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = "SchedulerValidationError";
    this.code = code;
    this.field = field;
  }
}

export const InvalidSchedulerRecordError = SchedulerValidationError;

/** The serializable schedule shape exposed outside this adapter module. */
export type ScheduleState = ScheduleRecord;
export type DurableScheduleState = ScheduleRecord;

export interface RatingPreview {
  readonly rating: Rating;
  readonly dueAt: EpochMilliseconds;
  readonly interval: string;
  readonly intervalLabel: string;
  readonly intervalMinutes: number;
  readonly intervalDays: number;
  readonly scheduledDays: number;
  readonly state: CardState;
}

export type RatingPreviewMap = Readonly<Record<Rating, RatingPreview>>;

export interface SchedulerLog {
  readonly rating: Rating;
  readonly state: CardState;
  readonly dueAt: EpochMilliseconds;
  readonly stability: number;
  readonly difficulty: number;
  readonly elapsedDays: number;
  readonly lastElapsedDays: number;
  readonly scheduledDays: number;
  readonly learningSteps: number;
  readonly reviewedAt: EpochMilliseconds;
}

export interface AppliedSchedule {
  readonly schedule: ScheduleState;
  readonly log: SchedulerLog;
}

export interface RatingCalculation extends AppliedSchedule {
  readonly preview: RatingPreview;
}

export type RatingCalculationMap = Readonly<Record<Rating, RatingCalculation>>;

export interface SchedulerAdapter {
  createNewCard(now: Date): ScheduleState;
  /** Calculates the complete four-rating result with one scheduler invocation. */
  calculate?(schedule: ScheduleState, now: Date): RatingCalculationMap;
  preview(schedule: ScheduleState, now: Date): RatingPreviewMap;
  apply(schedule: ScheduleState, rating: Rating, now: Date): AppliedSchedule;
  retrievability(schedule: ScheduleState, now: Date): number | null;
}

export interface SchedulerAdapterOptions {
  readonly config?: SchedulerConfig;
  readonly clock?: Clock;
}

export interface NewScheduleInput {
  cardId: CardRecord["id"];
  deckId: CardRecord["deckId"];
  /** Allows deterministic callers to provide the creation time explicitly. */
  createdAt?: ScheduleRecord["dueAt"];
}

/** The pre-FSRS initializer is retained for callers creating a fresh record. */
export interface ScheduleInitializer {
  initializeNewCard(input: NewScheduleInput): ScheduleRecord;
}

export class NeutralScheduleInitializer implements ScheduleInitializer {
  constructor(private readonly clock: Clock = systemClock) {}

  initializeNewCard({ cardId, deckId, createdAt }: NewScheduleInput): ScheduleRecord {
    const now = createdAt ?? this.clock.now();

    return {
      cardId,
      deckId,
      dueAt: now,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: "new",
      lastReviewAt: null,
      suspended: false,
      legacyEaseFactor: null,
    };
  }
}

/**
 * Stable application-facing wrapper around one pinned ts-fsrs release.
 *
 * The optional no-argument overloads are convenience paths for application
 * services that inject a Clock into the adapter. The public SchedulerAdapter
 * contract still accepts an explicit Date for every calculation.
 */
export class TsFsrsSchedulerAdapter implements SchedulerAdapter {
  private readonly config: SchedulerConfig;
  private readonly clock: Clock;

  constructor(options: SchedulerAdapterOptions = {}) {
    this.config = options.config ?? PRODUCTION_SCHEDULER_CONFIG;
    this.clock = options.clock ?? systemClock;
    validateConfig(this.config);
  }

  createNewCard(now: Date): ScheduleState;
  createNewCard(): ScheduleState;
  createNewCard(now?: Date): ScheduleState {
    const date = this.resolveDate(now);
    const card = createEmptyCard(date);
    return scheduleFromFsrsCard(card, "card-id-required", "deck-id-required");
  }

  /** Creates a new schedule with stable application identifiers. */
  createNewCardFor(
    cardId: string,
    deckId: string,
    now: Date,
  ): ScheduleState;
  createNewCardFor(cardId: string, deckId: string): ScheduleState;
  createNewCardFor(cardId: string, deckId: string, now?: Date): ScheduleState {
    assertNonEmptyId(cardId, "cardId");
    assertNonEmptyId(deckId, "deckId");
    const date = this.resolveDate(now);
    return scheduleFromFsrsCard(createEmptyCard(date), cardId, deckId);
  }

  preview(schedule: ScheduleState, now: Date): RatingPreviewMap;
  preview(schedule: ScheduleState): RatingPreviewMap;
  preview(schedule: ScheduleState, now?: Date): RatingPreviewMap {
    const calculations = this.calculate(schedule, this.resolveDate(now));
    return {
      again: calculations.again.preview,
      hard: calculations.hard.preview,
      good: calculations.good.preview,
      easy: calculations.easy.preview,
    };
  }

  calculate(schedule: ScheduleState, now: Date): RatingCalculationMap;
  calculate(schedule: ScheduleState): RatingCalculationMap;
  calculate(schedule: ScheduleState, now?: Date): RatingCalculationMap {
    const validSchedule = validateSchedule(schedule);
    const date = this.resolveDate(now);
    const scheduler = this.createScheduler();
    const calculations = scheduler.repeat(toFsrsCard(validSchedule), date);

    return {
      again: calculationFromRecord(
        "again", calculations[FsrsRating.Again], validSchedule, date,
      ),
      hard: calculationFromRecord(
        "hard", calculations[FsrsRating.Hard], validSchedule, date,
      ),
      good: calculationFromRecord(
        "good", calculations[FsrsRating.Good], validSchedule, date,
      ),
      easy: calculationFromRecord(
        "easy", calculations[FsrsRating.Easy], validSchedule, date,
      ),
    };
  }

  apply(schedule: ScheduleState, rating: Rating, now: Date): AppliedSchedule;
  apply(schedule: ScheduleState, rating: Rating): AppliedSchedule;
  apply(
    schedule: ScheduleState,
    rating: Rating,
    now?: Date,
  ): AppliedSchedule {
    const validSchedule = validateSchedule(schedule);
    const validRating = validateRating(rating);
    const date = this.resolveDate(now);
    const scheduler = this.createScheduler();
    const result = scheduler.next(
      toFsrsCard(validSchedule),
      date,
      toFsrsRating(validRating),
    );

    const appliedSchedule = scheduleFromFsrsCard(
      result.card,
      validSchedule.cardId,
      validSchedule.deckId,
      validSchedule,
    );
    return {
      schedule: appliedSchedule,
      log: logFromFsrsRecord(validRating, result.log, appliedSchedule),
    };
  }

  retrievability(schedule: ScheduleState, now: Date): number | null;
  retrievability(schedule: ScheduleState): number | null;
  retrievability(schedule: ScheduleState, now?: Date): number | null {
    const validSchedule = validateSchedule(schedule);
    if (validSchedule.state === "new") {
      return null;
    }

    const date = this.resolveDate(now);
    const value = this.createScheduler().get_retrievability(
      toFsrsCard(validSchedule),
      date,
      false,
    );

    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new SchedulerValidationError(
        "invalid-schedule",
        "The scheduler returned an invalid retrievability value.",
        "retrievability",
      );
    }

    return value;
  }

  getConfiguration(): SchedulerConfig {
    return this.config;
  }

  private resolveDate(now?: Date): Date {
    const value = now ?? new Date(this.clock.now());
    assertValidDate(value);
    return new Date(value.getTime());
  }

  private createScheduler() {
    const parameters: Partial<FSRSParameters> = {
      request_retention: this.config.requestRetention,
      maximum_interval: this.config.maximumInterval,
      enable_fuzz: this.config.enableFuzz,
      enable_short_term: this.config.enableShortTerm,
      learning_steps: this.config.learningSteps,
      relearning_steps: this.config.relearningSteps,
    };
    return fsrs(parameters);
  }
}

export function createProductionSchedulerAdapter(
  clock: Clock = systemClock,
): TsFsrsSchedulerAdapter {
  return new TsFsrsSchedulerAdapter({
    config: PRODUCTION_SCHEDULER_CONFIG,
    clock,
  });
}

export function createDeterministicSchedulerAdapter(
  clock: Clock,
): TsFsrsSchedulerAdapter {
  return new TsFsrsSchedulerAdapter({
    config: DETERMINISTIC_SCHEDULER_CONFIG,
    clock,
  });
}

function validateConfig(config: SchedulerConfig): void {
  if (
    !Number.isFinite(config.requestRetention)
    || config.requestRetention <= 0
    || config.requestRetention >= 1
  ) {
    throw new SchedulerValidationError(
      "invalid-schedule",
      "requestRetention must be greater than 0 and less than 1.",
      "requestRetention",
    );
  }
  if (!Number.isInteger(config.maximumInterval) || config.maximumInterval <= 0) {
    throw new SchedulerValidationError(
      "invalid-schedule",
      "maximumInterval must be a positive integer.",
      "maximumInterval",
    );
  }
}

function validateSchedule(value: ScheduleState): ScheduleState {
  if (typeof value !== "object" || value === null) {
    throw new SchedulerValidationError(
      "invalid-schedule",
      "The persisted scheduler record must be an object.",
    );
  }

  assertNonEmptyId(value.cardId, "cardId");
  assertNonEmptyId(value.deckId, "deckId");
  assertFinite(value.dueAt, "dueAt");
  assertFiniteDate(value.dueAt, "dueAt");

  for (const field of [
    "stability",
    "difficulty",
    "elapsedDays",
    "scheduledDays",
    "reps",
    "lapses",
  ] as const) {
    assertFinite(value[field], field);
    if (value[field] < 0) {
      throw new SchedulerValidationError(
        "invalid-schedule",
        `${field} must not be negative.`,
        field,
      );
    }
  }

  if (!isCardState(value.state)) {
    throw new SchedulerValidationError(
      "invalid-schedule",
      `Unknown scheduler state: ${String(value.state)}.`,
      "state",
    );
  }
  if (value.lastReviewAt !== null) {
    assertFinite(value.lastReviewAt, "lastReviewAt");
    assertFiniteDate(value.lastReviewAt, "lastReviewAt");
  }
  if (typeof value.suspended !== "boolean") {
    throw new SchedulerValidationError(
      "invalid-schedule",
      "suspended must be a boolean.",
      "suspended",
    );
  }
  if (value.learningSteps !== undefined) {
    if (!Number.isInteger(value.learningSteps) || value.learningSteps < 0) {
      throw new SchedulerValidationError(
        "invalid-schedule",
        "learningSteps must be a non-negative integer.",
        "learningSteps",
      );
    }
  }
  if (
    value.legacyEaseFactor !== undefined
    && value.legacyEaseFactor !== null
  ) {
    assertFinite(value.legacyEaseFactor, "legacyEaseFactor");
  }

  return value;
}

function validateRating(value: Rating): Rating {
  if (value !== "again" && value !== "hard" && value !== "good" && value !== "easy") {
    throw new SchedulerValidationError(
      "invalid-rating",
      `Unknown rating: ${String(value)}.`,
      "rating",
    );
  }
  return value;
}

function assertNonEmptyId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SchedulerValidationError(
      "invalid-schedule",
      `${field} must be a non-empty string.`,
      field,
    );
  }
}

function assertFinite(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SchedulerValidationError(
      "invalid-schedule",
      `${field} must be a finite number.`,
      field,
    );
  }
}

function assertFiniteDate(value: number, field: string): void {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new SchedulerValidationError(
      "invalid-schedule",
      `${field} must represent a valid Date.`,
      field,
    );
  }
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SchedulerValidationError(
      "invalid-date",
      "Scheduler calculations require a valid Date.",
      "now",
    );
  }
}

function isCardState(value: unknown): value is CardState {
  return (
    value === "new"
    || value === "learning"
    || value === "review"
    || value === "relearning"
  );
}

function toFsrsCard(schedule: ScheduleState): FsrsCard {
  const valid = validateSchedule(schedule);
  return {
    due: new Date(valid.dueAt),
    stability: valid.stability,
    difficulty: valid.difficulty,
    elapsed_days: valid.elapsedDays,
    scheduled_days: valid.scheduledDays,
    learning_steps: valid.learningSteps ?? 0,
    reps: valid.reps,
    lapses: valid.lapses,
    state: toFsrsState(valid.state),
    last_review: valid.lastReviewAt === null
      ? undefined
      : new Date(valid.lastReviewAt),
  };
}

function scheduleFromFsrsCard(
  card: FsrsCard,
  cardId: string,
  deckId: string,
  previous?: ScheduleState,
): ScheduleState {
  assertValidDate(card.due);
  const lastReviewAt = card.last_review?.getTime() ?? null;
  return {
    cardId,
    deckId,
    dueAt: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: fromFsrsState(card.state),
    lastReviewAt,
    suspended: previous?.suspended ?? false,
    learningSteps: card.learning_steps,
    legacyEaseFactor: previous?.legacyEaseFactor ?? null,
  };
}

function previewFromRecord(
  rating: Rating,
  record: { card: FsrsCard },
  now: Date,
): RatingPreview {
  const dueAt = record.card.due.getTime();
  const intervalMinutes = Math.max(0, dueAt - now.getTime()) / 60_000;
  const intervalDays = intervalMinutes / 1_440;
  const intervalLabel = formatInterval(dueAt - now.getTime());
  return {
    rating,
    dueAt,
    interval: intervalLabel,
    intervalLabel,
    intervalMinutes,
    intervalDays,
    scheduledDays: record.card.scheduled_days,
    state: fromFsrsState(record.card.state),
  };
}

function calculationFromRecord(
  rating: Rating,
  record: { card: FsrsCard; log: FsrsReviewLog },
  previous: ScheduleState,
  now: Date,
): RatingCalculation {
  const schedule = scheduleFromFsrsCard(
    record.card,
    previous.cardId,
    previous.deckId,
    previous,
  );
  return {
    preview: previewFromRecord(rating, record, now),
    schedule,
    log: logFromFsrsRecord(rating, record.log, schedule),
  };
}

function logFromFsrsRecord(
  rating: Rating,
  log: FsrsReviewLog,
  appliedSchedule: ScheduleState,
): SchedulerLog {
  return {
    rating,
    // ts-fsrs logs the state entering a review. The application log describes
    // the committed transition, so its state and scheduling fields must match
    // the resulting card instead.
    state: appliedSchedule.state,
    dueAt: appliedSchedule.dueAt,
    stability: appliedSchedule.stability,
    difficulty: appliedSchedule.difficulty,
    elapsedDays: appliedSchedule.elapsedDays,
    lastElapsedDays: log.last_elapsed_days,
    scheduledDays: appliedSchedule.scheduledDays,
    learningSteps: appliedSchedule.learningSteps ?? 0,
    reviewedAt: log.review.getTime(),
  };
}

function toFsrsState(value: CardState): FsrsState {
  switch (value) {
    case "new":
      return FsrsState.New;
    case "learning":
      return FsrsState.Learning;
    case "review":
      return FsrsState.Review;
    case "relearning":
      return FsrsState.Relearning;
  }
}

function fromFsrsState(value: FsrsState): CardState {
  switch (value) {
    case FsrsState.New:
      return "new";
    case FsrsState.Learning:
      return "learning";
    case FsrsState.Review:
      return "review";
    case FsrsState.Relearning:
      return "relearning";
    default:
      throw new SchedulerValidationError(
        "invalid-schedule",
        `The scheduler returned an unknown state: ${String(value)}.`,
        "state",
      );
  }
}

function toFsrsRating(value: Rating): Grade {
  switch (value) {
    case "again":
      return FsrsRating.Again as Grade;
    case "hard":
      return FsrsRating.Hard as Grade;
    case "good":
      return FsrsRating.Good as Grade;
    case "easy":
      return FsrsRating.Easy as Grade;
  }
}

function formatInterval(durationMs: number): string {
  if (durationMs <= 0) {
    return "now";
  }
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = durationMs / 86_400_000;
  return days >= 10 || Number.isInteger(days)
    ? `${Math.round(days)}d`
    : `${days.toFixed(1)}d`;
}
