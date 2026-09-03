import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import { assetPath } from "../lib/site";

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
      className="flex min-h-dvh flex-col bg-background text-navy antialiased"
      style={deploymentRoute === "deck-home" ? {
        backgroundImage: `linear-gradient(rgba(248, 250, 252, 0.22), rgba(248, 250, 252, 0.22)), url("${assetPath("/webmcp-anki-background.jpg")}")`,
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundSize: "cover",
      } : undefined}
    >
      <a
        className="fixed left-4 top-4 z-50 -translate-y-32 rounded-lg bg-navy px-3 py-2 text-sm font-semibold text-primary-foreground transition-transform focus:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
        href="#main-content"
      >
        Skip to content
      </a>
      <div
        data-shell-content
        className={cn(
          "mx-auto flex min-h-dvh w-full max-w-[76rem] flex-1 flex-col px-4 py-2 sm:px-6 lg:px-8",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
