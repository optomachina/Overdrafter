import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Index from "./Index";

const mockUseAppSession = vi.fn();

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => mockUseAppSession(),
}));

vi.mock("@/pages/ClientHome", () => ({
  default: () => <div>Client Home</div>,
}));

vi.mock("@/pages/InternalHome", () => ({
  default: () => <div>Internal Home</div>,
}));

vi.mock("@/pages/NorthStarPreviewHome", () => ({
  default: () => <div>North Star Preview</div>,
}));

describe("Index role resolution", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the client home for client memberships", () => {
    mockUseAppSession.mockReturnValue({
      activeMembership: {
        role: "client",
      },
    });

    render(
      <MemoryRouter>
        <Index />
      </MemoryRouter>,
    );

    expect(screen.getByText("Client Home")).toBeInTheDocument();
    expect(screen.queryByText("Internal Home")).not.toBeInTheDocument();
  });

  it("renders the internal home for internal memberships", () => {
    mockUseAppSession.mockReturnValue({
      activeMembership: {
        role: "internal_estimator",
      },
    });

    render(
      <MemoryRouter>
        <Index />
      </MemoryRouter>,
    );

    expect(screen.getByText("Internal Home")).toBeInTheDocument();
    expect(screen.queryByText("Client Home")).not.toBeInTheDocument();
  });

  it("renders North Star preview only when both gates are enabled", () => {
    vi.stubEnv("VITE_ENABLE_NORTH_STAR_UI", "1");

    mockUseAppSession.mockReturnValue({
      activeMembership: {
        role: "client",
      },
    });

    render(
      <MemoryRouter initialEntries={["/?north_star_ui=1"]}>
        <Index />
      </MemoryRouter>,
    );

    expect(screen.getByText("North Star Preview")).toBeInTheDocument();
    vi.unstubAllEnvs();
  });
});
