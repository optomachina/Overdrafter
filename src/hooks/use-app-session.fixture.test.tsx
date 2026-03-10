import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppSession } from "@/hooks/use-app-session";
import { resetClientWorkspaceFixtureStateForTests } from "@/features/quotes/client-workspace-fixtures";

function SessionProbe() {
  const session = useAppSession();

  return (
    <div>
      <span data-testid="email">{session.user?.email ?? "anonymous"}</span>
      <span data-testid="role">{session.activeMembership?.role ?? "none"}</span>
      <span data-testid="verified">{session.isVerifiedAuth ? "verified" : "unverified"}</span>
    </div>
  );
}

function renderWithRoute(route: string) {
  const queryClient = new QueryClient();

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <SessionProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("useAppSession fixture integration", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ENABLE_FIXTURE_MODE", "1");
  });

  afterEach(() => {
    cleanup();
    resetClientWorkspaceFixtureStateForTests();
    vi.unstubAllEnvs();
  });

  it("returns a fixture-backed client session when a fixture scenario is active", async () => {
    renderWithRoute("/?fixture=client-empty");

    expect(screen.getByTestId("email")).toHaveTextContent("client.fixture@example.com");
    expect(screen.getByTestId("role")).toHaveTextContent("client");
    expect(screen.getByTestId("verified")).toHaveTextContent("verified");
  });

  it("returns an anonymous session for the landing fixture", async () => {
    renderWithRoute("/?fixture=landing-anonymous");

    expect(screen.getByTestId("email")).toHaveTextContent("anonymous");
    expect(screen.getByTestId("role")).toHaveTextContent("none");
    expect(screen.getByTestId("verified")).toHaveTextContent("unverified");
  });
});
