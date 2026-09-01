import {
  domainError,
  failure,
  mapDatabaseError,
  success,
  type DomainResult,
} from "../domain/errors";
import type {
  RepositorySet,
  StudyStateChanges,
  StudyStateTransactionCoordinator,
  StudyStateTransactionHooks,
  StudyStateTransactionOptions,
  StudyStateWritePosition,
} from "../domain/repositories";
import {
  STUDY_STATE_TRANSACTION_STORES,
  STUDY_STATE_WRITE_POSITIONS,
} from "../domain/repositories";
import {
  createRepositories,
  createRepositoryTransactionContext,
} from "./repositories";

/**
 * Commits the four durable parts of a study rating as one native transaction.
 *
 * The coordinator deliberately accepts complete, already-calculated records.
 * It has no scheduler, clock, ID, UI, or WebMCP responsibilities; callers
 * supply those values before crossing this persistence boundary.
 */
export class IndexedDbStudyStateTransactionCoordinator
  implements StudyStateTransactionCoordinator
{
  constructor(
    private readonly database: IDBDatabase,
    private readonly repositories: RepositorySet = createRepositories(database),
    private readonly defaultOptions: StudyStateTransactionOptions = {},
  ) {}

  async commit(
    changes: StudyStateChanges,
    options: StudyStateTransactionOptions = {},
  ): Promise<DomainResult<StudyStateChanges>> {
    const validation = validateStudyStateChanges(changes);
    if (!validation.ok) {
      return validation;
    }

    let transaction: IDBTransaction;
    try {
      transaction = this.database.transaction(
        [...STUDY_STATE_TRANSACTION_STORES],
        "readwrite",
      );
    } catch (cause) {
      return transactionFailure(cause);
    }

    const completion = waitForTransaction(transaction);
    const context = createRepositoryTransactionContext(
      transaction,
      [...STUDY_STATE_TRANSACTION_STORES],
    );
    const hooks = options.hooks ?? this.defaultOptions.hooks;
    const failureAt = options.failureAt ?? this.defaultOptions.failureAt;

    try {
      const existing = await Promise.all([
        this.repositories.schedules.get(changes.schedule.cardId, context),
        this.repositories.sessions.get(changes.session.id, context),
        this.repositories.decks.get(changes.deck.id, context),
      ]);
      const readFailure = existing.find((result) => !result.ok);
      if (readFailure && !readFailure.ok) {
        await abortAndSettle(transaction, completion);
        return readFailure;
      }

      for (const position of STUDY_STATE_WRITE_POSITIONS) {
        try {
          invokeBeforeWrite(position, changes, hooks, failureAt);
        } catch (cause) {
          await abortAndSettle(transaction, completion);
          return transactionFailure(cause);
        }

        const writeResult = await this.write(
          position,
          changes,
          context,
        );
        if (!writeResult.ok) {
          await abortAndSettle(transaction, completion);
          return writeResult;
        }

        try {
          hooks?.afterWrite?.(position, changes);
        } catch (cause) {
          await abortAndSettle(transaction, completion);
          return transactionFailure(cause);
        }
      }

      try {
        await completion;
      } catch (cause) {
        return transactionFailure(cause);
      }

      return success(changes);
    } catch (cause) {
      await abortAndSettle(transaction, completion);
      return transactionFailure(cause);
    }
  }

  private write(
    position: StudyStateWritePosition,
    changes: StudyStateChanges,
    context: ReturnType<typeof createRepositoryTransactionContext>,
  ): Promise<DomainResult<unknown>> {
    switch (position) {
      case "schedule":
        return this.repositories.schedules.put(changes.schedule, context);
      case "reviewLog":
        return this.repositories.reviewLogs.add(changes.reviewLog, context);
      case "session":
        return this.repositories.sessions.put(changes.session, context);
      case "deck":
        return this.repositories.decks.put(changes.deck, context);
    }
  }
}

export function createStudyStateTransactionCoordinator(
  database: IDBDatabase,
  repositories: RepositorySet = createRepositories(database),
  options: StudyStateTransactionOptions = {},
): StudyStateTransactionCoordinator {
  return new IndexedDbStudyStateTransactionCoordinator(
    database,
    repositories,
    options,
  );
}

export const createAtomicStudyStateTransactionCoordinator =
  createStudyStateTransactionCoordinator;

function validateStudyStateChanges(
  changes: StudyStateChanges,
): DomainResult<StudyStateChanges> {
  if (changes.schedule.deckId !== changes.deck.id) {
    return failure(domainError(
      "validation",
      "The schedule and deck must belong to the same deck.",
      { resource: "study-state", key: changes.schedule.cardId },
    ));
  }

  if (changes.session.deckId !== changes.deck.id) {
    return failure(domainError(
      "validation",
      "The session and deck must belong to the same deck.",
      { resource: "study-state", key: changes.session.id },
    ));
  }

  if (
    changes.reviewLog.deckId !== changes.deck.id
    || changes.reviewLog.cardId !== changes.schedule.cardId
    || changes.reviewLog.sessionId !== changes.session.id
  ) {
    return failure(domainError(
      "validation",
      "The review log must reference the supplied study state.",
      { resource: "study-state", key: changes.reviewLog.id },
    ));
  }

  return success(changes);
}

function invokeBeforeWrite(
  position: StudyStateWritePosition,
  changes: StudyStateChanges,
  hooks: StudyStateTransactionHooks | undefined,
  failureAt: StudyStateWritePosition | undefined,
): void {
  hooks?.beforeWrite?.(position, changes);
  if (failureAt === position) {
    throw new Error(`Injected failure before ${position} write.`);
  }
}

function transactionFailure(cause: unknown): DomainResult<never> {
  const mapped = mapDatabaseError(cause, "transaction", {
    resource: "study-state",
  });

  // InvalidStateError is classified as a migration error by the generic
  // database mapper because it is most commonly observed during upgrades.
  // At this boundary it means the requested study transaction was not usable.
  if (mapped.code === "migration") {
    return failure(domainError(
      "transaction",
      "The database transaction was not committed.",
      { resource: "study-state" },
    ));
  }

  return failure(mapped);
}

async function abortAndSettle(
  transaction: IDBTransaction,
  completion: Promise<void>,
): Promise<void> {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have aborted or completed. The completion
    // promise below still gives the caller a deterministic terminal state.
  }

  await completion.catch(() => undefined);
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new DOMException(
        "IndexedDB transaction aborted.",
        "AbortError",
      ),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new DOMException(
        "IndexedDB transaction failed.",
        "UnknownError",
      ),
    );
  });
}
