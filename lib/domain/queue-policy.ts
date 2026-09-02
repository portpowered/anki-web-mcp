import type {
  CardRecord,
  EpochMilliseconds,
  ScheduleRecord,
  ScheduleState,
  SessionRecord,
  SessionQueueEntry,
} from "./entities";

export const DEFAULT_SESSION_INTAKE_LIMIT = 20;

/** The smallest card/schedule join needed to construct a session intake. */
export interface IntakeCandidate {
  readonly card: Pick<CardRecord, "id" | "creationOrder">;
  readonly schedule: Pick<ScheduleRecord, "cardId" | "dueAt" | "state" | "suspended">;
}

/** The persisted portion of a session needed for pending-card exclusion. */
export interface PendingSessionSnapshot {
  readonly completedAt: SessionRecord["completedAt"];
  readonly queueEntries: readonly Pick<SessionQueueEntry, "cardId">[];
}

export interface SelectEligibleIntakeOptions {
  readonly candidates: readonly IntakeCandidate[];
  readonly now: EpochMilliseconds;
  readonly incompleteSessions?: readonly PendingSessionSnapshot[];
  readonly intakeLimit?: number;
}

export type NoEligibleCardsReason =
  | "empty"
  | "all-suspended"
  | "caught-up";

export interface SelectedIntake {
  readonly status: "selected";
  readonly kind: "selected";
  readonly intakeLimit: number;
  readonly candidates: readonly IntakeCandidate[];
  readonly cardIds: readonly string[];
}

export interface NoEligibleCards {
  readonly status: "no-eligible-cards";
  readonly kind: "no-eligible-cards";
  readonly reason: NoEligibleCardsReason;
  readonly intakeLimit: number;
  readonly candidates: readonly [];
  readonly cardIds: readonly [];
}

export type IntakeSelection = SelectedIntake | NoEligibleCards;

export class QueuePolicyValidationError extends Error {
  readonly code = "invalid-intake" as const;
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "QueuePolicyValidationError";
    this.field = field;
  }
}

/**
 * Selects a bounded, deterministic intake at an explicitly supplied instant.
 *
 * Due learning, relearning, and review cards are ordered before new cards.
 * Pending occurrences are collected only from incomplete sessions; completed
 * historical sessions therefore do not reserve cards for future intake.
 */
export function selectEligibleIntake(
  options: SelectEligibleIntakeOptions,
): IntakeSelection {
  const now = validateEpoch(options.now, "now");
  const intakeLimit = validateIntakeLimit(options.intakeLimit);
  const candidates = deduplicateCandidates(options.candidates);
  const pendingCardIds = collectPendingCardIds(options.incompleteSessions ?? []);

  if (candidates.length === 0) {
    return noEligibleCards("empty", intakeLimit);
  }

  const eligible = candidates
    .filter((candidate) => !candidate.schedule.suspended)
    // New cards use creation order rather than a due timestamp for intake;
    // scheduled states become eligible only once their due time is reached.
    .filter((candidate) => (
      candidate.schedule.state === "new"
      || candidate.schedule.dueAt <= now
    ))
    .filter((candidate) => !pendingCardIds.has(candidate.card.id))
    .sort(compareCandidates);

  if (eligible.length === 0) {
    const reason = candidates.every((candidate) => candidate.schedule.suspended)
      ? "all-suspended"
      : "caught-up";
    return noEligibleCards(reason, intakeLimit);
  }

  const selected = eligible.slice(0, intakeLimit);
  return {
    status: "selected",
    kind: "selected",
    intakeLimit,
    candidates: selected,
    cardIds: selected.map((candidate) => candidate.card.id),
  };
}

/** Alias emphasizing that this policy is intended for deterministic sessions. */
export const selectDeterministicIntake = selectEligibleIntake;

function noEligibleCards(
  reason: NoEligibleCardsReason,
  intakeLimit: number,
): NoEligibleCards {
  return {
    status: "no-eligible-cards",
    kind: "no-eligible-cards",
    reason,
    intakeLimit,
    candidates: [],
    cardIds: [],
  };
}

function deduplicateCandidates(
  candidates: readonly IntakeCandidate[],
): IntakeCandidate[] {
  const byCardId = new Map<string, IntakeCandidate>();

  for (const candidate of candidates) {
    validateCandidate(candidate);
    const cardId = candidate.card.id;
    const existing = byCardId.get(cardId);
    if (existing === undefined || compareCandidates(candidate, existing) < 0) {
      byCardId.set(cardId, candidate);
    }
  }

  return [...byCardId.values()];
}

function collectPendingCardIds(
  sessions: readonly PendingSessionSnapshot[],
): Set<string> {
  const pendingCardIds = new Set<string>();
  for (const session of sessions) {
    if (session.completedAt !== null) {
      continue;
    }
    for (const entry of session.queueEntries) {
      if (typeof entry.cardId === "string" && entry.cardId.length > 0) {
        pendingCardIds.add(entry.cardId);
      }
    }
  }
  return pendingCardIds;
}

function compareCandidates(
  left: IntakeCandidate,
  right: IntakeCandidate,
): number {
  const leftPriority = statePriority(left.schedule.state);
  const rightPriority = statePriority(right.schedule.state);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  if (left.schedule.state === "new" && right.schedule.state === "new") {
    const creationOrderComparison = compareNumbers(
      left.card.creationOrder,
      right.card.creationOrder,
    );
    if (creationOrderComparison !== 0) {
      return creationOrderComparison;
    }
  } else {
    const dueComparison = compareNumbers(
      left.schedule.dueAt,
      right.schedule.dueAt,
    );
    if (dueComparison !== 0) {
      return dueComparison;
    }
  }

  const cardIdComparison = compareStrings(left.card.id, right.card.id);
  if (cardIdComparison !== 0) {
    return cardIdComparison;
  }

  // This final tie-breaker makes duplicate records deterministic even when
  // their card IDs match but their persisted values do not.
  const dueComparison = compareNumbers(left.schedule.dueAt, right.schedule.dueAt);
  if (dueComparison !== 0) {
    return dueComparison;
  }
  const creationOrderComparison = compareNumbers(
    left.card.creationOrder,
    right.card.creationOrder,
  );
  if (creationOrderComparison !== 0) {
    return creationOrderComparison;
  }
  return Number(left.schedule.suspended) - Number(right.schedule.suspended);
}

function statePriority(state: ScheduleState): number {
  switch (state) {
    case "learning":
      return 0;
    case "relearning":
      return 1;
    case "review":
      return 2;
    case "new":
      return 3;
  }
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compare UTF-16 code units so ordering does not depend on host locale data. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateCandidate(candidate: IntakeCandidate): void {
  if (typeof candidate !== "object" || candidate === null) {
    throw new QueuePolicyValidationError(
      "An intake candidate must be an object.",
      "candidate",
    );
  }
  if (
    typeof candidate.card !== "object"
    || candidate.card === null
    || typeof candidate.card.id !== "string"
    || candidate.card.id.trim().length === 0
  ) {
    throw new QueuePolicyValidationError(
      "An intake candidate requires a non-empty card ID.",
      "card.id",
    );
  }
  if (
    typeof candidate.card.creationOrder !== "number"
    || !Number.isFinite(candidate.card.creationOrder)
  ) {
    throw new QueuePolicyValidationError(
      "An intake candidate requires a finite creation order.",
      "card.creationOrder",
    );
  }
  if (
    typeof candidate.schedule !== "object"
    || candidate.schedule === null
    || candidate.schedule.cardId !== candidate.card.id
  ) {
    throw new QueuePolicyValidationError(
      "The schedule card ID must match the candidate card ID.",
      "schedule.cardId",
    );
  }
  validateEpoch(candidate.schedule.dueAt, "schedule.dueAt");
  if (!isScheduleState(candidate.schedule.state)) {
    throw new QueuePolicyValidationError(
      `Unknown schedule state: ${String(candidate.schedule.state)}.`,
      "schedule.state",
    );
  }
  if (typeof candidate.schedule.suspended !== "boolean") {
    throw new QueuePolicyValidationError(
      "schedule.suspended must be a boolean.",
      "schedule.suspended",
    );
  }
}

function validateEpoch(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new QueuePolicyValidationError(
      `${field} must be a finite epoch-millisecond value.`,
      field,
    );
  }
  return value;
}

function validateIntakeLimit(value: number | undefined): number {
  const intakeLimit = value ?? DEFAULT_SESSION_INTAKE_LIMIT;
  if (!Number.isInteger(intakeLimit) || intakeLimit <= 0) {
    throw new QueuePolicyValidationError(
      "intakeLimit must be a positive integer.",
      "intakeLimit",
    );
  }
  return intakeLimit;
}

function isScheduleState(value: unknown): value is ScheduleState {
  return (
    value === "new"
    || value === "learning"
    || value === "review"
    || value === "relearning"
  );
}
