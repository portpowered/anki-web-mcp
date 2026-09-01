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
