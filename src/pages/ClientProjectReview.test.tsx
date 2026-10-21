import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClientProjectReview from "./ClientProjectReview";

const api = vi.hoisted(() => ({
  fetchProject: vi.fn(),
  fetchJobsByProject: vi.fn(),
  fetchClientQuoteWorkspaceByJobIds: vi.fn(),
}));
vi.mock("@/features/quotes/api/workspace-access", () => api);
vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => ({ user: { id: "client" }, isAuthInitializing: false }),
}));
vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

beforeEach(() => {
  vi.resetAllMocks();
  api.fetchProject.mockResolvedValue({ id: "project-1", name: "Project one" });
  api.fetchJobsByProject.mockResolvedValue([{ id: "job-1" }]);
  api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([]);
});
afterEach(cleanup);

describe("project review quote-options failures", () => {
  it.each(["jobs", "workspace"])("shows an error and disables handoff when %s fails", async (failedQuery) => {
    const query = failedQuery === "jobs" ? api.fetchJobsByProject : api.fetchClientQuoteWorkspaceByJobIds;
    query.mockRejectedValue(new Error("Query unavailable"));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/projects/project-1/review"]}>
          <Routes><Route path="/projects/:projectId/review" element={<ClientProjectReview />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Unable to load quote options. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review handoff" })).toBeDisabled();
    expect(screen.queryByText(/Choose a (quote|package option) to continue/)).not.toBeInTheDocument();
    if (failedQuery === "jobs") expect(api.fetchClientQuoteWorkspaceByJobIds).not.toHaveBeenCalled();
  });
});
