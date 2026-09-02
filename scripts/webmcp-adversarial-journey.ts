import type { StudyJourneyCall, StudyJourneySnapshot } from "./webmcp-study-journey";

export type AdversarialAttempt = {
  label: string;
  call: StudyJourneyCall;
  after: StudyJourneySnapshot;
};

export type AdversarialRace = {
  kind: "review" | "suspend" | "restore" | "conflict";
  deckId: string;
  cardId: string;
  before: StudyJourneySnapshot;
  after: StudyJourneySnapshot;
  calls: StudyJourneyCall[];
  readCalls: StudyJourneyCall[];
};

export type AdversarialJourneyEvidence = {
  validation: {
    before: StudyJourneySnapshot;
    invalid: AdversarialAttempt[];
    stale: AdversarialAttempt;
    premature: AdversarialAttempt;
    collision: AdversarialAttempt;
    browserErrors: string[];
  };
  races: AdversarialRace[];
  browserErrors: string[];
};

export type AdversarialJourneyAssessment = {
  status: "passed" | "failed";
  failureCode: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decode(call: StudyJourneyCall): Record<string, unknown> | null {
  if (call.status !== "passed") return null;
  try {
    return record(typeof call.result === "string" ? JSON.parse(call.result) : call.result);
  } catch {
    return null;
  }
}

function code(call: StudyJourneyCall): string | null {
  const error = record(decode(call)?.error);
  return typeof error?.code === "string" ? error.code : null;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalid(call: StudyJourneyCall): boolean {
  return code(call) === "INVALID_INPUT" ||
    (call.status === "failed" && /parse input|invalid|schema|argument/i.test(call.error ?? ""));
}

function durable(snapshot: StudyJourneySnapshot): Record<string, unknown> | null {
  return record(snapshot.durable);
}

function successful(call: StudyJourneyCall): boolean {
  return decode(call)?.ok === true;
}

function oneEffectRace(race: AdversarialRace): boolean {
  const before = durable(race.before);
  const after = durable(race.after);
  const beforeSession = record(before?.session);
  const afterSession = record(after?.session);
  const beforeLogs = Array.isArray(before?.reviewLogs) ? before.reviewLogs : [];
  const afterLogs = Array.isArray(after?.reviewLogs) ? after.reviewLogs : [];
  const afterSchedule = record(after?.schedule);
  if (!before || !after || race.calls.length !== 2 ||
      race.calls.some((call) => !successful(call)) ||
      race.readCalls.some((call) => !successful(call))) return false;

  if (race.kind === "review") {
    const matchingLogs = afterLogs.filter((value) => record(value)?.cardId === race.cardId);
    return matchingLogs.length === 1 && afterLogs.length === beforeLogs.length + 1 &&
      Number(afterSession?.completedPresentationCount) ===
        Number(beforeSession?.completedPresentationCount) + 1;
  }
  if (race.kind === "suspend") {
    const beforeSchedule = record(before.schedule);
    const removed = Number(beforeSession?.plannedPresentationCount) -
      Number(afterSession?.plannedPresentationCount);
    return beforeSchedule?.suspended === false && afterSchedule?.suspended === true &&
      removed >= 1 && afterLogs.length === beforeLogs.length;
  }
  if (race.kind === "restore") {
    const beforeSchedule = record(before.schedule);
    return beforeSchedule?.suspended === true && afterSchedule?.suspended === false &&
      afterLogs.length === beforeLogs.length &&
      race.calls.some((call) => record(decode(call)?.data)?.idempotent === false) &&
      race.calls.every((call) => Number(record(decode(call)?.data)?.restored_count) >= 1);
  }
  return false;
}

function conflictIsLegal(race: AdversarialRace): boolean {
  const before = durable(race.before);
  const after = durable(race.after);
  const beforeLogs = Array.isArray(before?.reviewLogs) ? before.reviewLogs : [];
  const afterLogs = Array.isArray(after?.reviewLogs) ? after.reviewLogs : [];
  const schedule = record(after?.schedule);
  const successes = race.calls.filter(successful);
  const rejected = race.calls.filter((call) => code(call) === "STALE_CARD");
  if (successes.length !== 1 || rejected.length !== 1 ||
      race.readCalls.length !== 2 || race.readCalls.some((call) => !successful(call))) return false;
  const reviewWon = afterLogs.length === beforeLogs.length + 1 && schedule?.suspended !== true;
  const suspendWon = afterLogs.length === beforeLogs.length && schedule?.suspended === true;
  return reviewWon !== suspendWon;
}

/** Classify observable invalid-call and independently seeded concurrency evidence. */
export function assessAdversarialJourney(
  evidence: AdversarialJourneyEvidence,
): AdversarialJourneyAssessment {
  const validation = evidence.validation;
  if (validation.invalid.length < 4 || validation.invalid.some((attempt) =>
    !invalid(attempt.call) || !equal(validation.before, attempt.after)
  )) return { status: "failed", failureCode: "invalid-input-contract-failed" };
  if (code(validation.stale.call) !== "STALE_CARD" ||
      !equal(validation.before, validation.stale.after)) {
    return { status: "failed", failureCode: "stale-card-contract-failed" };
  }
  if (code(validation.premature.call) !== "ANSWER_NOT_REVEALED" ||
      !equal(validation.before, validation.premature.after)) {
    return { status: "failed", failureCode: "answer-not-revealed-contract-failed" };
  }
  if (code(validation.collision.call) !== "DUPLICATE_COMMAND" ||
      !equal(validation.before, validation.collision.after)) {
    return { status: "failed", failureCode: "duplicate-command-contract-failed" };
  }
  const expected = ["review", "suspend", "restore", "conflict"] as const;
  for (const kind of expected) {
    const matches = evidence.races.filter((race) => race.kind === kind);
    if (matches.length !== 1) return { status: "failed", failureCode: `${kind}-race-missing` };
    const passed = kind === "conflict" ? conflictIsLegal(matches[0]!) : oneEffectRace(matches[0]!);
    if (!passed) return { status: "failed", failureCode: `${kind}-race-contract-failed` };
  }
  if (validation.browserErrors.length > 0 || evidence.browserErrors.length > 0) {
    return { status: "failed", failureCode: "adversarial-browser-errors" };
  }
  return { status: "passed", failureCode: null };
}
