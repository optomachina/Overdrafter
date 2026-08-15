import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FOUNDING_BETA_POLICY_LINKS } from "@/lib/founding-beta-policy";
import { GuestAppShell } from "./GuestAppShell";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signInWithOAuth: vi.fn() } },
}));

describe("GuestAppShell policy links", () => {
  it("links signed-out visitors to the canonical beta policies", () => {
    render(<GuestAppShell onOpenAuth={vi.fn()} />);

    expect(screen.getByRole("link", { name: "Founding Beta Terms" })).toHaveAttribute(
      "href",
      FOUNDING_BETA_POLICY_LINKS.terms,
    );
    expect(screen.getByRole("link", { name: "Privacy & data handling notice" })).toHaveAttribute(
      "href",
      FOUNDING_BETA_POLICY_LINKS.privacy,
    );
  });
});
