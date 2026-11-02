import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GeneratedPartBadge } from "./GeneratedPartBadge";

describe("GeneratedPartBadge", () => {
  it("renders nothing for uploaded parts", () => {
    const { container } = render(<GeneratedPartBadge tags={["bracket"]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels generated parts with the generator", () => {
    render(<GeneratedPartBadge tags={["source:generated", "generator:cad-monkey"]} />);
    expect(screen.getByTestId("generated-part-badge")).toHaveTextContent("Generated · cad-monkey");
  });
});
