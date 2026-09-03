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
import {
  createDeckRemovalService,
  type DeckRemovalCommitResult,
  type DeckRemovalCommitResultValue,
  type DeckRemovalPreview,
  type DeckRemovalPreviewResult,
} from "./deck-removal-service";
import { ACTIVE_SESSION_STORAGE_KEY } from "./persistence";

export interface DeckHomeRow {
  readonly id: string;
  readonly name: string;
  readonly cardCount: number;
  readonly newCount: number;
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

export type DeckHomeSnapshotRefreshResult = "applied" | "failed" | "stale";

/**
 * Apply only the newest requested snapshot, even when IndexedDB reads resolve
 * out of order. Routes can invalidate pending presentation work on unmount
 * without cancelling or otherwise affecting a durable import transaction.
 */
export class DeckHomeSnapshotRefreshController {
  private generation = 0;

  async refresh(
    reader: DeckHomeSnapshotReader,
    publish: (snapshot: DeckHomeSnapshot) => void,
  ): Promise<DeckHomeSnapshotRefreshResult> {
    const ownGeneration = ++this.generation;
    let snapshot: DomainResult<DeckHomeSnapshot>;
    try {
      snapshot = await reader.readSnapshot();
    } catch {
      return ownGeneration === this.generation ? "failed" : "stale";
    }

    if (ownGeneration !== this.generation) return "stale";
    if (!snapshot.ok) return "failed";

    publish(snapshot.value);
    return "applied";
  }

  invalidate(): void {
    this.generation += 1;
  }
}

export interface ActiveSessionPointerStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export type DeckRemovalReconciliationResult =
  | {
      readonly status: "committed";
      readonly result: DeckRemovalCommitResultValue;
      readonly refresh: DeckHomeSnapshotRefreshResult;
    }
  | Exclude<DeckRemovalCommitResult, { readonly status: "committed" }>;

/**
 * Reconcile one durable removal with tab-local and route-local presentation
 * state. A shared in-flight promise closes the gap before React can render its
 * disabled committing controls, so every caller observes one transaction and
 * one snapshot refresh.
 */
export class DeckRemovalCommitController {
  private inFlight: Promise<DeckRemovalReconciliationResult> | null = null;

  constructor(
    private readonly service: Pick<BrowserDeckHomeService, "confirmRemoval" | "readSnapshot">,
    private readonly snapshots: DeckHomeSnapshotRefreshController,
    private readonly pointerStorage: ActiveSessionPointerStorage | null = browserSessionStorage(),
  ) {}

  confirm(
    preview: DeckRemovalPreview,
    publish: (snapshot: DeckHomeSnapshot) => void,
  ): Promise<DeckRemovalReconciliationResult> {
    if (this.inFlight) return this.inFlight;

    const operation = this.commitAndRefresh(preview, publish);
    this.inFlight = operation;
    const release = () => {
      if (this.inFlight === operation) this.inFlight = null;
    };
    void operation.then(release, release);
    return operation;
  }

  private async commitAndRefresh(
    preview: DeckRemovalPreview,
    publish: (snapshot: DeckHomeSnapshot) => void,
  ): Promise<DeckRemovalReconciliationResult> {
    let commit: DeckRemovalCommitResult;
    try {
      commit = await this.service.confirmRemoval(preview);
    } catch {
      return { status: "failed" };
    }
    if (commit.status !== "committed") return commit;

    clearDeletedActiveSessionPointer(
      commit.result.deletedSessionIds,
      this.pointerStorage,
    );
    const refresh = await this.snapshots.refresh(this.service, publish);
    return { ...commit, refresh };
  }
}

/** Clear only the pointer proven to have been deleted by the committed transaction. */
export function clearDeletedActiveSessionPointer(
  deletedSessionIds: readonly string[],
  storage: ActiveSessionPointerStorage | null = browserSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    const activeSessionId = storage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (activeSessionId === null || !deletedSessionIds.includes(activeSessionId)) {
      return false;
    }
    storage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    return true;
  } catch {
    // The transient pointer is best-effort; IndexedDB remains authoritative.
    return false;
  }
}

function browserSessionStorage(): ActiveSessionPointerStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
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
            newCount: deckSchedules.filter(
              (schedule) => !schedule.suspended && schedule.state === "new",
            ).length,
            dueCount: deckSchedules.filter(
              (schedule) => !schedule.suspended
                && schedule.state !== "new"
                && schedule.dueAt <= capturedAt,
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
  previewRemoval(deckId: string): Promise<DeckRemovalPreviewResult>;
  confirmRemoval(preview: DeckRemovalPreview): Promise<DeckRemovalCommitResult>;
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
  const removalService = createDeckRemovalService(opened.value.database);

  return success({
    importFile: (file, replacement) => importController.start(file, replacement),
    readSnapshot: () => service.readSnapshot(),
    selectDeck: (deckId) => sessionService.startSession(deckId),
    restoreSuspended: (deckId, commandId, canCommit) =>
      sessionService.restoreSuspended({ deckId, commandId, canCommit }),
    previewRemoval: (deckId) => removalService.previewRemoval(deckId),
    confirmRemoval: (preview) => removalService.confirmRemoval(preview),
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
