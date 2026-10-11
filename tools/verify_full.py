"""Standalone verifier for the full listening vocabulary JSON."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from full_pipeline import DEFAULT_SOURCE, VOCAB_PATH, VOCAB_JS_PATH, verify_document  # noqa: E402
from vocab_schema import normalize_document


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, help="optionally verify identities against this local source")
    parser.add_argument("--data", type=Path, default=VOCAB_PATH)
    parser.add_argument("--js", type=Path, default=VOCAB_JS_PATH)
    args = parser.parse_args()
    document = json.loads(args.data.read_text(encoding="utf-8"))
    validated = normalize_document(document)
    result = {'count': validated['count'], 'datasetId': validated['datasetId'], 'categoryCounts': validated['categoryCounts']}
    if args.source:
        if not args.source.is_file():
            parser.error('The specified local source is missing')
        result.update(verify_document(document, args.source))
    script = args.js.read_text(encoding="utf-8").strip()
    prefix = "window.LISTENING_DATA = "
    if not script.startswith(prefix) or not script.endswith(";"):
        raise ValueError("Browser data script has an unexpected format")
    if json.loads(script[len(prefix):-1]) != document:
        raise ValueError("vocab.json and the browser data script differ")
    result["jsonJsMatch"] = True
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
