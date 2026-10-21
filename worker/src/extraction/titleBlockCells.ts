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
 *  - `pdftotext -layout` text: a column is a character position, and a line a line of the text. poppler prints at
 *    most four blank lines between two lines of text however far apart they are on the sheet, so a value under that
 *    many is at an unknown distance from its label and is not read (far_value);
 *  - word boxes (`pdftotext -bbox`, built into lines by pdfWords.ts): a column is 0.4 text heights, each word is a
 *    run, and the position is the word's true one. A line's number orders the lines; its `y` measures how far down the
 *    page it is in text heights (the empty stretch of the sheet counts), and what a cell reads must be near by both: a
 *    value more than MAX_DY lines down the page under its label is not its value, and a line that would continue a value
 *    but is more than MAX_LINE_GAP lines down the page under it flags the cell (far_value), however few lines of text lie
 *    between. This is the source when the page has it, because layout columns are squeezed where a word is wider than
 *    its characters (a 24 pt drawing number beside 9 pt labels), and a column in text heights does not depend on the
 *    size of the sheet.
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
 *     cell of the same stack: FINISH under MATERIAL, SCALE under DWG. NO.), and it is no more than MAX_DY lines
 *     under the label (with word boxes, in order and down the page). Of the labels that fit, the nearest on the
 *     left wins. A run that fits no label belongs to none and is not read.
 *  4. Words after the first word of a value continue it along the line (no label between, no wide gap);
 *     the line under a value continues it when it overlaps its columns and is still in the label's columns,
 *     and with word boxes the words after the first one that overlaps continue it too, even where they run
 *     past the end of the line above.
 *  5. Within one line the runs a label owns must be contiguous (gap of at most GAP_JOIN columns); a
 *     farther run belongs to another cell. A second line joins a value only when it sits under the
 *     first and holds more than a single character.
 *
 * Fail closed: a label with no run, with more than one value line for a single-valued field, with text on
 * its own line AND text left aligned under it, with a label of an unlisted cell on its own line (a run that
 * ends in a colon, or has text of its own under it: see hasOwnCellOnItsLine), with a value that is itself a
 * label ("Q.A.", "CHECKED"), that names another field's label ("ALUMINUM FINISH ANODIZE"), that points
 * elsewhere ("SEE NOTE 1") or stops in the middle ("ANODIZE, CLASS"), with a single character (a zone
 * marker), or a part number containing a space (two cells squeezed together) yields no value. Nothing falls
 * back to neighbouring text, so the caller flags the field for review and leaves it empty rather than
 * guessing. Layout text, whose columns cannot tell the rest of a value from another cell at a fine pitch, is
 * flagged when a cell owns a run its value did not take, when text no cell owns follows a material or finish,
 * when a run of another label's band follows it directly, and for every cell of a page whose own labels are
 * spread apart (`spread` on a Label).
 *
 * A material or finish has a cell stacked under it as often as beside it, and its label is often one the vocabulary
 * does not know (SURFACE TREATMENT, PAINT, THICKNESS, QTY). Its text is never read as a line of the value, and the
 * rule that keeps it out is the shape of the line, not a list of labels and not the size of the text (shapeOfLine):
 * a label is words of letters (hyphenated, a unit in brackets or a number sign among them: "HEAT-TREAT",
 * "THICKNESS (IN)", "LOT #"), alone on its line or followed by its own value ("THICKNESS .125", "LOT CODE A123").
 *  - A first line that opens another cell (HEAT TREAT, HEAT-TREAT, HARDNESS, PAINT COLOR or any text with a colon), or
 *    that has a word after its first one set apart from the words before it or taller than its first word, whatever
 *    they are made of ("THICKNESS   .125", a 6 pt "THICKNESS (IN)" by a 9 pt ".125"), or that is followed on its line by
 *    taller text no cell owns (a 6 pt "LOT #" by a 9 pt "A123" past the cell's reach), or that is only label words with
 *    other text in its cell, a single character included ("THICKNESS" over ".125", "QTY" over "4", "ANODIZE" over
 *    "PAINT") gives no value: see chooseValueLines and firstLineIsStackedLabel.
 *  - A later line that starts with words of letters ends the value (word boxes, set smaller than the value) or gives
 *    no value, unless it is the value's own wrapped line: the value is beside its label on the label's own line, the
 *    line starts where the value starts and goes on past its lead ("CLASS 2" under "FINISH  ANODIZE, ... TYPE II"). A
 *    later line set taller than the one above makes that one a label. See stackedLineVerdict.
 * A part number or revision centred past its label's reach belongs to no cell either, and the label of a cell stacked
 * under it (QTY, ITEM, CUSTOMER) would be the only text its cell owns. Read from a line under its label, an identifier
 * that could be a label (label words only, or a part number with no digit) gives no value when the cell holds other
 * text: see identifierIsStackedLabel.
 * Known limits: a material or finish cell left empty, with a stacked cell under it whose label and value fit one line
 * one word space apart at one size ("LOT CODE A123"), or whose label is alone ("LOT CODE"), reads that line as the value:
 * it has the shape of a value such as "AL 6061-T6" or "AS MACHINED", and nothing else on the sheet tells them apart. A
 * stacked cell set at the value's size, whose label starts exactly where a value beside its own label starts and has its
 * value one word space after it ("QTY 4" under "FINISH  ANODIZE, BLACK"), is read as that value's wrapped line.
 *
 * A label ends at a colon whatever follows it, so a label and its value printed as one word ("MATERIAL:ALUMINUM")
 * are read as the label and its inline value; with word boxes the part of the word after the label is a run.
 * With word boxes, a separator printed as a word of its own ("-" one word space after "6061") stays in the value it is
 * printed with, as layout text keeps it in its run, so a value that ends on one is cut short and not read (findWordRuns).
 * Words are owned one by one, so a material or finish printed as one phrase that runs on under another label's columns
 * ("... TEMPER T651" with T651 under Q.A.), or that starts left of its own cell, is not cut there: every cell it is
 * printed in is flagged (markCutPhrases).
 *
 * Every loop is bounded by the caps below, and the work per line is linear in its length. A line over MAX_LINE_LENGTH is
 * not read, but no cell is read across it either (crossesUnreadLine): the field is flagged.
 *
 * A test that has a `pdftotext -layout` text, or a page of word boxes, can call readTitleBlockCells
 * directly; the sheets in worker/test-support build both.
 */

import { mergeHorizontalBorders, type GeometryBounds } from "./pdfVectorGeometry.js";

export type CellField = "partNumber" | "revision" | "material" | "finish";

/** One word of a line built from word boxes: its characters in `raw`, and where it sits, in layout columns. */
export type TitleBlockWord = {
  from: number;
  to: number;
  x0: number;
  x1: number;
  /** The word box's height in points. */
  height?: number;
  /** Original page coordinates, for proving a ruled cell border. */
  y0?: number;
  y1?: number;
};

export type TitleBlockBorder = { x0: number; x1: number; y: number };

export type TitleBlockTextLine = {
  page: number;
  /**
   * Layout line number on the page (1-based, blank lines included). For a line built from word boxes,
   * the position of the line among the page's lines from top to bottom.
   */
  lineNumber: number;
  /**
   * Word boxes only (pdfWords.ts): the line's distance down the page in the page's text heights, the first line at 1, so
   * the empty stretch of the sheet above it counts as blank lines do in layout text. What a cell reads is limited by it as
   * well as by the order of the lines (ownerOf, chooseValueLines): two lines next to each other in order may be far apart
   * on the sheet.
   */
  y?: number;
  raw: string;
  /**
   * Present on lines built from word boxes (pdfWords.ts). The columns of a `pdftotext -layout` line are
   * squeezed when a word is wider than its characters (a 24 pt drawing number next to 9 pt labels), so
   * the words' own extents are used instead: each word is a run, and its position is its true one.
   */
  words?: readonly TitleBlockWord[];
  /** Points per column of the page the words were measured on (pdfWords.ts); present with `words`. */
  pointsPerColumn?: number;
  /** Visible horizontal rules in page points; absent when vector geometry was unavailable. */
  borders?: readonly TitleBlockBorder[];
};

export type CellReadStatus = "value" | "empty" | "ambiguous" | "rejected";

export type CellRead = {
  field: CellField;
  status: CellReadStatus;
  /** The cell's value; null unless status is "value". */
  value: string | null;
  /**
   * Why the cell gave no value: no_value, multiple_values, label_token, bad_shape, unlisted_label, unconsumed_text,
   * fine_pitch, unread_line, far_value, pointer, cut_short, label_in_value.
   */
  reason: string | null;
  page: number;
  /** The label as printed, for example "DWG. NO.". */
  label: string;
  labelLine: number;
  labelStart: number;
  labelEnd: number;
  /** Layout lines the value was read from. */
  valueLines: number[];
  /** Positive evidence that the whole cell was consumed, not just a plausible candidate. */
  complete: boolean;
  geometryRegion?: GeometryBounds;
  revisionRole?: "current" | "history" | "ambiguous";
  /** Independent evidence survives a rejected suggestion; it can veto but never grant approval. */
  observations?: Array<{ value: string; binding: "label_owned" | "unresolved" }>;

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
  { source: "PN", field: "partNumber" },
  { source: "REVISIONS", field: null },
  { source: "REVISION", field: "revision" },
  { source: String.raw`REV\.?`, field: "revision" },
  { source: "MATERIAL", field: "material" },
  { source: String.raw`MATL\.?`, field: "material" },
  { source: String.raw`FINISH(?:\s*\/\s*COATING)?`, field: "finish" },
  { source: "COATING", field: "finish" },
  { source: "PLATING", field: "finish" },
  { source: String.raw`INTERPRET\s+(?:GEOMETRIC|IN\s+ACCORDANCE\s+WITH)`, field: null },
  { source: String.raw`TOLERANCING\s+PER`, field: null },
  { source: String.raw`UNLESS\s+OTHERWISE\s+SPECIFIED`, field: null },
  { source: String.raw`DIMENSIONS\s+APPLY\s+AFTER\s+PLATING`, field: null },
  { source: String.raw`DO\s+NOT\s+SCALE\s+DRAWING`, field: null },
  { source: String.raw`(?:THIRD|FIRST)\s+ANGLE\s+PROJECTION`, field: null },
  { source: String.raw`PROPRIETARY\s+AND\s+CONFIDENTIAL`, field: null },
  { source: String.raw`NEXT\s+(?:ASSY|ASSEMBLY|ASSM|ASM)\.?`, field: null },
  { source: String.raw`USED\s+ON`, field: null },
  { source: String.raw`CAGE(?:\s+CODE)?`, field: null },
  { source: "TITLE", field: null },
  { source: "DESCRIPTION", field: null },
  { source: "SIZE", field: null },
  { source: "SCALE", field: null },
  { source: "SHEET", field: null },
  { source: "WEIGHT", field: null },
  { source: "MASS", field: null },
  { source: "COMMENTS?", field: null },
  { source: "NOTES?", field: null },
  { source: "APPROVALS?", field: null },
  { source: String.raw`APPROVED(?:\s+BY)?`, field: null },
  { source: String.raw`APPR\.?`, field: null },
  { source: String.raw`APPD\.?`, field: null },
  { source: "NAME", field: null },
  { source: "DATE", field: null },
  { source: String.raw`DRAWN(?:\s+BY)?`, field: null },
  { source: String.raw`DRN\.?`, field: null },
  { source: String.raw`CHECKED(?:\s+BY)?`, field: null },
  { source: "CHECKER", field: null },
  { source: String.raw`CHKD?\.?`, field: null },
  { source: "ENGINEER(?:ING)?", field: null },
  { source: String.raw`ENGR?\.?`, field: null },
  { source: String.raw`MFG\.?`, field: null },
  { source: "MANUFACTURING", field: null },
  { source: String.raw`Q\.?\s?A\.?`, field: null },
  { source: String.raw`Q\.?\s?C\.?`, field: null },
  { source: "ISSUED", field: null },
  { source: "RELEASED", field: null },
  { source: "REVIEWED", field: null },
  { source: "PROJECT", field: null },
  { source: String.raw`SHT\.?`, field: null },
  { source: "PAGES?", field: null },
  { source: "EC[ONR]", field: null },
  { source: "ZONE", field: null },
];

// A label is a whole word: a letter, digit or hyphen on either side means the text is something else
// ("ENG-1234" and "REV-B" are values, not the labels ENG and REV). A colon ends a label whatever follows it, so
// a label and its value printed as one word ("MATERIAL:ALUMINUM", "REV:A") are the label "MATERIAL:" and its value.
// One capture group per spec, so the index of the group that matched names the spec.
const NOT_AFTER_LABEL_CHARACTER = "(?<![A-Za-z0-9-])";
const NOT_BEFORE_LABEL_CHARACTER = "(?![A-Za-z0-9-])";
const LABEL_ALTERNATION = LABEL_SPECS.map((spec) => `(${spec.source}(?::|${NOT_BEFORE_LABEL_CHARACTER}))`).join("|");
const LABEL_PATTERN = new RegExp(`${NOT_AFTER_LABEL_CHARACTER}(?:${LABEL_ALTERNATION})`, "gi");
// The same alternation, used to test whether a whole value is only labels.
const LABEL_ONLY_ALTERNATION = LABEL_SPECS.map((spec) => `(?:${spec.source}:?)`).join("|");
const LABEL_ONLY_PATTERN = new RegExp(
  `${NOT_AFTER_LABEL_CHARACTER}(?:${LABEL_ONLY_ALTERNATION})${NOT_BEFORE_LABEL_CHARACTER}`,
  "gi",
);

/**
 * Columns a value's centre may sit left of its label's left edge (labels are not always flush). Word boxes
 * give true positions, and a value is left aligned or centred under its label, so its centre is to the right
 * of the label's left edge; 2 columns of slack let a label that is indented a little still own its value and
 * keep the neighbouring cell's value (a 24 pt SIZE value left of DWG. NO.) out of the band.
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
/**
 * How many columns past its label's right edge the value of a material or finish centred in a wide cell may start
 * (unownedTextInCell): about 130 points with word boxes on a sheet of 9 pt text. Past the label's reach no cell owns
 * it; text farther off than this is another cell's, a note or the border's.
 */
const CENTRED_VALUE_REACH = 40;
/**
 * Largest vertical distance, in layout lines, from a label to a value it owns. With word boxes it holds for the order of
 * the lines and for their distance down the page in text heights (TitleBlockTextLine.y) alike.
 */
const MAX_DY = 20;
/** Runs of one line that are closer than this are one value; farther runs are another cell. */
const GAP_JOIN = 12;
/** The first run within this many columns after a label on the same line is that label's own value. */
const INLINE_GAP = 12;
/**
 * With word boxes the window is also at most this many heights of the label's own text, however large the
 * text of the rest of the page is: columns are fractions of the page's median text height, so a page set in
 * 16 pt dimensions would otherwise pull a label 74 pt away into the window of a 6 pt label.
 */
const INLINE_GAP_IN_LABEL_HEIGHTS = 6;
/** Text under an inline run belongs to it when it starts no more than this many columns left of the run, in columns. */
const ALIGNED_UNDER_INLINE = 4;
/** Text under an inline run is a value, and the run a label, when it is this much taller than the run. */
const VALUE_TEXT_TALLER_THAN_LABEL = 1.15;
/**
 * Layout text has no heights. A run of at most three words made of letters, with nothing else in it (no digit,
 * comma or hyphen: "HEAT TREAT", "TREATMENT", "PROCESS") reads like the label of a cell, and a value is
 * rarely such a run with text left aligned under it ("ANODIZE, BLACK, MIL-A-8625F" is not). See isLabelShaped.
 */
const LABEL_LIKE_RUN = /^[A-Z][A-Z .&/']{1,40}$/i;
/**
 * A word that can be part of the label of a cell: letters, with the stops, slashes, ampersands and apostrophes labels
 * are spelled with ("QTY.", "P&W") and hyphens between letters ("HEAT-TREAT", "X-RAY"); letters in brackets, the unit or
 * symbol a label names ("THICKNESS (IN)", "WT (LB)", "ROUGHNESS (Ra)"); or a number sign ("LOT #", "# REQD"). A digit or
 * a comma makes it a value ("6061-T6", "MIL-A-8625", "ANODIZE,", "(6061)"). See shapeOfLine.
 */
const LABEL_WORD = /^(?:[A-Z][A-Z.&/']*(?:-[A-Z][A-Z.&/']*)*|\([A-Z][A-Z.&/']*\)|#)$/i;
/**
 * Columns within which a later line of a material or finish starts where the value's first line starts, so that it
 * is that value wrapped and not the label of a cell stacked under it (see stackedLineVerdict).
 */
const WRAP_ALIGN = 1;
/**
 * The words that head the other cells a title block prints beside MATERIAL and FINISH. Text on the label's own line
 * that starts with one of them is that cell's label, not a value: "HEAT TREAT" beside an empty MATERIAL is not a
 * material. A cell's label also names what it heads with one word before such a word ("SURFACE TREATMENT", "PAINT
 * COLOR", "NO HEAT TREAT"); SPEC is not read that way, since "PER SPEC" and "SEE SPEC" are pointers (POINTER_AT_START).
 * They are not in the label vocabulary, so a value that runs under one of them keeps its cell.
 */
const ONE_WORD_BEFORE = String.raw`^(?:[A-Z]+\s+)?`;
const NEIGHBOUR_CELL_LABELS: readonly RegExp[] = [
  new RegExp(String.raw`${ONE_WORD_BEFORE}HEAT[\s-]+TREAT(?:MENT)?\b`, "i"),
  new RegExp(String.raw`${ONE_WORD_BEFORE}(?:TREATMENT|HARDNESS|COLOU?R|PROCESS|TEMPER|CONDITION)\b`, "i"),
  /^SPEC(?:IFICATION)?S?\b/i,
];
/** A run this close after an inline value continues it (the words of "SHEET 1 OF 1"). */
const PHRASE_GAP = 6;
/**
 * Owned value lines further apart than this are not one value; with word boxes, a line that is within it in order but
 * not down the page flags the cell (chooseValueLines). It also bounds the windows that flag a cell for text near its
 * value (ownsOtherText, hasOwnCellOnItsLine, unownedTextInCell), which count lines in order only: a sparse sheet must not
 * put text a cell owns out of their reach.
 */
const MAX_LINE_GAP = 3;
/**
 * `pdftotext -layout` prints at most this many blank lines between two lines of text, however far apart they are on
 * the sheet: a label and a line of text 400 points under it in its columns are five lines apart. Text after that many
 * blank lines is at a distance the layout text does not give, so a cell's value is not read across them (far_value).
 */
const LAYOUT_MAX_BLANK_LINES = 4;
/**
 * Layout text only: text that no cell owns, on a line of a material or finish, this many columns or fewer
 * after the end of the value, may be the rest of the value. At a fine pitch (`pdftotext -fixed 1`) the words of
 * one value are tens of columns apart, because a word is wider than its characters.
 */
const LAYOUT_TRAILING_WINDOW = 80;
/** How many value lines each field may join (one for identifiers). */
const MAX_VALUE_LINES: Record<CellField, number> = { partNumber: 1, revision: 1, material: 2, finish: 3 };
// Bounds that keep the reader linear on hostile text: a longer line or a bigger block is not read.
const MAX_LINE_LENGTH = 2_000;
const MAX_LINES_PER_PAGE = 400;
const MAX_LABELS_PER_PAGE = 400;
const MAX_RUNS_PER_PAGE = 2_000;

type Label = {
  revisionRole?: NonNullable<CellRead["revisionRole"]>;
  field: CellField | null;
  text: string;
  line: number;
  /** How far down the page the line is: TitleBlockTextLine.y with word boxes, the line number on layout text. */
  y: number;
  /** Columns: layout columns, or word extents in columns for a line built from word boxes. */
  start: number;
  end: number;
  /** Characters in the line's text. */
  charStart: number;
  charEnd: number;
  /** See WORD_SLACK and WORD_REACH: they depend on whether the line has word boxes. */
  slack: number;
  reach: number;
  /** Columns after the label in which the first run of its line is its own value. */
  inlineGap: number;
  /**
   * Layout text only: the label's own words are three or more blanks apart ("DWG.   NO."). A label is printed
   * with single spaces, so the page was laid out with columns far narrower than its characters (a fine
   * pitch): the words of every value on it are apart like cells are.
   */
  spread: boolean;
  /** True for a label on a line built from word boxes; false for one read from layout text. */
  fromWords: boolean;
  /** Word boxes only: the height of the label's own text, in points. */
  height?: number;
};

type Run = {
  text: string;
  line: number;
  /** How far down the page the line is: TitleBlockTextLine.y with word boxes, the line number on layout text. */
  y: number;
  start: number;
  end: number;
  center: number;
  /** Word boxes only: two or more spaces (a gap wider than the space inside a phrase) precede the word. */
  cellBreakBefore?: boolean;
  /** True for a run read from word boxes; false for one read from layout text. */
  fromWords: boolean;
  /** The word box's height in points, when known. */
  height?: number;
  /**
   * Word boxes only: the words of punctuation only ("-", ",") printed right after this run on its line, as one run at
   * their extent (findWordRuns). They join this run's text when a word in their place would join its value
   * (joinSeparators).
   */
  separatorAfter?: Run;
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

/** Values that supply no field evidence, shared by deterministic and model readers. */
export function isPlaceholderOrLabelValue(value: string): boolean {
  const text = normalizeWhitespace(foldForLabelTest(value)).toUpperCase();
  const normalized = text.replace(/[^A-Z0-9]/g, "");
  return /^(?:TBD|TBA|NA|NONE|TOBEDETERMINED|NOTAPPLICABLE|SEENOTES?|SEEDWG|PERNOTE|QA)$/.test(normalized) ||
    /^[\s()[\]{}.-]+$/.test(text) || isLabelLikeToken(text);
}

/** Explicit current cells outrank history; ambiguous table headers can only supply suggestions. */
export function currentRevisionReads(reads: readonly CellRead[]): CellRead[] {
  return reads.filter((read) => {
    if (read.field !== "revision") return true;
    const peers = reads.filter((other) => other.field === "revision");
    if (peers.some((other) => other.revisionRole === "current")) return read.revisionRole === "current";
    if (peers.some((other) => other.revisionRole === "ambiguous")) return read.revisionRole === "ambiguous";
    return true;
  });
}

const SPACE = 32;
const TAB = 9;

/**
 * For each position of a line, whether the token (run of non-blank characters) that ends there holds a
 * digit. One forward pass: asking it for every label of a line is linear in the line, where looking back
 * over the token for each label is quadratic in a long token that holds many labels ("PN.PN.PN. ...").
 */
function tokenDigitFlags(raw: string): Uint8Array {
  const flags = new Uint8Array(raw.length);
  let seen = 0;
  for (let position = 0; position < raw.length; position += 1) {
    const code = raw.codePointAt(position)!;
    if (code === SPACE || code === TAB) {
      seen = 0;
    } else if (code >= 48 && code <= 57) {
      seen = 1;
    }
    flags[position] = seen;
  }
  return flags;
}

function isBlankAt(raw: string, index: number): boolean {
  const code = raw.codePointAt(index);
  return code === SPACE || code === TAB;
}

/**
 * Whether a label may start at `start`: where a label can start, not inside a sentence. Scans back over the
 * blanks before it (each blank run precedes one label) and reads the digit rule from `digitFlags`, so a
 * long blank run or token stays linear.
 */
function labelMayStartAt(raw: string, start: number, previousLabelEnd: number, digitFlags: () => Uint8Array): boolean {
  let tokenEnd = start;
  while (tokenEnd > 0 && isBlankAt(raw, tokenEnd - 1)) {
    tokenEnd -= 1;
  }
  if (tokenEnd === 0) {
    return true;
  }
  const gap = start - tokenEnd;
  if (gap >= 2 || (gap === 1 && raw.codePointAt(tokenEnd) === TAB)) {
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
  return digitFlags()[tokenEnd - 1] === 1;
}

/**
 * How far down the page a line is (TitleBlockTextLine.y): its `y` with word boxes, its number on layout text (and on a
 * line whose `y` is not a finite number). With word boxes every step down is at least one line, so two lines are never
 * nearer by `y` than by their order.
 */
function yOf(line: TitleBlockTextLine): number {
  return line.y !== undefined && Number.isFinite(line.y) ? line.y : line.lineNumber;
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
  return words.at(-1)!.x1;
}

/**
 * Columns after a label in which the first run of its line is the label's own value: INLINE_GAP, and with
 * word boxes at most INLINE_GAP_IN_LABEL_HEIGHTS heights of the label's own text.
 */
function inlineGapOf(line: TitleBlockTextLine, height: number | undefined): number {
  const unit = line.pointsPerColumn;
  if (height === undefined || unit === undefined || Number.isNaN(unit) || unit <= 0) {
    return INLINE_GAP;
  }
  return Math.min(INLINE_GAP, (INLINE_GAP_IN_LABEL_HEIGHTS * height) / unit);
}

/** The height of the tallest word box of the characters `start` to `end`, or undefined (layout text has none). */
function heightOfText(line: TitleBlockTextLine, start: number, end: number): number | undefined {
  let height = 0;
  for (const word of line.words ?? []) {
    if (word.from < end && word.to > start && word.height !== undefined && word.height > height) {
      height = word.height;
    }
  }
  return height > 0 ? height : undefined;
}

/**
 * The labels of one line, appended to `into`. Stops as soon as `into` holds more than `limit` labels, so a
 * line full of labels is not scanned to its end once the page is known to be over its cap.
 */
function findLabels(line: TitleBlockTextLine, into: Label[], limit: number): void {
  const words = line.words !== undefined && line.words.length > 0;
  let digitFlags: Uint8Array | null = null;
  const flags = () => (digitFlags ??= tokenDigitFlags(line.raw));
  let previousLabelEnd = -1;
  for (const match of line.raw.matchAll(LABEL_PATTERN)) {
    if (into.length > limit) {
      return;
    }
    const start = match.index ?? 0;
    if (!labelMayStartAt(line.raw, start, previousLabelEnd, flags)) {
      continue;
    }
    const specIndex = match.slice(1).findIndex((group) => group !== undefined);
    const spec = LABEL_SPECS[specIndex];
    if (!spec) {
      continue;
    }
    const end = start + match[0].length;
    const height = heightOfText(line, start, end);
    into.push({
      field: spec.field,
      text: normalizeWhitespace(match[0]),
      line: line.lineNumber,
      y: yOf(line),
      start: columnAt(line, start, "start"),
      end: columnAt(line, end, "end"),
      charStart: start,
      charEnd: end,
      slack: words ? WORD_SLACK : LAYOUT_SLACK,
      reach: reachOf(spec.field, words),
      inlineGap: inlineGapOf(line, height),
      spread: !words && /\s{3}/.test(match[0]),
      fromWords: words,
      ...(height === undefined ? {} : { height }),
    });
    previousLabelEnd = end;
  }
}

/** A character a sheet draws cell borders with; layout text blanks them, and they never join a value. */
const BORDER_CHARACTER = /[|│┃]/;

/** Whether text holds no letter or digit: a separator or other punctuation printed as a word of its own. */
function isPunctuationOnly(text: string): boolean {
  return !/[A-Za-z0-9]/.test(text);
}

/** Word boxes: two blanks before `index` in a line's text, where pdfWords.ts marks a gap wider than a phrase's. */
function setApartAt(raw: string, index: number): boolean {
  return index >= 2 && raw.codePointAt(index - 1) === SPACE && raw.codePointAt(index - 2) === SPACE;
}

/**
 * The runs of a line built from word boxes: every word outside a label is a run at its true extent. Ownership is
 * decided word by word, so a number that runs up against the next cell is still split from it. The labels of a
 * line are in order, so one pass over both finds the words they cover. A word that a label covers only in part
 * ("MATERIAL:ALUMINUM", "NO:ABC-001": the label and its value with no blank between) keeps the part that no label
 * covers, as a run at the place its characters have in the word's box.
 *
 * A word of punctuation only ("-", ",", "/" printed apart from the word before it) is not a run of its own: it is never
 * the text of a cell, as layout text reads no run without a letter or digit. It is kept with the run before it on its
 * line (Run.separatorAfter) and joins that run's text where a word in its place would join the value (joinSeparators),
 * so the value is judged with it and a separator it ends on cuts it short (DANGLING_END): dropping it read "6061 -" as
 * "6061" (#884 review, round 12). A separator after a label or a border character, or alone in its cell, is not read.
 */
function findWordRuns(line: TitleBlockTextLine, words: readonly TitleBlockWord[], labels: readonly Label[], into: Run[], limit: number): void {
  let labelIndex = 0;
  // The run that the separators after it follow: the last part of the word before them, when that part was a run.
  let lastRun: Run | null = null;
  for (const word of words) {
    if (into.length > limit) {
      return;
    }
    while (labelIndex < labels.length && labels[labelIndex]!.charEnd <= word.from) {
      labelIndex += 1;
    }
    const text = line.raw.slice(word.from, word.to);
    const touchesLabel = labelIndex < labels.length && labels[labelIndex]!.charStart < word.to;
    if (!touchesLabel && isPunctuationOnly(text)) {
      if (lastRun !== null && !BORDER_CHARACTER.test(text)) {
        keepSeparator(line, word, text, lastRun);
      } else {
        lastRun = null;
      }
      continue;
    }
    let from = word.from;
    for (let index = labelIndex; index < labels.length && labels[index]!.charStart < word.to; index += 1) {
      const label = labels[index]!;
      pushWordPart(line, word, from, label.charStart, into);
      from = Math.max(from, label.charEnd);
    }
    lastRun = pushWordPart(line, word, from, word.to, into);
  }
}

/**
 * Adds a word of punctuation only to the separators that follow `run` on its line: one run from the first of them to the
 * last of the phrase the first one starts, so a line costs one placement per run however many separators it holds
 * (joinSeparators). A separator set apart from the one before it (a cell's gap) is another cell's and is not kept.
 */
function keepSeparator(line: TitleBlockTextLine, word: TitleBlockWord, text: string, run: Run): void {
  const setApart = setApartAt(line.raw, word.from);
  const kept = run.separatorAfter;
  if (kept === undefined) {
    run.separatorAfter = {
      text,
      line: line.lineNumber,
      y: yOf(line),
      start: word.x0,
      end: word.x1,
      center: (word.x0 + word.x1) / 2,
      cellBreakBefore: setApart,
      fromWords: true,
      ...(word.height !== undefined ? { height: word.height } : {}),
    };
  } else if (!setApart) {
    kept.text = `${kept.text} ${text}`;
    kept.end = Math.max(kept.end, word.x1);
    kept.center = (kept.start + kept.end) / 2;
  }
}

/**
 * The characters `from` to `to` of one word as a run, placed in the word's box by their share of its characters; null
 * when they hold no letter or digit (and then no run is added).
 */
function pushWordPart(line: TitleBlockTextLine, word: TitleBlockWord, from: number, to: number, into: Run[]): Run | null {
  const text = line.raw.slice(from, to);
  if (to <= from || isPunctuationOnly(text)) {
    return null;
  }
  const columnOf = (index: number) => word.x0 + ((index - word.from) / Math.max(1, word.to - word.from)) * (word.x1 - word.x0);
  const start = columnOf(from);
  const end = columnOf(to);
  const run: Run = {
    text,
    line: line.lineNumber,
    y: yOf(line),
    start,
    end,
    center: (start + end) / 2,
    cellBreakBefore: from === word.from && setApartAt(line.raw, from),
    fromWords: true,
    ...(word.height !== undefined ? { height: word.height } : {}),
  };
  into.push(run);
  return run;
}

/** The runs of a `pdftotext -layout` line: what is left after the labels are blanked, split where blanks are two or more. */
function findLayoutRuns(line: TitleBlockTextLine, labels: readonly Label[], into: Run[], limit: number): void {
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
    into.push({ text: match[0], line: line.lineNumber, y: line.lineNumber, start, end, center: (start + end) / 2, fromWords: false });
  }
}

/** The runs of one line, appended to `into` (left to right); stops once `into` holds more than `limit`. */
function findRuns(line: TitleBlockTextLine, labels: readonly Label[], into: Run[], limit: number): void {
  if (line.words !== undefined && line.words.length > 0) {
    findWordRuns(line, line.words, labels, into, limit);
  } else {
    findLayoutRuns(line, labels, into, limit);
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
    if (gap >= -1 && gap <= label.inlineGap) {
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

/**
 * Layout text only. The label whose cell a run on a later line STARTS in, among the labels that are not right of
 * `owner`: the run's left edge is no more than SLACK left of the label's left edge and no farther than REACH
 * right of its right edge. Caps are ignored, so a label that has another label under it in its columns still
 * counts. A run is left aligned with its cell, so this is where it begins; `ownerOf` judges by the run's
 * centre. They differ when the run is wide and spans into the columns of another label (two cells printed on
 * one line at a coarse pitch, a value that runs under the next stack's label): then the label the run starts
 * under and the one its centre is under both have a claim, and neither is read. A label whose own cell on this
 * line already holds the run just before (`previousRun`: "B" left of the drawing number, under SIZE) has no claim.
 */
function startOwnerOf(run: Run, owner: Label, labels: readonly Label[], previousRun: Run | null): Label | null {
  let best: Label | null = null;
  for (const label of labels) {
    const dy = run.line - label.line;
    if (dy < 1 || dy > MAX_DY || label.start > owner.start) {
      continue;
    }
    if (run.start < label.start - label.slack || run.start > label.end + label.reach) {
      continue;
    }
    if (
      previousRun !== null &&
      previousRun.end <= run.start + 1 &&
      previousRun.start >= label.start - label.slack &&
      previousRun.start <= label.end + label.reach
    ) {
      continue;
    }
    if (best === null || label.start > best.start || (label.start === best.start && label.line > best.line)) {
      best = label;
    }
  }
  return best;
}

/**
 * Layout text only. A label right of the run's owner whose columns the run reaches into: the run's last
 * character is printed under the label's first. A value is left aligned under its own label and ends before
 * the next cell begins; when it runs on into another label's columns, the text of two cells was printed on one
 * line at a pitch too coarse to keep them apart ("ABC-001A": the drawing number and the revision), and
 * the run is not one value. A label with another label under it before the run is the top of a stack of
 * cells, not a neighbour of this one.
 */
function reachesIntoLabelOf(run: Run, owner: Label, labels: readonly Label[], caps: ReadonlyMap<Label, number>): Label | null {
  for (const label of labels) {
    const dy = run.line - label.line;
    if (dy < 1 || dy > MAX_DY || label === owner || run.line > (caps.get(label) ?? Number.POSITIVE_INFINITY)) {
      continue;
    }
    if (label.start > owner.start && label.start < run.end && label.end > run.start) {
      return label;
    }
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
 * centred in a cell that starts at it, no more than MAX_DY lines under it in order and down the page. The nearest such
 * label on the left wins. A run that satisfies this for no label is text of an unlabelled cell and is never assigned.
 */
function ownerOf(run: Run, labels: readonly Label[], caps: ReadonlyMap<Label, number>): Label | null {
  let best: Label | null = null;
  for (const label of labels) {
    const dy = run.line - label.line;
    // MAX_DY down the page as well as in order: the next line of text under a label may be far under it on the sheet.
    if (dy < 1 || dy > MAX_DY || run.y - label.y > MAX_DY) {
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
// A cell that refers elsewhere instead of naming the material or finish. "PER" alone is not one ("6061-T6 PER
// AMS 4027" and "ANODIZE PER MIL-A-8625" name the material and the finish), but "PER SPEC", "PER NOTE 2",
// "PER DWG" and "PER BOM" do not. "PER SPECIFICATION MIL-DTL-5541" does name one: a specification followed by its
// designator (a standards body such as MIL or AMS, or a token that mixes letters and digits) is the finish itself.
// Two expressions rather than one alternation of an anchored and an unanchored branch: each anchor is the
// start of its own expression (SonarCloud S5850).
const SPEC_DESIGNATOR_FOLLOWS =
  String.raw`\s+(?:(?:MIL|AMS|ASTM|SAE|ISO|ASME|QQ|QPL|FED|NAS|ANSI|IEEE|DIN|EN|JIS|BS|DOD|MS|AN)(?![A-Z])|[A-Z]+-[A-Z0-9-]*\d|[A-Z]+\d)`;
const POINTER_AT_START = new RegExp(
  String.raw`^(?:SEE\b|REFER\b|REF\.?\s|AS\s+(?:NOTED|SPECIFIED|SHOWN|REQUIRED|STATED)\b|PER\s+(?:THE\s+)?(?:NOTES?|DWGS?|DRAWINGS?|BOM|PRINTS?|CUSTOMER)\b|PER\s+(?:THE\s+)?SPEC(?:S|IFICATIONS?)?\b(?!${SPEC_DESIGNATOR_FOLLOWS}))`,
  "i",
);
const POINTER_TARGETS = "NOTES?|BOM|SPECS?|SPECIFICATIONS?|DWGS?|DRAWINGS?|SHEET|TABLE|ABOVE|BELOW";
const POINTER_ANYWHERE = new RegExp(String.raw`\b(?:SEE|REFER\s+TO)\s+(?:${POINTER_TARGETS})\b`, "i");
// A value that ends in a separator, an open bracket or a word that is always followed by more. The separators include the
// other dashes a sheet prints (U+2010 to U+2015: hyphen to horizontal bar, U+2212: minus sign) and "&", which is AND.
const DANGLING_END = /(?:[,;:\-\u2010-\u2015\u2212&([/]|\b(?:CLASS|TYPE|GRADE|COND(?:ITION)?|PER|AND|OR|TO|OF|WITH|NO\.?))\s*$/i;

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

/** Why an identifier (part number, revision) read from a cell is not one, or null. */
function identifierRejection(field: "partNumber" | "revision", value: string): string | null {
  if (field === "revision") {
    return /^[A-Z0-9][A-Z0-9.-]{0,7}$/i.test(value) && !DATE_LIKE.test(value) ? null : "bad_shape";
  }
  // Whitespace in a drawing number is how two cells' values look when poppler's layout columns squeeze
  // them together ("ABC-001 A": the number and the revision). Without word boxes to tell them apart
  // it is not read; the field is flagged and left for the user.
  return value.length > 40 || /\s/.test(value) || DATE_LIKE.test(value) ? "bad_shape" : null;
}

/** Why a material or finish read from a cell is not one, or null. */
function descriptionRejection(field: "material" | "finish", value: string): string | null {
  if (value.length > 120) {
    return "bad_shape";
  }
  // "SEE NOTE 1", "SEE BOM", "AS NOTED": the cell points at another place for the material or finish. It
  // names none, so nothing is stored for the part.
  if (POINTER_AT_START.test(value) || POINTER_ANYWHERE.test(value)) {
    return "pointer";
  }
  // A value that stops in the middle ("ANODIZE, CLASS", "6061 -", "TYPE") is a value cut short, by text that
  // was laid out apart from it or by a cell that continues; the part of it that was read is not the value.
  if (DANGLING_END.test(value)) {
    return "cut_short";
  }
  // Two cells run together on one line (single-spaced text, OCR) put the next field's label inside this
  // value. Where one cell ends is not known, so neither is read.
  return namesAnotherFieldsLabel(field, value) ? "label_in_value" : null;
}

/** The reason a value read from a cell cannot be that field, or null when it can. */
function rejectionFor(field: CellField, value: string): string | null {
  if (isPlaceholderOrLabelValue(value)) {
    return "label_token";
  }
  // A single character is a zone marker or a stray letter, never a drawing number, material or finish.
  if (field !== "revision" && alphanumericCount(value) < 2) {
    return "bad_shape";
  }
  return field === "material" || field === "finish" ? descriptionRejection(field, value) : identifierRejection(field, value);
}

/**
 * Drawing sheets print zone markers along their edges ("8 7 6 5 4 3 2" and "1" under the title block).
 * They are one character each, so they would pass for the value of an empty cell above them. Only the
 * last few lines of the block can be the bottom border.
 */
const BORDER_MARKER_TAIL_LINES = 3;

/** The tokens of a line when every one of them is a single character ("5 4 3 2"), else null. */
function singleCharacterTokens(raw: string): string[] | null {
  const tokens = raw.trim().split(/\s+/);
  return tokens.every((token) => /^[A-Za-z0-9]$/.test(token)) ? tokens : null;
}

/** Three or more single characters on a line: a row of the border's zone markers. */
function isBorderMarkerRow(raw: string) {
  return (singleCharacterTokens(raw)?.length ?? 0) >= 3;
}

/**
 * A row of markers, and the one marker of the row that poppler prints a line lower ("8 7 6 5 4 3 2" over "1").
 * That lone character is a border marker only because the marker row is the line just above it: a single
 * character on the last line of a block is also a revision under REV ("DWG. NO. ABC-001", "REV", "A"), and
 * nothing but the row tells the two apart.
 */
function withoutBorderMarkers(lines: readonly TitleBlockTextLine[]): TitleBlockTextLine[] {
  const tail = lines
    .filter((line) => line.raw.trim().length > 0)
    .sort((left, right) => right.lineNumber - left.lineNumber)
    .slice(0, BORDER_MARKER_TAIL_LINES);
  if (tail.length < 2) {
    return [...lines];
  }
  const markers = new Set(tail.filter((line) => isBorderMarkerRow(line.raw)));
  const [last, aboveLast] = tail as [TitleBlockTextLine, TitleBlockTextLine];
  if (markers.has(aboveLast) && singleCharacterTokens(last.raw)?.length === 1) {
    markers.add(last);
  }
  return lines.filter((line) => !markers.has(line));
}

function joinContiguousRuns(runs: Run[]): Run[] {
  const sorted = [...runs].sort((left, right) => left.start - right.start);
  const joined: Run[] = [];
  for (const run of sorted) {
    const previous = joined.at(-1);
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

type ValueLine = { line: number; runs: Run[] };

/** Why a cell is not read before its text is looked at: see doubtOf and crossesUnreadLine. */
type CellDoubt = "unconsumed_text" | "fine_pitch" | "unread_line";

/**
 * Layout text spreads the words of one value apart when its characters are narrow (a fine pitch), so the runs the
 * cell owns but the value did not take may be the rest of the value, and so may text that no cell owns on the
 * value's line, a little after it (material and finish). Word boxes give true positions: the text that is left
 * over there is another cell's, except on a line the value was read from, where a word the cell owns and the
 * value did not take is the rest of that line ("ANODIZE" over "MIL-A-8625  TYPE III" with a wide gap) and the
 * value would be cut short.
 */
function leavesTextUnconsumed(
  field: CellField,
  owned: readonly Run[],
  chosen: readonly ValueLine[],
  leftoverByLine: ReadonlyMap<number, Run[]>,
): boolean {
  const taken = new Set<Run>();
  const chosenLines = new Set<number>();
  for (const entry of chosen) {
    chosenLines.add(entry.line);
    for (const run of entry.runs) {
      taken.add(run);
    }
  }
  if (owned.some((run) => !taken.has(run) && alphanumericCount(run.text) >= 2 && (!run.fromWords || chosenLines.has(run.line)))) {
    return true;
  }
  return (field === "material" || field === "finish") && chosen.some((entry) => hasTrailingLeftover(entry, leftoverByLine));
}

/**
 * Layout text only: text that no cell owns follows the value on its line within LAYOUT_TRAILING_WINDOW columns, with at
 * least `minimumAlphanumerics` letters or digits. Two, so that a zone letter of the sheet's border is not the rest of a
 * value; one after a line of label words only, whose own value may be a single character ("QTY", then "4": see
 * firstLineIsStackedLabel).
 */
function hasTrailingLeftover(entry: ValueLine, leftoverByLine: ReadonlyMap<number, Run[]>, minimumAlphanumerics = 2): boolean {
  if (!entry.runs.every((run) => !run.fromWords)) {
    return false;
  }
  const end = Math.max(...entry.runs.map((run) => run.end));
  return (leftoverByLine.get(entry.line) ?? []).some(
    (run) => run.start >= end - 1 && run.start - end <= LAYOUT_TRAILING_WINDOW && alphanumericCount(run.text) >= minimumAlphanumerics,
  );
}

/** The tallest word of a run of text, or undefined when no word has a height (layout text has none). */
function tallestOf(runs: readonly Run[]): number | undefined {
  let tallest: number | undefined;
  for (const run of runs) {
    if (run.height !== undefined && (tallest === undefined || run.height > tallest)) {
      tallest = run.height;
    }
  }
  return tallest;
}

/**
 * Whether a line of a cell opens the next cell of the stack (HEAT TREAT, HARDNESS, ... under MATERIAL or FINISH): it
 * holds a colon, or starts with a word that heads another cell of a title block (NEIGHBOUR_CELL_LABELS).
 * Neither is the label of the vocabulary, so the text is owned by the cell above it; it is that cell's own label
 * and value, not a line of this cell's value.
 */
function opensAnotherCell(text: string): boolean {
  return text.includes(":") || NEIGHBOUR_CELL_LABELS.some((pattern) => pattern.test(text));
}

/** What the lines of a page hold besides the runs of the cell being read. */
type PageLines = {
  /** The runs that no label owns, by line. */
  leftoverByLine: ReadonlyMap<number, Run[]>;
  /** Every run, by line. */
  runsByLine: ReadonlyMap<number, Run[]>;
  labelsByLine: ReadonlyMap<number, Label[]>;
  /** The runs a label owns. */
  assigned: ReadonlySet<Run>;
  /**
   * Layout text only, ascending: the lines that follow LAYOUT_MAX_BLANK_LINES blank lines or more, whose distance from
   * the text above them is not known (see farLinesOf).
   */
  farLines: readonly number[];
};

type ValueChoice = {
  lines: ValueLine[];
  /** A line of another cell of the stack came where the value was, or where its wrapped line was: see stackedLineVerdict. */
  stackedLabel: boolean;
  /** Word boxes: a line that would continue the value is far under it down the page (see chooseValueLines). */
  far: boolean;
  /** The first line the value did not take because it was the label of the cell under it; Infinity when there is none. */
  stoppedAt: number;
};

/** These complete label lines positively identify a neighbouring cell; arbitrary label-shaped text does not. */
const NEIGHBOUR_LABEL_LINE = /^(?:HEAT[ -]TREAT(?:MENT)?|(?:SURFACE )?TREATMENT|PAINT|THICKNESS|QTY):?$/i;

/** The text of one line of a cell: the runs that join the leftmost one, in order. */
function lineTextOf(lineRuns: readonly Run[]): string {
  return normalizeWhitespace(joinContiguousRuns([...lineRuns]).map((run) => run.text).join(" "));
}

/** Whether text is shaped like the label of a cell: at most three words of letters only (LABEL_LIKE_RUN). */
function isLabelShaped(text: string): boolean {
  return LABEL_LIKE_RUN.test(text) && text.trim().split(/\s+/).length <= 3;
}

/** How one line of a cell is made, as far as it can be the label of another cell: see shapeOfLine. */
type LineShape = {
  /** The line starts with words that can be a label (LABEL_WORD), with two letters or more between them. */
  labelLead: boolean;
  /** Words follow that lead on the line ("THICKNESS" then ".125", "CLASS" then "2"). */
  rest: boolean;
  /**
   * A word after the line's first word is set apart from the words before it, as a cell's value is from its label: two or
   * more blanks before it (another run of layout text, a cell break between word boxes), or, with word boxes, it is set
   * taller than the first word (a 6 pt label beside its 9 pt value). Whatever the words are made of: "THICKNESS (IN)"
   * then a 9 pt ".125", "LOT #" then "A123", "HEAT-TREAT" then a 9 pt "RC 40-45".
   */
  laterWordApart: boolean;
  /** The column the line starts at. */
  start: number;
};

/**
 * The shape of one line of a cell (the runs that join its leftmost one). This is what tells the label of a cell from a
 * value, without a list of labels and without the size of the value: a label is words of letters (LABEL_WORD), alone on
 * its line or followed by its own value. Where sizes are known they only add evidence (a value set taller beside its
 * label).
 */
function shapeOfLine(lineRuns: readonly Run[]): LineShape {
  const runs = joinContiguousRuns([...lineRuns]);
  const words: Array<{ text: string; breakBefore: boolean; height: number | undefined }> = [];
  for (const [index, run] of runs.entries()) {
    // Layout runs are split at two or more blanks; word boxes mark a gap wider than a phrase's (pdfWords.ts).
    let breakBefore = index > 0 && (!run.fromWords || run.cellBreakBefore === true);
    for (const text of run.text.trim().split(/\s+/)) {
      // A separator printed as a word of its own ("PAINT -", "- PAINT") does not say whether the words around it are a
      // label, so it neither ends a label's lead nor counts as text after it; a gap before it is the next word's. The
      // value it is part of keeps it, and is judged with it (descriptionRejection).
      if (isPunctuationOnly(text) && !LABEL_WORD.test(text)) {
        continue;
      }
      words.push({ text, breakBefore, height: run.height });
      breakBefore = false;
    }
  }
  // The lead is the words of letters the line starts with, up to a gap or a step up in size: what follows a label set
  // apart from it is its value, whatever it is made of ("PAINT   RAL 9005").
  const firstHeight = words[0]?.height;
  const setTaller = (word: { height: number | undefined }) =>
    word.height !== undefined && firstHeight !== undefined && word.height > VALUE_TEXT_TALLER_THAN_LABEL * firstHeight;
  let leadLength = 0;
  while (leadLength < words.length) {
    const word = words[leadLength]!;
    if (!LABEL_WORD.test(word.text) || (leadLength > 0 && (word.breakBefore || setTaller(word)))) {
      break;
    }
    leadLength += 1;
  }
  return {
    labelLead: alphanumericCount(words.slice(0, leadLength).map((word) => word.text).join("")) >= 2,
    rest: leadLength < words.length,
    laterWordApart: words.slice(1).some((word) => word.breakBefore || setTaller(word)),
    start: runs[0]?.start ?? 0,
  };
}

type StackVerdict = "join" | "stop" | "flag";

/**
 * What a line of a material or finish cell is, under `previous`, the value's last line so far. Another cell is often
 * stacked under MATERIAL or FINISH in its columns, with a label the vocabulary does not know ("SURFACE TREATMENT",
 * "PAINT", "THICKNESS" over ".125", "QTY 4"). The cell above owns its text, which must never become part of the value.
 * The shape of the line decides, whatever the vocabulary knows and whatever size the line is set in:
 *  - a line that starts with words of letters (shapeOfLine) may be that cell's label, alone or with its own value
 *    after it. It joins the value only as the value's own wrapped line, which takes all of: the value is printed beside
 *    its label on the label's own line and the line starts where the value starts (`wrapColumn`), a label's width
 *    right of where the cells of the stack start; more words follow the lead, one word space after it (a lone run of
 *    letters may as well be a label); and it is not set smaller or taller than the value. "CLASS 2" under
 *    "FINISH  ANODIZE, BLACK, MIL-A-8625F, TYPE II" is that. Anywhere else the line ends the value (set smaller, below)
 *    or the field is flagged: under a value that is under its label, "CLASS 2" cannot be told from "QTY 4";
 *  - word boxes, a line that starts with words set smaller than the value: those words are the label of that cell (its
 *    value may follow on the line, "PAINT" then "BLACK"). It ends the value when they are shaped like a label (or the
 *    line opens another cell); otherwise they may as well be the rest of the value set small, and there is no value;
 *  - word boxes, a line set taller than the line above it: that line was a label over its own value, so no value;
 *  - a line that opens another cell (a colon, a neighbour-cell word) set as large as the value, or on layout text: it
 *    may be the value's wrapped line ("ANODIZE" over "COLOR BLACK") or that cell's label, which is not known, so no value;
 *  - a line that starts with anything else (a digit, a designator, a word with a comma) joins as a wrapped line would
 *    (chooseValueLines): "MIL-A-8625 TYPE II" under "ANODIZE, BLACK".
 * A single character opens nothing (a zone marker), and never joins a value either.
 */
function stackedLineVerdict(previous: ValueLine, lineRuns: readonly Run[], wrapColumn: number | null): StackVerdict {
  const text = lineTextOf(lineRuns);
  const opens = opensAnotherCell(text);
  if (!opens && alphanumericCount(text) < 2) {
    return "join";
  }
  const above = tallestOf(previous.runs);
  const ordered = [...lineRuns].sort((left, right) => left.start - right.start);
  const firstAsLarge = ordered.findIndex((run) => above === undefined || run.height === undefined || above <= VALUE_TEXT_TALLER_THAN_LABEL * run.height);
  const smallerLead = firstAsLarge < 0 ? ordered : ordered.slice(0, firstAsLarge);
  if (smallerLead.length > 0) {
    return opens || isLabelShaped(lineTextOf(smallerLead)) ? "stop" : "flag";
  }
  const here = tallestOf(lineRuns);
  if (above !== undefined && here !== undefined && here > VALUE_TEXT_TALLER_THAN_LABEL * above) {
    return "flag";
  }
  if (opens) {
    return "flag";
  }
  const shape = shapeOfLine(lineRuns);
  return !shape.labelLead || isWrappedLine(shape, wrapColumn) ? "join" : "flag";
}

/**
 * Whether a line that starts with words of letters is the value's own wrapped line (stackedLineVerdict): it starts at
 * `wrapColumn`, and more words follow its lead one word space later, every one of them at the size of its first word.
 */
function isWrappedLine(shape: LineShape, wrapColumn: number | null): boolean {
  return shape.rest && !shape.laterWordApart && wrapColumn !== null && Math.abs(shape.start - wrapColumn) <= WRAP_ALIGN;
}

/**
 * Whether the first line of a material or finish is another cell's own: it opens one (opensAnotherCell), or a word after
 * its first is set apart from the words before it or taller than its first word (LineShape.laterWordApart), whatever
 * the words are made of: "THICKNESS   .125", a 6 pt "PAINT" by a 9 pt "RAL 9005", a 6 pt "HEAT-TREAT" by a 9 pt
 * "RC 40-45", "# REQD   4". A value is printed in one run at one size; a label beside its own value is not.
 */
function firstLineOpensCell(lineRuns: readonly Run[]): boolean {
  return opensAnotherCell(lineTextOf(lineRuns)) || shapeOfLine(lineRuns).laterWordApart;
}

/**
 * Where the value's first line starts, when it is printed beside its label on the label's own line: a later line that
 * starts there is under the value, a label's width right of where the cells of the stack start, so it is the value
 * wrapped and not the label of a cell stacked under this one. A value under its label has no such column (null): the
 * label of a stacked cell may be indented as the value is.
 */
function wrapColumnOf(stackOf: Label, line: number, runs: readonly Run[]): number | null {
  if (line !== stackOf.line || runs.length === 0) {
    return null;
  }
  const start = Math.min(...runs.map((run) => run.start));
  return start >= stackOf.end - 1 ? start : null;
}

/**
 * The lines that make up a cell's value: the first line the cell owns, and each line after it that continues it
 * (under it, overlapping its columns, within MAX_LINE_GAP lines). With `stackOf` (the label of a material or finish:
 * the cells that have an unlisted cell stacked under them), a first line that opens another cell, or that is a label
 * with its own value set apart beside it ("THICKNESS   .125", a 6 pt "PAINT" by a 9 pt "RAL 9005"), gives no value,
 * and each later line is judged by stackedLineVerdict.
 *
 * Word boxes: a line that would continue the value, within MAX_LINE_GAP lines of it in order but farther than that down
 * the page, is not joined and there is no value (`far`): it may be the rest of the value set far under it or the text of
 * another cell, and which one is not known. The value is not read without it either, which would cut it short.
 */
function chooseValueLines(byLine: ReadonlyMap<number, Run[]>, stackOf: Label | null): ValueChoice {
  const lines = [...byLine.keys()].sort((left, right) => left - right);
  const chosen: ValueLine[] = [];
  const stopped = (line: number): ValueChoice => ({ lines: chosen, stackedLabel: false, far: false, stoppedAt: line });
  const flagged = (): ValueChoice => ({ lines: chosen, stackedLabel: true, far: false, stoppedAt: Number.POSITIVE_INFINITY });
  let wrapColumn: number | null = null;
  for (const line of lines) {
    const lineRuns = byLine.get(line) ?? [];
    const previous = chosen.at(-1);
    if (previous !== undefined && line - previous.line > MAX_LINE_GAP) {
      break;
    }
    if (stackOf !== null && previous === undefined && firstLineOpensCell(lineRuns)) {
      return flagged();
    }
    const verdict = stackOf !== null && previous !== undefined ? stackedLineVerdict(previous, lineRuns, wrapColumn) : "join";
    if (verdict === "stop") {
      return stopped(line);
    }
    if (verdict === "flag") {
      return flagged();
    }
    // A wrapped value continues directly under the line above it ("CLASS 2" under "ANODIZE, BLACK ...").
    // Text that does not overlap the previous line's columns is another cell, and a single character is
    // a sheet-border zone marker ("4" under the FINISH value), so neither joins the value.
    const runs = previous === undefined ? joinContiguousRuns(lineRuns) : continuationRuns(lineRuns, previous.runs);
    const joins = runs.some((run) => alphanumericCount(run.text) >= 2);
    if (previous !== undefined && joins && lineRuns[0]!.y - previous.runs[0]!.y > MAX_LINE_GAP) {
      return { lines: chosen, stackedLabel: false, far: true, stoppedAt: Number.POSITIVE_INFINITY };
    }
    if (previous === undefined || joins) {
      chosen.push({ line, runs });
    }
    if (previous === undefined && stackOf !== null) {
      wrapColumn = wrapColumnOf(stackOf, line, runs);
    }
  }
  return { lines: chosen, stackedLabel: false, far: false, stoppedAt: Number.POSITIVE_INFINITY };
}

/**
 * Whether the first line of a material or finish is the label of a cell stacked where the value would be, with that
 * cell's own value next to it:
 *  - it is only label words (shapeOfLine: "THICKNESS", "THICKNESS (IN)", "LOT #") and the cell holds other text, on that
 *    line or on a line under it (ownsOtherText), or on layout text, text that no cell owns follows it on its line
 *    (hasTrailingLeftover). A single character counts: it never joins a value (chooseValueLines), so "QTY" over "4",
 *    "SHEETS" over "1" or "THICKNESS" over ".5" would otherwise read the label alone. Text under it says so whatever the
 *    sizes are: "ALUMINUM" over "6061-T6" cannot be told from "THICKNESS" over ".125", so there is no value;
 *  - it is only label words and text that no cell owns lies in the cell's rows, right of where the line starts and
 *    before the next cell, at any size (unownedTextInCell): the cell's own value, centred in a wide cell past the
 *    label's reach, or the stacked cell's value set the same way ("QTY" under a centred "AL 6061-T6", or over a
 *    centred "4");
 *  - word boxes, whatever the line is made of: text that no cell owns follows it on its line, set taller than the line's
 *    first word, right after it or before the next cell (a 6 pt "LOT #" by a 9 pt "A123", a 6 pt "THICKNESS (IN)" by a
 *    9 pt ".125", past the cell's reach): tallerUnownedTextFollows. A label beside its value is set smaller than it; a
 *    value is not. On layout text any such text already flags the cell (hasTrailingLeftover).
 * A line of label words alone, with nothing after it, is a value ("AS MACHINED", "CLEAR ANODIZE"): nothing on the sheet
 * tells it from a label with an empty cell (a known limit). The price of the rule is a value of label words with a stray
 * character in its cell (a zone marker under "AS MACHINED"), which is flagged rather than read.
 */
function firstLineIsStackedLabel(label: Label, chosen: readonly ValueLine[], owned: readonly Run[], page: PageLines): boolean {
  const first = chosen[0];
  if (first === undefined) {
    return false;
  }
  const shape = shapeOfLine(first.runs);
  if (
    shape.labelLead &&
    !shape.rest &&
    (ownsOtherText(first, owned) || hasTrailingLeftover(first, page.leftoverByLine, 1) || unownedTextInCell(label, first, owned, page))
  ) {
    return true;
  }
  return tallerUnownedTextFollows(first, page);
}

/**
 * Whether the part number or revision read from a line under its label is the label of a cell stacked where the value
 * would be (#884 review, round 12): the stacked-label test of a material or finish (firstLineIsStackedLabel), for the
 * identifiers. A drawing number or revision centred in a wide cell starts past its label's reach, so no cell owns it, and
 * the label of a cell stacked under it at the cell's left edge (QTY, ITEM, CUSTOMER) is then the only text the cell owns.
 * The line could be a label when it is only label words (shapeOfLine), or, for a part number, when it holds no digit. It
 * is one, and there is no value, when the cell holds other text: text the cell owns besides it (ownsOtherText), text that
 * no cell owns after it on its line on layout text (hasTrailingLeftover), text that no cell owns in the cell's rows, its
 * own row and the label's included (unownedTextInCell: the value centred past the reach, or set along the label's row
 * past the inline window in a row-form table), or, with word boxes, taller text that no cell owns after it on its line
 * (tallerUnownedTextFollows). An identifier on the label's own line is its inline value and is not asked. A lone
 * revision letter is not label words, and "AB" over an otherwise empty cell is still read; the price is an identifier of
 * letters only with other text in its cell, which is flagged.
 */
function identifierIsStackedLabel(label: Label, chosen: readonly ValueLine[], owned: readonly Run[], page: PageLines): boolean {
  const first = chosen[0];
  if (first === undefined || first.line === label.line) {
    return false;
  }
  const shape = shapeOfLine(first.runs);
  const couldBeLabel = (shape.labelLead && !shape.rest) || (label.field === "partNumber" && !/\d/.test(lineTextOf(first.runs)));
  return (
    couldBeLabel &&
    (ownsOtherText(first, owned) ||
      hasTrailingLeftover(first, page.leftoverByLine, 1) ||
      unownedTextInCell(label, first, owned, page, true) ||
      tallerUnownedTextFollows(first, page))
  );
}

/**
 * Whether text that no cell owns lies in the rows of a cell whose value's first line is `first`: on a line between the
 * label's line and `first`, or within MAX_LINE_GAP lines under `first`, starting right of where `first` starts, no more
 * than CENTRED_VALUE_REACH columns past the label's right edge, and before the next cell on its line (the first label
 * other than this one, or the first text another cell owns, after that point). Text starts past its label's reach when
 * it is centred in a wide cell, and then no cell owns it (ownerOf), so the cell may own only the label of a cell stacked
 * under it at its left edge. One character counts (a centred "4"). Unless `withOwnRows`, text on the label's own line or
 * on `first`'s own line is not looked at: for a material or finish, text far along those lines is another cell's
 * (tallerUnownedTextFollows reads the row where sizes tell). An identifier of letters only looks at them too
 * (identifierIsStackedLabel): a row-form table prints a value along its label's row, past the inline window.
 */
function unownedTextInCell(label: Label, first: ValueLine, owned: readonly Run[], page: PageLines, withOwnRows = false): boolean {
  const own = new Set(owned);
  const firstStart = Math.min(...first.runs.map((run) => run.start));
  const farthest = label.end + CENTRED_VALUE_REACH;
  // `first` is at most MAX_DY lines under the label (ownerOf); the bound keeps the loop that short whatever the lines are.
  const last = Math.min(first.line, label.line + MAX_DY) + MAX_LINE_GAP;
  for (let line = withOwnRows ? label.line : label.line + 1; line <= last; line += 1) {
    const leftovers = page.leftoverByLine.get(line);
    if ((!withOwnRows && line === first.line) || leftovers === undefined) {
      continue;
    }
    let nextCell = Number.POSITIVE_INFINITY;
    for (const other of page.labelsByLine.get(line) ?? []) {
      const isThisLabel = other.line === label.line && other.charStart === label.charStart;
      if (other.start > firstStart && !isThisLabel) {
        nextCell = Math.min(nextCell, other.start);
      }
    }
    for (const run of page.runsByLine.get(line) ?? []) {
      if (run.start > firstStart && page.assigned.has(run) && !own.has(run)) {
        nextCell = Math.min(nextCell, run.start);
      }
    }
    if (leftovers.some((run) => run.start > firstStart && run.start <= farthest && run.start < nextCell)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the cell owns text besides the runs of its value's first line, on that line or on a line under it within
 * MAX_LINE_GAP lines (`owned`: the runs above the cell stacked under it, see ValueChoice.stoppedAt). One character counts.
 */
function ownsOtherText(first: ValueLine, owned: readonly Run[]): boolean {
  const own = new Set(first.runs);
  return owned.some((run) => !own.has(run) && run.line >= first.line && run.line - first.line <= MAX_LINE_GAP);
}

/**
 * Word boxes: whether text that no cell owns follows a value's line on the same line, set taller than the line's first
 * word, either right after it (within INLINE_GAP) or with no label and no text a cell owns between them. Layout text
 * has no heights, so it never does.
 */
function tallerUnownedTextFollows(entry: ValueLine, page: PageLines): boolean {
  const initialWord = entry.runs[0];
  if (!initialWord) return false;
  const firstWord = entry.runs.reduce((leftmost, run) => (run.start < leftmost.start ? run : leftmost), initialWord);
  const height = firstWord.height;
  if (height === undefined) {
    return false;
  }
  const end = Math.max(...entry.runs.map((run) => run.end));
  const own = new Set(entry.runs);
  const after = (page.runsByLine.get(entry.line) ?? []).filter((run) => run.start >= end - 1 && !own.has(run));
  // Where the next cell begins: the first label, or the first text a cell owns, after the line.
  let nextCell = Number.POSITIVE_INFINITY;
  for (const label of page.labelsByLine.get(entry.line) ?? []) {
    if (label.start >= end - 1) {
      nextCell = Math.min(nextCell, label.start);
    }
  }
  for (const run of after) {
    if (page.assigned.has(run)) {
      nextCell = Math.min(nextCell, run.start);
    }
  }
  return after.some(
    (run) =>
      !page.assigned.has(run) &&
      run.height !== undefined &&
      run.height > VALUE_TEXT_TALLER_THAN_LABEL * height &&
      (run.start - end <= INLINE_GAP || run.start <= nextCell),
  );
}

/**
 * The runs of a line that continue the value on the line above (`above`): the first run that overlaps its columns,
 * and the runs that follow it. Layout text keeps only the runs that overlap, because a run it prints apart from them
 * may be another cell (and is flagged). Word boxes make every word a run, so the words after the first one that
 * overlaps continue it along the line even where they start past the end of the line above ("MIL-A-8625 TYPE III"
 * under "ANODIZE").
 */
function continuationRuns(lineRuns: readonly Run[], above: readonly Run[]): Run[] {
  const spanStart = Math.min(...above.map((run) => run.start));
  const spanEnd = Math.max(...above.map((run) => run.end));
  const overlaps = (run: Run) => run.start < spanEnd && run.end > spanStart;
  const sorted = [...lineRuns].sort((left, right) => left.start - right.start);
  const first = sorted.findIndex(overlaps);
  if (first < 0) {
    return [];
  }
  return joinContiguousRuns(sorted.slice(first).filter((run) => run.fromWords || overlaps(run)));
}

function readOne(
  label: Label & { field: CellField },
  page: number,
  owned: Run[],
  inlineRuns: ReadonlySet<Run>,
  fenced: boolean,
  pageLines: PageLines,
  doubt: CellDoubt | null,
): CellRead {
  const base = {
    field: label.field,
    page,
    label: label.text.replace(/:$/, ""),
    labelLine: label.line,
    labelStart: label.start,
    labelEnd: label.end,
    complete: false,
  };
  const empty = (status: CellReadStatus, reason: string, valueLines: number[] = []): CellRead => ({
    ...base,
    status,
    value: null,
    reason,
    valueLines,
  });

  // The text on the label's own line is another cell's label, with its own value (under it) or its own
  // colon: the field has no value of its own to read, and nothing is taken from the neighbouring cell.
  if (fenced) {
    return empty("ambiguous", "unlisted_label");
  }
  // A line too long to read lies in the cell (crossesUnreadLine), or, on layout text only, a run just after the value,
  // on its line, belongs to the band of another label: at a fine pitch the words of one value are apart like cells are,
  // so the run may be the rest of this value.
  if (doubt !== null) {
    return empty("ambiguous", doubt);
  }
  const describes = label.field === "material" || label.field === "finish";
  const choice = chooseValueLines(groupByLine(owned), describes ? label : null);
  const chosen = choice.lines;
  const valueLines = chosen.map((entry) => entry.line);
  // The cell under this one is an unlisted cell of its own ("HEAT TREAT" over "RC 40-45" under an empty MATERIAL):
  // its text is not this field's value, and where this cell's own value would have been there is none.
  if (choice.stackedLabel) {
    return empty("ambiguous", "unlisted_label", valueLines);
  }
  if (choice.far) {
    return empty("ambiguous", "far_value", valueLines);
  }
  if (chosen.length === 0) {
    return { ...empty("empty", "no_value"), complete: owned.length === 0 };
  }
  // Layout text: the value is under a run of blank lines as long as poppler prints, so how far it is from its label
  // is not known (LAYOUT_MAX_BLANK_LINES). It may be text far down the sheet in the label's columns.
  if (!label.fromWords && firstAfter(pageLines.farLines, label.line) <= chosen[0]!.line) {
    return empty("ambiguous", "far_value", valueLines);
  }
  // Text under the value that heads the cell below it is that cell's, and does not count against this one.
  const considered = owned.filter((run) => run.line < choice.stoppedAt);
  // Text on the label's own line AND text left aligned under the label: one of them belongs to a cell
  // the vocabulary does not know ("HEAT TREAT RC 40-45" beside MATERIAL), and which one is not known.
  const hasInline = considered.some((run) => inlineRuns.has(run));
  const alignedBelow = considered.some((run) => !inlineRuns.has(run) && run.start <= label.start + ALIGNED_UNDER_LABEL);
  if (hasInline && alignedBelow) {
    return empty("ambiguous", "multiple_values", valueLines);
  }
  if (chosen.length > MAX_VALUE_LINES[label.field]) {
    // An identifier with text on a second line, or a wrapped value that runs past its limit: the cell
    // is not one clean value, so none is taken.
    return empty("ambiguous", "multiple_values", valueLines);
  }
  if (leavesTextUnconsumed(label.field, considered, chosen, pageLines.leftoverByLine)) {
    return empty("ambiguous", "unconsumed_text", valueLines);
  }
  // A first line that is the label of a cell stacked where the value would be, with its own value next to it.
  const stackedLabel = describes
    ? firstLineIsStackedLabel(label, chosen, considered, pageLines)
    : identifierIsStackedLabel(label, chosen, considered, pageLines);
  if (stackedLabel) {
    return empty("ambiguous", "unlisted_label", valueLines);
  }

  const value = normalizeWhitespace(chosen.map((entry) => entry.runs.map((run) => run.text).join(" ")).join(" "));
  const rejection = rejectionFor(label.field, value);
  if (rejection !== null) {
    return empty("rejected", rejection, valueLines);
  }
  const consumed = new Set(chosen.flatMap((entry) => entry.runs));
  const boundary = NEIGHBOUR_LABEL_LINE.test(lineTextOf(owned.filter((run) => run.line === choice.stoppedAt)))
    ? choice.stoppedAt : Infinity;
  return { ...base, status: "value", value, reason: null, valueLines,
    complete: owned.every((run) => consumed.has(run) || run.line >= boundary) };
}

/**
 * Whether the text that follows a label on its own line is the label of another cell rather than the label's
 * value: it holds a colon, or starts with a word that heads another cell (NEIGHBOUR_CELL_LABELS), or it has text
 * of its own continuing underneath it, left aligned with it, that is taller (word boxes: a 6 pt label over a
 * 9 pt value), that starts after a blank line (layout text), or that sits under a short run of letters only
 * (layout text: "LOT CODE" over "RC 40-45").
 * A wrapped value is not that: its second line follows directly and has the same size ("ANODIZE, BLACK, ..."
 * over "CLASS 2"). The field is then empty and flagged, and the label's neighbour keeps its own text.
 */
function hasOwnCellOnItsLine(
  label: Label,
  owned: readonly Run[],
  inlineRuns: ReadonlySet<Run>,
  runsByLine: ReadonlyMap<number, Run[]>,
  caps: ReadonlyMap<Label, number>,
): boolean {
  const inline = owned.filter((run) => inlineRuns.has(run));
  const lead = inline.reduce<Run | null>((first, run) => (first === null || run.start < first.start ? run : first), null);
  if (lead === null) {
    return false;
  }
  // What the label's own line holds after it, in order: in word boxes the words of a phrase are runs of their own.
  const inlineText = inline
    .filter((run) => run.line === lead.line)
    .sort((left, right) => left.start - right.start)
    .map((run) => run.text)
    .join(" ");
  // A colon anywhere in it ("HEAT TREAT: RC 40-45"), or a word that heads another cell of a title block, however
  // it is spelled out: the text is that cell's label and value, not this one's.
  if (opensAnotherCell(inlineText)) {
    return true;
  }
  const limit = Math.min(lead.line + MAX_LINE_GAP, caps.get(label) ?? Number.POSITIVE_INFINITY);
  for (let line = lead.line + 1; line <= limit; line += 1) {
    if ((runsByLine.get(line) ?? []).some((under) => isValueTextUnder(lead, under, line, inlineRuns))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `under`, on a later line, is text of a cell of its own under the inline run `lead`: it starts below the
 * run's own extent (a little left of it is still under it), and it is taller than the run (word boxes: a 6 pt
 * label over a 9 pt value), or follows a blank line, or the run is a short run of letters (layout text, which has
 * no heights). The value of another label on its own row is not text under this run ("MATERIAL ALUMINUM" over
 * "FINISH ANODIZE").
 */
function isValueTextUnder(lead: Run, under: Run, line: number, inlineRuns: ReadonlySet<Run>): boolean {
  if (
    inlineRuns.has(under) ||
    under.start < lead.start - ALIGNED_UNDER_INLINE ||
    under.start >= lead.end ||
    alphanumericCount(under.text) < 2
  ) {
    return false;
  }
  const taller = lead.height !== undefined && under.height !== undefined && under.height > VALUE_TEXT_TALLER_THAN_LABEL * lead.height;
  const layoutOnly = !lead.fromWords && !under.fromWords;
  const afterBlankLine = layoutOnly && line - lead.line >= 2;
  const labelLikeOverText = layoutOnly && isLabelShaped(lead.text);
  return taller || afterBlankLine || labelLikeOverText;
}

/**
 * Layout text only: text just above a label, in its columns, that no label claims in the ordinary way (it has no
 * owner, or starts left of its owner's cell: a wide value of another cell that runs under the label's cell). A
 * coarse pitch prints the lines of a stack out of order, so the value of the cell may stand above its label.
 * The ordinary neighbour is not that: the value of the cell above starts in the columns of its own label. A label
 * that has its value on its own line is not asked: the text above it is a note.
 */
function hasStrayTextAbove(
  label: Label,
  runsByLine: ReadonlyMap<number, Run[]>,
  ownerOfRun: ReadonlyMap<Run, Label>,
  inlineRuns: ReadonlySet<Run>,
): boolean {
  for (let line = label.line - 1; line >= label.line - MAX_LINE_GAP; line -= 1) {
    for (const run of runsByLine.get(line) ?? []) {
      if (run.fromWords || inlineRuns.has(run) || alphanumericCount(run.text) < 2) {
        continue;
      }
      if (run.start < label.start - label.slack || run.start > label.end + label.reach) {
        continue;
      }
      const owner = ownerOfRun.get(run);
      if (owner === undefined || run.start < owner.start - owner.slack) {
        return true;
      }
    }
  }
  return false;
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

/** Which label owns each run of a page, and what is doubtful about it (see readTitleBlockCells). */
type PageOwnership = {
  ownedByLabel: Map<Label, Run[]>;
  ownedOnLine: Map<number, Array<{ run: Run; owner: Label }>>;
  /** Runs that no label owns. */
  unowned: Run[];
  assigned: Set<Run>;
  /**
   * Labels whose cell holds part of a phrase another label's cell (or none) holds the rest of: on layout text, a value
   * followed on its line by a run of another label's band; with word boxes, both sides of a phrase cut (markCutPhrases).
   */
  contested: Set<Label>;
  /** Layout text only: labels that claim one run, by where it starts and by where its centre is (startOwnerOf). */
  straddled: Set<Label>;
  ownerOfRun: Map<Run, Label>;
  /** The runs placed with a label on the same line, and the label each belongs to. */
  inlineRuns: Set<Run>;
  inlineOwners: Map<Run, Label>;
};

function newPageOwnership(): PageOwnership {
  return {
    ownedByLabel: new Map(),
    ownedOnLine: new Map(),
    unowned: [],
    assigned: new Set(),
    contested: new Set(),
    straddled: new Set(),
    ownerOfRun: new Map(),
    inlineRuns: new Set(),
    inlineOwners: new Map(),
  };
}

function assignRun(ownership: PageOwnership, run: Run, owner: Label): void {
  ownership.assigned.add(run);
  ownership.ownerOfRun.set(run, owner);
  const ownerRuns = ownership.ownedByLabel.get(owner);
  if (ownerRuns === undefined) {
    ownership.ownedByLabel.set(owner, [run]);
  } else {
    ownerRuns.push(run);
  }
  const lineOwned = ownership.ownedOnLine.get(run.line);
  if (lineOwned === undefined) {
    ownership.ownedOnLine.set(run.line, [{ run, owner }]);
  } else {
    lineOwned.push({ run, owner });
  }
}

/**
 * Layout text only: marks the labels that claim a run in two ways, the one it starts under and the one its centre
 * is under (startOwnerOf), and the one whose columns it runs on into (reachesIntoLabelOf). Neither is read.
 */
function markStraddledRun(
  ownership: PageOwnership,
  run: Run,
  byCell: Label,
  previousRun: Run | null,
  labels: readonly Label[],
  caps: ReadonlyMap<Label, number>,
): void {
  const startsUnder = startOwnerOf(run, byCell, labels, previousRun);
  if (startsUnder !== null && startsUnder !== byCell) {
    ownership.straddled.add(startsUnder);
    ownership.straddled.add(byCell);
  }
  const reachesInto = reachesIntoLabelOf(run, byCell, labels, caps);
  if (reachesInto !== null) {
    ownership.straddled.add(byCell);
    ownership.straddled.add(reachesInto);
  }
}

/** Whether `run` is printed in one phrase with `previous`, the run before it on its line: no label and no cell's gap between. */
function inOnePhrase(previous: Run, run: Run, lineLabels: readonly Label[]): boolean {
  return (
    run.start - previous.end <= GAP_JOIN &&
    run.cellBreakBefore !== true &&
    !lineLabels.some((label) => label.start >= previous.end - 1 && label.end <= run.start + 1)
  );
}

/**
 * Word boxes: marks the labels whose cells hold a phrase in parts (PageOwnership.contested), once every run has its owner
 * (continueWrappedRuns included). Words are owned one by one, so a phrase that runs on under another label's columns is
 * cut there: a material "... TEMPER T651" whose last word lies under the approvals column Q.A. read as "... TEMPER", and
 * with MATERIAL and FINISH side by side, "ALUMINUM 6061-T6 ALLOY" read as the material "ALUMINUM 6061-T6" and the finish
 * "ALLOY" (#884 review, round 14). Two words of one phrase (inOnePhrase) that are not owned alike, by two labels or by a
 * label and none (a phrase that starts left of its cell), mark every label that owns one of them: which cell the phrase is
 * is not known. Only a material or finish is flagged for it (doubtOf): an identifier has no word space in it. Layout
 * text is marked as it is placed (assignLineRuns).
 */
function markCutPhrases(ownership: PageOwnership, runsByLine: ReadonlyMap<number, Run[]>, labelsByLine: ReadonlyMap<number, Label[]>): void {
  for (const [line, lineRuns] of runsByLine) {
    const words = lineRuns.filter((run) => run.fromWords).sort((left, right) => left.start - right.start);
    const lineLabels = labelsByLine.get(line) ?? [];
    for (let index = 1; index < words.length; index += 1) {
      const previous = words[index - 1]!;
      const run = words[index]!;
      const previousOwner = ownership.ownerOfRun.get(previous);
      const owner = ownership.ownerOfRun.get(run);
      if (previousOwner !== owner && inOnePhrase(previous, run, lineLabels)) {
        for (const label of [previousOwner, owner]) {
          if (label !== undefined) {
            ownership.contested.add(label);
          }
        }
      }
    }
  }
}

/** Places the runs of one line, left to right, with the label that owns each. */
function assignLineRuns(
  ownership: PageOwnership,
  lineRuns: readonly Run[],
  lineLabels: readonly Label[],
  labels: readonly Label[],
  caps: ReadonlyMap<Label, number>,
): void {
  const ordered = [...lineRuns].sort((left, right) => left.start - right.start);
  let previousRun: Run | null = null;
  let previousOwner: Label | null = null;
  for (const run of ordered) {
    const inline = inlineOwnerOf(run, lineLabels, previousRun, ownership.inlineOwners);
    if (inline !== null) {
      ownership.inlineOwners.set(run, inline);
      ownership.inlineRuns.add(run);
    }
    // The first word of a value starts in its label's band; the words after it (word boxes make every
    // word a run) follow it on the line, with no label between.
    const byCell = inline ?? ownerOf(run, labels, caps);
    if (inline === null && byCell !== null && !run.fromWords) {
      markStraddledRun(ownership, run, byCell, previousRun, labels, caps);
    }
    const followsPrevious: boolean = previousRun !== null && previousOwner !== null && inOnePhrase(previousRun, run, lineLabels);
    // Layout text: the run before may be a value, and this run another cell's text set close after it at a coarse pitch, or
    // the rest of the value at a fine one. Word boxes are marked once every run has its owner (markCutPhrases).
    if (followsPrevious && byCell !== null && byCell !== previousOwner && !run.fromWords) {
      ownership.contested.add(previousOwner!);
    }
    const owner: Label | null = byCell ?? (followsPrevious ? previousOwner : null);
    joinSeparators(run, owner, lineLabels, labels, caps, ownership.inlineOwners);
    if (owner === null) {
      ownership.unowned.push(run);
    } else {
      assignRun(ownership, run, owner);
    }
    previousRun = run;
    previousOwner = owner;
  }
}

/**
 * Word boxes: adds to a run's text the separators printed right after it on its line (Run.separatorAfter) where a word
 * in their place would join the run's value, so the value is judged with them ("6061 -" is cut short). They are placed as
 * that word would be (assignLineRuns), and must be owned as the run is and within GAP_JOIN of it (joinContiguousRuns):
 *  - in the run's phrase, with the run's owner (or with none when the run has none), unless they lie in another label's
 *    band, where they are that cell's: a REV cell's "-" set right up against a large drawing number does not make the
 *    number "ABC-001 -";
 *  - set apart from the run by a cell's gap, only where the run's own label owns their place ("6061   -" in the MATERIAL
 *    cell). Layout text does not read a separator set apart, which word boxes place: failing toward review, the value is
 *    then judged with it.
 */
function joinSeparators(
  run: Run,
  owner: Label | null,
  lineLabels: readonly Label[],
  labels: readonly Label[],
  caps: ReadonlyMap<Label, number>,
  inlineOwners: ReadonlyMap<Run, Label>,
): void {
  const separator = run.separatorAfter;
  if (separator === undefined || separator.start - run.end > GAP_JOIN) {
    return;
  }
  const inPhrase = separator.cellBreakBefore !== true;
  const separatorOwner = inlineOwnerOf(separator, lineLabels, run, inlineOwners) ?? ownerOf(separator, labels, caps) ?? (inPhrase ? owner : null);
  if (separatorOwner === owner && (inPhrase || owner !== null)) {
    run.text = `${run.text} ${separator.text}`;
  }
}

/**
 * A run directly under an owned run and overlapping its columns continues that value ("CLASS 2" under
 * "ANODIZE, BLACK, ..."), as long as no other label stands between. Top to bottom, so a wrap of several lines
 * chains. A run far under it on the sheet still joins the cell here; chooseValueLines flags the cell rather than
 * read it (far_value).
 */
function continueWrappedRuns(ownership: PageOwnership, caps: ReadonlyMap<Label, number>): void {
  ownership.unowned.sort((left, right) => left.line - right.line);
  for (const run of ownership.unowned) {
    let continued: Label | null = null;
    for (let line = run.line - 1; line >= run.line - MAX_LINE_GAP && continued === null; line -= 1) {
      for (const { run: above, owner } of ownership.ownedOnLine.get(line) ?? []) {
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
      assignRun(ownership, run, continued);
    }
  }
}

/** The labels and the runs of one page, or null when a cap is passed: a hostile page costs its cap, not its size. */
function readPageGeometry(pageLines: readonly TitleBlockTextLine[]): { labels: Label[]; labelsByLine: Map<number, Label[]>; runs: Run[] } | null {
  const labels: Label[] = [];
  for (const line of pageLines) {
    findLabels(line, labels, MAX_LABELS_PER_PAGE);
    if (labels.length > MAX_LABELS_PER_PAGE) {
      return null;
    }
  }
  const labelsByLine = groupByLine(labels);
  // Header words alone cannot establish that a DESCRIPTION/DATE row is historical.
  // Keep its value as ambiguous evidence; an explicit current cell wins across the document.
  for (const row of labelsByLine.values()) {
    const headers = row.map((label) => label.text.replace(/:$/, ""));
    const firstLine = row[0]!.line;
    const heading = labels.some((label) => /^REVISIONS:?$/i.test(label.text) && label.line < firstLine && !labels.some((between) =>
        between.field === "revision" && between.line > label.line && between.line < firstLine));
    const history = heading || headers.some((text) => /^EC[ONR]$/i.test(text));
    const table = headers.some((text) => /^DESCRIPTION$/i.test(text)) &&
      headers.some((text) => /^(?:DATE|ENGINEER|APPROVED|BY)$/i.test(text));
    let revisionRole: NonNullable<CellRead["revisionRole"]> = "current";
    if (history) revisionRole = "history";
    else if (table) revisionRole = "ambiguous";
    for (const label of row) {
      if (label.field === "revision") label.revisionRole = revisionRole;
    }
  }
  const runs: Run[] = [];
  for (const line of pageLines) {
    findRuns(line, labelsByLine.get(line.lineNumber) ?? [], runs, MAX_RUNS_PER_PAGE);
    if (runs.length > MAX_RUNS_PER_PAGE) {
      return null;
    }
  }
  return { labels, labelsByLine, runs };
}

/**
 * Why a cell's value is doubtful, or null. Mostly layout text: word boxes give true positions (a run that is left over
 * there is another cell's), so only runs read from layout text count for a straddled run, stray text above or a fine
 * pitch. A material or finish whose phrase is cut by another cell (`contested`) is doubtful on either source.
 */
function doubtOf(
  label: Label,
  ownership: PageOwnership,
  runsByLine: ReadonlyMap<number, Run[]>,
  finePitch: boolean,
): CellDoubt | null {
  const ownedRuns = ownership.ownedByLabel.get(label) ?? [];
  const unconsumed =
    ownership.straddled.has(label) ||
    (!ownedRuns.some((run) => ownership.inlineRuns.has(run)) &&
      hasStrayTextAbove(label, runsByLine, ownership.ownerOfRun, ownership.inlineRuns)) ||
    (ownership.contested.has(label) && (label.field === "material" || label.field === "finish"));
  if (unconsumed) {
    return "unconsumed_text";
  }
  if (finePitch && ownedRuns.length > 0 && ownedRuns.every((run) => !run.fromWords)) {
    return "fine_pitch";
  }
  return null;
}

/** The first number of `sorted` (ascending) that is greater than `after`, or Infinity. A binary search. */
function firstAfter(sorted: readonly number[], after: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sorted[middle]! <= after) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return sorted[low] ?? Number.POSITIVE_INFINITY;
}

/**
 * Whether a line too long to read (`unreadLines`, MAX_LINE_LENGTH, ascending) lies where the label's cell could hold text:
 * under the label, up to the next label under it in its columns (its cap) and within MAX_DY lines; or, on layout text,
 * within MAX_LINE_GAP lines above it, where a coarse pitch prints a stack's lines out of order (hasStrayTextAbove).
 * Such a line is not read, but it is still there: it may hold the label of the next cell, which would end this one, or
 * the rest of this cell's value. Its columns are not known, so it counts across the whole line. The cell is not read
 * across it ("MATERIAL" over an unread line that holds "FINISH", over "ANODIZE", is not the material "ANODIZE").
 */
function crossesUnreadLine(label: Label, caps: ReadonlyMap<Label, number>, unreadLines: readonly number[]): boolean {
  if (unreadLines.length === 0) {
    return false;
  }
  const from = label.fromWords ? label.line : label.line - MAX_LINE_GAP - 1;
  const to = Math.min(caps.get(label) ?? Number.POSITIVE_INFINITY, label.line + MAX_DY);
  return firstAfter(unreadLines, from) <= to;
}

/**
 * Layout text only, ascending: the lines of text that follow LAYOUT_MAX_BLANK_LINES blank lines or more. poppler prints
 * no more blank lines than that between two lines of text, so the distance down the sheet from the text above such a
 * line to it is not known. A line built from word boxes is never one: its distance is measured (TitleBlockTextLine.y).
 */
function farLinesOf(candidateLines: readonly TitleBlockTextLine[], unreadLines: readonly number[]): number[] {
  const layout = new Set<number>();
  const text: number[] = [...unreadLines];
  for (const line of candidateLines) {
    if (line.raw.trim().length > 0) {
      text.push(line.lineNumber);
      if (line.words === undefined || line.words.length === 0) {
        layout.add(line.lineNumber);
      }
    }
  }
  text.sort((left, right) => left - right);
  return text.filter((line, index) => index > 0 && layout.has(line) && line - text[index - 1]! - 1 >= LAYOUT_MAX_BLANK_LINES);
}

/**
 * Approval accounts for every word in the cell's column through the next known label (or page end).
 * Candidate reach, font sizes, line gaps and character counts are deliberately not boundaries here.
 * In particular, punctuation omitted by the candidate parser still needs an owner. A separator is
 * consumed only when it was actually included in the value; text owned by a known neighbouring label
 * belongs to that label's cell. This scan uses the original, uncropped geometry.
 */
function accountsForCellGeometry(
  label: Label,
  read: CellRead,
  lines: readonly TitleBlockTextLine[],
  labelsByLine: ReadonlyMap<number, Label[]>,
  ownership: PageOwnership,
  caps: ReadonlyMap<Label, number>,
): boolean {
  if (!label.fromWords) return false;
  const owned = ownership.ownedByLabel.get(label) ?? [];
  // Search reach chooses a candidate, never the cell's right boundary. Without an active known
  // neighbour on the right, the proof must inspect the remainder of the page's row.
  const right = Math.min(...[...labelsByLine.values()].flat().filter((other) =>
    other.start > label.end && other.line <= label.line && (caps.get(other) ?? Infinity) >= label.line)
    .map((other) => other.start));
  const valueRight = Math.max(label.end, ...owned.map((run) => run.end));
  const column = lines[0]?.pointsPerColumn;
  const valueBottom = Math.max(...lines.flatMap((line) => read.valueLines.includes(line.lineNumber)
    ? (line.words ?? []).filter((word) => owned.some((run) => run.line === line.lineNumber &&
      word.x1 > run.start && word.x0 < run.end)).map((word) => word.y1 ?? Infinity) : []));
  const labelWords = lines.find((line) => line.lineNumber === label.line)?.words?.filter((word) =>
    word.from < label.charEnd && word.to > label.charStart) ?? [];
  const labelTop = Math.min(...labelWords.map((word) => word.y0 ?? -Infinity));
  const labelBottom = Math.max(...labelWords.map((word) => word.y1 ?? Infinity));
  // A bottom label may own the nearby text above it. Distant notes or a different column
  // cannot be that value; inspect the proposed value's column and the normal vertical reach.
  const couldBeAboveValue = (word: TitleBlockWord) => word.x1 >= label.start - label.slack &&
    word.x0 < valueRight && word.y1 !== undefined && labelTop - word.y1 <=
      MAX_LINE_GAP * Math.max(labelBottom - labelTop, word.height ?? 0);
  // ES2022 has no findLast; walk backwards without allocating a filtered copy.
  let previous: TitleBlockTextLine | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line.lineNumber < label.line && (line.words ?? []).some(couldBeAboveValue)) {
      previous = line;
      break;
    }
  }
  const top = Math.min(labelTop, ...(previous?.words ?? []).filter((word) =>
    word.x1 >= label.start - label.slack && word.x0 < right).map((word) => word.y0 ?? labelTop));
  const capLine = lines.find((line) => line.lineNumber >= (caps.get(label) ?? Infinity));
  if (column !== undefined) read.geometryRegion = {
    x0: (label.start - label.slack) * column,
    x1: Math.max(valueRight, right) * column,
    y0: top,
    y1: Math.max(valueBottom, Math.min(...(capLine?.words ?? []).map((word) => word.y0 ?? Infinity))),
  };
  if (!read.complete) return false;
  // A rule above OR below a proposed value separates it from its label. A rule below
  // the value can close the cell, but cannot repair an already broken binding.
  if (column !== undefined && lines.some((line) => read.valueLines.includes(line.lineNumber) &&
    (line.words ?? []).some((word) => owned.some((run) => run.line === line.lineNumber &&
      word.x1 > run.start && word.x0 < run.end) && (lines[0]?.borders ?? []).some((border) =>
      border.x0 / column <= Math.min(label.start, word.x0) &&
      border.x1 / column >= Math.max(label.end, word.x1) &&
      ((border.y >= labelBottom && border.y <= (word.y0 ?? -Infinity)) ||
       (border.y <= labelTop && border.y >= (word.y1 ?? Infinity))))))) return false;
  const ruledBorders = column === undefined ? [] : (lines[0]?.borders ?? [])
    .filter((border) => Number.isFinite(valueBottom) && border.y >= valueBottom && border.x0 / column <= label.start && border.x1 / column >= valueRight);
  // Only a known label in this cell's own column closes it. An adjacent label cannot close the
  // left part of a wide cell; its own label and values are accounted for separately below.
  let bottom = caps.get(label) ?? Number.POSITIVE_INFINITY;
  const lastValueLine = Math.max(...read.valueLines);
  for (const [line, runs] of groupByLine(owned)) {
    if (line > lastValueLine && NEIGHBOUR_LABEL_LINE.test(lineTextOf(runs))) bottom = Math.min(bottom, line);
  }

  for (const line of lines) {
    if (line.lineNumber < (previous?.lineNumber ?? label.line) || line.lineNumber >= bottom) {
      continue;
    }
    const lineLabels = labelsByLine.get(line.lineNumber) ?? [];
    for (const word of line.words ?? []) {
      // Cheap row/column filtering precedes every border lookup (dense pages stay bounded).
      if ((word.x0 + word.x1) / 2 < label.start - label.slack || word.x0 >= right ||
        (line.lineNumber < label.line && !couldBeAboveValue(word))) continue;
      if (line.lineNumber < label.line && column !== undefined && (lines[0]?.borders ?? []).some((border) =>
        border.y >= (word.y1 ?? Infinity) && border.y <= labelTop &&
        border.x0 / column <= label.start && border.x1 / column >= word.x1)) continue;
      if (column !== undefined && word.y0 !== undefined && ruledBorders.some((border) =>
        word.y0! >= border.y && word.x0 * column >= border.x0 && word.x1 * column <= border.x1)) continue;
      const coveredByLabel = lineLabels.some((other) => other.charStart <= word.from && other.charEnd >= word.to);
      const coveredByValue = (ownership.ownedOnLine.get(line.lineNumber) ?? []).some(({ run, owner }) => {
        const end = run.separatorAfter !== undefined && run.text.endsWith(run.separatorAfter.text)
          ? run.separatorAfter.end : run.end;
        return run.start <= word.x0 + 0.01 && end >= word.x1 - 0.01 &&
          (owner !== label || read.valueLines.includes(run.line));
      });
      // A label and its inline value can be one PDF word (MATERIAL:ALUMINUM).
      const coveredInline = lineLabels.some((other) => other.charStart <= word.from && other.charEnd > word.from &&
        (ownership.ownedOnLine.get(line.lineNumber) ?? []).some(({ run, owner }) =>
          owner === other && run.end >= word.x1 - 0.01 && run.start <= other.end + 0.01));
      if (!coveredByLabel && !coveredByValue && !coveredInline) {
        return false;
      }
    }
  }
  return true;
}

/** One read per cell label of one page's lines (null when the page is over a cap and is not read). */
function readPage(page: number, pageText: readonly TitleBlockTextLine[]): CellRead[] | null {
  // The caps are checked in the order the work grows, and each loop stops when its own cap is passed. A line over
  // MAX_LINE_LENGTH is not read, but the cells next to it are not read across it either (crossesUnreadLine).
  if (pageText[0]?.borders) pageText = [{ ...pageText[0], borders: mergeHorizontalBorders(pageText[0].borders) }, ...pageText.slice(1)];
  const candidateLines: TitleBlockTextLine[] = [];
  const unreadLines: number[] = [];
  for (const line of pageText) {
    if (line.raw.length <= MAX_LINE_LENGTH) {
      candidateLines.push(line);
    } else {
      unreadLines.push(line.lineNumber);
    }
  }
  if (candidateLines.length > MAX_LINES_PER_PAGE) {
    return null;
  }
  unreadLines.sort((left, right) => left - right);
  const geometry = readPageGeometry(withoutBorderMarkers(candidateLines));
  if (geometry === null) {
    return null;
  }
  const { labels, labelsByLine, runs } = geometry;
  const caps = computeCapLines(labels);
  const ownership = newPageOwnership();
  const runsByLine = groupByLine(runs);
  for (const [lineNumber, lineRuns] of runsByLine) {
    assignLineRuns(ownership, lineRuns, labelsByLine.get(lineNumber) ?? [], labels, caps);
  }
  continueWrappedRuns(ownership, caps);
  markCutPhrases(ownership, runsByLine, labelsByLine);
  const pageLines: PageLines = {
    leftoverByLine: groupByLine(ownership.unowned.filter((run) => !ownership.assigned.has(run))),
    runsByLine,
    labelsByLine,
    assigned: ownership.assigned,
    farLines: farLinesOf(candidateLines, unreadLines),
  };
  const finePitch = labels.some((label) => label.spread);
  const reads: CellRead[] = [];
  for (const label of labels) {
    if (label.field === null) {
      continue;
    }
    const ownedRuns = ownership.ownedByLabel.get(label) ?? [];
    const fenced = hasOwnCellOnItsLine(label, ownedRuns, ownership.inlineRuns, runsByLine, caps);
    const doubt = crossesUnreadLine(label, caps, unreadLines) ? "unread_line" : doubtOf(label, ownership, runsByLine, finePitch);
    const read = readOne({ ...label, field: label.field }, page, ownedRuns, ownership.inlineRuns, fenced, pageLines, doubt);
    if (read.status === "ambiguous" || read.status === "rejected") {
      const describes = label.field === "material" || label.field === "finish";
      const choice = chooseValueLines(groupByLine(ownedRuns), describes ? label : null);
      const considered = ownedRuns.filter((run) => run.line < choice.stoppedAt);
      // Keep every owned identifier, including later rows that made the suggestion ambiguous.
      // A material/finish is one phrase: its wrapped qualifier is not a competing value.
      const observedLines = [...groupByLine(considered)].sort(([left], [right]) => left - right)
        .map(([, runs]) => lineTextOf(runs));
      const values = describes ? [observedLines.join(" ")] : observedLines;
      const unresolved = fenced || choice.stackedLabel || choice.far || ownership.straddled.has(label) ||
        ownership.contested.has(label) || crossesUnreadLine(label, caps, unreadLines);
      read.observations = values.filter(Boolean).map((value) => ({
        value, binding: unresolved ? "unresolved" : "label_owned",
      }));
    }
    if (label.field === "revision") read.revisionRole = label.revisionRole;
    read.complete = accountsForCellGeometry(label, read, candidateLines, labelsByLine, ownership, caps);
    reads.push(read);
  }
  return reads;
}

/**
 * Read pages independently, preserving pages skipped at a parsing cap. Their labels are not known,
 * so they may contain conflicting evidence for any cell field, even when another page reads cleanly.
 */
export function readTitleBlockPages(lines: readonly TitleBlockTextLine[]): { reads: CellRead[]; unreadPages: number[] } {
  const reads: CellRead[] = [];
  const unreadPages: number[] = [];
  for (const [page, pageText] of groupByPage(lines)) {
    const pageReads = readPage(page, pageText);
    if (pageReads === null || pageText.some((line) => line.raw.length > MAX_LINE_LENGTH)) {
      unreadPages.push(page);
    }
    if (pageReads !== null) {
      reads.push(...pageReads);
    }
  }
  return { reads, unreadPages };
}

/** Cell reads only. Use readTitleBlockPages when deciding whether a drawing's fields can be approved. */
export function readTitleBlockCells(lines: readonly TitleBlockTextLine[]): CellRead[] {
  return readTitleBlockPages(lines).reads;
}
