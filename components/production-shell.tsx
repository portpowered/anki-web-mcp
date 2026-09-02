import type { ReactNode } from "react";

import { cn } from "../lib/cn";

type ProductionShellProps = {
  children: ReactNode;
  className?: string;
  deploymentRoute: "deck-home" | "study";
};

export function ProductionShell({
  children,
  className,
  deploymentRoute,
}: ProductionShellProps) {
  return (
    <div
      data-deployment-route={deploymentRoute}
      data-production-shell
      className="min-h-screen bg-background text-navy antialiased"
    >
      <a
        className="fixed left-4 top-4 z-50 -translate-y-32 rounded-lg bg-navy px-3 py-2 text-sm font-semibold text-primary-foreground transition-transform focus:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
        href="#main-content"
      >
        Skip to diagnostics
      </a>
      <div
        data-shell-content
        className={cn(
          "mx-auto w-full max-w-[76rem] px-4 py-6 sm:px-6 sm:py-10 lg:px-8",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
