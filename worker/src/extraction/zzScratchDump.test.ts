// @vitest-environment node
import { it } from "vitest";
import fs from "node:fs";
import type { JobFileRecord, PartRecord } from "../types";
import { runHybridExtraction } from "./hybridExtraction";
import { extractPdfText } from "./pdfDrawing";
import { buildStoredExtractionPayload } from "./sharedResult";
import { detectExportControlMarkings, scanDrawingTextForExportMarkings } from "../exportControl";

it("dump", async () => {
  const files = (process.env.DUMP_PDFS ?? "").split(",").filter(Boolean);
  for (const f of files) {
    const pdfText = await extractPdfText(f);
    const ex = await runHybridExtraction(
      { part: { id: "p", name: "s" } as PartRecord, cadFile: null, drawingFile: { original_name: "upload.pdf" } as JobFileRecord, pdfText },
      { extractWithModel: async () => { throw new Error("no model"); } },
    );
    const stored = buildStoredExtractionPayload(ex, pdfText?.pageCount ?? 0, "x");
    const out = {
      f, pages: pdfText?.pageCount, ocr: pdfText?.ocr,
      partNumber: ex.partNumber, revision: ex.revision, desc: ex.description,
      material: ex.material.raw, finish: ex.finish.raw, quoteFinish: ex.quoteFinish,
      gen: ex.generalTolerance.raw, tight: ex.tightestTolerance, status: ex.status, reviewFields: ex.reviewFields,
      notes: ex.notes, threads: ex.threads, warnings: ex.warnings,
      export: scanDrawingTextForExportMarkings(pdfText),
      stored: stored.tolerances,
    };
    console.log(JSON.stringify(out, null, 1));
    if (process.env.DUMP_TEXT) console.log(pdfText?.pages.map((p) => p.text).join("\n=====PAGE=====\n"));
  }
}, 120000);
