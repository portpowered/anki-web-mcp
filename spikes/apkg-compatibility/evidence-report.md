# APKG compatibility evidence report

Status: supported for this isolated spike only. This report does not authorize
production UI, IndexedDB, scheduling, or WebMCP integration.

The reproducible evidence command is `bun run evidence`. It verifies the
fixture corpus, typechecks, runs unit tests, builds the production assets,
measures the dependency bundle, serves that build through the static preview,
and runs the actual Chromium Worker evidence spec. The command writes the
current human-readable and machine-readable run to ignored
`.artifacts/evidence/report.md` and `.artifacts/evidence/report.json`; those
outputs must not be committed as CI or verification records.

## Recorded matrix

The last local evidence run was recorded on **2026-09-01** with Chromium
**152.0.7977.64** and the `P0B parser Worker protocol v1`. Every row below was
parsed by the real module Worker, had all six monotonic stages, and produced a
matching package SHA-256 and semantic checksum. Counts use
`decks/notes/cards/templates/fields/media/mediaBytes`.

| Layout | Fixture and origin | Exact exporter | Detected collection/member schema | Expected → observed | Package SHA-256 | Semantic SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| `legacy-anki2` | `synthetic-legacy-anki2` · synthetic | deterministic generator | `collection.anki2`; `cards`, `col`, `graves`, `notes`, `revlog` | `2/2/4/2/3/2/115` → `2/2/4/2/3/2/115` | `69e934219f4892f2e56ba6700dd76ad0964a6c680a2239873407df8b26597d9b` | `7423f8ff487bf2dc5f254c1f288ac60d9229e257047693cf4f771c6806c9092a` |
| `legacy-anki2` | `real-anki-legacy` · real export | Anki `2.1.49`, build `dc80804a` | `collection.anki2`; `cards`, `col`, `graves`, `notes`, `revlog`, `sqlite_stat1`, `sqlite_stat4` | `3/2/4/3/5/2/115` → `3/2/4/3/5/2/115` | `9697aa478e3ce5c941852e957c2474599dd07c7c39a6ef6bf78a51d44f9e9792` | `c58215261c3fa9c6818088a40988c803ce4910ec49c65a2260c4624550b886a6` |
| `transition-anki21` | `synthetic-transition-anki21` · synthetic | deterministic generator | `collection.anki21`; `cards`, `col`, `graves`, `notes`, `revlog` | `2/2/4/2/3/2/115` → `2/2/4/2/3/2/115` | `a3500e396439646a12603ed8f72df5f15c097ca82308ebace8bef7dcec5881e0` | `7423f8ff487bf2dc5f254c1f288ac60d9229e257047693cf4f771c6806c9092a` |
| `transition-anki21` | `real-anki-transition` · real export | Anki `25.09.4`, build `d52ca669` | `collection.anki21`; `cards`, `col`, `graves`, `notes`, `revlog`, `sqlite_stat1`, `sqlite_stat4` | `3/2/4/3/5/2/115` → `3/2/4/3/5/2/115` | `9d36ed6ad6149e8d06896505a61847896cd912f14fc70f39dcd46217c7593a35` | `c58215261c3fa9c6818088a40988c803ce4910ec49c65a2260c4624550b886a6` |
| `current-anki21b` | `synthetic-current-anki21b` · synthetic | deterministic generator | zstd `collection.anki21b`; `cards`, `col`, `graves`, `notes`, `revlog` | `2/2/4/2/3/2/115` → `2/2/4/2/3/2/115` | `1ede2f7e046430020eda754304fe8cb0efdcef79c16cf375f75f6519aa0131ff` | `7423f8ff487bf2dc5f254c1f288ac60d9229e257047693cf4f771c6806c9092a` |
| `current-anki21b` | `real-anki-current` · real export | Anki `25.09.4`, build `d52ca669` | zstd `collection.anki21b`; current `decks`, `fields`, `notetypes`, `templates` tables plus collection tables | `3/2/4/2/3/2/115` → `3/2/4/2/3/2/115` | `8a7040f3ecd3be776a66dec00aba66d7f698ed21da4a59a25d4e6876b76785b3` | `abac1203fe548e298db4c251ac816cb199815326b4986d16953cd7922b2a682a` |

The corresponding real-export and synthetic provenance, archive members,
byte sizes, expected counts, redistribution basis, and fixture hashes are in
[`fixtures/manifest.json`](fixtures/manifest.json). Synthetic archives are
deterministic probes, not exporter evidence. Real snapshots contain only
original repository-owned content and are provenance snapshots because Anki
may assign new IDs or timestamps when regenerating them.

## Explicit exclusions

| Layout or version | Status | Stable outcome | Reason |
| --- | --- | --- | --- |
| `collection.anki20`, `collection.anki21c`, or any other unrecognized `collection.*` member | Unsupported | `UNSUPPORTED_LAYOUT` | No fixture or normalization branch proves the layout; the Worker rejects it instead of selecting a nearby branch. |
| Current package metadata version other than `3` | Unsupported | `UNSUPPORTED_LAYOUT` | The protobuf metadata version is checked explicitly and is not treated as compatible with version 3. |
| Any Anki exporter version not listed above | Inconclusive; no compatibility claim | `UNSUPPORTED_LAYOUT` unless separately proven | Compatibility is never inferred from a nearby release. Add a provenance-recorded export and rerun the complete evidence command. |

The adverse corpus supplies direct runtime examples for unknown layout,
malformed SQLite/zstd/protobuf/media metadata, unsafe paths, disallowed media,
and nested archives. Every adverse terminal observed `commitReady: false` and
`stagedResult: null`.

## Stack and runtime evidence

The exact runtime pins are recorded in
[`decision-record.md`](decision-record.md): `fflate@0.8.3`,
`@sqlite.org/sqlite-wasm@3.53.0-build1`, `fzstd@0.1.1`, `protobufjs@8.8.0`,
and `xss@1.0.15`; the toolchain is Bun `1.4.0`, Vite `8.2.1`, TypeScript
`5.9.3`, and Playwright `1.58.2`.

The recorded static-preview run observed navigation status 200, four
same-origin emitted assets, zero external requests, zero CSP violations, a
dedicated Worker runtime, and a progressing main-thread heartbeat. The bundle
measurement was **1,732,685 raw / 664,801 gzip bytes** for stack assets and an
incremental **1,731,971 raw / 664,387 gzip bytes** over the no-runtime
baseline. Re-run `bun run evidence` after dependency or bundler changes; the
hash-suffixed asset names are intentionally not part of the contract.

The Worker-reported parser-owned memory high-water samples were 75,951 bytes
(synthetic legacy), 285,673 (real legacy), 114,044 (synthetic transition),
450,386 (real transition), 222,238 (synthetic current), and 392,736 (real
current), under the configured 128 MiB parser limit. These are allocation
estimates, not portable browser heap telemetry.

Cancellation was exercised after each of `archive`, `collection`,
`decompression`, `database`, `media`, and `sanitization`. Each returned the
stable `CANCELLED` terminal with no staged result. Since synchronous library
calls cannot be interrupted once entered, a production hard-cancel path must
terminate and recreate the Worker and discard late results.

## Downstream adoption constraints

- Only a complete success terminal with `commitReady: true` can cross the
  normalized staged-result boundary.
- Duplicate replacement defaults to cancellation; imported scheduling starts
  fresh, with review/scheduling fields retained only as diagnostics.
- Type-answer, TTS, LaTeX, JavaScript-dependent behavior, missing media, and
  similar safely degradable features produce typed warnings while supported
  text and safe formatting remain usable.
- The parser can be adopted or replaced behind the serializable
  `NormalizedStagedResult` contract without production UI, IndexedDB,
  scheduler/session, or WebMCP registration code.
