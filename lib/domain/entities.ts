/**
 * Serializable records shared by application services and persistence
 * adapters. These types intentionally do not contain scheduler-library
 * objects or platform-specific handles.
 */

export type EpochMilliseconds = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export type ScheduleState = "new" | "learning" | "review" | "relearning";
export type Rating = "again" | "hard" | "good" | "easy";
export type CardSide = "front" | "back";

export interface ScheduleRecord {
  cardId: string;
  deckId: string;
  dueAt: EpochMilliseconds;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: ScheduleState;
  lastReviewAt: EpochMilliseconds | null;
  suspended: boolean;
  /** Current (re)learning step; omitted by older imported records. */
  learningSteps?: number;
  /** Imported compatibility metadata; not used as canonical FSRS state. */
  legacyEaseFactor?: number | null;
}

export interface MetaRecord {
  key: string;
  value: JsonValue;
}

export interface ImportRecord {
  id: string;
  sha256: string;
  fileName: string;
  fileSize: number;
  packageVersion: string;
  importedAt: EpochMilliseconds;
  warnings: string[];
}

export interface DeckRecord {
  id: string;
  importId: string;
  sourceDeckId: string | null;
  name: string;
  cardCount: number;
  createdAt: EpochMilliseconds;
  lastStudiedAt: EpochMilliseconds | null;
  sessionIntakeLimit: number;
  schedulerConfigId: string;
}

export interface NoteRecord {
  id: string;
  importId: string;
  sourceNoteId: string | null;
  guid: string | null;
  modelId: string | null;
  fields: Record<string, string>;
  tags: string[];
}

export interface CardRecord {
  id: string;
  deckId: string;
  noteId: string;
  sourceCardId: string | null;
  templateOrdinal: number;
  frontHtml: string;
  backHtml: string;
  mediaRefs: string[];
  creationOrder: number;
  contentWarnings: string[];
}

export interface SessionQueueEntry {
  cardId: string;
  dueAt: EpochMilliseconds;
  ordinal: number;
}

export interface RatingCounts {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface SessionRecord {
  id: string;
  deckId: string;
  dayKey: string;
  sequence: number;
  intakeLimit: number;
  nextDayAt: EpochMilliseconds;
  queueEntries: SessionQueueEntry[];
  activeCardId: string | null;
  plannedPresentationCount: number;
  completedPresentationCount: number;
  currentSide: CardSide;
  ratingCounts: RatingCounts;
  startedAt: EpochMilliseconds;
  updatedAt: EpochMilliseconds;
  completedAt: EpochMilliseconds | null;
  lastCommandIds: string[];
}

export interface ScheduleSnapshot {
  dueAt: EpochMilliseconds;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: ScheduleState;
  lastReviewAt: EpochMilliseconds | null;
  suspended: boolean;
  learningSteps?: number;
  legacyEaseFactor?: number | null;
}

export interface ReviewLogRecord {
  id: string;
  sessionId: string;
  deckId: string;
  cardId: string;
  rating: Rating;
  reviewedAt: EpochMilliseconds;
  durationMs: number | null;
  before: ScheduleSnapshot;
  after: ScheduleSnapshot;
  commandId?: string;
}

export interface MediaRecord {
  importId: string;
  name: string;
  blob: Blob;
  mimeType: string;
  byteLength: number;
  sha256: string;
}
