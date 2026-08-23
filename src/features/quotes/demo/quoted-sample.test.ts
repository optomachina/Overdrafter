import { describe, expect, it } from "vitest";
import {
  QUOTED_SAMPLE_LANE_COUNT,
  QUOTED_SAMPLE_LANES,
  QUOTED_SAMPLE_ASSETS,
  QUOTED_SAMPLE_PART,
  QUOTED_SAMPLE_RFQ,
  QUOTED_SAMPLE_SOURCE,
  QUOTED_SAMPLE_SUPPLIER_COUNT,
  getQuotedSampleSelectedLane,
} from "@/features/quotes/demo/quoted-sample";

describe("quoted sample", () => {
  it("exposes a synthetic sample identity", () => {
    expect(QUOTED_SAMPLE_PART.partNumber).toBe("FX-101");
    expect(QUOTED_SAMPLE_PART.normalizedKey).toBe("quoted-sample");
    expect(QUOTED_SAMPLE_PART.revision).toBe("A");
    expect(QUOTED_SAMPLE_PART.description).toBe("SYNTHETIC DEMO BRACKET");
    expect(QUOTED_SAMPLE_ASSETS.cad.fileName).toBe("quoted-sample.step");
    expect(QUOTED_SAMPLE_ASSETS.drawing.fileName).toBe("quoted-sample-drawing.pdf");
    expect(QUOTED_SAMPLE_ASSETS.cad.fixturePath).toBe(
      "/__overdrafter_private_fixtures/quoted-sample.step",
    );
    expect(QUOTED_SAMPLE_ASSETS.cad.normalizedName).toBe(QUOTED_SAMPLE_PART.normalizedKey);
    expect(QUOTED_SAMPLE_ASSETS.drawing.normalizedName).toBe(QUOTED_SAMPLE_PART.normalizedKey);

    const serializedSample = JSON.stringify({
      assets: QUOTED_SAMPLE_ASSETS,
      lanes: QUOTED_SAMPLE_LANES,
      part: QUOTED_SAMPLE_PART,
      rfq: QUOTED_SAMPLE_RFQ,
      source: QUOTED_SAMPLE_SOURCE,
    });
    expect(serializedSample).not.toContain("1093-05589");
    expect(serializedSample).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(serializedSample).not.toMatch(/\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/);
  });

  it("keeps the workbook-backed compare set intact", () => {
    expect(QUOTED_SAMPLE_LANE_COUNT).toBe(16);
    expect(QUOTED_SAMPLE_SUPPLIER_COUNT).toBe(5);
    expect(QUOTED_SAMPLE_LANES).toHaveLength(16);

    const quotePrefixByVendor = new Map([
      ["fictiv", "DEMO-FIC"],
      ["protolabs", "DEMO-PRO"],
      ["xometry", "DEMO-XOM"],
    ]);
    for (const lane of QUOTED_SAMPLE_LANES) {
      if (!lane.quoteRef) {
        continue;
      }
      const expectedPrefix = quotePrefixByVendor.get(lane.vendor);
      expect(expectedPrefix).toBeDefined();
      expect(lane.quoteRef).toMatch(new RegExp(`^${expectedPrefix}-\\d{3}$`));
    }
  });

  it("keeps the default selected lane on Xometry international economy", () => {
    const lane = getQuotedSampleSelectedLane();

    expect(lane.id).toBe("xometry-international-economy");
    expect(lane.totalPriceUsd).toBe(423.7);
    expect(lane.supplier).toBe("Xometry");
  });
});
