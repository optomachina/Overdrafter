import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnonymousHomeLanding } from "./AnonymousHomeLanding";

describe("AnonymousHomeLanding", () => {
  it("leads with the manufacturing-agent headline without the obsolete launch-scope copy", () => {
    render(<AnonymousHomeLanding onSignIn={vi.fn()} onSignUp={vi.fn()} />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "OverDrafter is your manufacturing agent for building frontier hardware.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agents turn drawings into quotes" })).toBeInTheDocument();
    expect(screen.getAllByText(/free, invitation-only Founding Beta/i)).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Get started free" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Founding Beta · sample data/i)).not.toHaveLength(0);
    expect(screen.queryByText(/files in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/launch scope/i)).not.toBeInTheDocument();
  });
});
