// @vitest-environment node
//
// Unmocked end to end check of the OCR path. It needs poppler (pdftotext,
// pdftoppm, pdfinfo) and tesseract on PATH. The OCR assertion is skipped only
// when tesseract is absent; the unavailable path is covered in pdfDrawing.test.ts.

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPdfText, type PdfTextExtraction } from "./pdfDrawing";

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

function buildTwoPagePdf(): Buffer {
  const image = renderBitmapText("ITAR CONTROLLED", 12, 60);
  const pageText = "BT /F1 18 Tf 40 250 Td (TITLE BLOCK PAGE ONE) Tj ET";
  const pageImage = `q 520 0 0 ${Math.round((520 * image.height) / image.width)} 40 100 cm /Im1 Do Q`;
  const objects: Array<Buffer | string> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    `<< /Length ${pageText.length} >>\nstream\n${pageText}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Contents 6 0 R /Resources << /XObject << /Im1 8 0 R >> >> >>",
    `<< /Length ${pageImage.length} >>\nstream\n${pageImage}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.pixels.length} >>\nstream\n`,
      ),
      image.pixels,
      Buffer.from("\nendstream"),
    ]),
  ];

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

describe.skipIf(!hasPoppler)("extractPdfText OCR (unmocked)", () => {
  let dir: string;
  let result: PdfTextExtraction | null;

  // One extraction shared by the tests; OCR of two 3000px renders is slow on a loaded runner.
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
