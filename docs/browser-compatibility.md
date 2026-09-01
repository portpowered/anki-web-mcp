# Browser compatibility

This diagnostic harness treats WebMCP as progressive enhancement. The human
diagnostic routes remain usable when the browser does not expose the native
`document.modelContext` surface, and the application never installs a
polyfill or registers production tools in this bootstrap lane.

## Acceptance matrix

| Target | Pinned support or verification target |
| --- | --- |
| Native WebMCP acceptance | Chrome for Testing `152.0.7977.64` on the production origin `https://portpowered.github.io/anki-web-mcp/`, using the supplied origin-trial token and no polyfill or feature flag. Native availability must be observed through `document.modelContext`. |
| Human UI, desktop | Current stable desktop Chromium; the recorded local stable build is Google Chrome `152.0.7977.64`. The UI is supported whether native WebMCP is present or absent. |
| Human UI, mobile | Chromium at a `320 CSS px` wide by `800 CSS px` tall viewport. Navigation and focus indicators must remain usable without horizontal document overflow. |
| Other browsers | Best effort for the MVP. Semantic HTML and CSS diagnostics should remain usable; browsers without `document.modelContext` show the explicit unavailable state. No browser without native WebMCP is treated as native support evidence. |

The WebMCP-enabled target is intentionally recorded separately from the
stable human-support target: a browser may render the complete human UI while
reporting that native WebMCP is unavailable. Any future WebMCP tool lane must
reverify the origin trial, API exposure, and registration behavior on the
production origin with the polyfill blocked.
