import type { ReactNode } from "react";
import Image from "next/image";

import { assetPath } from "../lib/site";
import { WebMcpStatus } from "./webmcp-status";
import { RootWebMcpProbe } from "./root-webmcp-probe";

type DiagnosticShellProps = {
  eyebrow: string;
  title: string;
  children: ReactNode;
  webMcp?: "capability" | "root-probe";
};

export function DiagnosticShell({
  eyebrow,
  title,
  children,
  webMcp = "capability",
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

      <main id="main-content">
        {webMcp === "root-probe" ? <RootWebMcpProbe /> : <WebMcpStatus />}
        {children}
      </main>
    </div>
  );
}
