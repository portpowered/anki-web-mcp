"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { DeckPage, type DeckPageState, type DeckSummary } from "./decks";
import {
  DiagnosticLink,
  DiagnosticNavigation,
  Phase0Diagnostics,
} from "./phase0-diagnostics";
import { ProductionShell } from "./production-shell";
import { Status } from "./ui/status";

export const previewDecks: readonly DeckSummary[] = [
  {
    cardCount: 523,
    icon: "leaf",
    id: "biology",
    lastStudiedLabel: "Studied 2d ago",
    name: "Biology",
  },
  {
    cardCount: 1342,
    icon: "speech",
    id: "spanish-vocabulary",
    lastStudiedLabel: "Studied 1d ago",
    name: "Spanish Vocabulary",
  },
  {
    cardCount: 2034,
    icon: "torii",
    id: "japanese-core-2k",
    lastStudiedLabel: "Studied 3d ago",
    name: "Japanese Core 2k",
  },
  {
    cardCount: 756,
    icon: "column",
    id: "world-history",
    lastStudiedLabel: "Studied 5d ago",
    name: "World History",
  },
  {
    cardCount: 1105,
    icon: "flask",
    id: "chemistry",
    lastStudiedLabel: "Studied 1w ago",
    name: "Chemistry",
  },
  {
    cardCount: 432,
    icon: "quote",
    id: "literature-quotes",
    lastStudiedLabel: "Studied 1w ago",
    name: "Literature Quotes",
  },
] as const;

function diagnosticMessage(action: string): string {
  return `Preview only: ${action} was acknowledged; no deck data changed.`;
}

export function DeckRoutePreview() {
  const router = useRouter();
  const [deckState, setDeckState] = useState<DeckPageState>(() => ({
    decks: previewDecks,
    kind: "populated",
  }));
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);

  useEffect(() => {
    setDeckState(readDeckPreviewState(window.location.search));
  }, []);

  return (
    <ProductionShell>
      <main id="main-content" className="space-y-8">
        <section
          aria-label="Deck preview"
          className="rounded-surface border border-border bg-surface p-4 shadow-surface sm:p-8 lg:p-10"
          data-production-preview="decks"
        >
          <DeckPage
            state={deckState}
            onImport={() =>
              setAcknowledgement(diagnosticMessage("Import Deck"))
            }
            onRetry={() => setAcknowledgement(diagnosticMessage("Try again"))}
            onSelect={(deckId) =>
              router.push(`/study/?deck=${encodeURIComponent(deckId)}`)
            }
            onRemove={(deckId) =>
              setAcknowledgement(
                diagnosticMessage(`Remove ${deckNameForId(deckId)}`),
              )
            }
            onRestoreSuspended={(deckId) =>
              setAcknowledgement(
                diagnosticMessage(
                  `Restore suspended cards in ${deckNameForId(deckId)}`,
                ),
              )
            }
          />

          {acknowledgement ? (
            <Status
              className="mb-0 mt-6"
              data-preview-feedback
              role="status"
              tone="info"
            >
              {acknowledgement}
            </Status>
          ) : null}
        </section>

        <Phase0Diagnostics routeTitle="Static export harness" webMcp="root-probe">
          <section aria-labelledby="root-route-title">
            <h4
              id="root-route-title"
              className="m-0 text-base font-semibold text-navy"
            >
              Root route ready
            </h4>
            <p className="status status-success" role="status">
              <strong>Success:</strong> The root diagnostic loaded as a static
              application document.
            </p>
            <p className="max-w-prose leading-7">
              This harness has no backend. Its navigation and public assets are
              configured for the GitHub Pages project path.
            </p>
            <DiagnosticNavigation>
              <DiagnosticLink
                className="route-link"
                href="/study/?deck=diagnostic"
              >
                Open the study diagnostic
              </DiagnosticLink>
            </DiagnosticNavigation>
          </section>

          <section
            className="route-card secondary-card"
            aria-labelledby="root-error-title"
          >
            <h4
              id="root-error-title"
              className="m-0 text-base font-semibold text-navy"
            >
              Recoverable route errors
            </h4>
            <p className="status status-warning">
              <strong>Unsupported input:</strong> A study URL without a
              non-empty <code>deck</code> query is reported as a recoverable
              error with a return link.
            </p>
          </section>
        </Phase0Diagnostics>
      </main>
    </ProductionShell>
  );
}

function readDeckPreviewState(search: string): DeckPageState {
  switch (new URLSearchParams(search).get("preview")) {
    case "loading":
      return { kind: "loading" };
    case "empty":
      return { kind: "empty" };
    case "error":
      return {
        kind: "error",
        message: "The preview deck list is temporarily unavailable.",
      };
    default:
      return { decks: previewDecks, kind: "populated" };
  }
}

function deckNameForId(deckId: string): string {
  return previewDecks.find((deck) => deck.id === deckId)?.name ?? deckId;
}
