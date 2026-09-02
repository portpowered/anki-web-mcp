"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  openStudyRouteService,
  type BrowserStudyRouteService,
  type StudyRouteSnapshot,
} from "../lib/application/study-route-service";
import { readDeckQuery, type DeckQueryState } from "../lib/diagnostic";
import { Phase0Diagnostics } from "./phase0-diagnostics";
import { StudyPage, type StudyPageState, type StudyRating } from "./study";
import { ProductionShell } from "./production-shell";

const STUDY_LOAD_ERROR = "Your saved study is temporarily unavailable.";

type StudyRouteView = {
  readonly deckId: string;
  readonly deck: {
    readonly name: string;
    readonly sessionSequence?: number | null;
    readonly currentCardId?: string | null;
  };
  readonly progress: { readonly current: number; readonly total: number };
  readonly state: StudyPageState;
  readonly sessionId: string | null;
  readonly cardId: string | null;
  readonly wakeAt: number | null;
};

type FocusTarget = "rate" | "toggle";

export function StudyRoutePreview() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<StudyRouteView>(() => loadingStudyView());
  const [deckQuery, setDeckQuery] = useState<DeckQueryState>({
    kind: "missing",
    value: null,
  });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const serviceRef = useRef<BrowserStudyRouteService | null>(null);
  const focusTargetRef = useRef<FocusTarget | null>(null);
  const busyRef = useRef(false);

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
        serviceRef.current = service;
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

  useEffect(() => {
    if (view.state.kind !== "waiting" || view.wakeAt === null) return;
    const remaining = Math.max(0, view.wakeAt - Date.now());
    const timer = window.setTimeout(
      () => setLoadAttempt((attempt) => attempt + 1),
      Math.min(remaining + 25, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [view.state.kind, view.wakeAt]);

  useEffect(() => {
    const target = focusTargetRef.current;
    if (!target || busy || view.state.kind !== "active") return;
    focusTargetRef.current = null;
    window.requestAnimationFrame(() => {
      const selector = target === "rate"
        ? '[data-study-rating="again"]'
        : '[data-study-action="toggle"]';
      document.querySelector<HTMLElement>(selector)?.focus();
    });
  }, [busy, view.cardId, view.state]);

  const commitAndRefresh = useCallback(async (
    operation: (
      service: BrowserStudyRouteService,
      sessionId: string,
      cardId: string,
    ) => Promise<unknown>,
    focusTarget: FocusTarget,
  ) => {
    if (busyRef.current || !view.sessionId || !view.cardId || !view.deckId) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    const expectedSessionId = view.sessionId;
    const expectedCardId = view.cardId;
    try {
      const service = serviceRef.current ?? await openStudyRouteService();
      serviceRef.current = service;
      await operation(service, expectedSessionId, expectedCardId);
      const snapshot = await service.load(view.deckId);
      focusTargetRef.current = focusTarget;
      setView(studyViewFromSnapshot(snapshot));
    } catch {
      setActionError("That study action could not be saved. Your previous progress is still safe; try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [view]);

  const reveal = useCallback(() => {
    if (view.state.kind !== "active" || view.state.side !== "front") return;
    void commitAndRefresh(
      (service, sessionId, cardId) => service.reveal(sessionId, cardId),
      "rate",
    );
  }, [commitAndRefresh, view.state]);

  const rate = useCallback((rating: StudyRating) => {
    if (view.state.kind !== "active" || view.state.side !== "back") return;
    const commandId = createCommandId("rate");
    void commitAndRefresh(
      (service, sessionId, cardId) => service.rate(sessionId, cardId, rating, commandId),
      "toggle",
    );
  }, [commitAndRefresh, view.state]);

  const suspend = useCallback(() => {
    if (view.state.kind !== "active") return;
    const commandId = createCommandId("suspend");
    void commitAndRefresh(
      (service, sessionId, cardId) => service.suspend(sessionId, cardId, commandId),
      "toggle",
    );
  }, [commitAndRefresh, view.state]);

  const returnToDecks = useCallback(() => {
    if (!busyRef.current) router.push("/");
  }, [router]);

  const retry = useCallback(() => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  return (
    <ProductionShell>
      <main id="main-content" className="space-y-8">
        <section aria-label="Study" className="space-y-6" data-production-study>
          <StudyPage
            actionError={actionError}
            busy={busy}
            deck={view.deck}
            onRate={rate}
            onRetry={retry}
            onReturnToDecks={returnToDecks}
            onSuspend={suspend}
            onToggle={reveal}
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
      deckId: snapshot.deckId,
      deck: { name: "Study" },
      progress: { current: 0, total: 0 },
      state: {
        kind: "error",
        reason: "missing-deck",
        message: "That deck does not exist or is no longer available.",
      },
      sessionId: null,
      cardId: null,
      wakeAt: null,
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
  const identity = {
    deckId: snapshot.deckId,
    sessionId: snapshot.sessionId,
    cardId: snapshot.kind === "active" ? snapshot.cardId : null,
    wakeAt: snapshot.kind === "waiting" ? snapshot.nextDueAt : null,
  };

  switch (snapshot.kind) {
    case "active":
      return {
        ...identity,
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
        ...identity,
        deck,
        progress,
        state: {
          kind: "waiting",
          nextCardIn: formatDuration(snapshot.nextDueAt - snapshot.capturedAt),
        },
      };
    case "completion":
      return {
        ...identity,
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
      return { ...identity, deck, progress, state: { kind: "caught-up" } };
  }
}

function loadingStudyView(): StudyRouteView {
  return {
    deckId: "",
    deck: { name: "Study" },
    progress: { current: 0, total: 0 },
    state: { kind: "loading" },
    sessionId: null,
    cardId: null,
    wakeAt: null,
  };
}

function missingDeckView(empty: boolean): StudyRouteView {
  return {
    deckId: "",
    deck: { name: "Study" },
    progress: { current: 0, total: 0 },
    state: {
      kind: "error",
      reason: "missing-deck",
      message: empty
        ? "The deck query is empty."
        : "No deck was specified in this study link.",
    },
    sessionId: null,
    cardId: null,
    wakeAt: null,
  };
}

function recoverableErrorView(): StudyRouteView {
  return {
    deckId: "",
    deck: { name: "Study" },
    progress: { current: 0, total: 0 },
    state: { kind: "error", reason: "recoverable", message: STUDY_LOAD_ERROR },
    sessionId: null,
    cardId: null,
    wakeAt: null,
  };
}

function createCommandId(kind: "rate" | "suspend"): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `ui-${kind}-${random}`;
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
