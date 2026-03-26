import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DiagnosticsBootstrap } from "./DiagnosticsBootstrap";
import { getDiagnosticsSnapshot, resetDiagnosticsForTests } from "@/lib/diagnostics";

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => ({
    user: null,
    activeMembership: null,
  }),
}));

describe("DiagnosticsBootstrap", () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  afterEach(() => {
    cleanup();
    resetDiagnosticsForTests();
  });

  it("opens diagnostics on direct debug routes outside embed mode", async () => {
    render(
      <MemoryRouter initialEntries={["/?debug=1"]}>
        <DiagnosticsBootstrap />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getDiagnosticsSnapshot()).toMatchObject({
        enabled: true,
        panelOpen: true,
        uiSuppressed: true,
      });
    });
    expect(screen.queryByText("Troubleshooting console")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide launcher" })).not.toBeInTheDocument();
  });

  it("suppresses diagnostics UI for embedded previews even when debug mode is requested", async () => {
    render(
      <MemoryRouter initialEntries={["/?debug=1&embed=1"]}>
        <DiagnosticsBootstrap />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getDiagnosticsSnapshot()).toMatchObject({
        panelOpen: false,
        uiSuppressed: true,
      });
    });

    expect(screen.queryByRole("button", { name: "Diagnostics" })).not.toBeInTheDocument();
    expect(screen.queryByText("Troubleshooting console")).not.toBeInTheDocument();
  });

  it("keeps diagnostics closed and hidden for embedded previews when debug is explicitly disabled", async () => {
    render(
      <MemoryRouter initialEntries={["/?debug=0&embed=1"]}>
        <DiagnosticsBootstrap />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getDiagnosticsSnapshot()).toMatchObject({
        panelOpen: false,
        uiSuppressed: true,
      });
    });

    expect(screen.queryByRole("button", { name: "Diagnostics" })).not.toBeInTheDocument();
    expect(screen.queryByText("Troubleshooting console")).not.toBeInTheDocument();
  });
});
