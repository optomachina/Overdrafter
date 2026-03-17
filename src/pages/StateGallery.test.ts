import { describe, expect, it } from "vitest";
import { buildEmbeddedPreviewHref } from "./state-gallery-preview";

describe("buildEmbeddedPreviewHref", () => {
  it("adds embed mode while preserving existing debug-enabled direct links", () => {
    expect(buildEmbeddedPreviewHref("/projects/fx-project-quoted?fixture=client-quoted&debug=1")).toBe(
      "/projects/fx-project-quoted?fixture=client-quoted&debug=1&embed=1",
    );
  });

  it("adds both embed and debug flags when the direct link is not already debug-enabled", () => {
    expect(buildEmbeddedPreviewHref("/?fixture=client-empty")).toBe("/?fixture=client-empty&embed=1&debug=1");
  });
});
