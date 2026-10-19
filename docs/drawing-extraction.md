# Drawing Extraction

Last updated: October 19, 2026

## Purpose

This document defines the current drawing-metadata extraction rules for OverDrafter.

## Field priority

Extraction should prefer label-anchored title-block parsing over flat-text scanning.
The worker now uses a hybrid path:

1. deterministic title-block parsing first
2. bounded `gpt-5.4` fallback when critical fields are missing, low-confidence, or conflicting
3. validator and disagreement merge before persistence

Priority order per field:

1. explicit title-block labels such as `PART NUMBER`, `DWG. NO.`, `REV`, `DESCRIPTION`, `TITLE`, `MATERIAL`, `FINISH`, and `PROCESS`
2. values aligned to the same title-block row or the cell directly below the label
3. multiline continuation inside the same title-block region
4. field-specific fallback candidates inside the title block

## Field-specific guards

- Part number prefers company-style drawing numbers and rejects spec strings such as `MIL-A-8625F`, `ASTM`, `AMS`, `QQ-`, and approval or date metadata.
- Revision prefers values directly tied to `REV` or `REVISION` and rejects stray unlabeled letters from notes or revision-history blocks.
- Description prefers `TITLE` or `DESCRIPTION` regions, merges wrapped lines in reading order, and rejects numeric-only document identifiers when a labeled title exists.
- Finish prefers `FINISH` or `PROCESS` labels first, then finish-like note content only when it fits finish-specific keywords. Approval names, dates, and signature blocks must be rejected.
- A title-block label is never a value. `Q.A.`, `CHECKED`, `DRAWN`, `APPROVED`, `ENG`, `MFG` and the other labels in `titleBlockCells.ts` are rejected as a part number, revision, material or finish, whether they come from the title block, the filename stem, or a model.

## Title block cells (OVD-985, OVD-989)

The part number, revision, material and finish are the values of the cells their labels own (`worker/src/extraction/titleBlockCells.ts`). `pdftotext -layout` prints a title block row by row, so a cell's value is often several lines below its label with other cells' text in between; reading "the next line" lands on the approvals label `Q.A.`, the `TITLE` text, or the `SURFACE FINISH` note.

- Each line is split into labels from a fixed vocabulary and value runs. A label counts only where one can start (line start, after a wide gap, after another label, after a token with a digit), so `PLATING` inside "DIMENSIONS APPLY AFTER PLATING" is not a label, and `ENG-1234` or `REV-B` are values.
- A value is owned by the label above it (or left of it on its own line) whose left edge is nearest on the left of the value's centre. A label stops owning text below the first label under it in its own columns (`FINISH` under `MATERIAL`). The first value after a label on its own line, and the words that follow it, belong to that label.
- Fail closed: a label with no value, with a second value line for a single-valued field, with a value that is itself a label, with a single character (a sheet-border zone marker), or with a part number containing a space (two cells squeezed together) yields no value. The field is flagged for review and left empty; no fallback reads neighbouring text. A part number shaped like `1093-05589` found elsewhere in the title block is still offered as a flagged suggestion.
- Geometry: when `pdftotext -bbox` word boxes are available (`words` on each page), the reader uses the words' true positions. `-layout` columns are squeezed where a word is set larger than its neighbours (a 24 pt drawing number beside 9 pt labels prints as `B  ABC-001 A`, with the revision no longer under `REV`). Without boxes the reader uses layout columns, and the squeezed value is flagged rather than read.

## General tolerance table rows (OVD-989)

A block such as `TWO PLACE DECIMAL .01 / THREE PLACE DECIMAL .005 / FOUR PLACE DECIMAL .0010` (also `.XX ±.01`, and metric `X.XX 0.10` where the plus-minus glyph is not in the text layer) is a default for dimensions printed with that many decimal places. Reading its tightest row as the drawing's tightest tolerance denied every drawing from a template that prints a four-place row although no dimension uses four places.

- Dimension text is read from lines that hold only dimension callouts (numbers, `2X`, `R`, `Ø`, `THRU`, hole tags). The sheet is readable when at least three such decimal numbers are found, no line was too long to scan, and the text layer is not OCR.
- On a readable sheet a row applies only if some decimal number outside the tolerance and title block has that many places; other rows are dropped. An explicit tolerance on a feature is always kept.
- On a sheet that is not readable, a row of four or more places is not assumed in force: it becomes an unresolved value (the OVD-976 policy), so the stored `valueInch` is null unless a tighter explicit tolerance exists and the OVD-683 beta gate asks the user. Rows of one to three places are read as before.
- Units are untouched: bare row values follow the drawing's declared units (OVD-976).

## Page text and OCR

`extractPdfText` reads the text layer of every page with `pdftotext` and also renders and OCRs every page with `tesseract`, even when a text layer exists. A drawing can have a selectable title block next to an embedded raster image, such as a marking stamp, that has no text layer. Reading only the text layer, or only page 1, would treat that drawing as fully read.

- Each page carries `text` (text layer, or the OCR text when the whole document has no text layer, as before), `ocrText` (OCR output only, never mixed with the text layer), and `ocrStatus`.
- `ocrStatus` is one of:
  - `ok`: the page was rendered and tesseract ran on it. The text may be empty.
  - `failed`: the page size could not be read, the page is over the pixel cap, or the render or tesseract errored or timed out.
  - `unavailable`: the tesseract binary is missing, or its `--version` probe failed or timed out.
  - `not_read`: the page is past `PDF_OCR_MAX_PAGES`, or the total OCR budget ran out before the next call for that page could start. No tool ran to completion on that page, so nothing about its content is known.
- Only `ok` means the raster content of the page was read.
- `words` (OVD-989) holds the text layer's word boxes in points, from `pdftotext -bbox`, for each page that has a text layer. It is geometry for the title block reader and nothing else: it is absent when poppler cannot print the boxes or the page has more than `MAX_WORDS_PER_PAGE` words, and its absence never changes `text`, `drawingFullyRead` or the export scan.
- `ocrLimit` is set only when a fixed limit kept the page from being read, so no rerun of the same bytes can read it: `page_cap` (`not_read`, past `PDF_OCR_MAX_PAGES`) or `pixel_cap` (`failed`, over `PDF_OCR_MAX_PIXELS`). A timeout, a spent budget, or a tool error sets no limit. The export gate records such a drawing as final (`drawing_too_many_pages`, `drawing_sheet_too_large`).
- `pageCountKnown` is false when `pdfinfo` failed or printed no page count. `pageCount` is then a floor of 1, and later pages may exist unread.
- `drawingFullyRead` is the single fail closed answer for part B and any export gate. It is true only when `pageCountKnown` is true, the text layer of every page was read without error, and every page has `ocrStatus` `ok`. Anything else must hold the drawing. `ocr` keeps its older meaning: no text layer anywhere and OCR produced text.
- Each page is rendered at no less than `PDF_OCR_MIN_DPI` (200) so small print stays legible. The render covers the page CropBox (`pdftoppm -cropbox`), which is the size `pdfinfo` reports, and a page whose CropBox would exceed `PDF_OCR_MAX_PIXELS` (70 MP) at that resolution is `failed` instead of rendered. An E size sheet at 200 DPI is about 60 MP. Rendering the CropBox keeps the checked size and the rendered size the same, so a small CropBox on a huge MediaBox cannot slip past the cap.
- tesseract runs with `OMP_THREAD_LIMIT=1`. On a loaded host more threads were many times slower and could hit the page timeout.
- Time bounds:
  - each `pdfinfo` and `pdftotext` call, and the tesseract version probe: `PDF_TOOL_TIMEOUT_MS` (30 seconds);
  - each OCR render and each tesseract run: `PDF_OCR_PAGE_TIMEOUT_MS` (60 seconds);
  - the whole OCR pass: `PDF_OCR_TOTAL_TIMEOUT_MS` (120 seconds). The clock starts before the version probe. Immediately before each `pdfinfo`, `pdftoppm`, and tesseract call the time left is computed, the call gets at most that, and when none is left the call is skipped and the page reports `not_read`;
  - the text layer loop: `PDF_TEXT_LAYER_MAX_PAGES` (50 pages) and `PDF_TEXT_LAYER_TOTAL_TIMEOUT_MS` (60 seconds). Pages it does not reach have an empty `text`, and `drawingFullyRead` is false;
  - the word box pass: `PDF_WORD_BOXES_TOTAL_TIMEOUT_MS` (30 seconds), each call also bounded by `PDF_TOOL_TIMEOUT_MS`. Pages it does not reach keep their layout text and have no `words`;
  - the preview and title block crop renders: `PDF_OCR_PAGE_TIMEOUT_MS`.
- The title block crop also renders the CropBox, since its crop rectangle is computed from the size `pdfinfo` reports. The page size parser accepts size lines that end with a paper name, such as `612 x 792 pts (letter)`, so the crop now works for letter, legal, and A series pages.
- If the tesseract binary is missing, every page reports `unavailable` and the function does not throw. It logs the fixed code `pdf_ocr_tesseract_unavailable` once and never logs file names or contents.
- The worker image installs `tesseract-ocr` and the English data at pinned distro versions. Nothing is downloaded at runtime.

## Raw vs normalized data

- `drawing_extractions.extraction` is the source-truth record.
- Raw extracted fields include `extractedPartNumberRaw`, `extractedRevisionRaw`, `extractedDescriptionRaw`, and `extractedFinishRaw`.
- Quote-facing normalized fields live in `approved_part_requirements` plus `spec_snapshot`.
- `spec_snapshot.quoteDescription` and `spec_snapshot.quoteFinish` can compress or rephrase drawing text for quote workflows, but they must remain traceable to the raw extraction.
- Reparse must not overwrite normalized fields when provenance marks them as user-managed.
- Legacy `approved_part_requirements` rows with missing `spec_snapshot.fieldSources.*` must be treated as auto-managed, not user-managed.
- Auto-managed approved values should only be refreshed from extraction when the extraction is newer than the approved row and the extracted raw field is not review-blocked.

## Confidence and review

- Every extracted field carries confidence and `reviewNeeded`.
- Low-confidence or conflicting candidates must fail closed into review instead of silently becoming approved requirement data.
- Debug mode should log top candidates, rejection reasons, selected value, and source region.
- Model fallback must persist provenance such as `modelFallbackUsed`, `modelName`, `modelPromptVersion`, `fieldSelections`, and model candidate metadata without replacing parser `debugCandidates`.

## Model fallback rules

- The model receives the title-block crop first and the full first-page render only when the crop result is insufficient.
- The model returns raw drawing truth only, never quote-normalized strings.
- Parser-selected fields remain authoritative when they are strong, label-backed, and conflict-free.
- Model-selected fields may rescue missing or weak parser values, but they still pass field-specific validation.
- If parser and model disagree on a critical field and neither clearly wins, the field stays review-needed and the extraction lifecycle remains partial.
- The worker should still try to produce a first-page preview for model fallback when Poppler text extraction is unavailable. On macOS debug hosts, Quick Look rendering is an acceptable fallback for this preview image.

## Extraction Lab

- Internal debugging now supports preview-only reruns through the `Extraction Lab` on the internal job detail page.
- Debug reruns enqueue `debug_extract_part` tasks and persist their result in `debug_extraction_runs`.
- Preview-only runs must not overwrite canonical `drawing_extractions` rows or `approved_part_requirements`.
- The lab should show canonical extraction and the latest preview-only debug run side by side, including:
  - worker build version
  - extractor version
  - requested model and effective model
  - raw extracted fields
  - normalized quote-facing fields
  - review fields, warnings, and candidate/debug metadata
- The browser must request preview runs through Supabase RPC rather than calling the worker directly.
- `OPENAI_API_KEY` or `OPENROUTER_API_KEY` belongs only in the worker environment or secret manager.
- When OpenRouter is the active provider, an unqualified model such as `gpt-5.4` is sent as the provider-qualified `openai/gpt-5.4`; already-qualified model identifiers are preserved.
- `DRAWING_EXTRACTION_DEBUG_ALLOWED_MODELS` defines the allowlisted per-run model selector shown in the lab.
- `WORKER_BUILD_VERSION` should be injected from deploy metadata or git SHA so preview runs and canonical rows reveal the exact worker build that produced them.

## Internal review precedence

- Internal quote review should not blindly display `approved_part_requirements` when those values were auto-derived.
- If an approved field is auto-managed, the extraction is newer, and the extracted field is not review-blocked, the review UI should display the fresher extraction-backed value and surface the stale approved value as provenance.
- Explicit user-owned approved values remain authoritative until a user chooses to rebuild them from extraction.
- If there is no approved value yet and the extraction is review-blocked, the editable field should stay blank while the raw extracted candidate remains visible as review evidence.

## Smoke verification

- For real-file diagnostics outside fixture coverage, use `npm --prefix worker run extract:smoke -- /absolute/path/to/drawing.pdf`.
- The smoke command should print the raw extraction payload, preview path, and run directory so parser-vs-model behavior can be inspected against a production PDF without mutating application data.
- For app-level debugging of a stored part, prefer the internal `Extraction Lab` first because it keeps the run attached to the part/job record, records build/model metadata, and avoids reuploading or archiving files.

## Regression coverage

Regression coverage must include the `1093-05589` title-block layout:

- raw part number: `1093-05589`
- raw revision: `02`
- raw description: `ROUND, CARBON FIBER END ATTACHMENTS BONDED`
- raw finish: `ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2`

The same coverage should assert that:

- `MIL-A-8625F` does not win as part number
- approval metadata does not win as finish
- numeric-only stray text does not beat a labeled description
- quote normalization remains separate from raw extraction

The deterministic path is also run, under a neutral file name, on the committed sample drawing through poppler (`sampleDrawing.test.ts`) and on synthetic B-size title blocks (`titleBlockLayout.test.ts`, `titleBlockCells.test.ts`, `titleBlockWords.test.ts`, `generalToleranceRows.test.ts`). They assert that the part number and revision come from the `DWG. NO.` and `REV` cells, that `Q.A.` and the other approvals labels are never values, that the material and finish never come from the `TITLE` cell or the `SURFACE FINISH` note, and that a four-place tolerance row no dimension uses does not set the tightest tolerance. Real SolidWorks drawings are not committed; the repository is public.

## extract:eval CLI tool

`extract:eval` is a command-line evaluation harness for benchmarking and comparing drawing-extraction accuracy across multiple AI models and providers (OpenAI, Anthropic, and OpenRouter).

Basic usage:

```bash
npm --prefix worker run extract:eval -- /path/to/drawing.pdf
```

The tool runs the extraction prompt against the configured model(s), prints a structured comparison of field values, confidence scores, token usage, and estimated cost per model, and exits without writing to the database. It is intended for offline accuracy measurement against known-good drawings rather than live job processing.
