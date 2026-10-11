# Tingjian · English Listening and Flashcard Practice

**English** | [简体中文](README.zh-CN.md)

A simple English listening and spelling trainer, bundled with **1533 IELTS listening answer entries**. It includes listening, Chinese and IPA spelling prompts, flashcards, a mistake book and daily statistics. The interface uses Chinese by default.

The same practice system works with your own CET-4, CET-6 or other English vocabulary. There is no fixed entry count: annotate your list with English, IPA, Chinese meanings and answer rules, then use it in this app. The bundled data is an answer vocabulary collection; speech is synthesized, rather than taken from original exam recordings.

## Folder layout

```text
README.md / README.zh-CN.md
index.html Web entry
app/       Styles, scripts, icon and vocabulary
tools/     Windows launchers, annotation tools, audits and examples
```

The original study notes are not included. The structured vocabulary is in `app/data/`; custom-list examples are in `tools/examples/`.

## Open the page

Keep the downloaded folder together and open [`index.html`](index.html) or double click `tools/打开网页.cmd`. Chrome or Edge is recommended. Daily practice needs no installation, account or API configuration.

| Launcher | Purpose | Requirements |
| --- | --- | --- |
| `tools/打开网页.cmd` | Opens the local HTML in the default browser | Browser |
| `tools/启动本地预览.cmd` | Starts a local server at `http://127.0.0.1:11545/` | Browser, Python 3 |

These are alternative Windows launchers. Keep the server terminal open and press `Ctrl+C` to stop it. On other systems, open HTML directly or run `python tools/preview_server.py`. The page does not automatically refresh.

File and HTTP pages have separate browser storage. Export a study backup before changing browser, path, port or opening method.

The default appearance is black text on white, with Arial and system sans-serif fonts. Settings offer white, warm paper and dark palettes, applied to every view and fullscreen. Your choice is saved with your study settings and included in backups.

## My practice method

| Mode | Practice |
| --- | --- |
| Listen and spell | Listen, type the complete answer and replay as needed. |
| Chinese to English | Write the English answer from Chinese senses, including common multiple meanings. |
| IPA to English | Spell the full form from British IPA, including articles, plurals and tense endings. |
| Flashcards | Review entries one by one, with English, IPA, Chinese senses, pronunciation notes and synonyms. |

Choose a category, all entries, mistakes, bookmarks or unseen entries, with optional shuffle. Meanings appear in feedback and cards. Synonyms are fully expanded, linked to a meaning and usage context. They are study suggestions, not automatically accepted answers.

All four modes support speech playback and are available in normal and fullscreen layouts. Chinese and IPA hint buttons affect the current question; default hint checkboxes apply to later questions. Combine listening with Chinese and IPA, or Chinese with IPA and playback. Navigation restores defaults and the primary mode's content is not repeated.

Numeric entries display the original number and accept listed English readings: both `12` and `twelve`, for example. IPA transcribes the English reading. Times, dates and codes retain their original forms and valid aliases.

## Mistakes and correction

- A wrong answer enters the mistake book and clears the input. Failed corrections also clear the input and retain the spelling comparison. Correct spelling is required before continuing; unfinished correction survives reload with an empty input.
- Successful correction automatically reads the current entry **once**, regardless of the repetition count or next-entry automatic reading setting.
- Spelling feedback shows extra letters in red with a strikethrough and missing or corrected letters in green with an underline. Digits and English readings are compared with the closest accepted answer.
- Independent answers count toward accuracy. Correction attempts do not increase accuracy or the correct-answer streak.
- An entry leaves the mistake book after **3** later independent correct answers in a row by default. Another independent mistake resets the streak.
- The threshold supports 1, 2, 3, 4, 5 or 10. Manual addition, removal and clearing are available.
- Clearing mistakes keeps bookmarks and history. Threshold changes apply from the next independent answer.

Articles, plurals and tense must match. Case, outer/repeated spaces and hyphens between English words do not affect grading. Minus signs, decimal points and leading zeroes in codes remain significant. Feedback lists accepted forms.

## Keyboard and fullscreen

| Key | Action |
| --- | --- |
| `Alt+R` | Replay, including while typing |
| `R` | Replay outside inputs |
| `Space` | Play, pause or resume outside inputs |
| `Enter` | Play a blank question; submit a filled answer; advance after success/correction; read a flashcard |
| `Esc` | Close a menu/dialog or exit fullscreen |

Modes, category, range, bookmark, mistake actions, previous, hints and settings share a foldable control area. It starts expanded in normal practice and collapsed in fullscreen; each layout remembers its choice. Folding keeps hints and keyboard shortcuts active. Submit and the next button after success show `↵`; a short hint explains the current Enter action. Entering, flipping or advancing a flashcard focuses playback. Enter activates another button when deliberately focused. IME composition does not submit, and a held Enter does not repeatedly advance.

Fullscreen shows the exercise, playback, answers and navigation, with expand and exit controls in the corners. Expand the controls to change mode, category or hints. Browsers without native fullscreen use an immersive layout. Long details and short screens can scroll; exiting preserves answers and correction state.

## Speech

Speech uses browser `SpeechSynthesis`, with **no prerecorded audio**. Settings expose voice, rate, pitch and volume. Advancing to the next entry automatically reads it by default in every mode; you can turn this off. Existing saves receive this default, while later manual opt-outs are preserved. Prefer `en-GB` for a British voice when available.

Rate covers **0.1–10×**, **1× by default**, using a slider or number input; actual speed depends on the voice. Playback can repeat **1–10 times**, **twice by default**, for play, replay and automatic reading in every mode, with roughly half a second between repeats. Existing saves using the former defaults receive the new defaults; later manual changes are preserved. Replay starts over. Navigation, mode/view changes, settings/help and backgrounding cancel remaining repeats; Space pauses or resumes.

Volume is **0–100%**. Native browser speech cannot amplify beyond 100%; use the system or speaker volume for louder output. Google and other voices, offline support and successful synthesis depend on browser and system. Try another voice/browser if playback fails; confirm audible output on your own device.

## Statistics and backup

Statistics include independent attempts, accuracy, distinct practiced entries, daily streaks, current mistakes and active practice time. Filter by mode, category or date. The daily table includes correct/wrong answers, corrections, card reviews and time; accuracy charts cover 7 days, 30 days or all dates, leaving days without answers empty.

Study records stay in the browser's `localStorage`, with JSON export/import. Import validates data and asks before replacement. Background tabs, dialogs and long idle periods do not count as active time. Corrections and card reviews do not count toward independent accuracy.

Each vocabulary has a separate `datasetId` for study records and backups. Backups can only be imported into the matching vocabulary. Assign a new ID to a different list; keep the ID and stable entry IDs when revising the same vocabulary's meanings. The bundled list preserves existing records.

## Use your own vocabulary

`app/data/vocab.json` is the structured data and `app/data/vocab.js` is its identical browser copy for direct HTML opening. Replacing a vocabulary requires generating both files together.

**Manual annotation:** copy [tools/examples/vocab.json](tools/examples/vocab.json) and fill in complete entries. Export and check in a local directory first; add `--replace` to replace the app's vocabulary after review. Preserve the original vocabulary and export your learning backup first.

```sh
python tools/build_vocab.py --input tools/examples/vocab.json --output-dir private/my-vocab
python tools/verify_full.py --data private/my-vocab/vocab.json --js private/my-vocab/vocab.js
python tools/build_vocab.py --input tools/examples/vocab.json --output-dir app/data --replace
```

Replace the sample input with your annotated JSON. Words, phrases and names need Chinese senses; literal numbers can use an English reading and IPA. `acceptedAnswers` specifies valid answers, while `synonyms` holds separate study suggestions.

**Optional API annotation:** prepare your raw list using [tools/examples/source.json](tools/examples/source.json), then run `tools/full_pipeline.py` to generate IPA, Chinese senses and synonyms. Endpoint, model and key are provided locally at runtime; no provider configuration is bundled, and practice makes no annotation API calls. See the [English tools guide](tools/README.md) / [中文工具说明](tools/README.zh-CN.md) for configuration, thinking parameters and review. Check automated meanings, pronunciation and answer rules before use.

The bundled list preserves entries, order, duplicates and stable IDs; its 19 uncategorized entries have been classified. Notes identify estimated proper-name pronunciations and sense-dependent readings.

## Development and publication checks

The static HTML/CSS/JavaScript frontend needs no build. Python tools use the standard library and require Python 3.10+. Only browser audits need Node.js, Playwright and the selected browsers:

```sh
npm --prefix tools ci
npm --prefix tools run test:flows
npm --prefix tools run test:custom
python tools/verify_full.py
python tools/check_public.py
```

Run these commands from the repository root. Audit dependencies and their package files stay in `tools/`. Audits run in isolated headless browsers and write results to the system temporary directory by default. Full-flow audits target the bundled IELTS list; the custom audit uses sample data to verify reuse, grading and record separation.

`.gitignore` allows the app, formal vocabulary, examples, documentation and tools. Original notes, annotation intermediates, logs, reports, backups and actual API configuration are excluded. The publication scanner checks candidates, staged content and Git history, reporting only file names and issue categories. Rerun it after changes and inspect the actual staged files.
