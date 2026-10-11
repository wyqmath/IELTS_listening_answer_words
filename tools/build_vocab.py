"""Validate a self-annotated JSON vocabulary and export matching JSON/JS."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from vocab_schema import normalize_document

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'data')
    parser.add_argument('--replace', action='store_true', help='replace an existing vocabulary pair')
    args = parser.parse_args()
    document = normalize_document(json.loads(args.input.read_text(encoding='utf-8-sig')))
    target = args.output_dir
    if not args.replace and any((target / name).exists() for name in ['vocab.json', 'vocab.js']):
        parser.error('Output vocabulary already exists; use another directory or --replace')
    target.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, ensure_ascii=False, indent=2)
    contents = {'vocab.json': payload + '\n', 'vocab.js': 'window.LISTENING_DATA = ' + payload + ';\n'}
    for name, text in contents.items():
        (target / (name + '.tmp')).write_text(text, encoding='utf-8')
    for name in contents:
        (target / (name + '.tmp')).replace(target / name)
    print(json.dumps({'count': document['count'], 'datasetId': document['datasetId'], 'exported': list(contents)}, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
