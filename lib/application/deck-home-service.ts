import type { DeckRecord } from "../domain/entities";
import { failure, success, type DomainResult } from "../domain/errors";
import type { Clock } from "../domain/ports";
import type { RepositorySet } from "../domain/repositories";
import { systemClock } from "../platform/clock";
import { IndexedDbStudyDatabase } from "../persistence/db";
import {
  openDatabaseWithSeed,
  type OpenDatabaseWithSeedOptions,
} from "../persistence/seed";
import { createRepositories } from "../persistence/repositories";
import {
  SessionService,
  type SessionStartResult,
} from "./session-service";
import type { RestoreSuspendedResult } from "./suspension-service";
import type { OperationGuard } from "./operation-guard";
import {
  createImportFileController,
  type ImportFileController,
} from "./import-intake-controller";
import { createProductionImportService } from "./production-import";

export interface DeckHomeRow {
  readonly id: string;
  readonly name: string;
  readonly cardCount: number;
  readonly dueCount: number;
  readonly suspendedCount: number;
  readonly lastStudiedAt: number | null;
  readonly canStartSession: boolean;
}

export interface DeckHomeSnapshot {
  readonly capturedAt: number;
  readonly decks: readonly DeckHomeRow[];
}

export interface DeckHomeSnapshotReader {
  readSnapshot(): Promise<DomainResult<DeckHomeSnapshot>>;
}

/**
 * Read all home-route metadata behind one application boundary.
 *
 * Repositories remain the only IndexedDB-aware layer. Callers receive a
 * serializable snapshot captured against one clock instant, which keeps React
 * and future WebMCP handlers from independently deriving deck counts.
 */
export class DeckHomeService implements DeckHomeSnapshotReader {
  constructor(
    private readonly repositories: RepositorySet,
    private readonly clock: Clock = systemClock,
  ) {}

  async readSnapshot(): Promise<DomainResult<DeckHomeSnapshot>> {
    const capturedAt = this.clock.now();
    const [decks, cards, schedules, sessions] = await Promise.all([
      this.repositories.decks.list(),
      this.repositories.cards.list(),
      this.repositories.schedules.list(),
      this.repositories.sessions.list(),
    ]);

    if (!decks.ok) return failure(decks.error);
    if (!cards.ok) return failure(cards.error);
    if (!schedules.ok) return failure(schedules.error);
    if (!sessions.ok) return failure(sessions.error);

    return success({
      capturedAt,
      decks: [...decks.value]
        .sort(compareDecks)
        .map((deck) => {
          const deckSchedules = schedules.value.filter(
            (schedule) => schedule.deckId === deck.id,
          );

          return {
            id: deck.id,
            name: deck.name,
            cardCount: cards.value.filter((card) => card.deckId === deck.id).length,
            dueCount: deckSchedules.filter(
              (schedule) => !schedule.suspended && schedule.dueAt <= capturedAt,
            ).length,
            suspendedCount: deckSchedules.filter(
              (schedule) => schedule.suspended,
            ).length,
            lastStudiedAt: deck.lastStudiedAt,
            canStartSession:
              sessions.value.some(
                (session) => session.deckId === deck.id && session.completedAt === null,
              )
              || deckSchedules.some(
                (schedule) => !schedule.suspended
                  && (schedule.state === "new" || schedule.dueAt <= capturedAt),
              ),
          };
        }),
    });
  }
}

export interface BrowserDeckHomeService extends DeckHomeSnapshotReader {
  importFile: ImportFileController["start"];
  selectDeck(deckId: string): Promise<SessionStartResult>;
  restoreSuspended(
    deckId: string,
    commandId: string,
    canCommit?: OperationGuard,
  ): Promise<RestoreSuspendedResult>;
  close(): void;
}

export async function createDeckHomeService(
  options: OpenDatabaseWithSeedOptions = {},
  clock: Clock = systemClock,
): Promise<DomainResult<BrowserDeckHomeService>> {
  const opened = await openDatabaseWithSeed(options);
  if (!opened.ok) return opened;

  const service = new DeckHomeService(
    createRepositories(opened.value.database),
    clock,
  );
  const sessionService = new SessionService({
    database: new IndexedDbStudyDatabase(opened.value.database),
    clock,
  });
  const importController = createImportFileController(
    createProductionImportService(opened.value.database),
  );

  return success({
    importFile: (file) => importController.start(file),
    readSnapshot: () => service.readSnapshot(),
    selectDeck: (deckId) => sessionService.startSession(deckId),
    restoreSuspended: (deckId, commandId, canCommit) =>
      sessionService.restoreSuspended({ deckId, commandId, canCommit }),
    close: () => opened.value.database.close(),
  });
}

let browserDeckHomeService:
  | Promise<DomainResult<BrowserDeckHomeService>>
  | undefined;

/** Share one seeded browser connection across concurrent route mounts. */
export function openDeckHomeService(): Promise<DomainResult<BrowserDeckHomeService>> {
  if (!browserDeckHomeService) {
    browserDeckHomeService = createDeckHomeService().then((result) => {
      if (!result.ok) browserDeckHomeService = undefined;
      return result;
    });
  }

  return browserDeckHomeService;
}

function compareDecks(left: DeckRecord, right: DeckRecord): number {
  return left.createdAt - right.createdAt
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}
