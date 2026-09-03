import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProductionShell } from "../production-shell";
import { Button } from "./button";
import { Card, CardContent, CardHeader } from "./card";
import { Status } from "./status";

describe("local visual primitives", () => {
  test("renders a semantic button with composable classes and a forwarded ref", () => {
    const ref = createRef<HTMLButtonElement>();
    const markup = renderToStaticMarkup(
      <Button ref={ref} className="test-class" variant="secondary">
        Import Deck
      </Button>,
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).toContain("test-class");
    expect(markup).toContain("border-border");
    expect(markup).toContain(">Import Deck</button>");
  });

  test("renders surfaces and semantic status text as composition primitives", () => {
    const markup = renderToStaticMarkup(
      <Card aria-labelledby="status-title">
        <CardHeader>
          <h2 id="status-title">Import status</h2>
        </CardHeader>
        <CardContent>
          <Status tone="error">The package could not be read.</Status>
        </CardContent>
      </Card>,
    );

    expect(markup).toContain("<section");
    expect(markup).toContain('aria-labelledby="status-title"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The package could not be read.");
  });

  test("provides the responsive shell and content skip action", () => {
    const markup = renderToStaticMarkup(
      <ProductionShell deploymentRoute="deck-home">
        <main id="main-content">Preview</main>
      </ProductionShell>,
    );

    expect(markup).toContain("flex min-h-dvh flex-col bg-background");
    expect(markup).toContain("webmcp-anki-background.jpg");
    expect(markup).toContain('data-deployment-route="deck-home"');
    expect(markup).toContain("max-w-[76rem]");
    expect(markup).toContain("mx-auto flex min-h-dvh w-full");
    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain("Skip to content");
  });
});
