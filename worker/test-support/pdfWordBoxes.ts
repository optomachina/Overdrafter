// Test support for the word-box geometry of the title block reader (OVD-989). Builds the words that
// `pdftotext -bbox` would print for text set at a given size, and the markup around them, with no PDF.
import type { PdfWord } from "../src/extraction/pdfWords";

const CHARACTER_WIDTH_IN_SIZES = 0.55;

/** A word whose left edge is at `x` and whose top is at `y` (points), set at `size` points. */
export function box(text: string, x: number, y: number, size = 9): PdfWord {
  return { text, xMin: x, yMin: y, xMax: x + text.length * size * CHARACTER_WIDTH_IN_SIZES, yMax: y + size };
}

/** The words of a phrase set on one line, left to right from `x`, with a space of `gap` points between them. */
export function phrase(text: string, x: number, y: number, size = 9, gap = 3): PdfWord[] {
  const words: PdfWord[] = [];
  let cursor = x;
  for (const word of text.split(" ")) {
    const placed = box(word, cursor, y, size);
    words.push(placed);
    cursor = placed.xMax + gap;
  }
  return words;
}

function escapeMarkup(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The page markup `pdftotext -bbox` prints around its words. */
export function bboxMarkup(words: readonly PdfWord[], size: { width: number; height: number } = { width: 1224, height: 792 }) {
  const lines = words.map(
    (word) =>
      `    <word xMin="${word.xMin.toFixed(6)}" yMin="${word.yMin.toFixed(6)}" xMax="${word.xMax.toFixed(6)}" yMax="${word.yMax.toFixed(6)}">${escapeMarkup(word.text)}</word>`,
  );
  return [
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml">',
    "<head>",
    "<title>sample</title>",
    "</head>",
    "<body>",
    "<doc>",
    `  <page width="${size.width.toFixed(6)}" height="${size.height.toFixed(6)}">`,
    ...lines,
    "  </page>",
    "</doc>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
