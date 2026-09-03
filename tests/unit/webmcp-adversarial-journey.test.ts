import { describe, expect, test } from "bun:test";

import {
  assessAdversarialJourney,
  type AdversarialJourneyEvidence,
  type AdversarialRace,
} from "../../scripts/webmcp-adversarial-journey";
import { SPANISH_BASICS_FIXTURE } from "../../lib/persistence/spanish-basics-fixture";

const deckId = "seed-spanish-basics";
const cardId = "card-1";
const ok = (data: object = {}) => ({ status: "passed" as const, result: { ok: true, data }, error: null });
const rejectedEnvelopes = {
  STALE_CARD: {
    ok: false,
    error: {
      code: "STALE_CARD",
      message: "The expected card is no longer current.",
      recoverable: true,
      suggested_action: "Call get_state and use its current card id.",
    },
  },
  ANSWER_NOT_REVEALED: {
    ok: false,
    error: {
      code: "ANSWER_NOT_REVEALED",
      message: "Reveal the answer before rating this card.",
      recoverable: true,
      suggested_action: "Call flip for the current card.",
    },
  },
  DUPLICATE_COMMAND: {
    ok: false,
    error: {
      code: "DUPLICATE_COMMAND",
      message: "The command_id was already used for a different study action.",
      recoverable: true,
      suggested_action: "Use a new command_id for a different action.",
    },
  },
  INVALID_INPUT: {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: "Input does not match the declared schema.",
      recoverable: true,
      suggested_action: "Use the tool's declared input schema.",
    },
  },
} as const;
const rejected = (code: keyof typeof rejectedEnvelopes) => ({
  status: "passed" as const,
  result: structuredClone(rejectedEnvelopes[code]),
  error: null,
});
const invalidRejected = () => ({
  status: "passed" as const,
  result: {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: "Input does not match the declared schema.",
      recoverable: true,
      suggested_action: "Use the tool's declared input schema.",
    },
  },
  error: null,
});
const nativeMalformedRejected = () => ({
  status: "failed" as const,
  result: null,
  error: "UnknownError: Failed to parse input arguments",
});
const currentInvocation = (toolName: "flip" | "set_state" = "flip") => ({
  intendedToolName: toolName,
  acquiredToolName: toolName,
  availableToolNames: ["get_state", "flip", "set_state", "suspend", "go_home"],
  source: "current-registration" as const,
  executeStarted: true,
});
const currentFlipInvocation = () => currentInvocation("flip");
const dayStart = Date.parse("2026-09-03T07:00:00.000Z");
const capturedAt = Date.parse("2026-09-03T12:00:00.000Z");
const nextDayAt = Date.parse("2026-09-04T07:00:00.000Z");
const dueAt = capturedAt + 10 * 60 * 1_000;
const invalidCaptureTimes: Array<[string, unknown]> = [
  ["missing", undefined],
  ["null", null],
  ["string", String(capturedAt)],
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
  ["above the valid Date epoch", 8.64e15 + 1],
  ["below the valid Date epoch", -8.64e15 - 1],
];
const snapshot = (options: {
  activeCard?: string;
  side?: "front" | "back";
  logs?: number;
  completed?: number;
  suspended?: boolean;
  planned?: number;
  visibleCurrent?: number;
  visibleTotal?: number;
  route?: "study" | "deck-home";
} = {}) => {
  const completed = options.completed ?? 0;
  const planned = options.planned ?? 20;
  const logCount = options.logs ?? 0;
  const reviewedAt = (index: number) => capturedAt - 10 + index;
  const cards = Array.from({ length: 20 }, (_, index) => ({
    id: `card-${index + 1}`,
    deckId,
    noteId: `note-${index + 1}`,
    sourceCardId: null,
    templateOrdinal: 0,
    frontText: `Front ${index + 1}`,
    backText: `Back ${index + 1}`,
    answerText: `Back ${index + 1}`,
    css: "",
    frontHtml: `Front ${index + 1}`,
    backHtml: `Back ${index + 1}`,
    answerHtml: `Back ${index + 1}`,
    backIncludesFront: false,
    mediaRefs: [],
    creationOrder: index,
    contentWarnings: [],
  }));
  const scheduleDueAt = logCount > 0 ? dueAt : dayStart;
  const schedules = cards.map((card) => ({
    cardId: card.id,
    deckId,
    dueAt: card.id === cardId ? scheduleDueAt : dayStart,
    state: (card.id === cardId && logCount > 0 ? "learning" : "new") as
      "new" | "learning" | "review" | "relearning",
    lastReviewAt: card.id === cardId && logCount > 0 ? reviewedAt(logCount - 1) : null,
    suspended: card.id === cardId ? options.suspended ?? false : false,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: card.id === cardId ? logCount : 0,
    lapses: 0,
    learningSteps: 0,
    legacyEaseFactor: null,
    intervalDays: card.id === cardId && logCount > 0 ? 1 : 0,
    easeFactor: 2.5,
  }));
  const queueEntries = cards.map((card, index) => ({
    cardId: card.id,
    dueAt: card.id === cardId ? scheduleDueAt : dayStart,
    ordinal: index + 1,
  }));
  if (planned - completed === 19) queueEntries.shift();
  if (planned - completed === 20 && completed > 0) {
    queueEntries.shift();
    queueEntries.push({ cardId, dueAt: scheduleDueAt, ordinal: cards.length + completed });
  }
  cards.sort((left, right) => left.id.localeCompare(right.id));
  schedules.sort((left, right) => left.cardId.localeCompare(right.cardId));
  const session = {
    id: "session-1",
    deckId,
    status: "active",
    dayKey: "2026-09-03",
    sequence: 1,
    intakeLimit: 20,
    nextDayAt,
    activeCardId: options.activeCard ?? cardId,
    currentSide: options.side ?? "front" as const,
    completedPresentationCount: completed,
    plannedPresentationCount: planned,
    queueEntries,
    ratingCounts: { again: 0, hard: 0, good: logCount, easy: 0 },
    startedAt: dayStart,
    updatedAt: logCount > 0 ? reviewedAt(logCount - 1) : dayStart,
    completedAt: null,
    lastCommandIds: Array.from({ length: logCount }, (_, index) =>
      index === logCount - 1 ? "race-review" : `earlier-review-${index}`),
  };
  const reviewLogs = Array.from({ length: logCount }, (_, index) => ({
    id: `log-${index}`,
    sessionId: session.id,
    deckId,
    cardId,
    rating: "good",
    reviewedAt: reviewedAt(index),
    durationMs: null,
    commandId: index === logCount - 1 ? "race-review" : `earlier-review-${index}`,
    before: {
      reps: index,
      state: index === 0 ? "new" : "learning",
      dueAt: index === 0 ? dayStart : dueAt,
      lastReviewAt: index === 0 ? null : reviewedAt(index - 1),
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      lapses: 0,
      suspended: false,
    },
    after: {
      reps: index + 1,
      state: "learning",
      dueAt: scheduleDueAt,
      lastReviewAt: reviewedAt(index),
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      lapses: 0,
      suspended: false,
    },
  }));
  return {
    visible: options.route === "deck-home"
    ? {
      route: "deck-home",
      row: "Spanish Basics 24 new • 0 due • 24 total",
      restoreAvailable: options.suspended === true,
    }
    : {
      route: "study",
      state: "active",
      cardId: options.activeCard ?? cardId,
      side: options.side ?? "front",
      sideDetail: null,
      content: `Front ${Number((options.activeCard ?? cardId).split("-")[1])}`,
      progressCurrent: options.visibleCurrent ?? 0,
      progressTotal: options.visibleTotal ?? 20,
      busy: "false",
      pageText: "Spanish Basics Card 1 of 20 Front 1 Show answer",
      stateText: "Front 1 Show answer",
      statusMessages: [],
      alertMessages: [],
    },
    durable: {
      capturedAt,
      decks: [{
        id: deckId,
        importId: "seed-import",
        sourceDeckId: null,
        name: "Spanish Basics",
        cardCount: 20,
        createdAt: dayStart - 1_000,
        lastStudiedAt: logCount > 0 ? reviewedAt(logCount - 1) : null,
        sessionIntakeLimit: 20,
        schedulerConfigId: "default",
      }],
      cards,
      sessions: [session],
      session,
      card: cards[0],
      schedule: schedules[0],
      schedules,
      reviewLogs,
      stores: {
        meta: [{ key: "schemaVersion", value: 4 }, { key: "seedEligible", value: false }],
        imports: [
          {
            id: "other-import", sha256: "20".repeat(32), fileName: "other.apkg", fileSize: 256,
            packageVersion: "2", importedAt: dayStart - 2_000, warnings: [],
          },
          {
            id: "seed-import", sha256: "10".repeat(32), fileName: "seed.apkg", fileSize: 128,
            packageVersion: "2", importedAt: dayStart - 1_000, warnings: [],
          },
        ],
        decks: [
          {
            id: "other-deck", importId: "other-import", sourceDeckId: null, name: "Other",
            cardCount: 0, createdAt: dayStart - 2_000, lastStudiedAt: null,
            sessionIntakeLimit: 20, schedulerConfigId: "default",
          },
          {
            id: deckId, importId: "seed-import", sourceDeckId: null, name: "Spanish Basics",
            cardCount: 20, createdAt: dayStart - 1_000,
            lastStudiedAt: logCount > 0 ? reviewedAt(logCount - 1) : null,
            sessionIntakeLimit: 20, schedulerConfigId: "default",
          },
        ],
        notes: [
          ...cards.map((card) => ({
            id: card.noteId,
            importId: "seed-import",
            sourceNoteId: null,
            guid: null,
            modelId: null,
            fields: { Front: card.frontText, Back: card.backText },
            tags: ["seed"],
          })),
          {
            id: "other-note", importId: "other-import", sourceNoteId: null, guid: null, modelId: null,
            fields: { Front: "Other front", Back: "Other back" }, tags: [],
          },
        ],
        cards: structuredClone(cards),
        schedules: structuredClone(schedules),
        sessions: [structuredClone(session)],
        reviewLogs: structuredClone(reviewLogs),
        media: [
          {
            importId: "other-import",
            name: "image.png",
            mimeType: "image/png",
            byteLength: 256,
            sha256: "02".repeat(32),
            blob: { size: 256, type: "image/png", bytesSha256: "02".repeat(32) },
          },
          {
            importId: "seed-import",
            name: "sound.mp3",
            mimeType: "audio/mpeg",
            byteLength: 128,
            sha256: "01".repeat(32),
            blob: { size: 128, type: "audio/mpeg", bytesSha256: "01".repeat(32) },
          },
        ],
      },
    },
  };
};

function stateFromSnapshot(value: ReturnType<typeof snapshot>) {
  const visible = value.visible as Record<string, unknown>;
  const session = value.durable.session;
  return {
    page: "study",
    status: visible.state,
    deck: { id: deckId },
    session: {
      id: session.id,
      sequence: session.sequence,
      completed_presentations: session.completedPresentationCount,
      planned_presentations: session.plannedPresentationCount,
    },
    current_card: { id: visible.cardId, side: visible.side },
  };
}

function reviewCall(after: ReturnType<typeof snapshot>, commandId = "race-review") {
  const schedule = after.durable.schedule;
  return ok({
    state: stateFromSnapshot(after),
    command_id: commandId,
    transition: {
      rating: "good",
      reviewed_card_id: cardId,
      next_card_id: (after.visible as Record<string, unknown>).cardId,
      next_due_at: new Date(schedule.dueAt).toISOString(),
      idempotent: false,
    },
  });
}

function replaceReviewRace(
  subject: AdversarialJourneyEvidence,
  kind: "review" | "conflict",
  before: ReturnType<typeof snapshot>,
  after: ReturnType<typeof snapshot>,
): void {
  const selected = subject.races.find((candidate) => candidate.kind === kind)!;
  const commandId = kind === "review" ? "race-review" : "race-conflict-review";
  after.durable.reviewLogs.at(-1)!.commandId = commandId;
  after.durable.session.lastCommandIds[after.durable.session.lastCommandIds.length - 1] = commandId;
  after.durable.sessions[0] = after.durable.session;
  const review = reviewCall(after, commandId);
  selected.before = before;
  selected.after = after;
  selected.calls = kind === "review"
    ? [review, structuredClone(review)]
    : [review, rejected("STALE_CARD")];
  selected.readCalls = kind === "conflict"
    ? [ok({ state: stateFromSnapshot(before) }), ok({ state: stateFromSnapshot(after) })]
    : [];
}

function completedAtCutoff(): ReturnType<typeof snapshot> {
  const result = snapshot({
    activeCard: "card-2",
    logs: 1,
    completed: 1,
    planned: 20,
    visibleCurrent: 1,
  });
  result.durable.schedule.dueAt = nextDayAt;
  result.durable.schedule.state = "review";
  result.durable.schedules[0] = result.durable.schedule;
  result.durable.reviewLogs[0]!.after.dueAt = nextDayAt;
  result.durable.reviewLogs[0]!.after.state = "review";
  return result;
}

function repeatedReviewBoundary(): {
  before: ReturnType<typeof snapshot>;
  after: ReturnType<typeof snapshot>;
} {
  const before = snapshot({ side: "back", logs: 1, completed: 1, planned: 21 });
  before.durable.reviewLogs[0]!.commandId = "earlier-review";
  before.durable.session.lastCommandIds = ["earlier-review"];
  before.durable.capturedAt = dueAt;
  for (const schedule of before.durable.schedules.slice(1)) schedule.dueAt = dueAt + 500;
  for (const entry of before.durable.session.queueEntries) {
    if (entry.cardId !== cardId) entry.dueAt = dueAt + 500;
  }
  before.durable.sessions[0] = before.durable.session;

  const after = structuredClone(before);
  const reviewedAt = dueAt + 900;
  const nextDueAt = dueAt + 5 * 60 * 1_000;
  after.durable.capturedAt = dueAt + 1_000;
  after.visible = {
    ...after.visible,
    route: "study",
    state: "active",
    cardId: "card-2",
    side: "front",
    sideDetail: null,
    content: "Front 2",
    progressCurrent: 0,
    progressTotal: 20,
    busy: "false",
    pageText: "Spanish Basics Card 1 of 20 Front 2 Show answer",
    stateText: "Front 2 Show answer",
    statusMessages: [],
    alertMessages: [],
    row: undefined,
    restoreAvailable: undefined,
  };
  const previousSchedule = structuredClone(after.durable.schedule);
  after.durable.schedule = {
    ...after.durable.schedule,
    dueAt: nextDueAt,
    lastReviewAt: reviewedAt,
    reps: 2,
  };
  after.durable.schedules[0] = after.durable.schedule;
  after.durable.session = {
    ...after.durable.session,
    activeCardId: "card-2",
    currentSide: "front",
    completedPresentationCount: 2,
    plannedPresentationCount: 22,
    updatedAt: reviewedAt,
    queueEntries: [
      ...after.durable.session.queueEntries.filter((entry) => entry.cardId !== cardId),
      { cardId, dueAt: nextDueAt, ordinal: 22 },
    ],
    ratingCounts: { again: 0, hard: 0, good: 2, easy: 0 },
    lastCommandIds: ["earlier-review", "race-review"],
  };
  after.durable.sessions[0] = after.durable.session;
  after.durable.decks[0]!.lastStudiedAt = reviewedAt;
  storeRecords(after, "decks")[0]!.lastStudiedAt = reviewedAt;
  after.durable.reviewLogs.push({
    id: "log-1",
    sessionId: after.durable.session.id,
    deckId,
    cardId,
    rating: "good",
    reviewedAt,
    durationMs: null,
    commandId: "race-review",
    before: {
      ...previousSchedule,
      dueAt: previousSchedule.dueAt,
      state: previousSchedule.state,
      lastReviewAt: previousSchedule.lastReviewAt,
      reps: previousSchedule.reps,
    },
    after: {
      ...after.durable.schedule,
      dueAt: nextDueAt,
      state: after.durable.schedule.state,
      lastReviewAt: reviewedAt,
      reps: 2,
    },
  });
  return { before, after };
}

function race(kind: AdversarialRace["kind"]): AdversarialRace {
  const before = kind === "restore"
    ? snapshot({ suspended: true, route: "deck-home" })
    : snapshot({ side: kind === "review" || kind === "conflict" ? "back" : "front" });
  const after = kind === "review"
    ? snapshot({ activeCard: "card-2", logs: 1, completed: 1, planned: 21 })
    : kind === "suspend"
      ? snapshot({ activeCard: "card-2", suspended: true, planned: 19, visibleTotal: 19 })
      : kind === "restore"
        ? snapshot({ suspended: false, route: "deck-home" })
        : snapshot({ activeCard: "card-2", logs: 1, completed: 1, planned: 21 });
  if (kind === "conflict") {
    after.durable.reviewLogs.at(-1)!.commandId = "race-conflict-review";
    after.durable.session.lastCommandIds = ["race-conflict-review"];
    after.durable.sessions[0] = after.durable.session;
  }
  const review = reviewCall(after, kind === "conflict" ? "race-conflict-review" : "race-review");
  const suspend = ok({
    state: stateFromSnapshot(after),
    command_id: "race-suspend",
    suspension: {
      suspended_card_id: cardId,
      removed_occurrence_count: 1,
      next_card_id: "card-2",
      idempotent: false,
    },
  });
  const restore = (idempotent: boolean) => ok({
    page: "decks",
    decks: [{
      id: deckId,
      name: "Spanish Basics",
      card_count: 24,
      new_count: 24,
      due_count: 0,
      suspended_count: 0,
    }],
    deck_id: deckId,
    command_id: "race-restore",
    restored_count: 1,
    idempotent,
  });
  return {
    kind,
    deckId,
    cardId,
    before,
    after,
    calls: kind === "conflict"
      ? [review, rejected("STALE_CARD")]
      : kind === "restore"
        ? [restore(false), restore(true)]
        : kind === "review"
          ? [review, structuredClone(review)]
          : [suspend, structuredClone(suspend)],
    readCalls: kind === "conflict"
      ? [ok({ state: stateFromSnapshot(before) }), ok({ state: stateFromSnapshot(after) })]
      : [],
  };
}

function evidence(): AdversarialJourneyEvidence {
  const before = snapshot();
  const rejectedAttempt = (
    label: string,
    code: keyof typeof rejectedEnvelopes,
    offset: number,
    toolName: "flip" | "set_state" = "flip",
  ) => {
    const attemptBefore = structuredClone(before);
    const after = structuredClone(before);
    attemptBefore.durable.capturedAt += offset;
    after.durable.capturedAt += offset + 1;
    return {
      label,
      invocation: currentInvocation(toolName),
      before: attemptBefore,
      call: rejected(code),
      after,
    };
  };
  const definitions = [
    ["missing", "{}"],
    ["malformed", "null"],
    ["wrong-type", JSON.stringify({ card_id: 42, command_id: true })],
    ["extra", JSON.stringify({ card_id: cardId, command_id: "invalid-extra", extra: true })],
  ] as const;
  return {
    validation: {
      before,
      invalid: definitions.map(([label, input], index) => {
        const attemptBefore = structuredClone(before);
        const after = structuredClone(attemptBefore);
        attemptBefore.durable.capturedAt += index * 2;
        after.durable.capturedAt += index * 2 + 1;
        return {
          label,
          input,
          invocation: currentFlipInvocation(),
          before: attemptBefore,
          call: label === "malformed" ? nativeMalformedRejected() : invalidRejected(),
          after,
        };
      }),
      control: {
        input: JSON.stringify({ card_id: cardId, command_id: "validation-control" }),
        invocation: currentFlipInvocation(),
        call: ok({ state: {} }),
      },
      stale: rejectedAttempt("wrong-card", "STALE_CARD", 10),
      premature: rejectedAttempt("before-reveal", "ANSWER_NOT_REVEALED", 20, "set_state"),
      collision: rejectedAttempt("different-fingerprint", "DUPLICATE_COMMAND", 30),
      browserErrors: [],
    },
    races: [race("review"), race("suspend"), race("restore"), race("conflict")],
    browserErrors: [],
  };
}

type Snapshot = ReturnType<typeof snapshot>;
type SnapshotMutation = (after: Snapshot) => void;

function canonicalSeedSnapshot(): Snapshot {
  const result = snapshot();
  const notes = SPANISH_BASICS_FIXTURE.map((entry) => ({
    id: `seed-spanish-basics-note-${entry.id}`,
    importId: "seed",
    sourceNoteId: null,
    guid: null,
    modelId: "spanish-basics-v1",
    fields: { Front: entry.front, Back: entry.back },
    tags: ["spanish", "basics"],
  })).sort((left, right) => left.id.localeCompare(right.id));
  const cards = SPANISH_BASICS_FIXTURE.map((entry, creationOrder) => ({
    id: `seed-spanish-basics-card-${entry.id}`,
    deckId,
    noteId: `seed-spanish-basics-note-${entry.id}`,
    sourceCardId: null,
    templateOrdinal: 0,
    frontText: entry.front,
    backText: entry.back,
    answerText: entry.back,
    css: "",
    frontHtml: entry.front,
    backHtml: entry.back,
    answerHtml: entry.back,
    backIncludesFront: false,
    mediaRefs: [],
    creationOrder,
    contentWarnings: [],
  })).sort((left, right) => left.id.localeCompare(right.id));
  const schedules = cards.map((card) => ({
    cardId: card.id,
    deckId,
    dueAt: dayStart,
    state: "new" as const,
    lastReviewAt: null,
    suspended: false,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    learningSteps: 0,
    legacyEaseFactor: null,
    intervalDays: 0,
    easeFactor: 2.5,
  }));
  const selectedCard = cards[0]!;
  const selectedSchedule = schedules[0]!;
  const deck = {
    id: deckId,
    importId: "seed",
    sourceDeckId: null,
    name: "Spanish Basics",
    cardCount: 24,
    createdAt: dayStart - 1_000,
    lastStudiedAt: null,
    sessionIntakeLimit: 20,
    schedulerConfigId: "neutral-v1",
  };
  const session = {
    ...result.durable.session,
    activeCardId: selectedCard.id,
    queueEntries: cards.slice(0, 20).map((card, index) => ({
      cardId: card.id,
      dueAt: dayStart,
      ordinal: index + 1,
    })),
  };

  const visible = result.visible as Record<string, unknown>;
  visible.cardId = selectedCard.id;
  visible.content = selectedCard.frontText;
  result.durable.decks = [deck];
  result.durable.cards = cards;
  result.durable.sessions = [session];
  result.durable.session = session;
  result.durable.card = selectedCard;
  result.durable.schedule = selectedSchedule;
  result.durable.schedules = schedules;
  result.durable.reviewLogs = [];
  result.durable.stores = {
    meta: [
      { key: "schemaVersion", value: 4 },
      { key: "seedEligible", value: false },
      { key: "seedInstalled", value: true },
      { key: "seedVersion", value: 3 },
    ],
    imports: [],
    decks: [structuredClone(deck)],
    notes,
    cards: structuredClone(cards),
    schedules: structuredClone(schedules),
    sessions: [structuredClone(session)],
    reviewLogs: [],
    media: [],
  } as unknown as typeof result.durable.stores;
  return result;
}

function seedRejectedCaseEvidence(
  key: (typeof rejectedCaseDetails)[number][0],
): AdversarialJourneyEvidence {
  return rejectedCaseEvidenceFromSnapshot(key, canonicalSeedSnapshot());
}

function rejectedCaseEvidenceFromSnapshot(
  key: (typeof rejectedCaseDetails)[number][0],
  before: Snapshot,
): AdversarialJourneyEvidence {
  const subject = evidence();
  const after = structuredClone(before);
  after.durable.capturedAt += 1;
  subject.validation[key].before = before;
  subject.validation[key].after = after;
  return subject;
}

function mixedOwnershipSnapshot(): Snapshot {
  const result = canonicalSeedSnapshot();
  storeRecords(result, "imports").push({
    id: "uploaded-import", sha256: "30".repeat(32), fileName: "uploaded.apkg", fileSize: 512,
    packageVersion: "2", importedAt: dayStart - 2_000, warnings: [],
  });
  storeRecords(result, "decks").unshift({
    id: "imported-deck", importId: "uploaded-import", sourceDeckId: "10", name: "Imported",
    cardCount: 0, createdAt: dayStart - 2_000, lastStudiedAt: null,
    sessionIntakeLimit: 20, schedulerConfigId: "default",
  });
  storeRecords(result, "notes").unshift({
    id: "imported-note", importId: "uploaded-import", sourceNoteId: "20", guid: "guid-20",
    modelId: "30", fields: { Front: "Imported front", Back: "Imported back" }, tags: [],
  });
  storeRecords(result, "media").push({
    importId: "uploaded-import", name: "image.png", mimeType: "image/png", byteLength: 64,
    sha256: "40".repeat(32), blob: { size: 64, type: "image/png", bytesSha256: "40".repeat(32) },
  });
  return result;
}

function mediaRichMixedOwnershipSnapshot(): Snapshot {
  const result = mixedOwnershipSnapshot();
  storeRecords(result, "media").push({
    importId: "uploaded-import", name: "second.png", mimeType: "image/png", byteLength: 32,
    sha256: "41".repeat(32), blob: { size: 32, type: "image/png", bytesSha256: "41".repeat(32) },
  });
  return result;
}

function snapshotWithReviewLog(makeSnapshot: () => Snapshot): Snapshot {
  const result = makeSnapshot();
  const selectedCard = result.durable.card;
  const selectedSession = result.durable.session;
  const log = structuredClone(snapshot({ logs: 1 }).durable.reviewLogs[0]!);
  log.id = "relationship-log";
  log.sessionId = selectedSession.id;
  log.deckId = selectedSession.deckId;
  log.cardId = selectedCard.id;
  log.commandId = "relationship-command";
  result.durable.reviewLogs = [structuredClone(log)];
  storeRecords(result, "reviewLogs").push(log);
  return result;
}

function setReviewLogField(value: Snapshot, field: string, replacement: unknown): void {
  (value.durable.reviewLogs[0]! as unknown as Record<string, unknown>)[field] = replacement;
  storeRecords(value, "reviewLogs")[0]![field] = replacement;
}

function visibleRecord(after: Snapshot): Record<string, unknown> {
  return after.visible as Record<string, unknown>;
}

function storeRecords(after: Snapshot, name: string): Array<Record<string, unknown>> {
  return (after.durable.stores as unknown as Record<string, Array<Record<string, unknown>>>)[name]!;
}

function invalidMutationEvidence(
  mutate: SnapshotMutation,
  label: "missing" | "malformed" = "missing",
): AdversarialJourneyEvidence {
  const subject = evidence();
  const before = snapshot({ side: "back", logs: 2, completed: 2, planned: 22, visibleCurrent: 2 });
  const after = structuredClone(before);
  after.durable.capturedAt += 1;
  mutate(after);
  const attempt = subject.validation.invalid.find((candidate) => candidate.label === label)!;
  attempt.before = before;
  attempt.after = after;
  return subject;
}

const rejectedCaseDetails = [
  ["stale", "stale-card-contract-failed"],
  ["premature", "answer-not-revealed-contract-failed"],
  ["collision", "duplicate-command-contract-failed"],
] as const;

function rejectedMutationEvidence(
  key: (typeof rejectedCaseDetails)[number][0],
  mutate: SnapshotMutation,
): AdversarialJourneyEvidence {
  const subject = evidence();
  const attemptBefore = snapshot({ side: "back", logs: 2, completed: 2, planned: 22, visibleCurrent: 2 });
  const after = structuredClone(attemptBefore);
  after.durable.capturedAt += 1;
  subject.validation[key].before = attemptBefore;
  subject.validation[key].after = after;
  mutate(after);
  return subject;
}

describe("production adversarial journey classification", () => {
  test("accepts the exact deployed duplicate-command collision envelope", () => {
    const subject = evidence();

    expect(subject.validation.collision.call.result).toEqual({
      ok: false,
      error: {
        code: "DUPLICATE_COMMAND",
        message: "The command_id was already used for a different study action.",
        recoverable: true,
        suggested_action: "Use a new command_id for a different action.",
      },
    });
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "passed",
      failureCode: null,
    });
  });

  test.each(rejectedCaseDetails)(
    "accepts the canonical 24-card seed graph without an import row for the %s case",
    (key) => {
      expect(assessAdversarialJourney(seedRejectedCaseEvidence(key))).toEqual({
        status: "passed",
        failureCode: null,
      });
    },
  );

  test.each(rejectedCaseDetails)(
    "rejects every case-local contract defect paired with the canonical seed graph for the %s case",
    (key, failureCode) => {
      const defects: Array<[
        string,
        (subject: AdversarialJourneyEvidence) => void,
        string,
      ]> = [
        ["case label", (subject) => {
          subject.validation[key].label = "borrowed";
        }, `case-label:${key}:mismatched`],
        ["tool acquisition", (subject) => {
          subject.validation[key].invocation.executeStarted = false;
        }, `intended-invocation:${key}`],
        ["response envelope", (subject) => {
          subject.validation[key].call = ok();
        }, `response-contract:${key}`],
        ["before snapshot", (subject) => {
          const before = subject.validation[key].before as Snapshot;
          storeRecords(before, "notes").pop();
        }, `snapshot:${key}:before-incomplete`],
        ["capture chronology", (subject) => {
          const attempt = subject.validation[key] as { before: Snapshot; after: Snapshot };
          attempt.after.durable.capturedAt = attempt.before.durable.capturedAt - 1;
        }, `capture-time:${key}:after-backward`],
        ["visible material state", (subject) => {
          (subject.validation[key].after as Snapshot).visible.pageText = "changed";
        }, `material-mutation:${key}`],
        ["durable material state", (subject) => {
          storeRecords(subject.validation[key].after as Snapshot, "meta")[1]!.value = true;
        }, `material-mutation:${key}`],
        ["another case response", (subject) => {
          const otherKey = key === "stale" ? "premature" : "stale";
          subject.validation[key].call = structuredClone(subject.validation[otherKey].call);
        }, `response-contract:${key}`],
      ];

      for (const [, corrupt, failureDetail] of defects) {
        const subject = seedRejectedCaseEvidence(key);
        corrupt(subject);
        expect(assessAdversarialJourney(subject)).toEqual({
          status: "failed",
          failureCode,
          failureDetail,
        });
      }
    },
  );

  test.each(rejectedCaseDetails)(
    "rejects every canonical-seed ownership spoof for the %s case",
    (key, failureCode) => {
    const corruptions: Array<[string, SnapshotMutation]> = [
      ["missing installed marker", (value) => {
        storeRecords(value, "meta").splice(2, 1);
      }],
      ["missing version marker", (value) => {
        storeRecords(value, "meta").splice(3, 1);
      }],
      ["false installed marker", (value) => {
        storeRecords(value, "meta")[2]!.value = false;
      }],
      ["null installed marker", (value) => {
        storeRecords(value, "meta")[2]!.value = null;
      }],
      ["wrong marker type", (value) => {
        storeRecords(value, "meta")[3]!.value = "3";
      }],
      ["unsupported version", (value) => {
        storeRecords(value, "meta")[3]!.value = 2;
      }],
      ["similar deck id", (value) => {
        storeRecords(value, "decks")[0]!.id = "seed-spanish-basics-copy";
      }],
      ["wrong canonical deck name", (value) => {
        storeRecords(value, "decks")[0]!.name = "Spanish Basics copy";
      }],
      ["arbitrary seed import id", (value) => {
        storeRecords(value, "decks")[0]!.importId = "seed-copy";
      }],
      ["noncanonical note id", (value) => {
        storeRecords(value, "notes")[0]!.id = "seed-spanish-basics-note-copy";
      }],
      ["seed card attached to another deck", (value) => {
        storeRecords(value, "cards")[0]!.deckId = "other-deck";
      }],
      ["noncanonical card content", (value) => {
        storeRecords(value, "cards")[0]!.frontText = "spoof";
      }],
    ];
    for (const [, corrupt] of corruptions) {
      const subject = seedRejectedCaseEvidence(key);
      const attempt = subject.validation[key] as { before: Snapshot };
      corrupt(attempt.before);
      expect(assessAdversarialJourney(subject)).toEqual({
        status: "failed",
        failureCode,
        failureDetail: `snapshot:${key}:before-incomplete`,
      });
    }
    },
  );

  test.each(rejectedCaseDetails)("accepts exact imported-only ownership for the %s case", (key) => {
    expect(assessAdversarialJourney(rejectedCaseEvidenceFromSnapshot(key, snapshot()))).toEqual({
      status: "passed",
      failureCode: null,
    });
  });

  test.each(rejectedCaseDetails)("accepts independent seed and imported ownership for the %s case", (key) => {
    expect(assessAdversarialJourney(rejectedCaseEvidenceFromSnapshot(key, mixedOwnershipSnapshot()))).toEqual({
      status: "passed",
      failureCode: null,
    });
  });

  test.each(rejectedCaseDetails)(
    "rejects every missing, malformed, spoofed, and colliding import owner for the %s case",
    (key, failureCode) => {
    const corruptions: Array<[string, () => Snapshot]> = [
      ["deck import is absent", () => {
        const value = snapshot();
        storeRecords(value, "imports").pop();
        return value;
      }],
      ["note import is absent", () => {
        const value = snapshot();
        storeRecords(value, "notes")[0]!.importId = "missing-import";
        return value;
      }],
      ["media import is absent", () => {
        const value = snapshot();
        storeRecords(value, "media")[0]!.importId = "missing-import";
        return value;
      }],
      ["import is truncated", () => {
        const value = snapshot();
        delete storeRecords(value, "imports")[0]!.packageVersion;
        return value;
      }],
      ["import has a wrong field type", () => {
        const value = snapshot();
        storeRecords(value, "imports")[0]!.fileSize = "256";
        return value;
      }],
      ["seed-like ownership has no exact import", () => {
        const value = snapshot();
        storeRecords(value, "decks")[0]!.importId = "seed-copy";
        return value;
      }],
      ["an APKG import collides with the reserved seed owner", () => {
        const value = snapshot();
        const imported = storeRecords(value, "imports")[0]!;
        imported.id = "seed";
        storeRecords(value, "decks")[0]!.importId = "seed";
        storeRecords(value, "notes").at(-1)!.importId = "seed";
        storeRecords(value, "media")[0]!.importId = "seed";
        return value;
      }],
      ["a fabricated seed import collides with the canonical graph", () => {
        const value = canonicalSeedSnapshot();
        storeRecords(value, "imports").push({
          id: "seed", sha256: "50".repeat(32), fileName: "seed.apkg", fileSize: 128,
          packageVersion: "2", importedAt: dayStart - 2_000, warnings: [],
        });
        return value;
      }],
      ["an imported note is mixed into the canonical seed deck", () => {
        const value = mixedOwnershipSnapshot();
        storeRecords(value, "notes")[1]!.importId = "uploaded-import";
        return value;
      }],
      ["a seed note is mixed into an imported deck", () => {
        const value = snapshot();
        storeRecords(value, "notes")[0]!.importId = "seed";
        return value;
      }],
      ["a valid seed cannot mask an unrelated missing import", () => {
        const value = mixedOwnershipSnapshot();
        storeRecords(value, "imports").pop();
        return value;
      }],
    ];

    for (const [, corrupt] of corruptions) {
      const subject = rejectedCaseEvidenceFromSnapshot(key, corrupt());
      expect(assessAdversarialJourney(subject)).toEqual({
        status: "failed",
        failureCode,
        failureDetail: `snapshot:${key}:before-incomplete`,
      });
    }
    },
  );

  const relationshipSnapshots: Array<[string, () => Snapshot]> = [
    ["canonical seed-only", canonicalSeedSnapshot],
    ["imported-only", snapshot],
    ["mixed seed and imported", mixedOwnershipSnapshot],
  ];
  const downstreamRelationshipCorruptions: Array<[string, SnapshotMutation]> = [
    ["deck card count", (value) => {
      storeRecords(value, "decks").find((deck) => deck.id === deckId)!.cardCount = 0;
    }],
    ["card deck relationship", (value) => {
      storeRecords(value, "cards")[0]!.deckId = "missing-deck";
    }],
    ["card note relationship", (value) => {
      storeRecords(value, "cards")[0]!.noteId = "missing-note";
    }],
    ["schedule card relationship", (value) => {
      storeRecords(value, "schedules")[0]!.cardId = "missing-card";
    }],
    ["schedule deck relationship", (value) => {
      storeRecords(value, "schedules")[0]!.deckId = "missing-deck";
    }],
    ["session queue card relationship", (value) => {
      (storeRecords(value, "sessions")[0]!.queueEntries as Array<Record<string, unknown>>)[0]!.cardId =
        "missing-card";
    }],
    ["session queue order", (value) => {
      const queue = storeRecords(value, "sessions")[0]!.queueEntries as Array<Record<string, unknown>>;
      queue[1]!.ordinal = queue[0]!.ordinal;
    }],
    ["session active-card relationship", (value) => {
      storeRecords(value, "sessions")[0]!.activeCardId = "missing-card";
    }],
    ["selected card projection", (value) => {
      value.durable.card = structuredClone(value.durable.cards[1]!);
    }],
    ["selected schedule projection", (value) => {
      value.durable.schedule = structuredClone(value.durable.schedules[1]!);
    }],
    ["selected cards projection", (value) => {
      value.durable.cards = value.durable.cards.slice(1);
    }],
    ["duplicate card primary key", (value) => {
      storeRecords(value, "cards").splice(1, 0, structuredClone(storeRecords(value, "cards")[0]!));
    }],
    ["noncanonical card order", (value) => {
      storeRecords(value, "cards").reverse();
    }],
    ["malformed media reference", (value) => {
      storeRecords(value, "cards")[0]!.mediaRefs = ["not-a-production-media-reference"];
    }],
  ];

  test.each(relationshipSnapshots)(
    "retains downstream relationship and projection checks for the %s graph",
    (_graph, makeSnapshot) => {
      for (const [key, failureCode] of rejectedCaseDetails) {
        for (const [, corrupt] of downstreamRelationshipCorruptions) {
          const subject = rejectedCaseEvidenceFromSnapshot(key, makeSnapshot());
          const attempt = subject.validation[key] as { before: Snapshot; after: Snapshot };
          corrupt(attempt.before);
          corrupt(attempt.after);

          expect(assessAdversarialJourney(subject)).toEqual({
            status: "failed",
            failureCode,
            failureDetail: `snapshot:${key}:before-incomplete`,
          });
        }
      }
    },
  );

  test.each(relationshipSnapshots)(
    "accepts a fully related review log in the %s graph",
    (_graph, makeSnapshot) => {
      expect(assessAdversarialJourney(rejectedCaseEvidenceFromSnapshot(
        "stale",
        snapshotWithReviewLog(makeSnapshot),
      ))).toEqual({ status: "passed", failureCode: null });
    },
  );

  test.each(relationshipSnapshots)(
    "retains review-log identity and transition checks for the %s graph",
    (_graph, makeSnapshot) => {
      const corruptions: Array<[string, SnapshotMutation]> = [
        ["missing session", (value) => { setReviewLogField(value, "sessionId", "missing-session"); }],
        ["wrong deck", (value) => { setReviewLogField(value, "deckId", "missing-deck"); }],
        ["missing card", (value) => { setReviewLogField(value, "cardId", "missing-card"); }],
        ["invalid rating", (value) => { setReviewLogField(value, "rating", "invalid"); }],
        ["invalid scheduler transition", (value) => {
          (value.durable.reviewLogs[0]!.after as Record<string, unknown>).state = "invalid";
          (storeRecords(value, "reviewLogs")[0]!.after as Record<string, unknown>).state = "invalid";
        }],
        ["duplicate command identity", (value) => {
          const duplicate = structuredClone(storeRecords(value, "reviewLogs")[0]!);
          duplicate.id = "relationship-log-copy";
          storeRecords(value, "reviewLogs").push(duplicate);
          value.durable.reviewLogs.push(structuredClone(duplicate) as typeof value.durable.reviewLogs[number]);
        }],
      ];
      for (const [, corrupt] of corruptions) {
        const subject = rejectedCaseEvidenceFromSnapshot("stale", snapshotWithReviewLog(makeSnapshot));
        const attempt = subject.validation.stale as { before: Snapshot; after: Snapshot };
        corrupt(attempt.before);
        corrupt(attempt.after);

        expect(assessAdversarialJourney(subject)).toEqual({
          status: "failed",
          failureCode: "stale-card-contract-failed",
          failureDetail: "snapshot:stale:before-incomplete",
        });
      }
    },
  );

  test.each([
    ["imported-only", snapshot],
    ["mixed seed and imported", mediaRichMixedOwnershipSnapshot],
  ] as Array<[string, () => Snapshot]>)(
    "retains media metadata, digest, bytes, and composite-key checks for the %s graph",
    (_graph, makeSnapshot) => {
      const corruptions: Array<[string, SnapshotMutation]> = [
        ["media MIME metadata", (value) => {
          storeRecords(value, "media")[0]!.mimeType = "audio/ogg";
        }],
        ["media byte length", (value) => {
          storeRecords(value, "media")[0]!.byteLength = 1;
        }],
        ["media digest and bytes", (value) => {
          storeRecords(value, "media")[0]!.sha256 = "03".repeat(32);
        }],
        ["duplicate media composite key", (value) => {
          storeRecords(value, "media").splice(1, 0, structuredClone(storeRecords(value, "media")[0]!));
        }],
        ["noncanonical media order", (value) => {
          storeRecords(value, "media").reverse();
        }],
      ];
      for (const [, corrupt] of corruptions) {
        const subject = rejectedCaseEvidenceFromSnapshot("stale", makeSnapshot());
        const attempt = subject.validation.stale as { before: Snapshot; after: Snapshot };
        corrupt(attempt.before);
        corrupt(attempt.after);

        expect(assessAdversarialJourney(subject)).toEqual({
          status: "failed",
          failureCode: "stale-card-contract-failed",
          failureDetail: "snapshot:stale:before-incomplete",
        });
      }
    },
  );

  test("requires a media reference to resolve within its card deck's ownership", () => {
    const imported = snapshot();
    const reference = "seed-import/media/sound.mp3";
    (imported.durable.card as unknown as Record<string, unknown>).mediaRefs = [reference];
    (imported.durable.cards[0]! as unknown as Record<string, unknown>).mediaRefs = [reference];
    storeRecords(imported, "cards")[0]!.mediaRefs = [reference];
    expect(assessAdversarialJourney(rejectedCaseEvidenceFromSnapshot("stale", imported))).toEqual({
      status: "passed",
      failureCode: null,
    });

    const mixed = mixedOwnershipSnapshot();
    const crossOwnedReference = "uploaded-import/media/image.png";
    (mixed.durable.card as unknown as Record<string, unknown>).mediaRefs = [crossOwnedReference];
    (mixed.durable.cards[0]! as unknown as Record<string, unknown>).mediaRefs = [crossOwnedReference];
    storeRecords(mixed, "cards")[0]!.mediaRefs = [crossOwnedReference];
    expect(assessAdversarialJourney(rejectedCaseEvidenceFromSnapshot("stale", mixed))).toEqual({
      status: "failed",
      failureCode: "stale-card-contract-failed",
      failureDetail: "snapshot:stale:before-incomplete",
    });
  });

  test("accepts classified immutable failures and one-effect races", () => {
    const subject = evidence();
    expect(subject.validation.invalid[1]?.call).toEqual(nativeMalformedRejected());
    const after = subject.races.find((item) => item.kind === "review")!.after;
    expect(after.visible).toMatchObject({ progressCurrent: 0, progressTotal: 20 });
    expect(after.durable).toMatchObject({
      session: { completedPresentationCount: 1, plannedPresentationCount: 21 },
    });
    expect(assessAdversarialJourney(subject)).toEqual({ status: "passed", failureCode: null });
  });

  test.each(rejectedCaseDetails)("validates both complete snapshots owned by the %s case", (key, failureCode) => {
    for (const side of ["before", "after"] as const) {
      const subject = evidence();
      const attempt = subject.validation[key];
      const selected = attempt[side] as Snapshot;
      delete (selected.durable.stores as unknown as Record<string, unknown>).notes;

      expect(assessAdversarialJourney(subject)).toEqual({
        status: "failed",
        failureCode,
        failureDetail: `snapshot:${key}:${side}-incomplete`,
      });
    }
  });

  test("fails at the first rejected case when complete case evidence is swapped", () => {
    const subject = evidence();
    const stale = subject.validation.stale;
    subject.validation.stale = subject.validation.premature;
    subject.validation.premature = stale;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "stale-card-contract-failed",
      failureDetail: "case-label:stale:mismatched",
    });
  });

  test("does not let later complete evidence mask an earlier malformed rejected snapshot", () => {
    const subject = evidence();
    const media = storeRecords(subject.validation.stale.before as Snapshot, "media")[0]!;
    (media.blob as Record<string, unknown>).bytesSha256 = "truncated";

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "stale-card-contract-failed",
      failureDetail: "snapshot:stale:before-incomplete",
    });
  });

  test.each(rejectedCaseDetails)(
    "rejects independently identical malformed relationships and ordering for the %s case",
    (key, failureCode) => {
      const corruptions: Array<[string, SnapshotMutation]> = [
        ["selected record/store membership", (value) => {
          value.durable.card = structuredClone(value.durable.cards[1]!);
        }],
        ["cross-record reference", (value) => {
          value.durable.card.noteId = "other-note";
          value.durable.cards[0]!.noteId = "other-note";
          storeRecords(value, "cards")[0]!.noteId = "other-note";
        }],
        ["canonical ordering", (value) => {
          value.durable.cards.reverse();
          storeRecords(value, "cards").reverse();
        }],
        ["media digest/bytes agreement", (value) => {
          storeRecords(value, "media")[0]!.sha256 = "03".repeat(32);
        }],
      ];
      for (const [, corrupt] of corruptions) {
        const subject = evidence();
        const attempt = subject.validation[key] as { before: Snapshot; after: Snapshot };
        corrupt(attempt.before);
        corrupt(attempt.after);

        expect(assessAdversarialJourney(subject)).toEqual({
          status: "failed",
          failureCode,
          failureDetail: `snapshot:${key}:before-incomplete`,
        });
      }
    },
  );

  test.each(rejectedCaseDetails)(
    "attributes independently malformed after evidence to the %s case and side",
    (key, failureCode) => {
      const subject = evidence();
      const attempt = subject.validation[key] as { after: Snapshot };
      attempt.after.durable.card = structuredClone(attempt.after.durable.cards[1]!);

      expect(assessAdversarialJourney(subject)).toEqual({
        status: "failed",
        failureCode,
        failureDetail: `snapshot:${key}:after-incomplete`,
      });
    },
  );

  test.each(rejectedCaseDetails)(
    "requires the exact complete application rejection for the %s case",
    (key, failureCode) => {
      const corruptions: Array<[string, (result: Record<string, unknown>) => void]> = [
        ["empty envelope", (result) => { Object.keys(result).forEach((field) => delete result[field]); }],
        ["wrong ok discriminator", (result) => { result.ok = true; }],
        ["extra success data", (result) => { result.data = {}; }],
        ["missing error", (result) => { delete result.error; }],
        ["wrong code", (result) => { (result.error as Record<string, unknown>).code = "INVALID_INPUT"; }],
        ["wrong message", (result) => { (result.error as Record<string, unknown>).message = "Wrong"; }],
        ["wrong recoverability", (result) => { (result.error as Record<string, unknown>).recoverable = false; }],
        ["missing recovery", (result) => { delete (result.error as Record<string, unknown>).suggested_action; }],
        ["extra error field", (result) => { (result.error as Record<string, unknown>).detail = "extra"; }],
      ];
      for (const [, corrupt] of corruptions) {
        const subject = evidence();
        const result = subject.validation[key].call.result as Record<string, unknown>;
        corrupt(result);
        expect(assessAdversarialJourney(subject)).toEqual({
          status: "failed",
          failureCode,
          failureDetail: `response-contract:${key}`,
        });
      }
    },
  );

  test.each(rejectedCaseDetails)(
    "rejects null, malformed, and contradictory transport payloads for the %s case",
    (key, failureCode) => {
      for (const result of [null, "not-json", [], { ok: false, error: null }]) {
        const subject = evidence();
        subject.validation[key].call = { status: "passed", result, error: null };
        expect(assessAdversarialJourney(subject)).toEqual({
          status: "failed",
          failureCode,
          failureDetail: `response-contract:${key}`,
        });
      }
      const transportContradiction = evidence();
      transportContradiction.validation[key].call.error = "Error: transport also failed";
      expect(assessAdversarialJourney(transportContradiction)).toEqual({
        status: "failed",
        failureCode,
        failureDetail: `response-contract:${key}`,
      });
    },
  );

  test.each(rejectedCaseDetails)(
    "rejects non-application invocation outcomes for the %s case",
    (key, failureCode) => {
      const subject = evidence();
      subject.validation[key].call = {
        status: "failed",
        result: null,
        error: "Error: lifecycle interrupted",
      };

      expect(assessAdversarialJourney(subject)).toEqual({
        status: "failed",
        failureCode,
        failureDetail: `response-contract:${key}`,
      });
    },
  );

  test.each(rejectedCaseDetails)(
    "requires current intended tool acquisition for the %s case",
    (key, failureCode) => {
      const corruptions: Array<(subject: AdversarialJourneyEvidence) => void> = [
        (subject) => { subject.validation[key].invocation.source = "stale-registration"; },
        (subject) => { subject.validation[key].invocation.acquiredToolName = null; },
        (subject) => { subject.validation[key].invocation.intendedToolName = "go_home"; },
        (subject) => { subject.validation[key].invocation.acquiredToolName = "go_home"; },
        (subject) => { subject.validation[key].invocation.executeStarted = false; },
        (subject) => { subject.validation[key].invocation.availableToolNames.pop(); },
      ];
      for (const corrupt of corruptions) {
        const subject = evidence();
        corrupt(subject);
        expect(assessAdversarialJourney(subject)).toEqual({
          status: "failed",
          failureCode,
          failureDetail: `intended-invocation:${key}`,
        });
      }
    },
  );

  test("does not allow complete envelopes to be borrowed across rejected cases", () => {
    const subject = evidence();
    subject.validation.stale.call = structuredClone(subject.validation.premature.call);
    subject.validation.premature.call = structuredClone(subject.validation.collision.call);

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "stale-card-contract-failed",
      failureDetail: "response-contract:stale",
    });
  });

  test("reports rejected-case prerequisites in deterministic order", () => {
    const subject = evidence();
    const stale = subject.validation.stale;
    stale.label = "borrowed";
    stale.invocation.executeStarted = false;
    stale.call = ok();
    delete (stale.before.durable as { capturedAt?: number }).capturedAt;
    stale.after.visible = { changed: true };

    expect(assessAdversarialJourney(subject).failureDetail).toBe("case-label:stale:mismatched");
    stale.label = "wrong-card";
    expect(assessAdversarialJourney(subject).failureDetail).toBe("intended-invocation:stale");
    stale.invocation.executeStarted = true;
    expect(assessAdversarialJourney(subject).failureDetail).toBe("response-contract:stale");
    stale.call = rejected("STALE_CARD");
    expect(assessAdversarialJourney(subject).failureDetail).toBe("snapshot:stale:after-incomplete");
  });

  test("accepts advancing capture metadata without mutating the observed snapshots", () => {
    const subject = evidence();
    const beforeAssessment = structuredClone(subject.validation);

    expect(subject.validation.invalid.map((attempt) =>
      (attempt.after as ReturnType<typeof snapshot>).durable.capturedAt
    ))
      .toEqual([capturedAt + 1, capturedAt + 3, capturedAt + 5, capturedAt + 7]);
    expect(assessAdversarialJourney(subject)).toEqual({ status: "passed", failureCode: null });
    expect(subject.validation).toEqual(beforeAssessment);
  });

  test.each(rejectedCaseDetails)(
    "accepts advancing and equal capture metadata for the %s rejection without mutating evidence",
    (key) => {
      const advancing = evidence();
      const beforeAssessment = structuredClone(advancing.validation[key]);
      const advancingAttempt = advancing.validation[key] as { before: Snapshot; after: Snapshot };
      expect(advancingAttempt.after.durable.capturedAt)
        .toBe(advancingAttempt.before.durable.capturedAt + 1);
      expect(assessAdversarialJourney(advancing)).toEqual({ status: "passed", failureCode: null });
      expect(advancing.validation[key]).toEqual(beforeAssessment);

      const equalTime = evidence();
      const equalAttempt = equalTime.validation[key] as { before: Snapshot; after: Snapshot };
      equalAttempt.after.durable.capturedAt = equalAttempt.before.durable.capturedAt;
      expect(assessAdversarialJourney(equalTime)).toEqual({ status: "passed", failureCode: null });
    },
  );

  test.each(rejectedCaseDetails)(
    "rejects every invalid capture representation on both sides of the %s rejection",
    (key, failureCode) => {
      for (const side of ["before", "after"] as const) {
        for (const [, invalidTime] of invalidCaptureTimes) {
          const subject = evidence();
          const durable = subject.validation[key][side].durable as Record<string, unknown>;
          if (invalidTime === undefined) delete durable.capturedAt;
          else durable.capturedAt = invalidTime;

          expect(assessAdversarialJourney(subject)).toEqual({
            status: "failed",
            failureCode,
            failureDetail: `capture-time:${key}:${side}-invalid`,
          });
        }
      }
    },
  );

  test.each(rejectedCaseDetails)("rejects backward capture time for the %s rejection", (key, failureCode) => {
    const subject = evidence();
    const attempt = subject.validation[key] as { before: Snapshot; after: Snapshot };
    attempt.after.durable.capturedAt = attempt.before.durable.capturedAt - 1;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode,
      failureDetail: `capture-time:${key}:after-backward`,
    });
  });

  test.each(invalidCaptureTimes)("fails closed for an invalid %s after capture time", (_case, invalidTime) => {
    const subject = evidence();
    const durable = subject.validation.invalid[0]!.after.durable as Record<string, unknown>;
    if (invalidTime === undefined) delete durable.capturedAt;
    else durable.capturedAt = invalidTime;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "capture-time:missing:after-invalid",
    });
  });

  test.each(invalidCaptureTimes)("fails closed for an invalid %s before capture time", (_case, invalidTime) => {
    const subject = evidence();
    const durable = subject.validation.invalid[0]!.before.durable as Record<string, unknown>;
    if (invalidTime === undefined) delete durable.capturedAt;
    else durable.capturedAt = invalidTime;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "capture-time:missing:before-invalid",
    });
  });

  test.each(invalidCaptureTimes)("fails closed for an invalid malformed %s after capture time", (_case, invalidTime) => {
    const subject = evidence();
    const durable = subject.validation.invalid[1]!.after.durable as Record<string, unknown>;
    if (invalidTime === undefined) delete durable.capturedAt;
    else durable.capturedAt = invalidTime;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "capture-time:malformed:after-invalid",
    });
  });

  test.each(invalidCaptureTimes)("fails closed for an invalid malformed %s before capture time", (_case, invalidTime) => {
    const subject = evidence();
    const durable = subject.validation.invalid[1]!.before.durable as Record<string, unknown>;
    if (invalidTime === undefined) delete durable.capturedAt;
    else durable.capturedAt = invalidTime;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "capture-time:malformed:before-invalid",
    });
  });

  test.each([
    ["required notes family absent", (value: ReturnType<typeof snapshot>) => {
      delete (value.durable.stores as unknown as Record<string, unknown>).notes;
    }],
    ["required media family malformed", (value: ReturnType<typeof snapshot>) => {
      (value.durable.stores as unknown as Record<string, unknown>).media = {};
    }],
    ["same malformed media digest is present", (value: ReturnType<typeof snapshot>) => {
      (value.durable.stores.media[0] as Record<string, unknown>).blob = null;
    }],
  ] as Array<[string, (value: ReturnType<typeof snapshot>) => void]>)(
    "fails closed when both malformed snapshots have the %s",
    (_case, mutate) => {
      const subject = evidence();
      const attempt = subject.validation.invalid[1]!;
      mutate(attempt.before as ReturnType<typeof snapshot>);
      mutate(attempt.after as ReturnType<typeof snapshot>);

      expect(assessAdversarialJourney(subject)).toEqual({
        status: "failed",
        failureCode: "invalid-input-contract-failed",
        failureDetail: "capture-time:malformed:before-invalid",
      });
    },
  );

  test("rejects backward capture time but permits equal capture time", () => {
    const backward = evidence();
    (backward.validation.invalid[0]!.after.durable as Record<string, unknown>).capturedAt = capturedAt - 1;
    expect(assessAdversarialJourney(backward)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "capture-time:missing:after-backward",
    });

    const equalTime = evidence();
    (equalTime.validation.invalid[0]!.after.durable as Record<string, unknown>).capturedAt = capturedAt;
    expect(assessAdversarialJourney(equalTime)).toEqual({ status: "passed", failureCode: null });
  });

  test.each([
    ["persisted timestamp", (after: ReturnType<typeof snapshot>) => {
      after.durable.session.updatedAt += 1;
      after.durable.sessions[0] = after.durable.session;
    }],
    ["nested capturedAt", (after: ReturnType<typeof snapshot>) => {
      (after.durable.cards[0] as Record<string, unknown>).capturedAt = capturedAt + 1;
    }],
    ["visible capturedAt", (after: ReturnType<typeof snapshot>) => {
      (after.visible as Record<string, unknown>).capturedAt = capturedAt + 1;
    }],
  ])("keeps %s material when top-level capture time advances", (_case, mutate) => {
    const subject = evidence();
    const after = subject.validation.invalid[0]!.after as ReturnType<typeof snapshot>;
    mutate(after);

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "material-mutation:missing",
    });
  });

  const materialMutationCases: Array<[string, SnapshotMutation]> = [
    ["visible card identity", (after) => { visibleRecord(after).cardId = "card-2"; }],
    ["visible route", (after) => { visibleRecord(after).route = "deck-home"; }],
    ["visible side", (after) => { visibleRecord(after).side = "front"; }],
    ["visible answer detail", (after) => { visibleRecord(after).sideDetail = "answer"; }],
    ["visible content", (after) => { visibleRecord(after).content = "changed"; }],
    ["visible current progress", (after) => { visibleRecord(after).progressCurrent = 3; }],
    ["visible total progress", (after) => { visibleRecord(after).progressTotal = 21; }],
    ["visible loading state", (after) => { visibleRecord(after).state = "loading"; }],
    ["visible empty state", (after) => { visibleRecord(after).state = "caught-up"; }],
    ["visible error state", (after) => { visibleRecord(after).state = "error"; }],
    ["visible success state", (after) => { visibleRecord(after).state = "completion"; }],
    ["visible busy state", (after) => { visibleRecord(after).busy = "true"; }],
    ["visible page message", (after) => { visibleRecord(after).pageText = "changed"; }],
    ["visible state message", (after) => { visibleRecord(after).stateText = "changed"; }],
    ["visible status message", (after) => { visibleRecord(after).statusMessages = ["changed"]; }],
    ["visible alert message", (after) => { visibleRecord(after).alertMessages = ["changed"]; }],
    ["visible field addition", (after) => { visibleRecord(after).announcement = "changed"; }],
    ["visible nested capture metadata", (after) => { visibleRecord(after).capturedAt = capturedAt + 1; }],
    ["selected session identity", (after) => { after.durable.session.id = "session-2"; }],
    ["selected session status", (after) => { after.durable.session.status = "completed"; }],
    ["selected active card", (after) => { after.durable.session.activeCardId = "card-2"; }],
    ["selected queue removal", (after) => { after.durable.session.queueEntries.pop(); }],
    ["selected queue addition", (after) => {
      after.durable.session.queueEntries.push({ cardId: "card-added", dueAt: dayStart, ordinal: 99 });
    }],
    ["selected queue order", (after) => { after.durable.session.queueEntries.reverse(); }],
    ["selected session progress", (after) => { after.durable.session.completedPresentationCount += 1; }],
    ["selected session persisted timestamp", (after) => { after.durable.session.updatedAt += 1; }],
    ["session addition", (after) => { after.durable.sessions.push(structuredClone(after.durable.session)); }],
    ["session removal", (after) => { after.durable.sessions.pop(); }],
    ["current card content", (after) => { after.durable.cards[0]!.frontHtml = "changed"; }],
    ["non-current card content", (after) => { after.durable.cards[1]!.backHtml = "changed"; }],
    ["card addition", (after) => { after.durable.cards.push({ ...after.durable.cards[0]!, id: "card-added" }); }],
    ["card removal", (after) => { after.durable.cards.pop(); }],
    ["card order", (after) => { after.durable.cards.reverse(); }],
    ["card nested capture metadata", (after) => {
      (after.durable.cards[0] as Record<string, unknown>).capturedAt = capturedAt + 1;
    }],
    ["deck content", (after) => { after.durable.decks[0]!.name = "Changed"; }],
    ["deck addition", (after) => { after.durable.decks.push({ ...after.durable.decks[0]!, id: "deck-added" }); }],
    ["deck removal", (after) => { after.durable.decks.pop(); }],
    ["deck store order", (after) => { storeRecords(after, "decks").reverse(); }],
    ["schedule due", (after) => { after.durable.schedules[0]!.dueAt += 1; }],
    ["schedule interval", (after) => { after.durable.schedules[0]!.intervalDays += 1; }],
    ["schedule ease", (after) => { after.durable.schedules[0]!.easeFactor += 0.1; }],
    ["schedule state", (after) => { after.durable.schedules[0]!.state = "review"; }],
    ["schedule review time", (after) => { after.durable.schedules[0]!.lastReviewAt = capturedAt; }],
    ["schedule suspension", (after) => { after.durable.schedules[0]!.suspended = true; }],
    ["non-current schedule", (after) => { after.durable.schedules[1]!.dueAt += 1; }],
    ["schedule addition", (after) => {
      after.durable.schedules.push({ ...after.durable.schedules[0]!, cardId: "card-added" });
    }],
    ["schedule removal", (after) => { after.durable.schedules.pop(); }],
    ["schedule order", (after) => { after.durable.schedules.reverse(); }],
    ["review-log addition", (after) => {
      after.durable.reviewLogs.push({ ...after.durable.reviewLogs[0]!, id: "log-added" });
    }],
    ["review-log removal", (after) => { after.durable.reviewLogs.pop(); }],
    ["review-log content", (after) => { after.durable.reviewLogs[0]!.rating = "hard"; }],
    ["review-log nested timestamp", (after) => { after.durable.reviewLogs[0]!.after.lastReviewAt! += 1; }],
    ["review-log order", (after) => { after.durable.reviewLogs.reverse(); }],
    ["meta identity", (after) => { storeRecords(after, "meta")[0]!.key = "changed"; }],
    ["meta addition", (after) => { storeRecords(after, "meta").push({ key: "added", value: true }); }],
    ["meta removal", (after) => { storeRecords(after, "meta").pop(); }],
    ["meta order", (after) => { storeRecords(after, "meta").reverse(); }],
    ["import content", (after) => { storeRecords(after, "imports")[0]!.filename = "changed.apkg"; }],
    ["import addition", (after) => {
      storeRecords(after, "imports").push({
        id: "added", sha256: "30".repeat(32), fileName: "added.apkg", fileSize: 1,
        packageVersion: "2", importedAt: dayStart, warnings: [],
      });
    }],
    ["import removal", (after) => { storeRecords(after, "imports").pop(); }],
    ["import order", (after) => { storeRecords(after, "imports").reverse(); }],
    ["note content", (after) => { storeRecords(after, "notes")[0]!.fields = { Front: "changed" }; }],
    ["note addition", (after) => {
      storeRecords(after, "notes").push({
        id: "added", importId: "seed-import", sourceNoteId: null, guid: null, modelId: null,
        fields: { Front: "added" }, tags: [],
      });
    }],
    ["note removal", (after) => { storeRecords(after, "notes").pop(); }],
    ["note order", (after) => { storeRecords(after, "notes").reverse(); }],
    ["same-size same-MIME media bytes", (after) => {
      const blob = storeRecords(after, "media")[0]!.blob as Record<string, unknown>;
      blob.bytesSha256 = "03".repeat(32);
    }],
    ["media identity", (after) => { storeRecords(after, "media")[0]!.name = "changed.mp3"; }],
    ["media metadata", (after) => {
      const media = storeRecords(after, "media")[0]!;
      media.mimeType = "audio/ogg";
      (media.blob as Record<string, unknown>).type = "audio/ogg";
    }],
    ["media digest", (after) => { storeRecords(after, "media")[0]!.sha256 = "03".repeat(32); }],
    ["media addition", (after) => {
      storeRecords(after, "media").push({
        importId: "seed-import",
        name: "added",
        mimeType: "application/octet-stream",
        byteLength: 0,
        sha256: "03".repeat(32),
        blob: { size: 0, type: "application/octet-stream", bytesSha256: "03".repeat(32) },
      });
    }],
    ["media removal", (after) => { storeRecords(after, "media").pop(); }],
    ["media order", (after) => { storeRecords(after, "media").reverse(); }],
  ];

  test.each(materialMutationCases)(
    "rejects %s even while capture time advances",
    (_case, mutate) => {
      const subject = invalidMutationEvidence(mutate);
      const attempt = subject.validation.invalid[0]!;
      expect((attempt.after.durable as { capturedAt: number }).capturedAt)
        .toBe((attempt.before.durable as { capturedAt: number }).capturedAt + 1);
      expect(assessAdversarialJourney(subject)).toEqual({
        status: "failed",
        failureCode: "invalid-input-contract-failed",
        failureDetail: "material-mutation:missing",
      });
    },
  );

  test.each(materialMutationCases)(
    "rejects native malformed evidence that changes %s",
    (_case, mutate) => {
      const subject = invalidMutationEvidence(mutate, "malformed");
      expect(assessAdversarialJourney(subject)).toEqual({
        status: "failed",
        failureCode: "invalid-input-contract-failed",
        failureDetail: "material-mutation:malformed",
      });
    },
  );

  test.each(rejectedCaseDetails)(
    "rejects every material mutation for the %s rejection while capture time advances",
    (key, failureCode) => {
      for (const [, mutate] of materialMutationCases) {
        const subject = rejectedMutationEvidence(key, mutate);
        const assessment = assessAdversarialJourney(subject);
        expect(assessment).toMatchObject({ status: "failed", failureCode });
        expect([
          `snapshot:${key}:after-incomplete`,
          `material-mutation:${key}`,
        ]).toContain(assessment.failureDetail ?? "");
      }
    },
  );

  test.each(rejectedCaseDetails)(
    "reports the %s evidence prerequisite before capture and material comparison",
    (key, failureCode) => {
      const subject = rejectedMutationEvidence(key, (after) => {
        after.durable.cards[0]!.frontHtml = "changed";
      });
      (subject.validation[key].after.durable as Record<string, unknown>).capturedAt = null;
      expect(assessAdversarialJourney(subject)).toEqual({
        status: "failed",
        failureCode,
        failureDetail: `snapshot:${key}:after-incomplete`,
      });
    },
  );

  test("keeps native prerequisite and capture failures ahead of matching-text material changes", () => {
    const inventoryFailure = invalidMutationEvidence(
      (after) => { after.durable.cards[0]!.frontHtml = "changed"; },
      "malformed",
    );
    inventoryFailure.validation.invalid[1]!.invocation.availableToolNames.pop();
    expect(assessAdversarialJourney(inventoryFailure).failureDetail)
      .toBe("native-inventory:malformed:missing-expected-tool");

    const captureFailure = invalidMutationEvidence(
      (after) => { after.durable.cards[0]!.frontHtml = "changed"; },
      "malformed",
    );
    (captureFailure.validation.invalid[1]!.before.durable as Record<string, unknown>).capturedAt = null;
    expect(assessAdversarialJourney(captureFailure).failureDetail)
      .toBe("capture-time:malformed:before-invalid");
  });

  test("does not relabel browser lifecycle errors as the native tool rejection", () => {
    const subject = evidence();
    subject.validation.browserErrors.push("UnknownError: Failed to parse input arguments");
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "adversarial-browser-errors",
    });
  });

  test("accepts an independently projected non-divergent cutoff boundary", () => {
    const subject = evidence();
    replaceReviewRace(subject, "review", snapshot({ side: "back" }), completedAtCutoff());
    replaceReviewRace(subject, "conflict", snapshot({ side: "back" }), completedAtCutoff());

    expect(assessAdversarialJourney(subject)).toEqual({ status: "passed", failureCode: null });
  });

  test.each([
    ["missing case", (subject: AdversarialJourneyEvidence) => subject.validation.invalid.pop()],
    ["duplicate case", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[3]!.label = "missing";
    }],
    ["reclassified payload", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[0]!.input = JSON.stringify({ card_id: cardId, command_id: "valid" });
    }],
  ])("rejects an invalid-input inventory with a %s", (_case, corrupt) => {
    const subject = evidence();
    corrupt(subject);
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "inventory:incomplete",
    });
  });

  test.each([
    ["absent-looking input", ""],
    ["quoted null", "\"null\""],
    ["whitespace-padded null", " null"],
    ["object", "{}"],
    ["array", "[]"],
    ["boolean", "false"],
    ["number", "0"],
  ])("rejects malformed case with %s", (_case, input) => {
    const subject = evidence();
    subject.validation.invalid[1]!.input = input;
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "inventory:incomplete",
    });
  });

  test.each([
    ["missing current registration", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[0]!.invocation.availableToolNames = ["get_state", "set_state", "suspend", "go_home"];
      subject.validation.invalid[0]!.invocation.acquiredToolName = null;
    }],
    ["wrong acquired tool", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[0]!.invocation.acquiredToolName = "set_state";
    }],
    ["pre-invocation rejection", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[0]!.invocation.executeStarted = false;
    }],
  ])("rejects %s instead of crediting INVALID_INPUT", (_case, corrupt) => {
    const subject = evidence();
    corrupt(subject);
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "intended-invocation:missing",
    });
  });

  test.each([
    ["incomplete route inventory", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[1]!.invocation.availableToolNames.pop();
    }, "native-inventory:malformed:missing-expected-tool"],
    ["duplicate route inventory", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[1]!.invocation.availableToolNames.push("flip");
    }, "native-inventory:malformed:duplicate-tool"],
    ["stale registration", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[1]!.invocation.source = "stale-registration";
    }, "native-acquisition:malformed:current-intended-tool-required"],
    ["missing acquired tool", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[1]!.invocation.acquiredToolName = null;
    }, "native-acquisition:malformed:current-intended-tool-required"],
    ["wrong intended tool", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[1]!.invocation.intendedToolName = "set_state";
    }, "native-acquisition:malformed:current-intended-tool-required"],
    ["wrong acquired tool", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[1]!.invocation.acquiredToolName = "set_state";
    }, "native-acquisition:malformed:current-intended-tool-required"],
    ["missing executeTool attempt", (subject: AdversarialJourneyEvidence) => {
      subject.validation.invalid[1]!.invocation.executeStarted = false;
    }, "native-attempt:malformed:execute-tool-not-started"],
  ])("rejects native malformed evidence with %s", (_case, corrupt, detail) => {
    const subject = evidence();
    corrupt(subject);
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: detail,
    });
  });

  test.each([
    ["passed status", { status: "passed" as const, result: null, error: "UnknownError: Failed to parse input arguments" }, "native-response:malformed:failed-with-null-result-required"],
    ["non-null result", { status: "failed" as const, result: {}, error: "UnknownError: Failed to parse input arguments" }, "native-response:malformed:failed-with-null-result-required"],
    ["structured INVALID_INPUT", invalidRejected(), "native-response:malformed:failed-with-null-result-required"],
    ["generic Invalid argument", { status: "failed" as const, result: null, error: "Invalid argument" }, "native-signature:malformed:unsupported-native-error"],
    ["arbitrary UnknownError", { status: "failed" as const, result: null, error: "UnknownError: database unavailable" }, "native-signature:malformed:unsupported-native-error"],
    ["broad-regex collision", { status: "failed" as const, result: null, error: "UnknownError: schema argument failed to parse input later" }, "native-signature:malformed:unsupported-native-error"],
    ["prefixed supported text", { status: "failed" as const, result: null, error: "NavigationError: UnknownError: Failed to parse input arguments" }, "native-signature:malformed:unsupported-native-error"],
    ["suffixed supported text", { status: "failed" as const, result: null, error: "UnknownError: Failed to parse input arguments during cleanup" }, "native-signature:malformed:unsupported-native-error"],
  ])("rejects native malformed %s", (_case, call, detail) => {
    const subject = evidence();
    subject.validation.invalid[1]!.call = call;
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: detail,
    });
  });

  test.each([
    ["success envelope", ok()],
    ["generic thrown error", { status: "failed" as const, result: null, error: "Invalid argument" }],
    ["wrong code", rejected("STALE_CARD")],
    ["malformed envelope", { status: "passed" as const, result: { error: { code: "INVALID_INPUT" } }, error: null }],
    ["contradictory data", {
      status: "passed" as const,
      result: { ...invalidRejected().result, data: {} },
      error: null,
    }],
  ])("rejects a %s with response-contract attribution", (_case, call) => {
    const subject = evidence();
    subject.validation.invalid[0]!.call = call;
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "response-contract:missing",
    });
  });

  test("requires a successful well-formed control through the current flip registration", () => {
    const failedCall = evidence();
    failedCall.validation.control.call = rejected("INVALID_INPUT");
    expect(assessAdversarialJourney(failedCall)).toEqual({
      status: "failed",
      failureCode: "invalid-input-contract-failed",
      failureDetail: "control:unusable",
    });

    const staleRegistration = evidence();
    staleRegistration.validation.control.invocation.executeStarted = false;
    expect(assessAdversarialJourney(staleRegistration).failureDetail).toBe("control:unusable");

    const invalidPayload = evidence();
    invalidPayload.validation.control.input = "{}";
    expect(assessAdversarialJourney(invalidPayload).failureDetail).toBe("control:unusable");
  });

  test("does not complete a unique card after its later same-day presentation", () => {
    const subject = evidence();
    const { before, after } = repeatedReviewBoundary();
    replaceReviewRace(subject, "review", before, after);

    expect(after.visible).toMatchObject({ progressCurrent: 0, progressTotal: 20 });
    expect(assessAdversarialJourney(subject)).toEqual({ status: "passed", failureCode: null });
  });

  test.each([
    ["missing cards", (value: ReturnType<typeof snapshot>) => { value.durable.cards = []; }],
    ["missing schedules", (value: ReturnType<typeof snapshot>) => { value.durable.schedules = []; }],
    ["duplicate queue membership", (value: ReturnType<typeof snapshot>) => {
      value.durable.session.queueEntries[1]!.cardId = cardId;
      value.durable.sessions[0] = value.durable.session;
    }],
    ["wrong deck identity", (value: ReturnType<typeof snapshot>) => {
      value.durable.session.deckId = "wrong-deck";
      value.durable.sessions[0] = value.durable.session;
    }],
    ["invalid cutoff", (value: ReturnType<typeof snapshot>) => {
      value.durable.session.nextDayAt += 24 * 60 * 60 * 1_000;
      value.durable.sessions[0] = value.durable.session;
    }],
    ["missing observation time", (value: ReturnType<typeof snapshot>) => {
      (value.durable as { capturedAt?: number }).capturedAt = undefined;
    }],
    ["stale observation time", (value: ReturnType<typeof snapshot>) => {
      value.durable.capturedAt = value.durable.session.updatedAt - 1;
    }],
    ["impossible review log", (value: ReturnType<typeof snapshot>) => {
      value.durable.reviewLogs[0]!.sessionId = "wrong-session";
    }],
  ])("fails closed through the public assessor for %s", (_name, mutate) => {
    const subject = evidence();
    const selected = subject.races.find((item) => item.kind === "review")!;
    mutate(selected.after as ReturnType<typeof snapshot>);
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "review-race-contract-failed",
    });
  });

  test("rejects generic invalid errors or mutation after rejection", () => {
    const generic = evidence();
    generic.validation.invalid[0]!.call = { status: "failed", result: null, error: "Error" };
    expect(assessAdversarialJourney(generic).failureCode).toBe("invalid-input-contract-failed");
    const mutated = evidence();
    mutated.validation.stale.after.visible = { changed: true };
    expect(assessAdversarialJourney(mutated).failureCode).toBe("stale-card-contract-failed");
  });

  test("rejects duplicate effects and illegal conflicting outcomes", () => {
    const duplicate = evidence();
    duplicate.races.find((item) => item.kind === "review")!.after = snapshot({ logs: 2, completed: 2 });
    expect(assessAdversarialJourney(duplicate).failureCode).toBe("review-race-contract-failed");
    const conflict = evidence();
    conflict.races.find((item) => item.kind === "conflict")!.calls = [ok(), ok()];
    expect(assessAdversarialJourney(conflict).failureCode).toBe("conflict-race-contract-failed");
  });

  test("rejects divergent same-command results", () => {
    const divergent = evidence();
    const review = divergent.races.find((item) => item.kind === "review")!;
    const changed = structuredClone(review.calls[1]!.result) as { data: { transition: { next_card_id: string } } };
    changed.data.transition.next_card_id = "wrong-card";
    review.calls[1]!.result = changed;
    expect(assessAdversarialJourney(divergent).failureCode).toBe("review-race-contract-failed");
  });

  test.each([
    ["before visible progress", (review: AdversarialRace) => {
      (review.before.visible as Record<string, unknown>).progressCurrent = 1;
    }],
    ["visible current progress", (review: AdversarialRace) => {
      (review.after.visible as Record<string, unknown>).progressCurrent = 1;
    }],
    ["visible total progress", (review: AdversarialRace) => {
      (review.after.visible as Record<string, unknown>).progressTotal = 21;
    }],
    ["returned tool completed progress", (review: AdversarialRace) => {
      const state = (review.calls[0]!.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
      state.session.completed_presentations = 0;
      review.calls[1] = structuredClone(review.calls[0]!);
    }],
    ["returned tool planned progress", (review: AdversarialRace) => {
      const state = (review.calls[0]!.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
      state.session.planned_presentations = 20;
      review.calls[1] = structuredClone(review.calls[0]!);
    }],
    ["durable completed progress", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.completedPresentationCount = 2;
      durable.sessions[0] = durable.session;
    }],
    ["durable planned progress", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.plannedPresentationCount = 20;
      durable.sessions[0] = durable.session;
    }],
    ["queue readiness", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.queueEntries[0]!.dueAt += 1;
      durable.sessions[0] = durable.session;
    }],
    ["logged schedule transition", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.reviewLogs[0]!.before.dueAt += 1;
    }],
    ["coherently copied stale transition time", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      const staleReviewAt = durable.reviewLogs[0]!.reviewedAt - 1;
      durable.schedule.lastReviewAt = staleReviewAt;
      durable.schedules[0] = durable.schedule;
      durable.reviewLogs[0]!.after.lastReviewAt = staleReviewAt;
    }],
    ["coherently copied extra repetition", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.schedule.reps += 1;
      durable.schedules[0] = durable.schedule;
      durable.reviewLogs[0]!.after.reps = durable.schedule.reps;
    }],
    ["unrelated queue removal with self-consistent counters", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.queueEntries = durable.session.queueEntries.filter((entry) => entry.cardId !== "card-20");
      durable.session.plannedPresentationCount -= 1;
      durable.sessions[0] = durable.session;
      (review.after.visible as Record<string, unknown>).progressTotal = 19;
      for (const call of review.calls) {
        const state = (call.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
        state.session.planned_presentations = durable.session.plannedPresentationCount;
      }
    }],
    ["missing persisted command binding", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.lastCommandIds = [];
      durable.sessions[0] = durable.session;
    }],
    ["snapshot observation time", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.capturedAt = durable.session.updatedAt - 1;
    }],
    ["unrelated card mutation", (review: AdversarialRace) => {
      const durable = review.after.durable as ReturnType<typeof snapshot>["durable"];
      (durable.cards[1] as Record<string, unknown>).unexpected = true;
    }],
  ])("rejects independently corrupted same-command %s", (_name, mutate) => {
    const subject = evidence();
    const review = subject.races.find((item) => item.kind === "review")!;
    mutate(review);
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "review-race-contract-failed",
    });
  });

  test("rejects alteration of earlier persisted command history on a later review", () => {
    const subject = evidence();
    const { before, after } = repeatedReviewBoundary();
    replaceReviewRace(subject, "review", before, after);
    after.durable.session.lastCommandIds[0] = "replaced-earlier-command";
    after.durable.sessions[0] = after.durable.session;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "review-race-contract-failed",
    });
  });

  test("rejects final visible state drift", () => {
    const drifted = evidence();
    const conflict = drifted.races.find((item) => item.kind === "conflict")!;
    (conflict.after.visible as Record<string, unknown>).cardId = "wrong-card";
    expect(assessAdversarialJourney(drifted).failureCode).toBe("conflict-race-contract-failed");
  });

  test.each([
    ["before visible current progress", (conflict: AdversarialRace) => {
      (conflict.before.visible as Record<string, unknown>).progressCurrent = 1;
    }],
    ["after visible current progress", (conflict: AdversarialRace) => {
      (conflict.after.visible as Record<string, unknown>).progressCurrent = 1;
    }],
    ["after visible total progress", (conflict: AdversarialRace) => {
      (conflict.after.visible as Record<string, unknown>).progressTotal = 21;
    }],
    ["winning tool completed progress", (conflict: AdversarialRace) => {
      const state = (conflict.calls[0]!.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
      state.session.completed_presentations = 0;
    }],
    ["winning tool planned progress", (conflict: AdversarialRace) => {
      const state = (conflict.calls[0]!.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
      state.session.planned_presentations = 20;
    }],
    ["durable completed progress", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.completedPresentationCount = 2;
      durable.sessions[0] = durable.session;
    }],
    ["durable planned progress", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.plannedPresentationCount = 20;
      durable.sessions[0] = durable.session;
    }],
    ["queue readiness", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.queueEntries[0]!.dueAt += 1;
      durable.sessions[0] = durable.session;
    }],
    ["review log transition", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.reviewLogs[0]!.before.dueAt += 1;
    }],
    ["coherently copied stale transition time", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      const staleReviewAt = durable.reviewLogs[0]!.reviewedAt - 1;
      durable.schedule.lastReviewAt = staleReviewAt;
      durable.schedules[0] = durable.schedule;
      durable.reviewLogs[0]!.after.lastReviewAt = staleReviewAt;
    }],
    ["coherently copied extra repetition", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.schedule.reps += 1;
      durable.schedules[0] = durable.schedule;
      durable.reviewLogs[0]!.after.reps = durable.schedule.reps;
    }],
    ["unrelated queue removal with self-consistent counters", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.queueEntries = durable.session.queueEntries.filter((entry) => entry.cardId !== "card-20");
      durable.session.plannedPresentationCount -= 1;
      durable.sessions[0] = durable.session;
      (conflict.after.visible as Record<string, unknown>).progressTotal = 19;
      for (const call of [conflict.calls[0]!, conflict.readCalls[1]!]) {
        const state = (call.result as { data: { state: { session: Record<string, unknown> } } }).data.state;
        state.session.planned_presentations = durable.session.plannedPresentationCount;
      }
    }],
    ["missing persisted command binding", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.session.lastCommandIds = [];
      durable.sessions[0] = durable.session;
    }],
    ["active card", (conflict: AdversarialRace) => {
      (conflict.after.visible as Record<string, unknown>).cardId = "wrong-card";
    }],
    ["snapshot observation time", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      durable.capturedAt = durable.session.updatedAt - 1;
    }],
    ["unrelated durable record", (conflict: AdversarialRace) => {
      const durable = conflict.after.durable as ReturnType<typeof snapshot>["durable"];
      (durable.cards[1] as Record<string, unknown>).unexpected = true;
    }],
  ])("rejects independently corrupted conflict %s", (_name, mutate) => {
    const subject = evidence();
    const conflict = subject.races.find((item) => item.kind === "conflict")!;
    mutate(conflict);
    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "conflict-race-contract-failed",
    });
  });

  test("rejects alteration of earlier persisted command history on a later conflict", () => {
    const subject = evidence();
    const { before, after } = repeatedReviewBoundary();
    replaceReviewRace(subject, "conflict", before, after);
    after.durable.session.lastCommandIds[0] = "replaced-earlier-command";
    after.durable.sessions[0] = after.durable.session;

    expect(assessAdversarialJourney(subject)).toEqual({
      status: "failed",
      failureCode: "conflict-race-contract-failed",
    });
  });

  test("rejects conflict winner identity, loser reason, and missing race reads", () => {
    const wrongWinner = evidence();
    const winner = wrongWinner.races.find((item) => item.kind === "conflict")!.calls[0]!;
    (winner.result as { data: { command_id: string } }).data.command_id = "race-review";
    expect(assessAdversarialJourney(wrongWinner).failureCode).toBe("conflict-race-contract-failed");

    const wrongReason = evidence();
    wrongReason.races.find((item) => item.kind === "conflict")!.calls[1] = rejected("DUPLICATE_COMMAND");
    expect(assessAdversarialJourney(wrongReason).failureCode).toBe("conflict-race-contract-failed");

    const skippedRead = evidence();
    skippedRead.races.find((item) => item.kind === "conflict")!.readCalls.pop();
    expect(assessAdversarialJourney(skippedRead).failureCode).toBe("conflict-race-contract-failed");
  });

  test("requires each committed race to advance to one authoritative front-side card", () => {
    for (const kind of ["review", "suspend", "conflict"] as const) {
      const wrongSide = evidence();
      const selected = wrongSide.races.find((item) => item.kind === kind)!;
      (selected.after.visible as Record<string, unknown>).side = "back";
      selected.after.durable = {
        ...(selected.after.durable as Record<string, unknown>),
        session: {
          ...((selected.after.durable as { session: Record<string, unknown> }).session),
          currentSide: "back",
        },
      };
      expect(assessAdversarialJourney(wrongSide).failureCode).toBe(`${kind}-race-contract-failed`);

      const copied = evidence();
      const copiedRace = copied.races.find((item) => item.kind === kind)!;
      (copiedRace.after.visible as Record<string, unknown>).sideDetail = "study-side-invalid:copied-front";
      expect(assessAdversarialJourney(copied).failureCode).toBe(`${kind}-race-contract-failed`);
    }
  });
});
