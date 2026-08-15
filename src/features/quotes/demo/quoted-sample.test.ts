import { describe, expect, it } from "vitest";
import {
  QUOTED_SAMPLE_LANE_COUNT,
  QUOTED_SAMPLE_LANES,
  QUOTED_SAMPLE_ASSETS,
  QUOTED_SAMPLE_PART,
  QUOTED_SAMPLE_SUPPLIER_COUNT,
  getQuotedSampleSelectedLane,
} from "@/features/quotes/demo/quoted-sample";

describe("quoted sample", () => {
  it("exposes a synthetic sample identity", () => {
    expect(QUOTED_SAMPLE_PART.partNumber).toBe("FX-101");
    expect(QUOTED_SAMPLE_PART.normalizedKey).toBe("fx-101-demo-bracket");
    expect(QUOTED_SAMPLE_PART.revision).toBe("A");
    expect(QUOTED_SAMPLE_PART.description).toBe("SYNTHETIC DEMO BRACKET");
    expect(QUOTED_SAMPLE_ASSETS.cad.fileName).toBe("demo-bracket.step");
    expect(QUOTED_SAMPLE_ASSETS.drawing.fileName).toBe("demo-bracket-drawing.pdf");
    expect(JSON.stringify({ assets: QUOTED_SAMPLE_ASSETS, part: QUOTED_SAMPLE_PART })).not.toContain(
      "1093-05589",
    );
  });

  it("keeps the workbook-backed compare set intact", () => {
    expect(QUOTED_SAMPLE_LANE_COUNT).toBe(16);
    expect(QUOTED_SAMPLE_SUPPLIER_COUNT).toBe(5);
    expect(QUOTED_SAMPLE_LANES).toHaveLength(16);
  });

  it("keeps the default selected lane on Xometry international economy", () => {
    const lane = getQuotedSampleSelectedLane();

    expect(lane.id).toBe("xometry-international-economy");
    expect(lane.totalPriceUsd).toBe(423.7);
    expect(lane.supplier).toBe("Xometry");
  });
});
