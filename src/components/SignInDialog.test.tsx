import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignInDialog } from "./SignInDialog";

vi.mock("@/components/auth/AuthPanel", () => ({
  AuthPanel: () => <div>Auth panel</div>,
}));

describe("SignInDialog", () => {
  it("renders an accessible title and description for sign-in mode", () => {
    render(<SignInDialog open onOpenChange={() => undefined} initialMode="sign-in" />);

    expect(screen.getByRole("dialog")).toHaveClass(
      "left-1/2",
      "top-1/2",
      "-translate-x-1/2",
      "-translate-y-1/2",
    );
    expect(document.querySelector(".fixed.inset-0")).toHaveClass(
      "bg-background",
    );
    expect(screen.getByText("Log in")).toBeInTheDocument();
    expect(
      screen.getByText("Log in to OverDrafter to access uploads, quote reviews, and published packages."),
    ).toBeInTheDocument();
  });

  it("renders an accessible title and description for sign-up mode", () => {
    render(<SignInDialog open onOpenChange={() => undefined} initialMode="sign-up" />);

    expect(screen.getByText("Create account")).toBeInTheDocument();
    expect(
      screen.getByText("Create an OverDrafter account to access uploads, quote reviews, and published packages."),
    ).toBeInTheDocument();
  });
});
