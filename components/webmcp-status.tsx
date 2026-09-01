"use client";

import { useEffect, useState } from "react";

import {
  detectWebMcpCapability,
  type WebMcpCapability,
} from "../lib/webmcp";

const initialCapability: WebMcpCapability = { kind: "unavailable" };

function capabilityStatus(capability: WebMcpCapability) {
  switch (capability.kind) {
    case "available":
      return {
        className: "status-success",
        role: "status" as const,
        text: (
          <>
            <strong>Native WebMCP available:</strong> This browser exposed
            <code>document.modelContext</code>. The harness only reports that
            capability and does not register production tools.
          </>
        ),
      };
    case "error":
      return {
        className: "status-error",
        role: "alert" as const,
        text: (
          <>
            <strong>Native WebMCP detection error:</strong> The capability
            check could not complete. Human diagnostics remain usable; no
            tools or polyfill are loaded.
          </>
        ),
      };
    case "unavailable":
      return {
        className: "status-warning",
        role: "status" as const,
        text: (
          <>
            <strong>Native WebMCP unavailable:</strong> Human diagnostics
            remain usable in this browser; no WebMCP polyfill is loaded.
          </>
        ),
      };
  }
}

export function WebMcpStatus() {
  const [capability, setCapability] = useState(initialCapability);
  const status = capabilityStatus(capability);

  useEffect(() => {
    setCapability(detectWebMcpCapability(document));
  }, []);

  return (
    <section
      className="capability-card"
      aria-labelledby="webmcp-capability-title"
      data-webmcp-capability={capability.kind}
    >
      <h2 id="webmcp-capability-title">Native WebMCP capability</h2>
      <p className={`status ${status.className}`} role={status.role}>
        {status.text}
      </p>
    </section>
  );
}
