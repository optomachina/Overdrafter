import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UploadPairingNotice } from "./UploadPairingNotice";

const RULE =
  "A drawing pairs with a part when the file names match, ignoring spacing, case and punctuation.";

function makeFile(name: string, type = "application/octet-stream") {
  return new File(["test"], name, { type });
}

describe("UploadPairingNotice", () => {
  afterEach(cleanup);

  it("names an unpaired PDF and explains the filename rule", () => {
    render(<UploadPairingNotice files={[makeFile("PN Rev 02.pdf", "application/pdf")]} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("PN Rev 02.pdf");
    expect(notice).toHaveTextContent("no part with a matching name");
    expect(notice).toHaveTextContent(RULE);
    expect(notice).toHaveTextContent("You can still upload");
  });

  it("names a part with no drawing when another drawing is selected", () => {
    render(<UploadPairingNotice files={[makeFile("PN.step"), makeFile("Other.pdf", "application/pdf")]} />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("PN.step");
    expect(notice).toHaveTextContent("no drawing with a matching name");
    expect(notice).toHaveTextContent("Other.pdf");
    expect(notice).toHaveTextContent(RULE);
  });

  it("is hidden for a paired set, including names that differ only in punctuation", () => {
    render(
      <UploadPairingNotice files={[makeFile("My Part_01.step"), makeFile("my-part-01.pdf", "application/pdf")]} />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is hidden for a part-only selection and for no files", () => {
    const { rerender } = render(<UploadPairingNotice files={[makeFile("PN.step")]} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(<UploadPairingNotice files={[]} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
