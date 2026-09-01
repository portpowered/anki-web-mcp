import type { CardRecord, ScheduleRecord } from "./entities";
import type { Clock } from "./ports";
import { systemClock } from "../platform/clock";

export interface NewScheduleInput {
  cardId: CardRecord["id"];
  deckId: CardRecord["deckId"];
  /** Allows deterministic callers to provide the creation time explicitly. */
  createdAt?: ScheduleRecord["dueAt"];
}
/**
 * Narrow seam for creating a scheduler-neutral new-card state. A future FSRS
 * adapter can implement this interface without leaking its library objects
 * into domain records or callers.
 */
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
