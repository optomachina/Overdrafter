/**
 * OVD-989: word boxes for the title block reader.
 *
 * `pdftotext -layout` puts every character in one cell, so text set larger than its neighbours (the 24 pt
 * drawing number of a common SolidWorks template, beside 9 pt labels) overruns its cells and squeezes the
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

/** Points per layout column: 1224 pt across 279 columns on a B-size sheet, so word extents compare with layout columns. */
export const POINTS_PER_COLUMN = 4.4;

// A gap wider than this many text heights separates two cells' text; narrower is the space inside a phrase.
const CELL_GAP_IN_HEIGHTS = 0.6;
// Words whose vertical centres differ by less than this share of the smaller height are on one line.
const SAME_LINE_SHARE = 0.4;

const WORD_PATTERN = /<word xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)">([^<]*)<\/word>/g;
const ENTITY_PATTERN = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi;
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
  const words: PdfWord[] = [];
  for (const match of markup.matchAll(WORD_PATTERN)) {
    if (words.length >= MAX_WORDS_PER_PAGE) {
      return [];
    }
    const [xMin, yMin, xMax, yMax] = [match[1], match[2], match[3], match[4]].map((value) => Number(value));
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
  const ordered = [...words].sort((left, right) => left.yMin + left.yMax - (right.yMin + right.yMax) || left.xMin - right.xMin);
  const clusters: Cluster[] = [];
  for (const word of ordered) {
    const centre = (word.yMin + word.yMax) / 2;
    const height = Math.max(word.yMax - word.yMin, 1);
    const current = clusters[clusters.length - 1];
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
        const gap = word.xMin - lineWords[position - 1]!.xMax;
        raw += gap > CELL_GAP_IN_HEIGHTS * cluster.height ? "  " : " ";
      }
      placed.push({
        from: raw.length,
        to: raw.length + word.text.length,
        x0: word.xMin / POINTS_PER_COLUMN,
        x1: word.xMax / POINTS_PER_COLUMN,
      });
      raw += word.text;
    });
    return { page, lineNumber: index + 1, raw, words: placed };
  });
}
