// A synthetic B-size title block, written for the tests (OVD-985, OVD-989). It carries no real drawing data:
// every value and every note is a placeholder. What it reproduces is the layout problem of a text layer that
// prints a title block row by row:
//
//  - MATERIAL and FINISH cells stacked in one column, each value several lines below its label, with
//    notes beside and between them;
//  - a SIZE / DWG. NO. / REV label row whose DWG. NO. value sits several lines below it, centred;
//  - an approvals column and a general-tolerance table with ONE to FOUR PLACE DECIMAL rows;
//  - a TITLE cell, a SCALE / SHEET row, a revision table and zone markers along the edges.
//
// Tests build variants through the options; none of them needs a PDF, poppler or a model.
import { layoutSheet, type Piece } from "./titleBlockSheet";

export type DimensionStyle = "two_and_three_places" | "two_places" | "four_places" | "none";

export type TitleBlockTemplateOptions = {
  drawingNumber?: string;
  revision?: string;
  /** null leaves the MATERIAL cell empty. */
  material?: string | null;
  /** null leaves the FINISH cell empty. */
  finish?: string | null;
  title?: string;
  /** The units line of the tolerance block; null prints none. */
  units?: string | null;
  /** The ASME Y14.5 line under INTERPRET IN ACCORDANCE WITH. */
  standard?: string;
  /** Whether the table prints the FOUR PLACE DECIMAL row. */
  fourPlaceRow?: boolean;
  /** Whether the inspection environment notes are printed. */
  inspectionNotes?: boolean;
  /** Which decimal places the dimensions on the views use. */
  dimensions?: DimensionStyle;
  /** Pieces for a line printed directly under the SIZE / DWG. NO. / REV label row (approvals labels). */
  underLabelRow?: Piece[];
  /** Extra lines printed after the proprietary notice, for example an export-control note. */
  notice?: string[];
};

export const TEMPLATE_DEFAULTS = {
  drawingNumber: "ABC-0001",
  revision: "B",
  material: "ALUMINUM 6061-T6",
  finish: "AS MACHINED",
  title: "SAMPLE PLATE",
} as const;

const DIMENSION_ROWS: Record<DimensionStyle, Piece[][]> = {
  two_and_three_places: [
    [[40, ".250"]],
    [[39, ".500 THRU"], [60, "2X"], [65, ".140 THRU"]],
    [[12, "2X"], [15, ".190 THRU"]],
    [[28, ".75"]],
    [[12, ".625"]],
    [[12, "R.25"]],
    [[40, "1.250"], [70, ".95"]],
    [[8, "0"], [30, ".125"], [50, ".375"], [70, "1.65"]],
  ],
  two_places: [[[40, ".25"]], [[39, ".50 THRU"]], [[28, ".75"]], [[12, "R.25"]], [[40, "1.25"], [70, ".95"]]],
  four_places: [
    [[40, ".250"]],
    [[39, ".500 THRU"], [60, "2X"], [65, ".140 THRU"]],
    [[28, ".75"]],
    [[12, ".625"]],
    [[12, "R.25"]],
    [[40, "1.250"], [70, ".95"]],
    [[44, ".0625 THRU"]],
  ],
  none: [],
};

/** The DWG. NO. value is centred in its cell (columns 222 to 266), so a long one starts left of its label. */
function drawingNumberColumn(value: string) {
  return Math.max(219, 235 - Math.ceil(value.length / 2));
}

export function titleBlockTemplateSheet(options: TitleBlockTemplateOptions = {}): string {
  const drawingNumber = options.drawingNumber ?? TEMPLATE_DEFAULTS.drawingNumber;
  const revision = options.revision ?? TEMPLATE_DEFAULTS.revision;
  // A default applies to a missing option only: null is a cell left empty on purpose.
  const { material = TEMPLATE_DEFAULTS.material, finish = TEMPLATE_DEFAULTS.finish, units = "DIMENSIONS ARE IN INCHES" } = options;
  const dimensions = DIMENSION_ROWS[options.dimensions ?? "two_and_three_places"];
  const fourPlaceRow = options.fourPlaceRow ?? true;
  const inspectionNotes = options.inspectionNotes ?? true;

  const row = (...pieces: Piece[]): Piece[] => pieces;
  const rows: Array<readonly Piece[] | ""> = [
    // Top border and the revision table.
    row([7, "8"], [34, "7"], [65, "6"], [93, "5"], [137, "4"], [179, "3"], [221, "2"], [263, "1"]),
    row([249, "REVISIONS"]),
    row([176, "REV."], [204, "DESCRIPTION"], [244, "REV BY"], [262, "DATE"]),
    row([178, "A"], [200, "FIRST ISSUE (SAMPLE)"], [246, "ABC"], [262, "01/01/2026"]),
    row([178, revision], [200, "SECOND ISSUE (SAMPLE)"], [246, "ABC"], [262, "01/02/2026"]),
    row([0, "D"], [274, "D"]),
    "",
    "",
    ...dimensions,
    "",
    row([0, "B"], [274, "B"]),
    "",
    row([2, "SAMPLE COPY"]),
    "",
    "",
    // The title block, from the SURFACE FINISH note down.
    row([83, "SURFACE FINISH: SEE NOTE"]),
    row([105, "AS SPECIFIED"]),
    row([121, "INTERPRET IN ACCORDANCE WITH:"]),
    row([125, options.standard ?? "ASME Y14.5M-2009"]),
    row([153, "UNLESS OTHERWISE SPECIFIED:"]),
    ...(units === null ? [] : [row([153, units])]),
    row([193, "NAME"], [202, "DATE"]),
    row([237, "ORG NAME"]),
    row([230, "ORG ADDRESS"], [246, "ORG PHONE"]),
    row([153, "TOLERANCES:"], [185, "DRAWN"], [197, "ABC"], [204, "01/01/2026"]),
    row([85, "DIMENSIONS APPLY AFTER PLATING"]),
    row([121, "THIRD ANGLE PROJECTION"], [153, "ANGULAR: 0.5"], [217, "TITLE:"]),
    row([229, options.title ?? TEMPLATE_DEFAULTS.title]),
    row([166, "BEND 1.0"], [185, "CHECKED"]),
    ...(inspectionNotes ? [row([85, "ENVIRONMENT NOTES:"])] : []),
    row([153, "ONE PLACE DECIMAL         .05"], [274, "A"]),
    row(...(inspectionNotes ? ([[88, "SAMPLE NOTE ONE"]] as Piece[]) : []), [153, "TWO PLACE DECIMAL         .01"], [185, "ENG APPR."]),
    row(...(inspectionNotes ? ([[92, "SAMPLE NOTE TWO"]] as Piece[]) : []), [153, "THREE PLACE DECIMAL .005"]),
    row(
      ...(inspectionNotes ? ([[95, "23°C ±2°C"]] as Piece[]) : []),
      ...(fourPlaceRow ? ([[153, "FOUR PLACE DECIMAL .0010"]] as Piece[]) : []),
      [185, "MFG APPR."],
    ),
    row(...(inspectionNotes ? ([[93, "45% ±5% RH"]] as Piece[]) : []), [153, "SAMPLE EDGE NOTE"]),
    row([157, "SAMPLE RADIUS NOTE"], [185, "QA APPR."]),
    row([84, "PROPRIETARY AND CONFIDENTIAL"]),
    ...(options.notice ?? []).map((note) => row([84, note])),
    row([119, "MATERIAL"]),
    row([217, "SIZE DWG. NO."], [266, "REV"]),
    ...(options.underLabelRow ? [options.underLabelRow] : []),
    "",
    row([217, "B"], [266, revision]),
    row([84, "SAMPLE NOTICE TEXT, FIRST LINE"]),
    material === null ? "" : row([123, material]),
    row([83, "SAMPLE NOTICE TEXT, SECOND LINE"]),
    row([95, "ORG NAME."]),
    row([120, "FINISH"]),
    row([drawingNumberColumn(drawingNumber), drawingNumber]),
    row([84, "SAMPLE NOTICE TEXT, THIRD LINE"]),
    row([83, "SAMPLE NOTICE TEXT, FOURTH LINE"]),
    finish === null ? "" : row([123, finish]),
    row([92, "SAMPLE NOTICE, LAST LINE."], [217, "SCALE: NONE CAGE CODE: NONE"], [261, "SHEET 1 OF 1"]),
    // Bottom border.
    row([93, "5"], [137, "4"], [179, "3"], [221, "2"]),
    row([279, "1"]),
  ];
  return layoutSheet(...rows);
}

/** The line of a sheet that contains `needle` (1-based), for tests that need a layout line number. */
export function lineNumberOf(sheet: string, needle: string): number {
  const matches = sheet.split("\n").flatMap((line, index) => (line.includes(needle) ? [index + 1] : []));
  if (matches.length !== 1) {
    throw new Error(`exactly one line must contain "${needle}" (found ${matches.length})`);
  }
  return matches[0]!;
}
