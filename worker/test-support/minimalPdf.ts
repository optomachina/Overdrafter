// Test support: a one-page PDF with Helvetica text at given positions, written by hand (no library). For tests
// that need poppler's own layout and word boxes of a controlled sheet, not a model of them (OVD-985, OVD-989).
// The sheets are synthetic: the callers write placeholder text only.

/** Text at `x` points from the left and `y` points from the TOP of the page, set at `size` points. */
export type PdfTextItem = { x: number; y: number; size: number; text: string };

export type MinimalPdfOptions = {
  /** Real vector rules, for testing the cell-boundary proof through Poppler. */
  rules?: Array<{ x0: number; y0: number; x1: number; y1: number; gray?: number }>;
  /** Opaque white paint after rules, to exercise erased-border evidence. */
  erase?: Array<{ x: number; y: number; width: number; height: number }>;
  /** The size of the page as it is shown, in points. */
  width?: number;
  height?: number;
  /**
   * 90 stores the page upright (MediaBox height by width) with /Rotate 90 and text drawn along the page's
   * height, which is how a landscape sheet is often stored. The positions of the items are still the
   * displayed ones. poppler then prints the page with the size of the stored page and the coordinates of the
   * displayed one: the words run past the width its markup gives.
   */
  rotate?: 0 | 90;
};

function escapeText(text: string): string {
  return text.replaceAll("\\", String.raw`\\`).replaceAll("(", String.raw`\(`).replaceAll(")", String.raw`\)`);
}

/** The bytes of the PDF. Text is WinAnsi (Latin-1 for the characters used here: the diameter and plus-minus signs). */
export function minimalPdf(items: readonly PdfTextItem[], options: MinimalPdfOptions = {}): Buffer {
  const width = options.width ?? 1224;
  const height = options.height ?? 792;
  const rotated = options.rotate === 90;
  const operators = items.map((item) =>
    rotated
      ? `BT /F1 ${item.size} Tf 0 1 -1 0 ${item.y + item.size} ${item.x} Tm (${escapeText(item.text)}) Tj ET`
      : `BT /F1 ${item.size} Tf ${item.x} ${height - item.y - item.size} Td (${escapeText(item.text)}) Tj ET`,
  );
  const rules = (options.rules ?? []).map(({ x0, y0, x1, y1, gray = 0 }) =>
    `${gray} G 0.5 w ${x0} ${height - y0} m ${x1} ${height - y1} l S`);
  const erase = (options.erase ?? []).map((rect) =>
    `q 1 g ${rect.x} ${height - rect.y - rect.height} ${rect.width} ${rect.height} re f Q`);
  const stream = Buffer.from([...rules, ...erase, ...operators].join("\n"), "latin1");
  const rotate = rotated ? " /Rotate 90" : "";
  const mediaBox = rotated ? `[0 0 ${height} ${width}]` : `[0 0 ${width} ${height}]`;
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox}${rotate} /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    ),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
  ];

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    parts.push(object);
    length += object.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)];
  parts.push(
    Buffer.from(`${xref.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`),
  );
  return Buffer.concat(parts);
}

/**
 * A field of `count` three-digit dimensions set in `size` points, nine to a row. The size of the text of a
 * page sets the column of the word-box reader (a fraction of the median text height), so a sheet of mostly
 * large dimensions has wider columns than the same title block on a sheet of small ones.
 */
export function dimensionField(size: number, count = 90): PdfTextItem[] {
  return Array.from({ length: count }, (_, index) => ({
    x: 60 + (index % 9) * 45,
    y: 90 + Math.floor(index / 9) * (size + 14),
    size,
    text: `.${100 + ((index * 7) % 900)}`,
  }));
}

export type SyntheticSheetOptions = {
  /** null leaves the MATERIAL cell empty. */
  material?: string | null;
  finish?: string | null;
  drawingNumber?: string;
  revision?: string;
  /** Extra text: views, notes, stray text. */
  extra?: PdfTextItem[];
  /** Scales every position and size, as a sheet drawn at another size. */
  scale?: number;
};

const VIEWS: PdfTextItem[] = [
  { x: 60, y: 60, size: 9, text: "NOTES:" },
  { x: 60, y: 72, size: 9, text: "1. SYNTHETIC SAMPLE DRAWING." },
  { x: 300, y: 150, size: 9, text: ".18" },
  { x: 120, y: 200, size: 9, text: "2X Ø.070 THRU" },
  { x: 260, y: 190, size: 9, text: "Ø.656 THRU" },
  { x: 380, y: 200, size: 9, text: "2X Ø.089 THRU" },
  { x: 80, y: 260, size: 9, text: ".75" },
  { x: 80, y: 280, size: 9, text: ".625" },
  { x: 80, y: 300, size: 9, text: ".375" },
  { x: 80, y: 320, size: 9, text: ".125" },
  { x: 420, y: 300, size: 9, text: "R.50" },
  { x: 300, y: 420, size: 9, text: "1.653" },
];

/**
 * A B-size sheet: views with two- and three-place dimensions, a general-tolerance table with two-, three- and
 * four-place rows at the bottom right, and a title block with the MATERIAL and FINISH cells at the left and the
 * DWG. NO. and REV cells (24 pt values under 6 pt labels) at the right. Placeholder values only.
 */
export function syntheticSheet(options: SyntheticSheetOptions = {}): PdfTextItem[] {
  // A default applies to a missing option only: null is a cell left empty on purpose.
  const { material = "AL 6061-T6", finish = "AS MACHINED" } = options;
  const items: PdfTextItem[] = [
    ...VIEWS,
    { x: 500, y: 640, size: 7, text: "UNLESS OTHERWISE SPECIFIED:" },
    { x: 500, y: 650, size: 7, text: "DIMENSIONS ARE IN INCHES" },
    { x: 500, y: 660, size: 7, text: "TOLERANCES:" },
    { x: 500, y: 670, size: 7, text: "ANGULAR: 0.5" },
    { x: 500, y: 680, size: 7, text: "TWO PLACE DECIMAL    ±.01" },
    { x: 500, y: 690, size: 7, text: "THREE PLACE DECIMAL  ±.005" },
    { x: 500, y: 700, size: 7, text: "FOUR PLACE DECIMAL   ±.0010" },
    { x: 600, y: 640, size: 7, text: "NAME" },
    { x: 640, y: 640, size: 7, text: "DATE" },
    { x: 560, y: 655, size: 7, text: "DRAWN" },
    { x: 560, y: 668, size: 7, text: "CHECKED" },
    { x: 560, y: 681, size: 7, text: "ENG APPR." },
    { x: 560, y: 694, size: 7, text: "MFG APPR." },
    { x: 560, y: 707, size: 7, text: "Q.A." },
    { x: 700, y: 650, size: 7, text: "TITLE:" },
    { x: 760, y: 665, size: 14, text: "SAMPLE BRACKET" },
    { x: 330, y: 720, size: 6, text: "MATERIAL" },
    { x: 330, y: 750, size: 6, text: "FINISH" },
    { x: 700, y: 720, size: 6, text: "SIZE" },
    { x: 725, y: 720, size: 6, text: "DWG. NO." },
    { x: 900, y: 720, size: 6, text: "REV" },
    { x: 705, y: 735, size: 24, text: "B" },
    { x: 900, y: 735, size: 24, text: options.revision ?? "B" },
    { x: 760, y: 735, size: 24, text: options.drawingNumber ?? "ABC-1001" },
    { x: 700, y: 768, size: 7, text: "SCALE: 1:1" },
    { x: 880, y: 768, size: 7, text: "SHEET 1 OF 1" },
    ...(material === null ? [] : [{ x: 340, y: 732, size: 9, text: material }]),
    ...(finish === null ? [] : [{ x: 340, y: 760, size: 9, text: finish }]),
    ...(options.extra ?? []),
  ];
  const scale = options.scale ?? 1;
  return scale === 1 ? items : items.map((item) => ({ x: item.x * scale, y: item.y * scale, size: item.size * scale, text: item.text }));
}
