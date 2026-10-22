// Test support for title-block extraction (OVD-985, OVD-989). No model, no network, no poppler needed:
// it builds and edits `pdftotext -layout` text. Tests that want the real thing run extractPdfText on a
// PDF; tests that want a controlled layout build it here.
import type { PdfTextExtraction } from "../src/extraction/pdfDrawing";

/** Text placed at a 0-based layout column. */
export type Piece = readonly [column: number, text: string];

/** One layout line: every piece at its column. Pieces must be in order and must not overlap. */
export function layoutLine(...pieces: Piece[]): string {
  let line = "";
  for (const [column, text] of pieces) {
    if (column < line.length) {
      throw new Error(`piece "${text}" at column ${column} overlaps the line so far (${line.length} columns)`);
    }
    line = `${line.padEnd(column)}${text}`;
  }
  return line;
}

/** A sheet of layout lines; an empty row is a blank layout line. */
export function layoutSheet(...rows: Array<readonly Piece[] | "">): string {
  return rows.map((row) => (row === "" ? "" : layoutLine(...row))).join("\n");
}

/** The shape extractPdfText returns for a one-page PDF with a real text layer (or, with ocr, OCR text). */
export function pdfTextOf(text: string, options: { ocr?: boolean } = {}): PdfTextExtraction {
  return {
    pageCount: 1,
    pageCountKnown: true,
    drawingFullyRead: true,
    ocr: options.ocr ?? false,
    pages: [{ page: 1, text, ocrText: options.ocr ? text : "", ocrStatus: "ok" }],
  };
}

function occurrences(text: string, needle: string) {
  let count = 0;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) {
    count += 1;
  }
  return count;
}

function splice(text: string, index: number, from: string, to: string): string {
  const tail = text.slice(index + from.length);
  const sameLineTail = tail.split("\n")[0] ?? "";
  const extra = Math.max(0, to.length - from.length);
  if (extra > 0 && sameLineTail.slice(0, extra).trim() !== "") {
    throw new Error(`"${to}" does not fit in place of "${from}"`);
  }
  // A longer value uses the spaces after it (or the end of the line); nothing to its right moves.
  return `${text.slice(0, index)}${to.padEnd(from.length)}${tail.slice(Math.min(extra, sameLineTail.length))}`;
}

/**
 * Replaces the one occurrence of `from` with `to` without moving anything to its right: a shorter value
 * is padded with spaces, a longer one may only use the spaces that follow.
 */
export function replaceInPlace(text: string, from: string, to: string): string {
  if (occurrences(text, from) !== 1) {
    throw new Error(`"${from}" must occur exactly once (found ${occurrences(text, from)})`);
  }
  return splice(text, text.indexOf(from), from, to);
}

/** Like replaceInPlace, for text that occurs more than once: the one at 1-based `lineNumber`, 0-based `column`. */
export function replaceAtColumn(text: string, lineNumber: number, column: number, from: string, to: string): string {
  const lines = text.split("\n");
  const line = lines[lineNumber - 1];
  if (line?.slice(column, column + from.length) !== from) {
    throw new Error(`"${from}" is not at line ${lineNumber}, column ${column}`);
  }
  lines[lineNumber - 1] = splice(line, column, from, to);
  return lines.join("\n");
}

/**
 * Lays the same page out with character cells `factor` times as wide, as another poppler version (or
 * another character-cell estimate) would: every piece of text (a run of words one space apart) moves to
 * its column scaled by `factor`, so pieces that were aligned on different lines stay aligned. Text does
 * not change width, so two pieces never come closer than two spaces.
 */
export function stretchColumns(text: string, factor: number): string {
  return text
    .split("\n")
    .map((line) => {
      let result = "";
      for (const piece of line.matchAll(/\S+(?: \S+)*/g)) {
        const wanted = Math.round((piece.index ?? 0) * factor);
        const column = result.length === 0 ? wanted : Math.max(wanted, result.length + 2);
        result = `${result.padEnd(column)}${piece[0]}`;
      }
      return result;
    })
    .join("\n");
}

/** Removes the one line that contains `needle`. */
export function removeLineContaining(text: string, needle: string): string {
  const lines = text.split("\n");
  const matches = lines.filter((line) => line.includes(needle));
  if (matches.length !== 1) {
    throw new Error(`exactly one line must contain "${needle}" (found ${matches.length})`);
  }
  return lines.filter((line) => !line.includes(needle)).join("\n");
}

/** Inserts `line` after the one line that contains `needle`. */
export function insertLineAfter(text: string, needle: string, line: string): string {
  const lines = text.split("\n");
  const indexes = lines.flatMap((candidate, index) => (candidate.includes(needle) ? [index] : []));
  if (indexes.length !== 1) {
    throw new Error(`exactly one line must contain "${needle}" (found ${indexes.length})`);
  }
  lines.splice(indexes[0]! + 1, 0, line);
  return lines.join("\n");
}
