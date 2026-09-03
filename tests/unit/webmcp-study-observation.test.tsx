import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StudyPage, type StudyPageProps } from "../../components/study";
import { observeVisibleStudyCard } from "../../scripts/webmcp-study-observation";

const cardId = "card-selected";

function render(side: "front" | "back" = "front") {
  const window = new Window();
  const props: StudyPageProps = {
    deck: { name: "Production deck", currentCardId: cardId, sessionSequence: 1 },
    progress: { current: 0, total: 20 },
    state: {
      kind: "active",
      side,
      revealed: side === "back",
      frontContent: "Question",
      backContent: "Answer",
      ratings: [
        { rating: "again", interval: "1m" },
        { rating: "hard", interval: "6m" },
        { rating: "good", interval: "10m" },
        { rating: "easy", interval: "4d" },
      ],
    },
    onReturnToDecks: () => undefined,
    onToggle: () => undefined,
    onRate: () => undefined,
    onSuspend: () => undefined,
  };
  window.document.body.innerHTML = renderToStaticMarkup(createElement(StudyPage, props));
  const document = window.document as unknown as Document;
  return { document, observe: () => observeVisibleStudyCard(document) };
}

describe("production study-side observation", () => {
  test.each(["front", "back"] as const)(
    "reads %s from the real StudyPage and Flashcard semantic attribute",
    (side) => {
      const rendered = render(side);
      expect(rendered.observe()).toEqual({
        state: "active",
        cardId,
        side,
        detail: null,
      });
    },
  );

  test.each([
    ["missing", "study-side-count:0", (document: Document) => {
      document.querySelector("[data-flashcard]")?.removeAttribute("data-flashcard-side");
    }],
    ["empty", "study-side-invalid:", (document: Document) => {
      document.querySelector("[data-flashcard]")?.setAttribute("data-flashcard-side", "");
    }],
    ["malformed", "study-side-invalid:reverse", (document: Document) => {
      document.querySelector("[data-flashcard]")?.setAttribute("data-flashcard-side", "reverse");
    }],
    ["duplicate", "study-side-count:2", (document: Document) => {
      const duplicate = document.createElement("span");
      duplicate.setAttribute("data-flashcard-side", "front");
      document.querySelector("[data-study-state]")?.append(duplicate);
    }],
    ["multiple active cards", "study-state-count:2", (document: Document) => {
      document.querySelector("[data-study-state]")?.after(
        document.querySelector("[data-study-state]")!.cloneNode(true),
      );
    }],
    ["mixed identity", "study-card-identity-count:2", (document: Document) => {
      const identity = document.createElement("span");
      identity.setAttribute("data-study-card-id", "");
      identity.textContent = "card-other";
      document.body.append(identity);
    }],
    ["stale prior card", "study-card-count:2", (document: Document) => {
      document.body.append(document.querySelector("[data-flashcard]")!.cloneNode(true));
    }],
    ["hidden lookalike", "study-card-count:2", (document: Document) => {
      const hidden = document.querySelector("[data-flashcard]")!.cloneNode(true) as HTMLElement;
      hidden.hidden = true;
      document.body.append(hidden);
    }],
    ["hidden selected card", "study-card-hidden", (document: Document) => {
      (document.querySelector("[data-flashcard]") as HTMLElement).hidden = true;
    }],
    ["hidden study content", "study-card-hidden", (document: Document) => {
      (document.querySelector("[data-study-content]") as HTMLElement).hidden = true;
    }],
    ["hidden outer study page", "study-card-hidden", (document: Document) => {
      (document.querySelector("[data-study-page]") as HTMLElement).hidden = true;
    }],
    ["identity outside the active study page", "study-card-identity-outside-page", (document: Document) => {
      document.body.append(document.querySelector("[data-study-card-id]")!);
    }],
    ["side on a different node", "study-side-not-on-card", (document: Document) => {
      const card = document.querySelector("[data-flashcard]")!;
      card.removeAttribute("data-flashcard-side");
      document.querySelector("[data-study-state]")?.setAttribute("data-flashcard-side", "front");
    }],
  ] as const)("rejects %s evidence with stable detail", (_case, detail, mutate) => {
    const rendered = render();
    mutate(rendered.document);
    expect(rendered.observe()).toEqual({ state: null, cardId: null, side: null, detail });
  });

  test("does not combine a stale identity with an active card from another page", () => {
    const rendered = render();
    const stalePage = rendered.document.querySelector("[data-study-page]")!.cloneNode(true) as HTMLElement;
    stalePage.querySelector("[data-study-state]")?.remove();
    rendered.document.querySelector("[data-study-card-id]")?.remove();
    rendered.document.body.append(stalePage);

    expect(rendered.observe()).toEqual({
      state: null,
      cardId: null,
      side: null,
      detail: "study-page-count:2",
    });
  });

  test("does not borrow a copied side from non-DOM state", () => {
    const rendered = render();
    const toolState = { current_card: { id: cardId, side: "front" } };
    const durableSession = { activeCardId: cardId, currentSide: "front" };
    rendered.document.querySelector("[data-flashcard]")?.setAttribute("data-flashcard-side", "copied-wrong");

    expect(toolState.current_card.side).toBe("front");
    expect(durableSession.currentSide).toBe("front");
    expect(rendered.observe()).toEqual({
      state: null,
      cardId: null,
      side: null,
      detail: "study-side-invalid:copied-wrong",
    });
  });

  test.each(["loading", "waiting", "completion", "caught-up", "empty", "error"] as const)(
    "does not yield a side for the explicit %s state",
    (kind) => {
      const rendered = render();
      const state = rendered.document.querySelector("[data-study-state]")!;
      state.setAttribute("data-study-state", kind);
      expect(rendered.observe()).toEqual({
        state: null,
        cardId: null,
        side: null,
        detail: `study-state-not-active:${kind}`,
      });
    },
  );
});
