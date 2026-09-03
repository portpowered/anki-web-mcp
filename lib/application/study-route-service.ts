import type {
  CardRecord,
  DeckRecord,
  EpochMilliseconds,
  RatingCounts,
  Rating,
  ReviewLogRecord,
  ScheduleRecord,
  SessionRecord,
} from "../domain/entities";
import { getLocalDayBoundary, resolveTimeZone } from "../domain/local-day";
import type { Clock } from "../domain/ports";
import {
  createProductionSchedulerAdapter,
  type RatingPreviewMap,
  type SchedulerAdapter,
} from "../domain/scheduler";
import { systemClock } from "../platform/clock";
import { IndexedDbStudyDatabase, type StudyDatabase } from "../persistence/db";
import {
  openDatabaseWithSeed,
  type OpenDatabaseWithSeedOptions,
} from "../persistence/seed";
import { SessionService } from "./session-service";
import type { RevealAnswerResult } from "./reveal-service";
import type { ReviewResult } from "./review-service";
import type { SuspensionResult } from "./suspension-service";
import type { OperationGuard } from "./operation-guard";
import { projectSessionQueue } from "./session-queue-projection";
import { RatingPreviewSnapshotStore } from "./rating-preview-snapshot";

export type StudyRouteSnapshot =
  | StudyActiveSnapshot
  | StudyWaitingSnapshot
  | StudyCompletionSnapshot
  | StudyCaughtUpSnapshot
  | StudyMissingDeckSnapshot;

interface StudySnapshotBase {
  readonly capturedAt: EpochMilliseconds;
  readonly deckId: string;
}

interface StudySessionSnapshotBase extends StudySnapshotBase {
  readonly deckName: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly completedPresentationCount: number;
  readonly plannedPresentationCount: number;
  readonly completedTodayCount: number;
  readonly todayCardCount: number;
}

export interface StudyActiveSnapshot extends StudySessionSnapshotBase {
  readonly kind: "active";
  readonly cardId: string;
  readonly frontText: string;
  readonly frontHtml: string;
  readonly css: string;
  readonly mediaRefs: readonly string[];
  readonly side: "front" | "back";
  readonly backText?: string;
  readonly backHtml?: string;
  readonly answerText?: string;
  readonly answerHtml?: string;
  readonly backIncludesFront?: boolean;
  readonly ratingPreviews: RatingPreviewMap;
}

export interface StudyMediaAsset {
  readonly ref: string;
  readonly blob: Blob;
  readonly mimeType: string;
}

export interface StudyWaitingSnapshot extends StudySessionSnapshotBase {
  readonly kind: "waiting";
  readonly nextDueAt: EpochMilliseconds;
}

export interface StudyCompletionSnapshot extends StudySessionSnapshotBase {
  readonly kind: "completion";
  readonly completedAt: EpochMilliseconds;
  readonly startedAt: EpochMilliseconds;
  readonly nextDueAt: EpochMilliseconds | null;
  readonly ratingCounts: RatingCounts;
}

export interface StudyCaughtUpSnapshot extends StudySnapshotBase {
  readonly kind: "caught-up";
  readonly deckName: string;
  readonly sessionId: null;
  readonly sequence: null;
  readonly completedPresentationCount: 0;
  readonly plannedPresentationCount: 0;
  readonly completedTodayCount: 0;
  readonly todayCardCount: 0;
}

export interface StudyMissingDeckSnapshot extends StudySnapshotBase {
  readonly kind: "missing-deck";
}

export interface BrowserStudyRouteService {
  load(deckId: string): Promise<StudyRouteSnapshot>;
  loadMedia(mediaRefs: readonly string[]): Promise<readonly StudyMediaAsset[]>;
  reveal(sessionId: string, expectedCardId: string, canCommit?: OperationGuard): Promise<RevealAnswerResult>;
  rate(
    sessionId: string,
    expectedCardId: string,
    rating: Rating,
    commandId: string,
    canCommit?: OperationGuard,
  ): Promise<ReviewResult>;
  suspend(
    sessionId: string,
    expectedCardId: string,
    commandId: string,
    canCommit?: OperationGuard,
  ): Promise<SuspensionResult>;
  close(): void;
}

export interface StudyRouteServiceOptions {
  readonly database: StudyDatabase;
  readonly clock?: Clock;
  readonly scheduler?: SchedulerAdapter;
  readonly timeZone?: string;
}

/**
 * Produces the one serializable study-route view consumed by React and tools.
 * It resumes an incomplete session so a due delayed occurrence is promoted,
 * but preserves the latest completed session until the learner selects the
 * deck again from home to explicitly begin another sequence.
 */
export class StudyRouteService implements BrowserStudyRouteService {
  private readonly database: StudyDatabase;
  private readonly clock: Clock;
  private readonly scheduler: SchedulerAdapter;
  private readonly timeZone: string;
  private readonly sessions: SessionService;
  private readonly ratingPreviewSnapshots: RatingPreviewSnapshotStore;

  constructor(options: StudyRouteServiceOptions) {
    this.database = options.database;
    this.clock = options.clock ?? systemClock;
    this.scheduler = options.scheduler ?? createProductionSchedulerAdapter(this.clock);
    this.timeZone = resolveTimeZone(options.timeZone);
    this.ratingPreviewSnapshots = new RatingPreviewSnapshotStore(this.scheduler);
    this.sessions = new SessionService({
      database: this.database,
      clock: this.clock,
      scheduler: this.scheduler,
      timeZone: this.timeZone,
      requirePreviewSnapshot: true,
    });
  }

  async load(deckId: string): Promise<StudyRouteSnapshot> {
    const normalizedDeckId = deckId.trim();
    const capturedAt = this.clock.now();
    if (!normalizedDeckId) {
      this.ratingPreviewSnapshots.notePresentationUnavailable(capturedAt);
      return { kind: "missing-deck", capturedAt, deckId: normalizedDeckId };
    }

    const boundary = getLocalDayBoundary(capturedAt, this.timeZone);
    const initial = await this.database.transaction(
      "readonly",
      ["decks", "sessions"],
      async (transaction) => ({
        deck: await transaction.getDeck(normalizedDeckId),
        sessions: await transaction.listSessions(normalizedDeckId),
      }),
    );
    if (!initial.deck) {
      this.ratingPreviewSnapshots.notePresentationUnavailable(capturedAt);
      return { kind: "missing-deck", capturedAt, deckId: normalizedDeckId };
    }

    const latest = latestSessionForDay(initial.sessions, boundary.dayKey);
    if (!latest || latest.completedAt === null) {
      const started = await this.sessions.startSession(normalizedDeckId);
      if (started.kind === "no-session") {
        this.ratingPreviewSnapshots.notePresentationUnavailable(capturedAt);
        return caughtUpSnapshot(initial.deck, capturedAt);
      }
    }

    const snapshot = await this.readCommittedSnapshot(
      normalizedDeckId,
      capturedAt,
      boundary.dayKey,
    );
    if (snapshot.kind !== "active") {
      this.ratingPreviewSnapshots.notePresentationUnavailable(capturedAt);
    }
    return snapshot;
  }

  async loadMedia(mediaRefs: readonly string[]): Promise<readonly StudyMediaAsset[]> {
    const references = [...new Set(mediaRefs)].flatMap((ref) => {
      const parsed = parseMediaReference(ref);
      return parsed ? [{ ref, ...parsed }] : [];
    });
    if (references.length === 0) return [];

    return this.database.transaction("readonly", ["media"], async (transaction) => {
      const records = await Promise.all(references.map(async (reference) => ({
        reference,
        record: await transaction.getMedia?.(reference.importId, reference.name),
      })));
      return records.flatMap(({ reference, record }) => record ? [{
        ref: reference.ref,
        blob: record.blob,
        mimeType: record.mimeType,
      }] : []);
    });
  }

  reveal(sessionId: string, expectedCardId: string, canCommit?: OperationGuard): Promise<RevealAnswerResult> {
    return this.sessions.reveal({ sessionId, expectedCardId, canCommit });
  }

  rate(
    sessionId: string,
    expectedCardId: string,
    rating: Rating,
    commandId: string,
    canCommit?: OperationGuard,
  ): Promise<ReviewResult> {
    return this.sessions.rate({
      sessionId,
      expectedCardId,
      rating,
      commandId,
      canCommit,
      previewSnapshot: this.ratingPreviewSnapshots.current(),
    });
  }

  suspend(
    sessionId: string,
    expectedCardId: string,
    commandId: string,
    canCommit?: OperationGuard,
  ): Promise<SuspensionResult> {
    return this.sessions.suspend({ sessionId, expectedCardId, commandId, canCommit });
  }

  close(): void {
    this.ratingPreviewSnapshots.clear();
    this.database.close();
  }

  private async readCommittedSnapshot(
    deckId: string,
    capturedAt: EpochMilliseconds,
    dayKey: string,
  ): Promise<StudyRouteSnapshot> {
    return this.database.transaction(
      "readonly",
      ["decks", "cards", "schedules", "sessions", "reviewLogs"],
      async (transaction) => {
        const [deck, sessions, schedules] = await Promise.all([
          transaction.getDeck(deckId),
          transaction.listSessions(deckId),
          transaction.listSchedules(deckId),
        ]);
        if (!deck) return { kind: "missing-deck", capturedAt, deckId };

        const session = latestSessionForDay(sessions, dayKey);
        if (!session) return caughtUpSnapshot(deck, capturedAt);
        if (transaction.listReviewLogsBySessionId === undefined) {
          throw new Error("The study progress projection requires review-log access.");
        }
        const reviewLogs = await transaction.listReviewLogsBySessionId(session.id);
        const base = sessionSnapshotBase(
          deck,
          session,
          schedules,
          reviewLogs,
          capturedAt,
        );

        if (session.completedAt !== null) {
          const nextDueAt = schedules
            .filter((schedule) => !schedule.suspended)
            .map((schedule) => schedule.dueAt)
            .sort((left, right) => left - right)[0] ?? null;
          return {
            ...base,
            kind: "completion",
            completedAt: session.completedAt,
            startedAt: session.startedAt,
            nextDueAt,
            ratingCounts: session.ratingCounts,
          };
        }

        const queue = projectSessionQueue(session.queueEntries);
        const currentCardId = session.activeCardId ?? queue.nextCardId;
        if (currentCardId === null) {
          throw new Error(`Incomplete session ${session.id} has no pending card.`);
        }

        const [card, schedule] = await Promise.all([
          transaction.getCard(currentCardId),
          transaction.getSchedule(currentCardId),
        ]);
        const activeRecords = requireActiveRecords(session, card, schedule);
        const active: StudyActiveSnapshot = {
          ...base,
          kind: "active",
          cardId: activeRecords.card.id,
          frontText: activeRecords.card.frontText,
          frontHtml: activeRecords.card.frontHtml,
          css: activeRecords.card.css,
          mediaRefs: activeRecords.card.mediaRefs,
          side: session.currentSide,
          ratingPreviews: this.ratingPreviewSnapshots.getOrCreate({
            deckId: deck.id,
            sessionId: session.id,
            cardId: activeRecords.card.id,
            schedule: activeRecords.schedule,
            schedulerPolicyId: deck.schedulerConfigId,
            capturedAt,
          }).previews,
          ...(session.currentSide === "back" ? {
            backText: activeRecords.card.backText,
            backHtml: activeRecords.card.backHtml,
            ...(activeRecords.card.answerHtml === undefined ? {} : {
              answerText: activeRecords.card.answerText,
              answerHtml: activeRecords.card.answerHtml,
              backIncludesFront: activeRecords.card.backIncludesFront ?? false,
            }),
          } : {}),
        };
        return active;
      },
    );
  }
}

export function parseMediaReference(
  ref: string,
): { importId: string; name: string } | null {
  const marker = "/media/";
  const markerIndex = ref.indexOf(marker);
  if (markerIndex <= 0 || markerIndex + marker.length >= ref.length) return null;
  const importId = ref.slice(0, markerIndex);
  try {
    const name = decodeURIComponent(ref.slice(markerIndex + marker.length));
    if (!name || name.includes("\u0000")) return null;
    return { importId, name };
  } catch {
    return null;
  }
}

export async function createStudyRouteService(
  options: OpenDatabaseWithSeedOptions = {},
  clock: Clock = systemClock,
): Promise<BrowserStudyRouteService> {
  const opened = await openDatabaseWithSeed(options);
  if (!opened.ok) throw new Error(opened.error.message);
  return new StudyRouteService({
    database: new IndexedDbStudyDatabase(opened.value.database),
    clock,
  });
}

let browserStudyRouteService: Promise<BrowserStudyRouteService> | undefined;

export function openStudyRouteService(): Promise<BrowserStudyRouteService> {
  if (!browserStudyRouteService) {
    browserStudyRouteService = createStudyRouteService().catch((error) => {
      browserStudyRouteService = undefined;
      throw error;
    });
  }
  return browserStudyRouteService;
}

function latestSessionForDay(
  sessions: readonly SessionRecord[],
  dayKey: string,
): SessionRecord | undefined {
  return sessions
    .filter((session) => session.dayKey === dayKey)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .at(-1);
}

function caughtUpSnapshot(
  deck: DeckRecord,
  capturedAt: EpochMilliseconds,
): StudyCaughtUpSnapshot {
  return {
    kind: "caught-up",
    capturedAt,
    deckId: deck.id,
    deckName: deck.name,
    sessionId: null,
    sequence: null,
    completedPresentationCount: 0,
    plannedPresentationCount: 0,
    completedTodayCount: 0,
    todayCardCount: 0,
  };
}

function sessionSnapshotBase(
  deck: DeckRecord,
  session: SessionRecord,
  schedules: readonly ScheduleRecord[],
  reviewLogs: readonly ReviewLogRecord[],
  capturedAt: EpochMilliseconds,
): StudySessionSnapshotBase {
  const schedulesByCardId = new Map(schedules.map((schedule) => [schedule.cardId, schedule]));
  const completedTodayCardIds = new Set(reviewLogs.flatMap((reviewLog) => {
    const schedule = schedulesByCardId.get(reviewLog.cardId);
    return schedule !== undefined && !schedule.suspended && schedule.dueAt >= session.nextDayAt
      ? [reviewLog.cardId]
      : [];
  }));
  const todayCardIds = new Set([
    ...completedTodayCardIds,
    ...session.queueEntries.map((entry) => entry.cardId),
  ]);
  return {
    capturedAt,
    deckId: deck.id,
    deckName: deck.name,
    sessionId: session.id,
    sequence: session.sequence,
    completedPresentationCount: session.completedPresentationCount,
    plannedPresentationCount: session.plannedPresentationCount,
    completedTodayCount: completedTodayCardIds.size,
    todayCardCount: todayCardIds.size,
  };
}

function requireActiveRecords(
  session: SessionRecord,
  card: CardRecord | undefined,
  schedule: ScheduleRecord | undefined,
): { card: CardRecord; schedule: ScheduleRecord } {
  if (!card || !schedule || card.deckId !== session.deckId || schedule.deckId !== session.deckId) {
    throw new Error(`The active card for session ${session.id} is unavailable.`);
  }
  return { card, schedule };
}
