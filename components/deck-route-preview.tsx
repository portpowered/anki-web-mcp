"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  openDeckHomeService,
  type DeckHomeSnapshot,
} from "../lib/application/deck-home-service";
import { DeckPage, type DeckPageState } from "./decks";
import {
  DiagnosticLink,
  DiagnosticNavigation,
  Phase0Diagnostics,
} from "./phase0-diagnostics";
import { ProductionShell } from "./production-shell";
import { Status } from "./ui/status";

const DECK_LOAD_ERROR = "Your saved decks are temporarily unavailable.";

export function DeckRoute() {
  const router = useRouter();
  const [deckState, setDeckState] = useState<DeckPageState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;

    async function loadDecks() {
      setDeckState({ kind: "loading" });
      setNotice(null);

      const opened = await openDeckHomeService();
      if (!active) return;
      if (!opened.ok) {
        setDeckState({ kind: "error", message: DECK_LOAD_ERROR });
        return;
      }

      const snapshot = await opened.value.readSnapshot();
      if (!active) return;
      setDeckState(
        snapshot.ok
          ? deckPageStateFromSnapshot(snapshot.value)
          : { kind: "error", message: DECK_LOAD_ERROR },
      );
    }

    void loadDecks();
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const retry = useCallback(() => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  return (
    <ProductionShell>
      <main id="main-content" className="space-y-8">
        <section
          aria-label="Decks"
          className="rounded-surface border border-border bg-surface p-4 shadow-surface sm:p-8 lg:p-10"
        >
          <DeckPage
            state={deckState}
            onImport={() => setNotice("Deck import is not available in this release.")}
            onRetry={retry}
            onSelect={(deckId) =>
              router.push(`/study/?deck=${encodeURIComponent(deckId)}`)
            }
            onRemove={() => setNotice("Deck removal is not available in this release.")}
            onRestoreSuspended={() =>
              setNotice("Suspended-card restoration is not available yet.")
            }
          />

          {notice ? (
            <Status className="mb-0 mt-6" role="status" tone="info">
              {notice}
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
              The production deck list above is stored in IndexedDB. This
              secondary harness checks static routing and browser capabilities.
            </p>
            <DiagnosticNavigation>
              <DiagnosticLink className="route-link" href="/study/?deck=diagnostic">
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

export function deckPageStateFromSnapshot(
  snapshot: DeckHomeSnapshot,
): DeckPageState {
  if (snapshot.decks.length === 0) return { kind: "empty" };

  return {
    kind: "populated",
    decks: snapshot.decks.map((deck) => ({
      id: deck.id,
      name: deck.name,
      cardCount: deck.cardCount,
      dueCount: deck.dueCount,
      suspendedCount: deck.suspendedCount,
      lastStudiedLabel: formatLastStudied(deck.lastStudiedAt, snapshot.capturedAt),
    })),
  };
}

export function formatLastStudied(
  lastStudiedAt: number | null,
  capturedAt: number,
): string {
  if (lastStudiedAt === null) return "Not studied yet";

  const elapsedDays = Math.max(
    0,
    Math.floor((capturedAt - lastStudiedAt) / 86_400_000),
  );
  if (elapsedDays === 0) return "Studied today";
  if (elapsedDays === 1) return "Studied 1d ago";
  return `Studied ${elapsedDays}d ago`;
}
