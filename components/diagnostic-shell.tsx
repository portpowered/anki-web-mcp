import type { ReactNode } from "react";
import Image from "next/image";

import { assetPath } from "../lib/site";
import { WebMcpStatus } from "./webmcp-status";
import { RootWebMcpProbe } from "./root-webmcp-probe";
import { StudyWebMcpProbe } from "./study-webmcp-probe";

type DiagnosticShellProps = {
  eyebrow: string;
  title: string;
  children: ReactNode;
  webMcp?: "capability" | "root-probe" | "study-probe";
  studyDeck?: string;
};

export function DiagnosticShell({
  eyebrow,
  title,
  children,
  webMcp = "capability",
  studyDeck,
}: DiagnosticShellProps) {
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Skip to diagnostics
      </a>

      <header className="site-header">
        <Image
          src={assetPath("/diagnostic-mark.svg")}
          alt=""
          width={64}
          height={64}
          priority
        />
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
        </div>
      </header>

      <main id="main-content" className="space-y-4">
        {webMcp === "root-probe" ? (
          <RootWebMcpProbe />
        ) : webMcp === "study-probe" && studyDeck ? (
          <StudyWebMcpProbe deck={studyDeck} />
        ) : (
          <WebMcpStatus />
        )}
        {children}
      </main>
    </div>
  );
}
