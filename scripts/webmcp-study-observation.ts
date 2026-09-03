export type VisibleStudyCardObservation = {
  state: "active" | null;
  cardId: string | null;
  sessionSequence: number | null;
  side: "front" | "back" | null;
  answerState: "withheld" | "exposed" | null;
  answerSemantic: VisibleAnswerSemantic | null;
  detail: string | null;
};

export type VisibleAnswerSemantic = {
  /** NFC-normalized, whitespace-collapsed text that is actually rendered. */
  text: string;
  /** Accessible media meaning in DOM order, independent of object URLs. */
  media: Array<{ kind: "image" | "audio"; label: string }>;
};

export type VisibleRatingPreview = {
  rating: "again" | "hard" | "good" | "easy";
  interval: string;
  due_at: string;
};

/** Read the complete ordered rating map rendered by React, failing closed on malformed controls. */
export function readVisibleRatingPreviews(
  root: ParentNode = document,
): readonly VisibleRatingPreview[] | null {
  const ratings = ["again", "hard", "good", "easy"] as const;
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>("[data-study-action='rate']"),
  );
  if (controls.length !== ratings.length) return null;

  const previews = ratings.flatMap((rating) => {
    const matches = controls.filter(
      (control) => control.getAttribute("data-study-rating") === rating,
    );
    if (matches.length !== 1) return [];
    const control = matches[0]!;
    const intervalNodes = control.querySelectorAll<HTMLElement>("[data-rating-preview]");
    const interval = intervalNodes.length === 1
      ? intervalNodes[0]!.textContent?.trim() ?? ""
      : "";
    const dueAt = control.getAttribute("data-study-rating-due-at") ?? "";
    if (!interval || !dueAt || !Number.isFinite(Date.parse(dueAt))) return [];
    return [{ rating, interval, due_at: dueAt }];
  });
  return previews.length === ratings.length ? previews : null;
}

/**
 * Convert one rendered semantic answer region into stable user-visible meaning.
 * This deliberately ignores source markup and browser-owned media URLs.
 */
export function readVisibleAnswerSemantics(root: Element): VisibleAnswerSemantic {
  const normalize = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
  const hidden = (element: Element) => {
    if (!(element instanceof element.ownerDocument.defaultView!.HTMLElement)) return false;
    const html = element as HTMLElement;
    if (html.hidden || html.getAttribute("aria-hidden") === "true" || html.hasAttribute("inert")) return true;
    const style = html.ownerDocument.defaultView?.getComputedStyle(html);
    return style?.display === "none" || style?.visibility === "hidden" ||
      style?.visibility === "collapse" || style?.opacity === "0";
  };
  const media: VisibleAnswerSemantic["media"] = [];
  const text: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === node.TEXT_NODE) {
      text.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== node.ELEMENT_NODE) return;
    const element = node as Element;
    if (hidden(element)) return;
    const tag = element.tagName.toLowerCase();
    const reference = element.getAttribute("data-anki-media-ref") ?? "";
    const fallback = reference.split("/").at(-1) ?? reference;
    const label = normalize(
      element.getAttribute("aria-label") ?? element.getAttribute("alt") ??
      element.getAttribute("title") ?? fallback,
    );
    if (tag === "img") {
      media.push({ kind: "image", label: label || "image" });
      return;
    }
    if (tag === "audio" || element.classList.contains("anki-sound")) {
      media.push({ kind: "audio", label: label || normalize(element.textContent ?? "") || "audio" });
      return;
    }
    for (const child of element.childNodes) visit(child);
  };
  visit(root);
  return { text: normalize(text.join(" ")), media };
}

/**
 * Read the selected card and side only from the production study DOM.
 *
 * The function is deliberately self-contained so the production evidence
 * runner can serialize this exact observer into Playwright's browser realm.
 */
export function observeVisibleStudyCard(
  root: ParentNode = document,
  readAnswerSemantics: (root: Element) => VisibleAnswerSemantic = readVisibleAnswerSemantics,
): VisibleStudyCardObservation {
  const fail = (detail: string): VisibleStudyCardObservation => ({
    state: null,
    cardId: null,
    sessionSequence: null,
    side: null,
    answerState: null,
    answerSemantic: null,
    detail,
  });
  const pages = Array.from(root.querySelectorAll<HTMLElement>("[data-study-page]"));
  if (pages.length !== 1) return fail(`study-page-count:${pages.length}`);
  const page = pages[0]!;

  const states = Array.from(root.querySelectorAll<HTMLElement>("[data-study-state]"));
  if (states.length !== 1) return fail(`study-state-count:${states.length}`);
  const state = states[0]!;
  if (!page.contains(state)) return fail("study-state-outside-page");
  const stateValue = state.getAttribute("data-study-state");
  if (stateValue !== "active") return fail(`study-state-not-active:${stateValue ?? "missing"}`);

  const identities = Array.from(root.querySelectorAll<HTMLElement>("[data-study-card-id]"));
  if (identities.length !== 1) return fail(`study-card-identity-count:${identities.length}`);
  const identity = identities[0]!;
  if (!page.contains(identity)) return fail("study-card-identity-outside-page");
  const cardId = identity.textContent?.trim() ?? "";
  if (!cardId) return fail("study-card-identity-empty");

  const sessions = Array.from(root.querySelectorAll<HTMLElement>("[data-study-session-sequence]"));
  if (sessions.length !== 1) return fail(`study-session-count:${sessions.length}`);
  const session = sessions[0]!;
  if (!page.contains(session)) return fail("study-session-outside-page");
  const sessionSequence = Number(session.getAttribute("data-study-session-sequence"));
  if (!Number.isSafeInteger(sessionSequence) || sessionSequence < 1) {
    return fail(`study-session-invalid:${session.getAttribute("data-study-session-sequence") ?? "missing"}`);
  }

  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-flashcard]"));
  if (cards.length !== 1) return fail(`study-card-count:${cards.length}`);
  const card = cards[0]!;
  if (!state.contains(card)) return fail("study-card-outside-active-state");

  for (let node: HTMLElement | null = card; node; node = node.parentElement) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert")) {
      return fail("study-card-hidden");
    }
    const view: Window | null = node.ownerDocument.defaultView;
    const style = view?.getComputedStyle(node);
    if (style?.display === "none" || style?.visibility === "hidden" ||
        style?.visibility === "collapse" || style?.opacity === "0") {
      return fail("study-card-hidden");
    }
  }
  for (let node: HTMLElement | null = identity; node; node = node.parentElement) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert")) {
      return fail("study-card-identity-hidden");
    }
    const view: Window | null = node.ownerDocument.defaultView;
    const style = view?.getComputedStyle(node);
    if (style?.display === "none" || style?.visibility === "hidden" ||
        style?.visibility === "collapse" || style?.opacity === "0") {
      return fail("study-card-identity-hidden");
    }
  }

  const sideNodes = Array.from(root.querySelectorAll<HTMLElement>("[data-flashcard-side]"));
  if (sideNodes.length !== 1) return fail(`study-side-count:${sideNodes.length}`);
  if (sideNodes[0] !== card) return fail("study-side-not-on-card");
  const side = card.getAttribute("data-flashcard-side");
  if (side !== "front" && side !== "back") {
    return fail(`study-side-invalid:${side ?? "missing"}`);
  }

  const answers = Array.from(root.querySelectorAll<HTMLElement>("[data-flashcard-answer]"));
  if (side === "front") {
    if (answers.length !== 0) return fail(`study-answer-before-reveal-count:${answers.length}`);
    return {
      state: "active", cardId, sessionSequence, side, answerState: "withheld", answerSemantic: null, detail: null,
    };
  }
  if (answers.length !== 1) return fail(`study-answer-count:${answers.length}`);
  const answer = answers[0]!;
  if (!card.contains(answer)) return fail("study-answer-outside-card");
  if (answer.closest("[data-flashcard-front-context]")) return fail("study-answer-in-front-context");
  for (let node: HTMLElement | null = answer; node && node !== card; node = node.parentElement) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert")) {
      return fail("study-answer-hidden");
    }
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style?.display === "none" || style?.visibility === "hidden" ||
        style?.visibility === "collapse" || style?.opacity === "0") {
      return fail("study-answer-hidden");
    }
  }
  return {
    state: "active",
    cardId,
    sessionSequence,
    side,
    answerState: "exposed",
    answerSemantic: readAnswerSemantics(answer),
    detail: null,
  };
}
