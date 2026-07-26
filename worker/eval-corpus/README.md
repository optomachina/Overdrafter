# Extraction eval corpus

Ground-truth drawings used by the pre-merge extraction gate
(`npm --prefix worker run eval:gate`).

**The corpus currently holds one case.** That is enough to run the gate but not
enough to measure anything: one drawing means each field is scored 0% or 100%,
and a single case cannot represent the range of title blocks the pipeline sees.
It needs the rest of the real quote drawings.

It is also **partly circular**. `worker/src/extraction/pdfDrawing.ts` contains
rescues keyed to that drawing's literal expected values:

```ts
const materialMatch = /\b6061\s+Alloy\b/i.exec(input.text);
/ROUND,\s*CARBON FIBER END ATTACHMENTS/i.test(input.text)
/ANODIZE,\s*BLACK,\s*MIL-A-8625F,\s*TYPE\s*II/i.test(input.text)
```

A drawing whose answers are compiled into the parser pins known-good behaviour
but cannot demonstrate generalization. Treat any case that a rescue can satisfy
as a regression pin, and weight new drawings accordingly. Removing the rescues
is worth doing once enough real drawings exist that the parser can be judged
without them.

## Why this exists

Prompt, model, and threshold changes used to ship with no measured signal.
`extraction_quality_summary` observes production after the fact, which tells
you a regression hurt only once customers absorbed it. This corpus is the
before-merge half of that story.

## Layout

```
worker/eval-corpus/
  cases/
    bracket-mil-spec.json      # ground truth
    ...
  drawings/
    bracket-mil-spec.pdf       # the drawing itself
```

A case file:

```json
{
  "id": "bracket-mil-spec",
  "pdfPath": "drawings/bracket-mil-spec.pdf",
  "note": "MIL-spec callout in the notes block that the parser used to read as a part number",
  "fields": {
    "partNumber": "1234-56789",
    "revision": "C",
    "description": "MOUNTING BRACKET",
    "material": "6061-T6 ALUMINUM",
    "finish": "ANODIZE TYPE II"
  }
}
```

Omit a field the drawing genuinely does not carry — the gate scores each field
only over the cases that declare it, so drawings without a finish callout do
not drag the finish floor down.

## What to put in it

Aim for 30–50 drawings that span the failure modes the parser already names,
rather than 50 easy title blocks. Worth covering:

- spec strings (`MIL-`, `ASTM-`, `AMS-`) positioned where a part number is expected
- signature and approval blocks near the finish field
- single-letter revisions with no adjacent `REV` label
- title blocks split across a multi-page drawing
- scanned or rotated sheets where the crop heuristic is under pressure
- drawings with two plausible part-number candidates (the competing-candidate path)
- drawings that legitimately lack material or finish, to confirm the pipeline
  fails closed to review instead of inventing a value

Add the drawing that caused a bug at the same time as the fix. That is how the
corpus stays representative instead of becoming a set of cases that already pass.

The first case earned its keep immediately: running the real `1093-05589-02.pdf`
through the gate surfaced two parser defects that the repo's idealized synthetic
fixture did not — a FINISH value that absorbed the neighbouring
`THIRD ANGLE PROJECTION` cell, and a MATERIAL value truncated from `6061 Alloy`
to `6061` because the value row was clipped to the label row's width. Both are
fixed, with regression tests in `pdfDrawing.test.ts`. Synthetic fixtures written
from memory of a drawing will not find this class of bug; the actual file will.

## Floors

Per-field accuracy floors live in `DEFAULT_FIELD_FLOORS` in
`worker/src/tools/extractEvalGate.ts`. Raise them as the corpus grows and the
pipeline improves; lowering one should be a deliberate, reviewed change with a
note about what regressed.

## Running it

```bash
# uses worker/eval-corpus by default
npm --prefix worker run eval:gate

# explicit corpus, uniform floor, machine-readable output
npm --prefix worker run eval:gate -- --corpus /path/to/corpus --floor 0.9 --json
```

Requires whichever provider key the configured `DRAWING_EXTRACTION_MODEL`
routes to. Exit codes: `0` all floors met, `1` a field is below its floor,
`2` the corpus is missing or unusable.
