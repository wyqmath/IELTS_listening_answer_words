"""Check Git publication candidates without printing suspected secret values."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_ROOT = {
    '.gitignore', '.gitattributes', 'README.md', 'README.zh-CN.md',
    'package.json', 'package-lock.json', 'index.html', 'app.js', 'styles.css',
    '打开网页.cmd', '启动本地预览.cmd',
}
# Former public documents are still scanned for secrets in existing commits.
HISTORICAL_PUBLIC_PATHS = {'LICENSE', 'README.en.md', '使用说明.md', 'tools/README.en.md'}
PRIVATE_EXAMPLES = [
    '.env', '.env.local', 'private/source.md', '1.md', 'source.md',
    'data/source_rows.json', 'data/full_annotation_state.json',
    'data/quality_review.json', 'data/full_pipeline.log', 'data/vocab.before_review.json',
    'reports/preview.png', 'reports/audit.json', 'node_modules/example/index.js',
    'tools/__pycache__/example.pyc', 'study-backup.json', 'dist/build-output.json',
]
SECRET_PATTERNS = {
    'api-key-format': re.compile(rb'(?i)\b[a-f0-9]{32}\.[a-z0-9]{16}\b'),
    'github-token': re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
    'service-token': re.compile(rb'\bsk-[A-Za-z0-9_-]{24,}\b'),
    'aws-access-key': re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'private-key': re.compile(rb'-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----'),
    'jwt-token': re.compile(rb'\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b'),
    'literal-bearer-token': re.compile(rb'\bBearer\s+[A-Za-z0-9_+./=-]{20,}'),
}
LITERAL_SECRET = re.compile(
    r'''(?im)["']?\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']([^\r\n"']{8,})["']''')
URL_PATTERN = re.compile(r'''https?://[^\s"'<>`]+''', re.I)
PERSONAL_PATH = re.compile(r'(?i)(?:\b[a-z]:[\\/]+Users[\\/]+[^\s"<>]+|/(?:Users|home)/[a-z0-9_.-]+/)')
REASONING = re.compile(rb'"reasoning_content"\s*:')


def git(*arguments: str, input_bytes: bytes | None = None) -> bytes:
    """Use argv, never a shell, and keep command errors free of content values."""
    result = subprocess.run(['git', '-C', str(ROOT), *arguments], input=input_bytes,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError('Git inspection failed; initialize this folder with git init first')
    return result.stdout


def public_path(name: str) -> bool:
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        return False
    if name in PUBLIC_ROOT or name in {'assets/icon.svg', 'data/vocab.json', 'data/vocab.js', 'examples/source.json', 'examples/vocab.json'}:
        return True
    return (len(path.parts) == 2 and path.parts[0] == 'tools'
            and (path.suffix in {'.py', '.cjs'} or path.name in {'README.md', 'README.zh-CN.md'}))


def inspect_content(data: bytes, *, include_metadata: bool = True) -> set[str]:
    """Return labels only. Never retain a match or its value in a report."""
    labels = {label for label, pattern in SECRET_PATTERNS.items() if pattern.search(data)}
    text = data.decode('utf-8', errors='replace')
    for match in LITERAL_SECRET.finditer(text):
        value = match.group(1).strip()
        if not value.startswith('<') and not value.startswith('${'):
            labels.add('literal-secret-assignment')
    if include_metadata:
        if PERSONAL_PATH.search(text):
            labels.add('personal-absolute-path')
        if REASONING.search(data):
            labels.add('saved-model-reasoning')
        for match in URL_PATTERN.finditer(text):
            try:
                parts = urlsplit(match.group(0).rstrip(').,;'))
                host = (parts.hostname or '').lower()
                if parts.username is not None or parts.password is not None:
                    labels.add('credentials-in-url')
                if (host not in {'127.0.0.1', 'localhost', '::1'}
                    and (re.search(r'/(?:api|v[1-9]|anthropic|messages|responses|chat/completions)(?:/|$)', parts.path, re.I)
                         or re.search(r'(?:^|\.)(?:bigmodel|openai|anthropic)\.(?:cn|com)$', host))):
                    labels.add('annotation-api-address')
            except ValueError:
                labels.add('malformed-url')
    return labels


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, help='optionally save the scanner report locally')
    args = parser.parse_args()
    repository = Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve()
    if repository != ROOT.resolve():
        raise RuntimeError('Initialize this project folder as its own Git repository')
    filenames = sorted({name.decode('utf-8') for name in
                        git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0') if name})
    findings: list[dict[str, str]] = []
    hashes: dict[str, str] = {}

    def record(data: bytes, name: str, scope: str, metadata: bool = True) -> None:
        for category in sorted(inspect_content(data, include_metadata=metadata)):
            findings.append({'file': name, 'scope': scope, 'category': category})

    for name in filenames:
        path = ROOT / name
        if not public_path(name):
            findings.append({'file': name, 'scope': 'working-tree', 'category': 'private-file-selected'})
        elif path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(ROOT.resolve()):
            findings.append({'file': name, 'scope': 'working-tree', 'category': 'missing-or-linked-file'})
        else:
            data = path.read_bytes()
            hashes[name] = hashlib.sha256(data).hexdigest()
            record(data, name, 'working-tree')

    stages = [entry for entry in git('ls-files', '--stage', '-z').split(b'\0') if entry]
    for entry in stages:
        metadata, raw_name = entry.split(b'\t', 1)
        mode, digest, stage = metadata.decode().split()
        name = raw_name.decode('utf-8')
        if stage != '0' or mode == '120000' or not public_path(name):
            findings.append({'file': name, 'scope': 'index', 'category': 'private-or-conflicted-staged-file'})
        record(git('cat-file', 'blob', digest), name, 'index')

    ignored = {name.decode('utf-8') for name in git('check-ignore', '--no-index', '-z', '--stdin',
               input_bytes=('\0'.join(PRIVATE_EXAMPLES) + '\0').encode()).split(b'\0') if name}
    for name in PRIVATE_EXAMPLES:
        if name not in ignored:
            findings.append({'file': name, 'scope': 'ignore-rules', 'category': 'private-file-not-ignored'})

    # Inspect old blobs as well: ignoring/removing a file cannot erase Git history.
    historical = git('rev-list', '--objects', '--all').decode('utf-8').splitlines()
    historical_blobs = 0
    for entry in historical:
        digest, _, name = entry.partition(' ')
        if git('cat-file', '-t', digest).strip() != b'blob':
            continue
        historical_blobs += 1
        if name and not public_path(name) and name not in HISTORICAL_PUBLIC_PATHS:
            findings.append({'file': name, 'scope': 'history', 'category': 'private-file-in-history'})
        record(git('cat-file', 'blob', digest), name or '<unnamed blob>', 'history')

    # Check local text artifacts for credential formats too, without rejecting
    # their expected private paths or printing source/study data.
    local_text_files = 0
    for path in ROOT.rglob('*'):
        relative = path.relative_to(ROOT)
        if '.git' in relative.parts or 'node_modules' in relative.parts or not path.is_file() or path.is_symlink():
            continue
        if path.suffix.lower() in {'.json', '.js', '.cjs', '.py', '.md', '.txt', '.cmd', '.log', '.env', '.html', '.css', '.svg'} or path.name.startswith('.env'):
            local_text_files += 1
            if relative.as_posix() not in hashes:
                record(path.read_bytes(), relative.as_posix(), 'local-excluded', metadata=False)

    report = {
        'checkedAt': datetime.now(timezone.utc).isoformat(), 'passed': not findings,
        'publicFileCount': len(filenames), 'stagedFileCount': len(stages),
        'historicalBlobCount': historical_blobs, 'localTextFilesScanned': local_text_files,
        'privateExclusionsChecked': len(PRIVATE_EXAMPLES), 'findings': findings,
        'publicFileHashes': hashes,
    }
    if args.report:
        report_path = args.report if args.report.is_absolute() else ROOT / args.report
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'publicFileHashes'},
                     ensure_ascii=True, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f'Publication check did not complete ({type(error).__name__}); check Git initialization and paths.', file=sys.stderr)
        raise SystemExit(2)
