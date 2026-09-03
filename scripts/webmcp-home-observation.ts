export type HomeDeckObservation = {
  id: string;
  name: string;
  card_count: number;
  new_count: number;
  due_count: number;
  suspended_count: number;
  last_studied_at: string | null;
  can_start_session: boolean;
};

export type VisibleHomeDeckObservation = {
  id: string | null;
  name: string | null;
  card_count: number | null;
  new_count: number | null;
  due_count: number | null;
  /** The production row exposes suspension through recovery, not numeric text. */
  suspended_count: number | null;
  recovery_available: boolean;
  study_action: "start" | "resume" | null;
  study_keyboard_operable: boolean;
};

export type VisibleHomePageObservation = {
  state: "loading" | "empty" | "error" | "populated" | null;
  decks: VisibleHomeDeckObservation[];
};

/** Read only the semantic deck-row contract exposed by the production DOM. */
export function observeVisibleHomePage(
  root: ParentNode = document,
): VisibleHomePageObservation {
  const count = (row: ParentNode, field: string, label: string): number | null => {
    const candidates = row.querySelectorAll(`[data-deck-count="${field}"]`);
    if (candidates.length !== 1) return null;
    const text = candidates[0]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const match = new RegExp(
      `^(0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)\\s+${label}$`,
    ).exec(text);
    if (!match) return null;
    const value = Number(match[1]!.replaceAll(",", ""));
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const pageState = root.querySelector("[data-deck-page-state]")
    ?.getAttribute("data-deck-page-state") ?? null;
  return {
    state: pageState === "loading" || pageState === "empty" || pageState === "error" ||
        pageState === "populated"
      ? pageState
      : null,
    decks: Array.from(root.querySelectorAll<HTMLElement>("[data-deck-row]")).map((row) => {
      const study = row.querySelector<HTMLButtonElement>('[data-deck-action="study"]');
      const studyLabel = study?.getAttribute("aria-label") ?? "";
      const action = studyLabel.startsWith("Start studying ")
        ? "start" as const
        : studyLabel.startsWith("Resume studying ")
          ? "resume" as const
          : null;
      const recovery = row.querySelector<HTMLButtonElement>(
        '[data-deck-action="restore-suspended"]',
      );
      return {
        id: row.getAttribute("data-deck-id"),
        name: action === "start"
          ? studyLabel.slice("Start studying ".length)
          : action === "resume"
            ? studyLabel.slice("Resume studying ".length)
            : null,
        card_count: count(row, "total", "total"),
        new_count: count(row, "new", "new"),
        due_count: count(row, "due", "due"),
        // Production exposes only the recovery affordance for nonzero suspension.
        suspended_count: count(row, "suspended", "suspended"),
        recovery_available: recovery !== null && !recovery.disabled,
        study_action: action,
        study_keyboard_operable: study !== null && !study.disabled,
      };
    }),
  };
}

export type DurableHomeSnapshot = {
  capturedAt: number;
  decks: Array<{
    id: string;
    name: string;
    cardCount: number;
    sessionIntakeLimit: number;
    createdAt: number;
    lastStudiedAt: number | null;
  }>;
  cards: Array<{
    id: string;
    deckId: string;
    creationOrder: number;
  }>;
  schedules: Array<{
    cardId: string;
    deckId: string;
    dueAt: number;
    state: "new" | "learning" | "review" | "relearning";
    lastReviewAt: number | null;
    suspended: boolean;
  }>;
  sessions: Array<{
    id: string;
    deckId: string;
    dayKey: string;
    sequence: number;
    intakeLimit: number;
    nextDayAt: number;
    queueEntries: Array<{
      cardId: string;
      dueAt: number;
      ordinal: number;
    }>;
    activeCardId: string | null;
    plannedPresentationCount: number;
    completedPresentationCount: number;
    currentSide: "front" | "back";
    startedAt: number;
    updatedAt: number;
    completedAt: number | null;
  }>;
};

export type DurableDeckMetadataObservation = {
  id: string;
  last_studied_at: string | null;
};

/** Normalize raw deck metadata without consuming either parity adapter. */
export function observeDurableDeckMetadata(
  snapshot: DurableHomeSnapshot,
): DurableDeckMetadataObservation[] {
  return snapshot.decks.map((deck) => ({
    id: deck.id,
    last_studied_at: deck.lastStudiedAt === null
      ? null
      : new Date(deck.lastStudiedAt).toISOString(),
  }));
}

/**
 * Project only durable IndexedDB records into the production home contract.
 * This deliberately does not consume a list_decks result or UI expectation.
 */
export function projectDurableHomeDecks(
  snapshot: DurableHomeSnapshot,
): HomeDeckObservation[] {
  return [...snapshot.decks]
    .sort((left, right) => left.createdAt - right.createdAt
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id))
    .map((deck) => {
      const schedules = snapshot.schedules.filter((schedule) => schedule.deckId === deck.id);
      return {
        id: deck.id,
        name: deck.name,
        card_count: snapshot.cards.filter((card) => card.deckId === deck.id).length,
        new_count: schedules.filter((schedule) =>
          !schedule.suspended && schedule.state === "new"
        ).length,
        due_count: schedules.filter((schedule) =>
          !schedule.suspended
          && schedule.state !== "new"
          && schedule.dueAt <= snapshot.capturedAt
        ).length,
        suspended_count: schedules.filter((schedule) => schedule.suspended).length,
        last_studied_at: deck.lastStudiedAt === null
          ? null
          : new Date(deck.lastStudiedAt).toISOString(),
        can_start_session: snapshot.sessions.some((session) =>
          session.deckId === deck.id && session.completedAt === null
        ) || schedules.some((schedule) =>
          !schedule.suspended
          && (schedule.state === "new" || schedule.dueAt <= snapshot.capturedAt)
        ),
      };
    });
}

export function parseHomeDeckObservations(value: unknown): HomeDeckObservation[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: HomeDeckObservation[] = [];
  for (const candidate of value) {
    if (!isHomeDeckObservation(candidate)) return null;
    parsed.push(candidate);
  }
  return parsed;
}

function isHomeDeckObservation(value: unknown): value is HomeDeckObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const deck = value as Record<string, unknown>;
  return typeof deck.id === "string"
    && typeof deck.name === "string"
    && isCount(deck.card_count)
    && isCount(deck.new_count)
    && isCount(deck.due_count)
    && isCount(deck.suspended_count)
    && (deck.last_studied_at === null || isIsoDate(deck.last_studied_at))
    && typeof deck.can_start_session === "boolean";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string"
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}
