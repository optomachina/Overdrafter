import { describe, expect, it } from "vitest";
import {
  buildAutoProjectName,
  findUnpairedUploadFiles,
  groupUploadFiles,
  isCadUploadFile,
  normalizeUploadStem,
} from "./upload-groups";
import stemFixtures from "./upload-stem-fixtures.json";

function makeFile(name: string, type = "application/octet-stream") {
  return new File(["test"], name, { type });
}

describe("upload-groups", () => {
  it("normalizes stems and detects CAD files", () => {
    expect(normalizeUploadStem("Part001.STEP")).toBe("part001");
    expect(normalizeUploadStem("assy.final.revA.PDF")).toBe("assy-final-reva");
    expect(isCadUploadFile("part.sldprt")).toBe(true);
    expect(isCadUploadFile("drawing.pdf")).toBe(false);
  });

  it.each(stemFixtures.cases)("matches public.normalize_file_basename: $name", ({ input, expected }) => {
    expect(normalizeUploadStem(input)).toBe(expected);
  });

  it("is idempotent on its own output, which is what the server stores in normalized_name", () => {
    for (const { input } of stemFixtures.cases) {
      const once = normalizeUploadStem(input);
      expect(normalizeUploadStem(once)).toBe(once);
    }
  });

  it("pairs a part and drawings whose names differ only by spacing, case and punctuation", () => {
    const groups = groupUploadFiles([
      makeFile("My Part_01.step"),
      makeFile("my-part.01.PDF", "application/pdf"),
      makeFile("My Part_01.pdf", "application/pdf"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.normalizedStem).toBe("my-part-01");
    expect(groups[0]?.files.map((file) => file.name)).toEqual([
      "My Part_01.step",
      "my-part.01.PDF",
      "My Part_01.pdf",
    ]);
    expect(groups[0]?.hasCad).toBe(true);
    expect(groups[0]?.hasDrawing).toBe(true);
  });

  it("keeps a drawing with an extra revision word apart from its part", () => {
    const groups = groupUploadFiles([makeFile("PN.step"), makeFile("PN Rev 02.pdf", "application/pdf")]);

    expect(groups.map((group) => group.normalizedStem)).toEqual(["pn", "pn-rev-02"]);
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

describe("findUnpairedUploadFiles", () => {
  const pdf = (name: string) => makeFile(name, "application/pdf");
  const none = { drawingsWithoutPart: [], partsWithoutDrawing: [] };

  it("reports nothing for a paired set, even when the names differ in punctuation", () => {
    expect(findUnpairedUploadFiles([makeFile("My Part_01.step"), pdf("my-part-01.PDF")])).toEqual(none);
  });

  it("reports a PDF that has no matching part", () => {
    expect(findUnpairedUploadFiles([makeFile("PN.step"), pdf("PN.pdf"), pdf("Bracket Rev 02.pdf")])).toEqual({
      drawingsWithoutPart: ["Bracket Rev 02.pdf"],
      partsWithoutDrawing: [],
    });
  });

  it("reports a part that has no matching drawing when other drawings are selected", () => {
    expect(findUnpairedUploadFiles([makeFile("PN.step"), pdf("PN Rev 02.pdf")])).toEqual({
      drawingsWithoutPart: ["PN Rev 02.pdf"],
      partsWithoutDrawing: ["PN.step"],
    });
  });

  it("does not flag parts when no drawing was selected at all", () => {
    expect(findUnpairedUploadFiles([makeFile("a.step"), makeFile("b.sldprt")])).toEqual(none);
  });

  it("ignores images that are neither a part nor a drawing", () => {
    expect(findUnpairedUploadFiles([makeFile("photo.png", "image/png"), pdf("a.pdf"), makeFile("a.step")])).toEqual(none);
  });

  it("reports an empty selection as paired", () => {
    expect(findUnpairedUploadFiles([])).toEqual(none);
  });
});
