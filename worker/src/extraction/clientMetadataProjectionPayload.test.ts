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
});
