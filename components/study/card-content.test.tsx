import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CardContent,
  attachImageObjectUrls,
  attachMediaObjectUrls,
  cleanLegacyCardHtml,
  scopeCardCss,
} from "./card-content";

describe("sanitized APKG card content", () => {
  test("attaches only verified local object URLs to image references", () => {
    const reference = "package/media/photo%20one.png";
    const html = `<img alt="Example" data-anki-media-ref="${reference}"><p>hola</p>`;
    const resolved = attachImageObjectUrls(
      html,
      new Map([[reference, "blob:https://example.test/verified"]]),
    );

    expect(resolved).toContain('src="blob:https://example.test/verified"');
    expect(resolved).toContain(`data-anki-media-ref="${reference}"`);
    expect(attachImageObjectUrls(html, new Map())).not.toContain("src=");
  });

  test("keeps sanitized markup and image alt text in the initial render", () => {
    const markup = renderToStaticMarkup(
      <CardContent
        html='<img alt="Illustrated greeting" data-anki-media-ref="seed/media/hola.png"><strong>hola</strong>'
        mediaRefs={["seed/media/hola.png"]}
      />,
    );

    expect(markup).toContain('data-card-html="true"');
    expect(markup).toContain("[&amp;_a]:hidden");
    expect(markup).toContain("h-full");
    expect(markup).toContain("w-full");
    expect(markup).toContain("min-h-full");
    expect(markup).toContain("height:100%!important");
    expect(markup).toContain("padding-top:clamp(1rem,3vh,2rem)!important");
    expect(markup).toContain("[&amp;_img]:max-h-64");
    expect(markup).toContain("sm:[&amp;_img]:max-h-72");
    expect(markup).toContain('alt="Illustrated greeting"');
    expect(markup).toContain("<strong>hola</strong>");
    expect(markup).not.toContain("src=");
    expect(markup.indexOf('alt="Illustrated greeting"'))
      .toBeLessThan(markup.indexOf("<strong>hola</strong>"));
  });

  test("preserves template image order and turns sound references into invisible autoplay media", () => {
    const rendered = attachMediaObjectUrls(
      '<img alt="first" data-anki-media-ref="first.png"><p>Card text</p><span class="anki-sound" data-anki-media-ref="voice.mp3">voice.mp3</span>',
      new Map([
        ["first.png", "blob:https://example.test/image"],
        ["voice.mp3", "blob:https://example.test/audio"],
      ]),
    );

    expect(rendered.indexOf('alt="first"')).toBeLessThan(rendered.indexOf("Card text"));
    expect(rendered).toContain('src="blob:https://example.test/image"');
    expect(rendered).toContain('<audio autoplay data-anki-autoplay src="blob:https://example.test/audio"></audio>');
    expect(rendered).not.toContain("voice.mp3</span>");
  });

  test("scopes APKG styles and cleans legacy dictionary labels without horizontal overflow", () => {
    const markup = renderToStaticMarkup(
      <CardContent
        css=".card{color:navy}img{width:400px}"
        html="<p>one</p>大辞林ウィズダム類語辞典EBPocketjishoweblio"
        mediaRefs={[]}
      />,
    );

    expect(scopeCardCss(".card,img{max-width:100%}"))
      .toBe("[data-anki-card-template] .card,[data-anki-card-template] img{max-width:100%}");
    expect(cleanLegacyCardHtml("one 大辞林ウィズダム類語辞典EBPocketjishoweblio 35"))
      .toBe("one  35");
    expect(markup).toContain("[data-anki-card-template] .card{color:navy}");
    expect(markup).toContain("overflow-x-hidden");
    expect(markup).not.toContain("EBPocket");
  });
});
