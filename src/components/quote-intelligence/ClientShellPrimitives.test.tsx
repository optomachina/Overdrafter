import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ClientActionNotice,
  ClientShellPanel,
  ClientShellSection,
} from "./ClientShellPrimitives";

describe("client shell primitives", () => {
  it("keeps ordinary sections cardless", () => {
    render(<ClientShellSection title="Requirements">Content</ClientShellSection>);

    const section = screen.getByRole("region", { name: "Requirements" });
    expect(section).toHaveClass("border-b", "py-5");
    expect(section).not.toHaveClass("rounded-[4px]", "bg-paper-surface", "shadow");
  });

  it("reserves a flat bounded panel for meaningful objects", () => {
    render(<ClientShellPanel aria-label="Drawing">Drawing preview</ClientShellPanel>);

    expect(screen.getByRole("region", { name: "Drawing" })).toHaveClass(
      "rounded-[4px]",
      "border",
      "bg-paper-surface",
    );
  });

  it("pairs status information with an explicit action", () => {
    render(
      <ClientActionNotice
        title="3 drawing fields need review"
        detail="Confirm tolerances before requesting quotes."
        action={<button type="button">Review fields</button>}
      />,
    );

    expect(screen.getByText("3 drawing fields need review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review fields" })).toBeInTheDocument();
  });
});
