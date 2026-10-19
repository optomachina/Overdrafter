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
    expect(groups[0]?.files.map((file) => file.name)).toEqual([
      "My Part_01.step",
      "My Part_01.pdf",
      "my-part.01.PDF",
    ]);
    expect(groups[0]?.hasCad).toBe(true);
    expect(groups[0]?.hasDrawing).toBe(true);
  });

  it("keeps a drawing with an extra revision word apart from its part", () => {
    const groups = groupUploadFiles([makeFile("PN.step"), makeFile("PN Rev 02.pdf", "application/pdf")]);

    expect(groups.map((group) => group.files.map((file) => file.name))).toEqual([["PN.step"], ["PN Rev 02.pdf"]]);
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

  describe("grouping by original stem, then pairing a CAD-less drawing by the server stem", () => {
    const groupNames = (files: File[]) => groupUploadFiles(files).map((group) => group.files.map((file) => file.name));
    /** Groups and their files in a canonical order, for cases where only membership matters. */
    const sets = (files: File[]) =>
      groupNames(files)
        .map((names) => [...names].sort())
        .sort((left, right) => (left.join("|") < right.join("|") ? -1 : 1));
    const pdf = (name: string) => makeFile(name, "application/pdf");
    const stage =(names: string[]) => names.map((name) => (name.toLowerCase().endsWith(".pdf") ? pdf(name) : makeFile(name)));

    describe("a drawing whose name differs only by spacing, case or punctuation joins the part", () => {
      it.each([
        ["spaces and underscores", ["My Part 01.step", "My Part_01.pdf"]],
        ["hyphen and space", ["bracket-v2.step", "bracket v2.pdf"]],
        ["brackets", ["Part (Rev B).step", "Part Rev B.pdf"]],
        ["accented letter dropped", ["Café.step", "Caf.pdf"]],
        ["dotted capital I", ["İstanbul.step", "istanbul.pdf"]],
      ])("%s", (_label, names) => {
        const groups = groupUploadFiles(stage(names));

        expect(groups).toHaveLength(1);
        expect(groups[0]?.files.map((file) => file.name)).toEqual(names);
        expect(groups[0]?.hasCad).toBe(true);
        expect(groups[0]?.hasDrawing).toBe(true);
      });

      it("pairs a drawing staged before the part", () => {
        expect(groupNames(stage(["a_1.pdf", "a-1.step"]))).toEqual([["a-1.step", "a_1.pdf"]]);
      });

      it("pairs several differently spelled drawings, and a same-stem drawing, with the one part", () => {
        const groups = groupUploadFiles(stage(["x.step", "X_.pdf", "x.pdf", "x-.PDF"]));

        expect(groups).toHaveLength(1);
        expect(groups[0]?.files.map((file) => file.name).sort()).toEqual(["X_.pdf", "x-.PDF", "x.pdf", "x.step"]);
      });

      it("moves the images of the drawing's group with it", () => {
        expect(groupNames([makeFile("a.step"), makeFile("a_.png", "image/png"), pdf("a_.pdf")])).toEqual([
          ["a.step", "a_.png", "a_.pdf"],
        ]);
      });

      it("leaves a group without a drawing alone even when its server stem matches a part", () => {
        expect(groupNames([makeFile("a.step"), makeFile("a_.png", "image/png")])).toEqual([["a.step"], ["a_.png"]]);
      });
    });

    describe("a drawing with the identical name pairs with the identically named part", () => {
      it("keeps Part_1.pdf with Part_1.step, not with the first part of that server stem", () => {
        for (const names of [
          ["Part 1.step", "Part_1.step", "Part_1.pdf"],
          ["Part_1.step", "Part 1.step", "Part_1.pdf"],
          ["Part_1.pdf", "Part 1.step", "Part_1.step"],
        ]) {
          expect(groupNames(stage(names)).map((group) => [...group].sort())).toEqual([
            ["Part 1.step"],
            ["Part_1.pdf", "Part_1.step"],
          ]);
        }
      });

      it("does the same for names whose only a-z or 0-9 is a digit (部件1 / 零件1)", () => {
        for (const names of [
          ["部件1.step", "零件1.step", "零件1.pdf"],
          ["零件1.step", "部件1.step", "零件1.pdf"],
        ]) {
          expect(sets(stage(names))).toEqual([["部件1.step"], ["零件1.pdf", "零件1.step"]]);
        }
      });
    });

    describe("names with no a-z or 0-9 pair only when they are identical", () => {
      it("pairs identical non-Latin names", () => {
        expect(groupNames(stage(["Деталь.step", "Деталь.pdf"]))).toEqual([["Деталь.step", "Деталь.pdf"]]);
        expect(groupNames(stage(["部品.step", "部品.pdf"]))).toEqual([["部品.step", "部品.pdf"]]);
        expect(groupNames(stage(["---.step", "---.pdf"]))).toEqual([["---.step", "---.pdf"]]);
      });

      it("keeps different non-Latin parts apart and pairs the drawing by its own name", () => {
        expect(groupNames(stage(["Деталь.step", "Корпус.step", "Корпус.pdf"]))).toEqual([
          ["Деталь.step"],
          ["Корпус.step", "Корпус.pdf"],
        ]);
      });

      it("does not pair different names that both reduce to an empty server stem", () => {
        expect(groupNames(stage(["部品.step", "零件.pdf"])).sort()).toEqual([["部品.step"], ["零件.pdf"]]);
        expect(groupNames(stage(["---.step", "___.pdf"])).sort()).toEqual([["---.step"], ["___.pdf"]]);
      });

      it("does not pair an empty-stem drawing with a part whose stem is a real word", () => {
        expect(groupNames(stage(["a.step", "日本.pdf"])).sort()).toEqual([["a.step"], ["日本.pdf"]]);
      });
    });

    describe("files with the same original stem share one group, as on main", () => {
      it("keeps a.step, a.stp and a.pdf in one group", () => {
        expect(groupNames(stage(["a.step", "a.stp", "a.pdf"]))).toEqual([["a.step", "a.stp", "a.pdf"]]);
      });

      it("keeps two files with the same name in one group", () => {
        expect(groupNames(stage(["a.step", "a.step"]))).toEqual([["a.step", "a.step"]]);
      });

      it("groups case-insensitively and across CAD extensions", () => {
        expect(groupNames(stage(["a.step", "a.STEP"]))).toEqual([["a.step", "a.STEP"]]);
        expect(groupNames(stage(["A.step", "a.STEP", "A.pdf"]))).toEqual([["A.step", "a.STEP", "A.pdf"]]);
        expect(groupNames(stage(["a.step", "a.iges", "a.pdf"]))).toEqual([["a.step", "a.iges", "a.pdf"]]);
      });

      it("keeps three same-name CAD files and a drawing in one group", () => {
        expect(groupNames(stage(["a.step", "a.step", "a.step", "a.pdf"]))).toEqual([["a.step", "a.step", "a.step", "a.pdf"]]);
      });

      it("groups an identical empty-stem name together", () => {
        expect(groupNames(stage(["部品.step", "  部品.STEP", "部品.step"]))).toEqual([["部品.step", "  部品.STEP", "部品.step"]]);
      });
    });

    describe("a group that has a CAD file never absorbs another CAD group", () => {
      it("keeps parts whose names differ only by punctuation in separate groups", () => {
        expect(sets(stage(["a-1.step", "A 1.stp"]))).toEqual([["A 1.stp"], ["a-1.step"]]);
        expect(groupNames(stage(["Bracket 1.step", "bracket_1.stp", "BRACKET-1.iges"]))).toHaveLength(3);
      });

      it("keeps different Cyrillic parts that share a number in separate groups", () => {
        expect(groupNames(stage(["Деталь 1.step", "Корпус 1.step"]))).toEqual([["Деталь 1.step"], ["Корпус 1.step"]]);
      });

      it("keeps parts that differ only by accents in separate groups", () => {
        expect(groupNames(stage(["café.step", "cafè.step"])).sort()).toEqual([["cafè.step"], ["café.step"]].sort());
      });

      it("does not move a paired group into another part of the same server stem", () => {
        expect(sets(stage(["a-1.step", "a_1.step", "a_1.pdf"]))).toEqual([["a-1.step"], ["a_1.pdf", "a_1.step"]]);
      });
    });

    describe("several parts share the drawing's server name (documented limitation)", () => {
      it("pairs the drawing with the first staged of them, whatever the drawing's position", () => {
        for (const names of [
          ["a-1.step", "A 1.stp", "a_1.pdf"],
          ["a_1.pdf", "a-1.step", "A 1.stp"],
          ["a-1.step", "a_1.pdf", "A 1.stp"],
        ]) {
          expect(groupNames(stage(names)).map((group) => [...group].sort())).toEqual([["A 1.stp"], ["a-1.step", "a_1.pdf"]]);
        }
      });

      it("follows staging order, not file name order", () => {
        expect(groupNames(stage(["A 1.stp", "a-1.step", "a_1.pdf"]))).toEqual([["A 1.stp", "a_1.pdf"], ["a-1.step"]]);
      });
    });

    it("does not pair a drawing with a file that is not a CAD file, even when the stems match", () => {
      expect(sets(stage(["trailing.dot.", "trailing.dot.pdf"]))).toEqual([["trailing.dot."], ["trailing.dot.pdf"]]);
    });

    it("leaves a drawing with no matching part in its own group", () => {
      expect(groupNames(stage(["a.step", "b.pdf"]))).toEqual([["a.step"], ["b.pdf"]]);
      expect(groupNames(stage(["PN.step", "PN Rev 02.pdf"]))).toEqual([["PN.step"], ["PN Rev 02.pdf"]]);
    });

    it("does not merge two drawings with each other when no part carries their server stem", () => {
      expect(sets(stage(["b.pdf", "B_.pdf", "a.step"]))).toEqual([["B_.pdf"], ["a.step"], ["b.pdf"]]);
    });

    it("sorts the merged groups by display stem", () => {
      expect(groupNames(stage(["b.step", "a.step", "B_.pdf"]))).toEqual([["a.step"], ["b.step", "B_.pdf"]]);
    });

    it("still groups an image with the CAD file of the same stem", () => {
      expect(groupNames([makeFile("a.step"), makeFile("a.png", "image/png")])).toEqual([["a.step", "a.png"]]);
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

  describe("names that are not paired", () => {
    it("pairs identical names that have no a-z or 0-9 and does not report them", () => {
      expect(findUnpairedUploadFiles([makeFile("日本語.step"), pdf("日本語.pdf")])).toEqual(none);
      expect(findUnpairedUploadFiles([makeFile("Деталь.step"), pdf("Деталь.pdf")])).toEqual(none);
    });

    it("lists different empty-stem names as unpaired", () => {
      expect(findUnpairedUploadFiles([makeFile("部品.step"), pdf("零件.pdf")])).toEqual({
        ...none,
        drawingsWithoutPart: ["零件.pdf"],
        partsWithoutDrawing: ["部品.step"],
      });
    });

    it("never calls an empty-stem part a name-sharing part", () => {
      expect(findUnpairedUploadFiles([makeFile("部品.step"), pdf("部品.pdf"), makeFile("零件.step")])).toEqual({
        ...none,
        partsWithoutDrawing: ["零件.step"],
      });
    });

    it.each([
      ["My Part 01.step", "My Part_01.pdf"],
      ["Part 1.step", "Part_1.pdf"],
      ["Café.step", "Caf.pdf"],
      ["İstanbul.step", "istanbul.pdf"],
      ["Деталь.step", "Деталь.pdf"],
      ["部品.step", "部品.pdf"],
      ["a.step", "a.pdf"],
    ])("never says %s has no matching part for %s", (part, drawing) => {
      expect(findUnpairedUploadFiles([makeFile(part), pdf(drawing)]).drawingsWithoutPart).toEqual([]);
      expect(findUnpairedUploadFiles([pdf(drawing), makeFile(part)]).drawingsWithoutPart).toEqual([]);
    });

    it("pairs a drawing with the first same-stem part and reports the other parts as sharing its name", () => {
      expect(
        findUnpairedUploadFiles([makeFile("a-1.step"), makeFile("A 1.stp"), pdf("a_1.pdf"), makeFile("a.1.iges")]),
      ).toEqual({ ...none, partsSharingPairedName: ["A 1.stp", "a.1.iges"] });
    });

    it("reports the part with a different spelling, not the one with the identical name, when names collide", () => {
      expect(findUnpairedUploadFiles([makeFile("Part 1.step"), makeFile("Part_1.step"), pdf("Part_1.pdf")])).toEqual({
        ...none,
        partsSharingPairedName: ["Part 1.step"],
      });
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
