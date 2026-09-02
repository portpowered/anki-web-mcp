"use client";

import { useEffect, useState } from "react";

import {
  detectWebMcpCapability,
  type WebMcpCapability,
} from "../lib/webmcp";
import { Card } from "./ui/card";
import { Status } from "./ui/status";

const initialCapability: WebMcpCapability = { kind: "unavailable" };

function capabilityStatus(capability: WebMcpCapability) {
  switch (capability.kind) {
    case "available":
      return {
        role: "status" as const,
        text: (
          <>
            <strong>Native WebMCP available:</strong> This browser exposed
            <code>document.modelContext</code>. Production tools are registered
            separately by the active route.
          </>
        ),
      };
    case "error":
      return {
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
    <Card
      className="p-4 sm:p-6"
      aria-labelledby="webmcp-capability-title"
      data-webmcp-capability={capability.kind}
    >
      <h2
        id="webmcp-capability-title"
        className="m-0 text-lg font-semibold text-navy"
      >
        Native WebMCP capability
      </h2>
      <Status
        className="mb-0 mt-4"
        role={status.role}
        tone={
          capability.kind === "available"
            ? "success"
            : capability.kind === "error"
              ? "error"
              : "warning"
        }
      >
        {status.text}
      </Status>
    </Card>
  );
}
