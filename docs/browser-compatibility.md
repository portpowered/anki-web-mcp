# Browser compatibility and native WebMCP oracle

WebMCP is progressive enhancement. The diagnostic routes must remain usable
when `document.modelContext` is absent, and no local flag, mock, extension,
or polyfill result is native acceptance evidence.

## Story 001 acceptance matrix

| Field | Pinned acceptance value |
| --- | --- |
| Browser | Google Chrome |
| Version/build | `152.0.7977.65` |
| Channel | Stable |
| Operating system | Windows NT `10.0.26200`, `x64` (`win32 10.0.26200 x64` in the runner) |
| Origin | `https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/` |
| Origin-trial state | The live page's WebMCP token is inspected at runtime for feature, origin, expiry, and accepted/rejected outcome; the token value is never written to evidence. |
| Local WebMCP testing flag | Disabled/not supplied for the oracle; the control explicitly uses `--disable-features=WebMCP`. |
| Polyfill/network injection | The demo's `shared/webmcp-polyfill.js` request and scripts from other origins are aborted before execution; service workers and extensions are disabled. |
| Launch | Headless, isolated ephemeral Playwright context, no proxy, no extensions, fixed viewport `1280x900`, and the runner's recorded minimal Chromium arguments. |
| Inspection | Direct page runtime calls to `document.modelContext.getTools()` and `document.modelContext.executeTool()` through Playwright; no source inspection or WebMCP inspector is used as proof. |

The operating-system pin is intentionally exact. Rerun the matrix and change
the pin only when the acceptance workstation is deliberately changed. The
runner also records the full user agent, User-Agent Client Hints, executable
path, OS release, and retrieval timestamp.

## Reproducible oracle procedure

Install from the locked toolchain, set the pinned Google Chrome executable,
and run:

```sh
bun install --frozen-lockfile
WEBMCP_ORACLE_BROWSER_PATH=/path/to/chrome-for-testing \
WEBMCP_ORACLE_EXPECTED_OS="linux 6.x x64" \
bun run oracle:webmcp
```

On PowerShell:

```powershell
bun install --frozen-lockfile
$env:WEBMCP_ORACLE_BROWSER_PATH = 'C:\path\to\chrome.exe'
bun run oracle:webmcp
```

The acceptance command must use the matrix's exact OS value; the Linux value
above is only a syntax example and must not be used to claim this pinned
Windows result. `WEBMCP_ORACLE_EXPECTED_VERSION` and
`WEBMCP_ORACLE_CHANNEL` may be set only when deliberately recording a new
matrix. The default version and channel are the values in the table.

The command writes ignored machine-readable evidence to
`.artifacts/webmcp-oracle/report.json` and prints a short terminal summary.
Evidence is runtime-only and includes:

- browser/build/channel/OS and exact launch configuration;
- URL, retrieval timestamp, document identity, secure-context state, origin
  trial metadata status, and blocked-request records;
- native capability state and the sanitized discovered tool contracts;
- the `set_pizza_size({"size":"Small"})` result and visible `#size-text`
  state before and after execution;
- console/page errors, non-blocked failed requests, and the control result.

The report retains schema, descriptions, annotations, and origin but never
serializes a tool's `execute` function, `Window`, profile data, or raw token.

## Story 002 root diagnostic probe

The root production document includes the origin-trial meta tag in the initial
`head`, then performs a runtime-only capability check. It reports `checking`,
`native-ready`, `native-unavailable`, or `native-error` in accessible text. The
origin-trial detail is separately classified as `accepted`, `rejected`,
`expired`, `mismatched`, `not-required`, or `unknown`; a token's presence is
never treated as proof that the browser exposed WebMCP.

When native registration succeeds, the root route exposes only the bounded,
non-production `webmcp_diagnostic_increment` tool. Its input is:

```json
{
  "amount": 1,
  "command_id": "unique-attempt-id"
}
```

`amount` is an integer from 1 through 10 and `command_id` is a non-empty
string of at most 64 characters. A successful result is a serializable object
with `status: "applied"`, `code: "ok"`, `route: "/"`, `command`,
`command_id`, `amount`, and the updated in-memory `counter`. Invalid input and
repeated command IDs return classified rejected results without changing the
counter. No deck, card, persistence, network, or production Anki state is
connected to this probe.

The local `bun run test:browser` check is an absent-API control: it builds the
static export beneath `/anki-web-mcp/`, uses an ordinary Chromium instance,
verifies the root and study routes at desktop and 320 CSS-pixel widths, and
writes ignored root probe evidence to
`test-results/static-smoke/root-webmcp.json`. It does not turn a flag, mock,
extension, or polyfill into native acceptance evidence. The pinned deployed
run must open both exact production URLs in the browser matrix above and use
`document.modelContext.getTools()`/`executeTool()` to verify discovery, the
structured counter result, and the visible counter mutation.

## Story 003 study-route lifecycle probe

The study route registers only `webmcp_diagnostic_set_side` while a non-empty
`deck` query is active. Its bounded input is:

```json
{
  "deck": "diagnostic",
  "side": "back",
  "command_id": "unique-study-attempt-id"
}
```

The supplied deck must match the active query, and `side` must be `front` or
`back`. A successful result reports the `/study/` route, the deck, selected
side, command identifier, and monotonically increasing `mutation_count`. The
route owns registration with an `AbortSignal`; leaving the route aborts the
registration and the controller rejects delayed, stale, duplicate, or aborted
work without changing visible state.

The browser smoke suite uses a page-local test double only to exercise these
observable transitions: study-only discovery, structured side mutation,
duplicate/invalid/aborted calls, client navigation to root and back, and the
desktop/mobile error presentations. The deployed acceptance run must repeat
those checks through the browser's native `document.modelContext` surface.

## Story 004 isolation and failure boundaries

The application reports the facts that qualify a browser result instead of
guessing them: `data-webmcp-context` is `secure-production`,
`secure-non-production`, `insecure`, or `unknown`; the tools Permissions Policy
is `allowed`, `denied`, or `unknown`; and `data-webmcp-failure-code` carries a
stable classified failure when registration cannot proceed. A denied policy or
insecure context is handled before registration, so a rejected route cannot
leave a partially healthy tool visible. Registration errors are classified as
`permissions-policy-denied`, `invalid-schema`, `duplicate-registration`, or
`registration-rejected`; origin-trial status remains a separate observation.

Run the boundary check on the pinned browser with:

```sh
WEBMCP_BOUNDARY_BROWSER_PATH=/path/to/chrome-for-testing \
WEBMCP_BOUNDARY_ALLOW_FAILURE=1 \
bun run webmcp:boundaries
```

On PowerShell:

```powershell
$env:WEBMCP_BOUNDARY_BROWSER_PATH = 'C:\path\to\chrome.exe'
$env:WEBMCP_BOUNDARY_ALLOW_FAILURE = '1'
bun run webmcp:boundaries
```

The runner opens the exact root and study production URLs without a local
WebMCP flag, polyfill, extension, or mock. It records route status, native
discovery, structured valid/duplicate/invalid/cancelled outcomes, visible
state, token delivery, policy, and browser errors in the ignored
`.artifacts/webmcp-boundaries/report.json` artifact. An inaccessible route or
missing native API is retained as `deployment-route-failed` or
`native-unavailable`, never converted into a passing result.

The same command then runs a separately labeled loopback experiment with
`--enable-features=WebMCP` solely to exercise the browser boundary: a child
iframe is tested without `allow="tools"`, with permission but no `exposedTo`,
with both `allow="tools"` and the exact host origin in `exposedTo`, and again
after permission is removed. Only the explicitly permitted case may discover
and execute `webmcp_isolation_child`; the production diagnostic registrations
never pass an `exposedTo` list or wildcard. This local experiment is not
deployed-native evidence and is `not-evaluable` when the browser does not
expose WebMCP.

## Terminal classifications

The native oracle can only finish as `oracle-passed` or `oracle-failed`.
`oracle-passed` requires the exact browser version and OS, a blocked polyfill,
an available native API, the expected tool, a matching structured result, the
documented visible mutation from `Medium` to `Small`, and no unexplained
browser errors. A missing API is the stable `native-unavailable` failure code
inside an `oracle-failed` run; it is never treated as support.

The separate control uses the same isolated browser executable with
`--disable-features=WebMCP` unless `WEBMCP_ORACLE_CONTROL_BROWSER_PATH` names a
different browser. It must report `native-unavailable`. If it exposes a native
API or cannot launch, it reports `control-failed`, and the overall result is
not a passing oracle. When the oracle is not passing, the report's downstream
classification is `not-evaluable`; deployed-native stories must not infer a
failure or success from that environment result.

## References

- [Chrome WebMCP overview](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [GoogleChromeLabs pizza-maker source](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/demos/pizza-maker)
- [Live pizza-maker oracle](https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/)
