"use client";

import { useEffect, useRef, useState } from "react";

import {
  createDiagnosticCounterController,
  diagnosticToolName,
  inspectWebMcpOriginTrial,
  probeWebMcpSurface,
  type DiagnosticCounterController,
  type WebMcpCapability,
  type WebMcpOriginTrialStatus,
} from "../lib/webmcp";

type RootProbeState = {
  kind: "checking" | "native-ready" | "native-unavailable" | "native-error";
  originTrial: WebMcpOriginTrialStatus;
  error: string | null;
};

const initialState: RootProbeState = {
  kind: "checking",
  originTrial: "unknown",
  error: null,
};

function capabilityForProbe(
  probe: ReturnType<typeof probeWebMcpSurface>,
): WebMcpCapability {
  return probe.kind === "available"
    ? { kind: "available" }
    : { kind: probe.kind };
}

function describeRegistrationError(error: unknown): string {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function statusPresentation(state: RootProbeState) {
  switch (state.kind) {
    case "checking":
      return {
        className: "status-warning",
        role: "status" as const,
        text: (
          <>
            <strong>Checking native WebMCP:</strong> The page is probing the
            browser API and will report the result without loading a flag,
            mock, extension, or polyfill.
          </>
        ),
      };
    case "native-ready":
      return {
        className: "status-success",
        role: "status" as const,
        text: (
          <>
            <strong>Native WebMCP ready:</strong> The root diagnostic tool was
            registered by the browser&apos;s native API. This is a non-production
            in-memory probe.
          </>
        ),
      };
    case "native-unavailable":
      return {
        className: "status-warning",
        role: "status" as const,
        text: (
          <>
            <strong>Native WebMCP unavailable:</strong> No diagnostic tool was
            registered. The page remains usable; a local flag, mock, browser
            extension, or polyfill is not counted as native support.
          </>
        ),
      };
    case "native-error":
      return {
        className: "status-error",
        role: "alert" as const,
        text: (
          <>
            <strong>Native WebMCP error:</strong> The browser exposed the API,
            but rejected the diagnostic registration. Human navigation remains
            available; reload after correcting the browser or deployment
            configuration.
            {state.error ? (
              <span className="status-detail"> ({state.error})</span>
            ) : null}
          </>
        ),
      };
  }
}

export function RootWebMcpProbe() {
  const [state, setState] = useState<RootProbeState>(initialState);
  const [counter, setCounter] = useState(0);
  const activeRef = useRef(false);
  const controllerRef = useRef<DiagnosticCounterController | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = createDiagnosticCounterController(
      setCounter,
      () => activeRef.current,
    );
  }
  const diagnosticController = controllerRef.current;
  if (diagnosticController === null) {
    throw new Error("The root diagnostic controller could not be initialized.");
  }
  const diagnosticTool = diagnosticController.tool;

  useEffect(() => {
    activeRef.current = true;
    const probe = probeWebMcpSurface(document);
    const capability = capabilityForProbe(probe);
    const originTrial = inspectWebMcpOriginTrial(document, capability);

    if (probe.kind === "unavailable") {
      setState({ kind: "native-unavailable", originTrial, error: null });
      return () => {
        activeRef.current = false;
      };
    }

    if (probe.kind === "error") {
      setState({
        kind: "native-error",
        originTrial,
        error: probe.error,
      });
      return () => {
        activeRef.current = false;
      };
    }

    const registrationController = new AbortController();
    let registrationTimedOut = false;
    const registrationTimeout = window.setTimeout(() => {
      if (!activeRef.current) {
        return;
      }

      registrationTimedOut = true;
      registrationController.abort();
      setState({
        kind: "native-error",
        originTrial,
        error: "registerTool did not settle within 5 seconds.",
      });
    }, 5_000);

    void (async () => {
      try {
        await probe.modelContext.registerTool(diagnosticTool, {
          signal: registrationController.signal,
        });
        if (activeRef.current && !registrationTimedOut) {
          setState({ kind: "native-ready", originTrial, error: null });
        }
      } catch (error) {
        if (activeRef.current && !registrationTimedOut) {
          setState({
            kind: "native-error",
            originTrial,
            error: describeRegistrationError(error),
          });
        }
      } finally {
        window.clearTimeout(registrationTimeout);
      }
    })();

    return () => {
      activeRef.current = false;
      window.clearTimeout(registrationTimeout);
      registrationController.abort();
    };
  }, [diagnosticTool]);

  const presentation = statusPresentation(state);
  const toolRegistered = state.kind === "native-ready";

  return (
    <>
      <section
        className="capability-card"
        aria-labelledby="webmcp-capability-title"
        data-webmcp-capability={state.kind}
        data-webmcp-origin-trial={state.originTrial}
      >
        <h2 id="webmcp-capability-title">Native WebMCP capability</h2>
        <p className={`status ${presentation.className}`} role={presentation.role}>
          {presentation.text}
        </p>
        <dl className="probe-details">
          <div>
            <dt>Runtime mode</dt>
            <dd data-webmcp-runtime-mode={state.kind}>{state.kind}</dd>
          </div>
          <div>
            <dt>Origin-trial status</dt>
            <dd data-webmcp-origin-trial-value={state.originTrial}>
              {state.originTrial}
            </dd>
          </div>
        </dl>
      </section>

      <section className="route-card probe-card" aria-labelledby="probe-title">
        <h2 id="probe-title">Root route diagnostic probe</h2>
        <p>
          This bounded probe has no deck, card, persistence, network, or
          production Anki side effects. It is registered only while this root
          route is active and is absent when native WebMCP is unavailable.
        </p>
        <dl className="probe-details">
          <div>
            <dt>In-memory counter</dt>
            <dd>
              <output id="diagnostic-counter" data-diagnostic-counter>
                {counter}
              </output>
            </dd>
          </div>
          <div>
            <dt>Native tool</dt>
            <dd>
              {toolRegistered ? (
                <code data-webmcp-tool-name={diagnosticToolName}>
                  {diagnosticToolName}
                </code>
              ) : (
                <span data-webmcp-tool-name="">Not registered</span>
              )}
            </dd>
          </div>
        </dl>
        <p className="probe-contract">
          When ready, a valid call accepts <code>amount</code> from 1 through
          10 and a unique <code>command_id</code>. It returns structured
          <code>status</code>, <code>code</code>, <code>route</code>,
          <code>command</code>, <code>command_id</code>, <code>amount</code>,
          and <code>counter</code> fields. Invalid input and duplicate command
          IDs leave the counter unchanged.
        </p>
      </section>
    </>
  );
}
