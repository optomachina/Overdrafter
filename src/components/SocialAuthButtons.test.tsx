import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SocialAuthButtons } from "./SocialAuthButtons";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signInWithOAuth: vi.fn(),
    },
  },
}));

describe("SocialAuthButtons", () => {
  it("keeps full accessible names with compact visible provider labels", () => {
    render(<SocialAuthButtons compact />);

    expect(screen.getByRole("button", { name: "Continue with Google" })).toHaveTextContent("Google");
    expect(screen.getByRole("button", { name: "Continue with Microsoft" })).toHaveTextContent("Microsoft");
    expect(screen.getByRole("button", { name: "Continue with Apple" })).toHaveTextContent("Apple");
    expect(screen.queryByText("Continue with Microsoft")).not.toBeInTheDocument();
  });
});
