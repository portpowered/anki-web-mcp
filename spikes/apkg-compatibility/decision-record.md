# Browser APKG parsing stack decision

Date: 2026-09-01
Scope: P0B story `webmcp-anki-apkg-compatibility-spike-001`
Status: selected for the compatibility spike; this is not the production importer.

Story 006 publishes the exact layout/exporter matrix and current runtime
evidence in [`evidence-report.md`](evidence-report.md). Re-run `bun run
evidence` after changing dependencies, parser behavior, fixture provenance, or
the static asset build.

## Decision

Pin the following browser-Worker stack in `package.json` and `bun.lock`:

| Category | Package and exact version | License review | Worker use in this spike |
| --- | --- | --- | --- |
| ZIP | `fflate@0.8.3` | MIT; no runtime dependencies | `zipSync`/`unzipSync` round trip for `collection.anki2` and `media` |
| SQLite/WASM | `@sqlite.org/sqlite-wasm@3.53.0-build1` | Package Apache-2.0; bundled SQLite code is SQLite Public Domain; no package runtime dependencies | Same-origin module initialization and SQL query in the dedicated Worker |
| zstd | `fzstd@0.1.1` | MIT; no runtime dependencies | Pure-JavaScript Zstandard decompression of a deterministic raw frame |
| protobuf | `protobufjs@8.8.0` | BSD-3-Clause; runtime transitive `long@5.3.2` is Apache-2.0 | `protobufjs/minimal` Reader/Writer round trip, with no code generation |
| sanitizer | `xss@1.0.15` | MIT; runtime transitives `commander@2.20.3` and `cssfilter@0.0.10` are MIT | Whitelist sanitizer with a package-local `media://` image URL hook |

The runtime dependency graph is therefore limited to the five direct packages
and the three listed transitive packages. The toolchain is pinned separately:
`bun@1.4.0`, `vite@8.2.1`, `typescript@5.9.3`, and
`@playwright/test@1.58.2` (`@types/bun@1.3.1` supplies types only). The
toolchain is not shipped in the browser bundle.

## Runtime evidence

`tests/browser/stack.spec.ts` uses the page served at `/apkg-spike/` in actual
Chromium. It starts the real module Worker created by
`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })` and
asserts the observable terminal result from all five operations:

- ZIP entries, extracted collection payload, and SHA-256;
- SQLite library version and ordered rows;
- zstd decompressed text and byte counts;
- protobuf decoded fields; and
- sanitized output, removal of active/external content, and retention of
  `media://0`.

The page also advances a main-thread heartbeat while the Worker runs and counts
CSP violations. The passing run observed `workerRuntime: "dedicated-worker"`,
zero CSP violations, a progressing heartbeat, and no external network request
from the selected runtime assets. The result is staged until all five probes
pass; only that terminal carries `commitReady: true`.

## Static hosting and CSP

The Vite build emits the page, Worker chunks, SQLite helper Worker chunks, and
`sqlite3.wasm` under `dist/apkg-spike/`. The page uses the same `/apkg-spike/`
base path used by the browser test. Both the representative development header
and the page meta policy require same-origin `script-src`, `worker-src`, and
`connect-src`; the only WebAssembly allowance is `wasm-unsafe-eval`. There is
no `unsafe-eval`, remote script, remote Worker, or runtime fetch to a service.
The package's browser entry is selected by the bundler, and the module Worker
loads the emitted WASM asset through the package's static module path. The
production deployment must preserve these relative asset paths and headers;
the Vite server is only the local harness.

## Bundle measurement

Run:

```text
bun run measure:bundle
```

The script builds the stack page and a no-runtime baseline with Vite, walks
only emitted `.js`, `.mjs`, and `.wasm` assets, sums their raw bytes, and sums
gzip level 9 sizes. It writes temporary output under ignored
`.artifacts/bundle-measure/` and prints the machine-readable report; the
report itself is intentionally not committed.

Measurement on 2026-09-01 with the pinned lockfile:

| Build | Raw bytes | gzip bytes |
| --- | ---: | ---: |
| Stack assets | 1,732,685 | 664,801 |
| Baseline assets | 714 | 414 |
| Incremental stack cost | **1,731,971** | **664,387** |

The stack asset breakdown was: app 6,274 raw/2,242 gzip, SQLite WASM
864,752/400,297, SQLite helper Worker 210,704/62,777, SQLite OPFS helper
32,289/10,438, and parser Worker 320,862/97,195 plus stack Worker 297,804/91,852.
Hash-suffixed filenames are not part of the contract; rerunning the command is
the source of truth after dependency or bundler changes.

## Cancellation and limits

Cancellation is cooperative and observable. The browser test asks the Worker
to pause after the SQLite progress event, posts `cancel`, and receives exactly
one `cancelled` terminal with `commitReady: false` and `stagedResult: null`.
The Worker checks the operation ID before and after each task boundary and
suppresses later progress. The client clears its pending operation before
settling and ignores messages for a cancelled, superseded, or unknown ID; this
is the late-result protection, distinct from interrupting a synchronous parser
call. A synchronous ZIP/SQLite/zstd/protobuf/sanitizer call cannot be stopped
mid-call. Production hard-cancellation of a call that has already entered a
library must terminate and recreate the dedicated Worker, and must still
discard any non-success result.

The probe is deliberately bounded: fixed small payloads, a one-table in-memory
database closed in `finally`, one raw zstd frame capped at 255 payload bytes,
and checkpoint delays clamped to 100 ms (the cancellation demonstration's
post-progress pause is clamped to 2,000 ms). The output records input,
compressed, decompressed, and sanitized byte counts where applicable. The
browser harness has no portable Worker peak-heap telemetry, so this evidence
does not claim a production peak-memory limit. Archive original/expanded
budgets, entry and ratio limits, parse-duration budgets, and memory guards are
required follow-up work before untrusted APKG import (story 005); this spike
records the limitation rather than hiding it.

## Alternatives considered

| Alternative | Reason not selected for this spike |
| --- | --- |
| JSZip | The selected `fflate` browser entry provides the required ZIP round trip with no runtime dependencies; JSZip would add an unmeasured second ZIP implementation without improving this evidence. |
| `sql.js` | It is a viable SQLite/WASM option, but its Emscripten wrapper and separate asset-loading path would require a second CSP/static-host measurement. The official SQLite WASM module supplies the needed Worker probe and static asset path here. |
| `@bokuweb/zstd-wasm` | It introduces another WASM asset and initialization path for a decompression operation that `fzstd` exercises as pure JavaScript in this Worker. Re-evaluate if production throughput requires WASM. |
| DOMPurify | Its contract depends on a DOM; the selected sanitizer must run in a dedicated Worker with no DOM implementation. `xss` provides a pure-JavaScript whitelist path and is tested with the package-media URL policy. |
| Full `protobufjs`/runtime code generation | The minimal Reader/Writer API is sufficient for the probe and avoids adding generated/code-evaluation behavior to a CSP-sensitive Worker. |

These are selection decisions for the spike, not claims that the alternatives
cannot be made to work. Any replacement must repeat the browser, CSP, bundle,
cancellation, and license evidence before changing the pin.

## Reproduction

From a clean checkout, install the exact lockfile and run the evidence gates:

```text
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:browser
bun run measure:bundle
```

The browser test needs Chromium. `playwright.config.ts` uses the managed
Playwright Chromium when available and otherwise supports the explicitly
configured local Chromium executable used for this workstation run; this does
not change the browser/runtime evidence.
