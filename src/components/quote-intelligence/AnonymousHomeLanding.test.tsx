import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnonymousHomeLanding } from "./AnonymousHomeLanding";

describe("AnonymousHomeLanding", () => {
  it("uses the CAD-first headline without the obsolete launch-scope copy", () => {
    render(<AnonymousHomeLanding onSignIn={vi.fn()} onSignUp={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "CAD In Parts Out" })).toBeInTheDocument();
    expect(screen.queryByText(/files in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/launch scope/i)).not.toBeInTheDocument();
  });
});
