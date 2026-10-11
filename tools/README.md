# Annotation and Audit Tools

**English** | [简体中文](README.zh-CN.md) · [App and practice method](../README.md)

These tools generate, maintain and verify vocabulary. Daily practice only needs `app/index.html` or the `打开网页.cmd` launcher in this folder. Python scripts use the standard library and require Python 3.10+. Run the commands below from the repository root.

## Custom vocabulary

Use JSON for CET-4, CET-6 or any other list, with any nonzero count and your own categories. See the [raw source example](examples/source.json) and [annotated example](examples/vocab.json). The legacy Markdown parser only supports the original 1533-entry notes format; use JSON for general lists.

Source JSON can be a string array, object array or an object with `items`. Source objects require `original`; optional fields are `id`, `category`, `type`, `sourceMeaning`. Missing IDs are generated from position; preserve stable IDs when revising a list. Types are `word`, `phrase`, `name`, `code`, `number`, `time`, `date`. Specify numeric types explicitly.

Annotated JSON fields:

| Field | Meaning |
| --- | --- |
| `datasetId` | Root vocabulary identity for separate study records; change it for a different list |
| `items` | Nonempty root array |
| `id` / `original` | Stable entry ID / original answer, preserving complete entries |
| `english` / `phonetic` | Complete English form or reading / British IPA enclosed by `/.../` |
| `meanings` | `{pos, zh}` senses, required for words, phrases and names |
| `category` / `type` | Category / entry type |
| `acceptedAnswers` | Nonempty answer array containing the original |
| `synonyms` | `{english, chinese, meaningIndex, sense, note}` study suggestions |
| `speakText` | English text to read |
| `pronunciationNote` | Optional note; use an empty string when unnecessary |

`meaningIndex` is zero-based and links to a specific Chinese sense. Synonyms are separate from accepted answers. Literal numbers, numeric dates/times and codes may use English readings and IPA only; calendar words still need Chinese. Preserve articles, plurals and tense. Label uncertain proper-name pronunciation in notes.

## Manual annotation and export

Copy the annotated example and fill in your own data, then export and validate locally:

```sh
python tools/build_vocab.py --input tools/examples/vocab.json --output-dir private/my-vocab
python tools/verify_full.py --data private/my-vocab/vocab.json --js private/my-vocab/vocab.js
```

After review, replace the sample input with your file and update the app using `--replace`:

```sh
python tools/build_vocab.py --input tools/examples/vocab.json --output-dir app/data --replace
python tools/verify_full.py
```

Existing output is protected unless `--replace` is present. Both `vocab.json` and `vocab.js` are generated together. Preserve the original vocabulary and export a study backup before replacement. Different lists need different `datasetId` values; keep the ID and entry IDs when revising the same list.

## Optional API annotation

The process is raw-list parsing, local readings and answer rules, structured batch annotation, semantic review, confirmed repairs, validation and export. The model generates complete British IPA, common Chinese senses, sense-specific synonyms and notes. Source text is treated as data. Review the result: format validation does not prove semantic accuracy.

Annotation, review and patch tools require an explicit `--source` path to your local input. No original source document is bundled. The default vocabulary output is `app/data/`; use a separate output directory while preparing a new list.

Parsing needs no API:

```sh
python tools/full_pipeline.py --source tools/examples/source.json --prepare-only --output-dir private/my-annotation
```

Annotation requires a compatible HTTPS Chat Completions endpoint with `response_format: {"type":"json_object"}`. Supply the complete request URL, model and key locally at runtime. No provider address or model is configured by default; `.env` files are not loaded automatically.

Configure your own PowerShell terminal:

```powershell
$env:LISTENING_API_URL = Read-Host 'Complete HTTPS Chat Completions request URL'
$env:LISTENING_API_MODEL = Read-Host 'Model name'
python tools/full_pipeline.py --source tools/examples/source.json --output-dir private/my-annotation --batch-size 12 --workers 4
```

The script prompts for a hidden key and does not save it. Automation may supply `LISTENING_API_KEY` through the process environment. URLs cannot contain embedded credentials, query parameters or fragments. Configuration is used only by annotation/review and never enters the app or vocabulary.

Thinking parameters are omitted by default. Only enable these when the provider/model supports them:

```powershell
$env:LISTENING_API_THINKING = 'enabled'
$env:LISTENING_API_REASONING_EFFORT = Read-Host 'Supported reasoning effort'
```

They send `thinking: {"type":"enabled"}` and `reasoning_effort`, respectively. Remove unsupported variables. Only structured results are saved, not complete responses or reasoning. Service error logs retain HTTP status or error types.

Batches save atomically; rerun the same command to resume. `--reset` discards checkpoint progress. Use a new output directory for a new source. `--repair --ids ... --feedback ...` regenerates selected entries from confirmed feedback.

## Review and repair

For an API-generated custom list:

```sh
python tools/review_annotations.py --source tools/examples/source.json --data private/my-annotation/vocab.json --batch-size 20 --workers 4
python tools/full_pipeline.py --source tools/examples/source.json --output-dir private/my-annotation --repair --ids demo-word --feedback private/my-annotation/quality_review.json
python tools/verify_full.py --source tools/examples/source.json --data private/my-annotation/vocab.json --js private/my-annotation/vocab.js
```

Review output defaults to the vocabulary directory, with optional `--output-dir`. IDs are examples; repair actual confirmed issues, then review again. Manually annotated JSON needs basic `verify_full.py` checks without a pipeline source signature.

Manual patches use `apply_review_patch.py` and `{"items":[{"id":"demo-word","fields":{"pronunciationNote":"Note"}}]}`. Only `phonetic`, `meanings`, `synonyms`, `pronunciationNote` may change, preserving original answers, categories and aliases:

```sh
python tools/apply_review_patch.py private/confirmed-patch.json --source tools/examples/source.json --output-dir private/my-annotation
```

Basic verification needs no original notes or API. `--source` additionally checks the pipeline source signature, identities, order and local answer rules. Removed disposable checkpoints can be reconstructed from complete generated vocabulary belonging to the same source; vocabulary identity is preserved.

## Browser audits

```sh
npm --prefix tools ci
npm --prefix tools run test:flows
npm --prefix tools run test:custom
```

Flow audits start a random-port local server and test direct HTML opening too. Before other bundled-list audits, start `python tools/preview_server.py`, then run `npm --prefix tools run test:browser`, `npm --prefix tools run test:visual` or `npm --prefix tools run test:speech`. `--url` can select another local preview address.

For a different port, pass the URL directly, for example `node tools/audit_visual.cjs --url=http://127.0.0.1:11546/`. In Windows PowerShell, use `npm.cmd` when forwarding extra arguments through npm's `--`.

Audits use isolated headless browsers, never existing user tabs. Playwright selects installed Chrome by default. Applicable audits support `AUDIT_BROWSER=chrome`, `msedge` or `chromium`; Chrome/Edge compatibility audits launch both. Chromium requires `npm --prefix tools exec -- playwright install chromium`. An existing Playwright module can be supplied via `AUDIT_PLAYWRIGHT`; no personal installation paths are bundled.

Results and screenshots default to `tingjian-audit` in the system temporary directory; override with `AUDIT_OUTPUT_DIR`. Full-flow, layout and compatibility audits target the bundled IELTS vocabulary. `audit_custom.cjs` uses sample data to test variable counts, four modes, number aliases, correction, backup and record separation.

Speech audits distinguish native events from controlled simulation. Simulation checks shortcuts, repeats, pause, cancellation and error handling; it does not prove audible output. Confirm actual speech on the target device.

## Scripts

| Script | Purpose |
| --- | --- |
| `打开网页.cmd` / `启动本地预览.cmd` | Open `app/index.html` / start the localhost preview |
| `vocab_schema.py` / `build_vocab.py` | Custom annotated JSON validation/export |
| `full_pipeline.py` | Source parsing, batches, resume, repair and export |
| `review_annotations.py` / `apply_review_patch.py` | Semantic review / confirmed field repairs |
| `verify_full.py` | Fields, sense links, JSON/JS equality, optional source verification |
| `preview_server.py` | Localhost static preview |
| `audit_flows.cjs` / `audit_custom.cjs` | Bundled/custom practice flows |
| `audit_visual.cjs` / `audit_speech.cjs` | Viewport/fullscreen layout / speech controls and native failures |
| `verify_browser.cjs` / `playwright_runtime.cjs` | Chrome/Edge compatibility / runtime configuration |
| `check_public.py` | Public candidates, staged files and Git history scanning |

## Before publication

```sh
python tools/check_public.py
git diff --cached --check
```

The scanner writes no report by default; optional `--report` saves one locally. Publish the checked files using Git.

Public files use an allowlist. Original notes, annotation/review state, actual API configuration, logs, study backups and temporary reports are excluded. `.gitignore` cannot erase existing Git history, so history is also scanned. Inspect actual staged files before upload and avoid uploading the whole local working folder.
