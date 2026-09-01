import {
  domainError,
  failure,
  mapDatabaseError,
  success,
  type DomainResult,
} from "../domain/errors";
import {
  applySchemaMigrations,
  CURRENT_SCHEMA_VERSION,
  DATABASE_NAME,
  type SchemaMigrationHooks,
} from "./schema";

export interface OpenDatabaseOptions {
  /** Dependency injection keeps tests and non-window callers deterministic. */
  factory?: IDBFactory;
  name?: string;
  version?: number;
  onBlocked?: (databaseName: string, requestedVersion: number) => void;
  /** Optional deterministic fault hooks for migration tests and diagnostics. */
  migrationHooks?: SchemaMigrationHooks;
}

export type OpenDatabaseResult = DomainResult<IDBDatabase>;

export interface OpenedDatabaseInfo {
  database: IDBDatabase;
  /** True only when this request created an absent database. */
  created: boolean;
}

export type OpenDatabaseInfoResult = DomainResult<OpenedDatabaseInfo>;

/**
 * Open the application database through the versioned production schema.
 *
 * Native IndexedDB serializes concurrent opens and upgrades. The returned
 * connection closes itself when another tab requests a version change, which
 * lets that upgrade proceed instead of leaving the request blocked forever.
 */
export function openDatabase(
  options: OpenDatabaseOptions = {},
): Promise<OpenDatabaseResult> {
  return openDatabaseWithInfo(options).then((result) => {
    if (!result.ok) {
      return result;
    }
    return success(result.value.database);
  });
}

/**
 * Internal lifecycle variant used by the application seed boundary. Keeping
 * the creation bit here avoids guessing whether an existing empty profile is
 * genuinely new after an upgrade or a schema-only open.
 */
export function openDatabaseWithInfo(
  options: OpenDatabaseOptions = {},
): Promise<OpenDatabaseInfoResult> {
  const name = options.name ?? DATABASE_NAME;
  const version = options.version ?? CURRENT_SCHEMA_VERSION;
  const factory = options.factory ?? getGlobalIndexedDbFactory();

  if (!factory) {
    return Promise.resolve(
      failure(
        domainError("open", "IndexedDB is not available in this environment.", {
          resource: name,
        }),
      ),
    );
  }

  return new Promise<OpenDatabaseInfoResult>((resolve) => {
    let request: IDBOpenDBRequest;
    let upgradeAttempted = false;
    let upgradeFailed = false;
    let created = false;

    try {
      request = factory.open(name, version);
    } catch (cause) {
      resolve(failure(mapDatabaseError(cause, "open", { resource: name })));
      return;
    }

    request.onupgradeneeded = (event) => {
      upgradeAttempted = true;
      created = event.oldVersion === 0;
      const database = request.result;
      const transaction = request.transaction;

      if (!transaction) {
        upgradeFailed = true;
        return;
      }

      try {
        applySchemaMigrations(
          database,
          transaction,
          event.oldVersion,
          event.newVersion ?? version,
          { hooks: options.migrationHooks },
        );
      } catch {
        upgradeFailed = true;
        try {
          transaction.abort();
        } catch {
          // The request's error event still provides the typed failure.
        }
      }
    };

    request.onblocked = () => {
      options.onBlocked?.(name, version);
    };

    request.onerror = () => {
      const error = upgradeAttempted || upgradeFailed
        ? domainError("migration", "The local database could not be migrated.", {
            resource: name,
          })
        : mapDatabaseError(request.error, "open", { resource: name });
      resolve(failure(error));
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(success({ database, created }));
    };
  });
}

export const openPersistenceDatabase = openDatabase;

export interface DeleteDatabaseOptions {
  factory?: IDBFactory;
  name?: string;
  onBlocked?: (databaseName: string) => void;
}

export function deleteDatabase(
  options: DeleteDatabaseOptions = {},
): Promise<DomainResult<void>> {
  const name = options.name ?? DATABASE_NAME;
  const factory = options.factory ?? getGlobalIndexedDbFactory();

  if (!factory) {
    return Promise.resolve(
      failure(
        domainError("open", "IndexedDB is not available in this environment.", {
          resource: name,
        }),
      ),
    );
  }

  return new Promise<DomainResult<void>>((resolve) => {
    let request: IDBOpenDBRequest;

    try {
      request = factory.deleteDatabase(name);
    } catch (cause) {
      resolve(failure(mapDatabaseError(cause, "open", { resource: name })));
      return;
    }

    request.onblocked = () => options.onBlocked?.(name);
    request.onerror = () =>
      resolve(failure(mapDatabaseError(request.error, "open", { resource: name })));
    request.onsuccess = () => resolve(success(undefined));
  });
}

function getGlobalIndexedDbFactory(): IDBFactory | undefined {
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}
