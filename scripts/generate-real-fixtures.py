"""Generate minimal provenance-recorded packages with an exact Anki exporter.

This script intentionally imports Anki only from the caller-provided fixture
environment. Anki is not a browser or production dependency, and its source is
never copied into this repository.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

# Anki 2.1.49 ships protobuf descriptors that need the legacy Python runtime.
# Set this before importing Anki so the same command works with both pinned
# exporter environments without changing the repository dependency graph.
os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")

from anki import buildinfo  # noqa: E402
from anki.collection import Collection  # noqa: E402
from anki.exporting import AnkiPackageExporter  # noqa: E402


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = REPOSITORY_ROOT / "spikes" / "apkg-compatibility" / "fixtures"
REAL_ROOT = FIXTURE_ROOT / "real"
EXPECTED_EXPORTERS = {
    "legacy": "2.1.49",
    "transition": "25.09.4",
    "current": "25.09.4",
}
PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02"
    "0000000b4944415478da6364f80f00010501012718e3760000000049454e44ae426082"
)
MEDIA = {
    "café.png": PNG_BYTES,
    "音声.txt": "P0B fixture media — original repository text\n".encode("utf-8"),
}
FIELDS = ["Front", "Back", "Context"]
TEMPLATES = [
    ("Card 1", "{{Front}}", "{{Back}}"),
    ("Card 2", "{{Context}}", "{{Front}}"),
]
NOTES = [
    {
        "fields": [
            "こんにちは / café",
            '<img src="café.png"> [sound:音声.txt]\nAnswer α',
            "Context in the parent deck",
        ],
        "tags": ["media", "unicode"],
        "deck": "P0B Fixture",
    },
    {
        "fields": ["Second note", "Réponse β", "子 deck context"],
        "tags": ["templates"],
        "deck": "P0B Fixture::子 deck",
    },
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--layout", choices=EXPECTED_EXPORTERS, required=True)
    args = parser.parse_args()
    layout = str(args.layout)

    expected_version = EXPECTED_EXPORTERS[layout]
    if buildinfo.version != expected_version:
        raise SystemExit(
            f"{layout} requires anki=={expected_version}; "
            f"loaded Anki {buildinfo.version} ({buildinfo.buildhash})"
        )

    REAL_ROOT.mkdir(parents=True, exist_ok=True)
    output_path = REAL_ROOT / output_name(layout)

    with tempfile.TemporaryDirectory(prefix="apkg-real-source-") as temp_dir:
        source_path = Path(temp_dir) / "source.anki2"
        collection = build_collection(source_path)
        assert_collection_shape(collection)
        if layout == "current":
            collection.export_collection_package(str(output_path), True, False)
        else:
            AnkiPackageExporter(collection).exportInto(str(output_path))
            collection.close()

    record = make_record(layout, output_path)
    update_manifest(record)
    print(
        json.dumps(
            {
                "fixture": record["id"],
                "file": record["file"],
                "exporterVersion": buildinfo.version,
                "exporterBuild": buildinfo.buildhash,
                "byteSize": record["byteSize"],
                "sha256": record["sha256"],
            },
            ensure_ascii=False,
        )
    )


def build_collection(source_path: Path) -> Collection:
    collection = Collection(str(source_path))
    collection.models.remove_all_notetypes()
    model = collection.models.by_name("Basic")
    if model is None:
        raise RuntimeError("Anki did not create the stock Basic notetype")

    model["name"] = "P0B Fixture Note"
    model["flds"] = []
    model["tmpls"] = []
    for ordinal, name in enumerate(FIELDS):
        field = collection.models.new_field(name)
        field["ord"] = ordinal
        collection.models.add_field(model, field)
    for ordinal, (name, question, answer) in enumerate(TEMPLATES):
        template = collection.models.new_template(name)
        template["ord"] = ordinal
        template["qfmt"] = question
        template["afmt"] = f"{{{{FrontSide}}}}<hr id=answer>{answer}"
        collection.models.add_template(model, template)
    model["css"] = ".card { font-family: sans-serif; }"
    collection.models.update(model)

    media_names = {
        name: collection.media.write_data(name, data) for name, data in MEDIA.items()
    }
    parent_id = collection.decks.id("P0B Fixture")
    child_id = collection.decks.id("P0B Fixture::子 deck")
    deck_ids = {"P0B Fixture": parent_id, "P0B Fixture::子 deck": child_id}

    for note_data in NOTES:
        note = collection.new_note(model)
        note.fields[:] = [
            field.replace("café.png", media_names["café.png"])
            .replace("音声.txt", media_names["音声.txt"])
            for field in note_data["fields"]
        ]
        note.tags = list(note_data["tags"])
        collection.add_note(note, deck_ids[note_data["deck"]])

    return collection


def assert_collection_shape(collection: Collection) -> None:
    """Keep manifest expectations tied to the content before export."""

    if len(collection.models.all()) != 1:
        raise RuntimeError("fixture source must contain exactly one notetype")
    if len(collection.decks.all()) != 3:
        raise RuntimeError("fixture source must contain Default plus two fixture decks")
    if collection.note_count() != len(NOTES):
        raise RuntimeError("fixture source note count does not match the corpus")
    if collection.card_count() != len(NOTES) * len(TEMPLATES):
        raise RuntimeError("fixture source card count does not match the corpus")


def output_name(layout: str) -> str:
    if layout == "legacy":
        return "anki-2.1.49-legacy.apkg"
    if layout == "transition":
        return "anki-25.9.4-transition.apkg"
    return "anki-25.9.4-current.colpkg"


def make_record(layout: str, path: Path) -> dict[str, Any]:
    package_kind = "collection-colpkg" if layout == "current" else "deck-apkg"
    fixture_id = f"real-anki-{layout}"
    # Anki preserves the empty Default deck in both deck-package snapshots and
    # the full current collection package; record the observed archive shape.
    normalized = logical_expectation(
        include_default_deck=True,
        include_stock_notetype=layout != "current",
    )
    data = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    return {
        "id": fixture_id,
        "file": f"real/{path.name}",
        "fixtureType": "real-export",
        "layout": {
            "legacy": "legacy-anki2",
            "transition": "transition-anki21",
            "current": "current-anki21b",
        }[layout],
        "packageKind": package_kind,
        "supportStatus": "candidate",
        "byteSize": path.stat().st_size,
        "sha256": sha256(path.read_bytes()),
        "archive": {"members": archive_members(path, layout)},
        "expected": {
            "normalizedCounts": {
                "decks": len(normalized["decks"]),
                "notes": len(NOTES),
                "cards": len(NOTES) * len(TEMPLATES),
                "cardTemplates": len(normalized["templates"]),
                "fields": len(normalized["fields"]),
                "media": len(MEDIA),
                "mediaBytes": sum(len(data) for data in MEDIA.values()),
            },
            "semanticSha256": sha256(data),
            "normalized": normalized,
        },
        "provenance": {
            "kind": "real-export",
            "generator": "scripts/generate-real-fixtures.py",
            "command": f"python scripts/generate-real-fixtures.py --layout {layout}",
            "exporter": "Anki",
            "exporterVersion": buildinfo.version,
            "exporterBuild": buildinfo.buildhash,
            "sourceContent": "Two minimal notes, an original two-deck hierarchy, a two-template notetype, and original fixture media.",
            "contentLicense": "Original repository-owned content under the repository MIT license.",
            "redistributionBasis": "Only generated collection data and media are retained; no Anki source, bundled executable, or third-party deck content is copied.",
            "reproducibility": "Exporter snapshots are provenance-recorded; exporter-generated IDs and timestamps may change between runs. Compare logical normalized content and rerun the hash command when refreshing a snapshot.",
        },
    }


def logical_expectation(
    include_default_deck: bool,
    include_stock_notetype: bool,
) -> dict[str, Any]:
    decks = [
        {"name": "P0B Fixture"},
        {"name": "P0B Fixture::子 deck"},
    ]
    if include_default_deck:
        decks.insert(0, {"name": "Default"})
    notetypes = [
        {
            "name": "P0B Fixture Note",
            "fields": FIELDS,
            "templates": [name for name, _question, _answer in TEMPLATES],
        }
    ]
    if include_stock_notetype:
        notetypes.insert(
            0,
            {
                "name": "Basic",
                "fields": ["Front", "Back"],
                "templates": ["Card 1"],
            },
        )
    return {
        "decks": decks,
        "notetypes": notetypes,
        "fields": [field for notetype in notetypes for field in notetype["fields"]],
        "templates": [
            {"name": name, "ordinal": ordinal}
            for notetype in notetypes
            for ordinal, name in enumerate(notetype["templates"])
        ],
        "notes": [
            {"fields": note["fields"], "tags": note["tags"]} for note in NOTES
        ],
        "media": [
            {
                "name": name,
                "sha1": hashlib.sha1(data).hexdigest(),
                "bytes": len(data),
            }
            for name, data in MEDIA.items()
        ],
    }


def archive_members(path: Path, layout: str) -> list[dict[str, Any]]:
    members: list[dict[str, Any]] = []
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            name = info.filename
            role = "media-bytes" if name.isdigit() else "collection"
            required = True
            encoding = "stored" if info.compress_type == zipfile.ZIP_STORED else "deflate"
            if name == "meta":
                role, encoding = "package-metadata", "protobuf"
            elif name == "media":
                role = "media-map"
                encoding = "zstd" if layout == "current" else "json"
            elif name == "collection.anki2" and layout != "legacy":
                role, required = "compatibility-dummy", False
            elif name in {"collection.anki21", "collection.anki21b"}:
                role = "collection"
                encoding = "zstd" if name == "collection.anki21b" else "deflate"
            elif layout == "current" and name.isdigit():
                encoding = "zstd"
            members.append(
                {
                    "path": name,
                    "role": role,
                    "required": required,
                    "encoding": encoding,
                }
            )
    return members


def update_manifest(record: dict[str, Any]) -> None:
    manifest_path = FIXTURE_ROOT / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = {
            "schemaVersion": 1,
            "recordedOn": "2026-09-01",
            "purpose": "Auditable APKG compatibility fixtures for the isolated browser-Worker spike.",
            "layouts": [],
            "fixtures": [],
        }

    fixtures = [
        fixture
        for fixture in manifest.get("fixtures", [])
        if fixture.get("id") != record["id"]
    ]
    fixtures.append(record)
    fixtures.sort(key=lambda fixture: fixture["id"])
    manifest["fixtures"] = fixtures
    for layout in manifest.get("layouts", []):
        layout_id = layout.get("id")
        layout["realFixtureIds"] = [
            fixture["id"]
            for fixture in fixtures
            if fixture.get("fixtureType") == "real-export"
            and fixture.get("layout") == layout_id
        ]
    manifest_path.write_text(
        f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


if __name__ == "__main__":
    main()
