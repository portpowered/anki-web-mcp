import type {
  CardRecord,
  DeckRecord,
  EpochMilliseconds,
  RatingCounts,
  Rating,
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
}

export interface StudyActiveSnapshot extends StudySessionSnapshotBase {
  readonly kind: "active";
  readonly cardId: string;
  readonly frontText: string;
  readonly side: "front" | "back";
  readonly backText?: string;
  readonly ratingPreviews: RatingPreviewMap;
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
}

export interface StudyMissingDeckSnapshot extends StudySnapshotBase {
  readonly kind: "missing-deck";
}

export interface BrowserStudyRouteService {
  load(deckId: string): Promise<StudyRouteSnapshot>;
  reveal(sessionId: string, expectedCardId: string): Promise<RevealAnswerResult>;
  rate(
    sessionId: string,
    expectedCardId: string,
    rating: Rating,
    commandId: string,
  ): Promise<ReviewResult>;
  suspend(
    sessionId: string,
    expectedCardId: string,
    commandId: string,
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

  constructor(options: StudyRouteServiceOptions) {
    this.database = options.database;
    this.clock = options.clock ?? systemClock;
    this.scheduler = options.scheduler ?? createProductionSchedulerAdapter(this.clock);
    this.timeZone = resolveTimeZone(options.timeZone);
    this.sessions = new SessionService({
      database: this.database,
      clock: this.clock,
      scheduler: this.scheduler,
      timeZone: this.timeZone,
    });
  }

  async load(deckId: string): Promise<StudyRouteSnapshot> {
    const normalizedDeckId = deckId.trim();
    const capturedAt = this.clock.now();
    if (!normalizedDeckId) {
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
      return { kind: "missing-deck", capturedAt, deckId: normalizedDeckId };
    }

    const latest = latestSessionForDay(initial.sessions, boundary.dayKey);
    if (!latest || latest.completedAt === null) {
      const started = await this.sessions.startSession(normalizedDeckId);
      if (started.kind === "no-session") {
        return caughtUpSnapshot(initial.deck, capturedAt);
      }
    }

    return this.readCommittedSnapshot(normalizedDeckId, capturedAt, boundary.dayKey);
  }

  reveal(sessionId: string, expectedCardId: string): Promise<RevealAnswerResult> {
    return this.sessions.reveal(sessionId, expectedCardId);
  }

  rate(
    sessionId: string,
    expectedCardId: string,
    rating: Rating,
    commandId: string,
  ): Promise<ReviewResult> {
    return this.sessions.rate(sessionId, expectedCardId, rating, commandId);
  }

  suspend(
    sessionId: string,
    expectedCardId: string,
    commandId: string,
  ): Promise<SuspensionResult> {
    return this.sessions.suspend(sessionId, expectedCardId, commandId);
  }

  close(): void {
    this.database.close();
  }

  private async readCommittedSnapshot(
    deckId: string,
    capturedAt: EpochMilliseconds,
    dayKey: string,
  ): Promise<StudyRouteSnapshot> {
    return this.database.transaction(
      "readonly",
      ["decks", "cards", "schedules", "sessions"],
      async (transaction) => {
        const [deck, sessions, schedules] = await Promise.all([
          transaction.getDeck(deckId),
          transaction.listSessions(deckId),
          transaction.listSchedules(deckId),
        ]);
        if (!deck) return { kind: "missing-deck", capturedAt, deckId };

        const session = latestSessionForDay(sessions, dayKey);
        if (!session) return caughtUpSnapshot(deck, capturedAt);
        const base = sessionSnapshotBase(deck, session, capturedAt);

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

        if (session.activeCardId === null) {
          const nextDueAt = [...session.queueEntries]
            .sort(compareQueueEntries)[0]?.dueAt;
          if (nextDueAt === undefined) {
            throw new Error(`Incomplete session ${session.id} has no pending card.`);
          }
          return { ...base, kind: "waiting", nextDueAt };
        }

        const [card, schedule] = await Promise.all([
          transaction.getCard(session.activeCardId),
          transaction.getSchedule(session.activeCardId),
        ]);
        const activeRecords = requireActiveRecords(session, card, schedule);
        const active: StudyActiveSnapshot = {
          ...base,
          kind: "active",
          cardId: activeRecords.card.id,
          frontText: activeRecords.card.frontHtml,
          side: session.currentSide,
          ratingPreviews: this.scheduler.preview(activeRecords.schedule, new Date(capturedAt)),
          ...(session.currentSide === "back" ? { backText: activeRecords.card.backHtml } : {}),
        };
        return active;
      },
    );
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
  };
}

function sessionSnapshotBase(
  deck: DeckRecord,
  session: SessionRecord,
  capturedAt: EpochMilliseconds,
): StudySessionSnapshotBase {
  return {
    capturedAt,
    deckId: deck.id,
    deckName: deck.name,
    sessionId: session.id,
    sequence: session.sequence,
    completedPresentationCount: session.completedPresentationCount,
    plannedPresentationCount: session.plannedPresentationCount,
  };
}

function compareQueueEntries(
  left: SessionRecord["queueEntries"][number],
  right: SessionRecord["queueEntries"][number],
): number {
  return left.dueAt - right.dueAt || left.ordinal - right.ordinal || left.cardId.localeCompare(right.cardId);
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
