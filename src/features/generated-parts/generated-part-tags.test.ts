import { describe, expect, it } from "vitest";
import { getGeneratedPartInfo } from "./generated-part-tags";

describe("getGeneratedPartInfo", () => {
  it("returns null for uploaded parts", () => {
    expect(getGeneratedPartInfo([])).toBeNull();
    expect(getGeneratedPartInfo(null)).toBeNull();
    expect(getGeneratedPartInfo(["generator:cad-monkey"])).toBeNull();
  });

  it("reads the generator from tags", () => {
    expect(getGeneratedPartInfo(["source:generated", "generator:cad-monkey"])).toEqual({ generator: "cad-monkey" });
    expect(getGeneratedPartInfo(["source:generated"])).toEqual({ generator: null });
  });
});
