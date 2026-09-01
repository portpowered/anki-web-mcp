"use client";

import { useEffect, useState } from "react";

import {
  openApplicationPersistence,
  type PersistenceSnapshot,
} from "../lib/application/persistence";
import type { DomainError } from "../lib/domain/errors";

type PersistenceDiagnosticsProps = {
  requestedDeckId?: string;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; snapshot: PersistenceSnapshot }
  | { kind: "error"; error: DomainError };

const initialState: ViewState = { kind: "loading" };

export function PersistenceDiagnostics({
  requestedDeckId,
}: PersistenceDiagnosticsProps) {
  const [state, setState] = useState<ViewState>(initialState);
  const [probePending, setProbePending] = useState(false);
  const [probeError, setProbeError] = useState<DomainError | null>(null);

  useEffect(() => {
    let mounted = true;

    void readSnapshot().then((result) => {
      if (!mounted) {
        return;
      }

      setState(result.ok
        ? { kind: "ready", snapshot: result.value }
        : { kind: "error", error: result.error });
    });

    return () => {
      mounted = false;
    };
  }, []);

  async function writeProbe(): Promise<void> {
    setProbePending(true);
    setProbeError(null);
    const opened = await openApplicationPersistence();
    const result = opened.ok
      ? await opened.value.writeRepresentativeStudyState()
      : opened;

    if (result.ok) {
      setState({ kind: "ready", snapshot: result.value });
    } else {
      setProbeError(result.error);
    }
    setProbePending(false);
  }

  return (
    <section
      className="route-card persistence-card"
      aria-labelledby="persistence-title"
      data-persistence-status={state.kind}
      {...(state.kind === "ready" ? { "data-persistence-ready": "true" } : {})}
    >
      <h2 id="persistence-title">Durable IndexedDB foundation</h2>

      {state.kind === "loading" ? (
        <p className="status status-warning" role="status">
          <strong>Initializing:</strong> Opening the versioned database and
          checking the Spanish Basics seed…
        </p>
      ) : state.kind === "error" ? (
        <p className="status status-error" role="alert">
          <strong>Persistence unavailable:</strong> {state.error.message} ({state.error.code})
        </p>
      ) : (
        <>
          <p className="status status-success" role="status">
            <strong>Ready:</strong> IndexedDB is authoritative for the seeded
            deck and study records.
          </p>
          <dl className="persistence-details" data-persistence-records>
            <div>
              <dt>Database</dt>
              <dd><code>{state.snapshot.databaseName}</code> v{state.snapshot.schemaVersion}</dd>
            </div>
            <div>
              <dt>Seed deck</dt>
              <dd data-persistence-seed-deck-id={state.snapshot.deck.id}>
                {state.snapshot.deck.name} · <code>{state.snapshot.deck.id}</code>
              </dd>
            </div>
            <div>
              <dt>Cards / schedules</dt>
              <dd
                data-persistence-card-count={state.snapshot.cards.length}
                data-persistence-schedule-count={state.snapshot.schedules.length}
              >
                {state.snapshot.cards.length} / {state.snapshot.schedules.length}
              </dd>
            </div>
            <div>
              <dt>Durable study records</dt>
              <dd
                data-persistence-session-count={state.snapshot.sessions.length}
                data-persistence-review-log-count={state.snapshot.reviewLogs.length}
              >
                {state.snapshot.sessions.length} sessions · {state.snapshot.reviewLogs.length} review logs
              </dd>
            </div>
            <div>
              <dt>Active-session pointer</dt>
              <dd data-persistence-active-session-id>
                {state.snapshot.activeSessionId ?? "none"}
              </dd>
            </div>
            {requestedDeckId ? (
              <div>
                <dt>Requested deck</dt>
                <dd data-persistence-requested-deck-id>{requestedDeckId}</dd>
              </div>
            ) : null}
          </dl>
          <button
            type="button"
            className="persistence-probe-button"
            data-persistence-probe="write"
            data-persistence-probe-status={state.snapshot.reviewLogs.length > 0 ? "complete" : "idle"}
            disabled={probePending}
            onClick={() => void writeProbe()}
          >
            {probePending ? "Writing study records…" : "Write representative study records"}
          </button>
          {probeError ? (
            <p className="status status-error" role="alert">
              <strong>Study write failed:</strong> {probeError.message} ({probeError.code})
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

async function readSnapshot() {
  const opened = await openApplicationPersistence();
  return opened.ok ? opened.value.readSnapshot() : opened;
}
