"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { readDeckQuery, type DeckQueryState } from "../lib/diagnostic";
import {
  DiagnosticLink,
  DiagnosticNavigation,
  Phase0Diagnostics,
} from "./phase0-diagnostics";
import {
  StudyPage,
  type StudyPageState,
  type FlashcardSide,
  type StudyRating,
} from "./study";
import { ProductionShell } from "./production-shell";
import { Status } from "./ui/status";

const previewRatings = [
  { interval: "< 1 min", rating: "again" },
  { interval: "6 min", rating: "hard" },
  { interval: "10 min", rating: "good" },
  { interval: "4 d", rating: "easy" },
] as const;

function previewAcknowledgement(action: string): string {
  return `Preview only: ${action} was acknowledged; no schedule or session data changed.`;
}

export function StudyRoutePreview() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [hydrated, setHydrated] = useState(false);
  const [deckQuery, setDeckQuery] = useState<DeckQueryState>(() => ({
    kind: "missing" as const,
    value: null,
  }));
  const [side, setSide] = useState<FlashcardSide>("front");
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);

  useEffect(() => {
    setDeckQuery(readDeckQuery(searchParams));
    setHydrated(true);
  }, [searchParams]);

  if (!hydrated) {
    return <StudyRoutePreviewFallback />;
  }

  const hasDeck = deckQuery.kind === "provided";
  const state = getStudyPreviewState(
    deckQuery,
    side,
    searchParams.get("preview"),
  );

  return (
    <ProductionShell>
      <main id="main-content" className="space-y-8">
        <section
          aria-label="Study preview"
          className="space-y-6"
          data-production-preview="study"
        >
          <StudyPage
            deck={{ name: "Spanish Vocabulary" }}
            onRate={(rating: StudyRating) =>
              setAcknowledgement(previewAcknowledgement(ratingLabel(rating)))
            }
            onRetry={() =>
              setAcknowledgement(previewAcknowledgement("Try again"))
            }
            onReturnToDecks={() => router.push("/")}
            onSuspend={() =>
              setAcknowledgement(previewAcknowledgement("Suspend card"))
            }
            onToggle={() => setSide((currentSide) => toggleSide(currentSide))}
            progress={{ current: 15, total: 20 }}
            state={state}
          />

          {acknowledgement ? (
            <Status
              className="mb-0"
              data-preview-feedback
              role="status"
              tone="info"
            >
              {acknowledgement}
            </Status>
          ) : null}
        </section>

        <Phase0Diagnostics
          requestedDeckId={hasDeck ? deckQuery.value : undefined}
          routeTitle="Study route diagnostics"
          webMcp={hasDeck ? "study-probe" : "capability"}
        >
          <section aria-labelledby="study-route-title">
            <h4
              id="study-route-title"
              className="m-0 text-base font-semibold text-navy"
            >
              {hasDeck ? "Diagnostic deck query received" : "Deck query needed"}
            </h4>

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
                <p className="max-w-prose leading-7">
                  Query values are treated as untrusted text by this
                  diagnostic; they are never interpreted as markup.
                </p>
              </>
            ) : (
              <>
                <p className="status status-error" role="alert">
                  <strong>Error:</strong> This static study diagnostic needs a
                  non-empty <code>deck</code> query.
                </p>
                <p className="max-w-prose leading-7">
                  {deckQuery.kind === "empty"
                    ? "The deck query is empty."
                    : "No deck query was provided."} This is recoverable; return
                  to the root route and open the diagnostic study link.
                </p>
              </>
            )}

            <DiagnosticNavigation>
              <DiagnosticLink className="route-link" href="/">
                Return to the root diagnostic
              </DiagnosticLink>
            </DiagnosticNavigation>
          </section>
        </Phase0Diagnostics>
      </main>
    </ProductionShell>
  );
}

export function StudyRoutePreviewFallback() {
  return (
    <ProductionShell>
      <main id="main-content" className="space-y-8">
        <section
          aria-label="Study preview"
          className="space-y-6"
          data-production-preview="study"
        >
          <StudyPage
            deck={{ name: "Spanish Vocabulary" }}
            onRate={() => undefined}
            onReturnToDecks={() => undefined}
            onSuspend={() => undefined}
            onToggle={() => undefined}
            progress={{ current: 15, total: 20 }}
            state={{
              backContent: "house",
              frontContent: "casa",
              kind: "active",
              ratings: previewRatings,
              side: "front",
            }}
          />
        </section>
        <Phase0Diagnostics routeTitle="Study route diagnostics">
          <p className="m-0 leading-7 text-muted">
            Loading the direct-route diagnostic…
          </p>
        </Phase0Diagnostics>
      </main>
    </ProductionShell>
  );
}

function toggleSide(side: FlashcardSide): FlashcardSide {
  return side === "front" ? "back" : "front";
}

function ratingLabel(rating: StudyRating): string {
  return rating.charAt(0).toUpperCase() + rating.slice(1);
}

function getStudyPreviewState(
  deckQuery: DeckQueryState,
  side: FlashcardSide,
  previewMode: string | null,
): StudyPageState {
  if (deckQuery.kind !== "provided") {
    return {
      kind: "error",
      message:
        deckQuery.kind === "empty"
          ? "The deck query is empty."
          : "No deck query was provided.",
      reason: "missing-deck",
    };
  }

  switch (previewMode) {
    case "waiting":
      return { kind: "waiting", nextCardIn: "30 seconds" };
    case "completion":
      return {
        elapsed: "4 minutes",
        kind: "completion",
        nextDue: "Tomorrow at 9:00",
        ratingCounts: { again: 2, hard: 3, good: 9, easy: 6 },
        reviewCount: 20,
      };
    case "caught-up":
    case "empty":
      return previewMode === "empty"
        ? { kind: "empty" }
        : { kind: "caught-up" };
    case "error":
      return {
        kind: "error",
        message: "The preview study is temporarily unavailable.",
        reason: "recoverable",
      };
    default:
      return {
        backContent: <span data-preview-card-content>house</span>,
        frontContent: <span data-preview-card-content>casa</span>,
        kind: "active",
        ratings: previewRatings,
        side,
      };
  }
}
