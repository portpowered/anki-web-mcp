import Link from "next/link";

import { DiagnosticShell } from "../components/diagnostic-shell";

export default function HomePage() {
  return (
    <DiagnosticShell eyebrow="WebMCP Anki" title="Static export harness">
      <section className="route-card" aria-labelledby="root-route-title">
        <h2 id="root-route-title">Root route ready</h2>
        <p className="status status-success" role="status">
          <strong>Success:</strong> The root diagnostic loaded as a static
          application document.
        </p>
        <p>
          This harness has no backend. Its navigation and public assets are
          configured for the GitHub Pages project path.
        </p>
        <nav className="route-navigation" aria-label="Diagnostic navigation">
          <Link className="route-link" href="/study/?deck=diagnostic">
            Open the study diagnostic
          </Link>
        </nav>
      </section>

      <section className="route-card secondary-card" aria-labelledby="root-error-title">
        <h2 id="root-error-title">Recoverable route errors</h2>
        <p className="status status-warning">
          <strong>Unsupported input:</strong> A study URL without a non-empty{" "}
          <code>deck</code> query is reported as a recoverable error with a
          return link.
        </p>
      </section>
    </DiagnosticShell>
  );
}
