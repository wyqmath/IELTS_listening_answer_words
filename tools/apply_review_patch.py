"""Apply narrowly scoped semantic corrections and export validated data."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import full_pipeline as pipeline

ALLOWED = {"phonetic", "meanings", "synonyms", "pronunciationNote"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("patch", type=Path)
    parser.add_argument("--source", type=Path, required=True, help="the local source used for annotation")
    parser.add_argument("--output-dir", type=Path, help="directory containing the generated vocabulary/checkpoints")
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error("The specified local source is missing")
    if args.output_dir:
        pipeline.configure_output_dir(args.output_dir)
    patch = json.loads(args.patch.read_text(encoding="utf-8"))
    edits = patch.get("items") if isinstance(patch, dict) else None
    if not isinstance(edits, list) or not edits:
        raise ValueError("Patch must contain a nonempty items array")
    rows = pipeline.parse_source(args.source)
    source_by_id = {row["id"]: row for row in rows}
    state = pipeline._load_state(args.source, rows, False)
    seen = set()
    for edit in edits:
        if not isinstance(edit, dict) or edit.get("id") not in source_by_id or edit["id"] in seen:
            raise ValueError("Patch ID is unknown or duplicated")
        item_id = edit["id"]
        fields = edit.get("fields")
        if not isinstance(fields, dict) or not fields or not set(fields) <= ALLOWED:
            raise ValueError("Patch fields are empty or include locally-owned answer metadata")
        current = state["items"].get(item_id)
        if not current or current.get("annotationRevision") != pipeline.ANNOTATION_REVISION:
            raise ValueError("Patch requires a completed current-revision annotation")
        patched = dict(current)
        patched.update(fields)
        state["items"][item_id] = pipeline._normalize_annotated(source_by_id[item_id], patched)
        seen.add(item_id)
    document = pipeline.export_document(state, rows, args.source)
    print(json.dumps({"patched": sorted(seen), "count": document["count"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
