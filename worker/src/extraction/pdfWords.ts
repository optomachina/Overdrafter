/**
 * OVD-989: word boxes for the title block reader.
 *
 * `pdftotext -layout` puts every character in one cell, so text set larger than its neighbours (a 24 pt
 * drawing number beside 9 pt labels) overruns its cells and squeezes the
 * words after it left: "B  ABC-001 A", with the revision value no longer under the REV label. The
 * boxes `pdftotext -bbox` prints give each word's true extent in points, which does not depend on the
 * poppler version or on font sizes. This file parses them and groups them into lines for
 * titleBlockCells.ts. Nothing here reads a value; it only says where each word is.
 */
import type { TitleBlockTextLine, TitleBlockWord } from "./titleBlockCells.js";

/** One word as `pdftotext -bbox` prints it; coordinates are points from the top left of the page. */
export type PdfWord = {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
};

/** A page with more words than this gets no geometry (the layout text is read instead). */
export const MAX_WORDS_PER_PAGE = 20_000;
/** The words of all pages together; geometry is held in memory for the whole task. */
export const MAX_WORDS_TOTAL = 60_000;

/**
 * A column is a fraction of the text height of the page, not a fixed number of points, so a sheet drawn
 * at half the size (or twice) reads the same: the gaps and offsets the reader allows (SLACK, GAP_JOIN, ...
 * in titleBlockCells.ts) are all in columns. 0.4 text heights is 4.4 pt for the 11 pt boxes of the 9 pt text that
 * labels and notes are set in on a B-size sheet, where the reader was calibrated.
 */
export const COLUMN_IN_TEXT_HEIGHTS = 0.4;
/** Used when a page has no word with a usable height. */
export const FALLBACK_POINTS_PER_COLUMN = 4.4;
/** The smallest column: no page has text this small, and a smaller one only makes positions overflow. */
export const MIN_POINTS_PER_COLUMN = 1e-3;

/**
 * Points per column for a page: the median height of its words, times COLUMN_IN_TEXT_HEIGHTS. The median is
 * of the whole page (a title block is a small part of a drawing, so its labels are not the majority), and a
 * page whose boxes are rotated or odd falls back to the B-size value rather than to a size nobody chose.
 */
export function pointsPerColumn(words: readonly PdfWord[]): number {
  const heights = words.map((word) => word.yMax - word.yMin).filter((height) => height > 0 && Number.isFinite(height));
  if (heights.length === 0) {
    return FALLBACK_POINTS_PER_COLUMN;
  }
  heights.sort((left, right) => left - right);
  // A floor: a page of words a denormal number of points tall would otherwise give a zero column, and
  // every position divided by it would be infinite.
  return Math.max(COLUMN_IN_TEXT_HEIGHTS * heights[Math.floor(heights.length / 2)]!, MIN_POINTS_PER_COLUMN);
}

// A gap wider than this many text heights separates two cells' text; narrower is the space inside a phrase.
const CELL_GAP_IN_HEIGHTS = 0.6;
// Words whose vertical centres differ by less than this share of the smaller height are on one line.
const SAME_LINE_SHARE = 0.4;

const WORD_PATTERN = /<word xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)">([^<]*)<\/word>/g;
const ENTITY_PATTERN = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string) {
  return text.replace(ENTITY_PATTERN, (_match, entity: string) => {
    if (entity.startsWith("#")) {
      const codePoint = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? "";
  });
}

/** Parses the output of `pdftotext -bbox` for one page. Returns no words when the page has too many. */
export function parseBboxWords(markup: string): PdfWord[] {
  // poppler prints the document structure after the last word. Markup cut off before it (a killed process,
  // a full pipe) may end in the middle of a page, so none of it is trusted.
  if (!/<\/html>\s*$/i.test(markup.slice(-64))) {
    return [];
  }
  const words: PdfWord[] = [];
  for (const match of markup.matchAll(WORD_PATTERN)) {
    if (words.length >= MAX_WORDS_PER_PAGE) {
      return [];
    }
    const [xMin, yMin, xMax, yMax] = [match[1], match[2], match[3], match[4]].map(Number);
    const text = decodeEntities(match[5] ?? "").trim();
    if (text === "" || ![xMin, yMin, xMax, yMax].every((value) => Number.isFinite(value)) || xMax < xMin || yMax < yMin) {
      continue;
    }
    words.push({ text, xMin: xMin!, yMin: yMin!, xMax: xMax!, yMax: yMax! });
  }
  return words;
}

type Cluster = { words: PdfWord[]; centre: number; height: number };

/**
 * Groups a page's words into lines, top to bottom, and each line's words left to right. The text of a
 * line separates words by one space, or by two where the gap is wider than a phrase's, which is what the
 * label rules in titleBlockCells.ts read as "a label can start here".
 */
export function buildWordLines(words: readonly PdfWord[], page: number): TitleBlockTextLine[] {
  const column = pointsPerColumn(words);
  const ordered = [...words].sort((left, right) => left.yMin + left.yMax - (right.yMin + right.yMax) || left.xMin - right.xMin);
  const clusters: Cluster[] = [];
  for (const word of ordered) {
    const centre = (word.yMin + word.yMax) / 2;
    const height = Math.max(word.yMax - word.yMin, 1);
    const current = clusters.at(-1);
    if (current !== undefined && Math.abs(centre - current.centre) <= SAME_LINE_SHARE * Math.min(height, current.height)) {
      const count = current.words.length;
      current.centre = (current.centre * count + centre) / (count + 1);
      current.height = Math.min(current.height, height);
      current.words.push(word);
    } else {
      clusters.push({ words: [word], centre, height });
    }
  }

  return clusters.map((cluster, index): TitleBlockTextLine => {
    const lineWords = [...cluster.words].sort((left, right) => left.xMin - right.xMin);
    let raw = "";
    const placed: TitleBlockWord[] = [];
    lineWords.forEach((word, position) => {
      if (position > 0) {
        // The gap is compared with the heights of the two words it separates, not with the smallest word
        // on the line: one small character on the line (a zone letter) would make every space a cell break.
        const before = lineWords[position - 1]!;
        const gap = word.xMin - before.xMax;
        const textHeight = Math.max(Math.min(word.yMax - word.yMin, before.yMax - before.yMin), 1);
        raw += gap > CELL_GAP_IN_HEIGHTS * textHeight ? "  " : " ";
      }
      placed.push({
        from: raw.length,
        to: raw.length + word.text.length,
        x0: word.xMin / column,
        x1: word.xMax / column,
        height: word.yMax - word.yMin,
      });
      raw += word.text;
    });
    return { page, lineNumber: index + 1, raw, words: placed, pointsPerColumn: column };
  });
}
