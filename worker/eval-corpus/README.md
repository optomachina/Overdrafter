# Extraction eval corpus

Ground-truth drawings used by the pre-merge extraction gate
(`npm --prefix worker run eval:gate`).

**The checked-in corpus is intentionally empty.** The previous case depended on
a drawing that was removed from this public repository during the OVD-360
containment work. CI reports the quality gate as skipped until a rights-approved
synthetic or otherwise publishable case is added. Parser unit tests retain the
important title-block layout regressions without retaining the drawing bytes.

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

## Scrub before you commit

Customer drawings carry company names, engineer names, project codes, and
proprietary notices. Scrub every drawing before it enters the repo:

```bash
pip install pymupdf
python3 scripts/scrub_drawing.py --rules scripts/scrub-rules.json ~/path/to/QB000xx/ --dry-run
python3 scripts/scrub_drawing.py --rules scripts/scrub-rules.json ~/path/to/QB000xx/ -o worker/eval-corpus/drawings/
```

Every manufacturer identity becomes **ACME Mfg Co.** at the Tucson downtown
library address. Add a pattern per customer to `scripts/scrub-rules.json`, and
add the same strings to its `forbidden` list — the script re-extracts the text
after writing and exits non-zero if any forbidden term survived, so a
replacement that quietly failed to apply cannot pass as done.

Run `--dry-run` first and read the replacement list. The rules are regexes; a
too-greedy one silently eats real title-block values.

**Never put drawings in `public/`.** Vite copies that directory to the build
root, so anything there is downloadable from the deployed app. The drawing
that exposed this failure was removed during OVD-360 and was not relocated
elsewhere in this public repository. Only synthetic text/layout unit tests
remain until a rights-approved publishable eval case is added.

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

The removed case surfaced two parser defects: a FINISH value that absorbed a
neighbouring projection cell and a MATERIAL value clipped to the label row's
width. Both remain covered with text-layout regressions in
`pdfDrawing.test.ts`. Restore corpus coverage only with bytes that are approved
for this public repository.

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
