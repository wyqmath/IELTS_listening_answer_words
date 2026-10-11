"""Validate reusable, annotated vocabulary without a provider or source file."""
from __future__ import annotations

from collections import Counter
import hashlib
import json
import re
from typing import Any

TYPES = {'word', 'phrase', 'name', 'code', 'number', 'time', 'date'}
ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
IPA_RE = re.compile(r'^/[^/\r\n]+/$')


def normalize_document(value: Any) -> dict[str, Any]:
    """Copy and validate all entries; synonyms stay separate from answers."""
    document = dict(value) if isinstance(value, dict) else {'items': value}
    items = document.get('items')
    if not isinstance(items, list) or not items:
        raise ValueError('Vocabulary must contain a nonempty items array')
    if document.get('count', len(items)) != len(items):
        raise ValueError('Vocabulary count does not match items')
    ids: set[str] = set()
    cleaned = []
    for index, item in enumerate(items):
        location = f'Item {index + 1}'
        if not isinstance(item, dict):
            raise ValueError(f'{location} must be an object')
        row = dict(item)
        for field in ['id', 'original', 'english', 'phonetic', 'category', 'type', 'speakText']:
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError(f'{location} requires a nonempty {field}')
        if not ID_RE.fullmatch(row['id']) or row['id'] in {'constructor', 'prototype'} or row['id'] in ids:
            raise ValueError(f'{location} has an invalid or duplicate ID')
        ids.add(row['id'])
        if row['type'] not in TYPES or not IPA_RE.fullmatch(row['phonetic']):
            raise ValueError(f'{location} has an invalid type or IPA')
        for field in ['meanings', 'synonyms', 'acceptedAnswers']:
            if not isinstance(row.get(field), list):
                raise ValueError(f'{location} requires a {field} array')
        if not row['acceptedAnswers'] or any(not isinstance(a, str) or not a.strip() for a in row['acceptedAnswers']):
            raise ValueError(f'{location} has invalid accepted answers')
        if row['original'] not in row['acceptedAnswers']:
            raise ValueError(f'{location} must accept its original answer')
        for meaning in row['meanings']:
            if not isinstance(meaning, dict) or any(not isinstance(meaning.get(k), str) or not meaning[k].strip() for k in ['pos', 'zh']):
                raise ValueError(f'{location} has an invalid meaning')
        if row['type'] in {'word', 'phrase', 'name'} and not row['meanings']:
            raise ValueError(f'{location} requires Chinese meanings')
        for synonym in row['synonyms']:
            if not isinstance(synonym, dict):
                raise ValueError(f'{location} has an invalid synonym')
            meaning_index = synonym.get('meaningIndex')
            if type(meaning_index) is not int or not 0 <= meaning_index < len(row['meanings']):
                raise ValueError(f'{location} has an invalid synonym meaning index')
            if any(not isinstance(synonym.get(k), str) or not synonym[k].strip() for k in ['english', 'chinese', 'sense']):
                raise ValueError(f'{location} has an incomplete synonym')
            if not isinstance(synonym.get('note', ''), str):
                raise ValueError(f'{location} has an invalid synonym note')
        if not isinstance(row.get('pronunciationNote', ''), str):
            raise ValueError(f'{location} has an invalid pronunciation note')
        row.setdefault('pronunciationNote', '')
        row['chinese'] = '；'.join(f"{m['pos']} {m['zh']}" for m in row['meanings']) or None
        for field in ['sourceOldAnswer', 'sourceStatus']:
            row.pop(field, None)
        cleaned.append(row)
    document['items'] = cleaned
    document['version'] = 3
    document['count'] = len(cleaned)
    document['categoryCounts'] = dict(Counter(row['category'] for row in cleaned))
    if not document.get('datasetId'):
        content = json.dumps([[row['id'], row['original']] for row in cleaned], ensure_ascii=False).encode('utf-8')
        document['datasetId'] = 'vocab-' + hashlib.sha256(content).hexdigest()[:16]
    if not isinstance(document['datasetId'], str) or not ID_RE.fullmatch(document['datasetId']):
        raise ValueError('datasetId must use letters, digits, dots, underscores or hyphens')
    return document
