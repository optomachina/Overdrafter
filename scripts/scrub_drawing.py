#!/usr/bin/env python3
"""Scrub identifying information from engineering drawings.

Customer drawings carry company names, engineer names, project codes, and
proprietary notices. None of that belongs in a repository, and a drawing that
reaches a public asset directory becomes publicly downloadable. This rewrites
the text in place so the sheet stays realistic enough to be an extraction
fixture while carrying no real identity.

Two properties matter and both are enforced:

1.  The text layer survives. The extraction pipeline shells out to pdftotext
    and reads title-block values by column position, so rasterising or flattening
    the page would destroy exactly what the fixture exists to test.
2.  Scrubbing is verified, not assumed. After rewriting, the text is
    re-extracted and checked against a forbidden list. A replacement that
    silently failed to apply is worse than no scrubbing, because it looks done.

Usage:
    pip install pymupdf
    python3 scripts/scrub_drawing.py --rules scripts/scrub-rules.json IN.pdf -o OUT.pdf
    python3 scripts/scrub_drawing.py --rules scripts/scrub-rules.json IN_DIR/ -o OUT_DIR/
    python3 scripts/scrub_drawing.py --rules ... IN.pdf --dry-run

Exit codes: 0 clean, 1 a forbidden term survived, 2 bad input.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print("PyMuPDF is required: pip install pymupdf", file=sys.stderr)
    raise SystemExit(2)


@dataclass
class Rule:
    pattern: re.Pattern[str]
    replacement: str
    label: str

    def apply(self, text: str) -> str | None:
        """Returns the rewritten text, or None when this rule does not match."""
        new = self.pattern.sub(self.replacement, text)
        return new if new != text else None


def load_rules(path: Path) -> tuple[list[Rule], dict[str, str], list[str]]:
    config = json.loads(path.read_text())
    rules: list[Rule] = []

    for entry in config.get("replacements", []):
        match, replace = entry.get("match"), entry.get("replace")
        if match is None or replace is None:
            raise ValueError(f"replacement entries need 'match' and 'replace': {entry!r}")

        if entry.get("mode", "literal") == "literal":
            pattern = re.compile(re.escape(match))
        else:
            pattern = re.compile(match)

        rules.append(Rule(pattern, replace, entry.get("label", match)))

    return rules, config.get("metadata", {}), config.get("forbidden", [])


def text_angle(direction: tuple[float, float]) -> int:
    """Maps a line's writing direction to an insert_textbox rotation.

    Engineering sheets are routinely saved with /Rotate 90, which leaves the
    text stored running bottom-to-top in unrotated page space. Treating those
    spans as horizontal makes a bounding box grow sideways across neighbouring
    title-block columns, so redaction erases cells it was never aimed at.
    """
    dx, dy = direction
    if abs(dx) >= abs(dy):
        return 0 if dx >= 0 else 180
    return 90 if dy < 0 else 270


def scrub_page(page: "fitz.Page", rules: list[Rule], dry_run: bool) -> list[tuple[str, str]]:
    """Rewrites matching spans on one page. Returns (before, after) pairs."""
    changes: list[tuple[str, str]] = []
    pending: list[tuple[fitz.Point, str, float, int]] = []

    # Work in unrotated page space so span boxes, redaction boxes, and inserted
    # text all share one coordinate system.
    original_rotation = page.rotation
    if original_rotation:
        page.set_rotation(0)

    try:
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                angle = text_angle(line["dir"])

                for span in line["spans"]:
                    original = span["text"]
                    if not original.strip():
                        continue

                    rewritten = original
                    for rule in rules:
                        result = rule.apply(rewritten)
                        if result is not None:
                            rewritten = result

                    if rewritten == original:
                        continue

                    changes.append((original, rewritten))
                    if dry_run:
                        continue

                    rect = fitz.Rect(span["bbox"])
                    # Pad only across the writing direction. Never pad along the
                    # text axis: that is what runs into the adjacent cell.
                    if angle in (90, 270):
                        rect.x0 -= 0.5
                        rect.x1 += 0.5
                    else:
                        rect.y0 -= 0.5
                        rect.y1 += 0.5

                    page.add_redact_annot(rect)
                    # Replacement text is placed at the span's own baseline
                    # origin rather than flowed into a box. Title-block text
                    # runs as small as 3.7pt, and a box that tight cannot hold a
                    # line plus its leading, so insert_textbox silently drops
                    # it and leaves an empty cell where a value used to be.
                    pending.append((fitz.Point(span["origin"]), rewritten, span["size"], angle))

        if changes and not dry_run:
            # Leave line art and images untouched: the title-block ruling lines
            # and the part geometry sit under these boxes, and the default
            # behaviour would erase them along with the text.
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            )

            for point, text, size, angle in pending:
                # Replacements use a base-14 face: the source fonts are subset
                # embeddings that carry only the glyphs originally used and
                # cannot render new text.
                page.insert_text(
                    point,
                    text,
                    fontname="helv",
                    fontsize=size,
                    rotate=angle,
                )
    finally:
        if original_rotation:
            page.set_rotation(original_rotation)

    return changes


def verify(pdf_path: Path, forbidden: list[str]) -> list[str]:
    """Re-extracts text and reports any forbidden term that survived."""
    document = fitz.open(pdf_path)
    haystack = "\n".join(page.get_text() for page in document)
    haystack += "\n" + "\n".join(f"{k}:{v}" for k, v in (document.metadata or {}).items() if v)
    document.close()

    lowered = haystack.lower()
    return [term for term in forbidden if term.lower() in lowered]


def scrub_file(
    source: Path,
    target: Path,
    rules: list[Rule],
    metadata: dict[str, str],
    forbidden: list[str],
    dry_run: bool,
) -> int:
    document = fitz.open(source)
    all_changes: list[tuple[str, str]] = []

    for page in document:
        all_changes.extend(scrub_page(page, rules, dry_run))

    print(f"\n{source.name}")
    if not all_changes:
        print("  no matches — check the rules if you expected changes")
    for before, after in all_changes:
        print(f"  {before!r}\n    -> {after!r}")

    if dry_run:
        # Metadata is reported but not written, so a dry run stays read-only.
        current = document.metadata or {}
        for key, value in metadata.items():
            if current.get(key):
                print(f"  metadata {key}: {current.get(key)!r} -> {value!r}")
        document.close()
        return 0

    document.set_metadata({**(document.metadata or {}), **metadata})
    target.parent.mkdir(parents=True, exist_ok=True)
    # garbage=4 rewrites the object tree so removed strings do not linger in
    # unreferenced objects that a raw byte scan could still recover.
    document.save(target, garbage=4, deflate=True, clean=True)
    document.close()

    survivors = verify(target, forbidden)
    if survivors:
        print(f"  FAILED verification — still present: {survivors}", file=sys.stderr)
        return 1

    print(f"  wrote {target} (verified clean against {len(forbidden)} forbidden term(s))")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="PDF file or directory of PDFs")
    parser.add_argument("-o", "--output", type=Path, help="output file or directory")
    parser.add_argument("--rules", type=Path, required=True, help="JSON rules file")
    parser.add_argument("--dry-run", action="store_true", help="report changes without writing")
    args = parser.parse_args()

    if not args.source.exists():
        print(f"No such path: {args.source}", file=sys.stderr)
        return 2

    try:
        rules, metadata, forbidden = load_rules(args.rules)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Could not load rules: {error}", file=sys.stderr)
        return 2

    if not args.dry_run and not args.output:
        print("--output is required unless --dry-run is set", file=sys.stderr)
        return 2

    sources = sorted(args.source.glob("*.pdf")) if args.source.is_dir() else [args.source]
    if not sources:
        print(f"No PDFs found in {args.source}", file=sys.stderr)
        return 2

    status = 0
    for source in sources:
        if args.dry_run:
            target = source
        elif args.source.is_dir():
            target = args.output / source.name
        else:
            target = args.output

        status |= scrub_file(source, target, rules, metadata, forbidden, args.dry_run)

    return status


if __name__ == "__main__":
    raise SystemExit(main())
