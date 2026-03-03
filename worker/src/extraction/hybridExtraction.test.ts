// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { JobFileRecord, PartRecord } from "../types";
import { runHybridExtraction } from "./hybridExtraction";

function makePart(overrides: Partial<PartRecord> = {}): PartRecord {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "fallback-bracket",
    normalized_key: "fallback-bracket",
    cad_file_id: null,
    drawing_file_id: null,
    quantity: 2,
    ...overrides,
  };
}

function makeFile(overrides: Partial<JobFileRecord> = {}): JobFileRecord {
  return {
    id: "file-1",
    job_id: "job-1",
    storage_bucket: "job-files",
    storage_path: "job-1/file.step",
    original_name: "optic-bracket.step",
    file_kind: "cad",
    ...overrides,
  };
}

describe("runHybridExtraction", () => {
  it("derives fallback extraction details from the available CAD filename", async () => {
    const result = await runHybridExtraction({
      part: makePart(),
      cadFile: makeFile({
        original_name: "optic-bracket_lower.step",
      }),
      drawingFile: null,
    });

    expect(result).toEqual({
      partId: "part-1",
      description: "Optic Bracket Lower",
      partNumber: "OPTIC-BRACKET_LOWER",
      revision: null,
      material: {
        raw: null,
        normalized: null,
        confidence: 0.15,
      },
      finish: {
        raw: null,
        normalized: null,
        confidence: 0.1,
      },
      tightestTolerance: {
        raw: null,
        valueInch: null,
        confidence: 0.1,
      },
      evidence: [
        {
          field: "description",
          page: 1,
          snippet: "Optic Bracket Lower",
          confidence: 0.75,
        },
      ],
      warnings: [
        "No PDF drawing was attached. Material, finish, and tolerance values require review.",
      ],
      status: "needs_review",
    });
  });

  it("prefers the drawing filename when present and raises confidence scores", async () => {
    const result = await runHybridExtraction({
      part: makePart(),
      cadFile: makeFile(),
      drawingFile: makeFile({
        id: "file-2",
        original_name: "client-widget_rev-a.pdf",
        file_kind: "drawing",
      }),
    });

    expect(result.description).toBe("Client Widget Rev A");
    expect(result.partNumber).toBe("CLIENT-WIDGET_REV-A");
    expect(result.material.confidence).toBe(0.35);
    expect(result.finish.confidence).toBe(0.25);
    expect(result.tightestTolerance.confidence).toBe(0.25);
    expect(result.warnings).toEqual([]);
  });
});
