import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StudyPage, type StudyPageProps } from "../../components/study";
import { studyViewFromSnapshot } from "../../components/study-route-preview";
import {
  observeVisibleStudyCard,
  readVisibleAnswerSemantics,
  readVisibleRatingPreviews,
} from "../../scripts/webmcp-study-observation";

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
        { rating: "again", interval: "1m", dueAt: "2026-09-03T12:01:00.000Z" },
        { rating: "hard", interval: "6m", dueAt: "2026-09-03T12:06:00.000Z" },
        { rating: "good", interval: "10m", dueAt: "2026-09-03T12:10:00.000Z" },
        { rating: "easy", interval: "4d", dueAt: "2026-09-07T12:00:00.000Z" },
      ],
    },
    onReturnToDecks: () => undefined,
    onToggle: () => undefined,
    onRate: () => undefined,
  };
  window.document.body.innerHTML = renderToStaticMarkup(createElement(StudyPage, props));
  const document = window.document as unknown as Document;
  return { document, observe: () => observeVisibleStudyCard(document) };
}

describe("production study-side observation", () => {
  test("reads the exact complete React rating-preview map", () => {
    const rendered = render();
    expect(readVisibleRatingPreviews(rendered.document)).toEqual([
      { rating: "again", interval: "1m", due_at: "2026-09-03T12:01:00.000Z" },
      { rating: "hard", interval: "6m", due_at: "2026-09-03T12:06:00.000Z" },
      { rating: "good", interval: "10m", due_at: "2026-09-03T12:10:00.000Z" },
      { rating: "easy", interval: "4d", due_at: "2026-09-07T12:00:00.000Z" },
    ]);

    rendered.document.querySelector("[data-study-rating='easy']")
      ?.removeAttribute("data-study-rating-due-at");
    expect(readVisibleRatingPreviews(rendered.document)).toBeNull();
  });
  test("centers a plain Spanish answer through the same compact structure as its prompt", () => {
    const window = new Window();
    const view = studyViewFromSnapshot({
      kind: "active",
      capturedAt: 1,
      deckId: "seed-spanish-basics",
      deckName: "Spanish Basics",
      sessionId: "session-1",
      sequence: 1,
      completedPresentationCount: 0,
      plannedPresentationCount: 20,
      completedTodayCount: 0,
      todayCardCount: 20,
      cardId: "seed-spanish-basics-card-hola",
      frontText: "hola",
      frontHtml: "hola",
      backText: "hello",
      backHtml: "hello",
      answerText: "hello",
      answerHtml: "hello",
      backIncludesFront: false,
      css: "",
      mediaRefs: [],
      side: "back",
      ratingPreviews: Object.fromEntries((["again", "hard", "good", "easy"] as const).map((rating) => [
        rating,
        {
          rating,
          dueAt: 60_000,
          interval: "1m",
          intervalLabel: "1m",
          intervalMinutes: 1,
          intervalDays: 0,
          scheduledDays: 0,
          state: "learning" as const,
        },
      ])) as never,
    });
    window.document.body.innerHTML = renderToStaticMarkup(createElement(StudyPage, {
      deck: view.deck,
      progress: view.progress,
      state: view.state,
      onReturnToDecks: () => undefined,
      onToggle: () => undefined,
      onRate: () => undefined,
    }));
    const answerSection = window.document.querySelector('[aria-label="Card answer"]');

    expect(answerSection?.className).toContain("items-center");
    expect(answerSection?.className).toContain("justify-center");
    expect(answerSection?.querySelector(":scope > [data-flashcard-answer]")?.textContent)
      .toBe("hello");
    expect(answerSection?.querySelector("[data-anki-card-template]")).toBeNull();
  });

  test("observes only the independently compiled answer from a production FrontSide snapshot", () => {
    const window = new Window();
    const view = studyViewFromSnapshot({
      kind: "active",
      capturedAt: 1,
      deckId: "deck-1",
      deckName: "Imported deck",
      sessionId: "session-1",
      sequence: 7,
      completedPresentationCount: 0,
      plannedPresentationCount: 1,
      completedTodayCount: 0,
      todayCardCount: 1,
      cardId,
      frontText: "Question",
      frontHtml: "<b>Question</b>",
      backText: "Question Answer",
      backHtml: "<b>Question</b><hr><i>Answer</i>",
      answerText: "Answer",
      answerHtml: "<hr><i>Answer</i>",
      backIncludesFront: true,
      css: "",
      mediaRefs: [],
      side: "back",
      ratingPreviews: Object.fromEntries((["again", "hard", "good", "easy"] as const).map((rating) => [
        rating,
        {
          rating,
          dueAt: 60_000,
          interval: "1m",
          intervalLabel: "1m",
          intervalMinutes: 1,
          intervalDays: 0,
          scheduledDays: 0,
          state: "learning" as const,
        },
      ])) as never,
    });
    window.document.body.innerHTML = renderToStaticMarkup(createElement(StudyPage, {
      deck: view.deck,
      progress: view.progress,
      state: view.state,
      onReturnToDecks: () => undefined,
      onToggle: () => undefined,
      onRate: () => undefined,
    }));
    const document = window.document as unknown as Document;

    const flattened = document.querySelector("[data-flashcard-content]");
    expect(flattened?.textContent).toContain("Question");
    expect(flattened?.textContent).toContain("Answer");
    expect(readVisibleAnswerSemantics(flattened!)).toEqual({ text: "Question Answer", media: [] });
    expect(observeVisibleStudyCard(document)).toEqual({
      state: "active",
      cardId,
      sessionSequence: 7,
      side: "back",
      answerState: "exposed",
      answerSemantic: { text: "Answer", media: [] },
      detail: null,
    });
  });

  test("renders ambiguous legacy back content unchanged but fails answer observation closed", () => {
    const window = new Window();
    const view = studyViewFromSnapshot({
      kind: "active",
      capturedAt: 1,
      deckId: "deck-1",
      deckName: "Legacy deck",
      sessionId: "session-1",
      sequence: 8,
      completedPresentationCount: 0,
      plannedPresentationCount: 1,
      completedTodayCount: 0,
      todayCardCount: 1,
      cardId,
      frontText: "Question",
      frontHtml: "<b>Question</b>",
      backText: "Question Answer",
      backHtml: "<b>Question</b><hr><i>Answer</i>",
      css: "",
      mediaRefs: [],
      side: "back",
      ratingPreviews: Object.fromEntries(([
        "again", "hard", "good", "easy",
      ] as const).map((rating) => [rating, {
        rating,
        dueAt: 60_000,
        interval: "1m",
        intervalLabel: "1m",
        intervalMinutes: 1,
        intervalDays: 0,
        scheduledDays: 0,
        state: "learning" as const,
      }])) as never,
    });
    window.document.body.innerHTML = renderToStaticMarkup(createElement(StudyPage, {
      deck: view.deck,
      progress: view.progress,
      state: view.state,
      onReturnToDecks: () => undefined,
      onToggle: () => undefined,
      onRate: () => undefined,
    }));
    const document = window.document as unknown as Document;

    expect(document.querySelector("[data-flashcard-content]")?.textContent).toContain("Question");
    expect(document.querySelector("[data-flashcard-content]")?.textContent).toContain("Answer");
    expect(document.querySelector("[data-flashcard-answer]")).toBeNull();
    expect(observeVisibleStudyCard(document)).toEqual({
      state: null,
      cardId: null,
      sessionSequence: null,
      side: null,
      answerState: null,
      answerSemantic: null,
      detail: "study-answer-count:0",
    });
  });

  test.each(["front", "back"] as const)(
    "reads %s from the real StudyPage and Flashcard semantic attribute",
    (side) => {
      const rendered = render(side);
      expect(rendered.observe()).toEqual({
        state: "active",
        cardId,
        sessionSequence: 1,
        side,
        answerState: side === "front" ? "withheld" : "exposed",
        answerSemantic: side === "front" ? null : { text: "Answer", media: [] },
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
    expect(rendered.observe()).toEqual({
      state: null, cardId: null, sessionSequence: null, side: null, answerState: null, answerSemantic: null, detail,
    });
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
      sessionSequence: null,
      side: null,
      answerState: null,
      answerSemantic: null,
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
      sessionSequence: null,
      side: null,
      answerState: null,
      answerSemantic: null,
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
        sessionSequence: null,
        side: null,
        answerState: null,
        answerSemantic: null,
        detail: `study-state-not-active:${kind}`,
      });
    },
  );

  test.each([
    ["missing answer", "study-answer-count:0", (document: Document) => {
      document.querySelector("[data-flashcard-answer]")?.remove();
    }],
    ["duplicate answer", "study-answer-count:2", (document: Document) => {
      document.querySelector("[data-flashcard-answer]")?.after(
        document.querySelector("[data-flashcard-answer]")!.cloneNode(true),
      );
    }],
    ["hidden answer", "study-answer-hidden", (document: Document) => {
      (document.querySelector("[data-flashcard-answer]") as HTMLElement).hidden = true;
    }],
    ["answer outside selected card", "study-answer-outside-card", (document: Document) => {
      document.body.append(document.querySelector("[data-flashcard-answer]")!);
    }],
    ["answer copied into front context", "study-answer-in-front-context", (document: Document) => {
      const frontContext = document.createElement("section");
      frontContext.setAttribute("data-flashcard-front-context", "");
      document.querySelector("[data-flashcard-content]")?.append(frontContext);
      frontContext.append(document.querySelector("[data-flashcard-answer]")!);
    }],
  ] as const)("rejects a %s with stable detail", (_case, detail, mutate) => {
    const rendered = render("back");
    mutate(rendered.document);
    expect(rendered.observe()).toMatchObject({
      state: null,
      answerSemantic: null,
      detail,
    });
  });

  test.each([
    ["missing", "study-session-count:0", (session: Element) => {
      session.removeAttribute("data-study-session-sequence");
    }],
    ["malformed", "study-session-invalid:stale", (session: Element) => {
      session.setAttribute("data-study-session-sequence", "stale");
    }],
    ["duplicate", "study-session-count:2", (session: Element) => {
      const duplicate = session.ownerDocument.createElement("span");
      duplicate.setAttribute("data-study-session-sequence", "1");
      session.after(duplicate);
    }],
  ] as const)("rejects %s lifecycle evidence", (_case, detail, mutate) => {
    const rendered = render("back");
    mutate(rendered.document.querySelector("[data-study-session]")!);
    expect(rendered.observe()).toMatchObject({ state: null, sessionSequence: null, detail });
  });

  test("reads only the real answer region and normalizes visible text, Unicode, images, and audio", () => {
    const rendered = render("back");
    const answer = rendered.document.querySelector("[data-flashcard-answer]")!;
    answer.innerHTML = `
      <div data-card-html> cafe\u0301 <strong> answer </strong>
        <img alt="  Diagram  " src="blob:https://example.test/private">
        <span class="anki-sound" data-anki-media-ref="deck/media/pronunciation.mp3">ignored source label</span>
        <span hidden>not visible</span>
      </div>`;

    expect(readVisibleAnswerSemantics(answer)).toEqual({
      text: "café answer",
      media: [
        { kind: "image", label: "Diagram" },
        { kind: "audio", label: "pronunciation.mp3" },
      ],
    });
    expect(rendered.observe()).toMatchObject({
      answerState: "exposed",
      answerSemantic: {
        text: "café answer",
        media: [
          { kind: "image", label: "Diagram" },
          { kind: "audio", label: "pronunciation.mp3" },
        ],
      },
    });
  });
});
