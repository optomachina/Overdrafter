# Drawing Extraction

Last updated: March 16, 2026

## Purpose

This document defines the current drawing-metadata extraction rules for OverDrafter.

## Field priority

Extraction should prefer label-anchored title-block parsing over flat-text scanning.

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

## Confidence and review

- Every extracted field carries confidence and `reviewNeeded`.
- Low-confidence or conflicting candidates must fail closed into review instead of silently becoming approved requirement data.
- Debug mode should log top candidates, rejection reasons, selected value, and source region.

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
