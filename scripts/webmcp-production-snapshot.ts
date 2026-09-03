import {
  SPANISH_BASICS_FIXTURE,
  SPANISH_BASICS_FIXTURE_VERSION,
} from "../lib/persistence/spanish-basics-fixture";

const SEED_IMPORT_ID = "seed";
const SEED_INSTALLED_META_KEY = "seedInstalled";
const SEED_VERSION_META_KEY = "seedVersion";
const SPANISH_BASICS_DECK_ID = "seed-spanish-basics";
const SPANISH_BASICS_DECK_NAME = "Spanish Basics";

const productionStoreNames = [
  "cards",
  "decks",
  "imports",
  "media",
  "meta",
  "notes",
  "reviewLogs",
  "schedules",
  "sessions",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function recordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((item) => record(item) !== null);
}

function string(value: unknown): boolean {
  return typeof value === "string";
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function epoch(value: unknown): boolean {
  return finiteNumber(value) && !Number.isNaN(new Date(value as number).getTime());
}

function nullableEpoch(value: unknown): boolean {
  return value === null || epoch(value);
}

function stringRecord(value: unknown): boolean {
  const candidate = record(value);
  return candidate !== null && Object.values(candidate).every(string);
}

function completeImportRecord(value: unknown): boolean {
  const item = record(value);
  return item !== null && nonEmptyString(item.id) && /^[0-9a-f]{64}$/.test(String(item.sha256)) &&
    nonEmptyString(item.fileName) && nonNegativeInteger(item.fileSize) &&
    nonEmptyString(item.packageVersion) && epoch(item.importedAt) && stringArray(item.warnings);
}

function completeDeckRecord(value: unknown): boolean {
  const item = record(value);
  return item !== null && nonEmptyString(item.id) && nonEmptyString(item.importId) &&
    stringOrNull(item.sourceDeckId) && nonEmptyString(item.name) &&
    nonNegativeInteger(item.cardCount) && epoch(item.createdAt) && nullableEpoch(item.lastStudiedAt) &&
    Number.isSafeInteger(item.sessionIntakeLimit) && Number(item.sessionIntakeLimit) > 0 &&
    nonEmptyString(item.schedulerConfigId);
}

function completeNoteRecord(value: unknown): boolean {
  const item = record(value);
  return item !== null && nonEmptyString(item.id) && nonEmptyString(item.importId) &&
    stringOrNull(item.sourceNoteId) && stringOrNull(item.guid) && stringOrNull(item.modelId) &&
    stringRecord(item.fields) && stringArray(item.tags);
}

function completeCardRecord(value: unknown): boolean {
  const item = record(value);
  return item !== null && nonEmptyString(item.id) && nonEmptyString(item.deckId) &&
    nonEmptyString(item.noteId) && stringOrNull(item.sourceCardId) &&
    nonNegativeInteger(item.templateOrdinal) && string(item.frontText) && string(item.backText) &&
    string(item.css) && string(item.frontHtml) && string(item.backHtml) &&
    stringArray(item.mediaRefs) && nonNegativeInteger(item.creationOrder) &&
    stringArray(item.contentWarnings) &&
    (item.answerText === undefined || string(item.answerText)) &&
    (item.answerHtml === undefined || string(item.answerHtml)) &&
    (item.backIncludesFront === undefined || typeof item.backIncludesFront === "boolean");
}

function completeScheduleSnapshot(value: unknown): boolean {
  const item = record(value);
  return item !== null && epoch(item.dueAt) && finiteNumber(item.stability) &&
    finiteNumber(item.difficulty) && nonNegativeInteger(item.elapsedDays) &&
    nonNegativeInteger(item.scheduledDays) && nonNegativeInteger(item.reps) &&
    nonNegativeInteger(item.lapses) && ["new", "learning", "review", "relearning"].includes(String(item.state)) &&
    nullableEpoch(item.lastReviewAt) && typeof item.suspended === "boolean" &&
    (item.learningSteps === undefined || nonNegativeInteger(item.learningSteps)) &&
    (item.legacyEaseFactor === undefined || item.legacyEaseFactor === null || finiteNumber(item.legacyEaseFactor));
}

function completeScheduleRecord(value: unknown): boolean {
  const item = record(value);
  return item !== null && nonEmptyString(item.cardId) && nonEmptyString(item.deckId) &&
    completeScheduleSnapshot(item);
}

function completeQueueEntry(value: unknown): boolean {
  const item = record(value);
  return item !== null && nonEmptyString(item.cardId) && epoch(item.dueAt) &&
    nonNegativeInteger(item.ordinal);
}

function completeSessionRecord(value: unknown): boolean {
  const item = record(value);
  const counts = record(item?.ratingCounts);
  return item !== null && nonEmptyString(item.id) && nonEmptyString(item.deckId) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(item.dayKey)) &&
    Number.isSafeInteger(item.sequence) && Number(item.sequence) > 0 &&
    Number.isSafeInteger(item.intakeLimit) && Number(item.intakeLimit) > 0 &&
    epoch(item.nextDayAt) && Array.isArray(item.queueEntries) && item.queueEntries.every(completeQueueEntry) &&
    stringOrNull(item.activeCardId) && nonNegativeInteger(item.plannedPresentationCount) &&
    nonNegativeInteger(item.completedPresentationCount) && ["front", "back"].includes(String(item.currentSide)) &&
    counts !== null && ["again", "hard", "good", "easy"].every((key) => nonNegativeInteger(counts[key])) &&
    epoch(item.startedAt) && epoch(item.updatedAt) && nullableEpoch(item.completedAt) &&
    stringArray(item.lastCommandIds);
}

function completeReviewLogRecord(value: unknown): boolean {
  const item = record(value);
  return item !== null && nonEmptyString(item.id) && nonEmptyString(item.sessionId) &&
    nonEmptyString(item.deckId) && nonEmptyString(item.cardId) &&
    ["again", "hard", "good", "easy"].includes(String(item.rating)) && epoch(item.reviewedAt) &&
    (item.durationMs === null || nonNegativeInteger(item.durationMs)) &&
    completeScheduleSnapshot(item.before) && completeScheduleSnapshot(item.after) &&
    (item.commandId === undefined || nonEmptyString(item.commandId));
}

function completeMetaRecord(value: unknown): boolean {
  const item = record(value);
  return item !== null && nonEmptyString(item.key) && Object.hasOwn(item, "value");
}

function completeMediaRecord(value: unknown): boolean {
  const media = record(value);
  const blob = record(media?.blob);
  return media !== null && nonEmptyString(media.importId) && nonEmptyString(media.name) &&
    nonEmptyString(media.mimeType) && nonNegativeInteger(media.byteLength) &&
    typeof media.sha256 === "string" && /^[0-9a-f]{64}$/.test(media.sha256) && blob !== null &&
    typeof blob.size === "number" && Number.isFinite(blob.size) && blob.size >= 0 &&
    blob.size === media.byteLength && blob.type === media.mimeType &&
    typeof blob.bytesSha256 === "string" && /^[0-9a-f]{64}$/.test(blob.bytesSha256);
}

function completeMediaObservation(value: unknown): boolean {
  const media = record(value);
  const blob = record(media?.blob);
  return blob !== null && finiteNumber(blob.size) && Number(blob.size) >= 0 &&
    string(blob.type) && typeof blob.bytesSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(blob.bytesSha256);
}

function completeStores(value: unknown, completeRecords: boolean): boolean {
  const stores = record(value);
  if (stores === null || !productionStoreNames.every((name) => recordArray(stores[name]))) return false;
  if (!completeRecords) {
    return (stores.media as Array<Record<string, unknown>>).every(completeMediaObservation);
  }
  const validators: Record<(typeof productionStoreNames)[number], (value: unknown) => boolean> = {
    cards: completeCardRecord,
    decks: completeDeckRecord,
    imports: completeImportRecord,
    media: completeMediaRecord,
    meta: completeMetaRecord,
    notes: completeNoteRecord,
    reviewLogs: completeReviewLogRecord,
    schedules: completeScheduleRecord,
    sessions: completeSessionRecord,
  };
  return productionStoreNames.every((name) =>
    (stores[name] as Array<Record<string, unknown>>).every(validators[name]));
}

function completeDurable(value: unknown, requireSelectedRecords: boolean): boolean {
  const durable = record(value);
  if (!requireSelectedRecords) {
    return durable !== null && recordArray(durable.decks) && recordArray(durable.cards) &&
      recordArray(durable.schedules) && recordArray(durable.sessions) &&
      recordArray(durable.reviewLogs) && completeStores(durable.stores, false);
  }
  if (!durable || !recordArray(durable.decks) || !durable.decks.every(completeDeckRecord) ||
      !recordArray(durable.cards) || !durable.cards.every(completeCardRecord) ||
      !recordArray(durable.schedules) || !durable.schedules.every(completeScheduleRecord) ||
      !recordArray(durable.sessions) || !durable.sessions.every(completeSessionRecord) ||
      !recordArray(durable.reviewLogs) || !durable.reviewLogs.every(completeReviewLogRecord) ||
      !completeStores(durable.stores, true)) {
    return false;
  }
  return !requireSelectedRecords ||
    (completeSessionRecord(durable.session) && completeCardRecord(durable.card) &&
      completeScheduleRecord(durable.schedule));
}

function completeHomeVisible(value: unknown): boolean {
  const visible = record(value);
  if (!visible || !Array.isArray(visible.decks) ||
      !["loading", "empty", "error", "populated"].includes(String(visible.state))) {
    return false;
  }
  return visible.decks.every((candidate) => {
    const deck = record(candidate);
    return deck !== null && stringOrNull(deck.id) && stringOrNull(deck.name) &&
      stringOrNull(deck.study_action) && typeof deck.recovery_available === "boolean" &&
      typeof deck.study_keyboard_operable === "boolean" &&
      [deck.card_count, deck.new_count, deck.due_count, deck.suspended_count]
        .every((count) => count === null || typeof count === "number");
  });
}

function completeStudyVisible(value: unknown): boolean {
  const visible = record(value);
  return visible !== null && typeof visible.route === "string" &&
    typeof visible.state === "string" && typeof visible.cardId === "string" &&
    typeof visible.side === "string" && stringOrNull(visible.sideDetail) &&
    stringOrNull(visible.content) && typeof visible.progressCurrent === "number" &&
    Number.isFinite(visible.progressCurrent) && typeof visible.progressTotal === "number" &&
    Number.isFinite(visible.progressTotal) && stringOrNull(visible.busy) &&
    stringOrNull(visible.pageText) && stringOrNull(visible.stateText) &&
    stringArray(visible.statusMessages) && stringArray(visible.alertMessages);
}

/** Validate that an assessor received both complete independent production views. */
export function completeProductionSnapshot(
  snapshot: unknown,
  route: "home" | "study",
): boolean {
  const value = record(snapshot);
  if (!value || !completeDurable(value.durable, route === "study")) return false;
  return route === "home"
    ? completeHomeVisible(value.visible)
    : completeStudyVisible(value.visible);
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unique(records: Array<Record<string, unknown>>, key: (item: Record<string, unknown>) => string): boolean {
  return new Set(records.map(key)).size === records.length;
}

function canonicallyOrdered(
  records: Array<Record<string, unknown>>,
  key: (item: Record<string, unknown>) => readonly string[],
): boolean {
  return records.every((item, index) => {
    if (index === 0) return true;
    const previous = key(records[index - 1]!);
    const current = key(item);
    for (let part = 0; part < Math.max(previous.length, current.length); part += 1) {
      if (previous[part] === current[part]) continue;
      return String(previous[part]) < String(current[part]);
    }
    return false;
  });
}

function keyedRecords(
  records: Array<Record<string, unknown>>,
  key: (item: Record<string, unknown>) => string,
): Map<string, Record<string, unknown>> | null {
  if (!unique(records, key)) return null;
  return new Map(records.map((item) => [key(item), item]));
}

function exactMember(
  value: unknown,
  records: Map<string, Record<string, unknown>>,
  key: string,
): boolean {
  const item = records.get(key);
  return item !== undefined && equal(value, item);
}

interface CanonicalSeedOwnership {
  readonly valid: boolean;
  readonly deckIds: ReadonlySet<string>;
  readonly noteIds: ReadonlySet<string>;
  readonly mediaKeys: ReadonlySet<string>;
}

const noCanonicalSeedOwnership: CanonicalSeedOwnership = {
  valid: true,
  deckIds: new Set(),
  noteIds: new Set(),
  mediaKeys: new Set(),
};

const invalidCanonicalSeedOwnership: CanonicalSeedOwnership = {
  valid: false,
  deckIds: new Set(),
  noteIds: new Set(),
  mediaKeys: new Set(),
};

/**
 * Identify the one first-party graph whose `seed` ownership is durable without
 * an APKG import row. Markers alone are deliberately insufficient: the whole
 * immutable seed identity must be present before any record receives the
 * exemption.
 */
function canonicalSeedOwnership(
  stores: Record<(typeof productionStoreNames)[number], Array<Record<string, unknown>>>,
): CanonicalSeedOwnership {
  const meta = new Map(stores.meta.map((item) => [String(item.key), item.value]));
  const seedDecks = stores.decks.filter((item) => item.importId === SEED_IMPORT_ID);
  const seedNotes = stores.notes.filter((item) => item.importId === SEED_IMPORT_ID);
  const seedMedia = stores.media.filter((item) => item.importId === SEED_IMPORT_ID);
  const hasSeedRecords = seedDecks.length > 0 || seedNotes.length > 0 || seedMedia.length > 0;
  const seedImport = stores.imports.some((item) => item.id === SEED_IMPORT_ID);
  if (!hasSeedRecords) return seedImport ? invalidCanonicalSeedOwnership : noCanonicalSeedOwnership;
  if (meta.get(SEED_INSTALLED_META_KEY) !== true ||
      meta.get(SEED_VERSION_META_KEY) !== SPANISH_BASICS_FIXTURE_VERSION ||
      seedDecks.length !== 1 || seedNotes.length !== SPANISH_BASICS_FIXTURE.length ||
      seedMedia.length !== 0 || seedImport) {
    return invalidCanonicalSeedOwnership;
  }

  const deck = seedDecks[0]!;
  if (deck.id !== SPANISH_BASICS_DECK_ID || deck.sourceDeckId !== null ||
      deck.name !== SPANISH_BASICS_DECK_NAME || deck.cardCount !== SPANISH_BASICS_FIXTURE.length ||
      deck.sessionIntakeLimit !== 20 || deck.schedulerConfigId !== "neutral-v1") {
    return invalidCanonicalSeedOwnership;
  }

  const notes = new Map(seedNotes.map((item) => [String(item.id), item]));
  const cards = new Map(stores.cards.map((item) => [String(item.id), item]));
  const exactGraph = SPANISH_BASICS_FIXTURE.every((entry, creationOrder) => {
    const noteId = `seed-spanish-basics-note-${entry.id}`;
    const cardId = `seed-spanish-basics-card-${entry.id}`;
    const note = notes.get(noteId);
    const card = cards.get(cardId);
    return note !== undefined && card !== undefined &&
      note.importId === SEED_IMPORT_ID && note.sourceNoteId === null && note.guid === null &&
      note.modelId === "spanish-basics-v1" &&
      equal(note.fields, { Front: entry.front, Back: entry.back }) &&
      equal(note.tags, ["spanish", "basics"]) &&
      card.deckId === SPANISH_BASICS_DECK_ID && card.noteId === noteId &&
      card.sourceCardId === null && card.templateOrdinal === 0 &&
      card.frontText === entry.front && card.backText === entry.back &&
      card.answerText === entry.back && card.css === "" && card.frontHtml === entry.front &&
      card.backHtml === entry.back && card.answerHtml === entry.back &&
      card.backIncludesFront === false && equal(card.mediaRefs, []) &&
      card.creationOrder === creationOrder && equal(card.contentWarnings, []);
  });
  if (!exactGraph || stores.cards.filter((item) => item.deckId === SPANISH_BASICS_DECK_ID).length !==
      SPANISH_BASICS_FIXTURE.length) {
    return invalidCanonicalSeedOwnership;
  }

  return {
    valid: true,
    deckIds: new Set([SPANISH_BASICS_DECK_ID]),
    noteIds: new Set(notes.keys()),
    mediaKeys: new Set(),
  };
}

/**
 * Validate the relational and ordering guarantees of the independently captured
 * production study evidence used for rejected no-op assessment.
 */
export function completeRejectedProductionSnapshot(snapshot: unknown): boolean {
  if (!completeProductionSnapshot(snapshot, "study")) return false;
  const value = record(snapshot)!;
  const visible = record(value.visible)!;
  const durable = record(value.durable)!;
  const stores = record(durable.stores)!;
  const storeRecords = Object.fromEntries(productionStoreNames.map((name) =>
    [name, stores[name] as Array<Record<string, unknown>>]
  )) as Record<(typeof productionStoreNames)[number], Array<Record<string, unknown>>>;
  const primaryKeys: Record<(typeof productionStoreNames)[number], (item: Record<string, unknown>) => readonly string[]> = {
    cards: (item) => [String(item.id)],
    decks: (item) => [String(item.id)],
    imports: (item) => [String(item.id)],
    media: (item) => [String(item.importId), String(item.name)],
    meta: (item) => [String(item.key)],
    notes: (item) => [String(item.id)],
    reviewLogs: (item) => [String(item.id)],
    schedules: (item) => [String(item.cardId)],
    sessions: (item) => [String(item.id)],
  };
  if (!productionStoreNames.every((name) =>
    canonicallyOrdered(storeRecords[name], primaryKeys[name]))) return false;

  const imports = keyedRecords(storeRecords.imports, (item) => String(item.id));
  const decks = keyedRecords(storeRecords.decks, (item) => String(item.id));
  const notes = keyedRecords(storeRecords.notes, (item) => String(item.id));
  const cards = keyedRecords(storeRecords.cards, (item) => String(item.id));
  const schedules = keyedRecords(storeRecords.schedules, (item) => String(item.cardId));
  const sessions = keyedRecords(storeRecords.sessions, (item) => String(item.id));
  const reviewLogs = keyedRecords(storeRecords.reviewLogs, (item) => String(item.id));
  const media = keyedRecords(storeRecords.media, (item) => `${String(item.importId)}\0${String(item.name)}`);
  if (!imports || !decks || !notes || !cards || !schedules || !sessions || !reviewLogs || !media ||
      !unique(storeRecords.meta, (item) => String(item.key)) ||
      !unique(storeRecords.imports, (item) => String(item.sha256)) ||
      !unique(storeRecords.sessions, (item) => `${item.deckId}\0${item.dayKey}\0${item.sequence}`) ||
      !unique(storeRecords.reviewLogs.filter((item) => item.commandId !== undefined),
        (item) => String(item.commandId))) return false;

  const seedOwnership = canonicalSeedOwnership(storeRecords);
  if (!seedOwnership.valid) return false;

  for (const deck of storeRecords.decks) {
    if ((!seedOwnership.deckIds.has(String(deck.id)) && !imports.has(String(deck.importId))) ||
        storeRecords.cards.filter((card) => card.deckId === deck.id).length !== deck.cardCount) return false;
  }
  for (const note of storeRecords.notes) {
    if (!seedOwnership.noteIds.has(String(note.id)) && !imports.has(String(note.importId))) return false;
  }
  for (const card of storeRecords.cards) {
    const deck = decks.get(String(card.deckId));
    const note = notes.get(String(card.noteId));
    const mediaReferences = (card.mediaRefs as string[]).map((reference) => {
      const marker = "/media/";
      const markerIndex = reference.indexOf(marker);
      if (markerIndex <= 0 || markerIndex + marker.length >= reference.length) return null;
      try {
        const name = decodeURIComponent(reference.slice(markerIndex + marker.length));
        return name && !name.includes("\0")
          ? `${reference.slice(0, markerIndex)}\0${name}`
          : null;
      } catch {
        return null;
      }
    });
    if (!deck || !note || note.importId !== deck.importId ||
        mediaReferences.some((reference) => reference === null || !media.has(reference))) return false;
  }
  for (const schedule of storeRecords.schedules) {
    const card = cards.get(String(schedule.cardId));
    if (!card || schedule.deckId !== card.deckId) return false;
  }
  for (const session of storeRecords.sessions) {
    const deckId = String(session.deckId);
    if (!decks.has(deckId)) return false;
    const queue = session.queueEntries as Array<Record<string, unknown>>;
    if (!queue.every((entry, index) => {
      const card = cards.get(String(entry.cardId));
      return card?.deckId === deckId && schedules.has(String(entry.cardId)) &&
        (index === 0 || Number(queue[index - 1]!.ordinal) < Number(entry.ordinal));
    })) return false;
    if (session.activeCardId !== null && cards.get(String(session.activeCardId))?.deckId !== deckId) return false;
  }
  for (const log of storeRecords.reviewLogs) {
    const session = sessions.get(String(log.sessionId));
    const card = cards.get(String(log.cardId));
    if (!session || !card || log.deckId !== session.deckId || log.deckId !== card.deckId) return false;
  }
  if (!storeRecords.media.every((item) =>
    (seedOwnership.mediaKeys.has(`${String(item.importId)}\0${String(item.name)}`) ||
      imports.has(String(item.importId))) && record(item.blob)?.bytesSha256 === item.sha256
  )) return false;

  const selectedDecks = durable.decks as Array<Record<string, unknown>>;
  const selectedCards = durable.cards as Array<Record<string, unknown>>;
  const selectedSessions = durable.sessions as Array<Record<string, unknown>>;
  const selectedSchedules = durable.schedules as Array<Record<string, unknown>>;
  const selectedLogs = durable.reviewLogs as Array<Record<string, unknown>>;
  const selectedSession = record(durable.session)!;
  const selectedCard = record(durable.card)!;
  const selectedSchedule = record(durable.schedule)!;
  const deckId = String(selectedSession.deckId);
  const expectedSessions = storeRecords.sessions.filter((item) => item.deckId === deckId);
  const expectedSession = expectedSessions.find((item) => item.completedAt === null) ?? expectedSessions[0];
  return selectedDecks.length === 1 && exactMember(selectedDecks[0], decks, deckId) &&
    equal(selectedCards, storeRecords.cards.filter((item) => item.deckId === deckId)) &&
    equal(selectedSessions, expectedSessions) && expectedSession !== undefined && equal(selectedSession, expectedSession) &&
    selectedCard.id === visible.cardId && exactMember(selectedCard, cards, String(selectedCard.id)) &&
    selectedCard.deckId === deckId && selectedSchedule.cardId === selectedCard.id &&
    exactMember(selectedSchedule, schedules, String(selectedSchedule.cardId)) &&
    equal(selectedSchedules, storeRecords.schedules.filter((item) => item.deckId === deckId)) &&
    equal(selectedLogs, storeRecords.reviewLogs.filter((item) => item.deckId === deckId));
}
