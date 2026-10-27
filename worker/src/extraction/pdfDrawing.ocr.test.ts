// @vitest-environment node
//
// Unmocked end to end check of the OCR path. It needs poppler (pdftotext,
// pdftoppm, pdfinfo) and tesseract on PATH. The OCR assertion is skipped only
// when tesseract is absent. The CI unit job installs both, so it runs there.

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractPdfText,
  PDF_OCR_MIN_DPI,
  PDF_OCR_TOTAL_TIMEOUT_MS,
  renderPdfPageForOcr,
  type PdfTextExtraction,
} from "./pdfDrawing";

function hasBinary(name: string, args: string[]): boolean {
  try {
    execFileSync(name, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasPoppler = hasBinary("pdfinfo", ["-v"]) && hasBinary("pdftoppm", ["-v"]) && hasBinary("pdftotext", ["-v"]);
const hasTesseract = hasBinary("tesseract", ["--version"]);

const GLYPHS: Record<string, string[]> = {
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

/** Black on white 8 bit grayscale bitmap of the text, scaled up from a 5x7 font. */
function renderBitmapText(text: string, scale: number, margin: number) {
  const advance = 6;
  const width = text.length * advance * scale + margin * 2;
  const height = 7 * scale + margin * 2;
  const pixels = Buffer.alloc(width * height, 255);
  [...text].forEach((char, charIndex) => {
    GLYPHS[char].forEach((row, y) => {
      [...row].forEach((bit, x) => {
        if (bit !== "1") return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = margin + (charIndex * advance + x) * scale + dx;
            const py = margin + y * scale + dy;
            pixels[py * width + px] = 0;
          }
        }
      });
    });
  });
  return { width, height, pixels: boxBlur(pixels, width, height, Math.ceil(scale / 2)) };
}

/** Softens the stair stepped edges so tesseract sees stroke shapes, not blocks. */
function boxBlur(source: Buffer, width: number, height: number, radius: number): Buffer {
  const horizontal = Buffer.alloc(source.length);
  const out = Buffer.alloc(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(width - 1, x + radius); k += 1) {
        sum += source[y * width + k];
        count += 1;
      }
      horizontal[y * width + x] = Math.round(sum / count);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, y - radius); k <= Math.min(height - 1, y + radius); k += 1) {
        sum += horizontal[k * width + x];
        count += 1;
      }
      out[y * width + x] = Math.round(sum / count);
    }
  }
  return out;
}

function imageObject(image: { width: number; height: number; pixels: Buffer }): Buffer {
  return Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.pixels.length} >>\nstream\n`,
    ),
    image.pixels,
    Buffer.from("\nendstream"),
  ]);
}

function assemblePdf(objects: Array<Buffer | string>): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let position = chunks[0].length;
  objects.forEach((body, index) => {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      typeof body === "string" ? Buffer.from(body) : body,
      Buffer.from("\nendobj\n"),
    ]);
    offsets.push(position);
    chunks.push(chunk);
    position += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

function buildTwoPagePdf(): Buffer {
  const image = renderBitmapText("ITAR CONTROLLED", 12, 60);
  const pageText = "BT /F1 18 Tf 40 250 Td (TITLE BLOCK PAGE ONE) Tj ET";
  const pageImage = `q 520 0 0 ${Math.round((520 * image.height) / image.width)} 40 100 cm /Im1 Do Q`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    `<< /Length ${pageText.length} >>\nstream\n${pageText}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Contents 6 0 R /Resources << /XObject << /Im1 8 0 R >> >> >>",
    `<< /Length ${pageImage.length} >>\nstream\n${pageImage}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    imageObject(image),
  ]);
}

/**
 * One page whose MediaBox (6000 x 6000 pt, about 278 MP at 200 DPI) is far
 * over the pixel cap while its CropBox (600 x 300 pt) is small. The stamp
 * sits inside the CropBox.
 */
const CROP_BOX = { x: 1000, y: 1000, width: 600, height: 300 };
function buildHugeMediaBoxPdf(): Buffer {
  const image = renderBitmapText("ITAR CONTROLLED", 12, 60);
  const imageHeight = Math.round((520 * image.height) / image.width);
  const pageImage = `q 520 0 0 ${imageHeight} ${CROP_BOX.x + 40} ${CROP_BOX.y + 100} cm /Im1 Do Q`;
  const cropBox = `[${CROP_BOX.x} ${CROP_BOX.y} ${CROP_BOX.x + CROP_BOX.width} ${CROP_BOX.y + CROP_BOX.height}]`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 6000 6000] /CropBox ${cropBox} /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>`,
    `<< /Length ${pageImage.length} >>\nstream\n${pageImage}\nendstream`,
    imageObject(image),
  ]);
}

async function readPngSize(pngPath: string): Promise<{ width: number; height: number }> {
  const header = await fs.readFile(pngPath);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

describe.skipIf(!hasPoppler)("extractPdfText OCR (unmocked)", () => {
  let dir: string;
  let result: PdfTextExtraction | null;

  // One extraction shared by the tests: two 600 x 300 pt pages rendered at the
  // 200 DPI floor and OCR'd, which can take a while on a loaded runner.
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-ocr-test-"));
    const pdfPath = path.join(dir, "two-page.pdf");
    await fs.writeFile(pdfPath, buildTwoPagePdf());
    result = await extractPdfText(pdfPath);
  }, 120_000);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps the page 1 text layer and leaves the raster page 2 out of the text layer", async () => {
    expect(result?.pageCount).toBe(2);
    expect(result?.pages[0].text).toContain("TITLE BLOCK PAGE ONE");
    expect(result?.pages[1].text.trim()).toBe("");
    expect(result?.pages.map((page) => page.ocrStatus)).toEqual(
      hasTesseract ? ["ok", "ok"] : ["unavailable", "unavailable"],
    );
  });

  it.skipIf(!hasTesseract)("reads the raster ITAR CONTROLLED stamp on page 2 via OCR", async () => {
    expect(result?.pages[1].ocrText.replace(/\s+/g, " ")).toMatch(/ITAR CONTROLLED/i);
    expect(result?.pages[0].ocrText).toMatch(/TITLE BLOCK PAGE ONE/i);
  });
});

describe.skipIf(!hasPoppler)("OCR render of a page whose MediaBox is much larger than its CropBox", () => {
  let dir: string;
  let pdfPath: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-ocr-cropbox-test-"));
    pdfPath = path.join(dir, "huge-mediabox.pdf");
    await fs.writeFile(pdfPath, buildHugeMediaBoxPdf());
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("renders only the CropBox, the box the pixel cap was checked against", async () => {
    const outputPath = path.join(dir, "page-1.png");

    await expect(renderPdfPageForOcr(pdfPath, outputPath, 1, Date.now() + PDF_OCR_TOTAL_TIMEOUT_MS)).resolves.toBe(
      "ok",
    );

    expect(await readPngSize(outputPath)).toEqual({
      width: Math.ceil((CROP_BOX.width * PDF_OCR_MIN_DPI) / 72),
      height: Math.ceil((CROP_BOX.height * PDF_OCR_MIN_DPI) / 72),
    });
  }, 60_000);

  it.skipIf(!hasTesseract)(
    "reads the stamp inside the CropBox and reports the drawing fully read",
    async () => {
      const result = await extractPdfText(pdfPath);

      expect(result?.pages.map((page) => page.ocrStatus)).toEqual(["ok"]);
      expect(result?.pages[0].ocrText.replace(/\s+/g, " ")).toMatch(/ITAR CONTROLLED/i);
      expect(result?.drawingFullyRead).toBe(true);
    },
    120_000,
  );
});
