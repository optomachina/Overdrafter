import { describe, expect, it } from "vitest";
import { buildAutoProjectName, groupUploadFiles, isCadUploadFile, normalizeUploadStem } from "./upload-groups";

function makeFile(name: string, type = "application/octet-stream") {
  return new File(["test"], name, { type });
}

describe("upload-groups", () => {
  it("normalizes stems and detects CAD files", () => {
    expect(normalizeUploadStem("Part001.STEP")).toBe("part001");
    expect(normalizeUploadStem("assy.final.revA.PDF")).toBe("assy.final.reva");
    expect(isCadUploadFile("part.sldprt")).toBe(true);
    expect(isCadUploadFile("drawing.pdf")).toBe(false);
  });

  it("groups matching CAD and PDF files by basename", () => {
    const groups = groupUploadFiles([
      makeFile("part001.STP"),
      makeFile("part001.pdf", "application/pdf"),
      makeFile("part002.iges"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.normalizedStem).toBe("part001");
    expect(groups[0]?.files.map((file) => file.name)).toEqual(["part001.STP", "part001.pdf"]);
    expect(groups[0]?.hasCad).toBe(true);
    expect(groups[0]?.hasDrawing).toBe(true);
    expect(groups[1]?.normalizedStem).toBe("part002");
    expect(groups[1]?.files.map((file) => file.name)).toEqual(["part002.iges"]);
  });

  it("creates standalone groups for orphan PDFs", () => {
    const groups = groupUploadFiles([
      makeFile("drawing-only.pdf", "application/pdf"),
      makeFile("cad-only.step"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.normalizedStem).toBe("cad-only");
    expect(groups[1]?.normalizedStem).toBe("drawing-only");
    expect(groups[1]?.files.map((file) => file.name)).toEqual(["drawing-only.pdf"]);
    expect(groups[1]?.hasCad).toBe(false);
    expect(groups[1]?.hasDrawing).toBe(true);
  });

  it("builds a fallback auto-project name from grouped stems", () => {
    const groups = groupUploadFiles([
      makeFile("widget-a.step"),
      makeFile("widget-b.step"),
      makeFile("widget-c.pdf", "application/pdf"),
    ]);

    expect(buildAutoProjectName("", groups)).toBe("widget-a + 2 parts");
  });
});
