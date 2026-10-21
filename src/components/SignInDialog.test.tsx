import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignInDialog } from "./SignInDialog";

vi.mock("@/components/auth/AuthPanel", () => ({
  AuthPanel: () => <div>Auth panel</div>,
}));

describe("SignInDialog", () => {
  it.each(["sign-in", "sign-up", "forgot-password"] as const)(
    "bounds %s content to the viewport and allows internal scrolling",
    (initialMode) => {
      render(<SignInDialog open onOpenChange={() => undefined} initialMode={initialMode} />);

      // jsdom cannot measure layout; the fixture journey checks actual reachability.
      expect(screen.getByRole("dialog")).toHaveClass(
        "max-h-[calc(100dvh-2rem)]",
        "overflow-y-auto",
        "overscroll-contain",
        "sm:bottom-auto",
        "sm:max-h-[calc(100dvh-6rem)]",
      );
    },
  );

  it("renders an accessible title and description for sign-in mode", () => {
    render(<SignInDialog open onOpenChange={() => undefined} initialMode="sign-in" />);

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
