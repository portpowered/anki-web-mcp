"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  openDeckHomeService,
} from "../lib/application/deck-home-service";
import {
  openStudyRouteService,
  type BrowserStudyRouteService,
  type StudyRouteSnapshot,
} from "../lib/application/study-route-service";
import { createStudyToolController } from "../lib/application/study-webmcp";
import { readDeckQuery, type DeckQueryState } from "../lib/diagnostic";
import { probeWebMcpSurface } from "../lib/webmcp";
import { Phase0Diagnostics } from "./phase0-diagnostics";
import { StudyPage, type StudyPageState, type StudyRating } from "./study";
import { CardContent } from "./study/card-content";
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
  const [studyService, setStudyService] = useState<BrowserStudyRouteService | null>(null);
  const serviceRef = useRef<BrowserStudyRouteService | null>(null);
  const focusTargetRef = useRef<FocusTarget | null>(null);
  const busyRef = useRef(false);
  const routeEpochRef = useRef(0);
  const presentationRef = useRef(studyPresentationKey(view));
  const cardEpochRef = useRef(studyCardEpochKey(view));
  presentationRef.current = studyPresentationKey(view);
  cardEpochRef.current = studyCardEpochKey(view);
  const registrationEpoch = studyCardEpochKey(view);

  useEffect(() => {
    let active = true;
    const routeEpoch = ++routeEpochRef.current;
    setView(loadingStudyView());

    async function hydrateStudy() {
      const nextDeckQuery = readDeckQuery(searchParams);
      if (active && routeEpochRef.current === routeEpoch) setDeckQuery(nextDeckQuery);
      if (nextDeckQuery.kind !== "provided") {
        if (active && routeEpochRef.current === routeEpoch) setView(missingDeckView(nextDeckQuery.kind === "empty"));
        return;
      }

      try {
        const service = await openStudyRouteService();
        serviceRef.current = service;
        if (active && routeEpochRef.current === routeEpoch) setStudyService(service);
        const snapshot = await service.load(nextDeckQuery.value);
        if (active && routeEpochRef.current === routeEpoch) setView(studyViewFromSnapshot(snapshot));
      } catch {
        if (active && routeEpochRef.current === routeEpoch) setView(recoverableErrorView());
      }
    }

    void hydrateStudy();
    return () => {
      active = false;
      if (routeEpochRef.current === routeEpoch) routeEpochRef.current += 1;
    };
  }, [loadAttempt, searchParams]);

  useEffect(() => {
    if (
      !studyService
      || deckQuery.kind !== "provided"
      || window.isSecureContext === false
    ) return;
    const probe = probeWebMcpSurface(document);
    if (probe.kind !== "available") return;

    let active = true;
    const registration = new AbortController();
    const controller = createStudyToolController({
      service: studyService,
      deckId: deckQuery.value,
      publishSnapshot: (snapshot) => {
        if (active) setView(studyViewFromSnapshot(snapshot));
      },
      navigateHome: () => router.push("/"),
      readHomeDeckCount: async () => {
        const opened = await openDeckHomeService();
        if (!opened.ok) throw new Error(opened.error.message);
        const snapshot = await opened.value.readSnapshot();
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        return snapshot.value.decks.length;
      },
      isActive: () => active && cardEpochRef.current === registrationEpoch,
    });

    const routeTools = view.cardId === null
      ? controller.tools.filter((tool) => tool.name === "get_state" || tool.name === "go_home")
      : controller.tools;

    void (async () => {
      try {
        for (const tool of routeTools) {
          if (registration.signal.aborted) return;
          await probe.modelContext.registerTool(tool, { signal: registration.signal });
        }
      } catch {
        registration.abort();
      }
    })();

    return () => {
      active = false;
      registration.abort();
    };
  }, [deckQuery, registrationEpoch, router, studyService, view.cardId]);

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
      canCommit: () => boolean,
    ) => Promise<unknown>,
    focusTarget: FocusTarget,
  ) => {
    if (busyRef.current || !view.sessionId || !view.cardId || !view.deckId) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    const expectedSessionId = view.sessionId;
    const expectedCardId = view.cardId;
    const expectedRouteEpoch = routeEpochRef.current;
    const expectedPresentation = studyPresentationKey(view);
    const canCommit = () => {
      return routeEpochRef.current === expectedRouteEpoch
        && presentationRef.current === expectedPresentation;
    };
    try {
      const service = serviceRef.current ?? await openStudyRouteService();
      serviceRef.current = service;
      await operation(service, expectedSessionId, expectedCardId, canCommit);
      if (!canCommit()) return;
      const snapshot = await service.load(view.deckId);
      if (!canCommit()) return;
      focusTargetRef.current = focusTarget;
      setView(studyViewFromSnapshot(snapshot));
    } catch {
      if (canCommit()) {
        setActionError("That study action could not be saved. Your previous progress is still safe; try again.");
      }
    } finally {
      busyRef.current = false;
      if (canCommit()) setBusy(false);
    }
  }, [view]);

  const toggle = useCallback(() => {
    if (view.state.kind !== "active") return;
    if (view.state.revealed) {
      setActionError(null);
      setView((current) => toggleRevealedSide(current));
      return;
    }
    void commitAndRefresh(
      (service, sessionId, cardId, canCommit) => service.reveal(sessionId, cardId, canCommit),
      "rate",
    );
  }, [commitAndRefresh, view.state]);

  const rate = useCallback((rating: StudyRating) => {
    if (view.state.kind !== "active") return;
    const needsReveal = !view.state.revealed;
    const commandId = createCommandId("rate");
    void commitAndRefresh(
      async (service, sessionId, cardId, canCommit) => {
        if (needsReveal) {
          await service.reveal(sessionId, cardId, canCommit);
          if (!canCommit()) return;
        }
        await service.rate(sessionId, cardId, rating, commandId, canCommit);
      },
      "toggle",
    );
  }, [commitAndRefresh, view.state]);

  const suspend = useCallback(() => {
    if (view.state.kind !== "active") return;
    const commandId = createCommandId("suspend");
    void commitAndRefresh(
      (service, sessionId, cardId, canCommit) => service.suspend(sessionId, cardId, commandId, canCommit),
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
    <ProductionShell deploymentRoute="study">
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
            onToggle={toggle}
            progress={view.progress}
            state={view.state}
          />
        </section>

        <Phase0Diagnostics
          requestedDeckId={deckQuery.kind === "provided" ? deckQuery.value : undefined}
          routeTitle="Static export harness"
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
    <ProductionShell deploymentRoute="study">
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
        <Phase0Diagnostics routeTitle="Static export harness">
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
          revealed: snapshot.side === "back",
          frontContent: renderCardContent(
            snapshot.frontHtml,
            snapshot.frontText,
            snapshot.mediaRefs,
          ),
          backContent: snapshot.backHtml === undefined
            ? ""
            : renderCardContent(
              snapshot.backHtml,
              snapshot.backText ?? "",
              snapshot.mediaRefs,
            ),
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

function renderCardContent(
  html: string,
  text: string,
  mediaRefs: readonly string[],
) {
  return html === text && mediaRefs.length === 0
    ? text
    : <CardContent html={html} mediaRefs={mediaRefs} />;
}

export function toggleRevealedSide(view: StudyRouteView): StudyRouteView {
  if (view.state.kind !== "active" || !view.state.revealed) return view;
  return {
    ...view,
    state: {
      ...view.state,
      side: view.state.side === "front" ? "back" : "front",
    },
  };
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

function studyPresentationKey(view: StudyRouteView): string {
  const side = view.state.kind === "active" ? view.state.side : "none";
  return [
    view.deckId,
    view.sessionId ?? "none",
    view.cardId ?? "none",
    view.state.kind,
    side,
    view.progress.current,
  ].join(":");
}

function studyCardEpochKey(view: StudyRouteView): string {
  return [
    view.deckId,
    view.sessionId ?? "none",
    view.cardId ?? "none",
    view.state.kind,
    view.progress.current,
  ].join(":");
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
