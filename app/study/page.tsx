"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { DiagnosticShell } from "../../components/diagnostic-shell";
import { readDeckQuery } from "../../lib/diagnostic";

export const dynamic = "force-static";

function StudyDiagnostic() {
  const deckQuery = readDeckQuery(useSearchParams());
  const hasDeck = deckQuery.kind === "provided";

  return (
    <DiagnosticShell
      eyebrow="WebMCP Anki / study"
      title="Study route diagnostics"
      webMcp={hasDeck ? "study-probe" : "capability"}
      studyDeck={hasDeck ? deckQuery.value : undefined}
    >
      <section className="route-card" aria-labelledby="study-route-title">
        <h2 id="study-route-title">
          {hasDeck ? "Diagnostic deck query received" : "Deck query needed"}
        </h2>

        {hasDeck ? (
          <>
            <p className="status status-success" role="status">
              <strong>Success:</strong> The study route loaded directly and
              preserved the deck query as display text.
            </p>
            <dl className="query-details">
              <div>
                <dt>Deck query</dt>
                <dd>
                  <code>{deckQuery.value}</code>
                </dd>
              </div>
            </dl>
            <p>
              Query values are treated as untrusted text by this diagnostic;
              they are never interpreted as markup.
            </p>
          </>
        ) : (
          <>
            <p className="status status-error" role="alert">
              <strong>Error:</strong> This static study diagnostic needs a
              non-empty <code>deck</code> query.
            </p>
            <p>
              {deckQuery.kind === "empty"
                ? "The deck query is empty."
                : "No deck query was provided."} This is recoverable; return
              to the root route and open the diagnostic study link.
            </p>
          </>
        )}

        <nav className="route-navigation" aria-label="Diagnostic navigation">
          <Link className="route-link" href="/">
            Return to the root diagnostic
          </Link>
        </nav>
      </section>
    </DiagnosticShell>
  );
}

function StudyDiagnosticFallback() {
  return (
    <DiagnosticShell
      eyebrow="WebMCP Anki / study"
      title="Study route diagnostics"
    >
      <section className="route-card" aria-labelledby="study-route-title">
        <h2 id="study-route-title">Static study route ready</h2>
        <p className="status status-success" role="status">
          <strong>Success:</strong> The study document loaded; its deck query
          is read directly from this URL.
        </p>
        <nav className="route-navigation" aria-label="Diagnostic navigation">
          <Link className="route-link" href="/">
            Return to the root diagnostic
          </Link>
        </nav>
      </section>
    </DiagnosticShell>
  );
}

export default function StudyPage() {
  return (
    <Suspense fallback={<StudyDiagnosticFallback />}>
      <StudyDiagnostic />
    </Suspense>
  );
}
