import { describe, expect, it } from "vitest";
import { classifyFormerAssetResponse } from "./verify-removed-public-assets.mjs";

const missingControl = {
  status: 200,
  contentType: "text/html",
  hash: "safe-html-hash",
};

describe("deployed validation-asset removal proof", () => {
  it("accepts an explicit missing response", () => {
    expect(
      classifyFormerAssetResponse(
        { status: 410, contentType: "text/plain", hash: "safe-missing-hash" },
        missingControl,
      ),
    ).toEqual(expect.objectContaining({ ok: true }));
  });

  it("accepts only an exact match for the host SPA fallback", () => {
    expect(classifyFormerAssetResponse(missingControl, missingControl)).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(
      classifyFormerAssetResponse(
        { status: 200, contentType: "text/html", hash: "different-html" },
        missingControl,
      ),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  it("rejects the known exposed bytes regardless of response metadata", () => {
    expect(
      classifyFormerAssetResponse(
        {
          status: 404,
          contentType: "text/html",
          hash: "4111602b512ea575c010184f904675c92b8977028088c372033a7754d1e9f043",
        },
        missingControl,
      ),
    ).toEqual(expect.objectContaining({ ok: false }));
  });
});
