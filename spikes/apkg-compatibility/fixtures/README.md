# APKG fixture corpus

`manifest.json` is the source of truth for fixture IDs, archive members,
checksums, expected normalized counts, provenance, redistribution basis, and
the scenarios that production importer tests must exercise. The corpus is
shared by the production import suites and the isolated compatibility harness.
The three layout rows are deliberately conservative:

| Layout | Collection member | Real exporter snapshot |
| --- | --- | --- |
| `legacy-anki2` | `collection.anki2` | Anki `2.1.49` deck package |
| `transition-anki21` | `collection.anki21` plus a compatibility `collection.anki2` | Anki `25.09.4` deck package |
| `current-anki21b` | `meta`, zstd `collection.anki21b`, and zstd/protobuf `media` | Anki `25.09.4` collection package |

`collection.anki21b` is the exact member spelling used by the current Anki
exporter. The PRD's `collection.21b` shorthand refers to this row.

## Synthetic fixtures

Regenerate the deterministic corpus with:

```text
bun run fixtures:generate
bun run fixtures:verify
```

The generator uses only Bun's pinned SQLite implementation, `fflate`, and
original repository-owned content. It creates two decks, two notes, two card
templates, three fields, Unicode text, a PNG image, an original one-sample PCM
WAV, fixed source IDs, and
fixed scheduling values that are diagnostic-only. Legacy and transition use a
JSON media map; current uses protobuf media entries and raw zstd frames. The
synthetic layout archives have the same logical normalized expectation and
semantic checksum across all three rows.

The same command also creates small adverse inputs for later Worker tests:
invalid SQLite/JSON/protobuf declarations, corrupt zstd, absolute/traversal
and NFC-colliding archive or media paths, disallowed HTML media, unknown
layout, and a nested archive. It also creates a warning-producing sanitization
fixture with original malicious markup and unsupported Anki directives. They
contain no large or third-party data and are never compatibility claims.

## Real-export snapshots

The real snapshots were exported from a temporary collection containing only
the original fixture strings and media bytes. No shared deck, third-party
content, Anki source, or bundled executable is copied into this repository.
The generated collection data and media are retained under the repository MIT
license; Anki is used only as an external exporter in the fixture-generation
environment.

Use separate environments because the legacy and modern exporter pins cannot
be installed together:

```text
python -m pip install --target .tmp/anki-exporter-legacy -r scripts/fixture-requirements-legacy.txt
$env:PYTHONPATH = ".tmp/anki-exporter-legacy"
python scripts/generate-real-fixtures.py --layout legacy

python -m pip install --target .tmp/anki-exporter-modern -r scripts/fixture-requirements-modern.txt
$env:PYTHONPATH = ".tmp/anki-exporter-modern"
python scripts/generate-real-fixtures.py --layout transition
python scripts/generate-real-fixtures.py --layout current
```

The script checks Anki's reported build version before writing an artifact and
records the exporter version, build hash, command, archive members, byte size,
SHA-256, logical semantic checksum, and content-license basis in the manifest.
Exporter snapshots can change assigned IDs and timestamps on regeneration, so
their byte checksums are provenance snapshots; compare their logical manifest
expectations and refresh the recorded hash together with the snapshot.

Each layout is present only because an exact-version real exporter snapshot and
a deterministic synthetic equivalent agree on the expected logical content.
The manifest's support claim is deliberately narrower than the application
claim: production compatibility is established only when a production test
passes these bytes through the public import service and asserts its outcome
and normalized records. Nearby exporter versions and synthetic-only layouts
remain unproven.

`coverage` maps required content, adverse-input, and configurable-limit
scenarios to fixture IDs. Limit entries name valid base packages: production
tests apply the relevant limit at the exact observed boundary and at
boundary-plus-one rather than maintaining redundant large archives.

The published matrix and runtime evidence are in
[`../evidence-report.md`](../evidence-report.md); the reproducible command is
`bun run evidence`.
