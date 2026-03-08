import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Index from "./Index";

const mockUseAppSession = vi.fn();

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => mockUseAppSession(),
}));

vi.mock("@/pages/ClientHome", () => ({
  default: () => <div>Client Home View</div>,
}));

vi.mock("@/pages/InternalHome", () => ({
  default: () => <div>Internal Home View</div>,
}));

describe("Index role routing", () => {
  beforeEach(() => {
    mockUseAppSession.mockReset();
  });

  it("renders the client home when there is no internal membership", () => {
    mockUseAppSession.mockReturnValue({
      activeMembership: {
        role: "client",
      },
    });

    render(<Index />);

    expect(screen.getByText("Client Home View")).toBeInTheDocument();
    expect(screen.queryByText("Internal Home View")).not.toBeInTheDocument();
  });

  it.each(["internal_admin", "internal_estimator"])(
    "renders the internal home for %s memberships",
    (role) => {
      mockUseAppSession.mockReturnValue({
        activeMembership: {
          role,
        },
      });

      render(<Index />);

      expect(screen.getByText("Internal Home View")).toBeInTheDocument();
      expect(screen.queryByText("Client Home View")).not.toBeInTheDocument();
    },
  );
});
