import { describe, expect, test } from "bun:test";

import type { NormalizedImportGraph } from "../contracts";
import { compileImportContent, ContentCompilationFailure } from "./content";

describe("production card content compilation", () => {
  test("compiles fields, FrontSide, conditionals, cloze, CSS, sound, and local images", () => {
    const graph = fixtureGraph({
      fields: [
        "<b>Hello</b> {{c1::world::hint}} <img src=\"cafe&#x301;.png\"> [sound:音声.wav]",
        "<i>Answer</i>",
        "yes",
      ],
      questionFormat: "{{#Extra}}<section>{{cloze:Front}}</section>{{/Extra}}<p>{{text:Back}}</p>{{^Extra}}hidden{{/Extra}}",
      answerFormat: "{{FrontSide}}<hr id=answer>{{Back}} {{cloze:Front}}",
      css: ".card { color: red; font-size: 20px; } .cloze { font-weight: bold; }",
    });

    const result = compileImportContent(graph, { operationId: "compile" });
    const content = result.graph.cards[0].content;
    expect(content.frontHtml).toContain("<b>Hello</b>");
    expect(content.frontHtml).toContain("<p>Answer</p>");
    expect(content.frontHtml).toContain('data-anki-media-ref="café.png"');
    expect(content.frontHtml).toContain('data-anki-media-ref="音声.wav"');
    expect(content.backHtml).toContain(content.frontHtml);
    expect(content.backHtml).toContain('<span class="cloze">[hint]</span>');
    expect(content.frontText).toContain("Hello [hint]");
    expect(content.backText).toContain("[hint]");
    expect(content.backText).toContain("world");
    expect(content.css).toBe(".card{color:red;font-size:20px}.cloze{font-weight:bold}");
    expect(content.mediaReferences).toEqual(["café.png", "音声.wav"]);
    expect(result.warnings).toEqual([]);
  });

  test("sanitizes active markup, navigation, obfuscated URLs, handlers, and unsafe CSS", () => {
    const graph = fixtureGraph({
      fields: [
        '<script>globalThis.pwned=1</script><form action="https://bad.example"><input autofocus></form>'
        + '<img src="jav&#x61;script:alert(1)" onerror="alert(2)"><iframe srcdoc="bad"></iframe>'
        + '<a href="https://bad.example">navigate</a><p style="color:blue;background:url(https://bad.example/x)">safe</p>',
        "answer",
        "yes",
      ],
      questionFormat: "{{Front}}",
      answerFormat: "{{FrontSide}}{{Back}}",
      css: '@import "https://bad.example/x";.card{color:green;background-image:url(https://bad.example/x);behavior:url(x)}',
    });

    const result = compileImportContent(graph, { operationId: "hostile" });
    const content = result.graph.cards[0].content;
    for (const forbidden of ["script", "globalThis", "form", "input", "iframe", "javascript", "onerror", "href", "https:", "url(", "behavior"]) {
      expect(`${content.frontHtml}${content.backHtml}${content.css}`.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(content.frontHtml).toContain("safe");
    expect(content.frontHtml).toContain('style="color:blue"');
    expect(result.warnings).toEqual([{
      code: "UNSAFE_CONTENT_REMOVED",
      message: "Unsafe imported card content was removed.",
      stage: "compiling-content",
      source: { kind: "card", id: "card-1" },
    }, {
      code: "UNSAFE_CONTENT_REMOVED",
      message: "Unsafe model CSS was removed.",
      stage: "compiling-content",
      source: { kind: "card", id: "card-1" },
    }]);
  });

  test("warns on unsupported directives while preserving safe surrounding content", () => {
    const result = compileImportContent(fixtureGraph({
      questionFormat: "before {{type:Front}} after {{Front}}",
      answerFormat: "{{FrontSide}} {{hint:Back}}",
    }), { operationId: "unsupported" });
    expect(result.graph.cards[0].content.frontText).toBe("before  after Question");
    expect(result.graph.cards[0].content.backText).toBe("before  after Question");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "UNSUPPORTED_TEMPLATE_FEATURE",
      "UNSUPPORTED_TEMPLATE_FEATURE",
    ]);
    expect(result.warnings.every((warning) => warning.source?.kind === "template")).toBe(true);
  });

  test("distinguishes escaped text from sanitized raw interpolation", () => {
    const raw = compileImportContent(fixtureGraph({
      fields: ["<b>Question &amp; more</b>", "Answer", "yes"],
      questionFormat: "{{Front}} {{{Front}}} {{&Front}} {{text:Front}}",
    }), { operationId: "forms" }).graph.cards[0].content;
    expect(raw.frontHtml.match(/<b>/g)).toHaveLength(3);
    expect(raw.frontHtml).toContain("Question &amp; more");
    expect(raw.frontText).toBe("Question & more Question & more Question & more Question & more");
  });

  test("rejects malformed templates and observes cancellation between cards", () => {
    expect(() => compileImportContent(fixtureGraph({ questionFormat: "{{Front}" }), {
      operationId: "malformed",
    })).toThrow(ContentCompilationFailure);
    try {
      compileImportContent(fixtureGraph({ questionFormat: "{{Front}" }), { operationId: "malformed" });
    } catch (error) {
      expect((error as ContentCompilationFailure).error).toMatchObject({
        code: "TEMPLATE_COMPILATION_FAILED",
        operationId: "malformed",
        stage: "compiling-content",
      });
    }

    expect(() => compileImportContent(fixtureGraph(), {
      operationId: "cancelled",
      isCancelled: () => true,
    })).toThrow(ContentCompilationFailure);
    try {
      compileImportContent(fixtureGraph(), { operationId: "cancelled", isCancelled: () => true });
    } catch (error) {
      expect((error as ContentCompilationFailure).error.code).toBe("IMPORT_CANCELLED");
    }
  });
});

function fixtureGraph(overrides: {
  fields?: string[];
  questionFormat?: string;
  answerFormat?: string;
  css?: string;
} = {}): NormalizedImportGraph {
  return {
    layout: "legacy-anki2",
    packageSha256: "a".repeat(64),
    decks: [{ id: "deck-1", name: "Deck" }],
    notetypes: [{
      id: "model-1",
      name: "Basic",
      fields: ["Front", "Back", "Extra"],
      templates: ["Card 1"],
      css: overrides.css ?? ".card { color: black; }",
    }],
    fields: [
      { notetypeId: "model-1", ordinal: 0, name: "Front" },
      { notetypeId: "model-1", ordinal: 1, name: "Back" },
      { notetypeId: "model-1", ordinal: 2, name: "Extra" },
    ],
    cardTemplates: [{
      notetypeId: "model-1",
      ordinal: 0,
      name: "Card 1",
      questionFormat: overrides.questionFormat ?? "{{Front}}",
      answerFormat: overrides.answerFormat ?? "{{FrontSide}}<hr>{{Back}}",
    }],
    notes: [{
      id: "note-1",
      sourceGuid: "guid",
      notetypeId: "model-1",
      deckId: "deck-1",
      fields: overrides.fields ?? ["Question", "Answer", "yes"],
      tags: [],
    }],
    cards: [{
      id: "card-1",
      noteId: "note-1",
      deckId: "deck-1",
      templateOrdinal: 0,
      scheduling: "fresh",
      content: {
        frontText: "", backText: "", frontHtml: "", backHtml: "", css: "", mediaReferences: [],
      },
    }],
    media: [],
  };
}
