import { describe, expect, it } from "vitest";
import {
  QUOTED_SAMPLE_LANE_COUNT,
  QUOTED_SAMPLE_LANES,
  QUOTED_SAMPLE_PART,
  QUOTED_SAMPLE_SUPPLIER_COUNT,
  getQuotedSampleSelectedLane,
} from "@/features/quotes/demo/quoted-sample";

describe("quoted sample", () => {
  it("exposes the expected sample identity", () => {
    expect(QUOTED_SAMPLE_PART.partNumber).toBe("1093-05589");
    expect(QUOTED_SAMPLE_PART.revision).toBe("2");
    expect(QUOTED_SAMPLE_PART.description).toBe("BONDED, CARBON FIBER END ATTACHMENT");
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
