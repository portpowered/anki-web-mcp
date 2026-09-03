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

function completeStores(value: unknown): boolean {
  const stores = record(value);
  return stores !== null && productionStoreNames.every((name) => Array.isArray(stores[name]));
}

function completeDurable(value: unknown, requireSelectedRecords: boolean): boolean {
  const durable = record(value);
  if (!durable || !Array.isArray(durable.decks) || !Array.isArray(durable.cards) ||
      !Array.isArray(durable.schedules) || !Array.isArray(durable.sessions) ||
      !Array.isArray(durable.reviewLogs) || !completeStores(durable.stores)) {
    return false;
  }
  return !requireSelectedRecords ||
    (record(durable.session) !== null && record(durable.card) !== null &&
      record(durable.schedule) !== null);
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
