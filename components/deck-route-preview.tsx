"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DeckRemovalCommitController,
  DeckHomeSnapshotRefreshController,
  openDeckHomeService,
  type BrowserDeckHomeService,
  type DeckHomeSnapshot,
} from "../lib/application/deck-home-service";
import type { DeckRemovalPreview } from "../lib/application/deck-removal-service";
import {
  createHomeToolController,
  restoreSuspendedAndReadSnapshot,
  selectDeckAndNavigate,
} from "../lib/application/home-webmcp";
import {
  createImportProgressController,
  type ImportProgressController,
  type ImportProgressPresentation,
} from "../lib/application/import-intake-controller";
import { probeWebMcpSurface } from "../lib/webmcp";
import {
  DeckPage,
  type DeckPageState,
  type DeckRemovalDialogState,
} from "./decks";
import { ProductionShell } from "./production-shell";
import { Status } from "./ui/status";

const DECK_LOAD_ERROR = "Your saved decks are temporarily unavailable.";
const DECK_SELECT_ERROR = "That deck could not be opened. Please try again.";
const RESTORE_ERROR = "Suspended cards could not be restored. Please try again.";
const IMPORT_START_ERROR = "That file could not be opened. Choose another .apkg file.";

export function DeckRoute() {
  const router = useRouter();
  const [deckState, setDeckState] = useState<DeckPageState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [homeService, setHomeService] = useState<BrowserDeckHomeService | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgressPresentation>({
    kind: "idle",
  });
  const [removalState, setRemovalState] = useState<DeckRemovalDialogState | null>(null);
  const serviceRef = useRef<BrowserDeckHomeService | null>(null);
  const importControllerRef = useRef<ImportProgressController | null>(null);
  const snapshotRefreshRef = useRef<DeckHomeSnapshotRefreshController | null>(null);
  if (!snapshotRefreshRef.current) {
    snapshotRefreshRef.current = new DeckHomeSnapshotRefreshController();
  }
  const operationRef = useRef<"select" | "restore" | null>(null);
  const mountedRef = useRef(false);
  const removalOperationRef = useRef(0);
  const removalCommitControllerRef = useRef<{
    readonly service: BrowserDeckHomeService;
    readonly controller: DeckRemovalCommitController;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      snapshotRefreshRef.current?.invalidate();
    };
  }, []);

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

      serviceRef.current = opened.value;
      setHomeService(opened.value);
      const result = await snapshotRefreshRef.current?.refresh(
        opened.value,
        (snapshot) => {
          if (active) setDeckState(deckPageStateFromSnapshot(snapshot));
        },
      );
      if (active && result === "failed") {
        setDeckState({ kind: "error", message: DECK_LOAD_ERROR });
      }
    }

    void loadDecks();
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  useEffect(() => {
    if (!homeService) return;
    const controller = createImportProgressController(
      { start: homeService.importFile },
      {
        onDurableSuccess: async () => {
          const result = await snapshotRefreshRef.current?.refresh(
            homeService,
            (snapshot) => {
              if (mountedRef.current) setDeckState(deckPageStateFromSnapshot(snapshot));
            },
          );
          if (mountedRef.current && result === "failed") setNotice(DECK_LOAD_ERROR);
        },
      },
    );
    importControllerRef.current = controller;
    const unsubscribe = controller.subscribe(setImportProgress);
    return () => {
      unsubscribe();
      controller.dispose();
      if (importControllerRef.current === controller) importControllerRef.current = null;
    };
  }, [homeService]);

  useEffect(() => {
    if (!homeService || window.isSecureContext === false) return;
    const probe = probeWebMcpSurface(document);
    if (probe.kind !== "available") return;

    let active = true;
    const registration = new AbortController();
    const controller = createHomeToolController({
      service: homeService,
      navigate: (href) => router.push(href),
      publishSnapshot: (snapshot) => {
        if (active) setDeckState(deckPageStateFromSnapshot(snapshot));
      },
      isActive: () => active,
    });

    void (async () => {
      try {
        for (const tool of controller.tools) {
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
  }, [homeService, router]);

  const retry = useCallback(() => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const selectDeck = useCallback(async (deckId: string) => {
    if (operationRef.current !== null) return;
    operationRef.current = "select";
    setNotice("Preparing your study session…");

    try {
      const service = serviceRef.current;
      if (!service) throw new Error("Deck service is not ready.");
      await selectDeckAndNavigate(service, deckId, (href) => {
        if (mountedRef.current) router.push(href);
      });
    } catch {
      if (mountedRef.current) setNotice(DECK_SELECT_ERROR);
    } finally {
      operationRef.current = null;
    }
  }, [router]);

  const restoreSuspended = useCallback(async (deckId: string) => {
    if (operationRef.current !== null) return;
    operationRef.current = "restore";
    setNotice("Restoring suspended cards…");

    try {
      const service = serviceRef.current;
      if (!service) throw new Error("Deck service is not ready.");
      const { result, snapshot } = await restoreSuspendedAndReadSnapshot(
        service,
        deckId,
        createCommandId(),
        () => mountedRef.current,
      );
      if (!mountedRef.current) return;
      setDeckState(deckPageStateFromSnapshot(snapshot));
      setNotice(
        result.restoredCount === 0
          ? "No suspended cards needed restoring."
          : `Restored ${result.restoredCount} suspended ${result.restoredCount === 1 ? "card" : "cards"}.`,
      );
    } catch {
      if (mountedRef.current) setNotice(RESTORE_ERROR);
    } finally {
      operationRef.current = null;
    }
  }, []);

  const importFile = useCallback(async (file: File) => {
    const controller = importControllerRef.current;
    if (!controller) {
      setNotice(IMPORT_START_ERROR);
      return;
    }

    setNotice(null);
    try {
      await controller.start(file);
    } catch {
      if (mountedRef.current) setNotice(IMPORT_START_ERROR);
    }
  }, []);

  const cancelImport = useCallback(() => {
    importControllerRef.current?.cancel();
  }, []);

  const cancelDuplicate = useCallback(() => {
    importControllerRef.current?.cancelDuplicate();
  }, []);

  const replaceDuplicate = useCallback(async () => {
    try {
      await importControllerRef.current?.confirmDuplicateReplacement();
    } catch {
      if (mountedRef.current) setNotice(IMPORT_START_ERROR);
    }
  }, []);

  const retryReplacement = useCallback(async () => {
    try {
      await importControllerRef.current?.retryReplacement();
    } catch {
      if (mountedRef.current) setNotice(IMPORT_START_ERROR);
    }
  }, []);

  const retryImport = useCallback(async () => {
    try {
      await importControllerRef.current?.retryImport();
    } catch {
      if (mountedRef.current) setNotice(IMPORT_START_ERROR);
    }
  }, []);

  const dismissImport = useCallback(() => {
    importControllerRef.current?.dismiss();
  }, []);

  const loadRemovalPreview = useCallback(async (deckId: string, deckName: string) => {
    const operation = ++removalOperationRef.current;
    setRemovalState({ kind: "loading", deckId, deckName });
    const service = serviceRef.current;
    const result = service
      ? await service.previewRemoval(deckId)
      : { status: "failed" as const };
    if (!mountedRef.current || operation !== removalOperationRef.current) return;
    setRemovalState(result.status === "ready"
      ? { kind: "ready", preview: result.preview }
      : { kind: "preview-error", deckId, deckName });
  }, []);

  const requestRemoval = useCallback((deckId: string) => {
    const deckName = deckState.kind === "populated"
      ? deckState.decks.find((deck) => deck.id === deckId)?.name ?? "this deck"
      : "this deck";
    void loadRemovalPreview(deckId, deckName);
  }, [deckState, loadRemovalPreview]);

  const dismissRemoval = useCallback(() => {
    removalOperationRef.current += 1;
    setRemovalState(null);
  }, []);

  const retryRemovalPreview = useCallback(() => {
    if (!removalState) return;
    if ("preview" in removalState) {
      void loadRemovalPreview(removalState.preview.deckId, removalState.preview.deckName);
    } else {
      void loadRemovalPreview(removalState.deckId, removalState.deckName);
    }
  }, [loadRemovalPreview, removalState]);

  const confirmRemoval = useCallback(async () => {
    if (removalState?.kind !== "ready") return;
    const preview = removalState.preview;
    const operation = ++removalOperationRef.current;
    setRemovalState({ kind: "committing", preview });
    const service = serviceRef.current;
    if (service && removalCommitControllerRef.current?.service !== service) {
      removalCommitControllerRef.current = {
        service,
        controller: new DeckRemovalCommitController(
          service,
          snapshotRefreshRef.current!,
        ),
      };
    }
    const result = removalCommitControllerRef.current
      ? await removalCommitControllerRef.current.controller.confirm(
          preview,
          (snapshot) => {
            if (mountedRef.current) setDeckState(deckPageStateFromSnapshot(snapshot));
          },
        )
      : { status: "failed" as const };
    if (!mountedRef.current || operation !== removalOperationRef.current) return;
    if (result.status === "committed" && result.refresh === "failed") {
      setNotice(DECK_LOAD_ERROR);
    }
    setRemovalState(result.status === "committed"
      ? { kind: "success", preview }
      : { kind: "commit-error", preview, reason: result.status });
  }, [removalState]);

  return (
    <ProductionShell deploymentRoute="deck-home">
      <main id="main-content" className="space-y-8">
        <section
          aria-label="Decks"
          className="rounded-surface border border-border bg-surface/90 p-4 shadow-surface sm:p-8 lg:p-10"
        >
          <DeckPage
            state={deckState}
            importProgress={importProgress}
            removalState={removalState}
            onCancelImport={cancelImport}
            onCancelDuplicate={cancelDuplicate}
            onCancelRemoval={dismissRemoval}
            onImport={(file) => void importFile(file)}
            onDismissImport={dismissImport}
            onReplaceDuplicate={() => void replaceDuplicate()}
            onRetryImport={() => void retryImport()}
            onRetryReplacement={() => void retryReplacement()}
            onRetry={retry}
            onSelect={(deckId) => void selectDeck(deckId)}
            onRemove={requestRemoval}
            onConfirmRemoval={() => void confirmRemoval()}
            onRetryRemovalPreview={retryRemovalPreview}
            onRestoreSuspended={(deckId) => void restoreSuspended(deckId)}
          />

          {notice ? (
            <Status className="mb-0 mt-6" role="status" tone="info">
              {notice}
            </Status>
          ) : null}
        </section>

      </main>
    </ProductionShell>
  );
}

function createCommandId(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `restore-${suffix}`;
}

export { selectDeckAndNavigate } from "../lib/application/home-webmcp";

export function confirmDeckRemovalOnce(
  service: Pick<BrowserDeckHomeService, "confirmRemoval">,
  preview: DeckRemovalPreview,
) {
  return service.confirmRemoval(preview);
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
      newCount: deck.newCount,
      dueCount: deck.dueCount,
      suspendedCount: deck.suspendedCount,
    })),
  };
}
