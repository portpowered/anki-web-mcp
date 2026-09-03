export type VisibleStudyCardObservation = {
  state: "active" | null;
  cardId: string | null;
  side: "front" | "back" | null;
  detail: string | null;
};

/**
 * Read the selected card and side only from the production study DOM.
 *
 * The function is deliberately self-contained so the production evidence
 * runner can serialize this exact observer into Playwright's browser realm.
 */
export function observeVisibleStudyCard(
  root: ParentNode = document,
): VisibleStudyCardObservation {
  const fail = (detail: string): VisibleStudyCardObservation => ({
    state: null,
    cardId: null,
    side: null,
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
  return { state: "active", cardId, side, detail: null };
}
