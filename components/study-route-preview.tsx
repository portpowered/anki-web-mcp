"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  openStudyRouteService,
  type StudyRouteSnapshot,
} from "../lib/application/study-route-service";
import { readDeckQuery, type DeckQueryState } from "../lib/diagnostic";
import { Phase0Diagnostics } from "./phase0-diagnostics";
import { StudyPage, type StudyPageState } from "./study";
import { ProductionShell } from "./production-shell";

const STUDY_LOAD_ERROR = "Your saved study is temporarily unavailable.";

type StudyRouteView = {
  readonly deck: {
    readonly name: string;
    readonly sessionSequence?: number | null;
    readonly currentCardId?: string | null;
  };
  readonly progress: { readonly current: number; readonly total: number };
  readonly state: StudyPageState;
};

export function StudyRoutePreview() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<StudyRouteView>(() => loadingStudyView());
  const [deckQuery, setDeckQuery] = useState<DeckQueryState>({
    kind: "missing",
    value: null,
  });
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setView(loadingStudyView());

    async function hydrateStudy() {
      const nextDeckQuery = readDeckQuery(searchParams);
      if (active) setDeckQuery(nextDeckQuery);
      if (nextDeckQuery.kind !== "provided") {
        if (active) setView(missingDeckView(nextDeckQuery.kind === "empty"));
        return;
      }

      try {
        const service = await openStudyRouteService();
        const snapshot = await service.load(nextDeckQuery.value);
        if (active) setView(studyViewFromSnapshot(snapshot));
      } catch {
        if (active) setView(recoverableErrorView());
      }
    }

    void hydrateStudy();
    return () => {
      active = false;
    };
  }, [loadAttempt, searchParams]);

  const retry = useCallback(() => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  return (
    <ProductionShell>
      <main id="main-content" className="space-y-8">
        <section aria-label="Study" className="space-y-6" data-production-study>
          <StudyPage
            deck={view.deck}
            onRate={() => undefined}
            onRetry={retry}
            onReturnToDecks={() => router.push("/")}
            onSuspend={() => undefined}
            onToggle={() => undefined}
            progress={view.progress}
            state={view.state}
          />
        </section>

        <Phase0Diagnostics
          requestedDeckId={deckQuery.kind === "provided" ? deckQuery.value : undefined}
          routeTitle="Static export harness"
          webMcp="study-probe"
        >
          <p className="m-0 leading-7 text-muted">
            Production study state above is restored from IndexedDB. This
            secondary harness reports browser and native bridge capabilities.
          </p>
        </Phase0Diagnostics>
      </main>
    </ProductionShell>
  );
}

export function StudyRoutePreviewFallback() {
  const view = loadingStudyView();
  return (
    <ProductionShell>
      <main id="main-content" className="space-y-8">
        <section aria-label="Study" className="space-y-6" data-production-study>
          <StudyPage
            deck={view.deck}
            onRate={() => undefined}
            onReturnToDecks={() => undefined}
            onSuspend={() => undefined}
            onToggle={() => undefined}
            progress={view.progress}
            state={view.state}
          />
        </section>
        <Phase0Diagnostics routeTitle="Static export harness" webMcp="study-probe">
          <p className="m-0 leading-7 text-muted">
            Production study state above is restored from IndexedDB. This
            secondary harness reports browser and native bridge capabilities.
          </p>
        </Phase0Diagnostics>
      </main>
    </ProductionShell>
  );
}

export function studyViewFromSnapshot(snapshot: StudyRouteSnapshot): StudyRouteView {
  if (snapshot.kind === "missing-deck") {
    return {
      deck: { name: "Study" },
      progress: { current: 0, total: 0 },
      state: {
        kind: "error",
        reason: "missing-deck",
        message: "That deck does not exist or is no longer available.",
      },
    };
  }

  const deck = {
    name: snapshot.deckName,
    sessionSequence: snapshot.sequence,
    currentCardId: snapshot.kind === "active" ? snapshot.cardId : null,
  };
  const progress = {
    current: snapshot.completedPresentationCount,
    total: snapshot.plannedPresentationCount,
  };

  switch (snapshot.kind) {
    case "active":
      return {
        deck,
        progress,
        state: {
          kind: "active",
          side: snapshot.side,
          frontContent: snapshot.frontText,
          backContent: snapshot.backText ?? "",
          ratings: [
            snapshot.ratingPreviews.again,
            snapshot.ratingPreviews.hard,
            snapshot.ratingPreviews.good,
            snapshot.ratingPreviews.easy,
          ].map((preview) => ({
            rating: preview.rating,
            interval: preview.intervalLabel,
          })),
        },
      };
    case "waiting":
      return {
        deck,
        progress,
        state: {
          kind: "waiting",
          nextCardIn: formatDuration(snapshot.nextDueAt - snapshot.capturedAt),
        },
      };
    case "completion":
      return {
        deck,
        progress,
        state: {
          kind: "completion",
          reviewCount: snapshot.completedPresentationCount,
          ratingCounts: snapshot.ratingCounts,
          elapsed: formatDuration(snapshot.completedAt - snapshot.startedAt),
          nextDue: snapshot.nextDueAt === null
            ? null
            : formatDueTime(snapshot.nextDueAt, snapshot.capturedAt),
        },
      };
    case "caught-up":
      return { deck, progress, state: { kind: "caught-up" } };
  }
}

function loadingStudyView(): StudyRouteView {
  return {
    deck: { name: "Study" },
    progress: { current: 0, total: 0 },
    state: { kind: "loading" },
  };
}

function missingDeckView(empty: boolean): StudyRouteView {
  return {
    deck: { name: "Study" },
    progress: { current: 0, total: 0 },
    state: {
      kind: "error",
      reason: "missing-deck",
      message: empty
        ? "The deck query is empty."
        : "No deck was specified in this study link.",
    },
  };
}

function recoverableErrorView(): StudyRouteView {
  return {
    deck: { name: "Study" },
    progress: { current: 0, total: 0 },
    state: { kind: "error", reason: "recoverable", message: STUDY_LOAD_ERROR },
  };
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function formatDueTime(dueAt: number, capturedAt: number): string {
  if (dueAt <= capturedAt) return "Now";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(dueAt));
}
