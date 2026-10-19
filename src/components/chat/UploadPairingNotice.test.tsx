import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UploadPairingNotice } from "./UploadPairingNotice";

const RULE =
  "A drawing pairs with a part when the file names match, ignoring spacing, case and punctuation.";

const PART_CONSEQUENCE_ONE = "An unpaired part is quoted without drawing data";
const PART_CONSEQUENCE_MANY = "Unpaired parts are quoted without drawing data";
const DRAWING_CONSEQUENCE_ONE =
  "An unpaired drawing becomes a separate line item and cannot be quoted until a matching CAD file is uploaded.";
const DRAWING_CONSEQUENCE_MANY =
  "Unpaired drawings become separate line items and cannot be quoted until matching CAD files are uploaded.";
const OLD_FALSE_CLAIM = "unpaired files are quoted without that pairing";

function makeFile(name: string, type = "application/octet-stream") {
  return new File(["test"], name, { type });
}

const pdf = (name: string) => makeFile(name, "application/pdf");

describe("UploadPairingNotice", () => {
  afterEach(cleanup);

  it("names an unpaired PDF and explains the filename rule", () => {
    render(<UploadPairingNotice files={[pdf("PN Rev 02.pdf")]} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("PN Rev 02.pdf");
    expect(notice).toHaveTextContent("This drawing has no part with a matching name");
    expect(notice).toHaveTextContent(RULE);
    expect(notice).toHaveTextContent("You can still upload");
  });

  it("names a part with no drawing when another drawing is selected", () => {
    render(<UploadPairingNotice files={[makeFile("PN.step"), pdf("Other.pdf")]} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("PN.step");
    expect(notice).toHaveTextContent("This part has no drawing with a matching name");
    expect(notice).toHaveTextContent("Other.pdf");
    expect(notice).toHaveTextContent(RULE);
  });

  describe("consequence copy is true for each kind of unpaired file", () => {
    it("says an unpaired drawing becomes its own line item that cannot be quoted without a CAD file", () => {
      render(<UploadPairingNotice files={[pdf("lonely.pdf")]} />);

      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent(DRAWING_CONSEQUENCE_ONE);
      expect(notice).not.toHaveTextContent("quoted without drawing data");
      expect(notice).not.toHaveTextContent(OLD_FALSE_CLAIM);
    });

    it("says an unpaired part is quoted without drawing data and takes tolerance and finish from the user", () => {
      render(<UploadPairingNotice files={[makeFile("a.step"), pdf("a.pdf"), makeFile("b.step")]} />);

      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent(PART_CONSEQUENCE_ONE);
      expect(notice).toHaveTextContent("tolerance and finish come from what you enter");
      expect(notice).not.toHaveTextContent("separate line item");
      expect(notice).not.toHaveTextContent(OLD_FALSE_CLAIM);
    });

    it("gives both consequences when a drawing and a part are unpaired", () => {
      render(<UploadPairingNotice files={[makeFile("PN.step"), pdf("PN Rev 02.pdf")]} />);

      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent(DRAWING_CONSEQUENCE_ONE);
      expect(notice).toHaveTextContent(PART_CONSEQUENCE_ONE);
      expect(notice).not.toHaveTextContent(OLD_FALSE_CLAIM);
    });
  });

  it("is empty for a paired set, including names that differ only in punctuation", () => {
    render(<UploadPairingNotice files={[makeFile("My Part_01.step"), pdf("my-part-01.pdf")]} />);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("is empty for a part-only selection and for no files", () => {
    const { rerender } = render(<UploadPairingNotice files={[makeFile("PN.step")]} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    rerender(<UploadPairingNotice files={[]} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("keeps one status container mounted so the change is announced when content appears", () => {
    const { rerender } = render(<UploadPairingNotice files={[]} />);
    const container = screen.getByRole("status");

    rerender(<UploadPairingNotice files={[pdf("lonely.pdf")]} />);

    expect(screen.getByRole("status")).toBe(container);
    expect(container).toHaveTextContent("lonely.pdf");

    rerender(<UploadPairingNotice files={[]} />);
    expect(screen.getByRole("status")).toBe(container);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists parts when every staged drawing is paired but another part has no drawing", () => {
    render(<UploadPairingNotice files={[makeFile("a.step"), pdf("a.pdf"), makeFile("b.step")]} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("b.step");
    expect(notice).toHaveTextContent("This part has no drawing with a matching name");
    expect(notice).not.toHaveTextContent("a.step");
    expect(notice).not.toHaveTextContent("no part with a matching name");
  });

  it("does not report parts when no drawing is staged", () => {
    render(<UploadPairingNotice files={[makeFile("a.step"), makeFile("b.step")]} />);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("lists an upper-case .PDF drawing", () => {
    render(<UploadPairingNotice files={[makeFile("a.step"), pdf("Other.PDF")]} />);

    expect(screen.getByRole("status")).toHaveTextContent("Other.PDF");
  });

  it("does not list a non-matching file that sits beside an unpaired drawing", () => {
    render(<UploadPairingNotice files={[makeFile("photo.png", "image/png"), pdf("lonely.pdf")]} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("lonely.pdf");
    expect(notice).not.toHaveTextContent("photo.png");
  });

  it("does not list an image that shares its name with an unpaired drawing", () => {
    render(<UploadPairingNotice files={[makeFile("lonely.png", "image/png"), pdf("lonely.pdf")]} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("lonely.pdf");
    expect(notice).not.toHaveTextContent("lonely.png");
  });

  describe("singular and plural wording", () => {
    it("uses singular wording for one drawing and one part", () => {
      render(<UploadPairingNotice files={[makeFile("PN.step"), pdf("Other.pdf")]} />);

      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent("This drawing has no part");
      expect(notice).toHaveTextContent("This part has no drawing");
      expect(notice).toHaveTextContent(DRAWING_CONSEQUENCE_ONE);
      expect(notice).toHaveTextContent(PART_CONSEQUENCE_ONE);
      expect(notice).not.toHaveTextContent("These drawings");
      expect(notice).not.toHaveTextContent("These parts");
    });

    it("uses plural wording for several drawings and several parts", () => {
      render(
        <UploadPairingNotice
          files={[makeFile("a.step"), makeFile("b.step"), pdf("x.pdf"), pdf("y.pdf")]}
        />,
      );

      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent("These drawings have no part");
      expect(notice).toHaveTextContent("These parts have no drawing");
      expect(notice).toHaveTextContent(DRAWING_CONSEQUENCE_MANY);
      expect(notice).toHaveTextContent(PART_CONSEQUENCE_MANY);
      expect(notice).not.toHaveTextContent("This drawing");
      expect(notice).not.toHaveTextContent("This part ");
    });
  });

  describe("parts that share a server name, and names with no a-z or 0-9", () => {
    it("tells the user a drawing pairs with one part when several parts share its name", () => {
      render(<UploadPairingNotice files={[makeFile("a-1.step"), makeFile("A 1.stp"), pdf("a_1.pdf")]} />);

      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent("A 1.stp");
      expect(notice).toHaveTextContent("This part shares a name with a part that already has the drawing");
      expect(notice).not.toHaveTextContent("This part has no drawing with a matching name");
      expect(notice).not.toHaveTextContent("a_1.pdf");
      expect(notice).not.toHaveTextContent("a-1.step");
      expect(notice).toHaveTextContent(PART_CONSEQUENCE_ONE);
    });

    it("uses plural wording when more than one part shares the paired name", () => {
      render(
        <UploadPairingNotice
          files={[makeFile("a-1.step"), makeFile("A 1.stp"), makeFile("a.1.iges"), pdf("a_1.pdf")]}
        />,
      );

      expect(screen.getByRole("status")).toHaveTextContent(
        "These parts share a name with a part that already has the drawing",
      );
    });

    it("is empty for identical names that have no a-z or 0-9, because the drawing does pair", () => {
      render(<UploadPairingNotice files={[makeFile("日本語.step"), pdf("日本語.pdf")]} />);

      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });

    it("lists a drawing and a part with different names that have no a-z or 0-9 as unpaired", () => {
      render(<UploadPairingNotice files={[makeFile("部品.step"), pdf("零件.pdf")]} />);

      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent("零件.pdf");
      expect(notice).toHaveTextContent("部品.step");
      expect(notice).toHaveTextContent("This drawing has no part with a matching name");
      expect(notice).toHaveTextContent("This part has no drawing with a matching name");
    });

    it("never says a drawing has no matching part while a part with the identical name is staged", () => {
      for (const files of [
        [makeFile("Part_1.step"), pdf("Part_1.pdf")],
        [makeFile("Part 1.step"), makeFile("Part_1.step"), pdf("Part_1.pdf")],
        [makeFile("Деталь.step"), pdf("Деталь.pdf")],
        [makeFile("部品.step"), makeFile("a.step"), pdf("部品.pdf")],
      ]) {
        const { unmount } = render(<UploadPairingNotice files={files} />);

        expect(screen.getByRole("status")).not.toHaveTextContent("no part with a matching name");
        unmount();
      }
    });

    it("names the part with the other spelling, not the identically named one, when two parts collide", () => {
      render(<UploadPairingNotice files={[makeFile("Part 1.step"), makeFile("Part_1.step"), pdf("Part_1.pdf")]} />);

      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent("This part shares a name with a part that already has the drawing");
      expect(notice).toHaveTextContent("Part 1.step");
      expect(notice).not.toHaveTextContent("Part_1");
      expect(notice).not.toHaveTextContent("no part with a matching name");
    });
  });

  describe("design", () => {
    it("sets file names in the monospaced face", () => {
      render(<UploadPairingNotice files={[makeFile("PN.step"), pdf("Other.pdf")]} />);

      const names = within(screen.getByRole("status")).getAllByRole("listitem");
      expect(names).toHaveLength(2);
      for (const item of names) {
        expect(item).toHaveClass("font-mono");
      }
    });

    it("sets the micro label with 0.1em tracking in the monospaced face", () => {
      render(<UploadPairingNotice files={[pdf("lonely.pdf")]} />);

      const label = screen.getByText("Note");
      expect(label).toHaveClass("font-mono", "uppercase", "tracking-[0.1em]");
      expect(label).not.toHaveClass("tracking-wide");
    });
  });
});
