/**
 * OVD-985 and OVD-989: read the title block by the cell each label owns.
 *
 * pdftotext -layout prints a title block row by row, so the value of a cell is usually several lines
 * below its label, with the other cells' text in between ("DWG. NO." on one line, its number seven
 * lines later; MATERIAL and FINISH stacked in one column next to the approvals block). Reading "the
 * next line, or else the whole next line" therefore lands on a neighbouring cell: the approvals label
 * Q.A. as the part number, the TITLE text as the material, the SURFACE FINISH note as the finish.
 *
 * Positions are columns, and "line" orders the lines of one page from top to bottom, so blank lines
 * count as vertical distance. Two sources feed the same rules:
 *  - `pdftotext -layout` text: a column is a character position;
 *  - word boxes (`pdftotext -bbox`, built into lines by pdfWords.ts): a column is a position in points
 *    divided by POINTS_PER_COLUMN, each word is a run, and the position is the word's true one. This is
 *    the source when the page has it, because layout columns are squeezed where a word is wider than its
 *    characters (a 24 pt drawing number beside 9 pt labels).
 *
 * Ownership rule:
 *
 *  1. A line is split into labels from a fixed vocabulary and value runs. A label counts only where a
 *     label can start: at the line start, after two or more spaces, directly after another label, or
 *     after a token that contains a digit ("DWG. NO. 1000-1 REV A"). "DIMENSIONS APPLY AFTER PLATING"
 *     is prose, so PLATING there is not a label. In layout text, what is left after the labels are
 *     blanked splits into runs wherever two or more spaces separate it.
 *  2. The first run printed after a label on the same line is that label's value, and the words that
 *     follow it ("SHEET 1 OF 1"). Any other run is owned by the label that is above it (or left of it
 *     on its own line), has its left edge no more than SLACK columns right of the run's centre, and has
 *     the greatest left edge among those. Cells are left aligned and stacked, so the label whose left
 *     edge is nearest on the left is the one whose cell the run lies in; a value centred in its cell
 *     has its centre inside it.
 *  3. A label stops owning anything below the first label that sits under it in its own columns (the
 *     next cell of the same stack: FINISH under MATERIAL, SCALE under DWG. NO.).
 *  4. Within one line the runs a label owns must be contiguous (gap of at most GAP_JOIN columns); a
 *     farther run belongs to another cell. A second line joins a value only when it sits under the
 *     first and holds more than a single character.
 *
 * Fail closed: a label with no run, with more than one value line for a single-valued field, with a
 * value that is itself a label ("Q.A.", "CHECKED"), with a single character (a zone marker), or a part
 * number containing a space (two cells squeezed together) yields no value. Nothing falls back to
 * neighbouring text, so the caller flags the field for review and leaves it empty rather than guessing.
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

/** Columns a value's centre may sit left of its label's left edge (labels are not always flush). */
const SLACK = 3;
/** Largest horizontal distance, in columns, from a label's left edge to a value's centre. */
const MAX_DX = 100;
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
};

type Run = {
  text: string;
  line: number;
  start: number;
  end: number;
  center: number;
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** True when the whole text is made only of title-block labels ("Q.A.", "CHECKED", "ENG APPR."). */
export function isLabelLikeToken(value: string): boolean {
  const text = normalizeWhitespace(value);
  if (!/[A-Za-z0-9]/.test(text)) {
    return false;
  }
  const rest = text.replace(LABEL_ONLY_PATTERN, " ").replace(/[^A-Za-z0-9]+/g, "");
  return rest.length === 0;
}

/** Whether a label may start at `start`: where a label can start, not inside a sentence. */
function labelMayStartAt(raw: string, start: number, previousLabelEnd: number): boolean {
  const before = raw.slice(0, start);
  const trimmed = before.replace(/[ \t]+$/, "");
  const gap = before.slice(trimmed.length);
  if (trimmed.length === 0 || gap.length >= 2 || gap.includes("\t")) {
    return true;
  }
  if (previousLabelEnd === trimmed.length) {
    return true;
  }
  return /\d/.test(/\S+$/.exec(trimmed)?.[0] ?? "");
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

function findLabels(line: TitleBlockTextLine): Label[] {
  const labels: Label[] = [];
  let previousLabelEnd = -1;
  for (const match of line.raw.matchAll(LABEL_PATTERN)) {
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
    labels.push({
      field: spec.field,
      text: normalizeWhitespace(match[0]),
      line: line.lineNumber,
      start: columnAt(line, start, "start"),
      end: columnAt(line, end, "end"),
      charStart: start,
      charEnd: end,
    });
    previousLabelEnd = end;
  }
  return labels;
}

function findRuns(line: TitleBlockTextLine, labels: Label[]): Run[] {
  if (line.words !== undefined && line.words.length > 0) {
    // Word boxes: every word outside a label is a run at its true extent. Ownership is decided word by
    // word, so a number that runs up against the next cell is still split from it.
    const wordRuns: Run[] = [];
    for (const word of line.words) {
      const text = line.raw.slice(word.from, word.to);
      if (!/[A-Za-z0-9]/.test(text) || labels.some((label) => word.from < label.charEnd && word.to > label.charStart)) {
        continue;
      }
      wordRuns.push({ text, line: line.lineNumber, start: word.x0, end: word.x1, center: (word.x0 + word.x1) / 2 });
    }
    return wordRuns;
  }

  let blanked = line.raw.replace(/[|│┃]/g, " ");
  for (const label of labels) {
    blanked = `${blanked.slice(0, label.charStart)}${" ".repeat(label.charEnd - label.charStart)}${blanked.slice(label.charEnd)}`;
  }
  const runs: Run[] = [];
  for (const match of blanked.matchAll(/\S+(?: \S+)*/g)) {
    if (!/[A-Za-z0-9]/.test(match[0])) {
      continue;
    }
    const start = match.index ?? 0;
    const end = start + match[0].length;
    runs.push({ text: match[0], line: line.lineNumber, start, end, center: (start + end) / 2 });
  }
  return runs;
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
        other.end > label.start - SLACK &&
        other.start < label.end + SLACK
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
 * 0.0724", "DWG. NO. 1000-1 REV A"), whatever stack of cells lies above it. The words after the first one
 * of such a phrase belong to the same label. `inlineOwners` holds the runs already placed that way, left
 * to right.
 */
function inlineOwnerOf(
  run: Run,
  labels: Label[],
  lineRuns: readonly Run[],
  inlineOwners: ReadonlyMap<Run, Label>,
): Label | null {
  let direct: Label | null = null;
  for (const label of labels) {
    if (label.line === run.line && run.start - label.end >= -1 && run.start - label.end <= INLINE_GAP) {
      const runBetween = lineRuns.some((other) => other !== run && other.start >= label.end - 1 && other.end <= run.start);
      if (!runBetween && (direct === null || label.start > direct.start)) {
        direct = label;
      }
    }
  }
  if (direct !== null) {
    return direct;
  }

  let previous: Run | null = null;
  for (const other of lineRuns) {
    if (other !== run && other.end <= run.start + 1 && (previous === null || other.end > previous.end)) {
      previous = other;
    }
  }
  return previous !== null && run.start - previous.end <= PHRASE_GAP ? (inlineOwners.get(previous) ?? null) : null;
}

function ownerOf(run: Run, labels: Label[], caps: Map<Label, number>): Label | null {
  let best: Label | null = null;
  for (const label of labels) {
    const dy = run.line - label.line;
    if (dy < 0 || dy > MAX_DY) {
      continue;
    }
    if (dy === 0 && label.end > run.start + 1) {
      continue;
    }
    if (run.center < label.start - SLACK || run.center - label.start > MAX_DX) {
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
  return value.length > 120 ? "bad_shape" : null;
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

function readOne(
  label: Label & { field: CellField },
  page: number,
  owned: Run[],
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
    const spanStart = Math.min(...previous.runs.map((run) => run.start));
    const spanEnd = Math.max(...previous.runs.map((run) => run.end));
    const continuing = joinContiguousRuns(lineRuns.filter((run) => run.start < spanEnd && run.end > spanStart));
    if (continuing.some((run) => (run.text.match(/[A-Za-z0-9]/g) ?? []).length >= 2)) {
      chosen.push({ line, runs: continuing });
    }
  }
  if (chosen.length === 0) {
    return empty("empty", "no_value");
  }
  const valueLines = chosen.map((entry) => entry.line);
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

/**
 * One read per cell label (DWG. NO., REV, MATERIAL, FINISH) found in the given title-block lines.
 * Pass the lines of a single drawing in reading order; pages are read independently.
 */
export function readTitleBlockCells(lines: readonly TitleBlockTextLine[]): CellRead[] {
  const reads: CellRead[] = [];
  for (const page of [...new Set(lines.map((line) => line.page))]) {
    const candidateLines = lines.filter((line) => line.page === page && line.raw.length <= MAX_LINE_LENGTH);
    if (candidateLines.length > MAX_LINES_PER_PAGE) {
      continue;
    }
    const pageLines = withoutBorderMarkers(candidateLines);
    const labels = pageLines.flatMap(findLabels);
    if (labels.length > MAX_LABELS_PER_PAGE) {
      continue;
    }
    const labelsByLine = new Map<number, Label[]>();
    for (const label of labels) {
      const lineLabels = labelsByLine.get(label.line);
      if (lineLabels === undefined) {
        labelsByLine.set(label.line, [label]);
      } else {
        lineLabels.push(label);
      }
    }
    const runs = pageLines.flatMap((line) => findRuns(line, labelsByLine.get(line.lineNumber) ?? []));
    if (runs.length > MAX_RUNS_PER_PAGE) {
      continue;
    }
    const caps = computeCapLines(labels);
    const runsByLine = new Map<number, Run[]>();
    for (const run of runs) {
      const lineRuns = runsByLine.get(run.line);
      if (lineRuns === undefined) {
        runsByLine.set(run.line, [run]);
      } else {
        lineRuns.push(run);
      }
    }
    const ownedByLabel = new Map<Label, Run[]>();
    const inlineOwners = new Map<Run, Label>();
    for (const run of runs) {
      const inline = inlineOwnerOf(run, labels, runsByLine.get(run.line) ?? [], inlineOwners);
      if (inline !== null) {
        inlineOwners.set(run, inline);
      }
      const owner = inline ?? ownerOf(run, labels, caps);
      if (owner === null) {
        continue;
      }
      const ownerRuns = ownedByLabel.get(owner);
      if (ownerRuns === undefined) {
        ownedByLabel.set(owner, [run]);
      } else {
        ownerRuns.push(run);
      }
    }
    for (const label of labels) {
      if (label.field !== null) {
        reads.push(readOne({ ...label, field: label.field }, page, ownedByLabel.get(label) ?? []));
      }
    }
  }
  return reads;
}
