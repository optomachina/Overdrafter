import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

describe("Index role resolution", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes client memberships into the parts collection", () => {
    mockUseAppSession.mockReturnValue({
      activeMembership: {
        role: "client",
      },
    });

    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/parts" element={<div>Parts Collection</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Parts Collection")).toBeInTheDocument();
    expect(screen.queryByText("Client Home")).not.toBeInTheDocument();
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
        <Routes>
          <Route path="/" element={<Index />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Internal Home")).toBeInTheDocument();
    expect(screen.queryByText("Client Home")).not.toBeInTheDocument();
  });
});
