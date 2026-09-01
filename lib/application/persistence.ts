import type {
  CardRecord,
  DeckRecord,
  ReviewLogRecord,
  ScheduleRecord,
  ScheduleSnapshot,
  SessionRecord,
} from "../domain/entities";
import {
  domainError,
  failure,
  mapDatabaseError,
  success,
  type DomainResult,
} from "../domain/errors";
import type { Clock, IdGenerator } from "../domain/ports";
import { randomIdGenerator } from "../platform/ids";
import { systemClock } from "../platform/clock";
import {
  createRepositories,
  type IndexedDbRepositorySet,
} from "../persistence/repositories";
import {
  openDatabaseWithSeed,
  type OpenDatabaseWithSeedOptions,
  SEED_INSTALLED_META_KEY,
  SEED_VERSION_META_KEY,
  SPANISH_BASICS_DECK_ID,
} from "../persistence";
import { SCHEMA_VERSION_META_KEY } from "../persistence/schema";
import { createStudyStateTransactionCoordinator } from "../persistence/study-state";

export const ACTIVE_SESSION_STORAGE_KEY = "anki-web-mcp.active-session-id";
export const PERSISTENCE_PROBE_COMMAND_ID = "browser-persistence-probe-v1";

const DAY_IN_MILLISECONDS = 86_400_000;

export interface PersistenceSnapshot {
  readonly databaseName: string;
  readonly schemaVersion: number;
  readonly seedInstalled: boolean;
  readonly seedVersion: number;
  readonly deck: DeckRecord;
  readonly cards: readonly CardRecord[];
  readonly schedules: readonly ScheduleRecord[];
  readonly sessions: readonly SessionRecord[];
  readonly reviewLogs: readonly ReviewLogRecord[];
  /** A transient sessionStorage pointer, not a durable record payload. */
  readonly activeSessionId: string | null;
}

export interface ApplicationPersistence {
  readSnapshot(): Promise<DomainResult<PersistenceSnapshot>>;
  writeRepresentativeStudyState(): Promise<DomainResult<PersistenceSnapshot>>;
  close(): void;
}

export interface ApplicationPersistencePorts {
  clock?: Clock;
  idGenerator?: IdGenerator;
}

/**
 * Open the one application-owned persistence service for a browser tab.
 * Route components use this promise instead of opening IndexedDB themselves.
 */
export function openApplicationPersistence(): Promise<DomainResult<ApplicationPersistence>> {
  if (!applicationPersistencePromise) {
    applicationPersistencePromise = createApplicationPersistence().then((result) => {
      if (!result.ok) {
        applicationPersistencePromise = undefined;
      }
      return result;
    });
  }

  return applicationPersistencePromise;
}

export async function createApplicationPersistence(
  options: OpenDatabaseWithSeedOptions = {},
  ports: ApplicationPersistencePorts = {},
): Promise<DomainResult<ApplicationPersistence>> {
  const opened = await openDatabaseWithSeed(options);
  if (!opened.ok) {
    return opened;
  }

  const repositories = createRepositories(opened.value.database);
  const service = new IndexedDbApplicationPersistence(
    opened.value.database,
    repositories,
    ports.clock ?? systemClock,
    ports.idGenerator ?? randomIdGenerator,
  );
  const snapshot = await service.readSnapshot();
  if (!snapshot.ok) {
    service.close();
    return snapshot;
  }

  return success(service);
}

let applicationPersistencePromise:
  | Promise<DomainResult<ApplicationPersistence>>
  | undefined;

class IndexedDbApplicationPersistence implements ApplicationPersistence {
  private readonly coordinator;

  constructor(
    private readonly database: IDBDatabase,
    private readonly repositories: IndexedDbRepositorySet,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {
    this.coordinator = createStudyStateTransactionCoordinator(
      database,
      repositories,
    );
  }

  readSnapshot(): Promise<DomainResult<PersistenceSnapshot>> {
    return Promise.all([
      this.repositories.meta.get(SCHEMA_VERSION_META_KEY),
      this.repositories.meta.get(SEED_INSTALLED_META_KEY),
      this.repositories.meta.get(SEED_VERSION_META_KEY),
      this.repositories.decks.get(SPANISH_BASICS_DECK_ID),
      this.repositories.cards.listByDeckId(SPANISH_BASICS_DECK_ID),
      this.repositories.schedules.list(),
      this.repositories.sessions.list(),
      this.repositories.reviewLogs.listByDeckId(SPANISH_BASICS_DECK_ID),
    ]).then((results) => {
      const failureResult = results.find((result) => !result.ok);
      if (failureResult && !failureResult.ok) {
        return failureResult;
      }

      const [schemaVersion, seedInstalled, seedVersion, deck, cards, schedules,
        sessions, reviewLogs] = results;
      if (
        !schemaVersion.ok
        || !seedInstalled.ok
        || !seedVersion.ok
        || !deck.ok
        || !cards.ok
        || !schedules.ok
        || !sessions.ok
        || !reviewLogs.ok
      ) {
        return failure(domainError(
          "storage",
          "The persistence snapshot could not be read.",
          { resource: "application-persistence" },
        ));
      }

      if (
        typeof schemaVersion.value.value !== "number"
        || !Number.isInteger(schemaVersion.value.value)
        || seedInstalled.value.value !== true
        || typeof seedVersion.value.value !== "number"
        || !Number.isInteger(seedVersion.value.value)
      ) {
        return failure(domainError(
          "validation",
          "The persistence metadata is invalid.",
          { resource: "meta" },
        ));
      }

      return success({
        databaseName: this.database.name,
        schemaVersion: schemaVersion.value.value,
        seedInstalled: seedInstalled.value.value,
        seedVersion: seedVersion.value.value,
        deck: deck.value,
        cards: cards.value,
        schedules: schedules.value
          .filter((schedule) => schedule.deckId === SPANISH_BASICS_DECK_ID)
          .sort(compareSchedules),
        sessions: sessions.value
          .filter((session) => session.deckId === SPANISH_BASICS_DECK_ID)
          .sort(compareSessions),
        reviewLogs: reviewLogs.value,
        activeSessionId: readActiveSessionId(),
      });
    });
  }

  async writeRepresentativeStudyState(): Promise<DomainResult<PersistenceSnapshot>> {
    const current = await this.readSnapshot();
    if (!current.ok) {
      return current;
    }

    const existingProbe = current.value.reviewLogs.find(
      (reviewLog) => reviewLog.commandId === PERSISTENCE_PROBE_COMMAND_ID,
    );
    if (existingProbe) {
      writeActiveSessionId(existingProbe.sessionId);
      return current;
    }

    const card = current.value.cards[0];
    const schedule = card
      ? current.value.schedules.find((candidate) => candidate.cardId === card.id)
      : undefined;
    if (!card || !schedule) {
      return failure(domainError(
        "not-found",
        "The seeded card schedule is not available.",
        { resource: "schedules", key: card?.id ?? SPANISH_BASICS_DECK_ID },
      ));
    }

    let now: number;
    let sessionId: string;
    let reviewLogId: string;
    try {
      now = this.clock.now();
      sessionId = this.idGenerator.next("session");
      reviewLogId = this.idGenerator.next("review");
    } catch (cause) {
      return failure(mapDatabaseError(cause, "validation", {
        resource: "application-persistence",
      }));
    }

    const before = scheduleSnapshot(schedule);
    const afterSchedule: ScheduleRecord = {
      ...schedule,
      dueAt: Math.max(schedule.dueAt, now) + DAY_IN_MILLISECONDS,
      stability: Math.max(schedule.stability, 1),
      scheduledDays: Math.max(schedule.scheduledDays, 1),
      reps: schedule.reps + 1,
      state: "review",
      lastReviewAt: now,
    };
    const after = scheduleSnapshot(afterSchedule);
    const dayKey = localDayKey(now);
    const session: SessionRecord = {
      id: sessionId,
      deckId: current.value.deck.id,
      dayKey,
      sequence: nextSessionSequence(current.value.sessions, dayKey),
      intakeLimit: current.value.deck.sessionIntakeLimit,
      nextDayAt: nextLocalDayAt(now),
      queueEntries: [{ cardId: card.id, dueAt: afterSchedule.dueAt, ordinal: 0 }],
      activeCardId: card.id,
      plannedPresentationCount: 1,
      completedPresentationCount: 1,
      currentSide: "front",
      ratingCounts: { again: 0, hard: 0, good: 1, easy: 0 },
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      lastCommandIds: [PERSISTENCE_PROBE_COMMAND_ID],
    };
    const reviewLog: ReviewLogRecord = {
      id: reviewLogId,
      sessionId,
      deckId: current.value.deck.id,
      cardId: card.id,
      rating: "good",
      reviewedAt: now,
      durationMs: 1_000,
      before,
      after,
      commandId: PERSISTENCE_PROBE_COMMAND_ID,
    };
    const deck: DeckRecord = {
      ...current.value.deck,
      lastStudiedAt: now,
    };

    const sessionWrite = await this.repositories.sessions.add(session);
    if (!sessionWrite.ok) {
      return sessionWrite;
    }

    const committed = await this.coordinator.commit({
      schedule: afterSchedule,
      reviewLog,
      session,
      deck,
    });
    if (!committed.ok) {
      await this.repositories.sessions.delete(session.id);
      return committed;
    }

    writeActiveSessionId(session.id);
    return this.readSnapshot();
  }

  close(): void {
    this.database.close();
  }
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
    ...(schedule.legacyEaseFactor === undefined
      ? {}
      : { legacyEaseFactor: schedule.legacyEaseFactor }),
  };
}

function nextSessionSequence(
  sessions: readonly SessionRecord[],
  dayKey: string,
): number {
  return sessions
    .filter((session) => session.dayKey === dayKey)
    .reduce((highest, session) => Math.max(highest, session.sequence), 0) + 1;
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
}

function nextLocalDayAt(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function compareSchedules(left: ScheduleRecord, right: ScheduleRecord): number {
  return left.dueAt - right.dueAt
    || (left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0);
}

function compareSessions(left: SessionRecord, right: SessionRecord): number {
  return left.sequence - right.sequence
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function readActiveSessionId(): string | null {
  try {
    return globalThis.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeActiveSessionId(sessionId: string): void {
  try {
    globalThis.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // sessionStorage is optional; IndexedDB remains authoritative.
  }
}
