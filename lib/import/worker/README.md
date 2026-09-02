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
