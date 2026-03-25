# Drawing Extraction

Last updated: March 17, 2026

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
- `OPENAI_API_KEY` belongs only in the worker environment or secret manager.
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

## extract:eval CLI tool

`extract:eval` is a command-line evaluation harness for benchmarking and comparing drawing-extraction accuracy across multiple AI models and providers (OpenAI, Anthropic, and OpenRouter).

Basic usage:

```bash
npm --prefix worker run extract:eval -- /path/to/drawing.pdf
```

The tool runs the extraction prompt against the configured model(s), prints a structured comparison of field values, confidence scores, token usage, and estimated cost per model, and exits without writing to the database. It is intended for offline accuracy measurement against known-good drawings rather than live job processing.
