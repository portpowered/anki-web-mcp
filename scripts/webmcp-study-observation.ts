export type VisibleStudyCardObservation = {
  state: "active" | null;
  cardId: string | null;
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
      state: "active", cardId, side, answerState: "withheld", answerSemantic: null, detail: null,
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
    side,
    answerState: "exposed",
    answerSemantic: readAnswerSemantics(answer),
    detail: null,
  };
}
