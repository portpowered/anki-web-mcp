"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import type { DeckRemovalPreview } from "../../lib/application/deck-removal-service";
import { Button } from "../ui/button";
import { Status } from "../ui/status";

export type DeckRemovalDialogState =
  | { readonly kind: "loading"; readonly deckId: string; readonly deckName: string }
  | { readonly kind: "preview-error"; readonly deckId: string; readonly deckName: string }
  | { readonly kind: "ready"; readonly preview: DeckRemovalPreview }
  | { readonly kind: "committing"; readonly preview: DeckRemovalPreview }
  | {
      readonly kind: "commit-error";
      readonly preview: DeckRemovalPreview;
      readonly reason: "stale" | "not-found" | "failed";
    }
  | { readonly kind: "success"; readonly preview: DeckRemovalPreview };

export type DeckRemovalDialogProps = {
  readonly state: DeckRemovalDialogState;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onRetryPreview: () => void;
};

function removalDeckName(state: DeckRemovalDialogState): string {
  return "preview" in state ? state.preview.deckName : state.deckName;
}

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Keep keyboard focus in the modal and make Escape the safe cancel action. */
export function trapRemovalDialogFocus(
  event: Pick<ReactKeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  dialog: HTMLElement | null,
  onCancel: () => void,
  dismissible = true,
): void {
  if (event.key === "Escape" && dismissible) {
    event.preventDefault();
    onCancel();
    return;
  }
  if (event.key !== "Tab" || !dialog) return;

  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter((element) => !element.hasAttribute("disabled"));
  if (controls.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = controls[0]!;
  const last = controls[controls.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

export function DeckRemovalDialog({
  state,
  onCancel,
  onConfirm,
  onRetryPreview,
}: DeckRemovalDialogProps) {
  const generatedId = useId().replace(/:/g, "");
  const headingId = `deck-removal-heading-${generatedId}`;
  const descriptionId = `deck-removal-description-${generatedId}`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const dismissible = state.kind !== "committing";

  useEffect(() => {
    setPortalHost(document.body);
  }, []);

  useEffect(() => {
    cancelRef.current?.focus();
  }, [portalHost, state.kind]);

  const preview = "preview" in state ? state.preview : null;
  const deckName = removalDeckName(state);

  const dialog = (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={headingId}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-navy/80 p-3 sm:p-6"
      data-deck-removal-dialog={state.kind}
      onKeyDown={(event) =>
        trapRemovalDialogFocus(event, dialogRef.current, onCancel, dismissible)
      }
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onCancel();
      }}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="w-full min-w-0 max-w-lg overflow-hidden rounded-surface border border-border bg-surface p-5 shadow-surface sm:p-6">
        <h2 id={headingId} className="m-0 break-words text-xl font-semibold text-navy">
          Remove {deckName}?
        </h2>
        <div id={descriptionId} className="mt-3 space-y-3">
          {state.kind === "loading" ? (
            <Status role="status" tone="info">
              Checking exactly what will be removed…
            </Status>
          ) : null}
          {state.kind === "preview-error" ? (
            <Status role="alert" tone="error">
              Removal details could not be loaded. Try again, or cancel to keep this deck.
            </Status>
          ) : null}
          {preview ? (
            <p className="m-0 break-words leading-7 text-muted">
              This permanently deletes the deck and its saved study progress. This cannot be undone.
            </p>
          ) : null}
          {state.kind === "committing" ? (
            <Status role="status" tone="info">Removing this deck…</Status>
          ) : null}
          {state.kind === "commit-error" ? (
            <Status role="alert" tone="error">
              {state.reason === "stale"
                ? "This deck changed after the details were loaded. Review refreshed details before trying again."
                : "The deck could not be removed. Nothing was changed. Try again, or cancel to keep this deck."}
            </Status>
          ) : null}
          {state.kind === "success" ? (
            <Status role="status" tone="success">The deck was removed.</Status>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            data-deck-action={state.kind === "success" ? "close-removal" : "cancel-removal"}
            disabled={!dismissible}
            onClick={onCancel}
            ref={cancelRef}
            variant="primary"
          >
            {state.kind === "success" ? "Close" : "Cancel"}
          </Button>
          {state.kind === "ready" ? (
            <Button
              data-deck-action="confirm-removal"
              onClick={onConfirm}
              variant="destructive"
            >
              Remove deck
            </Button>
          ) : null}
          {state.kind === "preview-error" || state.kind === "commit-error" ? (
            <Button data-deck-action="retry-removal" onClick={onRetryPreview}>
              Reload removal details
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );

  return portalHost ? createPortal(dialog, portalHost) : dialog;
}
