# Production APKG Worker boundary

The production importer treats ZIP metadata, names, and expanded bytes as
untrusted. `archive.ts` is loaded by `import-worker.ts`; application code must
use `BrowserImportWorkerFactory` and must not call the validator as a
main-thread parser fallback.

Archive member names use this canonical contract:

- names must be valid UTF-8 (or ASCII when the ZIP UTF-8 flag is absent),
  normalize to Unicode NFC, and compare collision keys case-insensitively;
- absolute paths, drive paths, separators, traversal segments, controls, and
  duplicate normalized names are rejected as `ARCHIVE_PATH_UNSAFE`;
- only root collection members (`collection.anki2`, `collection.anki21`, or
  `collection.anki21b`), `meta`, `media`, and numeric media members are in the
  accepted APKG namespace;
- transition and current collection members together are ambiguous and are
  rejected rather than guessed.

The central directory is checked before expansion. Original bytes, entry
count, per-entry bytes, aggregate expanded bytes, compression ratio, and
nested archive count are inclusive maxima: exactly the configured value is
accepted and the next greater value fails. ZIP64, multi-disk, encrypted, and
unknown compression methods are unsupported. Local/central names and bounds,
expanded sizes, and CRC-32 values must agree. Cancellation and elapsed-time
checks run before validation, for every central-directory/member iteration,
and around decompression. A failure never returns archive members or a
commit-ready graph.

`collection.ts` then selects exactly one proven collection layout. Legacy and
transition SQLite images are read directly; current `collection.anki21b`
images are decompressed with declared-window and streamed-output bounds after
protobuf package-version validation. The private SQLite/WASM image is opened
with `query_only`, application-owned fixed queries, and the required `unicase`
collation. Legacy JSON definitions and current normalized schema tables both
produce the same deterministically ordered graph. Source review values are not
queried; every normalized card is marked for fresh scheduling.

`maxUtf8Bytes` is an inclusive per-payload bound. It applies before decoding
legacy and current media maps, before decoding plain-text media, to every text
value returned by the fixed SQLite queries (including legacy JSON collection
metadata), and to each UTF-8 string extracted from modern protobuf template
and notetype configuration. A payload at the configured byte length is
accepted; one additional encoded byte returns `ARCHIVE_LIMIT_EXCEEDED` without
a graph.

Media maps are decoded only after collection and content validation. Legacy
JSON maps and current zstd/protobuf maps must use unique numeric members and
flat NFC names. Missing mapped members, duplicate normalized names, declaration
mismatches, active extensions, unknown signatures, and extension/content MIME
mismatches are terminal errors. Numeric archive members omitted from the map
are ignored with `MISSING_MEDIA_MAP_ENTRY`; mapped but card-unreferenced passive
media is preserved without a warning. Verified allow-listed image, short-audio,
and plain-text bytes are copied into package-owned SHA-256 records, and card
references are replaced with deterministic persisted keys. Missing safe card
references degrade with `MISSING_MEDIA` warnings.

The application service transfers the caller-owned package copy into a fresh
dedicated module Worker for each operation. The Worker transfers verified
media buffers back with its single terminal success; it never exposes a
partial graph. Caller cancellation and supersession carry their explicit
reason before immediate termination, while a Worker that does not finish
within `maxParseTimeMs` is terminated with `IMPORT_TIMEOUT`. Worker errors,
message-deserialization failures, and invalid active-operation messages map to
`WORKER_FAILED` without exposing browser or library exceptions.

On the main thread, operation identity is checked before accepting the
terminal graph and again immediately before calling the commit adapter. The
Worker is terminated as soon as its terminal message is accepted, so late
progress, errors, or duplicate terminals cannot race the commit. A fresh
structured clone of the graph is recursively frozen (excluding the private
typed-array storage itself) before it crosses the commit-ready boundary; the
typed arrays are already isolated by both Worker transfer and that defensive
clone. Browser coverage loads this exact service and Worker bundle from the
configured same-origin static base path under the harness CSP and verifies
main-thread heartbeat progress, cancellation without commit, monotonic public
progress, and the absence of external requests.
