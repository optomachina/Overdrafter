// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveRequirementProcess } from "./partContext";

describe("resolveRequirementProcess", () => {
  it("returns the trimmed process from the approved requirement snapshot", () => {
    expect(resolveRequirementProcess({ process: "  CNC Machining  " })).toBe(
      "CNC Machining",
    );
  });

  it("returns null when the approved requirement snapshot has no usable process", () => {
    expect(resolveRequirementProcess(null)).toBeNull();
    expect(resolveRequirementProcess({ process: "  " })).toBeNull();
    expect(resolveRequirementProcess({ process: 42 })).toBeNull();
  });
});
