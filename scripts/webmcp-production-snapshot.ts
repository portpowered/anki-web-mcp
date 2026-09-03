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
