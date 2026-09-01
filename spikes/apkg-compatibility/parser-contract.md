# APKG parser Worker contract

Scope: P0B stories `webmcp-anki-apkg-compatibility-spike-003` through `-005`.

The isolated parser Worker is exposed by `ParserWorkerClient` in
`src/parser-client.ts`. It accepts a transferable `ArrayBuffer`, a unique
operation ID, and explicit `ParseLimits`. The default limits are only a
convenience for the harness; a production caller should pass the application's
chosen values.

## Request and progress

```ts
{
  type: "parse",
  operationId: "apkg-parse-1",
  packageBytes: ArrayBuffer,
  limits: {
    maxPackageBytes,
    maxArchiveEntries,
    maxExpandedBytes,
    maxEntryBytes,
    maxCompressionRatio,
    maxParseTimeMs,
    maxMemoryBytes
  }
}
```

The Worker emits one progress message after each completed stage, in this
order, with `completed` values `1` through `6`:

1. `archive` — ZIP member names and declared sizes are checked before files
   are extracted.
2. `collection` — archive members and current-format metadata select one of
   the supported layouts.
3. `decompression` — current collection data is decoded from zstd.
4. `database` — the collection is opened read-only by SQLite/WASM.
5. `media` — legacy JSON or current protobuf media metadata and media bytes
   are validated and staged.
6. `sanitization` — card fields, templates, and CSS are sanitized and warning
   diagnostics are collected before the result can become commit-ready.

Progress is monotonic per operation. The client ignores a message for an
unknown, cancelled, or superseded operation ID, and ignores regressive stage
numbers.

## Terminal boundary

Every accepted operation emits at most one terminal message:

- `success` has `commitReady: true` and one serializable staged result.
- `error`, `unsupported`, and `cancelled` have `commitReady: false` and
  `stagedResult: null`.

`commitIfReady()` is the recording downstream boundary. It calls its callback
only for the success shape; no repository or IndexedDB implementation is part
of this spike. A package is never handed downstream while only some stage
records have been produced.

## Stable diagnostics

The Worker uses these codes:

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_LAYOUT` | No supported collection/member layout or metadata version. |
| `INVALID_ZIP` | ZIP structure or member decompression failed. |
| `ARCHIVE_LIMIT_EXCEEDED` | Package, entry count, entry size, expanded size, or compression ratio exceeded its limit. |
| `MEMORY_LIMIT_EXCEEDED` | The parser-owned live memory estimate, including a zstd window or staged output, exceeded `maxMemoryBytes`. |
| `INVALID_SQLITE` | Collection is not a readable SQLite database with the required base tables. |
| `INVALID_ZSTD` | A current collection or media member is not a valid zstd frame. |
| `INVALID_PROTOBUF_MEDIA_MAP` | Current metadata/media protobuf or legacy media JSON is malformed. |
| `DISALLOWED_MEDIA_MIME` | A mapped media member has an executable, unknown, or content-mismatched MIME type. |
| `UNSAFE_ARCHIVE_PATH` | An archive/media path is absolute, traversing, malformed, or collides after normalization. |
| `PARSE_LIMIT_EXCEEDED` | The operation exceeded `maxParseTimeMs`. |
| `CANCELLED` | Cancellation was observed at a cooperative task boundary. |

## Cancellation

Cancellation is cooperative: the Worker checks the operation ID before and
after every stage boundary and before each media item. ZIP, SQLite, zstd,
protobuf, sanitizer, and Web Crypto calls are synchronous once entered, so a
call already on the stack cannot be interrupted by a message event. The
client therefore discards late messages, and a production hard-cancel path
must terminate and recreate the dedicated Worker before starting another
operation. In either case, only a success terminal can cross the commit
boundary.

Chromium evidence is in `tests/browser/parser.spec.ts`; the test transfers a
real fixture into the bundled module Worker, observes all six stages, checks
the main-thread heartbeat, exercises structured failures, cancellation, and
supersession, and asserts that no external asset request occurs.

## Bounded failure and content safety policy

The archive filter enforces package size, central-directory entry count, ZIP
expanded size, per-entry size, and compression-ratio limits before extraction.
Current-format zstd headers are inspected before decoding; the Worker rejects a
window or streamed output that would exceed the configured expanded, per-entry,
or memory budget. `validation.peakMemoryBytes` records the high-water mark of
the parser-owned estimate for the successful staged result. SQLite/WASM is
opened read-only and is closed before the terminal is emitted.

Media map entries are checked against their archive members, declared byte
length, SHA-1, and a conservative allowlist of PNG/JPEG/GIF/WebP, audio, and
plain-text MIME signatures. HTML, SVG, script, stylesheet, archive, and
unknown media are rejected with `DISALLOWED_MEDIA_MIME`.

The sanitizer allows safe formatting and package-local image references only.
It strips scripts, event handlers, forms, embedded pages, navigation
attributes, external URLs, and active CSS networking. Type-answer, TTS, LaTeX,
JavaScript-dependent/template directives, and missing media are non-blocking
typed warnings; the supported text and Unicode content remains in the staged
result. Warning records are sorted deterministically by code and detail.

The browser matrix covers malformed ZIP/SQLite/zstd/protobuf/media data,
absolute/traversal and Unicode-colliding paths, nested archives, all configured
limit boundaries, stage-boundary cancellation, and the warning-producing
sanitization fixture. Every non-success terminal remains
`commitReady: false` with `stagedResult: null`.

## Normalized collection contract

The `normalized` value is format-independent and is complete before the
success terminal is sent:

- `decks` contains `{ id, name }` records. Current-schema unit-separator deck
  names are canonicalized to Anki's `::` hierarchy separator.
- `notetypes` contains the ordered field and template names for each notetype.
  `fields` contains `{ notetypeId, ordinal, name }` records, and
  `cardTemplates` contains `{ notetypeId, ordinal, name, questionFormat,
  answerFormat }` records.
- `notes` contains `{ id, sourceGuid, notetypeId, deckId, fields, tags }`.
  Field values are split on Anki's unit separator and tags are trimmed,
  deduplicated, and sorted.
- `cards` contains `{ id, noteId, deckId, templateOrdinal, scheduling }`.
  `scheduling` is always `"fresh"`; imported review fields such as due, queue,
  intervals, and ease are deliberately not active downstream scheduling input.
- `media` contains the canonical media name, source archive member, byte
  length, SHA-1, and transferable bytes. `css` is the deterministic
  concatenation of non-empty notetype styles.

Legacy `collection.anki2` and transition `collection.anki21` databases read
JSON definitions from `col.models` and `col.decks`. Current `collection.anki21b`
databases read `decks`, `notetypes`, `fields`, and `templates` when those tables
are present; template and notetype configuration is decoded from the pinned
Anki protobuf fields. The current package is still accepted when it carries a
legacy SQLite schema under the current zstd/protobuf archive layout, as covered
by the synthetic current fixture.

All definition, note, card, and media arrays are sorted by stable IDs, names,
or ordinals before the terminal is emitted. The database is opened read-only.
Anki current exports may carry a WAL-mode header without a sidecar WAL inside
the package, so the Worker owns a private copy with only the SQLite journal
mode header changed to rollback mode before in-memory deserialization. Package
bytes and their SHA-256 remain unchanged.
