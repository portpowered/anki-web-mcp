# WebMCP Anki static harness

This repository contains the production WebMCP Anki application. It is a
serverless Next.js static export with in-browser deck persistence, APKG import,
study scheduling, and WebMCP tool registration.

## Production URLs

- Deck home: <https://portpowered.github.io/anki-web-mcp/>
- Study: <https://portpowered.github.io/anki-web-mcp/study/?deck=diagnostic>

The GitHub Pages project path is part of the application contract. Both URLs
must continue to work on direct navigation and reload, including the study
query string.

## Release-candidate blind cohort

After the harness-bearing commit is merged, protected-main CI and Pages are
successful, run cohort one from a checkout of that exact `main` commit:

```sh
BLIND_COHORT_SHA=<40-character-main-sha> \
BLIND_COHORT_MODEL=<independent-agent-model> \
OPENAI_API_KEY=<controller-only-credential> \
BLIND_COHORT_CHROME_PATH=<ordinary-Chrome-152.0.7977.65> \
bun run blind-cohort:one
```

The command fetches `origin/main`, verifies protected CI, Pages source, both
route markers, the HTTP-observed deployment revision, and absence of the open
release-candidate PR. It then runs the ordinary checks and exactly one fresh
eight-tool aggregate before any blind probe. Cohort records and the human
summary are sanitized into ignored `.artifacts/blind-cohort/cohort-one/`
outputs. Any missing or inconsistent gate writes NO-GO and starts no agent;
any probe failure stops before the next probe. There is intentionally no
cohort-two invocation.

## Local development and checks

The pinned toolchain is Bun `1.4.0` (recorded in `.bun-version` and
`package.json`). Install exactly from the committed lockfile:

```sh
bun install --frozen-lockfile
```

Run the local quality gates individually when iterating:

```sh
bun run typecheck
bun run lint
bun test
bun run test:import:coverage
bun run build
bun run test:browser
bun run test:apkg:browser
```

The WebMCP compatibility gate is a separate bounded command. It runs the
external native oracle, local controls, exact production route probe, and
isolated policy experiment, then writes ignored JSON and Markdown decision
artifacts beneath `.artifacts/webmcp-evidence/`:

```sh
bun run webmcp:evidence
```

See [docs/browser-compatibility.md](docs/browser-compatibility.md) for the
native-only procedure and the supported/no-go interpretation.

`bun run test:browser` builds the production export, stages it beneath
`/anki-web-mcp/`, serves it with Python's standard static server, and verifies
the desktop and 320 CSS-pixel Chromium routes. Chromium must be available on
the machine; set `CHROME_PATH` when it is not discoverable automatically.

`bun run test:import:coverage` exercises every executable line and function in
the import-limit and archive-boundary modules and fails if either regresses
below 100%. `bun run test:apkg:browser` runs the production dedicated-Worker
and IndexedDB integration suite in Chromium.

The complete release gate is also available as one fail-fast command:

```sh
bun run release:check
```

To inspect a built export with a normal static server, stage the export at the
project path before serving it. For PowerShell:

```powershell
bun run build
New-Item -ItemType Directory -Force .local-pages\anki-web-mcp | Out-Null
Copy-Item -Recurse -Force out\* .local-pages\anki-web-mcp\
python -m http.server 8000 --directory .local-pages
```

Then open
<http://127.0.0.1:8000/anki-web-mcp/> or
<http://127.0.0.1:8000/anki-web-mcp/study/?deck=diagnostic>.

## CI and GitHub Pages deployment

Pull requests and pushes to `main` run the frozen install, typecheck, lint
gate, changed-source lint comparison against the pull request base, unit
tests, production build, and static browser smoke suite. Browser failure
evidence is uploaded from `test-results/static-smoke/`.

Only a push to the protected `main` branch can run the Pages deployment job.
The job requires the quality job, publishes the checked `out/` artifact, uses
the `github-pages` environment, and verifies both production URLs after the
deployment. In repository settings, keep `main` protected with the `quality`
check required before merge and protect the `github-pages` environment with
the release approvals appropriate for this project.

The compatibility targets and the exact WebMCP origin-trial acceptance build
are recorded in [docs/browser-compatibility.md](docs/browser-compatibility.md).
