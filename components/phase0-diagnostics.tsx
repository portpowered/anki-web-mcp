import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { assetPath } from "../lib/site";
import { cn } from "../lib/cn";
import { PersistenceDiagnostics } from "./persistence-diagnostics";
import { RootWebMcpProbe } from "./root-webmcp-probe";
import { StudyWebMcpProbe } from "./study-webmcp-probe";
import { WebMcpStatus } from "./webmcp-status";

export type Phase0DiagnosticsProps = {
  readonly routeTitle: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly requestedDeckId?: string;
  readonly webMcp?: "capability" | "root-probe" | "study-probe";
};

/**
 * Keeps the Phase 0 diagnostic surface available below the production preview.
 * The production route owns no diagnostic side effects; this region only
 * exposes the existing capability and static-route observations.
 */
export function Phase0Diagnostics({
  routeTitle,
  children,
  className,
  requestedDeckId,
  webMcp = "capability",
}: Phase0DiagnosticsProps) {
  return (
    <section
      id="phase0-diagnostics"
      aria-labelledby="phase0-diagnostics-title"
      className={cn(
        "rounded-card border border-border bg-surface-muted/70 p-4 sm:p-6",
        className,
      )}
      data-phase0-diagnostics
    >
      <header className="flex items-start gap-3 sm:gap-4">
        <Image
          className="size-8 shrink-0 sm:size-10"
          src={assetPath("/diagnostic-mark.svg")}
          alt=""
          width={40}
          height={40}
        />
        <div className="min-w-0">
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-muted">
            Phase 0 / diagnostics
          </p>
          <h2
            id="phase0-diagnostics-title"
            className="m-0 text-xl font-semibold text-navy sm:text-2xl"
          >
            Native capability and route diagnostics
          </h2>
          <p className="mt-2 max-w-prose text-sm leading-6 text-muted">
            The production preview above is intentionally non-persistent. The
            original static diagnostics remain available here for deployment
            and browser-capability checks.
          </p>
        </div>
      </header>

      <div className="mt-5 space-y-4">
        {webMcp === "root-probe" ? (
          <RootWebMcpProbe />
        ) : webMcp === "study-probe" && requestedDeckId ? (
          <StudyWebMcpProbe deck={requestedDeckId} />
        ) : (
          <WebMcpStatus />
        )}
        <PersistenceDiagnostics requestedDeckId={requestedDeckId} />
        <section
          aria-labelledby="phase0-route-title"
          className="rounded-card border border-border bg-surface p-4 sm:p-6"
          data-phase0-route={routeTitle}
        >
          <h3
            id="phase0-route-title"
            className="m-0 text-lg font-semibold text-navy"
          >
            {routeTitle}
          </h3>
          <div className="mt-4">{children}</div>
        </section>
      </div>
    </section>
  );
}

export function DiagnosticNavigation({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <nav className="route-navigation" aria-label="Diagnostic navigation">
      {children}
    </nav>
  );
}

export { Link as DiagnosticLink };
