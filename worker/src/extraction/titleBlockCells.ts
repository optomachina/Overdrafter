/**
 * OVD-985 and OVD-989: read the title block by the cell each label owns.
 *
 * pdftotext -layout prints a title block row by row, so the value of a cell is usually several lines
 * below its label, with the other cells' text in between. Reading "the next line, or else the whole next
 * line" therefore lands on a neighbouring cell: the approvals label Q.A. as the part number, the TITLE text
 * as the material, the SURFACE FINISH note as the finish.
 *
 * Positions are columns, and "line" orders the lines of one page from top to bottom, so blank lines
 * count as vertical distance. Two sources feed the same rules:
 *  - `pdftotext -layout` text: a column is a character position;
 *  - word boxes (`pdftotext -bbox`, built into lines by pdfWords.ts): a column is 0.4 text heights, each
 *    word is a run, and the position is the word's true one. This is the source when the page has it,
 *    because layout columns are squeezed where a word is wider than its characters (a 24 pt drawing number
 *    beside 9 pt labels), and a column in text heights does not depend on the size of the sheet.
 *
 * Ownership rule:
 *
 *  1. A line is split into labels from a fixed vocabulary and value runs. A label counts only where a
 *     label can start: at the line start, after two or more spaces, directly after another label, or
 *     after a token that contains a digit on a line that already has a label ("DWG. NO. 1000-1 REV A").
 *     "DIMENSIONS APPLY AFTER PLATING" is prose, so PLATING there is not a label. In layout text, what is
 *     left after the labels are blanked splits into runs wherever two or more spaces separate it.
 *  2. The first run printed after a label on the same line (within INLINE_GAP columns) is that label's value,
 *     and the words that follow it in a phrase ("SHEET 1 OF 1") belong to the same label.
 *  3. A run on a later line belongs to the label whose cell it is in: its centre is no more than SLACK
 *     columns left of the label's left edge and it starts no more than REACH columns right of the label's
 *     right edge, and no label has been placed under that label in its own columns before the run (the next
 *     cell of the same stack: FINISH under MATERIAL, SCALE under DWG. NO.). Of the labels that fit, the
 *     nearest on the left wins. A run that fits no label belongs to none and is not read.
 *  4. Words after the first word of a value continue it along the line (no label between, no wide gap);
 *     the line under a value continues it when it overlaps its columns and is still in the label's columns.
 *  5. Within one line the runs a label owns must be contiguous (gap of at most GAP_JOIN columns); a
 *     farther run belongs to another cell. A second line joins a value only when it sits under the
 *     first and holds more than a single character.
 *
 * Fail closed: a label with no run, with more than one value line for a single-valued field, with text on
 * its own line AND text left aligned under it, with a value that is itself a label ("Q.A.", "CHECKED"), that
 * names another field's label ("ALUMINUM FINISH ANODIZE"), with a single character (a zone marker), or a
 * part number containing a space (two cells squeezed together) yields no value. Nothing falls back to
 * neighbouring text, so the caller flags the field for review and leaves it empty rather than guessing.
 *
 * Every loop is bounded by the caps below, and the work per line is linear in its length.
 *
 * A test that has a `pdftotext -layout` text, or a page of word boxes, can call readTitleBlockCells
 * directly; the sheets in worker/test-support build both.
 */

export type CellField = "partNumber" | "revision" | "material" | "finish";

/** One word of a line built from word boxes: its characters in `raw`, and where it sits, in layout columns. */
export type TitleBlockWord = {
  from: number;
  to: number;
  x0: number;
  x1: number;
};

export type TitleBlockTextLine = {
  page: number;
  /**
   * Layout line number on the page (1-based, blank lines included). For a line built from word boxes,
   * the position of the line among the page's lines from top to bottom.
   */
  lineNumber: number;
  raw: string;
  /**
   * Present on lines built from word boxes (pdfWords.ts). The columns of a `pdftotext -layout` line are
   * squeezed when a word is wider than its characters (a 24 pt drawing number next to 9 pt labels), so
   * the words' own extents are used instead: each word is a run, and its position is its true one.
   */
  words?: readonly TitleBlockWord[];
};

export type CellReadStatus = "value" | "empty" | "ambiguous" | "rejected";

export type CellRead = {
  field: CellField;
  status: CellReadStatus;
  /** The cell's value; null unless status is "value". */
  value: string | null;
  /** Why the cell gave no value: no_value, multiple_values, label_token, bad_shape. */
  reason: string | null;
  page: number;
  /** The label as printed, for example "DWG. NO.". */
  label: string;
  labelLine: number;
  labelStart: number;
  labelEnd: number;
  /** Layout lines the value was read from. */
  valueLines: number[];
};

type LabelSpec = {
  /** Case insensitive regular expression source for the label, without a trailing colon. */
  source: string;
  /** The cell field this label heads, or null for a label that only fences the others off. */
  field: CellField | null;
};

// Longer and more specific labels first; a label is matched at the earliest position and, at that
// position, the first alternative that fits wins (SURFACE FINISH must not read as FINISH).
const LABEL_SPECS: readonly LabelSpec[] = [
  { source: String.raw`SURFACE\s+FINISH`, field: null },
  { source: String.raw`DWG\.?\s*(?:NO\.?|NUMBER|#)`, field: "partNumber" },
  { source: String.raw`DRAWING\s*(?:NUMBER|NO\.?|#)`, field: "partNumber" },
  { source: String.raw`PART\s*(?:NUMBER|NO\.?|#)`, field: "partNumber" },
  { source: String.raw`P\/N`, field: "partNumber" },
  { source: String.raw`PN`, field: "partNumber" },
  { source: String.raw`REVISIONS`, field: null },
  { source: String.raw`REVISION`, field: "revision" },
  { source: String.raw`REV\.?`, field: "revision" },
  { source: String.raw`MATERIAL`, field: "material" },
  { source: String.raw`MATL\.?`, field: "material" },
  { source: String.raw`FINISH(?:\s*\/\s*COATING)?`, field: "finish" },
  { source: String.raw`COATING`, field: "finish" },
  { source: String.raw`PLATING`, field: "finish" },
  { source: String.raw`INTERPRET\s+(?:GEOMETRIC|IN\s+ACCORDANCE\s+WITH)`, field: null },
  { source: String.raw`TOLERANCING\s+PER`, field: null },
  { source: String.raw`UNLESS\s+OTHERWISE\s+SPECIFIED`, field: null },
  { source: String.raw`DO\s+NOT\s+SCALE\s+DRAWING`, field: null },
  { source: String.raw`(?:THIRD|FIRST)\s+ANGLE\s+PROJECTION`, field: null },
  { source: String.raw`PROPRIETARY\s+AND\s+CONFIDENTIAL`, field: null },
  { source: String.raw`NEXT\s+ASS(?:Y|EMBLY|M)\.?`, field: null },
  { source: String.raw`USED\s+ON`, field: null },
  { source: String.raw`CAGE(?:\s+CODE)?`, field: null },
  { source: String.raw`TITLE`, field: null },
  { source: String.raw`DESCRIPTION`, field: null },
  { source: String.raw`SIZE`, field: null },
  { source: String.raw`SCALE`, field: null },
  { source: String.raw`SHEET`, field: null },
  { source: String.raw`WEIGHT`, field: null },
  { source: String.raw`MASS`, field: null },
  { source: String.raw`COMMENTS?`, field: null },
  { source: String.raw`NOTES?`, field: null },
  { source: String.raw`APPROVALS?`, field: null },
  { source: String.raw`APPROVED(?:\s+BY)?`, field: null },
  { source: String.raw`APPR\.?`, field: null },
  { source: String.raw`APPD\.?`, field: null },
  { source: String.raw`NAME`, field: null },
  { source: String.raw`DATE`, field: null },
  { source: String.raw`DRAWN(?:\s+BY)?`, field: null },
  { source: String.raw`DRN\.?`, field: null },
  { source: String.raw`CHECKED(?:\s+BY)?`, field: null },
  { source: String.raw`CHECKER`, field: null },
  { source: String.raw`CHKD?\.?`, field: null },
  { source: String.raw`ENGINEER(?:ING)?`, field: null },
  { source: String.raw`ENGR?\.?`, field: null },
  { source: String.raw`MFG\.?`, field: null },
  { source: String.raw`MANUFACTURING`, field: null },
  { source: String.raw`Q\.?\s?A\.?`, field: null },
  { source: String.raw`Q\.?\s?C\.?`, field: null },
  { source: String.raw`ISSUED`, field: null },
  { source: String.raw`RELEASED`, field: null },
  { source: String.raw`REVIEWED`, field: null },
  { source: String.raw`PROJECT`, field: null },
  { source: String.raw`SHT\.?`, field: null },
  { source: String.raw`PAGES?`, field: null },
  { source: String.raw`EC[ONR]`, field: null },
  { source: String.raw`ZONE`, field: null },
];

// A label is a whole word: a letter, digit or hyphen on either side means the text is something else
// ("ENG-1234" and "REV-B" are values, not the labels ENG and REV).
// One capture group per spec, so the index of the group that matched names the spec.
const LABEL_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9-])(?:${LABEL_SPECS.map((spec) => `(${spec.source}:?)`).join("|")})(?![A-Za-z0-9-])`,
  "gi",
);
// The same alternation, used to test whether a whole value is only labels.
const LABEL_ONLY_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9-])(?:${LABEL_SPECS.map((spec) => `(?:${spec.source}:?)`).join("|")})(?![A-Za-z0-9-])`,
  "gi",
);

/**
 * Columns a value's centre may sit left of its label's left edge (labels are not always flush). Word boxes
 * give true positions, and the corpus values centre at least 2 columns right of their labels' left edges,
 * so 2 keeps the neighbouring cell's value (a 24 pt SIZE value left of DWG. NO.) out of a label's band.
 * Layout text rounds each line's columns on its own, so it gets 3.
 */
const WORD_SLACK = 2;
const LAYOUT_SLACK = 3;
/**
 * How far past the label's right edge a value under it may start, in columns. A value belongs to the cell
 * whose label it sits under: left aligned with it, or centred in a cell that starts at the label. Text that
 * starts farther right belongs to another cell, and when that cell has no label of its own the text belongs
 * to no label at all and is not read. Revisions are short and left aligned under REV, so they get less.
 * Layout text is more generous: its columns are characters, and a poppler version with another character
 * cell stretches every gap between a label and its value.
 */
const WORD_REACH = 8;
const WORD_REVISION_REACH = 4;
const LAYOUT_REACH = 12;
const LAYOUT_REVISION_REACH = 5;
/** Largest vertical distance, in layout lines, from a label to a value it owns. */
const MAX_DY = 20;
/** Runs of one line that are closer than this are one value; farther runs are another cell. */
const GAP_JOIN = 12;
/** The first run within this many columns after a label on the same line is that label's own value. */
const INLINE_GAP = 12;
/** A run this close after an inline value continues it (the words of "SHEET 1 OF 1"). */
const PHRASE_GAP = 6;
/** Owned value lines further apart than this are not one value. */
const MAX_LINE_GAP = 3;
/** How many value lines each field may join (one for identifiers). */
const MAX_VALUE_LINES: Record<CellField, number> = { partNumber: 1, revision: 1, material: 2, finish: 3 };
// Bounds that keep the reader linear on hostile text: a longer line or a bigger block is not read.
const MAX_LINE_LENGTH = 2_000;
const MAX_LINES_PER_PAGE = 400;
const MAX_LABELS_PER_PAGE = 400;
const MAX_RUNS_PER_PAGE = 2_000;

type Label = {
  field: CellField | null;
  text: string;
  line: number;
  /** Columns: layout columns, or word extents in columns for a line built from word boxes. */
  start: number;
  end: number;
  /** Characters in the line's text. */
  charStart: number;
  charEnd: number;
  /** See WORD_SLACK and WORD_REACH: they depend on whether the line has word boxes. */
  slack: number;
  reach: number;
};

type Run = {
  text: string;
  line: number;
  start: number;
  end: number;
  center: number;
  /** Word boxes only: two or more spaces (a gap wider than the space inside a phrase) precede the word. */
  cellBreakBefore?: boolean;
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

// Look-alikes for the letters of the labels: Cyrillic and Greek capitals that print like Latin ones.
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u0401": "E", "\u041a": "K", "\u041c": "M", "\u041d": "H",
  "\u041e": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u0406": "I", "\u0408": "J",
  "\u0405": "S", "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x",
  "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z",
  "\u0397": "H", "\u0399": "I", "\u039a": "K", "\u039c": "M", "\u039d": "N", "\u039f": "O", "\u03a1": "P",
  "\u03a4": "T", "\u03a5": "Y", "\u03a7": "X", "\u03bf": "o", "\u03bd": "v",
};
// A value longer than this is never "only labels", and the fold below stays bounded.
const MAX_LABEL_TOKEN_LENGTH = 200;

/**
 * Folds what looks like a label but is spelled with other code points: full-width letters, zero-width and
 * other invisible characters, combining marks, Cyrillic and Greek look-alikes. Marks are dropped before the
 * compatibility decomposition because canonical reordering is quadratic on a long run of them.
 */
function foldForLabelTest(value: string): string {
  return value
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .replace(/[\p{Cf}\u00ad]+/gu, "")
    .replace(/[\u0370-\u03ff\u0400-\u04ff]/g, (letter) => LOOK_ALIKES[letter] ?? letter);
}

/** True when the whole text is made only of title-block labels ("Q.A.", "CHECKED", "ENG APPR."). */
export function isLabelLikeToken(value: string): boolean {
  if (value.length > MAX_LABEL_TOKEN_LENGTH) {
    return false;
  }
  const text = normalizeWhitespace(foldForLabelTest(value));
  if (!/[A-Za-z0-9]/.test(text)) {
    return false;
  }
  const rest = text.replace(LABEL_ONLY_PATTERN, " ").replace(/[^A-Za-z0-9]+/g, "");
  return rest.length === 0;
}

const SPACE = 32;
const TAB = 9;

/**
 * Whether a label may start at `start`: where a label can start, not inside a sentence. Scans back over the
 * blanks before it and, for the digit rule, over the one token before them, and stops at the first
 * non-blank: no end-anchored pattern on the line, so a long blank run or token stays linear.
 */
function labelMayStartAt(raw: string, start: number, previousLabelEnd: number): boolean {
  let tokenEnd = start;
  while (tokenEnd > 0 && (raw.charCodeAt(tokenEnd - 1) === SPACE || raw.charCodeAt(tokenEnd - 1) === TAB)) {
    tokenEnd -= 1;
  }
  if (tokenEnd === 0) {
    return true;
  }
  const gap = start - tokenEnd;
  if (gap >= 2 || (gap === 1 && raw.charCodeAt(tokenEnd) === TAB)) {
    return true;
  }
  if (previousLabelEnd === tokenEnd) {
    return true;
  }
  // "DWG. NO. 1000-1 REV A": after a token with a digit, but only on a line that already has a label, so a
  // note such as "PER ECO 1234 REV C" is a sentence and not the REV cell.
  if (previousLabelEnd < 0) {
    return false;
  }
  for (let position = tokenEnd - 1; position >= 0; position -= 1) {
    const code = raw.charCodeAt(position);
    if (code === SPACE || code === TAB) {
      return false;
    }
    if (code >= 48 && code <= 57) {
      return true;
    }
  }
  return false;
}

/** The column of a character position: the position itself in layout text, interpolated in a word otherwise. */
function columnAt(line: TitleBlockTextLine, index: number, edge: "start" | "end"): number {
  const words = line.words;
  if (words === undefined || words.length === 0) {
    return index;
  }
  for (let position = 0; position < words.length; position += 1) {
    const word = words[position]!;
    const inGap = edge === "start" ? index < word.from : index <= word.from;
    if (inGap) {
      return edge === "start" || position === 0 ? word.x0 : words[position - 1]!.x1;
    }
    if (index <= word.to && (edge === "end" || index < word.to)) {
      return word.x0 + ((index - word.from) / Math.max(1, word.to - word.from)) * (word.x1 - word.x0);
    }
  }
  return words[words.length - 1]!.x1;
}

/**
 * The labels of one line, appended to `into`. Stops as soon as `into` holds more than `limit` labels, so a
 * line full of labels is not scanned to its end once the page is known to be over its cap.
 */
function findLabels(line: TitleBlockTextLine, into: Label[], limit: number): void {
  const words = line.words !== undefined && line.words.length > 0;
  let previousLabelEnd = -1;
  for (const match of line.raw.matchAll(LABEL_PATTERN)) {
    if (into.length > limit) {
      return;
    }
    const start = match.index ?? 0;
    if (!labelMayStartAt(line.raw, start, previousLabelEnd)) {
      continue;
    }
    const specIndex = match.slice(1).findIndex((group) => group !== undefined);
    const spec = LABEL_SPECS[specIndex];
    if (!spec) {
      continue;
    }
    const end = start + match[0].length;
    into.push({
      field: spec.field,
      text: normalizeWhitespace(match[0]),
      line: line.lineNumber,
      start: columnAt(line, start, "start"),
      end: columnAt(line, end, "end"),
      charStart: start,
      charEnd: end,
      slack: words ? WORD_SLACK : LAYOUT_SLACK,
      reach: reachOf(spec.field, words),
    });
    previousLabelEnd = end;
  }
}

/** The runs of one line, appended to `into` (left to right); stops once `into` holds more than `limit`. */
function findRuns(line: TitleBlockTextLine, labels: readonly Label[], into: Run[], limit: number): void {
  if (line.words !== undefined && line.words.length > 0) {
    // Word boxes: every word outside a label is a run at its true extent. Ownership is decided word by
    // word, so a number that runs up against the next cell is still split from it. The labels of a line
    // are in order, so one pass over both finds the words they cover.
    let labelIndex = 0;
    for (const word of line.words) {
      if (into.length > limit) {
        return;
      }
      while (labelIndex < labels.length && labels[labelIndex]!.charEnd <= word.from) {
        labelIndex += 1;
      }
      const label = labels[labelIndex];
      if (label !== undefined && word.from < label.charEnd && word.to > label.charStart) {
        continue;
      }
      const text = line.raw.slice(word.from, word.to);
      if (!/[A-Za-z0-9]/.test(text)) {
        continue;
      }
      into.push({
        text,
        line: line.lineNumber,
        start: word.x0,
        end: word.x1,
        center: (word.x0 + word.x1) / 2,
        cellBreakBefore: word.from >= 2 && line.raw.charCodeAt(word.from - 1) === SPACE && line.raw.charCodeAt(word.from - 2) === SPACE,
      });
    }
    return;
  }

  let blanked = line.raw.replace(/[|│┃]/g, " ");
  for (const label of labels) {
    blanked = `${blanked.slice(0, label.charStart)}${" ".repeat(label.charEnd - label.charStart)}${blanked.slice(label.charEnd)}`;
  }
  for (const match of blanked.matchAll(/\S+(?: \S+)*/g)) {
    if (into.length > limit) {
      return;
    }
    if (!/[A-Za-z0-9]/.test(match[0])) {
      continue;
    }
    const start = match.index ?? 0;
    const end = start + match[0].length;
    into.push({ text: match[0], line: line.lineNumber, start, end, center: (start + end) / 2 });
  }
}

/** The layout line at which each label stops owning text: the first label under it in its columns. */
function computeCapLines(labels: Label[]): Map<Label, number> {
  const caps = new Map<Label, number>();
  for (const label of labels) {
    let cap = Number.POSITIVE_INFINITY;
    for (const other of labels) {
      if (
        other.line > label.line &&
        other.line < cap &&
        other.end > label.start - label.slack &&
        other.start < label.end + label.slack
      ) {
        cap = other.line;
      }
    }
    caps.set(label, cap);
  }
  return caps;
}

/**
 * A value printed on the same line right after a label is that label's value ("SHEET 1 OF 1", "WEIGHT:
 * 0.0831", "DWG. NO. 1000-1 REV A"), whatever stack of cells lies above it. The words after the first one
 * of such a phrase belong to the same label. `previousRun` is the run just before this one on the line
 * and `inlineOwners` holds the runs already placed that way.
 */
function inlineOwnerOf(
  run: Run,
  lineLabels: readonly Label[],
  previousRun: Run | null,
  inlineOwners: ReadonlyMap<Run, Label>,
): Label | null {
  let direct: Label | null = null;
  for (const label of lineLabels) {
    const gap = run.start - label.end;
    if (gap >= -1 && gap <= INLINE_GAP) {
      const runBetween = previousRun !== null && previousRun.start >= label.end - 1 && previousRun.end <= run.start;
      if (!runBetween && (direct === null || label.start > direct.start)) {
        direct = label;
      }
    }
  }
  if (direct !== null) {
    return direct;
  }
  if (previousRun !== null && previousRun.end <= run.start + 1 && run.start - previousRun.end <= PHRASE_GAP) {
    return inlineOwners.get(previousRun) ?? null;
  }
  return null;
}

function reachOf(field: CellField | null, words: boolean): number {
  if (field === "revision") {
    return words ? WORD_REVISION_REACH : LAYOUT_REVISION_REACH;
  }
  return words ? WORD_REACH : LAYOUT_REACH;
}

/**
 * The label whose cell a run on a later line lies in, or null when it lies in none. A run belongs to a
 * cell when it sits under the label's columns (its centre is no more than SLACK left of the label's left
 * edge) and starts no farther than REACH right of the label's right edge: left aligned under the label, or
 * centred in a cell that starts at it. The nearest such label on the left wins. A run that satisfies this
 * for no label is text of an unlabelled cell and is never assigned.
 */
function ownerOf(run: Run, labels: readonly Label[], caps: ReadonlyMap<Label, number>): Label | null {
  let best: Label | null = null;
  for (const label of labels) {
    const dy = run.line - label.line;
    if (dy < 1 || dy > MAX_DY) {
      continue;
    }
    if (run.center < label.start - label.slack || run.start > label.end + label.reach) {
      continue;
    }
    if (run.line > (caps.get(label) ?? Number.POSITIVE_INFINITY)) {
      continue;
    }
    if (best === null || label.start > best.start || (label.start === best.start && label.line > best.line)) {
      best = label;
    }
  }
  return best;
}

const DATE_LIKE = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/;

function alphanumericCount(value: string) {
  return (value.match(/[A-Za-z0-9]/g) ?? []).length;
}

/** Whether a value names the label of another field ("ALUMINUM FINISH ANODIZE": two cells run together). */
function namesAnotherFieldsLabel(field: CellField, value: string): boolean {
  for (const match of value.matchAll(LABEL_PATTERN)) {
    const specIndex = match.slice(1).findIndex((group) => group !== undefined);
    const other = LABEL_SPECS[specIndex]?.field ?? null;
    if (other !== null && other !== field) {
      return true;
    }
  }
  return false;
}

/** The reason a value read from a cell cannot be that field, or null when it can. */
function rejectionFor(field: CellField, value: string): string | null {
  if (isLabelLikeToken(value)) {
    return "label_token";
  }
  if (field === "revision") {
    return /^[A-Z0-9][A-Z0-9.-]{0,7}$/i.test(value) && !DATE_LIKE.test(value) ? null : "bad_shape";
  }
  // A single character is a zone marker or a stray letter, never a drawing number, material or finish.
  if (alphanumericCount(value) < 2) {
    return "bad_shape";
  }
  if (field === "partNumber") {
    // Whitespace in a drawing number is how two cells' values look when poppler's layout columns squeeze
    // them together ("ABC-001 A": the number and the revision). Without word boxes to tell them apart
    // it is not read; the field is flagged and left for the user.
    return value.length > 40 || /\s/.test(value) || DATE_LIKE.test(value) ? "bad_shape" : null;
  }
  if (value.length > 120) {
    return "bad_shape";
  }
  // Two cells run together on one line (single-spaced text, OCR) put the next field's label inside this
  // value. Where one cell ends is not known, so neither is read.
  return namesAnotherFieldsLabel(field, value) ? "label_in_value" : null;
}

/**
 * Drawing sheets print zone markers along their edges ("8 7 6 5 4 3 2" and "1" under the title block).
 * They are one character each, so they would pass for the value of an empty cell above them. Only the
 * last few lines of the block can be the bottom border.
 */
const BORDER_MARKER_TAIL_LINES = 3;

/** Only single characters: three or more of them in a row ("5 4 3 2"), or one alone on the last line ("1"). */
function isBorderMarkerLine(raw: string, isLastLine: boolean) {
  const tokens = raw.trim().split(/\s+/);
  return tokens.every((token) => /^[A-Za-z0-9]$/.test(token)) && (tokens.length >= 3 || (isLastLine && tokens.length === 1));
}

function withoutBorderMarkers(lines: readonly TitleBlockTextLine[]): TitleBlockTextLine[] {
  const tail = lines
    .filter((line) => line.raw.trim().length > 0)
    .sort((left, right) => right.lineNumber - left.lineNumber)
    .slice(0, BORDER_MARKER_TAIL_LINES);
  if (tail.length < 2) {
    return [...lines];
  }
  const markers = new Set(tail.filter((line, index) => isBorderMarkerLine(line.raw, index === 0)));
  return lines.filter((line) => !markers.has(line));
}

function joinContiguousRuns(runs: Run[]): Run[] {
  const sorted = [...runs].sort((left, right) => left.start - right.start);
  const joined: Run[] = [];
  for (const run of sorted) {
    const previous = joined[joined.length - 1];
    if (previous === undefined || run.start - previous.end <= GAP_JOIN) {
      joined.push(run);
    } else {
      break;
    }
  }
  return joined;
}

/** A run left of this many columns past its label's left edge is left aligned under the label. */
const ALIGNED_UNDER_LABEL = 4;

function readOne(
  label: Label & { field: CellField },
  page: number,
  owned: Run[],
  inlineRuns: ReadonlySet<Run>,
): CellRead {
  const base = {
    field: label.field,
    page,
    label: label.text.replace(/:$/, ""),
    labelLine: label.line,
    labelStart: label.start,
    labelEnd: label.end,
  };
  const empty = (status: CellReadStatus, reason: string, valueLines: number[] = []): CellRead => ({
    ...base,
    status,
    value: null,
    reason,
    valueLines,
  });

  const byLine = new Map<number, Run[]>();
  for (const run of owned) {
    const lineRuns = byLine.get(run.line);
    if (lineRuns === undefined) {
      byLine.set(run.line, [run]);
    } else {
      lineRuns.push(run);
    }
  }
  const lines = [...byLine.keys()].sort((left, right) => left - right);
  const chosen: Array<{ line: number; runs: Run[] }> = [];
  for (const line of lines) {
    const lineRuns = byLine.get(line) ?? [];
    const previous = chosen[chosen.length - 1];
    if (previous === undefined) {
      chosen.push({ line, runs: joinContiguousRuns(lineRuns) });
      continue;
    }
    if (line - previous.line > MAX_LINE_GAP) {
      break;
    }
    // A wrapped value continues directly under the line above it ("CLASS 2" under "ANODIZE, BLACK ...").
    // Text that does not overlap the previous line's columns is another cell, and a single character is
    // a sheet-border zone marker ("4" under the FINISH value), so neither joins the value.
    let spanStart = Number.POSITIVE_INFINITY;
    let spanEnd = Number.NEGATIVE_INFINITY;
    for (const run of previous.runs) {
      spanStart = Math.min(spanStart, run.start);
      spanEnd = Math.max(spanEnd, run.end);
    }
    const continuing = joinContiguousRuns(lineRuns.filter((run) => run.start < spanEnd && run.end > spanStart));
    if (continuing.some((run) => alphanumericCount(run.text) >= 2)) {
      chosen.push({ line, runs: continuing });
    }
  }
  if (chosen.length === 0) {
    return empty("empty", "no_value");
  }
  const valueLines = chosen.map((entry) => entry.line);
  // Text on the label's own line AND text left aligned under the label: one of them belongs to a cell
  // the vocabulary does not know ("HEAT TREAT RC 40-45" beside MATERIAL), and which one is not known.
  const hasInline = owned.some((run) => inlineRuns.has(run));
  const alignedBelow = owned.some((run) => !inlineRuns.has(run) && run.start <= label.start + ALIGNED_UNDER_LABEL);
  if (hasInline && alignedBelow) {
    return empty("ambiguous", "multiple_values", valueLines);
  }
  if (chosen.length > MAX_VALUE_LINES[label.field]) {
    // An identifier with text on a second line, or a wrapped value that runs past its limit: the cell
    // is not one clean value, so none is taken.
    return empty("ambiguous", "multiple_values", valueLines);
  }

  const value = normalizeWhitespace(chosen.map((entry) => entry.runs.map((run) => run.text).join(" ")).join(" "));
  const rejection = rejectionFor(label.field, value);
  if (rejection !== null) {
    return empty("rejected", rejection, valueLines);
  }
  return { ...base, status: "value", value, reason: null, valueLines };
}

function groupByPage(lines: readonly TitleBlockTextLine[]): Map<number, TitleBlockTextLine[]> {
  const pages = new Map<number, TitleBlockTextLine[]>();
  for (const line of lines) {
    const pageLines = pages.get(line.page);
    if (pageLines === undefined) {
      pages.set(line.page, [line]);
    } else {
      pageLines.push(line);
    }
  }
  return pages;
}

function groupByLine<T extends { line: number }>(items: readonly T[]): Map<number, T[]> {
  const lines = new Map<number, T[]>();
  for (const item of items) {
    const lineItems = lines.get(item.line);
    if (lineItems === undefined) {
      lines.set(item.line, [item]);
    } else {
      lineItems.push(item);
    }
  }
  return lines;
}

/**
 * One read per cell label (DWG. NO., REV, MATERIAL, FINISH) found in the given title-block lines.
 * Pass the lines of a single drawing in reading order; pages are read independently.
 */
export function readTitleBlockCells(lines: readonly TitleBlockTextLine[]): CellRead[] {
  const reads: CellRead[] = [];
  for (const [page, pageText] of groupByPage(lines)) {
    // The caps are checked in the order the work grows, and each loop below stops when its own cap is
    // passed, so a hostile page costs about its cap and not its size.
    const candidateLines = pageText.filter((line) => line.raw.length <= MAX_LINE_LENGTH);
    if (candidateLines.length > MAX_LINES_PER_PAGE) {
      continue;
    }
    const pageLines = withoutBorderMarkers(candidateLines);
    const labels: Label[] = [];
    for (const line of pageLines) {
      findLabels(line, labels, MAX_LABELS_PER_PAGE);
      if (labels.length > MAX_LABELS_PER_PAGE) {
        break;
      }
    }
    if (labels.length > MAX_LABELS_PER_PAGE) {
      continue;
    }
    const labelsByLine = groupByLine(labels);
    const runs: Run[] = [];
    for (const line of pageLines) {
      findRuns(line, labelsByLine.get(line.lineNumber) ?? [], runs, MAX_RUNS_PER_PAGE);
      if (runs.length > MAX_RUNS_PER_PAGE) {
        break;
      }
    }
    if (runs.length > MAX_RUNS_PER_PAGE) {
      continue;
    }
    const caps = computeCapLines(labels);
    const ownedByLabel = new Map<Label, Run[]>();
    const ownedOnLine = new Map<number, Array<{ run: Run; owner: Label }>>();
    const unowned: Run[] = [];
    const assign = (run: Run, owner: Label) => {
      const ownerRuns = ownedByLabel.get(owner);
      if (ownerRuns === undefined) {
        ownedByLabel.set(owner, [run]);
      } else {
        ownerRuns.push(run);
      }
      const lineOwned = ownedOnLine.get(run.line);
      if (lineOwned === undefined) {
        ownedOnLine.set(run.line, [{ run, owner }]);
      } else {
        lineOwned.push({ run, owner });
      }
    };
    const inlineRuns = new Set<Run>();
    const inlineOwners = new Map<Run, Label>();
    const runsByLine = groupByLine(runs);
    for (const [lineNumber, lineRuns] of runsByLine) {
      const lineLabels = labelsByLine.get(lineNumber) ?? [];
      const ordered = [...lineRuns].sort((left, right) => left.start - right.start);
      let previousRun: Run | null = null;
      let previousOwner: Label | null = null;
      for (const run of ordered) {
        const inline = inlineOwnerOf(run, lineLabels, previousRun, inlineOwners);
        if (inline !== null) {
          inlineOwners.set(run, inline);
          inlineRuns.add(run);
        }
        // The first word of a value starts in its label's band; the words after it (word boxes make every
        // word a run) follow it on the line, with no label between.
        const owner: Label | null =
          inline ??
          ownerOf(run, labels, caps) ??
          (previousRun !== null &&
          previousOwner !== null &&
          run.start - previousRun.end <= GAP_JOIN &&
          run.cellBreakBefore !== true &&
          !lineLabels.some((label) => label.start >= previousRun!.end - 1 && label.end <= run.start + 1)
            ? previousOwner
            : null);
        if (owner === null) {
          unowned.push(run);
        } else {
          assign(run, owner);
        }
        previousRun = run;
        previousOwner = owner;
      }
    }
    // A run directly under an owned run and overlapping its columns continues that value ("CLASS 2" under
    // "ANODIZE, BLACK, ..."), as long as no other label stands between. Top to bottom, so a wrap of
    // several lines chains.
    unowned.sort((left, right) => left.line - right.line);
    for (const run of unowned) {
      let continued: Label | null = null;
      for (let line = run.line - 1; line >= run.line - MAX_LINE_GAP && continued === null; line -= 1) {
        for (const { run: above, owner } of ownedOnLine.get(line) ?? []) {
          if (
            run.start < above.end &&
            run.end > above.start &&
            run.center >= owner.start - owner.slack &&
            run.line <= (caps.get(owner) ?? Number.POSITIVE_INFINITY)
          ) {
            continued = owner;
            break;
          }
        }
      }
      if (continued !== null) {
        assign(run, continued);
      }
    }
    for (const label of labels) {
      if (label.field !== null) {
        reads.push(readOne({ ...label, field: label.field }, page, ownedByLabel.get(label) ?? [], inlineRuns));
      }
    }
  }
  return reads;
}
