import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fixture from "../../../src/features/quotes/client-part-metadata-projection.fixture.json";
import type { DrawingExtractionPayload } from "../types";
import { buildStoredExtractionPayload } from "./sharedResult";

// OVD-978: worker side of the client part metadata projection guard. The client-side
// assertions live in src/features/quotes/client-part-metadata-projection.test.tsx, which
// cannot import worker modules (server/design-graph/import-boundary.ts).

type FixturePart = (typeof fixture.parts)[number];

const partByKey = (key: string): FixturePart => {
  const part = fixture.parts.find((candidate) => candidate.key === key);
  if (!part) throw new Error(`fixture part ${key} missing`);
  return part;
};

describe("worker extraction payload (OVD-978)", () => {
  it("never stores missingFields or warnings inside the extraction payload", () => {
    for (const part of fixture.parts.filter((candidate) => candidate.extraction)) {
      const { workerInput, pageCount, workerBuildVersion } = part.extraction!;
      const stored = buildStoredExtractionPayload(
        workerInput as unknown as DrawingExtractionPayload,
        pageCount,
        workerBuildVersion,
      );

      expect(stored).not.toHaveProperty("missingFields");
      expect(stored).not.toHaveProperty("warnings");
      expect(stored.pageCount).toBe(pageCount);
    }
  });

  it("writes material and finish as objects even when nothing was found", () => {
    const { workerInput, pageCount, workerBuildVersion } = partByKey("noDrawing").extraction!;
    const stored = buildStoredExtractionPayload(
      workerInput as unknown as DrawingExtractionPayload,
      pageCount,
      workerBuildVersion,
    );

    expect(stored.material).toMatchObject({ raw: null, normalized: null });
    expect(stored.finish).toMatchObject({ raw: null, normalized: null });
  });

  // The pgTAP file claims to carry the real worker output. OVD-976 added tolerances.unit and
  // tolerances.drawingUnits and the literals silently stopped being exact, so this fails the
  // moment the builder and the file disagree. It reads the promoted test once the migration
  // window renames the pending file.
  it("keeps the pgTAP payload literals equal to the real builder output", () => {
    const candidates = [
      "../../../supabase/tests/ovd978_client_part_metadata_projection.sql",
      "../../../supabase/tests/pending/ovd978_client_part_metadata_projection.sql.pending",
    ].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
    const path = candidates.find((candidate) => existsSync(candidate));
    if (!path) throw new Error("OVD-978 pgTAP file not found (pending or promoted)");
    const pgtap = readFileSync(path, "utf8");

    for (const key of ["partial", "complete", "noDrawing"]) {
      const literal = new RegExp(`\\$${key}_payload\\$([\\s\\S]*?)\\$${key}_payload\\$`).exec(pgtap);
      if (!literal) throw new Error(`pgTAP payload literal ${key} not found`);
      const { workerInput, pageCount, workerBuildVersion } = partByKey(key).extraction!;
      const stored = buildStoredExtractionPayload(
        workerInput as unknown as DrawingExtractionPayload,
        pageCount,
        workerBuildVersion,
      );

      expect(JSON.parse(literal[1]), `${key} literal in ${path}`).toEqual(JSON.parse(JSON.stringify(stored)));
    }
  });
});
