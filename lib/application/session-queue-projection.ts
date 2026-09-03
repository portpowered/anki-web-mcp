import type { EpochMilliseconds, SessionQueueEntry } from "../domain/entities";

export interface SessionQueueProjection {
  readonly entries: SessionQueueEntry[];
  readonly nextEntry: SessionQueueEntry | null;
  readonly nextCardId: string | null;
  readonly nextPresentationDueAt: EpochMilliseconds | null;
  readonly state: "active" | "completed";
}

/**
 * Projects the durable session queue into its presentation state.
 *
 * Queue membership already expresses the session's local-day cutoff, so a
 * future due time controls ordering and display only. Every queued occurrence
 * remains immediately presentable until it is removed at the day boundary.
 */
export function projectSessionQueue(
  entries: readonly SessionQueueEntry[],
): SessionQueueProjection {
  const orderedEntries = [...entries].sort(compareSessionQueueEntries);
  const nextEntry = orderedEntries[0] ?? null;

  return {
    entries: orderedEntries,
    nextEntry,
    nextCardId: nextEntry?.cardId ?? null,
    nextPresentationDueAt: nextEntry?.dueAt ?? null,
    state: nextEntry === null ? "completed" : "active",
  };
}

export function firstSessionOccurrenceForCard(
  entries: readonly SessionQueueEntry[],
  cardId: string,
): SessionQueueEntry | undefined {
  return entries
    .filter((entry) => entry.cardId === cardId)
    .sort(compareSessionQueueEntries)[0];
}

export function compareSessionQueueEntries(
  left: SessionQueueEntry,
  right: SessionQueueEntry,
): number {
  if (left.dueAt !== right.dueAt) return left.dueAt - right.dueAt;
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0;
}
