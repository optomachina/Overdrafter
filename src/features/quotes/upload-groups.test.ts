import { describe, expect, it } from "vitest";
import {
  buildAutoProjectName,
  findUnpairedUploadFiles,
  groupUploadFiles,
  isCadUploadFile,
  isDrawingUploadFile,
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

  describe("a group holds at most one CAD file and only files that can pair", () => {
    const groupNames = (files: File[]) => groupUploadFiles(files).map((group) => group.files.map((file) => file.name));

    it("keeps two different Cyrillic parts that share a number in separate groups", () => {
      const groups = groupUploadFiles([makeFile("Деталь 1.step"), makeFile("Корпус 1.step")]);

      expect(groups).toHaveLength(2);
      expect(groups.every((group) => group.files.length === 1 && group.hasCad)).toBe(true);
      expect(new Set(groups.map((group) => group.key)).size).toBe(2);
    });

    it("keeps parts that differ only by accents in separate groups", () => {
      expect(groupNames([makeFile("café.step"), makeFile("cafè.step")]).sort()).toEqual([["cafè.step"], ["café.step"]].sort());
    });

    it("puts three CAD files with the same stem in three groups with distinct keys", () => {
      const groups = groupUploadFiles([makeFile("Bracket 1.step"), makeFile("bracket_1.stp"), makeFile("BRACKET-1.iges")]);

      expect(groups).toHaveLength(3);
      expect(groups.map((group) => group.files.length)).toEqual([1, 1, 1]);
      expect(new Set(groups.map((group) => group.key)).size).toBe(3);
      expect(groups.every((group) => group.normalizedStem === "bracket-1")).toBe(true);
    });

    it("pairs a drawing with the first staged CAD file of that stem, whatever the drawing order", () => {
      const cadFirst = groupUploadFiles([makeFile("a-1.step"), makeFile("A 1.stp"), makeFile("a_1.pdf", "application/pdf")]);
      const drawingFirst = groupUploadFiles([makeFile("a_1.pdf", "application/pdf"), makeFile("a-1.step"), makeFile("A 1.stp")]);
      const drawingBetween = groupUploadFiles([makeFile("a-1.step"), makeFile("a_1.pdf", "application/pdf"), makeFile("A 1.stp")]);

      for (const groups of [cadFirst, drawingFirst, drawingBetween]) {
        const paired = groups.find((group) => group.hasDrawing);
        expect(paired?.files.map((file) => file.name)).toEqual(
          expect.arrayContaining(["a-1.step", "a_1.pdf"]),
        );
        expect(paired?.files).toHaveLength(2);
        expect(groups.filter((group) => group.hasCad)).toHaveLength(2);
        expect(groups.flatMap((group) => group.files)).toHaveLength(3);
      }
    });

    it("never puts two CAD files in one group, so the server keeps every part", () => {
      const groups = groupUploadFiles([
        makeFile("p.step"),
        makeFile("P.stp"),
        makeFile("p.pdf", "application/pdf"),
        makeFile("p.prt"),
        makeFile("P.PDF", "application/pdf"),
      ]);

      expect(groups).toHaveLength(3);
      for (const group of groups) {
        expect(group.files.filter((file) => isCadUploadFile(file.name)).length).toBeLessThanOrEqual(1);
      }
    });

    it("gives a file with an empty stem its own group and never pairs it by the empty stem", () => {
      const groups = groupUploadFiles([
        makeFile("日本語.step"),
        makeFile("日本語.pdf", "application/pdf"),
        makeFile("---.step"),
      ]);

      expect(groups).toHaveLength(3);
      expect(groups.every((group) => group.files.length === 1)).toBe(true);
      expect(new Set(groups.map((group) => group.key)).size).toBe(3);
      expect(groups.every((group) => group.normalizedStem === "")).toBe(true);
    });

    it("keeps different empty-stem CAD files apart and derives the key from the lower-cased trimmed name", () => {
      const groups = groupUploadFiles([makeFile("部品.step"), makeFile("  部品.STEP"), makeFile("部品.step")]);

      expect(groups).toHaveLength(3);
      expect(groups.every((group) => group.hasCad && group.files.length === 1)).toBe(true);
      expect(new Set(groups.map((group) => group.key)).size).toBe(3);
      expect(groups[0]?.key).toContain("部品.step");
    });

    it("does not let an empty-stem file join a group whose stem is a real word", () => {
      expect(groupNames([makeFile("a.step"), makeFile("日本.pdf", "application/pdf")]).sort()).toEqual([
        ["a.step"],
        ["日本.pdf"],
      ]);
    });

    it("still groups an image with the CAD file of the same stem", () => {
      const groups = groupUploadFiles([makeFile("a.step"), makeFile("a.png", "image/png")]);

      expect(groups).toHaveLength(1);
      expect(groups[0]?.files).toHaveLength(2);
    });
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

describe("isDrawingUploadFile", () => {
  it("matches .pdf in any case and nothing else", () => {
    expect(isDrawingUploadFile("a.pdf")).toBe(true);
    expect(isDrawingUploadFile("A.PDF")).toBe(true);
    expect(isDrawingUploadFile("a.Pdf")).toBe(true);
    expect(isDrawingUploadFile("a.png")).toBe(false);
    expect(isDrawingUploadFile("a.pdf.step")).toBe(false);
  });
});

describe("findUnpairedUploadFiles", () => {
  const pdf = (name: string) => makeFile(name, "application/pdf");
  const none = { drawingsWithoutPart: [], partsWithoutDrawing: [], partsSharingPairedName: [] };

  it("reports nothing for a paired set, even when the names differ in punctuation", () => {
    expect(findUnpairedUploadFiles([makeFile("My Part_01.step"), pdf("my-part-01.PDF")])).toEqual(none);
  });

  it("reports a PDF that has no matching part", () => {
    expect(findUnpairedUploadFiles([makeFile("PN.step"), pdf("PN.pdf"), pdf("Bracket Rev 02.pdf")])).toEqual({
      ...none,
      drawingsWithoutPart: ["Bracket Rev 02.pdf"],
    });
  });

  it("reports a part that has no matching drawing when other drawings are selected", () => {
    expect(findUnpairedUploadFiles([makeFile("PN.step"), pdf("PN Rev 02.pdf")])).toEqual({
      ...none,
      drawingsWithoutPart: ["PN Rev 02.pdf"],
      partsWithoutDrawing: ["PN.step"],
    });
  });

  it("reports only the parts when every staged drawing is paired but another part has no drawing", () => {
    expect(
      findUnpairedUploadFiles([makeFile("a.step"), pdf("a.pdf"), makeFile("b.step"), makeFile("c.sldprt")]),
    ).toEqual({ ...none, partsWithoutDrawing: ["b.step", "c.sldprt"] });
  });

  it("does not flag parts when no drawing was selected at all", () => {
    expect(findUnpairedUploadFiles([makeFile("a.step"), makeFile("b.sldprt")])).toEqual(none);
  });

  it("lists an upper-case .PDF drawing that has no part", () => {
    expect(findUnpairedUploadFiles([makeFile("a.step"), pdf("A.step.PDF"), pdf("Other.PDF")])).toEqual({
      ...none,
      drawingsWithoutPart: ["A.step.PDF", "Other.PDF"],
      partsWithoutDrawing: ["a.step"],
    });
  });

  it("ignores images that are neither a part nor a drawing", () => {
    expect(findUnpairedUploadFiles([makeFile("photo.png", "image/png"), pdf("a.pdf"), makeFile("a.step")])).toEqual(none);
  });

  it("does not list a non-matching file that sits beside an unpaired drawing", () => {
    expect(findUnpairedUploadFiles([makeFile("photo.png", "image/png"), pdf("lonely.pdf")])).toEqual({
      ...none,
      drawingsWithoutPart: ["lonely.pdf"],
    });
  });

  it("does not list an image that shares its stem with an unpaired drawing or an unpaired part", () => {
    expect(
      findUnpairedUploadFiles([makeFile("lonely.png", "image/png"), pdf("lonely.pdf"), makeFile("b.step"), makeFile("b.jpg", "image/jpeg")]),
    ).toEqual({ ...none, drawingsWithoutPart: ["lonely.pdf"], partsWithoutDrawing: ["b.step"] });
  });

  it("reports an empty selection as paired", () => {
    expect(findUnpairedUploadFiles([])).toEqual(none);
  });

  describe("names the server cannot pair", () => {
    it("lists a drawing and a part whose names reduce to an empty stem as unpaired", () => {
      expect(findUnpairedUploadFiles([makeFile("日本語.step"), pdf("日本語.pdf")])).toEqual({
        ...none,
        drawingsWithoutPart: ["日本語.pdf"],
        partsWithoutDrawing: ["日本語.step"],
      });
    });

    it("pairs a drawing with the first same-stem part and reports the other parts as sharing its name", () => {
      expect(
        findUnpairedUploadFiles([makeFile("a-1.step"), makeFile("A 1.stp"), pdf("a_1.pdf"), makeFile("a.1.iges")]),
      ).toEqual({ ...none, partsSharingPairedName: ["A 1.stp", "a.1.iges"] });
    });

    it("does not call same-stem parts name-sharing when no drawing carries that stem", () => {
      expect(findUnpairedUploadFiles([makeFile("a-1.step"), makeFile("A 1.stp"), pdf("other.pdf")])).toEqual({
        ...none,
        drawingsWithoutPart: ["other.pdf"],
        partsWithoutDrawing: ["A 1.stp", "a-1.step"],
      });
    });

    it("keeps the two Cyrillic parts separate and unpaired next to a drawing of another name", () => {
      expect(findUnpairedUploadFiles([makeFile("Деталь 1.step"), makeFile("Корпус 1.step"), pdf("x.pdf")])).toEqual({
        ...none,
        drawingsWithoutPart: ["x.pdf"],
        partsWithoutDrawing: ["Деталь 1.step", "Корпус 1.step"],
      });
    });
  });
});
