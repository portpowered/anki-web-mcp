"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  classifyWebMcpRegistrationError,
  createStudyDiagnosticController,
  inspectWebMcpEnvironment,
  probeWebMcpSurface,
  type StudyDiagnosticState,
  type WebMcpCapability,
  type WebMcpContextKind,
  type WebMcpFailureCode,
  type WebMcpPermissionsPolicyStatus,
  type WebMcpOriginTrialStatus,
} from "../lib/webmcp";

type StudyProbeState = {
  kind: "checking" | "native-ready" | "native-unavailable" | "native-error";
  originTrial: WebMcpOriginTrialStatus;
  context: WebMcpContextKind;
  permissionsPolicy: WebMcpPermissionsPolicyStatus;
  failureCode: WebMcpFailureCode | null;
  origin: string | null;
  error: string | null;
};

const initialState: StudyProbeState = {
  kind: "checking",
  originTrial: "unknown",
  context: "unknown",
  permissionsPolicy: "unknown",
  failureCode: null,
  origin: null,
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

function statusPresentation(state: StudyProbeState) {
  switch (state.kind) {
    case "checking":
      return {
        className: "status-warning",
        role: "status" as const,
        text: (
          <>
            <strong>Checking native WebMCP:</strong> The study route is
            probing the browser API without loading a flag, mock, extension,
            or polyfill.
          </>
        ),
      };
    case "native-ready":
      return {
        className: "status-success",
        role: "status" as const,
        text: (
          <>
            <strong>Native WebMCP ready:</strong> The study diagnostic tool was
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
            <strong>Native WebMCP unavailable:</strong> No study diagnostic
            tool was registered. The route remains usable; a local flag, mock,
            browser extension, or polyfill is not counted as native support.
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
            but rejected the study diagnostic registration. Human navigation
            remains available; reload after correcting the browser or
            deployment configuration.
            {state.failureCode ? (
              <span className="status-detail">
                {" "}Classification: <code>{state.failureCode}</code>.
              </span>
            ) : null}
            {state.error ? (
              <span className="status-detail"> ({state.error})</span>
            ) : null}
          </>
        ),
      };
  }
}

export function StudyWebMcpProbe({ deck }: { deck: string }) {
  const [state, setState] = useState<StudyProbeState>(initialState);
  const [diagnosticState, setDiagnosticState] = useState<StudyDiagnosticState>({
    deck,
    side: "front",
    lastCommandId: null,
    mutationCount: 0,
  });
  const activeRef = useRef(false);
  const diagnosticController = useMemo(
    () =>
      createStudyDiagnosticController(
        deck,
        setDiagnosticState,
        () => activeRef.current,
      ),
    [deck],
  );
  const diagnosticTool = diagnosticController.tool;

  useEffect(() => {
    activeRef.current = true;
    setDiagnosticState({
      deck,
      side: "front",
      lastCommandId: null,
      mutationCount: 0,
    });

    const probe = window.isSecureContext === false
      ? ({ kind: "unavailable" } as const)
      : probeWebMcpSurface(document);
    const capability = capabilityForProbe(probe);
    const environment = inspectWebMcpEnvironment(
      document,
      capability,
      window.isSecureContext,
    );
    const environmentState = {
      originTrial: environment.originTrial,
      context: environment.context,
      permissionsPolicy: environment.permissionsPolicy,
      origin: environment.origin,
    };

    if (environment.context === "insecure") {
      setState({
        kind: "native-error",
        ...environmentState,
        failureCode: "insecure-context",
        error: "Native WebMCP requires a secure context.",
      });
      return () => {
        activeRef.current = false;
      };
    }

    if (probe.kind === "unavailable") {
      setState({
        kind: "native-unavailable",
        ...environmentState,
        failureCode: "native-unavailable",
        error: null,
      });
      return () => {
        activeRef.current = false;
      };
    }

    if (probe.kind === "error") {
      setState({
        kind: "native-error",
        ...environmentState,
        failureCode: "api-error",
        error: probe.error,
      });
      return () => {
        activeRef.current = false;
      };
    }

    if (environment.permissionsPolicy === "denied") {
      setState({
        kind: "native-error",
        ...environmentState,
        failureCode: "permissions-policy-denied",
        error: "The browser's tools Permissions Policy denies this document.",
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
        ...environmentState,
        failureCode: "registration-timeout",
        error: "registerTool did not settle within 5 seconds.",
      });
    }, 5_000);

    void (async () => {
      try {
        await probe.modelContext.registerTool(diagnosticTool, {
          signal: registrationController.signal,
        });
        if (activeRef.current && !registrationTimedOut) {
          setState({
            kind: "native-ready",
            ...environmentState,
            failureCode: null,
            error: null,
          });
        }
      } catch (error) {
        registrationController.abort();
        if (activeRef.current && !registrationTimedOut) {
          setState({
            kind: "native-error",
            ...environmentState,
            failureCode: classifyWebMcpRegistrationError(error),
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
  }, [deck, diagnosticTool]);

  const presentation = statusPresentation(state);
  const toolRegistered = state.kind === "native-ready";

  return (
    <>
      <section
        className="capability-card"
        aria-labelledby="webmcp-capability-title"
        data-webmcp-capability={state.kind}
        data-webmcp-origin-trial={state.originTrial}
        data-webmcp-route="/study/"
        data-webmcp-context={state.context}
        data-webmcp-permissions-policy={state.permissionsPolicy}
        data-webmcp-failure-code={state.failureCode ?? ""}
        data-webmcp-origin={state.origin ?? ""}
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
          <div>
            <dt>Document context</dt>
            <dd data-webmcp-context-value={state.context}>{state.context}</dd>
          </div>
          <div>
            <dt>Tools Permissions Policy</dt>
            <dd data-webmcp-permissions-policy-value={state.permissionsPolicy}>
              {state.permissionsPolicy}
            </dd>
          </div>
          <div>
            <dt>Failure classification</dt>
            <dd data-webmcp-failure-code-value={state.failureCode ?? "none"}>
              {state.failureCode ?? "none"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="route-card probe-card" aria-labelledby="study-probe-title">
        <h2 id="study-probe-title">Study route diagnostic probe</h2>
        <p>
          This bounded probe has no imported content, card data, persistence,
          network, or production Anki side effects. It is registered only while
          this study route is active and its deck query remains in memory.
        </p>
        <dl className="probe-details">
          <div>
            <dt>Active deck</dt>
            <dd>
              <code data-diagnostic-deck>{diagnosticState.deck}</code>
            </dd>
          </div>
          <div>
            <dt>Visible side</dt>
            <dd>
              <output id="diagnostic-side" data-diagnostic-side>
                {diagnosticState.side}
              </output>
            </dd>
          </div>
          <div>
            <dt>Applied commands</dt>
            <dd data-diagnostic-mutation-count>{diagnosticState.mutationCount}</dd>
          </div>
          <div>
            <dt>Last command</dt>
            <dd data-diagnostic-last-command>
              {diagnosticState.lastCommandId ?? "None"}
            </dd>
          </div>
          <div>
            <dt>Native tool</dt>
            <dd>
              {toolRegistered ? (
                <code data-webmcp-tool-name={diagnosticTool.name}>
                  {diagnosticTool.name}
                </code>
              ) : (
                <span data-webmcp-tool-name="">Not registered</span>
              )}
            </dd>
          </div>
        </dl>
        <p className="probe-contract">
          When ready, a valid call accepts the current <code>deck</code>, a
          <code>side</code> of <code>front</code> or <code>back</code>, and a
          unique <code>command_id</code>. It returns structured
          <code>status</code>, <code>code</code>, <code>route</code>,
          <code>command</code>, <code>deck</code>, <code>side</code>,
          <code>command_id</code>, and <code>mutation_count</code> fields.
          Invalid, duplicate, aborted, and stale calls leave the visible state
          unchanged.
        </p>
      </section>
    </>
  );
}
