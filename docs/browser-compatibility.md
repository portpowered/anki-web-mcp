# Browser compatibility and native WebMCP acceptance

WebMCP is progressive enhancement. The production routes remain usable when
`document.modelContext` is absent, but no local flag, mock, extension, or
polyfill result is native acceptance evidence.

## Pinned acceptance boundary

| Field | Required value |
| --- | --- |
| Browser | Google Chrome Stable `152.0.7977.65` |
| Operating system | Windows NT `10.0.26200`, `x64` |
| Production root | `https://portpowered.github.io/anki-web-mcp/` |
| Production study boundary | `https://portpowered.github.io/anki-web-mcp/study/?deck=diagnostic` |
| External oracle | `https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/` |
| Profile | Newly created ephemeral Playwright context, discarded after each isolated case |
| Launch | Headless, no WebMCP enabling/testing flag, proxy, extension, reused state, or service worker |
| Inspection | Runtime calls to `document.modelContext.getTools()` and `executeTool()` only |

The runner records the actual browser identity, executable, OS, launch
arguments, exact URLs, HTTP status, secure-context state, Permissions Policy,
and browser errors. A mismatch is a deterministic no-go or not-evaluable
result, never support.

The existing origin-trial token remains in both static document heads. Runtime
evidence records only sanitized feature, origin, expiry, and acceptance state;
the raw token must never be written to logs or evidence.

## Production tool scopes

Discovery is fail-closed and duplicate-sensitive. The runner validates the
entire route/state set before making any tool call; native discovery order is
recorded but is not treated as stable.

| Route/state | Exact discovered tools |
| --- | --- |
| Home | `list_decks`, `select_deck`, `restore_suspended` |
| Study with an active card | `get_state`, `flip`, `set_state`, `suspend`, `go_home` |
| Study without an active card | `get_state`, `go_home` |

A missing, duplicated, unexpected, or mixed-route registration records both
the expected and observed inventories and skips invocation. There is no legacy
or alternate diagnostic branch in production acceptance.

The accepted journey starts at the production root, obtains a persisted
`deck_id` from `list_decks`, and passes that returned identifier to
`select_deck`. Before selection, repeated reads and malformed/extra-input
rejections must leave the visible deck list and its IndexedDB records unchanged.
The returned deck metadata must agree with both surfaces, and the exact study
URL, active session, current card, route marker, and five-tool inventory are
taken from application navigation and durable state. Tests must never fabricate
a deck or card identifier, retain a prior evidence artifact, or accept a
fallback document as the study route.

Suspension and restoration run in a separate fresh browser context. The runner
uses the current `card_id`, proves `suspend` removes every occurrence without a
review or scheduling-memory change, retries the same command idempotently, and
rejects a different fingerprint as `DUPLICATE_COMMAND`. It then invokes
`go_home`, waits for the exact root inventory, and restores the returned deck
with visible count and IndexedDB parity. The restore retry must preserve the
first result without a second effect, and the context is discarded afterward.

## Running evidence

Install the locked toolchain, point both native runners at the pinned Chrome,
and run the combined command:

```powershell
bun install --frozen-lockfile
$env:WEBMCP_ORACLE_BROWSER_PATH = 'C:\path\to\chrome.exe'
$env:WEBMCP_BOUNDARY_BROWSER_PATH = 'C:\path\to\chrome.exe'
bun run webmcp:evidence
```

To retain an expected no-go/not-evaluable report without converting it to
support:

```powershell
$env:WEBMCP_EVIDENCE_ALLOW_FAILURE = '1'
bun run webmcp:evidence
```

The command writes ignored reports beneath `.artifacts/`. Reports include
sanitized discovery contracts, structured calls, visible and durable state,
classification boundaries, limitations, and rerun triggers. They exclude raw
tokens, reusable profiles, imported card content, and CI transcripts.

The separately labelled loopback Permissions Policy experiment may launch with
`--enable-features=WebMCP` to test cross-origin isolation. It is non-production
boundary evidence and cannot contribute to deployed-native support.

## Decision gate

`bun run webmcp:evidence` reports `supported` only when the external oracle,
exact production boundary and journey, lifecycle/cancellation/concurrency and
isolation cases, and ordinary quality commands pass. Missing native support or
an inconclusive oracle is not-evaluable; a failed production boundary after a
passing oracle is no-go. Required calls cannot be silently skipped.

Do not commit generated evidence. After the final implementation head is
pushed, CI and exact deployed-final-main summaries belong in the PR
conversation. Rerun when the browser, token, origin/path, Permissions Policy,
tool contracts, final deployed revision, or relevant lifecycle behavior
changes. No blind-agent probe is part of this command.

## References

- [Chrome WebMCP overview](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [Live pizza-maker oracle](https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/)
